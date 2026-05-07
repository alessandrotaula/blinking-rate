const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";

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

async function exchangeCode(code) {
  const id = process.env.WHOOP_CLIENT_ID;
  const secret = process.env.WHOOP_CLIENT_SECRET;
  const redirect = process.env.WHOOP_REDIRECT_URI;
  if (!id || !secret || !redirect) throw new Error("server_env_missing");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    client_id: id,
    client_secret: secret,
  });
  const r = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`token_exchange_${r.status}:${text.slice(0, 120)}`);
  }
  return r.json();
}

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errParam = url.searchParams.get("error");
  const cookies = readCookies(req);

  const redirectHome = (qs) => {
    res.statusCode = 302;
    res.setHeader("Location", "/?" + qs);
    res.end();
  };

  try {
    if (errParam) return redirectHome(`whoop=error&detail=${encodeURIComponent(errParam)}`);
    if (!code || !state) return redirectHome("whoop=error&detail=missing_code");
    if (!cookies.whoop_state || cookies.whoop_state !== state) {
      return redirectHome("whoop=error&detail=state_mismatch");
    }
    const tok = await exchangeCode(code);
    setSessionCookies(res, tok);
    redirectHome("whoop=connected");
  } catch (e) {
    redirectHome(`whoop=error&detail=${encodeURIComponent(e.message)}`);
  }
}
