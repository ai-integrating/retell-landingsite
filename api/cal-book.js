// /api/cal-book.js
const axios = require("axios");

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (req.body && typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });

  try {
    const body = await readJsonBody(req);

    const CAL_API_KEY = process.env.CAL_API_KEY;
    const username = process.env.CAL_USERNAME || "ai-integrating";
    const eventTypeSlug = process.env.CAL_EVENT_SLUG || "ai-intake-call-test";
    const timeZone = process.env.CAL_TIMEZONE || "America/New_York";

    if (!CAL_API_KEY) return json(res, 500, { ok: false, error: "Missing CAL_API_KEY" });

    // Required inputs
    const start = body.start; // must be ISO 8601 UTC (e.g. "2026-02-08T15:00:00Z") :contentReference[oaicite:5]{index=5}
    const attendee = body.attendee; // {name,email,phoneNumber,timeZone}

    if (!start) return json(res, 400, { ok: false, error: "Missing start" });
    if (!attendee?.name) return json(res, 400, { ok: false, error: "Missing attendee.name" });
    if (!attendee?.email) return json(res, 400, { ok: false, error: "Missing attendee.email" });
    if (!attendee?.phoneNumber) return json(res, 400, { ok: false, error: "Missing attendee.phoneNumber" });

    const payload = {
      start,
      attendee: {
        name: attendee.name,
        email: attendee.email,
        phoneNumber: attendee.phoneNumber,
        timeZone: attendee.timeZone || timeZone,
      },
      eventTypeSlug,
      username,
      // optional but very useful for your system
      metadata: {
        agent_id: body.agent_id || "",
        client_id: body.client_id || "",
        retell_call_id: body.retell_call_id || "",
        idempotency_key: body.idempotency_key || "",
        reason_for_call: body.reason_for_call || "",
      },
    };

    const resp = await axios.post("https://api.cal.com/v2/bookings", payload, {
      headers: {
        Authorization: `Bearer ${CAL_API_KEY}`,
        "Content-Type": "application/json",
        // required version for bookings endpoint :contentReference[oaicite:6]{index=6}
        "cal-api-version": "2024-08-13",
      },
      timeout: 30000,
    });

    return json(res, 200, { ok: true, booking: resp.data });
  } catch (err) {
    const msg = err?.response?.data || err?.message || "Unknown error";
    return json(res, 500, { ok: false, error: msg });
  }
};
