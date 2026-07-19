// /api/enqueue-job.js

const axios = require("axios");
const { kv } = require("@vercel/kv");

// Keep enqueue/provision records for 30 days.
const RECORD_TTL_SECONDS = 60 * 60 * 24 * 30;

// The lock only needs to cover this request and the Zapier webhook call.
const LOCK_TTL_SECONDS = 60;

const UNIVERSAL_LEAD_CAPTURE_POLICY = `
# UNIVERSAL LEAD CAPTURE POLICY

- Capture the caller's name and callback number for inbound service inquiries.
- Clearly identify the purpose of the call.
- Ask only ONE question at a time.
- If a callback is needed, ask for the best number to reach the caller.
- Confirm the caller's name and callback number to ensure accuracy.
- Request an email only when it is reasonably useful or required by the selected workflow.
- Do not pressure the caller or repeatedly request an email after the caller refuses.
`.trim();

// -------------------------------------------------------
// REQUEST HELPERS
// -------------------------------------------------------

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

  if (req.body && typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return await new Promise((resolve, reject) => {
    let data = "";

    req.on("data", (chunk) => {
      data += chunk;
    });

    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });

    req.on("error", reject);
  });
}

function pick(obj, keys, fallback = undefined) {
  for (const key of keys) {
    let value = obj?.[key];

    // Unwrap Zapier-style objects such as:
    // { output: "estimator" }
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, "output")
    ) {
      value = value.output;
    }

    if (value === undefined || value === null) {
      continue;
    }

    if (typeof value === "string") {
      const cleaned = value.trim();
      const lowered = cleaned.toLowerCase();

      if (
        !cleaned ||
        lowered === "null" ||
        lowered === "undefined"
      ) {
        continue;
      }

      return cleaned;
    }

    return value;
  }

  return fallback;
}

function normalizeSubmissionId(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
}

// -------------------------------------------------------
// ROLE HELPERS
// -------------------------------------------------------

function normalizeRole(roleRaw) {
  const role = String(roleRaw || "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");

  const exactRoleMap = {
    receptionist: "receptionist",
    front_desk: "receptionist",

    scheduler: "scheduler",
    scheduling: "scheduler",

    intake: "intake",
    intake_specialist: "intake",

    emergency: "emergency",
    emergency_dispatch: "emergency",
    dispatcher: "emergency",
    dispatch: "emergency",

    lead_revival: "lead_revival",
    revival: "lead_revival",

    operations: "operations",
    full_staff: "operations",
    operator: "operations",

    estimator: "estimator",
    estimating: "estimator",

    // Preserve compatibility with previous values,
    // but normalize them to the estimator capability.
    receptionist_estimator: "estimator",
    estimator_receptionist: "estimator",
  };

  if (exactRoleMap[role]) {
    return exactRoleMap[role];
  }

  if (
    role.includes("full_staff") ||
    role.includes("operations") ||
    role.includes("operator")
  ) {
    return "operations";
  }

  if (role.includes("estimat")) {
    return "estimator";
  }

  if (role.includes("lead") || role.includes("revival")) {
    return "lead_revival";
  }

  if (role.includes("dispatch") || role.includes("emergency")) {
    return "emergency";
  }

  if (role.includes("intake")) {
    return "intake";
  }

  if (role.includes("sched")) {
    return "scheduler";
  }

  if (role.includes("reception") || role.includes("front")) {
    return "receptionist";
  }

  return "receptionist";
}

function buildSetupForRole(body, roleKey) {
  const receptionistSetup = pick(
    body,
    ["receptionist_setup", "receptionist_config"],
    ""
  );

  const schedulerSetup = pick(
    body,
    ["scheduler_setup", "scheduler_config"],
    ""
  );

  const estimatorSetup = pick(
    body,
    [
      "estimator_setup",
      "estimator_config",
      "estimate_setup",
      "Estimator",
    ],
    ""
  );

  const intakeSetup = pick(
    body,
    ["intake_setup", "intake_config"],
    ""
  );

  const emergencySetup = pick(
    body,
    [
      "emergency_setup",
      "dispatch_setup",
      "dispatch_config",
    ],
    ""
  );

  const leadRevivalSetup = pick(
    body,
    ["lead_revival_setup", "lead_revival_config"],
    ""
  );

  const blocks = [];

  // Every agent has the shared receptionist baseline.
  // Include custom receptionist setup whenever it exists.
  if (receptionistSetup) {
    blocks.push(
      `RECEPTIONIST SETUP:\n${receptionistSetup}`
    );
  }

  if (roleKey === "scheduler" && schedulerSetup) {
    blocks.push(
      `SCHEDULING SETUP:\n${schedulerSetup}`
    );
  }

  if (roleKey === "estimator" && estimatorSetup) {
    blocks.push(
      `ESTIMATOR SETUP:\n${estimatorSetup}`
    );
  }

  if (roleKey === "intake" && intakeSetup) {
    blocks.push(
      `INTAKE SETUP:\n${intakeSetup}`
    );
  }

  if (roleKey === "emergency" && emergencySetup) {
    blocks.push(
      `EMERGENCY DISPATCH SETUP:\n${emergencySetup}`
    );
  }

  if (roleKey === "lead_revival" && leadRevivalSetup) {
    blocks.push(
      `LEAD REVIVAL SETUP:\n${leadRevivalSetup}`
    );
  }

  // Operations receives all available capability setup blocks.
  if (roleKey === "operations") {
    if (schedulerSetup) {
      blocks.push(
        `SCHEDULING SETUP:\n${schedulerSetup}`
      );
    }

    if (estimatorSetup) {
      blocks.push(
        `ESTIMATOR SETUP:\n${estimatorSetup}`
      );
    }

    if (intakeSetup) {
      blocks.push(
        `INTAKE SETUP:\n${intakeSetup}`
      );
    }

    if (emergencySetup) {
      blocks.push(
        `EMERGENCY DISPATCH SETUP:\n${emergencySetup}`
      );
    }

    if (leadRevivalSetup) {
      blocks.push(
        `LEAD REVIVAL SETUP:\n${leadRevivalSetup}`
      );
    }
  }

  return blocks.join("\n\n");
}

// -------------------------------------------------------
// NORMALIZED ZAPIER CONTRACT
// -------------------------------------------------------

function buildCleanPayload(body, submissionId, roleKey) {
  return {
    // Keep the original submission fields for backward compatibility.
    ...body,

    // Stable identifiers
    idempotency_key: submissionId,
    jotform_submission_id: submissionId,
    submission_id: submissionId,
    job_id: submissionId,

    // Requested provisioning behavior
    status: "queued",
    mode: "agent_and_number",
    purchase_number: true,

    // Customer and business information
    business_name: pick(
      body,
      [
        "business_name",
        "biz_name",
        "company",
        "company_name",
      ],
      ""
    ),

    client_name: pick(
      body,
      [
        "client_name",
        "customer_name",
        "owner_name",
        "full_name",
      ],
      ""
    ),

    client_email: pick(
      body,
      [
        "client_email",
        "email",
        "customer_email",
        "owner_email",
      ],
      ""
    ),

    business_phone: pick(
      body,
      [
        "business_phone",
        "phone",
        "company_phone",
      ],
      ""
    ),

    website: pick(
      body,
      [
        "website",
        "website_url",
        "web",
        "site",
        "url",
      ],
      ""
    ),

    industry: pick(
      body,
      [
        "industry",
        "business_type",
        "primary_business_type",
      ],
      ""
    ),

    timezone: pick(
      body,
      ["timezone", "time_zone", "tz"],
      "America/New_York"
    ),

    business_hours: pick(
      body,
      ["business_hours", "hours"],
      ""
    ),

    service_area: pick(
      body,
      [
        "service_area",
        "service_area_cities",
        "cities",
        "towns",
      ],
      ""
    ),

    // Package information
    purchased_package: pick(
      body,
      [
        "purchased_package",
        "package",
        "subscription",
        "subscription_plan",
      ],
      ""
    ),

    add_ons: pick(
      body,
      [
        "add_ons",
        "addons",
        "selected_add_ons",
      ],
      ""
    ),

    // Agent configuration
    agent_role: roleKey,

    agent_name: pick(
      body,
      ["agent_name", "a_name", "voice_name"],
      ""
    ),

    agent_gender: pick(
      body,
      ["agent_gender", "voice_gender", "gender"],
      ""
    ),

    voice_tone: pick(
      body,
      ["voice_tone", "tone"],
      ""
    ),

    agent_template_id: pick(
      body,
      ["agent_template_id", "template_id"],
      ""
    ),

    template_llm_id: pick(
      body,
      [
        "template_llm_id",
        "retell_template_llm_id",
      ],
      ""
    ),

    voice_name: pick(
      body,
      ["voice_name", "agent_voice_name"],
      ""
    ),

    voice_id: pick(
      body,
      [
        "voice_id",
        "retell_voice_id",
        "elevenlabs_voice_id",
      ],
      ""
    ),

    voice_provider: pick(
      body,
      ["voice_provider", "provider"],
      ""
    ),

    // Prompt and setup information
    global_setup: pick(
      body,
      [
        "global_setup",
        "business_setup",
        "company_setup",
        "global_info",
      ],
      ""
    ),

    receptionist_setup: pick(
      body,
      [
        "receptionist_setup",
        "receptionist_config",
      ],
      ""
    ),

    scheduler_setup: pick(
      body,
      [
        "scheduler_setup",
        "scheduler_config",
      ],
      ""
    ),

    estimator_setup: pick(
      body,
      [
        "estimator_setup",
        "estimator_config",
        "estimate_setup",
        "Estimator",
      ],
      ""
    ),

    intake_setup: pick(
      body,
      ["intake_setup", "intake_config"],
      ""
    ),

    emergency_setup: pick(
      body,
      [
        "emergency_setup",
        "dispatch_setup",
        "dispatch_config",
      ],
      ""
    ),

    lead_revival_setup: pick(
      body,
      [
        "lead_revival_setup",
        "lead_revival_config",
      ],
      ""
    ),

    role_setup: buildSetupForRole(body, roleKey),

    universal_lead_capture_policy:
      UNIVERSAL_LEAD_CAPTURE_POLICY,

    // Scheduling information
    cal_username: pick(
      body,
      [
        "cal_username",
        "calendar_username",
        "calcom_username",
        "cal_com_username",
        "booking_username",
      ],
      ""
    ),

    cal_slug: pick(
      body,
      [
        "cal_slug",
        "calendar_slug",
        "event_type_slug",
        "service_key",
        "booking_service_key",
      ],
      ""
    ),

    service_key: pick(
      body,
      [
        "service_key",
        "booking_service_key",
        "default_service_key",
      ],
      ""
    ),
  };
}

// -------------------------------------------------------
// HANDLER
// -------------------------------------------------------

module.exports = async function enqueueJob(req, res) {
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

  let submissionId = "";
  let enqueueKey = "";
  let provisionKey = "";
  let lockKey = "";
  let lockAcquired = false;

  try {
    const body = await readJsonBody(req);

    submissionId = normalizeSubmissionId(
      pick(
        body,
        [
          "jotform_submission_id",
          "submission_id",
          "idempotency_key",
          "job_id",
        ],
        ""
      )
    );

    if (!submissionId) {
      return res.status(400).json({
        ok: false,
        error: "Missing submission ID.",
      });
    }

    const agentCreatorWebhookUrl =
      process.env.AGENT_CREATOR_WEBHOOK_URL;

    if (!agentCreatorWebhookUrl) {
      return res.status(500).json({
        ok: false,
        error:
          "Missing AGENT_CREATOR_WEBHOOK_URL environment variable.",
        idempotency_key: submissionId,
      });
    }

    enqueueKey = `enq:${submissionId}`;
    provisionKey = `prov:${submissionId}`;
    lockKey = `enqlock:${submissionId}`;

    // Provision is the source of truth.
    const existingProvision = await kv.get(provisionKey);

    if (existingProvision?.status === "completed") {
      return res.status(200).json({
        ok: true,
        queued: false,
        completed: true,
        idempotent: true,
        handoff_status: "provisioning_completed",
        idempotency_key: submissionId,
        agent_id:
          existingProvision.agent_id || null,
        phone_number:
          existingProvision.phone_number || null,
        phone_number_id:
          existingProvision.phone_number_id || null,
      });
    }

    // Do not resend while provision is actively creating a paid resource.
    // The provisioner should own its own durable lock as well.
    if (
      existingProvision?.status === "creating_agent" ||
      existingProvision?.status === "purchasing_number"
    ) {
      return res.status(202).json({
        ok: true,
        queued: true,
        completed: false,
        idempotent: true,
        handoff_status: "provisioning_in_progress",
        provisioning_status: existingProvision.status,
        idempotency_key: submissionId,
        agent_id:
          existingProvision.agent_id || null,
      });
    }

    // Prevent two enqueue requests from forwarding simultaneously.
    const lockResult = await kv.set(
      lockKey,
      {
        status: "locked",
        submission_id: submissionId,
        locked_at: new Date().toISOString(),
      },
      {
        nx: true,
        ex: LOCK_TTL_SECONDS,
      }
    );

    lockAcquired = Boolean(lockResult);

    if (!lockAcquired) {
      return res.status(202).json({
        ok: true,
        queued: true,
        completed: false,
        handoff_status: "enqueue_in_progress",
        idempotency_key: submissionId,
      });
    }

    // Recheck provision after obtaining the lock.
    // It may have completed between the first check and lock acquisition.
    const provisionAfterLock = await kv.get(provisionKey);

    if (provisionAfterLock?.status === "completed") {
      return res.status(200).json({
        ok: true,
        queued: false,
        completed: true,
        idempotent: true,
        handoff_status: "provisioning_completed",
        idempotency_key: submissionId,
        agent_id:
          provisionAfterLock.agent_id || null,
        phone_number:
          provisionAfterLock.phone_number || null,
        phone_number_id:
          provisionAfterLock.phone_number_id || null,
      });
    }

    if (
      provisionAfterLock?.status === "creating_agent" ||
      provisionAfterLock?.status === "purchasing_number"
    ) {
      return res.status(202).json({
        ok: true,
        queued: true,
        completed: false,
        idempotent: true,
        handoff_status: "provisioning_in_progress",
        provisioning_status:
          provisionAfterLock.status,
        idempotency_key: submissionId,
        agent_id:
          provisionAfterLock.agent_id || null,
      });
    }

    const existingEnqueue = await kv.get(enqueueKey);
    const previousAttempts = Number(
      existingEnqueue?.attempt_count || 0
    );

    const roleKey = normalizeRole(
      pick(
        body,
        ["agent_role", "role", "a_role"],
        "receptionist"
      )
    );

    const cleanPayload = buildCleanPayload(
      body,
      submissionId,
      roleKey
    );

    // Record the forwarding attempt for observability.
    await kv.set(
      enqueueKey,
      {
        status: "forwarding",
        submission_id: submissionId,
        role: roleKey,
        attempt_count: previousAttempts + 1,
        started_at: new Date().toISOString(),
        previous_status:
          existingEnqueue?.status || null,
      },
      {
        ex: RECORD_TTL_SECONDS,
      }
    );

    const zapierResponse = await axios.post(
      agentCreatorWebhookUrl,
      cleanPayload,
      {
        timeout: 15000,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    // Forwarded is not the same as provisioned.
    // It only confirms Zapier accepted the webhook request.
    await kv.set(
      enqueueKey,
      {
        status: "forwarded",
        submission_id: submissionId,
        role: roleKey,
        attempt_count: previousAttempts + 1,
        forwarded_at: new Date().toISOString(),
        zapier_status:
          zapierResponse?.status || null,
      },
      {
        ex: RECORD_TTL_SECONDS,
      }
    );

    return res.status(200).json({
      ok: true,
      queued: true,
      completed: false,
      handoff_status: "forwarded_to_zapier",
      handed_off_to_agent_creator: true,
      idempotency_key: submissionId,
      role: roleKey,
      attempt_count: previousAttempts + 1,
    });
  } catch (error) {
    const details =
      error?.response?.data ||
      error?.message ||
      String(error);

    // Preserve the failure for visibility, but do not make it final.
    // A later request may retry this submission.
    if (enqueueKey && submissionId) {
      try {
        const existingEnqueue =
          await kv.get(enqueueKey);

        await kv.set(
          enqueueKey,
          {
            status: "failed",
            submission_id: submissionId,
            attempt_count: Number(
              existingEnqueue?.attempt_count || 1
            ),
            failed_at: new Date().toISOString(),
            last_error:
              typeof details === "string"
                ? details
                : JSON.stringify(details),
          },
          {
            ex: RECORD_TTL_SECONDS,
          }
        );
      } catch {
        // Do not replace the original error if KV error logging fails.
      }
    }

    return res.status(500).json({
      ok: false,
      queued: false,
      error: "Enqueue failed to forward to Zapier",
      idempotency_key: submissionId || "",
      details,
    });
  } finally {
    // Only delete the lock if this request acquired it.
    if (lockAcquired && lockKey) {
      try {
        await kv.del(lockKey);
      } catch {
        // The lock also expires automatically.
      }
    }
  }
};
