// /api/cal-availability.js
const axios = require("axios");

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function isoDate(d) {
  // YYYY-MM-DD
  return d.toISOString().slice(0, 10);
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST")
    return json(res, 405, { ok: false, error: "Method not allowed" });

  try {
    const CAL_API_KEY = process.env.CAL_API_KEY;
    const username = process.env.CAL_USERNAME || "ai-integrating";
    const eventTypeSlug = process.env.CAL_EVENT_SLUG || "ai-intake-call-test";
    const timeZone = process.env.CAL_TIMEZONE || "America/New_York";

    if (!CAL_API_KEY) return json(res, 500, { ok: false, error: "Missing CAL_API_KEY" });

    // configurable window: default next 7 days
    const now = new Date();
    const start = isoDate(now);
    const end = isoDate(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000));

    const url =
      `https://api.cal.com/v2/slots` +
      `?eventTypeSlug=${encodeURIComponent(eventTypeSlug)}` +
      `&username=${encodeURIComponent(username)}` +
      `&start=${encodeURIComponent(start)}` +
      `&end=${encodeURIComponent(end)}` +
      `&timeZone=${encodeURIComponent(timeZone)}` +
      `&format=time`;

    const resp = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${CAL_API_KEY}`,
        // required version for slots endpoint
        "cal-api-version": "2024-09-04",
      },
      timeout: 30000,
    });

    // resp.data.data is a map: { "YYYY-MM-DD": [{start:"..."}, ...], ... } :contentReference[oaicite:3]{index=3}
    const byDate = resp?.data?.data || {};
    const starts = [];

    for (const day of Object.keys(byDate).sort()) {
      const slots = byDate[day] || [];
      for (const s of slots) {
        if (s?.start) starts.push(s.start);
      }
    }

    // Return first 10 by default
    return json(res, 200, { ok: true, username, eventTypeSlug, timeZone, starts: starts.slice(0, 10) });
  } catch (err) {
    const msg = err?.response?.data || err?.message || "Unknown error";
    return json(res, 500, { ok: false, error: msg });
  }
};
