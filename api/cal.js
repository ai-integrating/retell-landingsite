const axios = require("axios");
const { kv } = require("@vercel/kv");

// Use a stable, widely supported version for both V1 and V2
const CAL_V2_VERSION = "2024-06-11"; 

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

// -------------------- KV RESOLVER --------------------
async function resolveCalConfig(req, body) {
  const args = body.args || body || {};
  // 1. Try to get Agent ID from header or body
  const agentId = asString(req.headers["x-agent-id"] || args.agentId || args.agent_id);
  
  let config = {
    username: asString(req.headers["x-cal-username"]),
    eventTypeSlug: asString(req.headers["x-cal-slug"] || args.eventTypeSlug || args.service_key),
    timeZone: "America/New_York"
  };

  // 2. If we have an Agent ID, try to pull from KV to override/fill blanks
  if (agentId) {
    try {
      const clientId = await kv.get(`agent:${agentId}:client`);
      if (clientId) {
        const kvCal = await kv.get(`client:${clientId}:cal`);
        if (kvCal) {
          config.username = kvCal.username || config.username;
          config.eventTypeSlug = kvCal.eventTypeSlug || config.eventTypeSlug;
          config.timeZone = kvCal.timeZone || config.timeZone;
        }
      }
    } catch (e) {
      console.error("KV Lookup failed, falling back to headers", e);
    }
  }

  return config;
}

// -------------------- MAIN HANDLERS --------------------
async function handleAvailability(req, res, body) {
  const config = await resolveCalConfig(req, body);
  const args = body.args || body || {};

  if (!config.username || !config.eventTypeSlug) {
    return json(res, 400, { error: "Missing Config", debug: config });
  }

  const start = asString(args.start_date, ymd(Date.now()));
  const end = asString(args.end_date, ymd(Date.now() + 7 * 24 * 60 * 60 * 1000));

  const url = `https://api.cal.com/v2/slots?username=${encodeURIComponent(config.username)}&eventTypeSlug=${encodeURIComponent(config.eventTypeSlug)}&start=${start}&end=${end}`;

  try {
    const resp = await axios.get(url, {
      headers: { "cal-api-version": CAL_V2_VERSION, Authorization: `Bearer ${process.env.CAL_API_KEY}` }
    });
    const starts = Object.values(resp.data?.data || {}).flat().map(s => s.start).filter(Boolean);
    return json(res, 200, { ok: true, available_slots: starts });
  } catch (err) {
    return json(res, 500, { error: "Availability Failed", message: err.message });
  }
}

async function handleBook(req, res, body) {
  const config = await resolveCalConfig(req, body);
  const args = body.args || body || {};

  const start = asString(args.start || args.slot || args.selected_start);
  const name = asString(args.attendee_name || args.name);
  const email = asString(args.attendee_email || args.email);

  if (!start || !name || !email || !config.username || !config.eventTypeSlug) {
    return json(res, 400, { error: "Missing details", debug: { ...config, hasStart: !!start, hasName: !!name, hasEmail: !!email } });
  }

  const payload = {
    username: config.username,
    eventTypeSlug: config.eventTypeSlug,
    start,
    attendee: { name, email, timeZone: config.timeZone }
  };

  try {
    const resp = await axios.post("https://api.cal.com/v2/bookings", payload, {
      headers: { "Content-Type": "application/json", "cal-api-version": CAL_V2_VERSION, Authorization: `Bearer ${process.env.CAL_API_KEY}` }
    });
    return json(res, 200, { ok: true, booking: resp.data });
  } catch (err) {
    return json(res, 500, { error: "Booking failed", message: err.response?.data || err.message });
  }
}

// -------------------- ROUTER --------------------
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action")?.toLowerCase();
  const body = req.method === "POST" ? await readJsonBody(req) : {};

  if (action === "availability") return await handleAvailability(req, res, body);
  if (action === "book") return await handleBook(req, res, body);

  return json(res, 400, { error: "Unknown action" });
};
