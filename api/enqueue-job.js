// /api/enqueue-job.js
const axios = require("axios");

// Universal policy applied to all inbound agents
const UNIVERSAL_LEAD_CAPTURE_POLICY = `
LEAD CAPTURE FIRST POLICY (MANDATORY)

Every inbound caller must be identified.
Capture caller name before proceeding with the workflow.
Then proceed with the workflow.

Capture email whenever reasonably possible.
If an estimate is requested, email is mandatory to request unless the customer refuses.
Capture service/property address when applicable.

Only after minimum lead information is collected should the AI move into scheduling, estimating, dispatching, sales, or support.

For inbound calls, this policy overrides any role flow that delays name/contact capture until later in the call.

Never end a call without at least attempting to collect contact information.

Goal: We're closing leads, not losing them.
`;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return await new Promise((resolve) => {
    let data = "";

    req.on("data", (chunk) => {
      data += chunk;
    });

    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function pick(obj, keys, fallback = "") {
  for (const key of keys) {
    const value = obj?.[key];

    if (value === undefined || value === null) continue;
    if (typeof value === "string" && !value.trim()) continue;

    return typeof value === "string" ? value.trim() : value;
  }

  return fallback;
}

function normalizeRole(roleRaw) {
  const role = String(roleRaw || "").toLowerCase().trim();

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

    estimator: "receptionist_estimator",
    receptionist_estimator: "receptionist_estimator",
    estimator_receptionist: "receptionist_estimator",

    operations: "operations",
    full_staff: "operations",
    operator: "operations",
  };

  return map[role] || "receptionist";
}

function buildSetupForRole(body, roleKey) {
  const scheduler = pick(
    body,
    ["scheduler_setup", "scheduler_config"],
    ""
  );

  const intake = pick(
    body,
    ["intake_setup", "intake_config"],
    ""
  );

  const emergency = pick(
    body,
    ["emergency_setup", "dispatch_setup", "dispatch_config"],
    ""
  );

  const lead = pick(
    body,
    ["lead_revival_setup", "lead_revival_config"],
    ""
  );

  const estimator = pick(
    body,
    ["estimator_setup", "estimator_config"],
    ""
  );

  if (roleKey === "operations") {
    return [
      scheduler && `SCHEDULING SETUP:\n${scheduler}`,
      intake && `INTAKE SETUP:\n${intake}`,
      emergency && `EMERGENCY DISPATCH SETUP:\n${emergency}`,
      lead && `LEAD REVIVAL SETUP:\n${lead}`,
      estimator && `ESTIMATOR SETUP:\n${estimator}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  if (roleKey === "receptionist_estimator") {
    return [
      "RECEPTIONIST + ESTIMATOR SETUP:",
      estimator && `ESTIMATOR FLOWS & CONFIG:\n${estimator}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  if (roleKey === "scheduler") return scheduler;
  if (roleKey === "intake") return intake;
  if (roleKey === "emergency") return emergency;
  if (roleKey === "lead_revival") return lead;

  return "";
}

// Temporary same-instance duplicate protection.
// Durable provisioning protection remains inside /api/provision using KV.
const seen =
  global.__AIINTEGRATING_SEEN__ ||
  (global.__AIINTEGRATING_SEEN__ = new Map());

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  const body = await readJsonBody(req);

  const idempotencyKey = String(
    pick(
      body,
      [
        "jotform_submission_id",
        "submission_id",
        "idempotency_key",
        "idem_key",
        "job_id",
      ],
      ""
    )
  ).trim();

  if (!idempotencyKey) {
    return res.status(400).json({
      ok: false,
      error: "Missing submission ID or idempotency key",
      hint:
        "Send the Jotform submission ID as jotform_submission_id, submission_id, idempotency_key, or job_id.",
      received_keys: Object.keys(body || {}),
    });
  }

  if (seen.has(idempotencyKey)) {
    return res.status(200).json({
      ok: true,
      queued: true,
      duplicate: true,
      handed_off_to_agent_creator: true,
      idempotency_key: idempotencyKey,
      cached: seen.get(idempotencyKey),
    });
  }

  const roleKey = normalizeRole(
    pick(body, ["agent_role", "role"], "receptionist")
  );

  const roleSetup = buildSetupForRole(body, roleKey);

  const provisionPayload = {
    ...body,
    agent_role: roleKey,
    universal_lead_capture_policy:
      UNIVERSAL_LEAD_CAPTURE_POLICY,
    [`${roleKey}_setup`]: roleSetup,

    // Preserve one ID through the entire workflow.
    jotform_submission_id: idempotencyKey,
    submission_id: idempotencyKey,
    idempotency_key: idempotencyKey,
    job_id: idempotencyKey,

    status: "queued",
    mode: "agent_and_number",
    purchase_number: "true",
  };

  const agentCreatorWebhookUrl =
    process.env.AGENT_CREATOR_WEBHOOK_URL;

  if (!agentCreatorWebhookUrl) {
    return res.status(500).json({
      ok: false,
      error: "Missing AGENT_CREATOR_WEBHOOK_URL",
    });
  }

  try {
    const webhookResponse = await axios.post(
      agentCreatorWebhookUrl,
      provisionPayload,
      {
        timeout: 15000,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const queuedResult = {
      webhook_status: webhookResponse.status,
      role: roleKey,
    };

    seen.set(idempotencyKey, queuedResult);

    return res.status(200).json({
      ok: true,
      queued: true,
      handed_off_to_agent_creator: true,
      idempotency_key: idempotencyKey,
      role: roleKey,
    });
  } catch (err) {
    const details =
      err?.response?.data ||
      err?.message ||
      String(err);

    return res.status(502).json({
      ok: false,
      error: "Failed to hand off job to Agent Creator Zap",
      idempotency_key: idempotencyKey,
      role: roleKey,
      details,
    });
  }
};
