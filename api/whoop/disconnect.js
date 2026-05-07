import { clearSessionCookies } from "../_lib/whoop.js";

export default async function handler(req, res) {
  clearSessionCookies(res);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true }));
}
