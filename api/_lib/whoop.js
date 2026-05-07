// Shared helpers for the WHOOP serverless functions.
//
// Auth flow:
//   /api/whoop/start     →  redirects to WHOOP authorize URL
//   /api/whoop/callback  →  exchanges code, sets HttpOnly cookies, redirects home
//   /api/whoop/status    →  returns { connected }
//   /api/whoop/recovery  →  proxies WHOOP recovery API (auto-refreshes on 401)
//   /api/whoop/disconnect→  clears cookies
//
// Required env vars (set in Vercel project settings):
//   WHOOP_CLIENT_ID
//   WHOOP_CLIENT_SECRET
//   WHOOP_REDIRECT_URI   e.g. https://blinking-rate.vercel.app/api/whoop/callback

export const WHOOP_AUTH_URL  = "https://api.prod.whoop.com/oauth/oauth2/auth";
export const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
export const WHOOP_API_BASE  = "https://api.prod.whoop.com/developer/v1";
export const WHOOP_SCOPES    = "read:recovery read:cycles read:sleep offline";

const COOKIE_ACCESS  = "whoop_access";
const COOKIE_REFRESH = "whoop_refresh";
const COOKIE_STATE   = "whoop_state";
const COOKIE_EXP     = "whoop_exp";

export function readCookies(req) {
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

function cookieHeader(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push("Path=/");
  parts.push("HttpOnly");
  parts.push("Secure");
  parts.push("SameSite=Lax");
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join("; ");
}

export function setSessionCookies(res, { access_token, refresh_token, expires_in }) {
  const exp = Date.now() + Math.max(60, (expires_in || 3600) - 60) * 1000;
  const cookies = [
    cookieHeader(COOKIE_ACCESS,  access_token,  { maxAge: expires_in || 3600 }),
    cookieHeader(COOKIE_EXP,     String(exp),    { maxAge: expires_in || 3600 }),
  ];
  if (refresh_token) {
    cookies.push(cookieHeader(COOKIE_REFRESH, refresh_token, { maxAge: 60 * 60 * 24 * 60 }));
  }
  res.setHeader("Set-Cookie", cookies);
}

export function clearSessionCookies(res) {
  res.setHeader("Set-Cookie", [
    cookieHeader(COOKIE_ACCESS,  "", { maxAge: 0 }),
    cookieHeader(COOKIE_REFRESH, "", { maxAge: 0 }),
    cookieHeader(COOKIE_EXP,     "", { maxAge: 0 }),
    cookieHeader(COOKIE_STATE,   "", { maxAge: 0 }),
  ]);
}

export function setStateCookie(res, state) {
  res.setHeader("Set-Cookie", cookieHeader(COOKIE_STATE, state, { maxAge: 600 }));
}

export function getCookieNames() {
  return { COOKIE_ACCESS, COOKIE_REFRESH, COOKIE_STATE, COOKIE_EXP };
}

export function requireEnv() {
  const id = process.env.WHOOP_CLIENT_ID;
  const secret = process.env.WHOOP_CLIENT_SECRET;
  const redirect = process.env.WHOOP_REDIRECT_URI;
  if (!id || !secret || !redirect) {
    throw new Error("WHOOP env vars missing — set WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, WHOOP_REDIRECT_URI in Vercel.");
  }
  return { id, secret, redirect };
}

export async function exchangeCode(code) {
  const { id, secret, redirect } = requireEnv();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    client_id: id,
    client_secret: secret,
  });
  const res = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WHOOP token exchange failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function refreshAccessToken(refreshToken) {
  const { id, secret } = requireEnv();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: id,
    client_secret: secret,
    scope: WHOOP_SCOPES,
  });
  const res = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WHOOP refresh failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function getValidAccessToken(req, res) {
  const cookies = readCookies(req);
  const access = cookies[COOKIE_ACCESS];
  const refresh = cookies[COOKIE_REFRESH];
  const expRaw = cookies[COOKIE_EXP];
  const exp = expRaw ? parseInt(expRaw, 10) : 0;

  if (access && exp > Date.now() + 5_000) return access;
  if (!refresh) return null;

  const tok = await refreshAccessToken(refresh);
  setSessionCookies(res, tok);
  return tok.access_token;
}

export function randomState() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}
