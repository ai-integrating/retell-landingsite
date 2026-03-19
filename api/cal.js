const axios = require("axios");
const { kv } = require("@vercel/kv");

const CAL_API_VERSION = "2024-09-04";

// -------------------- CORS & RESPONSES --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Agent-Id, X-Cal-Username, X-Cal-Slug");
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

// -------------------- IDENTITY RESOLUTION --------------------
async function getCalConfig(req, body) {
  const args = body.args || {};
  const agentId = req.headers["x-agent-id"] || body.agent_id || args.agent_id || "";
  
  let kvConfig = null;
  if (agentId) {
    try {
      const clientId = await kv.get(`agent:${agentId}:client`);
      if (clientId) kvConfig = await kv.get(`client:${clientId}:cal`);
    } catch (e) {
      console.error("KV Lookup Error:", e.message);
    }
  }

  // PRIORITY: KV Store -> Headers (Hardcoded in Retell) -> Request Body
  return {
    username: asString(kvConfig?.username || req.headers["x-cal-username"] || body.username || args.username),
    eventTypeSlug: asString(kvConfig?.eventTypeSlug || req.headers["x-cal-slug"] || body.event_slug || args.event_slug || args.eventTypeSlug)
  };
}

// -------------------- MAIN HANDLERS --------------------
async function handleAvailability(req, res, body) {
  const config = await getCalConfig(req, body);
  const args = body.args || body;

  if (!config.username || !config.eventTypeSlug) {
    return json(res, 400, { error: "Missing Config", debug: config });
  }

  const start = asString(args.start_date || body.start_date, new Date().toISOString().slice(0, 10));
  const end = asString(args.end_date || body.end_date, new Date(Date.now() + 604800000).toISOString().slice(0, 10));

  const url = `https://api.cal.com/v2/slots?username=${encodeURIComponent(config.username)}&eventTypeSlug=${encodeURIComponent(config.eventTypeSlug)}&start=${start}&end=${end}`;

  try {
    const resp = await axios.get(url, { 
      headers: { "cal-api-version": CAL_API_VERSION, Authorization: `Bearer ${process.env.CAL_API_KEY}` } 
    });
    const starts = Object.values(resp.data?.data || {}).flat().map(s => s.start).filter(Boolean);
    return json(res, 200, { ok: true, available_slots: starts });
  } catch (err) {
    return json(res, 500, { error: "Availability failed", message: err.message });
  }
}

async function handleBook(req, res, body) {
  const config = await getCalConfig(req, body);
  const args = body.args || body;

  // Search for attendee details in both root and args
  const start = asString(args.start || body.start || args.start_time || body.start_time);
  const name = asString(args.name || body.name || args.attendee_name || body.attendee_name);
  const email = asString(args.email || body.email || args.attendee_email || body.attendee_email).toLowerCase();

  if (!start || !name || !email || !config.username || !config.eventTypeSlug) {
    return json(res, 400, { 
      error: "Missing details", 
      debug: { 
        hasStart: !!start, 
        hasName: !!name, 
        hasEmail: !!email, 
        hasUser: !!config.username, 
        hasSlug: !!config.eventTypeSlug,
        retrievedConfig: config
      } 
    });
  }

  const payload = {
    username: config.username,
    eventTypeSlug: config.eventTypeSlug,
    start,
    attendee: { name, email, timeZone: "America/New_York" }
  };

  try {
    const resp = await axios.post("https://api.cal.com/v2/bookings", payload, {
      headers: { 
        "Content-Type": "application/json", 
        "cal-api-version": CAL_API_VERSION, 
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
