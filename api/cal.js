// /api/cal.js
const axios = require("axios");

// -------------------- CORS & RESPONSES --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Agent-Id, X-Cal-Username, X-Cal-Slug"
  );
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

// -------------------- HELPERS --------------------
async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function asString(v, fallback = "") {
  return v === undefined || v === null ? fallback : String(v).trim();
}

function ymd(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function normalizeSlug(slug = "") {
  return String(slug)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/_/g, "-");
}

function resolveEventTypeSlug(req, body) {
  const args = body.args || body || {};

  const bodySlug =
    args.eventTypeSlug ||
    args.event_slug ||
    args.eventSlug ||
    args.slug ||
    null;

  const headerSlug = req.headers["x-cal-slug"] || null;

  const chosen = bodySlug || headerSlug || "";
  return normalizeSlug(chosen);
}

// -------------------- MAIN HANDLERS --------------------
async function handleAvailability(req, res, body) {
  const username = asString(req.headers["x-cal-username"]);
  const eventTypeSlug = resolveEventTypeSlug(req, body);

  console.log("Availability username:", username);
  console.log("Availability body slug:", body?.args?.event_slug || body?.event_slug || body?.args?.eventTypeSlug || body?.eventTypeSlug || body?.args?.slug || body?.slug || null);
  console.log("Availability header slug:", req.headers["x-cal-slug"] || null);
  console.log("Availability final slug:", eventTypeSlug);

  if (!username || !eventTypeSlug) {
    return json(res, 400, {
      error: "Missing Client Config",
      detail: "Ensure X-Cal-Username is set and an event slug is provided via body or X-Cal-Slug header."
    });
  }

  const headers = {
    "cal-api-version": "2024-09-04",
    Authorization: `Bearer ${process.env.CAL_API_KEY}`
  };

  const start = asString(body.start_date || body.args?.start_date, ymd(Date.now()));
  const end = asString(
    body.end_date || body.args?.end_date,
    ymd(Date.now() + 7 * 24 * 60 * 60 * 1000)
  );

  const url =
    `https://api.cal.com/v2/slots?username=${encodeURIComponent(username)}` +
    `&eventTypeSlug=${encodeURIComponent(eventTypeSlug)}` +
    `&start=${encodeURIComponent(start)}` +
    `&end=${encodeURIComponent(end)}`;

  try {
    const resp = await axios.get(url, { headers });
    const slots = resp.data?.data?.slots || resp.data?.slots || [];
    const starts = slots.map((s) => s.start).filter(Boolean);
    return json(res, 200, { ok: true, available_slots: starts });
  } catch (err) {
    return json(res, 500, {
      error: "Cal fetch failed",
      message: err.response?.data || err.message,
      debug: { username, eventTypeSlug, start, end }
    });
  }
}

async function handleBook(req, res, body) {
  const username = asString(req.headers["x-cal-username"]);
  const eventTypeSlug = resolveEventTypeSlug(req, body);

  const args = body.args || body;
  const start = asString(args.start || args.slot);
  const name = asString(args.attendee_name || args.name);
  const email = asString(args.attendee_email || args.email);

  console.log("Book username:", username);
  console.log("Book body slug:", args.event_slug || args.eventTypeSlug || args.eventSlug || args.slug || null);
  console.log("Book header slug:", req.headers["x-cal-slug"] || null);
  console.log("Book final slug:", eventTypeSlug);

  if (!start || !name || !email || !username || !eventTypeSlug) {
    return json(res, 400, {
      error: "Missing details",
      debug: {
        hasStart: !!start,
        hasName: !!name,
        hasEmail: !!email,
        hasUser: !!username,
        hasEventTypeSlug: !!eventTypeSlug
      }
    });
  }

  const payload = {
    username,
    eventTypeSlug,
    start,
    attendee: {
      name,
      email,
      phoneNumber: args.phone || undefined
    }
  };

  const headers = {
    "cal-api-version": "2024-09-04",
    Authorization: `Bearer ${process.env.CAL_API_KEY}`
  };

  try {
    const resp = await axios.post("https://api.cal.com/v2/bookings", payload, { headers });
    return json(res, 200, { ok: true, booking: resp.data });
  } catch (err) {
    return json(res, 500, {
      error: "Booking failed",
      message: err.response?.data || err.message,
      debug: { username, eventTypeSlug, start }
    });
  }
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const body = req.method === "POST" ? await readJsonBody(req) : {};
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action")?.toLowerCase();

  if (action === "availability") return await handleAvailability(req, res, body);
  if (action === "book") return await handleBook(req, res, body);

  return json(res, 400, { error: "Unknown action" });
};
