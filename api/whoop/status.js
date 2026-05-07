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

export default async function handler(req, res) {
  const cookies = readCookies(req);
  const exp = cookies.whoop_exp ? parseInt(cookies.whoop_exp, 10) : 0;
  const connected = !!(cookies.whoop_access && exp > Date.now()) || !!cookies.whoop_refresh;
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ connected }));
}
