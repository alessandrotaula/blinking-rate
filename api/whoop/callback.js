import { exchangeCode, setSessionCookies, readCookies, getCookieNames } from "../_lib/whoop.js";

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errParam = url.searchParams.get("error");
  const cookies = readCookies(req);
  const { COOKIE_STATE } = getCookieNames();

  const redirectHome = (qs) => {
    res.statusCode = 302;
    res.setHeader("Location", "/?" + qs);
    res.end();
  };

  try {
    if (errParam) return redirectHome(`whoop=error&detail=${encodeURIComponent(errParam)}`);
    if (!code || !state) return redirectHome("whoop=error&detail=missing_code");
    if (!cookies[COOKIE_STATE] || cookies[COOKIE_STATE] !== state) {
      return redirectHome("whoop=error&detail=state_mismatch");
    }
    const tok = await exchangeCode(code);
    setSessionCookies(res, tok);
    redirectHome("whoop=connected");
  } catch (e) {
    redirectHome(`whoop=error&detail=${encodeURIComponent(e.message)}`);
  }
}
