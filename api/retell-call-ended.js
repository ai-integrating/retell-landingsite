// /api/retell-call-ended.js
// Retell webhook: on call end -> decrement active + write usage metrics + release reserved minutes.

const { kv } = require("@vercel/kv");

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Retell-Signature");
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (req.body && typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
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

function isAuthorized(req) {
  const secret = process.env.RETELL_WEBHOOK_SECRET;
  if (!secret) return true; // dev
  return !!req.headers["x-retell-signature"];
}

function extractAgentId(body) {
  return body?.agent_id || body?.call?.agent_id || body?.data?.agent_id || body?.event?.agent_id;
}
function extractCallId(body) {
  return body?.call_id || body?.call?.call_id || body?.call?.id || body?.data?.call_id || body?.data?.id || body?.event?.call_id || body?.event?.id;
}

// Duration: try common fields
function extractDurationSeconds(body) {
  const call = body?.call || body?.data || body?.event || {};
  const durSec =
    call?.duration_seconds ??
    call?.duration ??
    call?.duration_sec ??
    null;

  const durMs =
    call?.duration_ms ??
    call?.durationMilliseconds ??
    null;

  if (Number.isFinite(Number(durSec))) return Number(durSec);
  if (Number.isFinite(Number(durMs))) return Math.round(Number(durMs) / 1000);
  return null;
}

function getMetadata(body) {
  const call = body?.call || body?.data || body?.event || {};
  return call?.metadata && typeof call.metadata === "object" ? call.metadata : {};
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.end("ok");
  if (req.method !== "POST") return okJson(res, 405, { ok: false, error: "Use POST" });

  if (!isAuthorized(req)) {
    return okJson(res, 401, {
      ok: false,
      error: "Unauthorized webhook",
      has_retell_signature: !!req.headers["x-retell-signature"],
    });
  }

  try {
    const body = await readJsonBody(req);
    const agent_id = extractAgentId(body);
    const call_id = extractCallId(body);
    const durationSeconds = extractDurationSeconds(body);
    const meta = getMetadata(body);

    console.log("CALL_ENDED incoming", {
      agent_id: agent_id || null,
      call_id: call_id || null,
      durationSeconds: durationSeconds || null,
      meta_keys: Object.keys(meta || {}),
      top_level_keys: Object.keys(body || {}),
    });

    if (!agent_id) return okJson(res, 200, { ok: true, ignored: true, reason: "no_agent_id" });

    // Idempotency: only process once per call_id
    if (call_id) {
      const seenKey = `retell:callended:${call_id}`;
      const alreadySeen = await kv.get(seenKey);
      if (alreadySeen) {
        console.log("retell-call-ended: DUPLICATE (no-op)", { agent_id, call_id, seenKey });
        return okJson(res, 200, { ok: true, duplicate: true, agent_id, call_id });
      }
      await kv.set(seenKey, "1", { ex: 60 * 60 * 24 * 7 });
    }

    // 1) Decrement active concurrent counter
    const activeKey = `outbound:${agent_id}:active`;
    let activeNow = await kv.decr(activeKey);
    if (activeNow < 0) {
      await kv.set(activeKey, 0, { ex: 60 * 10 });
      activeNow = 0;
    }

    // 2) Metrics: add minutes used (best effort)
    // If durationSeconds missing, we still release reserved minutes.
    const reserved = Number(meta?.reserved_minutes || 0);
    const day = meta?.usage_day ? String(meta.usage_day) : null;
    const month = meta?.usage_month ? String(meta.usage_month) : null;

    let billedMinutes = null;
    if (durationSeconds != null) {
      billedMinutes = Math.max(1, Math.ceil(durationSeconds / 60)); // bill at least 1 minute
      if (day) await kv.incrby(`metrics:${agent_id}:day:${day}:minutes`, billedMinutes);
      if (month) await kv.incrby(`metrics:${agent_id}:month:${month}:minutes`, billedMinutes);
    }

    // 3) Release reserved minutes (so "reserve" doesn’t grow forever)
    // We release exactly the reserved amount for this call.
    if (reserved && day) {
      await kv.incrby(`outbound:${agent_id}:day:${day}:reserved_minutes`, -reserved).catch(() => {});
    }
    if (reserved && month) {
      await kv.incrby(`outbound:${agent_id}:month:${month}:reserved_minutes`, -reserved).catch(() => {});
    }

    console.log("retell-call-ended: processed", {
      agent_id,
      call_id: call_id || null,
      active_now: activeNow,
      reserved_released: reserved || 0,
      billed_minutes: billedMinutes,
      day,
      month,
    });

    return okJson(res, 200, {
      ok: true,
      agent_id,
      call_id: call_id || null,
      active_now: activeNow,
      reserved_released: reserved || 0,
      billed_minutes: billedMinutes,
      usage_day: day,
      usage_month: month,
    });
  } catch (err) {
    console.error("retell-call-ended: ERROR", err);
    return okJson(res, 500, { ok: false, error: err?.message || "Server error" });
  }
};
