// /api/outgoing-call.js
// ✅ FIXED: correct route usage (no .js in URL), Retell dynamic vars are ALL strings,
// ✅ keeps override_agent_id payload, keeps hard cutoffs, better error surfacing

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
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
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
      if (!s) continue;
      if (s.toLowerCase() === "null") continue;
      if (s.toLowerCase() === "undefined") continue;
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
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}
function ymInTZ(date = new Date(), tz = "America/New_York") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  return `${y}-${m}`;
}
function hourInTZ(date = new Date(), tz = "America/New_York") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const h = parts.find((p) => p.type === "hour")?.value;
  return Number(h);
}

// ---- Plans (fallbacks) ----
const PLAN_LIMITS = {
  trial: { daily_minutes_cap: 30, monthly_minutes_cap: 200, reserve_minutes_per_call: 1 },
  basic: { daily_minutes_cap: 120, monthly_minutes_cap: 1000, reserve_minutes_per_call: 1 },
  pro: { daily_minutes_cap: 500, monthly_minutes_cap: 5000, reserve_minutes_per_call: 2 },
};

function toNumOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeLimits(obj) {
  if (!obj || typeof obj !== "object") return {};
  return {
    daily_minutes_cap: toNumOrNull(obj.daily_minutes_cap),
    monthly_minutes_cap: toNumOrNull(obj.monthly_minutes_cap),
    reserve_minutes_per_call: toNumOrNull(obj.reserve_minutes_per_call),
    daily_call_limit: toNumOrNull(obj.daily_call_limit),
    concurrent_limit: toNumOrNull(obj.concurrent_limit),
    outbound_hours:
      obj.outbound_hours && typeof obj.outbound_hours === "object"
        ? {
            start: toNumOrNull(obj.outbound_hours.start),
            end: toNumOrNull(obj.outbound_hours.end),
          }
        : null,
  };
}

async function computeEffectiveLimits(agent_id) {
  const [planRaw, limitsRaw, tzRaw] = await Promise.all([
    kv.get(`plan:${agent_id}`),
    kv.get(`limits:${agent_id}`),
    kv.get(`tz:${agent_id}`),
  ]);

  const plan = (typeof planRaw === "string" ? planRaw : "") || "trial";
  const planDefaults = PLAN_LIMITS[plan] || PLAN_LIMITS.trial;
  const overrides = normalizeLimits(limitsRaw);
  const tz = (typeof tzRaw === "string" ? tzRaw : "") || process.env.DEFAULT_TZ || "America/New_York";

  return {
    plan,
    tz,
    daily_minutes_cap: overrides.daily_minutes_cap ?? planDefaults.daily_minutes_cap,
    monthly_minutes_cap: overrides.monthly_minutes_cap ?? planDefaults.monthly_minutes_cap,
    reserve_minutes_per_call: overrides.reserve_minutes_per_call ?? planDefaults.reserve_minutes_per_call,
    daily_call_limit: overrides.daily_call_limit ?? null,
    concurrent_limit: overrides.concurrent_limit ?? null,
    outbound_hours: overrides.outbound_hours ?? null,
  };
}

async function enforceHardCutoffs(agent_id) {
  const limits = await computeEffectiveLimits(agent_id);
  const now = new Date();

  const day = ymdInTZ(now, limits.tz);
  const month = ymInTZ(now, limits.tz);

  const [
    dayCalls,
    dayMinutes,
    monthMinutes,
    dayReserved,
    monthReserved,
    activeNow,
  ] = await Promise.all([
    kv.get(`metrics:${agent_id}:day:${day}:calls`),
    kv.get(`metrics:${agent_id}:day:${day}:minutes`),
    kv.get(`metrics:${agent_id}:month:${month}:minutes`),
    kv.get(`outbound:${agent_id}:day:${day}:reserved_minutes`),
    kv.get(`outbound:${agent_id}:month:${month}:reserved_minutes`),
    kv.get(`outbound:${agent_id}:active`),
  ]);

  const callsToday = Number(dayCalls || 0);
  const minutesToday = Number(dayMinutes || 0);
  const minutesMonth = Number(monthMinutes || 0);
  const reservedToday = Number(dayReserved || 0);
  const reservedMonth = Number(monthReserved || 0);
  const active = Number(activeNow || 0);

  // Hours cutoff (optional)
  if (limits.outbound_hours?.start != null && limits.outbound_hours?.end != null) {
    const h = hourInTZ(now, limits.tz);
    const allowed = h >= limits.outbound_hours.start && h < limits.outbound_hours.end;
    if (!allowed) {
      return { ok: false, reason: "outside_outbound_hours", limits };
    }
  }

  // Concurrency (optional)
  if (limits.concurrent_limit != null && active >= limits.concurrent_limit) {
    return { ok: false, reason: "concurrency_limit_reached", limits };
  }

  // Call count (optional)
  if (limits.daily_call_limit != null && callsToday >= limits.daily_call_limit) {
    return { ok: false, reason: "daily_call_limit_reached", limits };
  }

  // Minutes caps (hard)
  const reserveForThisCall = Number(limits.reserve_minutes_per_call || 1);

  if (limits.daily_minutes_cap != null) {
    const projectedDaily = minutesToday + reservedToday + reserveForThisCall;
    if (projectedDaily > limits.daily_minutes_cap) {
      return { ok: false, reason: "daily_minutes_cap_reached", limits };
    }
  }

  if (limits.monthly_minutes_cap != null) {
    const projectedMonthly = minutesMonth + reservedMonth + reserveForThisCall;
    if (projectedMonthly > limits.monthly_minutes_cap) {
      return { ok: false, reason: "monthly_minutes_cap_reached", limits };
    }
  }

  // Reserve minutes for this call
  await Promise.all([
    kv.incrby(`outbound:${agent_id}:day:${day}:reserved_minutes`, reserveForThisCall).catch(() => {}),
    kv.incrby(`outbound:${agent_id}:month:${month}:reserved_minutes`, reserveForThisCall).catch(() => {}),
  ]);

  return { ok: true, limits, usage_day: day, usage_month: month, reserveForThisCall };
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

  const idempotency_key =
    req.headers["x-idempotency-key"] ||
    pick(body, ["idempotency_key", "request_id", "call_request_id", "submission_id"]);

  if (!agent_id) return json(res, 400, { ok: false, error: "Missing agent_id" });
  if (!to_number) return json(res, 400, { ok: false, error: "Missing to_number" });
  if (!from_number) return json(res, 400, { ok: false, error: "Missing from_number" });

  // idempotency
  if (idempotency_key) {
    const idemKey = `outbound:idem:${idempotency_key}`;
    const existing = await kv.get(idemKey);
    if (existing && existing.status !== "processing") return json(res, 200, existing);
    await kv.set(idemKey, { ok: true, status: "processing" }, { ex: 600 });
  }

  // limits
  const gate = await enforceHardCutoffs(agent_id);
  if (!gate.ok) {
    const blocked = { ok: false, status: "blocked", reason: gate.reason, limits: gate.limits };
    if (idempotency_key) await kv.set(`outbound:idem:${idempotency_key}`, blocked, { ex: 900 });
    return json(res, 429, blocked);
  }

  try {
    const RETELL_API_KEY = process.env.OUTBOUND_RETELL_API_KEY || process.env.RETELL_API_KEY;
    if (!RETELL_API_KEY) return json(res, 500, { ok: false, error: "Missing RETELL_API_KEY env var" });

    // ✅ Retell requires dynamic vars to be string:string
    const dynVars = {
      // do NOT rely on this for {{direction}} — Retell sets that itself for outbound calls
      CALL_DIRECTION: "outbound",
      client_name: String(asString(client_name, "")),
      reason_for_call: String(asString(reason_for_call, "")),
      notes: String(asString(notes, "")),
      usage_day: String(gate.usage_day || ""),
      usage_month: String(gate.usage_month || ""),
      tz: String(gate.limits?.tz || "America/New_York"),
      reserved_minutes: String(gate.reserveForThisCall || 0),
      plan: String(gate.limits?.plan || ""),
    };

    const payload = {
      from_number,
      to_number,
      // ✅ keep your known-good field
      override_agent_id: agent_id,
      // (harmless extra — helps if Retell ever prefers it)
      agent_id: agent_id,
      retell_llm_dynamic_variables: dynVars,
      metadata: {
        idempotency_key: asString(idempotency_key, ""),
        usage_day: gate.usage_day,
        usage_month: gate.usage_month,
        tz: gate.limits.tz,
        plan: gate.limits.plan,
      },
    };

    const resp = await axios.post("https://api.retellai.com/v2/create-phone-call", payload, {
      headers: { Authorization: `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" },
      timeout: 30000,
    });

    // concurrency marker
    const activeKey = `outbound:${agent_id}:active`;
    await kv.incr(activeKey);
    await kv.expire(activeKey, 60 * 20);

    const result = { ok: true, status: "created", retell: resp.data };
    if (idempotency_key) await kv.set(`outbound:idem:${idempotency_key}`, result, { ex: 86400 });

    return json(res, 200, result);
  } catch (err) {
    // release reserved minutes (since call-ended won’t fire on failure)
    try {
      const tz = (await kv.get(`tz:${agent_id}`)) || process.env.DEFAULT_TZ || "America/New_York";
      const day = ymdInTZ(new Date(), tz);
      const month = ymInTZ(new Date(), tz);
      const reserve = Number(gate.reserveForThisCall || 0);
      if (reserve) {
        await kv.incrby(`outbound:${agent_id}:day:${day}:reserved_minutes`, -reserve).catch(() => {});
        await kv.incrby(`outbound:${agent_id}:month:${month}:reserved_minutes`, -reserve).catch(() => {});
      }
    } catch {}

    const status = err?.response?.status || 500;
    const details = err?.response?.data || null;

    const result = {
      ok: false,
      status: "failed",
      error: err?.message || "Unknown error",
      retell_error: details,
    };

    if (idempotency_key) await kv.set(`outbound:idem:${idempotency_key}`, result, { ex: 900 });

    return json(res, status, result);
  }
};
