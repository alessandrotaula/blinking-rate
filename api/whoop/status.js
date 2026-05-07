import { createHmac, timingSafeEqual } from "node:crypto";

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

export default async function handler(req, res) {
  const cookies = readCookies(req);
  const exp = cookies.whoop_exp ? parseInt(cookies.whoop_exp, 10) : 0;
  const isAdmin = !!verifyAdmin(req);
  const connected = isAdmin && (
    !!(cookies.whoop_access && exp > Date.now()) || !!cookies.whoop_refresh
  );
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ connected, isAdmin }));
}
