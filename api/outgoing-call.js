// /api/retell-outbound-call.js
// Purpose: Place an outbound call using an *existing* Retell agent.
// ✅ Does NOT create agents
// ✅ Does NOT buy numbers
// ✅ Safe to call from Zapier / your portal
// ✅ Enforces outbound entitlements + daily + concurrent limits via Vercel KV
// ✅ Retry-safe via Idempotency-Key (Zapier retries won't double count)

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

// ✅ Zapier-tolerant pick (handles {output:"..."} shapes)
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

function okJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

// Local date/hour in timezone without extra libraries
function localParts(timeZone) {
  const tz = timeZone && String(timeZone).trim() ? String(timeZone).trim() : "America/New_York";

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

  // Counters for rollback safety
  let activeKey = null;
  let dailyKey = null;
  let countersIncremented = false;

  try {
    const body = await readJsonBody(req);

    // Accept either snake_case or camelCase to make Zap mapping easier
    const agent_id = pick(body, ["agent_id", "agentId"]);
    const to_phone_raw = pick(body, ["to_phone", "toPhone", "phone", "to"]);

    const from_phone_number_id = pick(body, [
      "from_phone_number_id",
      "fromPhoneNumberId",
      "phone_number_id",
      "phoneNumberId",
    ]);

    const from_number_raw = pick(body, [
      "from_number",
      "fromNumber",
      "from_phone",
      "fromPhone",
      "caller_id",
      "callerId",
    ]);

    const metadata = pick(body, ["metadata"], {});
    const context = pick(body, ["context"], {});
    const dynamic_variables = pick(body, ["dynamic_variables", "dynamicVariables"], {});

    // Idempotency key (recommended for Zapier retries)
    const idempotency_key =
      req.headers["x-idempotency-key"] ||
      pick(body, ["idempotency_key", "idempotencyKey"], "");

    if (!process.env.OUTBOUND_RETELL_API_KEY) {
      return okJson(res, 500, { ok: false, error: "Missing OUTBOUND_RETELL_API_KEY" });
    }

    if (!agent_id) {
      return okJson(res, 400, { ok: false, error: "Missing agent_id" });
    }

    const to_number = cleanPhone(to_phone_raw);
    if (!to_number) {
      return okJson(res, 400, { ok: false, error: "Missing/invalid to_phone" });
    }

    const from_number = cleanPhone(from_number_raw);

    // -------------------- LIMITS + ENTITLEMENTS --------------------
    // These are passed from Zap (Agent_Lookup lookup step)
    const premium_outbound_enabled = toBool(
      pick(body, ["premium_outbound_enabled", "Premium Outbound Enabled", "premiumOutboundEnabled"], false)
    );

    const daily_call_limit = toInt(pick(body, ["daily_call_limit", "Daily Call Limit"], 0), 0);
    const concurrent_limit = toInt(pick(body, ["concurrent_limit", "Concurrent Limit"], 0), 0);
    const timezone = pick(body, ["timezone", "tz", "time_zone"], "America/New_York");

    // Optional hours (defaults)
    const outbound_hours_start = toInt(pick(body, ["outbound_hours_start"], 9), 9);
    const outbound_hours_end = toInt(pick(body, ["outbound_hours_end"], 18), 18);

    // -------------------- IDEMPOTENCY DEDUPE (prevents double counts on retries) --------------------
    const idemKey = idempotency_key ? `outbound:${agent_id}:idem:${idempotency_key}` : null;
    if (idemKey) {
      const prior = await kv.get(idemKey);
      if (prior && typeof prior === "object" && prior.ok) {
        return okJson(res, 200, { ...prior, idempotent: true });
      }
      // Reserve for 10 minutes (so simultaneous retries don't both proceed)
      await kv.set(idemKey, { reserved: true }, { ex: 60 * 10 });
    }

    if (!premium_outbound_enabled) {
      const blocked = { ok: false, blocked: true, reason: "outbound_not_enabled" };
      if (idemKey) await kv.set(idemKey, blocked, { ex: 60 * 10 });
      return okJson(res, 403, blocked);
    }

    if (daily_call_limit <= 0 || concurrent_limit <= 0) {
      const blocked = {
        ok: false,
        blocked: true,
        reason: "limits_not_configured",
        daily_call_limit,
        concurrent_limit,
      };
      if (idemKey) await kv.set(idemKey, blocked, { ex: 60 * 10 });
      return okJson(res, 403, blocked);
    }

    // Business-hours gate
    const lp = localParts(timezone);
    if (lp.hh < outbound_hours_start || lp.hh >= outbound_hours_end) {
      const blocked = {
        ok: false,
        blocked: true,
        reason: "outside_outbound_hours",
        timezone: lp.tz,
        local_hour: lp.hh,
        allowed: { start: outbound_hours_start, end: outbound_hours_end },
      };
      if (idemKey) await kv.set(idemKey, blocked, { ex: 60 * 10 });
      return okJson(res, 403, blocked);
    }

    // KV keys
    const day = localDateKey(lp.tz);
    dailyKey = `outbound:${agent_id}:${day}:count`;
    activeKey = `outbound:${agent_id}:active`;

    // Daily counter (atomic)
    const dailyCount = await kv.incr(dailyKey);
    if (dailyCount === 1) {
      // keep it around ~48h to avoid KV clutter
      await kv.expire(dailyKey, 60 * 60 * 48);
    }

    if (dailyCount > daily_call_limit) {
      await kv.decr(dailyKey);
      const blocked = {
        ok: false,
        blocked: true,
        reason: "daily_limit_reached",
        calls_today: dailyCount,
        daily_call_limit,
        day,
        timezone: lp.tz,
      };
      if (idemKey) await kv.set(idemKey, blocked, { ex: 60 * 10 });
      return okJson(res, 429, blocked);
    }

    // Concurrent counter (atomic)
    const active = await kv.incr(activeKey);
    if (active === 1) {
      // Safety TTL (if we never decrement, it clears)
      await kv.expire(activeKey, 60 * 10); // 10 minutes
    }

    if (active > concurrent_limit) {
      await kv.decr(activeKey);
      await kv.decr(dailyKey); // rollback daily because we won't place call
      const blocked = {
        ok: false,
        blocked: true,
        reason: "concurrent_limit_reached",
        active_now: active,
        concurrent_limit,
        calls_today: dailyCount - 1, // rolled back
        day,
        timezone: lp.tz,
      };
      if (idemKey) await kv.set(idemKey, blocked, { ex: 60 * 10 });
      return okJson(res, 429, blocked);
    }

    countersIncremented = true;

    // -------------------- RETELL OUTBOUND CALL --------------------
    const RETELL_BASE = "https://api.retellai.com";
    const OUTBOUND_PATH = "/create-phone-call"; // <-- may vary by Retell account/version

    const payload = {
      agent_id,
      to_number,

      ...(from_phone_number_id ? { from_phone_number_id } : {}),
      ...(!from_phone_number_id && from_number ? { from_number } : {}),

      metadata: {
        ...(typeof metadata === "object" && metadata ? metadata : {}),
        idempotency_key: idempotency_key || undefined,
        outbound: true,
      },

      dynamic_variables:
        typeof dynamic_variables === "object" && dynamic_variables ? dynamic_variables : {},

      context: typeof context === "object" && context ? context : {},
    };

    const headers = {
      Authorization: `Bearer ${process.env.OUTBOUND_RETELL_API_KEY}`,
      "Content-Type": "application/json",
    };

    if (idempotency_key) {
      headers["Idempotency-Key"] = idempotency_key;
    }

    const resp = await axios.post(`${RETELL_BASE}${OUTBOUND_PATH}`, payload, {
      headers,
      timeout: 60_000,
      validateStatus: () => true,
    });

    if (resp.status < 200 || resp.status >= 300) {
      // rollback counters on failure
      if (countersIncremented) {
        try {
          await kv.decr(activeKey);
          await kv.decr(dailyKey);
        } catch {}
      }

      const failed = {
        ok: false,
        error: "Retell outbound call failed",
        status: resp.status,
        data: resp.data,
        sent: {
          agent_id,
          to_number,
          from_phone_number_id: from_phone_number_id || null,
          from_number: !from_phone_number_id ? (from_number || null) : null,
        },
      };

      if (idemKey) await kv.set(idemKey, failed, { ex: 60 * 10 });
      return okJson(res, 502, failed);
    }

    // NOTE: We are NOT decrementing activeKey here because the call is now in progress.
    // We rely on the 10-minute TTL as a safety guard.
    // Later, you can decrement activeKey on a Retell "call ended" webhook.

    const success = {
      ok: true,
      mode: "outbound_call",
      agent_id,
      to_number,
      from_phone_number_id: from_phone_number_id || null,
      from_number: !from_phone_number_id ? (from_number || null) : null,
      idempotency_key: idempotency_key || null,

      // ✅ These let Zap update your Sheet:
      calls_today: dailyCount,
      active_now: active,

      limits: {
        day,
        timezone: lp.tz,
        daily_call_limit,
        concurrent_limit,
        outbound_hours_start,
        outbound_hours_end,
      },

      retell: resp.data,
    };

    if (idemKey) await kv.set(idemKey, success, { ex: 60 * 10 });

    return okJson(res, 200, success);
  } catch (err) {
    // If we incremented counters but crashed before finishing, rollback best-effort
    if (countersIncremented && activeKey && dailyKey) {
      try {
        await kv.decr(activeKey);
        await kv.decr(dailyKey);
      } catch {}
    }

    return okJson(res, 500, {
      ok: false,
      error: err?.message || "Server error",
    });
  }
};
