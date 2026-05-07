// Each handler is self-contained — no shared imports — so Vercel's bundler
// can't drop a referenced helper from the deployment artefact.
//
// Required env vars (set in Vercel project settings):
//   WHOOP_CLIENT_ID
//   WHOOP_CLIENT_SECRET
//   WHOOP_REDIRECT_URI   e.g. https://blinking-rate.vercel.app/api/whoop/callback
//   AUTH_SECRET          shared with the auth endpoints
//   ADMIN_EMAILS         comma-separated list of admin emails

import { createHmac, timingSafeEqual } from "node:crypto";

const WHOOP_AUTH_URL  = "https://api.prod.whoop.com/oauth/oauth2/auth";
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

function setStateCookie(res, state) {
  res.setHeader(
    "Set-Cookie",
    `whoop_state=${encodeURIComponent(state)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );
}

function randomState() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

export default async function handler(req, res) {
  try {
    if (!verifyAdmin(req)) {
      res.statusCode = 302;
      res.setHeader("Location", "/?whoop=error&detail=forbidden_not_admin");
      res.end();
      return;
    }
    const id = process.env.WHOOP_CLIENT_ID;
    const redirect = process.env.WHOOP_REDIRECT_URI;
    if (!id || !redirect) {
      res.statusCode = 302;
      res.setHeader("Location", "/?whoop=error&detail=server_env_missing");
      res.end();
      return;
    }
    const state = randomState();
    setStateCookie(res, state);
    const url = new URL(WHOOP_AUTH_URL);
    url.searchParams.set("client_id", id);
    url.searchParams.set("redirect_uri", redirect);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", WHOOP_SCOPES);
    url.searchParams.set("state", state);
    res.statusCode = 302;
    res.setHeader("Location", url.toString());
    res.end();
  } catch (e) {
    res.statusCode = 302;
    res.setHeader("Location", "/?whoop=error&detail=" + encodeURIComponent(e.message));
    res.end();
  }
}
