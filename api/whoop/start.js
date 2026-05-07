import { WHOOP_AUTH_URL, WHOOP_SCOPES, requireEnv, setStateCookie, randomState } from "../_lib/whoop.js";

export default async function handler(req, res) {
  try {
    const { id, redirect } = requireEnv();
    const state = randomState();
    setStateCookie(res, state);
    const url = new URL(WHOOP_AUTH_URL);
    url.searchParams.set("client_id", id);
    url.searchParams.set("redirect_uri", redirect);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", WHOOP_SCOPES);
    url.searchParams.set("state", state);
    res.statusCode = 302;
    res.setHeader("Location", url.toString());
    res.end();
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: e.message }));
  }
}
