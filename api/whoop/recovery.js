import { createHmac, timingSafeEqual } from "node:crypto";

const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const WHOOP_API_BASE  = "https://api.prod.whoop.com/developer/v1";
const WHOOP_SCOPES    = "read:recovery read:cycles read:sleep offline";

function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64").toString();
}

function verifyAdmin(req) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const cookies = readCookies(req);
  const token = cookies.bra_auth;
  if (!token || !token.includes(".")) return null;
  const [payloadB64, sigB64] = token.split(".");
  const expected = createHmac("sha256", secret).update(payloadB64).digest();
  let given;
  try { given = Buffer.from(sigB64.replace(/-/g, "+").replace(/_/g, "/"), "base64"); }
  catch { return null; }
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(given, expected)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(payloadB64)); }
  catch { return null; }
  if (!payload?.email || !payload?.exp || payload.exp < Date.now()) return null;
  const admins = (process.env.ADMIN_EMAILS || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  return admins.includes(payload.email) ? payload.email : null;
}

function readCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join("="));
  }
  return out;
}

function setSessionCookies(res, { access_token, refresh_token, expires_in }) {
  const exp = Date.now() + Math.max(60, (expires_in || 3600) - 60) * 1000;
  const cookies = [
    `whoop_access=${encodeURIComponent(access_token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${expires_in || 3600}`,
    `whoop_exp=${encodeURIComponent(String(exp))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${expires_in || 3600}`,
  ];
  if (refresh_token) {
    cookies.push(`whoop_refresh=${encodeURIComponent(refresh_token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 60}`);
  }
  res.setHeader("Set-Cookie", cookies);
}

function clearSessionCookies(res) {
  res.setHeader("Set-Cookie", [
    "whoop_access=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    "whoop_refresh=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    "whoop_exp=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
  ]);
}

async function refreshAccessToken(refreshToken) {
  const id = process.env.WHOOP_CLIENT_ID;
  const secret = process.env.WHOOP_CLIENT_SECRET;
  if (!id || !secret) throw new Error("server_env_missing");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: id,
    client_secret: secret,
    scope: WHOOP_SCOPES,
  });
  const r = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`refresh_${r.status}:${text.slice(0, 120)}`);
  }
  return r.json();
}

async function getValidAccessToken(req, res) {
  const cookies = readCookies(req);
  const access = cookies.whoop_access;
  const refresh = cookies.whoop_refresh;
  const exp = cookies.whoop_exp ? parseInt(cookies.whoop_exp, 10) : 0;
  if (access && exp > Date.now() + 5_000) return access;
  if (!refresh) return null;
  const tok = await refreshAccessToken(refresh);
  setSessionCookies(res, tok);
  return tok.access_token;
}

export default async function handler(req, res) {
  try {
    if (!verifyAdmin(req)) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "forbidden_not_admin" }));
    }
    const token = await getValidAccessToken(req, res);
    if (!token) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "not_connected" }));
      return;
    }

    const url = new URL(req.url, `https://${req.headers.host}`);
    const start = url.searchParams.get("start");
    const end   = url.searchParams.get("end");

    const items = [];
    let nextToken = null;
    let pages = 0;
    do {
      const apiUrl = new URL(`${WHOOP_API_BASE}/recovery`);
      if (start) apiUrl.searchParams.set("start", start);
      if (end)   apiUrl.searchParams.set("end", end);
      apiUrl.searchParams.set("limit", "25");
      if (nextToken) apiUrl.searchParams.set("nextToken", nextToken);

      const r = await fetch(apiUrl.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.status === 401) {
        clearSessionCookies(res);
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "session_expired" }));
        return;
      }
      if (!r.ok) {
        const text = await r.text();
        res.statusCode = r.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "whoop_api", status: r.status, detail: text.slice(0, 500) }));
        return;
      }
      const json = await r.json();
      items.push(...(json.records || []));
      nextToken = json.next_token || null;
      pages++;
    } while (nextToken && pages < 10);

    const simplified = items.map(rec => ({
      cycle_id: rec.cycle_id,
      date: rec.created_at?.slice(0, 10) || null,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
      score_state: rec.score_state,
      hrv_ms: rec.score?.hrv_rmssd_milli ?? null,
      resting_hr: rec.score?.resting_heart_rate ?? null,
      recovery_score: rec.score?.recovery_score ?? null,
      user_calibrating: rec.score?.user_calibrating ?? false,
    })).filter(r => r.date);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ records: simplified }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: e.message }));
  }
}
