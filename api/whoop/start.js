// Each handler is self-contained — no shared imports — so Vercel's bundler
// can't drop a referenced helper from the deployment artefact.
//
// Required env vars (set in Vercel project settings):
//   WHOOP_CLIENT_ID
//   WHOOP_CLIENT_SECRET
//   WHOOP_REDIRECT_URI   e.g. https://blinking-rate.vercel.app/api/whoop/callback

const WHOOP_AUTH_URL  = "https://api.prod.whoop.com/oauth/oauth2/auth";
const WHOOP_SCOPES    = "read:recovery read:cycles read:sleep offline";

function setStateCookie(res, state) {
  res.setHeader(
    "Set-Cookie",
    `whoop_state=${encodeURIComponent(state)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );
}

function randomState() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

export default async function handler(req, res) {
  try {
    const id = process.env.WHOOP_CLIENT_ID;
    const redirect = process.env.WHOOP_REDIRECT_URI;
    if (!id || !redirect) {
      res.statusCode = 302;
      res.setHeader("Location", "/?whoop=error&detail=server_env_missing");
      res.end();
      return;
    }
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
    res.statusCode = 302;
    res.setHeader("Location", "/?whoop=error&detail=" + encodeURIComponent(e.message));
    res.end();
  }
}
