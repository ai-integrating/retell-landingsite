// /api/cal.js
const axios = require("axios");
const crypto = require("crypto");
const { kv } = require("@vercel/kv");

// -------------------- CORS & RESPONSES --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Idempotency-Key, X-Agent-Id"
  );
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

// -------------------- QUERY PARSING --------------------
function getQuery(req) {
  const u = new URL(req.url, "http://localhost");
  const q = {};
  for (const [k, v] of u.searchParams.entries()) q[k] = v;
  return q;
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
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

function mergeArgs(body) {
  return {
    ...(body && typeof body === "object" ? body : {}),
    ...(body?.args && typeof body.args === "object" ? body.args : {}),
  };
}

function asString(v, fallback = "") {
  return v === undefined || v === null ? fallback : String(v).trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(asString(email));
}

function ymd(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function tokenKeyForAgent(agentId) {
  const a = asString(agentId);
  return a ? `cal:tokens:agent:${a}` : "";
}

function tokenKeyForEmail(email) {
  const e = asString(email).toLowerCase();
  return e ? `cal:tokens:${e}` : "";
}

function normalizeServiceKey(v) {
  const s = asString(v, "").toLowerCase();
  if (!s) return "";
  return s.replace(/[^\w\s-]/g, "").replace(/\s+/g, "_").replace(/_+/g, "_").trim();
}

function serviceKeyVariants(v) {
  const raw = asString(v, "");
  if (!raw) return [];
  const variants = new Set();
  const underscored = normalizeServiceKey(raw);
  const dashed = raw.toLowerCase().replace(/[^\w\s-]/g, "").replace(/[_\s]+/g, "-");
  [raw.toLowerCase(), underscored, dashed].forEach(v => variants.add(v));
  return Array.from(variants);
}

function isTemplateLike(value) {
  const s = asString(value);
  return !s || s.includes("{{") || s.includes("}}") || s.includes("{") || s.includes("}");
}

function extractStartTimes(raw) {
  const candidate = raw?.slots ?? raw;
  let starts = [];
  if (Array.isArray(candidate)) {
    starts = candidate.map((s) => (typeof s === "string" ? s : s?.start || s?.time || null)).filter(Boolean);
  } else if (candidate && typeof candidate === "object") {
    for (const k of Object.keys(candidate)) {
      const v = candidate[k];
      if (Array.isArray(v)) v.forEach(item => {
        const st = typeof item === "string" ? item : item?.start || item?.time || null;
        if (st) starts.push(st);
      });
    }
  }
  return starts.sort();
}

// -------------------- CLIENT CAL CONFIG (KV) --------------------
async function getClientCalConfig(agent_id) {
  const aid = asString(agent_id, "");
  if (!aid) return null;
  const client_id = await kv.get(`agent:${aid}:client`);
  if (!client_id) return null;
  const calKey = `client:${client_id}:cal`;
  let cfg = await kv.get(calKey);
  if (typeof cfg === "string") { try { cfg = JSON.parse(cfg); } catch { return { client_id: String(client_id) }; } }
  return cfg && typeof cfg === "object" ? { client_id: String(client_id), ...cfg } : { client_id: String(client_id) };
}

function findMappedSlugFromService(map, rawServiceKey) {
  if (!map || typeof map !== "object") return "";
  const variants = serviceKeyVariants(rawServiceKey);
  for (const variant of variants) {
    if (map[variant]) return map[variant];
  }
  return "";
}

async function resolveCalContext({ agent_id, body }) {
  const clientCfg = await getClientCalConfig(agent_id);
  const username = asString(body?.username, asString(clientCfg?.username, process.env.CAL_USERNAME));
  const rawServiceKey = body?.service_key || body?.service || body?.serviceKey || body?.appointment_type || "";
  const mappedSlug = findMappedSlugFromService(clientCfg?.eventTypeSlugs, rawServiceKey);
  const eventTypeSlug = asString(body?.eventTypeSlug, asString(mappedSlug, asString(clientCfg?.eventTypeSlug, process.env.CAL_EVENT_SLUG || "")));
  return { username, eventTypeSlug, timeZone: asString(clientCfg?.timeZone, "America/New_York"), client_id: clientCfg?.client_id };
}

// -------------------- OAUTH & HEADERS --------------------
async function getHeaders({ agent_id, email }) {
  const base = { "cal-api-version": "2024-09-04" };
  return { ...base, Authorization: `Bearer ${process.env.CAL_API_KEY}` };
}

// -------------------- MAIN HANDLERS --------------------
async function handleAvailability(req, res, body) {
  const mergedBody = mergeArgs(body);
  // Check the SaaS Header first!
  const agent_id = asString(req.headers["x-agent-id"] || req.query.agent_id || mergedBody.agent_id);

  if (isTemplateLike(agent_id)) return json(res, 400, { error: "Invalid agent_id", received: agent_id });

  const ctx = await resolveCalContext({ agent_id, body: mergedBody });
  if (!ctx.eventTypeSlug) return json(res, 400, { error: "Missing eventTypeSlug", agent_id });

  const headers = await getHeaders({ agent_id });
  const start = asString(mergedBody.start_date, ymd(Date.now()));
  const end = asString(mergedBody.end_date, ymd(Date.now() + 7 * 24 * 60 * 60 * 1000));

  const url = `https://api.cal.com/v2/slots?username=${encodeURIComponent(ctx.username)}&eventTypeSlug=${encodeURIComponent(ctx.eventTypeSlug)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  const resp = await axios.get(url, { headers });
  let starts = extractStartTimes(resp.data?.data || resp.data);

  return json(res, 200, { ok: true, available_slots: starts, count: starts.length });
}

async function handleBook(req, res, body) {
  const mergedBody = mergeArgs(body);
  const agent_id = asString(req.headers["x-agent-id"] || req.query.agent_id || mergedBody.agent_id);

  if (isTemplateLike(agent_id)) return json(res, 400, { error: "Invalid agent_id", received: agent_id });

  const ctx = await resolveCalContext({ agent_id, body: mergedBody });
  const start = asString(mergedBody.start || mergedBody.selected_start || mergedBody.slot);
  const name = asString(mergedBody.attendee_name || mergedBody.name);
  const email = asString(mergedBody.attendee_email || mergedBody.email);

  if (!start || !name || !email || !ctx.eventTypeSlug) {
    return json(res, 400, { error: "Missing details", debug: { hasStart: !!start, hasName: !!name, hasEmail: !!email, hasSlug: !!ctx.eventTypeSlug } });
  }

  const payload = { 
    username: ctx.username, 
    eventTypeSlug: ctx.eventTypeSlug, 
    start, 
    attendee: { name, email, phoneNumber: mergedBody.phone || undefined } 
  };

  const headers = await getHeaders({ agent_id });
  try {
    const resp = await axios.post("https://api.cal.com/v2/bookings", payload, { headers });
    return json(res, 200, { ok: true, booking: resp.data?.data || resp.data });
  } catch (err) {
    return json(res, 500, { error: "Booking failed", message: err.response?.data || err.message });
  }
}

module.exports = async (req, res) => {
  req.query = req.query || getQuery(req);
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const body = req.method === "POST" ? await readJsonBody(req) : {};
  const action = asString(req.query.action, asString(body.action, "")).toLowerCase();

  if (action === "availability" || action === "slots") return await handleAvailability(req, res, body);
  if (action === "book") return await handleBook(req, res, body);
  return json(res, 400, { error: "Unknown action" });
};
