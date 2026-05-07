// POST /api/auth/login
// Body: { id_token }
// Verifies the Google ID token via Google's tokeninfo endpoint, then sets a
// signed HttpOnly session cookie. Returns user info + admin flag (admin iff
// the email is in the ADMIN_EMAILS env var).
//
// Required env vars:
//   GOOGLE_CLIENT_ID — same value used in the front-end (audience claim)
//   AUTH_SECRET      — any long random string; signs the session cookie
//   ADMIN_EMAILS     — comma-separated list of admin emails

import { createHmac } from "node:crypto";

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signSession(email, exp, secret) {
  const payload = b64url(JSON.stringify({ email, exp }));
  const sig = b64url(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

async function readBody(req) {
  if (req.body) return req.body;
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "method_not_allowed" }));
  }
  try {
    const expectedAud = process.env.GOOGLE_CLIENT_ID;
    const authSecret = process.env.AUTH_SECRET;
    if (!expectedAud || !authSecret) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({
        error: "server_env_missing",
        detail: "Set GOOGLE_CLIENT_ID and AUTH_SECRET in Vercel env vars."
      }));
    }
    const body = await readBody(req);
    const idToken = body.id_token;
    if (!idToken) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "missing_id_token" }));
    }

    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!r.ok) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "invalid_token", status: r.status }));
    }
    const t = await r.json();
    if (t.error) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "invalid_token", detail: t.error_description || t.error }));
    }
    if (t.aud !== expectedAud) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "audience_mismatch" }));
    }
    if (!t.iss || !/^https?:\/\/accounts\.google\.com$|^accounts\.google\.com$/.test(t.iss)) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "issuer_mismatch" }));
    }
    if (Number(t.exp) * 1000 < Date.now()) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "token_expired" }));
    }
    if (t.email_verified !== "true" && t.email_verified !== true) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "email_unverified" }));
    }

    const email = String(t.email).toLowerCase();
    const admins = (process.env.ADMIN_EMAILS || "")
      .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    const isAdmin = admins.includes(email);

    const sessionMaxAge = 60 * 60 * 24 * 14;
    const exp = Date.now() + sessionMaxAge * 1000;
    const session = signSession(email, exp, authSecret);
    res.setHeader("Set-Cookie",
      `bra_auth=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${sessionMaxAge}`
    );
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      email,
      isAdmin,
      name: t.name || null,
      picture: t.picture || null,
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: e.message }));
  }
}
