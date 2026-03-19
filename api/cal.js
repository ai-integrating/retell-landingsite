const axios = require("axios");
const crypto = require("crypto");
const { kv } = require("@vercel/kv");

const CAL_API_VERSION = "2024-09-04";

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
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

function asString(v, fallback = "") {
  return v === undefined || v === null ? fallback : String(v).trim();
}

function normalizeSlug(slug = "") {
  return String(slug).trim().toLowerCase().replace(/\s+/g, "-").replace(/_/g, "-");
}

function resolveEventTypeSlug(req, body) {
  const args = body.args || body || {};
  const chosen = args.eventTypeSlug || args.event_slug || args.eventSlug || args.slug || args.service_key || req.headers["x-cal-slug"] || "";
  return normalizeSlug(chosen);
}

// -------------------- KV LOOKUP --------------------
async function resolveCalFromAgent(req, body) {
  const args = body.args || body || {};
  const agentId = asString(req.headers["x-agent-id"] || body.agent_id || args.agent_id, "");
  if (!agentId) return null;
  const clientId = await kv.get(`agent:${agentId}:client`);
  if (!clientId) return null;
  const cal = await kv.get(`client:${clientId}:cal`);
  return cal && typeof cal === "object" ? cal : null;
}

// -------------------- AVAILABILITY --------------------
async function handleAvailability(req, res, body) {
  const resolved = await resolveCalFromAgent(req, body);
  let username = asString(req.headers["x-cal-username"] || body.username || body.args?.username || resolved?.username);
  let eventTypeSlug = resolveEventTypeSlug(req, body);

  if (!username || !eventTypeSlug) return json(res, 400, { error: "Missing Config" });

  const args = body.args || body || {};
  const start = asString(args.start_date, new Date().toISOString().slice(0, 10));
  const end = asString(args.end_date, new Date(Date.now() + 604800000).toISOString().slice(0, 10));

  const url = `https://api.cal.com/v2/slots?username=${encodeURIComponent(username)}&eventTypeSlug=${encodeURIComponent(eventTypeSlug)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;

  try {
    const resp = await axios.get(url, { headers: { "cal-api-version": CAL_API_VERSION, Authorization: `Bearer ${process.env.CAL_API_KEY}` } });
    const starts = Object.values(resp.data?.data || {}).flat().map((s) => s.start).filter(Boolean);
    return json(res, 200, { ok: true, available_slots: starts });
  } catch (err) {
    return json(res, 500, { error: "Fetch failed", message: err.message });
  }
}

// -------------------- BOOK (MATCHED TO OLD WORKING PAYLOAD) --------------------
async function handleBook(req, res, body) {
  const resolved = await resolveCalFromAgent(req, body);
  const args = body.args || body; // Look specifically in args for Retell data

  const username = asString(req.headers["x-cal-username"] || body.username || args.username || resolved?.username);
  const eventTypeSlug = resolveEventTypeSlug(req, body);
  
  // Extracting exactly as your old working code did
  const start = asString(args.start || args.slot || args.selected_start);
  const name = asString(args.name || args.attendee_name || args.customer_name);
  const email = asString(args.email || args.attendee_email || args.customer_email).toLowerCase();

  // DEBUG: This will show up in Vercel logs so we can see the data flow
  console.log("BOOKING ATTEMPT:", { username, eventTypeSlug, start, name, email });

  if (!start || !name || !email || !username || !eventTypeSlug) {
    return json(res, 400, { 
      error: "Missing details", 
      debug: { hasStart: !!start, hasName: !!name, hasEmail: !!email, hasUser: !!username, hasSlug: !!eventTypeSlug } 
    });
  }

  // The Exact Payload Structure Cal.com expects
  const payload = {
    username,
    eventTypeSlug,
    start,
    attendee: {
      name,
      email,
      timeZone: "America/New_York" 
    }
  };

  try {
    const resp = await axios.post("https://api.cal.com/v2/bookings", payload, {
      headers: { 
        "Content-Type": "application/json", 
        "cal-api-version": "2024-09-04", 
        "Authorization": `Bearer ${process.env.CAL_API_KEY}` 
      }
    });
    return json(res, 200, { ok: true, booking: resp.data });
  } catch (err) {
    return json(res, 500, { error: "Booking failed", detail: err.response?.data || err.message });
  }
}

// -------------------- ROUTER --------------------
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const body = await readJsonBody(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action")?.toLowerCase();

  if (action === "availability") return await handleAvailability(req, res, body);
  if (action === "book") return await handleBook(req, res, body);
  return json(res, 400, { error: "Unknown action" });
};
