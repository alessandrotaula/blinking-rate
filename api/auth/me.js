// GET /api/auth/me — returns the current session info
// Reads the bra_auth cookie, verifies the HMAC, returns { email, isAdmin }.
// Always re-checks isAdmin against ADMIN_EMAILS env var so that
// promoting/demoting an email takes effect on the next request.

import { createHmac, timingSafeEqual } from "node:crypto";

function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64").toString();
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

function verifySession(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [payloadB64, sigB64] = token.split(".");
  const expectedSig = createHmac("sha256", secret).update(payloadB64).digest();
  let givenSig;
  try {
    givenSig = Buffer.from(sigB64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  } catch { return null; }
  if (givenSig.length !== expectedSig.length) return null;
  if (!timingSafeEqual(givenSig, expectedSig)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(payloadB64)); }
  catch { return null; }
  if (!payload?.email || !payload?.exp) return null;
  if (payload.exp < Date.now()) return null;
  return payload;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  try {
    const authSecret = process.env.AUTH_SECRET;
    if (!authSecret) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: "server_env_missing" }));
    }
    const cookies = readCookies(req);
    const session = verifySession(cookies.bra_auth, authSecret);
    if (!session) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ signedIn: false, isAdmin: false }));
    }
    const admins = (process.env.ADMIN_EMAILS || "")
      .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    res.statusCode = 200;
    res.end(JSON.stringify({
      signedIn: true,
      email: session.email,
      isAdmin: admins.includes(session.email),
    }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
}
