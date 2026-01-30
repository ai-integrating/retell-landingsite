// /api/retell-call-ended.js
// Purpose: Retell webhook handler for CALL_ENDED
// ✅ Dedupes by call_id
// ✅ Decrements outbound concurrency (client-scoped)
// ✅ Tracks usage minutes (client-scoped)
// ✅ Releases reserved minutes (client-scoped)
// ✅ Uses metadata.client_id_for_billing when available (best), fallback KV agent->client

const { kv } = require("@vercel/kv");

// -------------------- CORS --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Retell-Signature"
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
    req.on("data", (c) => (data += c));
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

function okJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

/**
 * Auth strategy for your Retell UI limitation:
 * - Retell UI doesn't allow custom secret headers
 * - So we require the Retell webhook header to be present: x-retell-signature
 *
 * Optional dev escape hatch:
 * - If RETELL_WEBHOOK_SECRET is NOT set, allow (dev mode)
 * - If it IS set, we still can't compare headers (because Retell UI can't send them),
 *   so we rely on presence of x-retell-signature.
 */
function isAuthorized(req) {
  const secret = process.env.RETELL_WEBHOOK_SECRET;
  if (!secret) return true; // dev mode
  return !!req.headers["x-retell-signature"];
}

// -------------------- EXTRACTORS --------------------
function extractAgentId(body) {
  return (
    body?.agent_id ||
    body?.call?.agent_id ||
    body?.data?.agent_id ||
    body?.event?.agent_id
  );
}

function extractCallId(body) {
  return (
    body?.call_id ||
    body?.call?.call_id ||
    body?.call?.id ||
    body?.data?.call_id ||
    body?.data?.id ||
    body?.event?.call_id ||
    body?.event?.id
  );
}

function extractMetadata(body) {
  // Retell typically puts metadata under call.metadata for V2 create-phone-call
  return (
    body?.metadata ||
    body?.call?.metadata ||
    body?.data?.metadata ||
    body?.event?.metadata ||
    {}
  );
}

function toBool(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v || "").trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1" || s === "checked";
}

function toInt(v, fallback = 0) {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

// -------------------- TIME HELPERS --------------------
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

  return { tz, yyyy: get("year"), mm: get("month"), dd: get("day") };
}

function localDateKey(timeZone) {
  const p = localParts(timeZone);
  return `${p.yyyy}-${p.mm}-${p.dd}`;
}

function localMonthKey(timeZone) {
  const p = localParts(timeZone);
  return `${p.yyyy}-${p.mm}`;
}

// -------------------- DURATION / BILLING --------------------
// We bill in WHOLE minutes (rounded up) because KV incrby is integer.
function extractDurationSeconds(body) {
  const c = body?.call || body?.data?.call || body?.data || body?.event || {};

  const candidates = [
    c?.duration_seconds,
    c?.call_duration_seconds,
    c?.duration,
    c?.call_duration,
    c?.duration_ms ? Number(c.duration_ms) / 1000 : null,
    c?.call_duration_ms ? Number(c.call_duration_ms) / 1000 : null,
    body?.duration_seconds,
    body?.duration_ms ? Number(body.duration_ms) / 1000 : null,
  ].filter((x) => x !== null && x !== undefined);

  if (!candidates.length) return null;

  const n = Number(candidates[0]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function billMinutesFromSeconds(seconds) {
  if (seconds === null || seconds === undefined) return 0;
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return 0;
  // Round UP to the next minute so you can't "game" the system with 10-second calls
  return Math.max(1, Math.ceil(s / 60));
}

// -------------------- KV LOOKUPS --------------------
async function getClientIdForAgent(agent_id) {
  return (
    (await kv.get(`agent:${agent_id}:client_id`)) ||
    (await kv.get(`agent:${agent_id}:client`)) ||
    null
  );
}

// -------------------- SAFE DECR / CLAMP --------------------
async function decrClampToZero(key, ttlSecondsIfReset = 600) {
  let v = await kv.decr(key);
  if (v < 0) {
    await kv.set(key, 0, { ex: ttlSecondsIfReset });
    v = 0;
  }
  return v;
}

async function incrbyClampToZero(key, delta, ttlSecondsIfNew = null) {
  // KV allows negative incrby
  let v = await kv.incrby(key, delta);
  if (v < 0) {
    await kv.set(key, 0, ttlSecondsIfNew ? { ex: ttlSecondsIfNew } : undefined);
    v = 0;
  }
  return v;
}

// -------------------- DEBUG LOG --------------------
function logRawCandidates(body) {
  const md = extractMetadata(body);
  const call = body?.call || {};
  console.log("CALL_ENDED raw candidates", {
    top_level_keys: Object.keys(body || {}),
    call_keys: Object.keys(call || {}),
    has_retell_signature: !!body, // placeholder; we log header separately
    agent_id_top: body?.agent_id || null,
    agent_id_call: body?.call?.agent_id || null,
    call_id_top: body?.call_id || null,
    call_id_call: body?.call?.call_id || body?.call?.id || null,
    outbound_flag: md?.outbound ?? null,
    client_id_for_billing: md?.client_id_for_billing ?? null,
    reserved_minutes: md?.reserved_minutes ?? null,
    timezone_meta: md?.timezone ?? null,
    duration_seconds_guess: extractDurationSeconds(body),
  });
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    return res.end("ok");
  }

  if (req.method !== "POST") {
    return okJson(res, 405, { ok: false, error: "Use POST" });
  }

  if (!isAuthorized(req)) {
    return okJson(res, 401, {
      ok: false,
      error: "Unauthorized webhook",
      expected_env_secret_set: !!process.env.RETELL_WEBHOOK_SECRET,
      has_retell_signature: !!req.headers["x-retell-signature"],
      received_headers: Object.keys(req.headers || {}),
    });
  }

  try {
    const body = await readJsonBody(req);

    const agent_id = extractAgentId(body);
    const call_id = extractCallId(body);
    const metadata = extractMetadata(body);

    logRawCandidates(body);

    console.log("CALL_ENDED incoming", {
      has_retell_signature: !!req.headers["x-retell-signature"],
      agent_id: agent_id || null,
      call_id: call_id || null,
    });

    if (!agent_id) {
      return okJson(res, 200, { ok: true, ignored: true, reason: "no_agent_id" });
    }

    // ✅ Dedupe
    if (call_id) {
      const seenKey = `retell:callended:${call_id}`;
      const alreadySeen = await kv.get(seenKey);

      if (alreadySeen) {
        console.log("retell-call-ended: DUPLICATE webhook (no-op)", {
          agent_id,
          call_id,
          seenKey,
        });

        return okJson(res, 200, {
          ok: true,
          duplicate: true,
          agent_id,
          call_id,
          reason: "call_id_already_processed",
        });
      }

      await kv.set(seenKey, "1", { ex: 60 * 60 * 24 * 7 });
    } else {
      console.warn("retell-call-ended: no call_id found; cannot dedupe.");
    }

    // ✅ Only apply billing + concurrency if this was an outbound call we initiated
    const isOutbound = toBool(metadata?.outbound);

    if (!isOutbound) {
      return okJson(res, 200, {
        ok: true,
        ignored: true,
        reason: "not_outbound_call",
        agent_id,
        call_id: call_id || null,
      });
    }

    // ✅ Find client_id (best: from metadata)
    let client_id = metadata?.client_id_for_billing || null;

    // Fallback: KV mapping agent -> client
    if (!client_id) {
      client_id = await getClientIdForAgent(agent_id);
    }

    if (!client_id) {
      // We can still decrement old agent-scoped key as a safety fallback,
      // but we *won't* record billing minutes without a client_id.
      const fallbackActiveKey = `outbound:${agent_id}:active`;
      const fallbackActiveNow = await decrClampToZero(fallbackActiveKey);

      return okJson(res, 200, {
        ok: true,
        warning: "missing_client_id_for_billing",
        agent_id,
        call_id: call_id || null,
        fallback_active_key: fallbackActiveKey,
        fallback_active_now: fallbackActiveNow,
      });
    }

    // ✅ timezone (prefer metadata if you ever pass it; else default)
    const timezone = metadata?.timezone || "America/New_York";
    const day = localDateKey(timezone);
    const month = localMonthKey(timezone);

    // ✅ Minutes actuals (rounded up)
    const durationSeconds = extractDurationSeconds(body);
    const billedMinutes = billMinutesFromSeconds(durationSeconds);

    // ✅ Reserved minutes (we stored this in outbound metadata)
    const reservedMinutes = toInt(metadata?.reserved_minutes, 0);

    // -------------------- CONCURRENCY DECREMENT (client-scoped) --------------------
    const activeKey = `outbound:${client_id}:active`;
    const activeNow = await decrClampToZero(activeKey);

    // -------------------- USAGE METRICS (client-scoped) --------------------
    // Add actual minutes (if we can compute)
    const dayUsedKey = `metrics:${client_id}:day:${day}:minutes`;
    const monthUsedKey = `metrics:${client_id}:month:${month}:minutes`;

    let dayUsedNow = null;
    let monthUsedNow = null;

    if (billedMinutes > 0) {
      dayUsedNow = await kv.incrby(dayUsedKey, billedMinutes);
      // keep a little buffer
      if (dayUsedNow === billedMinutes) await kv.expire(dayUsedKey, 60 * 60 * 72);

      monthUsedNow = await kv.incrby(monthUsedKey, billedMinutes);
      if (monthUsedNow === billedMinutes) await kv.expire(monthUsedKey, 60 * 60 * 24 * 60);
    } else {
      console.warn("retell-call-ended: could not compute billed minutes", {
        agent_id,
        client_id,
        call_id: call_id || null,
        durationSeconds,
      });
    }

    // -------------------- RELEASE RESERVED MINUTES (client-scoped) --------------------
    const dayResKey = `outbound:${client_id}:day:${day}:reserved_minutes`;
    const monthResKey = `outbound:${client_id}:month:${month}:reserved_minutes`;

    let dayReservedNow = null;
    let monthReservedNow = null;

    if (reservedMinutes > 0) {
      dayReservedNow = await incrbyClampToZero(dayResKey, -reservedMinutes, 60 * 60 * 72);
      monthReservedNow = await incrbyClampToZero(
        monthResKey,
        -reservedMinutes,
        60 * 60 * 24 * 60
      );
    }

    console.log("retell-call-ended: processed", {
      agent_id,
      client_id,
      call_id: call_id || null,
      activeKey,
      activeNow,
      billedMinutes,
      reservedMinutesReleased: reservedMinutes,
      day,
      month,
    });

    return okJson(res, 200, {
      ok: true,
      agent_id,
      client_id,
      call_id: call_id || null,
      active_now: activeNow,
      billed_minutes: billedMinutes,
      duration_seconds: durationSeconds,
      day,
      month,
      metrics: {
        dayUsedKey,
        monthUsedKey,
        day_used_now: dayUsedNow,
        month_used_now: monthUsedNow,
        dayResKey,
        monthResKey,
        day_reserved_now: dayReservedNow,
        month_reserved_now: monthReservedNow,
      },
    });
  } catch (err) {
    console.error("retell-call-ended: ERROR", err);
    return okJson(res, 500, { ok: false, error: err?.message || "Server error" });
  }
};
