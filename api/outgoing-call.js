// /api/outgoing-call.js
// ✅ FIXED: Restored original payload structure while maintaining new hard limits.
// ✅ FIXED: Retell dynamic variables are ALL strings
// ✅ FIXED: Force {{direction}} to outbound (no provisioning edits)
// ✅ FIXED: active counter has TTL to avoid stuck concurrency
// ✅ FIXED: refund reserved minutes if create-call fails

const axios = require("axios");
const { kv } = require("@vercel/kv");

// -------------------- CORS --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Idempotency-Key"
  );
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
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
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
      if (!s || s.toLowerCase() === "null" || s.toLowerCase() === "undefined")
        continue;
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
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
function ymInTZ(date = new Date(), tz = "America/New_York") {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
  }).format(date);
  return s.substring(0, 7);
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

  const plan = (typeof planRaw === "string" ? planRaw : "") || "trial";
  const limits = (limitsRaw && typeof limitsRaw === "object") ? limitsRaw : (PLAN_LIMITS[plan] || PLAN_LIMITS.trial);
  const tz = (typeof tzRaw === "string" ? tzRaw : "") || "America/New_York";

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

  if (limits.concurrent_limit != null && active >= Number(limits.concurrent_limit)) {
    return { ok: false, reason: "concurrency_limit_reached" };
  }
  if (limits.daily_call_limit != null && callsToday >= Number(limits.daily_call_limit)) {
    return { ok: false, reason: "daily_call_limit_reached" };
  }
  if (limits.daily_minutes_cap != null && (minutesToday + reservedToday + reserveForThisCall) > Number(limits.daily_minutes_cap)) {
    return { ok: false, reason: "daily_minutes_cap_reached" };
  }

  await kv.incrby(`outbound:${agent_id}:day:${day}:reserved_minutes`, reserveForThisCall).catch(() => {});

  return { ok: true, usage_day: day, usage_month: month, reserveForThisCall, tz, plan };
}

// -------------------- MAIN --------------------
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });

  const body = await readJsonBody(req);

  const agent_id = pick(body, ["agent_id", "agentId"]);
  const to_number = cleanPhone(pick(body, ["to_number", "to", "phone_number", "phone", "client_phone"]));
  const from_number = cleanPhone(pick(body, ["from_number", "from", "retell_phone", "outbound_from_number"]));

  const client_name = pick(body, ["client_name", "clientName", "name"]);
  const reason_for_call = pick(body, ["reason_for_call", "reason", "call_reason"]);
  const notes = pick(body, ["notes", "note"]);
  const idempotency_key = req.headers["x-idempotency-key"] || pick(body, ["idempotency_key", "request_id", "call_request_id", "submission_id"]);

  if (!agent_id || !to_number || !from_number) {
    return json(res, 400, { ok: false, error: "Missing required fields (agent_id, to_number, from_number)" });
  }

  const gate = await enforceHardCutoffs(agent_id);
  if (!gate.ok) return json(res, 429, { ok: false, reason: gate.reason });

  try {
    const RETELL_API_KEY = process.env.OUTBOUND_RETELL_API_KEY || process.env.RETELL_API_KEY;
    if (!RETELL_API_KEY) throw new Error("Missing RETELL API key env var");

    const payload = {
      from_number,
      to_number,
      override_agent_id: agent_id,
      retell_llm_dynamic_variables: {
        // ✅ this makes your prompt's {{direction}} resolve correctly
        direction: "outbound",
        // ✅ keep your existing backup too
        CALL_DIRECTION: "outbound",

        client_name: String(asString(client_name, "")),
        reason_for_call: String(asString(reason_for_call, "")),
        notes: String(asString(notes, "")),

        // ✅ ALL STRINGS for Retell
        usage_day: String(gate.usage_day || ""),
        usage_month: String(gate.usage_month || ""),
        tz: String(gate.tz || "America/New_York"),
        reserved_minutes: String(gate.reserveForThisCall || 0),
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

    // ✅ active counter with TTL so it can't get stuck forever
    const activeKey = `outbound:${agent_id}:active`;
    await kv.incr(activeKey);
    await kv.expire(activeKey, 60 * 20);

    return json(res, 200, { ok: true, status: "created", retell: resp.data });
  } catch (err) {
    // ✅ refund reserved minutes if create-call fails
    try {
      const tz = (await kv.get(`tz:${agent_id}`)) || "America/New_York";
      const day = ymdInTZ(new Date(), tz);
      const reserve = Number(gate.reserveForThisCall || 0);
      if (reserve) {
        await kv.incrby(`outbound:${agent_id}:day:${day}:reserved_minutes`, -reserve).catch(() => {});
      }
    } catch {}

    return json(res, 500, { ok: false, error: err?.response?.data || err?.message || "Unknown error" });
  }
};
