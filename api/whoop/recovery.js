const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
// Try v2 first, fall back to v1. WHOOP migrated to v2 in 2025; v1 may
// still serve some accounts. Whichever returns 200 wins for the request.
const WHOOP_API_BASES = [
  "https://api.prod.whoop.com/developer/v2",
  "https://api.prod.whoop.com/developer/v1",
];
const WHOOP_SCOPES    = "read:recovery read:cycles read:sleep offline";

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

    // Pick a working API base. Probe v2 then v1 with the first request.
    let apiBase = null;
    let firstJson = null;
    let firstNextToken = null;
    let lastError = null;
    for (const base of WHOOP_API_BASES) {
      const apiUrl = new URL(`${base}/recovery`);
      if (start) apiUrl.searchParams.set("start", start);
      if (end)   apiUrl.searchParams.set("end", end);
      apiUrl.searchParams.set("limit", "25");
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
      if (r.ok) {
        apiBase = base;
        firstJson = await r.json();
        firstNextToken = firstJson.next_token || null;
        break;
      }
      const text = await r.text();
      lastError = { base, status: r.status, detail: text.slice(0, 200) };
    }
    if (!apiBase) {
      res.statusCode = lastError?.status || 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        error: "whoop_api",
        tried: WHOOP_API_BASES,
        last: lastError,
        hint: "WHOOP API didn't recognise /recovery on either v2 or v1 — your account may need a different scope set or endpoint path.",
      }));
      return;
    }

    const items = [...(firstJson.records || [])];
    let nextToken = firstNextToken;
    let pages = 1;
    while (nextToken && pages < 10) {
      const apiUrl = new URL(`${apiBase}/recovery`);
      if (start) apiUrl.searchParams.set("start", start);
      if (end)   apiUrl.searchParams.set("end", end);
      apiUrl.searchParams.set("limit", "25");
      apiUrl.searchParams.set("nextToken", nextToken);
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
      if (!r.ok) break;
      const json = await r.json();
      items.push(...(json.records || []));
      nextToken = json.next_token || null;
      pages++;
    }

    const simplified = items.map(rec => {
      const sc = rec.score || {};
      return {
        cycle_id: rec.cycle_id != null ? String(rec.cycle_id) : null,
        date: rec.created_at?.slice(0, 10) || null,
        created_at: rec.created_at,
        updated_at: rec.updated_at,
        score_state: rec.score_state,
        hrv_ms: sc.hrv_rmssd_milli ?? sc.heart_rate_variability_rmssd_milli ?? null,
        resting_hr: sc.resting_heart_rate ?? null,
        recovery_score: sc.recovery_score ?? null,
        user_calibrating: sc.user_calibrating ?? false,
      };
    }).filter(r => r.date);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ records: simplified, api_version: apiBase.endsWith("/v2") ? "v2" : "v1" }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: e.message }));
  }
}
