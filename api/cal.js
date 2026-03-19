const axios = require("axios");
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

// -------------------- DYNAMIC KV LOOKUP --------------------
async function resolveCalFromAgent(req, body) {
  const args = body.args || body || {};
  
  // Try to find Agent ID in every possible spot
  const agentId = asString(
    req.headers["x-agent-id"] || 
    req.headers["agent-id"] || 
    body.agent_id || 
    args.agent_id, 
    ""
  );

  if (!agentId) return { error: "no_agent_id_provided" };

  try {
    const clientId = await kv.get(`agent:${agentId}:client`);
    if (!clientId) return { error: `agent_${agentId}_not_mapped_to_client` };

    const cal = await kv.get(`client:${clientId}:cal`);
    if (!cal) return { error: `no_cal_config_for_client_${clientId}` };
    
    return cal;
  } catch (e) {
    return { error: "kv_error", message: e.message };
  }
}

// -------------------- BOOKING LOGIC --------------------
async function handleBook(req, res, body) {
  const resolved = await resolveCalFromAgent(req, body);
  const args = body.args || body;

  // 1. Resolve Identity (KV first, then fallback to your Hardcoded Headers)
  const username = asString(resolved?.username || req.headers["x-cal-username"] || args.username || "");
  const eventTypeSlug = normalizeSlug(resolved?.eventTypeSlug || req.headers["x-cal-slug"] || args.eventTypeSlug || args.slug || "");
  
  // 2. Extract Attendee Info
  const start = asString(args.start || args.slot || args.selected_start || args.time);
  const name = asString(args.name || args.attendee_name || args.customer_name);
  const email = asString(args.email || args.attendee_email || args.customer_email).toLowerCase();

  // 3. Strict Validation with detailed debug output
  if (!start || !name || !email || !username || !eventTypeSlug) {
    return json(res, 400, { 
      error: "Missing details", 
      debug: { 
        hasStart: !!start, 
        hasName: !!name, 
        hasEmail: !!email, 
        hasUser: !!username, 
        hasSlug: !!eventTypeSlug,
        agentLookupResult: resolved // This tells us exactly what KV found
      } 
    });
  }

  const payload = {
    username,
    eventTypeSlug,
    start,
    attendee: { name, email, timeZone: "America/New_York" }
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
    return json(res, 500, { 
      error: "Booking failed", 
      message: err.response?.data?.message || err.message,
      cal_error_raw: err.response?.data 
    });
  }
}

// -------------------- AVAILABILITY (REUSE RESOLVE LOGIC) --------------------
async function handleAvailability(req, res, body) {
  const resolved = await resolveCalFromAgent(req, body);
  const args = body.args || body;
  
  const username = asString(resolved?.username || req.headers["x-cal-username"] || "");
  const eventTypeSlug = normalizeSlug(resolved?.eventTypeSlug || req.headers["x-cal-slug"] || args.slug || "");

  if (!username || !eventTypeSlug) return json(res, 400, { error: "Config missing" });

  const start = asString(args.start_date, new Date().toISOString().slice(0, 10));
  const end = asString(args.end_date, new Date(Date.now() + 604800000).toISOString().slice(0, 10));

  const url = `https://api.cal.com/v2/slots?username=${encodeURIComponent(username)}&eventTypeSlug=${encodeURIComponent(eventTypeSlug)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;

  try {
    const resp = await axios.get(url, { headers: { "cal-api-version": "2024-09-04", Authorization: `Bearer ${process.env.CAL_API_KEY}` } });
    const starts = Object.values(resp.data?.data || {}).flat().map((s) => s.start).filter(Boolean);
    return json(res, 200, { ok: true, available_slots: starts });
  } catch (err) {
    return json(res, 500, { error: "Fetch failed", message: err.message });
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
