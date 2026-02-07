// /api/cal.js
// Combines Cal.com availability + booking into ONE Vercel function.

const axios = require("axios");

// -------------------- CORS --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Idempotency-Key"
  );
}

// -------------------- JSON RESPONSE --------------------
function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
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
function asString(v, fallback = "") {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  return s ? s : fallback;
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

function ymd(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// -------------------- MAIN --------------------
module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  const body = req.method === "POST" ? await readJsonBody(req) : {};

  // action can come from query string or body
  const action = asString(req.query.action, asString(body.action, "")).toLowerCase();

  // env
  const CAL_API_KEY = process.env.CAL_API_KEY;
  const username = process.env.CAL_USERNAME || "ai-integrating";
  const eventTypeSlug = process.env.CAL_EVENT_SLUG || "ai-intake-call-test";
  const timeZone = process.env.CAL_TIMEZONE || "America/New_York";

  if (!CAL_API_KEY) return json(res, 500, { ok: false, error: "Missing CAL_API_KEY" });

  try {
    // -------------------- AVAILABILITY --------------------
    // GET /api/cal?action=availability&days=7&limit=10
    // OR POST /api/cal with { action: "availability", days: 7, limit: 10 }
    if (action === "availability" || action === "slots") {
      const days = Number(req.query.days || body.days || 7);
      const limit = Number(req.query.limit || body.limit || 10);

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
          "cal-api-version": "2024-09-04",
        },
        timeout: 30000,
      });

      const byDate = resp?.data?.data || {};
      const starts = [];

      for (const day of Object.keys(byDate).sort()) {
        const slots = byDate[day] || [];
        for (const s of slots) {
          if (s?.start) starts.push(s.start);
        }
      }

      return json(res, 200, {
        ok: true,
        action: "availability",
        username,
        eventTypeSlug,
        timeZone,
        start,
        end,
        starts: starts.slice(0, limit),
        rawCount: starts.length,
      });
    }

    // -------------------- BOOK --------------------
    // POST /api/cal?action=book
    // Body:
    // {
    //   "start": "2026-02-07T15:00:00Z",
    //   "attendee": { "name": "...", "email": "...", "phoneNumber": "+1...", "timeZone": "America/New_York" },
    //   "agent_id": "...", "client_id": "...", "retell_call_id": "...", "reason_for_call": "..."
    // }
    if (action === "book" || action === "booking") {
      if (req.method !== "POST") {
        return json(res, 405, { ok: false, error: "Booking requires POST" });
      }

      const startISO = asString(body.start, "");
      if (!startISO) return json(res, 400, { ok: false, error: "Missing start (ISO time)" });

      const attendee = body.attendee || {};
      const attendeeName = asString(attendee.name, asString(body.name, ""));
      const attendeeEmail = asString(attendee.email, asString(body.email, ""));
      const attendeePhone = cleanPhone(attendee.phoneNumber || body.phone || body.phoneNumber);
      const attendeeTZ = asString(attendee.timeZone, asString(body.timeZone, timeZone));

      if (!attendeeName) return json(res, 400, { ok: false, error: "Missing attendee name" });
      if (!attendeeEmail) return json(res, 400, { ok: false, error: "Missing attendee email" });
      if (!attendeePhone) return json(res, 400, { ok: false, error: "Missing attendee phoneNumber" });

      const idempotency_key =
        req.headers["x-idempotency-key"] ||
        asString(body.idempotency_key, asString(body.request_id, ""));

      const payload = {
        start: startISO,
        eventTypeSlug,
        username,
        attendee: {
          name: attendeeName,
          email: attendeeEmail,
          phoneNumber: attendeePhone,
          timeZone: attendeeTZ,
        },
        metadata: {
          agent_id: asString(body.agent_id, ""),
          client_id: asString(body.client_id, ""),
          retell_call_id: asString(body.retell_call_id, ""),
          idempotency_key: asString(idempotency_key, ""),
          reason_for_call: asString(body.reason_for_call, ""),
        },
      };

      const resp = await axios.post("https://api.cal.com/v2/bookings", payload, {
        headers: {
          Authorization: `Bearer ${CAL_API_KEY}`,
          "Content-Type": "application/json",
          "cal-api-version": "2024-08-13",
        },
        timeout: 30000,
      });

      return json(res, 200, {
        ok: true,
        action: "book",
        booking: resp.data,
      });
    }

    // -------------------- HELP --------------------
    return json(res, 400, {
      ok: false,
      error: "Missing/unknown action. Use action=availability or action=book.",
      examples: {
        availability: "/api/cal?action=availability&days=7&limit=10",
        book: "POST /api/cal?action=book with { start, attendee{...} }",
      },
    });
  } catch (err) {
    const msg = err?.response?.data || err?.message || "Unknown error";
    return json(res, 500, { ok: false, error: msg });
  }
};
