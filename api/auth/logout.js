export default async function handler(req, res) {
  res.setHeader("Set-Cookie",
    "bra_auth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  );
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true }));
}
