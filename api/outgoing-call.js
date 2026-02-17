// /api/outgoing-call.js
// Place an outbound call via Retell Call (V2) endpoint.
// ✅ UPDATED: Hard cutoffs when limits are hit (minutes/calls/concurrency/hours)
// ✅ UPDATED: writes usage_day/usage_month into metadata (tz-aware)

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

// ignores "", whitespace, null-ish strings, Zapier {output:"..."}
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

// ✅ NEW: treat Zapier "No data" as empty
function normalizeZapierNoData(v) {
  const s = asString(v, "");
  if (!s) return "";
  if (s.toLowerCase() === "no data") return "";
  if (s.toLowerCase() === "n/a") return "";
  return s;
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

  return `${y}-${m}-${d}`; // YYYY-MM-DD
}

function ymInTZ(date = new Date(), tz = "America/New_York") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;

  return `${y}-${m}`; // YYYY-MM
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

// Normalize limits object from KV (if any)
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

  const tz =
    (typeof tzRaw === "string" ? tzRaw : "") ||
    process.env.DEFAULT_TZ ||
    "America/New_York";

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

  const dayCallsKey = `metrics:${agent_id}:day:${day}:calls`;
  const dayMinutesKey = `metrics:${agent_id}:day:${day}:minutes`;
  const monthMinutesKey = `metrics:${agent_id}:month:${month}:minutes`;

  const dayReservedKey = `outbound:${agent_id}:day:${day}:reserved_minutes`;
  const monthReservedKey = `outbound:${agent_id}:month:${month}:reserved_minutes`;

  const activeKey = `outbound:${agent_id}:active`;

  const [dayCalls, dayMinutes, monthMinutes, dayReserved, monthReserved, activeNow] =
    await Promise.all([
      kv.get(dayCallsKey),
      kv.get(dayMinutesKey),
      kv.get(monthMinutesKey),
      kv.get(dayReservedKey),
      kv.get(monthReservedKey),
      kv.get(activeKey),
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
    const start = limits.outbound_hours.start;
    const end = limits.outbound_hours.end;
    const allowed = h >= start && h < end;
    if (!allowed) {
      return {
        ok: false,
        reason: "outside_outbound_hours",
        limits,
        usage: { callsToday, minutesToday, minutesMonth, active },
        window: { start, end, tz: limits.tz, hour: h },
      };
    }
  }

  // Concurrency cutoff (optional)
  if (limits.concurrent_limit != null && active >= limits.concurrent_limit) {
    return {
      ok: false,
      reason: "concurrency_limit_reached",
      limits,
      usage: { callsToday, minutesToday, minutesMonth, active },
    };
  }

  // Call limit cutoff (optional)
  if (limits.daily_call_limit != null && callsToday >= limits.daily_call_limit) {
    return {
      ok: false,
      reason: "daily_call_limit_reached",
      limits,
      usage: { callsToday, minutesToday, minutesMonth, active },
    };
  }

  // Minutes cap cutoffs (hard)
  const reserveForThisCall = Number(limits.reserve_minutes_per_call || 1);

  if (limits.daily_minutes_cap != null) {
    const projectedDaily = minutesToday + reservedToday + reserveForThisCall;
    if (projectedDaily > limits.daily_minutes_cap) {
      return {
        ok: false,
        reason: "daily_minutes_cap_reached",
        limits,
        usage: { callsToday, minutesToday, minutesMonth, active, reservedToday },
        projectedDaily,
      };
    }
  }

  if (limits.monthly_minutes_cap != null) {
    const projectedMonthly = minutesMonth + reservedMonth + reserveForThisCall;
    if (projectedMonthly > limits.monthly_minutes_cap) {
      return {
        ok: false,
        reason: "monthly_minutes_cap_reached",
        limits,
        usage: { callsToday, minutesToday, minutesMonth, active, reservedMonth },
        projectedMonthly,
      };
    }
  }

  // Reserve minutes (race-safe)
  await Promise.all([
    kv.incrby(dayReservedKey, reserveForThisCall).catch(() => {}),
    kv.incrby(monthReservedKey, reserveForThisCall).catch(() => {}),
  ]);

  return {
    ok: true,
    limits,
    usage: { callsToday, minutesToday, minutesMonth, active },
    reserveForThisCall,
    usage_day: day,
    usage_month: month,
  };
}

// -------------------- MAIN --------------------
module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });

  const body = await readJsonBody(req);

  const agent_id = pick(body, ["agent_id", "agentId"]);
  const to_number_raw = pick(body, ["to_number", "to", "phone_number", "phone", "client_phone"]);
  const from_number_raw = pick(body, ["from_number", "from", "retell_phone", "outbound_from_number"]);

  // ✅ UPDATED: include Zapier "Answers ..." aliases you showed in the screenshot
  const client_name = pick(body, [
    "client_name",
    "clientName",
    "name",
    "Answers Client Name Name Of The Person Being Called",
    "Answers Client Name",
  ]);

  const reason_for_call = pick(body, [
    "reason_for_call",
    "reason",
    "call_reason",
    "Answers Reason For This Call",
    "Answers Reason",
  ]);

  const notes = pick(body, [
    "notes",
    "note",
    "Answers Notes Or Context For The Agent Anything Helpful The Agent Should Know Before Calling",
    "Answers Notes Or Context For The Agent",
    "Answers Notes",
  ]);

  const idempotency_key =
    req.headers["x-idempotency-key"] ||
    pick(body, ["idempotency_key", "request_id", "call_request_id", "submission_id", "retell_call_id"]);

  const to_number = cleanPhone(to_number_raw);
  const from_number = cleanPhone(from_number_raw);

  if (!agent_id) return json(res, 400, { ok: false, error: "Missing agent_id" });
  if (!to_number) return json(res, 400, { ok: false, error: "Missing to_number" });
  if (!from_number) return json(res, 400, { ok: false, error: "Missing from_number" });

  // --- idempotency: dedupe Zap retries ---
  if (idempotency_key) {
    const idemKey = `outbound:idem:${idempotency_key}`;
    const existing = await kv.get(idemKey);
    if (existing && existing.status !== "processing") return json(res, 200, existing);
    await kv.set(idemKey, { ok: true, status: "processing" }, { ex: 60 * 10 });
  }

  const gate = await enforceHardCutoffs(agent_id);
  if (!gate.ok) {
    const result = {
      ok: false,
      status: "blocked",
      reason: gate.reason,
      limits: gate.limits,
      usage: gate.usage,
      message: "Outbound call blocked: usage limits reached.",
    };
    if (idempotency_key) {
      await kv.set(`outbound:idem:${idempotency_key}`, result, { ex: 60 * 15 });
    }
    return json(res, 429, result);
  }

  try {
    const RETELL_API_KEY = process.env.OUTBOUND_RETELL_API_KEY || process.env.RETELL_API_KEY;
    if (!RETELL_API_KEY) throw new Error("Missing RETELL API key env var");

    const url = "https://api.retellai.com/v2/create-phone-call";

    // ✅ Retell requires key/value PAIRS OF STRINGS
    const dynVars = {
      // ✅ UPDATED: normalize "No data" => ""
      client_name: String(normalizeZapierNoData(client_name)),
      reason_for_call: String(normalizeZapierNoData(reason_for_call)),
      notes: String(normalizeZapierNoData(notes)),

      usage_day: String(gate.usage_day || ""),
      usage_month: String(gate.usage_month || ""),
      tz: String(gate.limits?.tz || "America/New_York"),
      reserved_minutes: String(gate.reserveForThisCall || 0),
      plan: String(gate.limits?.plan || ""),
    };

    const payload = {
      from_number,
      to_number,
      override_agent_id: agent_id,
      retell_llm_dynamic_variables: dynVars,
      metadata: {
        idempotency_key: asString(idempotency_key, ""),
        usage_day: gate.usage_day,
        usage_month: gate.usage_month,
        tz: gate.limits.tz,
        reserved_minutes: gate.reserveForThisCall,
        plan: gate.limits.plan,
      },
    };

    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${RETELL_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });

    // Mark active AFTER successful create
    const activeKey = `outbound:${agent_id}:active`;
    await kv.incr(activeKey);
    await kv.expire(activeKey, 60 * 20);

    const result = { ok: true, status: "created", retell: resp.data };

    if (idempotency_key) {
      await kv.set(`outbound:idem:${idempotency_key}`, result, { ex: 60 * 60 * 24 });
    }

    return json(res, 200, result);
  } catch (err) {
    const msg = err?.response?.data || err?.message || "Unknown error";

    // Release reserved minutes on failure
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

    if (idempotency_key) {
      await kv.set(
        `outbound:idem:${idempotency_key}`,
        { ok: false, status: "failed", error: msg },
        { ex: 60 * 15 }
      );
    }

    return json(res, 500, { ok: false, error: msg });
  }
};
