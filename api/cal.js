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

// -------------------- BOOKING LOGIC --------------------
async function handleBook(req, res, body) {
  const args = body.args || {};
  
  // 1. Resolve Identity (Check Headers -> Check Args -> Check KV)
  // We'll try to find the Agent ID to do a KV lookup
  const agentId = req.headers["x-agent-id"] || body.agent_id || args.agent_id || "";
  let resolved = null;
  if (agentId) {
    const clientId = await kv.get(`agent:${agentId}:client`);
    if (clientId) resolved = await kv.get(`client:${clientId}:cal`);
  }

  // Final Username/Slug Resolution (Fallback to your known working values)
  const username = resolved?.username || req.headers["x-cal-username"] || body.username || args.username || "";
  const eventTypeSlug = resolved?.eventTypeSlug || req.headers["x-cal-slug"] || body.event_slug || args.event_slug || args.eventTypeSlug || "";

  // 2. The "Deep Search" for Attendee Info
  // Retell often names these differently. We check the most common variations.
  const start = body.start || args.start || body.start_time || args.start_time || body.slot || args.slot || "";
  const name = body.name || args.name || body.attendee_name || args.attendee_name || body.customer_name || args.customer_name || "";
  const email = (body.email || args.email || body.attendee_email || args.attendee_email || "").toLowerCase().trim();

  // 3. Validation with Log
  console.log("FINAL ATTEMPT PARAMS:", { username, eventTypeSlug, start, name, email });

  if (!start || !name || !email || !username || !eventTypeSlug) {
    return json(res, 400, { 
      error: "Missing details", 
      debug: { 
        hasStart: !!start, 
        hasName: !!name, 
        hasEmail: !!email, 
        hasUser: !!username, 
        hasSlug: !!eventTypeSlug,
        receivedData: body // This lets us see exactly what Retell sent if it fails again
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
      detail: err.response?.data || err.message 
    });
  }
}

// -------------------- ROUTER --------------------
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  
  const body = await readJsonBody(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action")?.toLowerCase();

  if (action === "book") return await handleBook(req, res, body);
  
  // Basic Availability (Simpler version to ensure it doesn't break)
  if (action === "availability") {
     // Re-run the same identity logic for availability if needed
     return json(res, 200, { message: "Action received, but focus is on 'book' fix right now." });
  }

  return json(res, 400, { error: "Unknown action" });
};
