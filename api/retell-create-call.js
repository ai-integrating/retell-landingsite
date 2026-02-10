// /api/retell-call-ended.js
// Retell webhook: on call end -> decrement active + write usage metrics.
// UPDATED:
// - Supports durationSeconds camelCase (common Retell field)
// - If metadata missing, computes day/month using tz:<agent_id> or DEFAULT_TZ
// - Writes minutes + calls + totals so /api/usage works

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
  // Presence check only (not full verification)
  return !!req.headers["x-retell-signature"];
}

function extractAgentId(body) {
  return body?.agent_id || body?.call?.agent_id || body?.data?.agent_id || body?.event?.agent_id;
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

// ✅ SUPerset duration extraction (includes camelCase durationSeconds)
function extractDurationSeconds(body) {
  const call = body?.call || body?.data || body?.event || {};

  const candidates = [
    call?.durationSeconds,
    call?.duration_seconds,
    call?.duration,
    call?.duration_sec,
  ];

  for (const c of candidates) {
    if (Number.isFinite(Number(c))) return Number(c);
  }

  const msCandidates = [call?.duration_ms, call?.durationMilliseconds];
  for (const ms of msCandidates) {
    if (Number.isFinite(Number(ms))) return Math.round(Number(ms) / 1000);
  }

  return null;
}

function getMetadata(body) {
  const call = body?.call || body?.data || body?.event || {};
  return call?.metadata && typeof call.metadata === "object" ? call.metadata : {};
}

// ---- TZ helpers (no deps) ----
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
      durationSeconds: durationSeconds ?? null,
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

    // 1) Decrement active concurrent counter (best effort)
    const activeKey = `outbound:${agent_id}:active`;
    let activeNow = await kv.decr(activeKey);
    if (activeNow < 0) {
      await kv.set(activeKey, 0, { ex: 60 * 10 });
      activeNow = 0;
    }

    // 2) Determine usage day/month
    // Prefer metadata (if provided), otherwise compute from tz:<agent_id>
    const tz =
      (await kv.get(`tz:${agent_id}`)) ||
      (meta?.tz ? String(meta.tz) : null) ||
      process.env.DEFAULT_TZ ||
      "America/New_York";

    const day = meta?.usage_day ? String(meta.usage_day) : ymdInTZ(new Date(), tz);
    const month = meta?.usage_month ? String(meta.usage_month) : ymInTZ(new Date(), tz);

    // 3) Bill minutes + increment counts
    let billedMinutes = null;
    if (durationSeconds != null) {
      billedMinutes = Math.max(1, Math.ceil(durationSeconds / 60));

      await Promise.all([
        kv.incrby(`metrics:${agent_id}:day:${day}:minutes`, billedMinutes),
        kv.incrby(`metrics:${agent_id}:month:${month}:minutes`, billedMinutes),
        kv.incrby(`metrics:${agent_id}:minutes_total`, billedMinutes),

        kv.incr(`metrics:${agent_id}:day:${day}:calls`),
        kv.incr(`metrics:${agent_id}:month:${month}:calls`),
        kv.incr(`metrics:${agent_id}:calls_total`),

        kv.set(
          `metrics:${agent_id}:last_call`,
          JSON.stringify({
            call_id: call_id || null,
            durationSeconds,
            billedMinutes,
            day,
            month,
            tz,
            ts: new Date().toISOString(),
          }),
          { ex: 60 * 60 * 24 * 14 }
        ),
      ]);
    } else {
      console.warn("retell-call-ended: duration missing (minutes not billed)", {
        agent_id,
        call_id: call_id || null,
        tz,
        day,
        month,
      });
    }

    console.log("retell-call-ended: processed", {
      agent_id,
      call_id: call_id || null,
      active_now: activeNow,
      billed_minutes: billedMinutes,
      day,
      month,
      tz,
    });

    return okJson(res, 200, {
      ok: true,
      agent_id,
      call_id: call_id || null,
      active_now: activeNow,
      billed_minutes: billedMinutes,
      usage_day: day,
      usage_month: month,
      tz,
    });
  } catch (err) {
    console.error("retell-call-ended: ERROR", err);
    return okJson(res, 500, { ok: false, error: err?.message || "Server error" });
  }
};
