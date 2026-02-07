// /api/cal-availability.js
// Returns next available slot start times for a Cal.com event type.

const axios = require("axios");

// -------------------- CORS --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// -------------------- HELPERS --------------------
function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

// YYYY-MM-DD
function ymd(d) {
  return d.toISOString().slice(0, 10);
}

function pickEnv(name, fallback) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : fallback;
}

// -------------------- MAIN --------------------
module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  try {
    const CAL_API_KEY = pickEnv("CAL_API_KEY", "");
    const username = pickEnv("CAL_USERNAME", "ai-integrating");
    const eventTypeSlug = pickEnv("CAL_EVENT_SLUG", "ai-intake-call-test");
    const timeZone = pickEnv("CAL_TIMEZONE", "America/New_York");

    if (!CAL_API_KEY) return json(res, 500, { ok: false, error: "Missing CAL_API_KEY" });

    // allow optional overrides
    const days = Number(req.query?.days || 7);
    const limit = Number(req.query?.limit || 10);

    const now = new Date();
    const start = ymd(now);
    const end = ymd(new Date(now.getTime() + days * 24 * 60 * 60 * 1000));

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
        // slots endpoint version
        "cal-api-version": "2024-09-04",
      },
      timeout: 30000,
    });

    const byDate = resp?.data?.data || {};
    const starts = [];

    Object.keys(byDate)
      .sort()
      .forEach((day) => {
        const slots = byDate[day] || [];
        for (const s of slots) {
          if (s && s.start) starts.push(s.start);
        }
      });

    return json(res, 200, {
      ok: true,
      username,
      eventTypeSlug,
      timeZone,
      start,
      end,
      starts: starts.slice(0, limit),
    });
  } catch (err) {
    const msg = err?.response?.data || err?.message || "Unknown error";
    return json(res, 500, { ok: false, error: msg });
  }
};
