import { readCookies, getCookieNames } from "../_lib/whoop.js";

export default async function handler(req, res) {
  const cookies = readCookies(req);
  const { COOKIE_ACCESS, COOKIE_REFRESH, COOKIE_EXP } = getCookieNames();
  const exp = cookies[COOKIE_EXP] ? parseInt(cookies[COOKIE_EXP], 10) : 0;
  const connected = !!(cookies[COOKIE_ACCESS] && exp > Date.now()) || !!cookies[COOKIE_REFRESH];
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ connected }));
}
