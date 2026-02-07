// /api/cal-book.js
// Books a Cal.com event for a given start time and attendee.

const axios = require("axios");

// -------------------- CORS --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// -------------------- BODY --------------------
async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (req.body && typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

// -------------------- HELPERS --------------------
function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function pickEnv(name, fallback) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : fallback;
}

function cleanPhone(phone) {
  if (!phone) return "";
  let p = String(phone).trim();
  const digits = p.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (p.startsWith("+")) return p;
  return digits ? `+${digits}` : "";
}

// -------------------- MAIN --------------------
module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });

  try {
    const body = await readJsonBody(req);

    const CAL_API_KEY = pickEnv("CAL_API_KEY", "");
    const username = pickEnv("CAL_USERNAME", "ai-integrating");
    const eventTypeSlug = pickEnv("CAL_EVENT_SLUG", "ai-intake-call-test");
    const defaultTZ = pickEnv("CAL_TIMEZONE", "America/New_York");

    if (!CAL_API_KEY) return json(res, 500, { ok: false, error: "Missing CAL_API_KEY" });

    // Required
    const start = body.start; // ISO string e.g. "2026-02-08T15:00:00.000Z"
    const attendee = body.attendee || {};

    const attendeeName = attendee.name || body.name;
    const attendeeEmail = attendee.email || body.email;
    const attendeePhone = cleanPhone(attendee.phoneNumber || attendee.phone || body.phone);

    if (!start) return json(res, 400, { ok: false, error: "Missing start" });
    if (!attendeeName) return json(res, 400, { ok: false, error: "Missing attendee.name" });
    if (!attendeeEmail) return json(res, 400, { ok: false, error: "Missing attendee.email" });
    if (!attendeePhone) return json(res, 400, { ok: false, error: "Missing attendee.phoneNumber" });

    const payload = {
      start,
      username,
      eventTypeSlug,
      attendee: {
        name: attendeeName,
        email: attendeeEmail,
        phoneNumber: attendeePhone,
        timeZone: attendee.timeZone || body.timeZone || defaultTZ,
      },
      metadata: {
        agent_id: body.agent_id || "",
        client_id: body.client_id || "",
        call_id: body.call_id || "",
        retell_call_id: body.retell_call_id || "",
        idempotency_key: body.idempotency_key || "",
        reason_for_call: body.reason_for_call || "",
      },
    };

    const resp = await axios.post("https://api.cal.com/v2/bookings", payload, {
      headers: {
        Authorization: `Bearer ${CAL_API_KEY}`,
        "Content-Type": "application/json",
        // bookings endpoint version
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
