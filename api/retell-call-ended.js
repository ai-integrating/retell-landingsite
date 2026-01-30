// /api/retell-call-ended.js
// Purpose: Retell webhook handler to decrement concurrent outbound counter when a call ends.

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
 *
 * If you later move to signature verification (recommended), this function is where it goes.
 */
function isAuthorized(req) {
  const secret = process.env.RETELL_WEBHOOK_SECRET;

  // Dev mode: if you haven't set the env var, don't block
  if (!secret) return true;

  // Retell webhooks include this header (as your logs show)
  return !!req.headers["x-retell-signature"];
}

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

// Extra visibility: helps us find the *real* unique ID field Retell sends
function logRawIdCandidates(body) {
  console.log("CALL_ENDED raw ids", {
    event_type: body?.event_type || body?.type || body?.event?.type || body?.event,
    call_id_top: body?.call_id || null,
    call_id_call: body?.call?.call_id || body?.call?.id || null,
    call_id_data: body?.data?.call_id || body?.data?.id || null,
    call_id_event: body?.event?.call_id || body?.event?.id || null,
    agent_id_top: body?.agent_id || null,
    agent_id_call: body?.call?.agent_id || null,
    agent_id_data: body?.data?.agent_id || null,
    agent_id_event: body?.event?.agent_id || null,
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

    // ✅ NEW: print the raw candidate fields so we can confirm the real call_id field
    logRawIdCandidates(body);

    console.log("CALL_ENDED incoming", {
      has_retell_signature: !!req.headers["x-retell-signature"],
      agent_id: agent_id || null,
      call_id: call_id || null,
      top_level_keys: Object.keys(body || {}),
    });

    if (!agent_id) {
      return okJson(res, 200, { ok: true, ignored: true, reason: "no_agent_id" });
    }

    // ✅ Idempotency: only decrement once per call_id
    if (call_id) {
      const seenKey = `retell:callended:${call_id}`;
      const alreadySeen = await kv.get(seenKey);

      if (alreadySeen) {
        // ✅ NEW: make duplicates obvious in logs
        console.log("retell-call-ended: DUPLICATE webhook (no decrement)", {
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
      console.warn("retell-call-ended: no call_id found; cannot dedupe this event.");
    }

    const activeKey = `outbound:${agent_id}:active`;

    let activeNow = await kv.decr(activeKey);
    if (activeNow < 0) {
      await kv.set(activeKey, 0, { ex: 60 * 10 });
      activeNow = 0;
    }

    console.log("retell-call-ended: KV decrement", {
      agent_id,
      call_id: call_id || null,
      key: activeKey,
      active_now: activeNow,
    });

    return okJson(res, 200, {
      ok: true,
      agent_id,
      call_id: call_id || null,
      active_now: activeNow,
    });
  } catch (err) {
    console.error("retell-call-ended: ERROR", err);
    return okJson(res, 500, { ok: false, error: err?.message || "Server error" });
  }
};
