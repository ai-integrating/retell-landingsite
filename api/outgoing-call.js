// /api/outgoing-call.js
// ✅ FIXED: Restored original payload structure while maintaining new hard limits.

const axios = require("axios");
const { kv } = require("@vercel/kv");

// -------------------- CORS --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Idempotency-Key");
}

// -------------------- BODY --------------------
async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (req.body && typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); }
    });
  });
}

// -------------------- HELPERS --------------------
function cleanPhone(phone) {
  if (!phone) return "";
  let p = String(phone).trim();
  const digits = p.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (p.startsWith("+")) return p;
  return digits ? `+${digits}` : "";
}

function pick(obj, keys, fallback = undefined) {
  for (const k of keys) {
    let v = obj?.[k];
    if (v && typeof v === "object" && "output" in v) v = v.output;
    if (v === undefined || v === null) continue;
    if (typeof v === "string") {
      const s = v.trim();
      if (!s || s.toLowerCase() === "null" || s.toLowerCase() === "undefined") continue;
      return s;
    }
    return v;
  }
  return fallback;
}

function asString(v, fallback = "") {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "object" && "output" in v) v = v.output;
  const s = String(v).trim();
  return s ? s : fallback;
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

// ---- TZ helpers ----
function ymdInTZ(date = new Date(), tz = "America/New_York") {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function ymInTZ(date = new Date(), tz = "America/New_York") {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).format(date);
  return s.substring(0, 7); 
}
function hourInTZ(date = new Date(), tz = "America/New_York") {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(date));
}

// ---- Limits Logic ----
const PLAN_LIMITS = {
  trial: { daily_minutes_cap: 30, monthly_minutes_cap: 200, reserve_minutes_per_call: 1 },
  basic: { daily_minutes_cap: 120, monthly_minutes_cap: 1000, reserve_minutes_per_call: 1 },
  pro: { daily_minutes_cap: 500, monthly_minutes_cap: 5000, reserve_minutes_per_call: 2 },
};

async function enforceHardCutoffs(agent_id) {
  const [planRaw, limitsRaw, tzRaw] = await Promise.all([
    kv.get(`plan:${agent_id}`),
    kv.get(`limits:${agent_id}`),
    kv.get(`tz:${agent_id}`),
  ]);

  const plan = planRaw || "trial";
  const limits = limitsRaw || PLAN_LIMITS[plan] || PLAN_LIMITS.trial;
  const tz = tzRaw || "America/New_York";
  const now = new Date();
  const day = ymdInTZ(now, tz);
  const month = ymInTZ(now, tz);

  const [dayCalls, dayMinutes, activeNow, dayReserved] = await Promise.all([
    kv.get(`metrics:${agent_id}:day:${day}:calls`),
    kv.get(`metrics:${agent_id}:day:${day}:minutes`),
    kv.get(`outbound:${agent_id}:active`),
    kv.get(`outbound:${agent_id}:day:${day}:reserved_minutes`),
  ]);

  const active = Number(activeNow || 0);
  const callsToday = Number(dayCalls || 0);
  const minutesToday = Number(dayMinutes || 0);
  const reservedToday = Number(dayReserved || 0);
  const reserveForThisCall = Number(limits.reserve_minutes_per_call || 1);

  // Checks
  if (limits.concurrent_limit && active >= limits.concurrent_limit) return { ok: false, reason: "concurrency_limit_reached" };
  if (limits.daily_call_limit && callsToday >= limits.daily_call_limit) return { ok: false, reason: "daily_call_limit_reached" };
  if (limits.daily_minutes_cap && (minutesToday + reservedToday + reserveForThisCall) > limits.daily_minutes_cap) return { ok: false, reason: "daily_minutes_cap_reached" };

  await kv.incrby(`outbound:${agent_id}:day:${day}:reserved_minutes`, reserveForThisCall);
  return { ok: true, usage_day: day, usage_month: month, reserveForThisCall, tz, plan };
}

// -------------------- MAIN --------------------
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const body = await readJsonBody(req);

  const agent_id = pick(body, ["agent_id", "agentId"]);
  const to_number = cleanPhone(pick(body, ["to_number", "to", "phone_number", "phone", "client_phone"]));
  const from_number = cleanPhone(pick(body, ["from_number", "from", "retell_phone"]));

  const client_name = pick(body, ["client_name", "clientName", "name"]);
  const reason_for_call = pick(body, ["reason_for_call", "reason", "call_reason"]);
  const notes = pick(body, ["notes", "note"]);
  const idempotency_key = req.headers["x-idempotency-key"] || pick(body, ["idempotency_key", "request_id"]);

  if (!agent_id || !to_number || !from_number) return json(res, 400, { ok: false, error: "Missing required fields" });

  const gate = await enforceHardCutoffs(agent_id);
  if (!gate.ok) return json(res, 429, { ok: false, reason: gate.reason });

  try {
    const RETELL_API_KEY = process.env.OUTBOUND_RETELL_API_KEY || process.env.RETELL_API_KEY;
    
    // ✅ Reverting to your EXACT working payload structure
    const payload = {
      from_number,
      to_number,
      override_agent_id: agent_id,
      retell_llm_dynamic_variables: {
        CALL_DIRECTION: "outbound",
        client_name: asString(client_name, "there"), // 'there' is a safer fallback than empty
        reason_for_call: asString(reason_for_call, ""),
        notes: asString(notes, ""),
        usage_day: gate.usage_day,
        usage_month: gate.usage_month,
        tz: gate.tz,
        reserved_minutes: gate.reserveForThisCall,
      },
      metadata: {
        idempotency_key: asString(idempotency_key, ""),
        usage_day: gate.usage_day,
        usage_month: gate.usage_month,
        tz: gate.tz,
        plan: gate.plan,
      },
    };

    const resp = await axios.post("https://api.retellai.com/v2/create-phone-call", payload, {
      headers: { Authorization: `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" },
      timeout: 30000,
    });

    await kv.incr(`outbound:${agent_id}:active`);
    return json(res, 200, { ok: true, status: "created", retell: resp.data });
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message });
  }
};
