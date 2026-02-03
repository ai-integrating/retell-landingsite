// /api/outgoing-call.js
// Place an outbound call via Retell Call (V2) endpoint.
// ✅ Does NOT create agents
// ✅ Does NOT buy numbers
// ✅ Enforces outbound entitlements + daily + concurrent limits via Vercel KV
// ✅ Tracks minutes (reserve before dialing; actuals written by retell-call-ended)
// ✅ DEDUPES Zap retries using idempotency_key so counters don’t double count

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

// ✅ Better pick(): ignores "", whitespace, null-ish strings, Zapier {output:"..."}
function pick(obj, keys, fallback = undefined) {
  for (const k of keys) {
    let v = obj?.[k];
    if (v && typeof v === "object" && "output" in v) v = v.output;
    if (v === undefined || v === null) continue;
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) continue;
      return s;
    }
    return v;
  }
  return fallback;
}

// ✅ Lowercase all keys at the top level (Zap-proof: Client_name -> client_name)
function lowerKeyObject(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[String(k).toLowerCase()] = v;
  }
  return out;
}

function toBool(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v || "").trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1" || s === "checked" || s === "y";
}

function toInt(v, fallback = 0) {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : fallback;
}

function okJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

// Local date/hour in timezone without extra libs
function localParts(timeZone) {
  const tz =
    timeZone && String(timeZone).trim()
      ? String(timeZone).trim()
      : "America/New_York";

  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });

  const parts = fmt.formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;

  return {
    tz,
    yyyy: get("year"),
    mm: get("month"),
    dd: get("day"),
    hh: toInt(get("hour"), 0),
  };
}

function localDateKey(timeZone) {
  const p = localParts(timeZone);
  return `${p.yyyy}-${p.mm}-${p.dd}`; // YYYY-MM-DD
}
function localMonthKey(timeZone) {
  const p = localParts(timeZone);
  return `${p.yyyy}-${p.mm}`; // YYYY-MM
}

function nextResetLocalISO(timeZone) {
  const p = localParts(timeZone);
  const yyyy = Number(p.yyyy);
  const mm = Number(p.mm);
  const dd = Number(p.dd);

  const dt = new Date(Date.UTC(yyyy, mm - 1, dd, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + 1);

  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}T00:00:00 (${String(timeZone)})`;
}

function nextMonthResetLocalISO(timeZone) {
  const p = localParts(timeZone);
  const yyyy = Number(p.yyyy);
  const mm = Number(p.mm);

  const dt = new Date(Date.UTC(yyyy, mm - 1, 15, 12, 0, 0));
  dt.setUTCMonth(dt.getUTCMonth() + 1);

  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01T00:00:00 (${String(timeZone)})`;
}

// -------------------- PLAN LIMITS --------------------
const PLAN_LIMITS = {
  trial: { daily_minutes: 30, monthly_minutes: 200, reserve_minutes_per_call: 5 },
  basic: { daily_minutes: 120, monthly_minutes: 1000, reserve_minutes_per_call: 5 },
  pro: { daily_minutes: 500, monthly_minutes: 5000, reserve_minutes_per_call: 10 },
};

async function getPlanForAgent(agent_id) {
  return (await kv.get(`plan:${agent_id}`)) || "trial";
}

async function getTimezoneForAgent(agent_id, fallbackTz) {
  return (await kv.get(`tz:${agent_id}`)) || fallbackTz || "America/New_York";
}

// Optional: store limits in KV so your Zap doesn't need to send them every time
async function getLimitsForAgent(agent_id) {
  const v = await kv.get(`limits:${agent_id}`);
  if (v && typeof v === "object") return v;
  return null;
}

// Reserve minutes pre-call so you can block spam before call-ended arrives
async function checkMinutesOrBlock({
  agent_id,
  tz,
  daily_minutes_cap,
  monthly_minutes_cap,
  reserve_minutes,
}) {
  const day = localDateKey(tz);
  const month = localMonthKey(tz);

  const dayUsedKey = `metrics:${agent_id}:day:${day}:minutes`;
  const monthUsedKey = `metrics:${agent_id}:month:${month}:minutes`;

  const dayResKey = `outbound:${agent_id}:day:${day}:reserved_minutes`;
  const monthResKey = `outbound:${agent_id}:month:${month}:reserved_minutes`;

  const [dayUsed, monthUsed, dayRes, monthRes] = await Promise.all([
    kv.get(dayUsedKey),
    kv.get(monthUsedKey),
    kv.get(dayResKey),
    kv.get(monthResKey),
  ]);

  const usedDay = Number(dayUsed || 0);
  const usedMonth = Number(monthUsed || 0);
  const reservedDay = Number(dayRes || 0);
  const reservedMonth = Number(monthRes || 0);

  if (usedDay + reservedDay + reserve_minutes > daily_minutes_cap) {
    return {
      ok: false,
      reason: "daily_minutes_limit",
      used_minutes_today: usedDay,
      reserved_minutes_today: reservedDay,
      daily_minutes_cap,
      day,
      resets_at: nextResetLocalISO(tz),
    };
  }

  if (usedMonth + reservedMonth + reserve_minutes > monthly_minutes_cap) {
    return {
      ok: false,
      reason: "monthly_minutes_limit",
      used_minutes_month: usedMonth,
      reserved_minutes_month: reservedMonth,
      monthly_minutes_cap,
      month,
      resets_at: nextMonthResetLocalISO(tz),
    };
  }

  return { ok: true, day, month, dayResKey, monthResKey };
}

// -------------------- MAIN --------------------
module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    return res.end("ok");
  }
  if (req.method !== "POST") {
    return okJson(res, 405, { ok: false, error: "Use POST" });
  }

  let activeKey = null;
  let dailyKey = null;
  let countersIncremented = false;

  // minutes reservation rollback
  let reservedKeys = null;
  let reservedMinutes = 0;

  try {
    const body = await readJsonBody(req);
    const bodyLC = lowerKeyObject(body);

    const agent_id =
      pick(body, ["agent_id", "agentId"]) ||
      pick(bodyLC, ["agent_id", "agentid"]);

    const to_phone_raw =
      pick(body, ["to_phone", "toPhone", "phone", "to"]) ||
      pick(bodyLC, ["to_phone", "tophone", "phone", "to"]);

    const from_number_raw =
      pick(body, [
        "from_number",
        "fromNumber",
        "from_phone",
        "fromPhone",
        "caller_id",
        "callerId",
        "from_phone_number_id",
        "fromPhoneNumberId",
      ]) ||
      pick(bodyLC, [
        "from_number",
        "fromnumber",
        "from_phone",
        "fromphone",
        "caller_id",
        "callerid",
        "from_phone_number_id",
        "fromphonenumberid",
      ]);

    // Incoming objects (Zap can send these)
    const metadataIn = pick(body, ["metadata"], {}) || pick(bodyLC, ["metadata"], {});
    const dynamicIn =
      pick(body, ["dynamic_variables", "dynamicVariables"], {}) ||
      pick(bodyLC, ["dynamic_variables", "dynamicvariables"], {});

    const dynamicLC = lowerKeyObject(dynamicIn);

    const idempotency_key =
      req.headers["x-idempotency-key"] ||
      pick(body, ["idempotency_key", "idempotencyKey"], "") ||
      pick(bodyLC, ["idempotency_key", "idempotencykey"], "");

    if (!process.env.OUTBOUND_RETELL_API_KEY) {
      return okJson(res, 500, { ok: false, error: "Missing OUTBOUND_RETELL_API_KEY" });
    }
    if (!agent_id) {
      return okJson(res, 400, { ok: false, error: "Missing agent_id" });
    }

    const to_number = cleanPhone(to_phone_raw);
    const from_number = cleanPhone(from_number_raw);

    if (!to_number) return okJson(res, 400, { ok: false, error: "Missing/invalid to_phone" });
    if (!from_number) {
      return okJson(res, 400, {
        ok: false,
        error: "Missing/invalid from_number. Map E.164 like +1617... into from_number.",
      });
    }

    // ---- Load defaults from KV (optional but recommended) ----
    const kvLimits = await getLimitsForAgent(agent_id); // may be null
    const timezoneFromBody =
      pick(body, ["timezone", "tz", "time_zone"], null) ||
      pick(bodyLC, ["timezone", "tz", "time_zone", "time zone"], null);

    const timezone = await getTimezoneForAgent(agent_id, timezoneFromBody || "America/New_York");

    // ---- Entitlements + limits: body overrides KV ----
    const premium_outbound_enabled = toBool(
      pick(
        body,
        ["premium_outbound_enabled", "Premium Outbound Enabled"],
        kvLimits?.premium_outbound_enabled ?? false
      ) ?? pick(bodyLC, ["premium_outbound_enabled", "premium outbound enabled"], kvLimits?.premium_outbound_enabled ?? false)
    );

    const daily_call_limit = toInt(
      pick(body, ["daily_call_limit", "Daily Call Limit"], kvLimits?.daily_call_limit ?? 0) ??
        pick(bodyLC, ["daily_call_limit", "daily call limit"], kvLimits?.daily_call_limit ?? 0),
      0
    );

    const concurrent_limit = toInt(
      pick(body, ["concurrent_limit", "Concurrent Limit"], kvLimits?.concurrent_limit ?? 0) ??
        pick(bodyLC, ["concurrent_limit", "concurrent limit"], kvLimits?.concurrent_limit ?? 0),
      0
    );

    const outbound_hours_start = toInt(
      pick(body, ["outbound_hours_start"], kvLimits?.outbound_hours_start ?? 9) ??
        pick(bodyLC, ["outbound_hours_start"], kvLimits?.outbound_hours_start ?? 9),
      9
    );

    const outbound_hours_end = toInt(
      pick(body, ["outbound_hours_end"], kvLimits?.outbound_hours_end ?? 18) ??
        pick(bodyLC, ["outbound_hours_end"], kvLimits?.outbound_hours_end ?? 18),
      18
    );

    if (!premium_outbound_enabled) {
      return okJson(res, 403, { ok: false, blocked: true, reason: "outbound_not_enabled" });
    }

    if (daily_call_limit <= 0 || concurrent_limit <= 0) {
      return okJson(res, 403, {
        ok: false,
        blocked: true,
        reason: "limits_not_configured",
        hint: "Send daily_call_limit and concurrent_limit in the Zap OR store limits in KV: limits:<agent_id>",
        received: { daily_call_limit, concurrent_limit, timezone },
      });
    }

    const lp = localParts(timezone);
    if (lp.hh < outbound_hours_start || lp.hh >= outbound_hours_end) {
      return okJson(res, 403, {
        ok: false,
        blocked: true,
        reason: "outside_outbound_hours",
        timezone: lp.tz,
        local_hour: lp.hh,
        allowed: { start: outbound_hours_start, end: outbound_hours_end },
      });
    }

    // ---- Dedupe Zap retries ----
    const dedupeKey =
      idempotency_key && String(idempotency_key).trim()
        ? `outbound:dedupe:${agent_id}:${String(idempotency_key).trim()}`
        : null;

    if (dedupeKey) {
      const prior = await kv.get(dedupeKey);
      if (prior && typeof prior === "object") {
        return okJson(res, 200, { ok: true, deduped: true, ...prior });
      }
    }

    // ---- Minutes caps (plan + optional override) ----
    const plan = await getPlanForAgent(agent_id);
    const planCfg = PLAN_LIMITS[plan] || PLAN_LIMITS.trial;

    const daily_minutes_cap = toInt(
      p
