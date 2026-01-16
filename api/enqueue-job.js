// /api/enqueue-job.js
const axios = require("axios");

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

// Small helper to avoid empty strings
function pick(obj, keys, fallback = "") {
  for (const k of keys) {
    const v = obj?.[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && !v.trim()) continue;
    return typeof v === "string" ? v.trim() : v;
  }
  return fallback;
}

// Same normalization you use in provision (keep consistent)
function normalizeRole(roleRaw) {
  const r = String(roleRaw || "").toLowerCase().trim();
  const map = {
    receptionist: "receptionist",
    front_desk: "receptionist",

    scheduler: "scheduler",
    scheduling: "scheduler",

    intake: "intake",
    intake_specialist: "intake",

    emergency: "emergency",
    emergency_dispatch: "emergency",
    dispatcher: "emergency",

    lead_revival: "lead_revival",
    revival: "lead_revival",

    operations: "operations",
    full_staff: "operations",
    operator: "operations",
  };
  return map[r] || "receptionist";
}

function buildSetupForRole(body, roleKey) {
  const scheduler = pick(body, ["scheduler_setup", "scheduler_config"], "");
  const intake = pick(body, ["intake_setup", "intake_config"], "");
  const emergency = pick(body, ["emergency_setup", "dispatch_setup", "dispatch_config"], "");
  const lead = pick(body, ["lead_revival_setup", "lead_revival_config"], "");

  if (roleKey === "operations") {
    return [
      scheduler && `SCHEDULING SETUP:\n${scheduler}`,
      intake && `INTAKE SETUP:\n${intake}`,
      emergency && `EMERGENCY DISPATCH SETUP:\n${emergency}`,
      lead && `LEAD REVIVAL SETUP:\n${lead}`,
    ].filter(Boolean).join("\n\n");
  }

  if (roleKey === "scheduler") return scheduler;
  if (roleKey === "intake") return intake;
  if (roleKey === "emergency") return emergency;
  if (roleKey === "lead_revival") return lead;

  // receptionist uses global info only; return empty setup
  return "";
}

// In-memory idempotency (good enough for now). Replace with DB later.
const seen = global.__AIINTEGRATING_SEEN__ || (global.__AIINTEGRATING_SEEN__ = new Map());

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const body = await readJsonBody(req);

  const idempotencyKey = pick(body, ["idempotency_key", "idem_key", "job_id"], "");
  if (!idempotencyKey) {
    return res.status(400).json({
      ok: false,
      error: "Missing idempotency_key",
      hint: "Send a unique idempotency_key from Zapier (e.g., Jotform submission ID).",
      received_keys: Object.keys(body || {}),
    });
  }

  // If we've already processed this key, return the cached result
  if (seen.has(idempotencyKey)) {
    return res.status(200).json({
      ok: true,
      duplicate: true,
      idempotency_key: idempotencyKey,
      cached: seen.get(idempotencyKey),
    });
  }

  const roleKey = normalizeRole(pick(body, ["agent_role", "role"], "receptionist"));

  // Build the correct setup block for the role
  const roleSetup = buildSetupForRole(body, roleKey);

  // Prepare payload for /api/provision
  const provisionPayload = {
    ...body,
    agent_role: roleKey,
    // This is what your provision.js expects for the role:
    [`${roleKey}_setup`]: roleSetup,
  };

  // Call provision immediately (acts like your "worker" for now)
  const provisionUrl = pick(body, ["provision_url"], process.env.PROVISION_URL);
  if (!provisionUrl) {
    return res.status(500).json({
      ok: false,
      error: "Missing PROVISION_URL",
      hint: "Set PROVISION_URL in Vercel env to your deployed /api/provision endpoint.",
    });
  }

  try {
    const resp = await axios.post(provisionUrl, provisionPayload, { timeout: 30000 });
    const result = resp.data;

    // Cache for idempotency
    seen.set(idempotencyKey, result);

    return res.status(200).json({
      ok: true,
      queued: true,
      idempotency_key: idempotencyKey,
      role: roleKey,
      used_setup_length: roleSetup ? String(roleSetup).length : 0,
      provision_result: result,
    });
  } catch (err) {
    const details = err?.response?.data || err?.message || String(err);
    return res.status(500).json({
      ok: false,
      error: "Enqueue failed to provision",
      idempotency_key: idempotencyKey,
      role: roleKey,
      details,
    });
  }
};
