// /api/provision.js
const axios = require("axios");

// --------------------
// Helpers
// --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

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

function pick(obj, keys, fallback = undefined) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return fallback;
}

function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

function inferAreaCode(body) {
  // Priority: preferred_area_code -> business_phone -> fallback
  const preferred = digitsOnly(pick(body, ["preferred_area_code", "area_code"], "")).slice(0, 3);
  if (preferred.length === 3) return preferred;

  const bizPhone = pick(body, ["business_phone", "phone", "company_phone"], "");
  const d = digitsOnly(bizPhone);

  // US 10-digit: AAAxxxxxxx or 11-digit starting with 1
  if (d.length === 10) return d.slice(0, 3);
  if (d.length === 11 && d.startsWith("1")) return d.slice(1, 4);

  return "508"; // safe default
}

function nowStamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, "");
}

// --------------------
// Canonical lineup + missions
// --------------------
const GLOBAL_PROTOCOL = `
GLOBAL STAFF PROTOCOL (MANDATORY):
- Identity: You are a member of the office team at {{business_name}}.
- AI Disclosure: Do NOT volunteer that you are an AI. If explicitly asked "Are you a robot/AI?", say:
  "Yes, I am an AI assistant helping the team handle calls. I can help you now or take a detailed message for the office."
- Pricing: Never provide exact quotes or binding prices. Say:
  "Pricing depends on the job requirements; our team will provide a formal estimate after reviewing your details."
- Safety: Do not provide medical, legal, or technical safety advice. In life-threatening emergencies, instruct the caller to hang up and dial 911.
- Consistency: Stay in character. Use a warm, professional, and efficient tone at all times.
`;

const STAFF_ROLES = [
  {
    name: "Allie",
    role_display: "AI Receptionist",
    role_id: "receptionist",
    mission: `You are Allie, the AI Receptionist for {{business_name}}. Your job is to answer calls professionally, capture caller details, provide basic business info from WEBSITE FACTS, and route the caller to the correct next step. You do not overpromise; you set clear expectations and take excellent messages.`,
  },
  {
    name: "Mia",
    role_display: "Intake Specialist",
    role_id: "intake",
    mission: `You are Mia, the Intake Specialist for {{business_name}}. Your job is to qualify leads and capture complete job details using structured questions (service type, location, urgency, timeline, key details). You organize the request so the team can respond quickly.`,
  },
  {
    name: "Lexi",
    role_display: "Scheduler",
    role_id: "scheduler",
    mission: `You are Lexi, the Scheduler for {{business_name}}. Your job is to gather preferred appointment windows and scheduling details without overpromising. You collect what’s needed for approval and explain the confirmation process clearly.`,
  },
  {
    name: "Sam",
    role_display: "Dispatcher",
    role_id: "dispatcher",
    mission: `You are Sam, the Dispatcher for {{business_name}}. Your job is to identify urgent situations, gather critical details fast, and follow the escalation protocol. If not urgent, you capture details and route to normal workflow.`,
  },
];

// --------------------
// Retell client
// --------------------
const RETELL_BASE = "https://api.retellai.com";

function retellHeaders() {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) throw new Error("Missing RETELL_API_KEY in environment variables.");
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

// Create LLM (Retell)
async function createRetellLLM({ prompt, model }) {
  const headers = retellHeaders();
  const resp = await axios.post(
    `${RETELL_BASE}/create-retell-llm`,
    {
      general_prompt: prompt,
      model: model || "gpt-4o-mini",
    },
    { headers }
  );
  return resp.data; // expects llm_id
}

// Create Agent (Retell)
async function createRetellAgent({ bizName, staffName, roleDisplay, llmId, voiceId, metadata }) {
  const headers = retellHeaders();
  const stamp = nowStamp();
  const resp = await axios.post(
    `${RETELL_BASE}/create-agent`,
    {
      agent_name: `${bizName} - ${staffName} (${roleDisplay}) - ${stamp}`,
      voice_id: voiceId || process.env.DEFAULT_VOICE_ID,
      response_engine: { type: "retell-llm", llm_id: llmId },
      metadata: metadata || {},
    },
    { headers }
  );
  return resp.data; // expects agent_id
}

// --------------------
// Phone buy & bind (Retell) — supports either "id" or "phone_number" style APIs.
// You may only need to adjust ONE endpoint depending on your Retell account.
// --------------------
async function createPhoneNumber({ areaCode, nickname }) {
  const headers = retellHeaders();

  // Common pattern (Gemini-style): POST /create-phone-number
  const resp = await axios.post(
    `${RETELL_BASE}/create-phone-number`,
    {
      area_code: Number(areaCode),
      nickname,
    },
    { headers, timeout: 7000 }
  );

  // Possible return keys:
  // - phone_number (E.164)
  // - e164
  // - phone_number_id / id
  return resp.data;
}

async function bindPhoneNumberToAgent({ phoneData, agentId }) {
  const headers = retellHeaders();

  const phoneNumber =
    phoneData.phone_number ||
    phoneData.e164 ||
    phoneData.number ||
    null;

  const phoneId =
    phoneData.phone_number_id ||
    phoneData.id ||
    null;

  // Binding API patterns differ. We try two common patterns.

  // Pattern A: PATCH /update-phone-number/{E164}
  if (phoneNumber) {
    try {
      await axios.patch(
        `${RETELL_BASE}/update-phone-number/${encodeURIComponent(phoneNumber)}`,
        { inbound_agent_id: agentId, outbound_agent_id: agentId },
        { headers, timeout: 7000 }
      );
      return { phone_number: phoneNumber };
    } catch (e) {
      // fall through to Pattern B
    }
  }

  // Pattern B: PATCH /update-phone-number/{phoneId}
  if (phoneId) {
    await axios.patch(
      `${RETELL_BASE}/update-phone-number/${encodeURIComponent(phoneId)}`,
      { inbound_agent_id: agentId, outbound_agent_id: agentId },
      { headers, timeout: 7000 }
    );
    return { phone_number: phoneNumber || "(number assigned)" };
  }

  throw new Error("Could not bind phone number: missing phone_number and phone_number_id in response.");
}

// --------------------
// Prompt builder
// --------------------
function buildPrompt({ bizName, staffMission, structuredFacts }) {
  const facts = structuredFacts ? String(structuredFacts) : "";
  return `
${staffMission}

${GLOBAL_PROTOCOL}

WEBSITE FACTS:
${facts}

REMINDER:
- Use the WEBSITE FACTS as your source of truth for hours/services/service areas.
- If info is missing, ask the caller for details and take a message.
`
    .replaceAll("{{business_name}}", bizName);
}

// --------------------
// Handler
// --------------------
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = await readJsonBody(req);

    const bizName = pick(body, ["business_name", "biz_name", "company", "company_name"], "Client Business");
    const packageType = pick(body, ["package_type", "product_name", "plan"], "solo_allie");
    const structuredFacts = pick(body, ["structured_facts", "website_facts", "facts"], "");
    const voiceId = pick(body, ["voice_id"], process.env.DEFAULT_VOICE_ID);

    // metadata you may want later
    const metadataBase = {
      business_name: bizName,
      client_email: pick(body, ["email_for_call_summaries", "email"], ""),
      notify_phone: pick(body, ["notify_phone", "cell_phone", "owner_phone"], ""),
    };

    const areaCode = inferAreaCode(body);

    // Decide which roles to provision
    const isFullStaff =
      String(packageType).toLowerCase().includes("full") ||
      String(packageType).toLowerCase().includes("bundle") ||
      String(packageType).toLowerCase().includes("digital_staff");

    const rolesToProvision = isFullStaff
      ? STAFF_ROLES
      : [STAFF_ROLES[0]]; // Allie only

    const provisioned = [];

    for (const staff of rolesToProvision) {
      // 1) Build prompt (mission + global protocol + facts)
      const prompt = buildPrompt({
        bizName,
        staffMission: staff.mission,
        structuredFacts,
      });

      // 2) Create LLM
      const llm = await createRetellLLM({ prompt, model: pick(body, ["llm_model"], "gpt-4o-mini") });
      const llmId = llm.llm_id || llm.id;
      if (!llmId) throw new Error("Retell LLM creation did not return llm_id.");

      // 3) Create Agent
      const agent = await createRetellAgent({
        bizName,
        staffName: staff.name,
        roleDisplay: staff.role_display,
        llmId,
        voiceId,
        metadata: { ...metadataBase, role_id: staff.role_id, role_display: staff.role_display },
      });

      const agentId = agent.agent_id || agent.id;
      if (!agentId) throw new Error("Retell agent creation did not return agent_id.");

      // 4) Buy & bind phone (Zap-proof fallback)
      let livePhoneNumber = "Provisioning...";
      try {
        const phoneData = await createPhoneNumber({
          areaCode,
          nickname: `${bizName} - ${staff.name} (${staff.role_display})`,
        });

        const bound = await bindPhoneNumberToAgent({ phoneData, agentId });
        if (bound.phone_number) livePhoneNumber = bound.phone_number;
      } catch (phoneErr) {
        console.error("Phone step failed:", phoneErr?.response?.data || phoneErr?.message || phoneErr);
      }

      provisioned.push({
        name: staff.name,
        role_id: staff.role_id,
        role_display: staff.role_display,
        agent_id: agentId,
        phone_number: livePhoneNumber,
      });
    }

    // For Zapier convenience:
    // - Always return a top-level phone_number for the "primary" line (Allie if present).
    const primary = provisioned.find((p) => p.role_id === "receptionist") || provisioned[0];

    return res.status(200).json({
      ok: true,
      package: isFullStaff ? "full_staff" : "solo_allie",
      agent_id: primary?.agent_id,         // keeps your existing Zap mapping simple
      phone_number: primary?.phone_number, // this is what you map into the email
      agents: provisioned,                 // future-proof for full-staff emails
    });
  } catch (error) {
    console.error("Provisioning failed:", error?.response?.data || error?.message || error);
    return res.status(500).json({
      ok: false,
      error: "Provisioning Failed",
      details: error?.response?.data || error?.message,
    });
  }
};
