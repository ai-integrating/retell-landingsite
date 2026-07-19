// /api/provision.js
const axios = require("axios");

// -------------------- CORS --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// -------------------- BODY --------------------
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

function pick(obj, keys, fallback = undefined) {
  for (const k of keys) {
    let val = obj?.[k];

    if (val && typeof val === "object" && "output" in val) {
      val = val.output;
    }

    if (val === undefined || val === null) continue;

    if (typeof val === "string") {
      const s = val.trim();
      if (!s || s.toLowerCase() === "null" || s.toLowerCase() === "undefined") continue;
      return s;
    }

    return val;
  }
  return fallback;
}

// -------------------- AGENT RESOLVER --------------------
const MASTER_TEMPLATE_LLM_ID = "llm_18a432fcc18b235399fc298809ef";

function resolveAgentSelection(agentName) {
  const normalized = String(agentName || "").trim().toLowerCase();
  const agents = {
    marcus: {
      agent_name: "Marcus",
      agent_gender: "male",
      voice_tone: "calm",
      agent_role: "receptionist",
      agent_template_id: "receptionist_male_v1",
      template_llm_id: MASTER_TEMPLATE_LLM_ID,
      voice_name: "Marcus",
      voice_provider: "11labs",
      number_tier: "standard",
    },
    peter: {
      agent_name: "Peter",
      agent_gender: "male",
      voice_tone: "calm",
      agent_role: "estimator",
      agent_template_id: "estimator_male_v1",
      template_llm_id: MASTER_TEMPLATE_LLM_ID,
      voice_name: "Peter",
      voice_provider: "11labs",
      number_tier: "standard",
    },
    ava: {
      agent_name: "Ava",
      agent_gender: "female",
      voice_tone: "warm",
      agent_role: "scheduler",
      agent_template_id: "scheduler_female_v1",
      template_llm_id: MASTER_TEMPLATE_LLM_ID,
      voice_name: "Ava",
      voice_provider: "11labs",
      number_tier: "premium",
    },
  };
  return agents[normalized] || null;
}

// -------------------- HANDLER --------------------
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = await readJsonBody(req);
    
    const submissionId = String(
      pick(
        body,
        ["jotform_submission_id", "submission_id", "idempotency_key", "job_id"],
        ""
      )
    ).trim();

    if (!submissionId) {
      return res.status(400).json({ ok: false, error: "Missing submission ID." });
    }

    const selectedAgent = resolveAgentSelection(pick(body, ["agent_name"], ""));

    if (!selectedAgent) {
      return res.status(400).json({
        ok: false,
        error: "Unknown or missing agent selection",
        received_agent_name: body.agent_name || null,
      });
    }

    const provisionPayload = {
      ...body,
      ...selectedAgent,
      idempotency_key: submissionId,
      jotform_submission_id: submissionId,
      job_id: submissionId,
      voice_key: `${selectedAgent.agent_gender}_${selectedAgent.voice_tone}`,
      universal_info: pick(body, ["universal_info", "universal_setup", "universal_business_info", "global_setup", "business_setup"], ""),
      lead_setup: pick(body, ["lead_setup", "lead_revival_setup"], ""),
      emergency_setup: pick(body, ["emergency_setup", "dispatch_setup"], ""),
      operations_setup: pick(body, ["operations_setup"], ""),
      estimator_setup: pick(body, ["estimator_setup", "Estimator"], ""),
      mode: "agent_and_number",
      purchase_number: "true",
    };

    console.log("FINAL AGENT CREATOR PAYLOAD", {
      agent_name: provisionPayload.agent_name,
      agent_gender: provisionPayload.agent_gender,
      voice_tone: provisionPayload.voice_tone,
      voice_key: provisionPayload.voice_key,
      agent_template_id: provisionPayload.agent_template_id,
      universal_info_length: String(provisionPayload.universal_info || "").length,
    });

    const agentCreatorWebhookUrl = process.env.AGENT_CREATOR_WEBHOOK_URL;
    if (!agentCreatorWebhookUrl) {
      throw new Error("Missing AGENT_CREATOR_WEBHOOK_URL.");
    }

    const webhookResponse = await axios.post(
      agentCreatorWebhookUrl,
      provisionPayload,
      {
        timeout: 15000,
        headers: { "Content-Type": "application/json" },
      }
    );

    return res.status(200).json({
      ok: true,
      queued: true,
      idempotency_key: submissionId,
      agent_name: provisionPayload.agent_name,
      agent_gender: provisionPayload.agent_gender,
      voice_tone: provisionPayload.voice_tone,
      voice_key: provisionPayload.voice_key,
      agent_role: provisionPayload.agent_role,
      agent_template_id: provisionPayload.agent_template_id,
      universal_info_sent: Boolean(provisionPayload.universal_info),
      webhook_response: webhookResponse.data || null,
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Provisioning failed",
      details: err?.response?.data || err?.message || String(err),
    });
  }
};
