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
      pick(
        body,
        ["daily_minutes_cap", "Daily Minutes Cap"],
        kvLimits?.daily_minutes_cap ?? planCfg.daily_minutes
      ) ?? pick(bodyLC, ["daily_minutes_cap", "daily minutes cap"], kvLimits?.daily_minutes_cap ?? planCfg.daily_minutes),
      planCfg.daily_minutes
    );

    const monthly_minutes_cap = toInt(
      pick(
        body,
        ["monthly_minutes_cap", "Monthly Minutes Cap"],
        kvLimits?.monthly_minutes_cap ?? planCfg.monthly_minutes
      ) ?? pick(bodyLC, ["monthly_minutes_cap", "monthly minutes cap"], kvLimits?.monthly_minutes_cap ?? planCfg.monthly_minutes),
      planCfg.monthly_minutes
    );

    reservedMinutes = toInt(
      pick(
        body,
        ["reserve_minutes_per_call", "Reserve Minutes Per Call"],
        kvLimits?.reserve_minutes_per_call ?? planCfg.reserve_minutes_per_call
      ) ?? pick(bodyLC, ["reserve_minutes_per_call", "reserve minutes per call"], kvLimits?.reserve_minutes_per_call ?? planCfg.reserve_minutes_per_call),
      planCfg.reserve_minutes_per_call
    );

    const minutesGate = await checkMinutesOrBlock({
      agent_id,
      tz: lp.tz,
      daily_minutes_cap,
      monthly_minutes_cap,
      reserve_minutes: reservedMinutes,
    });

    if (!minutesGate.ok) {
      return okJson(res, 429, { ok: false, blocked: true, plan, ...minutesGate });
    }

    reservedKeys = {
      dayResKey: minutesGate.dayResKey,
      monthResKey: minutesGate.monthResKey,
      day: minutesGate.day,
      month: minutesGate.month,
    };

    const dayResNow = await kv.incrby(reservedKeys.dayResKey, reservedMinutes);
    if (dayResNow === reservedMinutes) await kv.expire(reservedKeys.dayResKey, 60 * 60 * 72);

    const monthResNow = await kv.incrby(reservedKeys.monthResKey, reservedMinutes);
    if (monthResNow === reservedMinutes) await kv.expire(reservedKeys.monthResKey, 60 * 60 * 24 * 60);

    // ---- Call count + concurrency ----
    const day = localDateKey(lp.tz);
    dailyKey = `outbound:${agent_id}:${day}:count`;
    activeKey = `outbound:${agent_id}:active`;

    const dailyCount = await kv.incr(dailyKey);
    if (dailyCount === 1) await kv.expire(dailyKey, 60 * 60 * 48);

    if (dailyCount > daily_call_limit) {
      await kv.decr(dailyKey);
      if (reservedKeys) {
        try {
          await kv.incrby(reservedKeys.dayResKey, -reservedMinutes);
          await kv.incrby(reservedKeys.monthResKey, -reservedMinutes);
        } catch {}
      }
      return okJson(res, 429, {
        ok: false,
        blocked: true,
        reason: "daily_limit_reached",
        calls_today: dailyCount,
        daily_call_limit,
        day,
        resets_at: nextResetLocalISO(lp.tz),
      });
    }

    const activeNow = await kv.incr(activeKey);
    if (activeNow === 1) await kv.expire(activeKey, 60 * 10);

    if (activeNow > concurrent_limit) {
      await kv.decr(activeKey);
      await kv.decr(dailyKey);
      if (reservedKeys) {
        try {
          await kv.incrby(reservedKeys.dayResKey, -reservedMinutes);
          await kv.incrby(reservedKeys.monthResKey, -reservedMinutes);
        } catch {}
      }
      return okJson(res, 429, {
        ok: false,
        blocked: true,
        reason: "concurrent_limit_reached",
        active_now: activeNow,
        concurrent_limit,
      });
    }

    countersIncremented = true;

    // -------------------- ✅ FORCE OUTBOUND VARIABLES (CASE-INSENSITIVE) --------------------
    // Pull from body, bodyLC, dynamicIn, dynamicLC
    // IMPORTANT: do NOT pass "Hi there" as client_name because your prompt treats that as inbound.
    const clientNameRaw =
      pick(body, ["client_name", "clientName", "name"], "") ||
      pick(bodyLC, ["client_name", "clientname", "name"], "") ||
      pick(dynamicIn, ["client_name", "clientName", "name"], "") ||
      pick(dynamicLC, ["client_name", "clientname", "name"], "");

    const client_name =
      String(clientNameRaw || "").trim().toLowerCase() === "hi there"
        ? ""
        : String(clientNameRaw || "").trim();

    const reason_for_call =
      pick(body, ["reason_for_call", "reasonForCall", "reason"], "") ||
      pick(bodyLC, ["reason_for_call", "reasonforcall", "reason"], "") ||
      pick(dynamicIn, ["reason_for_call", "reasonForCall", "reason"], "") ||
      pick(dynamicLC, ["reason_for_call", "reasonforcall", "reason"], "");

    const notes =
      pick(body, ["notes", "note"], "") ||
      pick(bodyLC, ["notes", "note"], "") ||
      pick(dynamicIn, ["notes", "note"], "") ||
      pick(dynamicLC, ["notes", "note"], "");

    const mergedDynamicVars = {
      ...(typeof dynamicIn === "object" && dynamicIn ? dynamicIn : {}),
      // Deterministic outbound detection for your prompt:
      call_direction: "outbound",
      is_outbound: "true",
      // Your prompt expects these exact keys:
      client_name: client_name || undefined,
      reason_for_call: String(reason_for_call || "").trim() || undefined,
      notes: String(notes || "").trim() || undefined,
    };

    // ---- Retell Outbound Call (V2) ----
    const payload = {
      from_number,
      to_number,
      metadata: {
        ...(typeof metadataIn === "object" && metadataIn ? metadataIn : {}),
        idempotency_key: idempotency_key || undefined,
        outbound: true,
        agent_id_for_tracking: agent_id,
        plan_for_tracking: plan,
        reserved_minutes: reservedMinutes,
        usage_day: reservedKeys?.day,
        usage_month: reservedKeys?.month,
        timezone: lp.tz,
      },
      // ✅ These are what your prompt can actually read as {{...}}
      retell_llm_dynamic_variables: mergedDynamicVars,
    };

    const headers = {
      Authorization: `Bearer ${process.env.OUTBOUND_RETELL_API_KEY}`,
      "Content-Type": "application/json",
    };
    if (idempotency_key) headers["Idempotency-Key"] = idempotency_key;

    const resp = await axios.post("https://api.retellai.com/v2/create-phone-call", payload, {
      headers,
      timeout: 60_000,
      validateStatus: () => true,
    });

    if (resp.status < 200 || resp.status >= 300) {
      if (countersIncremented) {
        try {
          await kv.decr(activeKey);
          await kv.decr(dailyKey);
        } catch {}
      }
      if (reservedKeys) {
        try {
          await kv.incrby(reservedKeys.dayResKey, -reservedMinutes);
          await kv.incrby(reservedKeys.monthResKey, -reservedMinutes);
        } catch {}
      }

      return okJson(res, 502, {
        ok: false,
        error: "Retell outbound call failed",
        status: resp.status,
        retell_reason: resp.data,
      });
    }

    const responsePayload = {
      ok: true,
      mode: "outbound_call",
      retell: resp.data,
      sent_dynamic_variables: mergedDynamicVars, // helpful debug (remove later if you want)
      limits: {
        calls_today: dailyCount,
        daily_call_limit,
        active_now: activeNow,
        concurrent_limit,
        day,
        resets_at: nextResetLocalISO(lp.tz),
        plan,
        daily_minutes_cap,
        monthly_minutes_cap,
        reserved_minutes_per_call: reservedMinutes,
      },
    };

    if (dedupeKey) await kv.set(dedupeKey, responsePayload, { ex: 60 * 60 * 6 });

    return okJson(res, 200, responsePayload);
  } catch (err) {
    if (countersIncremented && activeKey && dailyKey) {
      try {
        await kv.decr(activeKey);
        await kv.decr(dailyKey);
      } catch {}
    }
    if (reservedKeys) {
      try {
        await kv.incrby(reservedKeys.dayResKey, -reservedMinutes);
        await kv.incrby(reservedKeys.monthResKey, -reservedMinutes);
      } catch {}
    }
    return okJson(res, 500, { ok: false, error: err?.message || "Server error" });
  }
};
