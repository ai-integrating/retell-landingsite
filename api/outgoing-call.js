// /api/retell-outbound-call.js
const axios = require("axios");
const { kv } = require("@vercel/kv");

// -------------------- CORS --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Idempotency-Key");
}

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

function okJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

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

function toBool(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v || "").trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1" || s === "checked";
}

function toInt(v, fallback = 0) {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : fallback;
}

function cleanPhone(phone) {
  if (!phone) return "";
  let p = String(phone).trim();
  const digits = p.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (p.startsWith("+")) return p;
  return digits ? `+${digits}` : "";
}

// Local date/hour in timezone
function localParts(timeZone) {
  const tz = timeZone && String(timeZone).trim() ? String(timeZone).trim() : "America/New_York";
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;

  return { tz, yyyy: get("year"), mm: get("month"), dd: get("day"), hh: toInt(get("hour"), 0) };
}

function localDateKey(tz) {
  const p = localParts(tz);
  return `${p.yyyy}-${p.mm}-${p.dd}`;
}
function localMonthKey(tz) {
  const p = localParts(tz);
  return `${p.yyyy}-${p.mm}`;
}

// -------------------- SIMPLE PLAN LIMITS --------------------
const PLAN_LIMITS = {
  trial: { daily_minutes: 30, monthly_minutes: 200, reserve_minutes_per_call: 5 },
  basic: { daily_minutes: 120, monthly_minutes: 1000, reserve_minutes_per_call: 5 },
  pro: { daily_minutes: 500, monthly_minutes: 5000, reserve_minutes_per_call: 10 },
};

async function getPlanForAgent(agent_id) {
  return (await kv.get(`plan:${agent_id}`)) || "trial";
}

// -------------------- MAIN --------------------
module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.end("ok");
  if (req.method !== "POST") return okJson(res, 405, { ok: false, error: "Use POST" });

  let activeKey = null;
  let dailyKey = null;
  let countersIncremented = false;

  let reservedKeys = null;
  let reservedMinutes = 0;

  try {
    const body = await readJsonBody(req);

    const agent_id = pick(body, ["agent_id", "agentId"]);
    if (!agent_id) return okJson(res, 400, { ok: false, error: "Missing agent_id" });

    // ✅ Pull client_id from KV so we can enforce "agent belongs to client"
    const client_id = await kv.get(`agent:${agent_id}:client`);
    if (!client_id) {
      return okJson(res, 403, {
        ok: false,
        blocked: true,
        reason: "agent_not_registered_in_kv",
        fix: "Run kv-set-agent-client after agent is created (and client_id is known).",
      });
    }

    const to_number = cleanPhone(pick(body, ["to_phone", "toPhone", "phone", "to"]));
    const from_number = cleanPhone(
      pick(body, ["from_number", "fromNumber", "from_phone", "fromPhone", "caller_id", "callerId"])
    );

    if (!to_number) return okJson(res, 400, { ok: false, error: "Missing/invalid to_phone" });
    if (!from_number) {
      return okJson(res, 400, { ok: false, error: "Missing/invalid from_number (E.164 like +1617...)" });
    }

    if (!process.env.OUTBOUND_RETELL_API_KEY) {
      return okJson(res, 500, { ok: false, error: "Missing OUTBOUND_RETELL_API_KEY" });
    }

    const premium_outbound_enabled = toBool(pick(body, ["premium_outbound_enabled"], false));
    const daily_call_limit = toInt(pick(body, ["daily_call_limit"], 0), 0);
    const concurrent_limit = toInt(pick(body, ["concurrent_limit"], 0), 0);
    const timezone = pick(body, ["timezone", "tz", "time_zone"], "America/New_York");
    const outbound_hours_start = toInt(pick(body, ["outbound_hours_start"], 9), 9);
    const outbound_hours_end = toInt(pick(body, ["outbound_hours_end"], 18), 18);

    if (!premium_outbound_enabled) {
      return okJson(res, 403, { ok: false, blocked: true, reason: "outbound_not_enabled" });
    }
    if (daily_call_limit <= 0 || concurrent_limit <= 0) {
      return okJson(res, 403, { ok: false, blocked: true, reason: "limits_not_configured" });
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

    // -------------------- DEDUPE --------------------
    const idempotency_key =
      req.headers["x-idempotency-key"] || pick(body, ["idempotency_key", "idempotencyKey"], "");

    const dedupeKey =
      idempotency_key && String(idempotency_key).trim()
        ? `outbound:dedupe:${agent_id}:${String(idempotency_key).trim()}`
        : null;

    if (dedupeKey) {
      const prior = await kv.get(dedupeKey);
      if (prior && typeof prior === "object") return okJson(res, 200, { ok: true, deduped: true, ...prior });
    }

    // -------------------- PLAN MINUTES (reserve now) --------------------
    const plan = await getPlanForAgent(agent_id);
    const cfg = PLAN_LIMITS[plan] || PLAN_LIMITS.trial;

    const daily_minutes_cap = toInt(pick(body, ["daily_minutes_cap"], cfg.daily_minutes), cfg.daily_minutes);
    const monthly_minutes_cap = toInt(pick(body, ["monthly_minutes_cap"], cfg.monthly_minutes), cfg.monthly_minutes);
    reservedMinutes = toInt(pick(body, ["reserve_minutes_per_call"], cfg.reserve_minutes_per_call), cfg.reserve_minutes_per_call);

    const day = localDateKey(lp.tz);
    const month = localMonthKey(lp.tz);

    const dayUsedKey = `metrics:${agent_id}:day:${day}:minutes`;
    const monthUsedKey = `metrics:${agent_id}:month:${month}:minutes`;
    const dayResKey = `outbound:${agent_id}:day:${day}:reserved_minutes`;
    const monthResKey = `outbound:${agent_id}:month:${month}:reserved_minutes`;

    const [usedDayRaw, usedMonthRaw, resDayRaw, resMonthRaw] = await Promise.all([
      kv.get(dayUsedKey), kv.get(monthUsedKey), kv.get(dayResKey), kv.get(monthResKey),
    ]);

    const usedDay = Number(usedDayRaw || 0);
    const usedMonth = Number(usedMonthRaw || 0);
    const reservedDay = Number(resDayRaw || 0);
    const reservedMonth = Number(resMonthRaw || 0);

    if (usedDay + reservedDay + reservedMinutes > daily_minutes_cap) {
      return okJson(res, 429, { ok: false, blocked: true, reason: "daily_minutes_limit", plan, usedDay, reservedDay, daily_minutes_cap });
    }
    if (usedMonth + reservedMonth + reservedMinutes > monthly_minutes_cap) {
      return okJson(res, 429, { ok: false, blocked: true, reason: "monthly_minutes_limit", plan, usedMonth, reservedMonth, monthly_minutes_cap });
    }

    // reserve minutes now
    reservedKeys = { dayResKey, monthResKey, day, month };
    await kv.incrby(dayResKey, reservedMinutes);
    await kv.incrby(monthResKey, reservedMinutes);
    await kv.expire(dayResKey, 60 * 60 * 72);
    await kv.expire(monthResKey, 60 * 60 * 24 * 60);

    // -------------------- CALL + CONCURRENCY COUNTERS --------------------
    dailyKey = `outbound:${agent_id}:${day}:count`;
    activeKey = `outbound:${agent_id}:active`;

    const dailyCount = await kv.incr(dailyKey);
    if (dailyCount === 1) await kv.expire(dailyKey, 60 * 60 * 48);

    if (dailyCount > daily_call_limit) {
      await kv.decr(dailyKey);
      await kv.incrby(dayResKey, -reservedMinutes);
      await kv.incrby(monthResKey, -reservedMinutes);
      return okJson(res, 429, { ok: false, blocked: true, reason: "daily_limit_reached", calls_today: dailyCount, daily_call_limit });
    }

    const activeNow = await kv.incr(activeKey);
    if (activeNow === 1) await kv.expire(activeKey, 60 * 10);

    if (activeNow > concurrent_limit) {
      await kv.decr(activeKey);
      await kv.decr(dailyKey);
      await kv.incrby(dayResKey, -reservedMinutes);
      await kv.incrby(monthResKey, -reservedMinutes);
      return okJson(res, 429, { ok: false, blocked: true, reason: "concurrent_limit_reached", active_now: activeNow, concurrent_limit });
    }

    countersIncremented = true;

    // -------------------- RETELL CALL --------------------
    const metadata = pick(body, ["metadata"], {});
    const dynamic_variables = pick(body, ["dynamic_variables", "dynamicVariables"], {});

    const payload = {
      from_number,
      to_number,
      metadata: {
        ...(typeof metadata === "object" && metadata ? metadata : {}),
        outbound: true,
        agent_id_for_tracking: agent_id,
        client_id_for_tracking: client_id,
        plan_for_tracking: plan,
        reserved_minutes: reservedMinutes,
        usage_day: day,
        usage_month: month,
        idempotency_key: idempotency_key || undefined,
      },
      retell_llm_dynamic_variables: typeof dynamic_variables === "object" && dynamic_variables ? dynamic_variables : {},
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
      console.error("RETELL OUTBOUND ERROR:", resp.status, JSON.stringify(resp.data, null, 2));

      if (countersIncremented) {
        await kv.decr(activeKey).catch(() => {});
        await kv.decr(dailyKey).catch(() => {});
      }
      await kv.incrby(dayResKey, -reservedMinutes).catch(() => {});
      await kv.incrby(monthResKey, -reservedMinutes).catch(() => {});

      // NOTE: Retell may return 409 if Idempotency-Key reused with different payload
      return okJson(res, resp.status === 409 ? 409 : 502, {
        ok: false,
        error: "Retell outbound call failed",
        status: resp.status,
        retell_reason: resp.data,
        hint:
          resp.status === 409
            ? "Idempotency-Key conflict. Make idempotency_key unique per call attempt, or remove it while testing."
            : undefined,
      });
    }

    const out = {
      ok: true,
      mode: "outbound_call",
      retell: resp.data,
      tracking: { agent_id, client_id, plan, reserved_minutes: reservedMinutes, day, month },
    };

    if (dedupeKey) await kv.set(dedupeKey, out, { ex: 60 * 60 * 6 });

    return okJson(res, 200, out);
  } catch (err) {
    console.error("OUTBOUND SERVER ERROR:", err);

    // rollback counters + reservations if we got far enough
    if (countersIncremented && activeKey && dailyKey) {
      await kv.decr(activeKey).catch(() => {});
      await kv.decr(dailyKey).catch(() => {});
    }
    if (reservedKeys) {
      await kv.incrby(reservedKeys.dayResKey, -reservedMinutes).catch(() => {});
      await kv.incrby(reservedKeys.monthResKey, -reservedMinutes).catch(() => {});
    }

    return okJson(res, 500, { ok: false, error: err?.message || "Server error" });
  }
};
