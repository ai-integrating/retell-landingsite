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
  if (req.body && typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
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

function ymd(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function normalizeSlug(slug = "") {
  return String(slug).trim().toLowerCase().replace(/\s+/g, "-").replace(/_/g, "-");
}

function normalizeServiceKey(v = "") {
  return String(v).trim().toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "_").replace(/_+/g, "_");
}

function resolveEventTypeSlug(req, body) {
  const args = body.args || body || {};
  const bodySlug = args.eventTypeSlug || args.event_slug || args.eventSlug || args.slug || args.service_key || null;
  const headerSlug = req.headers["x-cal-slug"] || null;
  const chosen = bodySlug || headerSlug || "";
  return normalizeSlug(chosen);
}

function tokenKeyForAgent(agentId) {
  const a = asString(agentId);
  return a ? `cal:tokens:agent:${a}` : "";
}

function getCalRedirectUri() {
  return process.env.CAL_OAUTH_REDIRECT_URI || process.env.CAL_REDIRECT_URI || "";
}

// -------------------- AUTO-RESOLVE CAL CONFIG FROM AGENT --------------------
async function resolveCalFromAgent(req, body) {
  const args = body.args || body || {};
  const agentId = asString(req.headers["x-agent-id"] || body.agent_id || body.agentId || args.agent_id, "");

  if (!agentId) return null;

  const clientId = await kv.get(`agent:${agentId}:client`);
  if (!clientId) return { agentId, error: "no_client_mapping" };

  const cal = await kv.get(`client:${clientId}:cal`);
  if (!cal || typeof cal !== "object") {
    return { agentId, clientId: String(clientId), error: "no_cal_config" };
  }

  return {
    agentId,
    clientId: String(clientId),
    username: asString(cal.username, ""),
    eventTypeSlug: asString(cal.eventTypeSlug, ""),
    eventTypeSlugs: cal.eventTypeSlugs && typeof cal.eventTypeSlugs === "object" ? cal.eventTypeSlugs : null,
    timeZone: asString(cal.timeZone, "America/New_York")
  };
}

function pickResolvedSlug(body, resolved) {
  if (!resolved) return "";
  if (resolved.eventTypeSlug) return normalizeSlug(resolved.eventTypeSlug);
  const args = body.args || body || {};
  const serviceKey = normalizeServiceKey(args.service_key || args.serviceKey || args.service);
  if (serviceKey && resolved.eventTypeSlugs && resolved.eventTypeSlugs[serviceKey]) {
    return normalizeSlug(resolved.eventTypeSlugs[serviceKey]);
  }
  return "";
}

function getCalHeaders() {
  return {
    "Content-Type": "application/json",
    "cal-api-version": CAL_API_VERSION,
    Authorization: `Bearer ${process.env.CAL_API_KEY}`
  };
}

function extractCalError(err) {
  return err?.response?.data?.error?.message || err?.response?.data?.message || err?.message || "Unknown Cal.com error";
}

// -------------------- OAUTH HANDLERS --------------------
async function handleOauthStart(req, res, url) {
  const agent_id = asString(url.searchParams.get("agent_id"));
  const email = asString(url.searchParams.get("email"));
  if (!agent_id) return json(res, 400, { error: "agent_id param required" });

  const clientId = process.env.CAL_CLIENT_ID;
  const redirectUri = getCalRedirectUri();
  const nonce = crypto.randomBytes(16).toString("hex");
  await kv.set(`cal:oauth:state:${nonce}`, { agent_id, email: email || "" }, { ex: 600 });

  const authUrl = `https://app.cal.com/auth/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(nonce)}`;
  res.writeHead(302, { Location: authUrl });
  return res.end();
}

async function handleOauthCallback(req, res, url) {
  const code = asString(url.searchParams.get("code"));
  const state = asString(url.searchParams.get("state"));
  const stateRecord = await kv.get(`cal:oauth:state:${state}`);
  if (!stateRecord?.agent_id) return json(res, 400, { error: "Invalid state" });
  await kv.del(`cal:oauth:state:${state}`);

  try {
    const tokenResp = await axios.post("https://api.cal.com/v2/auth/oauth2/token", {
      client_id: process.env.CAL_CLIENT_ID,
      client_secret: process.env.CAL_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: getCalRedirectUri()
    }, { headers: { "Content-Type": "application/json", "cal-api-version": CAL_API_VERSION } });

    const data = tokenResp.data || {};
    const tokenPayload = { access_token: data.access_token, refresh_token: data.refresh_token };
    await kv.set(tokenKeyForAgent(stateRecord.agent_id), tokenPayload);

    res.writeHead(302, { Location: "https://app.cal.com/event-types" });
    return res.end();
  } catch (err) {
    return json(res, 500, { error: "OAuth Exchange Failed", detail: extractCalError(err) });
  }
}

// -------------------- AVAILABILITY (V2) --------------------
async function handleAvailability(req, res, body) {
  const resolved = await resolveCalFromAgent(req, body);
  let username = asString(req.headers["x-cal-username"] || body.username || body.args?.username);
  let eventTypeSlug = resolveEventTypeSlug(req, body);

  if (!username && resolved?.username) username = resolved.username;
  if (!eventTypeSlug) eventTypeSlug = pickResolvedSlug(body, resolved);

  const args = body.args || body || {};
  const timeZone = asString(args.timeZone || args.time_zone || body.timeZone) || resolved?.timeZone || "America/New_York";

  if (!username || !eventTypeSlug) {
    return json(res, 400, { error: "Missing Client Config", debug: { agentId: resolved?.agentId || "not_found" } });
  }

  const start = asString(body.start_date || body.args?.start_date, ymd(Date.now()));
  const end = asString(body.end_date || body.args?.end_date, ymd(Date.now() + 7 * 24 * 60 * 60 * 1000));
  const url = `https://api.cal.com/v2/slots?username=${encodeURIComponent(username)}&eventTypeSlug=${encodeURIComponent(eventTypeSlug)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&timeZone=${encodeURIComponent(timeZone)}`;

  try {
    const resp = await axios.get(url, { headers: getCalHeaders() });
    const starts = Object.values(resp.data?.data || {}).flat().map((s) => s.start).filter(Boolean);
    return json(res, 200, { ok: true, available_slots: starts });
  } catch (err) {
    return json(res, 500, { error: "Cal fetch failed", message: extractCalError(err) });
  }
}

// -------------------- BOOK (V1 STABLE) --------------------
async function handleBook(req, res, body) {
  const resolved = await resolveCalFromAgent(req, body);
  let username = asString(req.headers["x-cal-username"] || body.username || body.args?.username);
  let eventTypeSlug = resolveEventTypeSlug(req, body);

  if (!username && resolved?.username) username = resolved.username;
  if (!eventTypeSlug) eventTypeSlug = pickResolvedSlug(body, resolved);

  const args = body.args || body || {};

  const start = asString(args.start || args.slot || args.selected_start || args.time);
  const name = asString(args.attendee_name || args.name || args.customer_name || args.full_name);
  const email = asString(args.attendee_email || args.email || args.customer_email).toLowerCase();
  const phone = asString(args.phone || args.phoneNumber || args.phone_number);
  const timeZone = asString(args.timeZone || args.time_zone) || resolved?.timeZone || "America/New_York";

  if (!start || !name || !email || !username || !eventTypeSlug) {
    return json(res, 400, { 
      error: "Missing details", 
      debug: { hasStart: !!start, hasName: !!name, hasEmail: !!email, hasUser: !!username, hasSlug: !!eventTypeSlug } 
    });
  }

  // Flatter V1 payload
  const v1Payload = {
    start,
    name,
    email,
    username,
    eventTypeSlug,
    timeZone,
    language: "en",
    metadata: {},
    ...(phone ? { smsReminderNumber: phone } : {})
  };

  // FIX: Properly handle eventTypeId to satisfy Cal V1 "Required" constraint
  // We check args, then headers. If we find it, we force it to a Number.
  const rawId = args.eventTypeId || args.event_type_id || req.headers["x-cal-event-id"];
  if (rawId && !isNaN(rawId)) {
    v1Payload.eventTypeId = Number(rawId);
  }

  try {
    const resp = await axios.post("https://api.cal.com/v1/bookings", v1Payload, {
      params: { apiKey: process.env.CAL_API_KEY }
    });

    return json(res, 200, { ok: true, booking: resp.data });
  } catch (err) {
    const msg = extractCalError(err);
    console.error("CAL V1 BOOK ERROR:", msg);
    return json(res, 500, { error: "Booking failed", message: msg });
  }
}

// -------------------- ROUTER --------------------
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const body = req.method === "POST" ? await readJsonBody(req) : {};
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action")?.toLowerCase();

  if (req.method === "GET" && action === "oauth_start") return await handleOauthStart(req, res, url);
  if (req.method === "GET" && action === "oauth_callback") return await handleOauthCallback(req, res, url);
  if (req.method === "POST" && action === "availability") return await handleAvailability(req, res, body);
  if (req.method === "POST" && action === "book") return await handleBook(req, res, body);

  return json(res, 400, { error: "Unknown action" });
};
