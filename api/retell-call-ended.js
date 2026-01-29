// /api/retell-call-ended.js
// Purpose: Retell/Zapier webhook handler to decrement concurrent outbound counter when a call ends.

const { kv } = require("@vercel/kv");

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Retell-Secret, X-Webhook-Secret, X-Retell-Signature"
  );
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

/**
 * Authorization strategy (safe + practical):
 * 1) If RETELL_WEBHOOK_SECRET is not set -> allow (dev mode)
 * 2) If caller is Zapier -> allow TEMPORARILY (so you can confirm KV works)
 * 3) Otherwise require header x-webhook-secret (or x-retell-secret) to match RETELL_WEBHOOK_SECRET
 *
 * After you confirm KV works:
 * - add x-webhook-secret header in Zapier (same secret), then
 * - remove the Zapier bypass line.
 */
function isAuthorized(req) {
  const secret = process.env.RETELL_WEBHOOK_SECRET;
  if (!secret) return true;

  const ua = String(req.headers["user-agent"] || "").toLowerCase();

  // TEMP BYPASS so your Zapier test calls stop 401'ing
  if (ua.includes("zapier")) return true;

  const got =
    req.headers["x-webhook-secret"] ||
    req.headers["x-retell-secret"];

  return String(got || "") === String(secret);
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
      has_webhook_secret: !!req.headers["x-webhook-secret"],
      has_retell_secret: !!req.headers["x-retell-secret"],
      has_retell_signature: !!req.headers["x-retell-signature"],
      received_headers: Object.keys(req.headers || {}),
    });
  }

  try {
    const body = await readJsonBody(req);

    const agent_id =
      body?.agent_id ||
      body?.call?.agent_id ||
      body?.data?.agent_id ||
      body?.event?.agent_id;

    const call_id =
      body?.call_id ||
      body?.call?.call_id ||
      body?.data?.call_id ||
      body?.event?.call_id;

    if (!agent_id) {
      return okJson(res, 200, { ok: true, ignored: true, reason: "no_agent_id" });
    }

    const activeKey = `outbound:${agent_id}:active`;

    let activeNow = await kv.decr(activeKey);
    if (activeNow < 0) {
      await kv.set(activeKey, 0, { ex: 60 * 10 });
      activeNow = 0;
    }

    // Helpful log so you can confirm KV is changing
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
