export default async function handler(req, res) {
  res.setHeader("Set-Cookie", [
    "whoop_access=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    "whoop_refresh=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    "whoop_exp=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    "whoop_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
  ]);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true }));
}
