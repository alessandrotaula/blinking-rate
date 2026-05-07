import { WHOOP_API_BASE, getValidAccessToken, clearSessionCookies } from "../_lib/whoop.js";

export default async function handler(req, res) {
  try {
    const token = await getValidAccessToken(req, res);
    if (!token) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "not_connected" }));
      return;
    }

    const url = new URL(req.url, `https://${req.headers.host}`);
    const start = url.searchParams.get("start");
    const end   = url.searchParams.get("end");

    const items = [];
    let nextToken = null;
    let pages = 0;
    do {
      const apiUrl = new URL(`${WHOOP_API_BASE}/recovery`);
      if (start) apiUrl.searchParams.set("start", start);
      if (end)   apiUrl.searchParams.set("end", end);
      apiUrl.searchParams.set("limit", "25");
      if (nextToken) apiUrl.searchParams.set("nextToken", nextToken);

      const r = await fetch(apiUrl.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.status === 401) {
        clearSessionCookies(res);
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "session_expired" }));
        return;
      }
      if (!r.ok) {
        const text = await r.text();
        res.statusCode = r.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "whoop_api", status: r.status, detail: text.slice(0, 500) }));
        return;
      }
      const json = await r.json();
      items.push(...(json.records || []));
      nextToken = json.next_token || null;
      pages++;
    } while (nextToken && pages < 10);

    const simplified = items.map(rec => ({
      cycle_id: rec.cycle_id,
      date: rec.created_at?.slice(0, 10) || null,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
      score_state: rec.score_state,
      hrv_ms: rec.score?.hrv_rmssd_milli ?? null,
      resting_hr: rec.score?.resting_heart_rate ?? null,
      recovery_score: rec.score?.recovery_score ?? null,
      user_calibrating: rec.score?.user_calibrating ?? false,
    })).filter(r => r.date);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ records: simplified }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: e.message }));
  }
}
