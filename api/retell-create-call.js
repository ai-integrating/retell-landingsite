const axios = require("axios");
const crypto = require("crypto");

// --- 1. CORE UTILITIES ---
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function pick(obj, keys, fallback = "Not provided") {
  for (const k of keys) {
    let val = obj?.[k];
    if (val !== undefined && val !== null && val !== "" && val !== "No data") {
      if (typeof val === "object" && val.output) return val.output;
      return val;
    }
  }
  return fallback;
}

// --- 2. VOICE RESOLUTION ---
function resolveVoiceId(body) {
  const direct = pick(body, ["voice_id", "voiceId", "VOICE_ID"], "");
  if (direct && direct !== "Not provided") return String(direct).trim();

  const tone = String(pick(body, ["voice_tone", "voiceTone", "tone"], "warm"))
    .toLowerCase()
    .trim();
  const gender = String(
    pick(body, ["agent_gender", "agentGender", "gender"], "female")
  )
    .toLowerCase()
    .trim();

  const VOICE_MAP = {
    female_warm: process.env.VOICE_FEMALE_WARM,
    female_authoritative: process.env.VOICE_FEMALE_AUTHORITATIVE,
    female_calm: process.env.VOICE_FEMALE_CALM,
    male_warm: process.env.VOICE_MALE_WARM,
    male_authoritative: process.env.VOICE_MALE_AUTHORITATIVE,
    male_calm: process.env.VOICE_MALE_CALM,
  };

  return VOICE_MAP[`${gender}_${tone}`] || process.env.DEFAULT_VOICE_ID;
}

// --- 3. ROLE RESOLUTION (DETERMINISTIC) ---
const TEMPLATE_ROLE_MAP = {
  receptionist_female_v1: "receptionist",
  receptionist_male_v1: "receptionist",
  scheduler_female_v1: "scheduler",
  intake_female_v1: "intake",
  dispatch_female_v1: "emergency_dispatch",
  leadrevival_male_v1: "lead_revival",
  operations_female_v1: "operations",
  operations_male_v1: "operations",
};

// allowed roles (fail-fast if something weird comes in)
const ALLOWED_ROLES = new Set([
  "receptionist",
  "scheduler",
  "intake",
  "emergency_dispatch",
  "lead_revival",
  "operations",
]);

function resolveRole(body) {
  const templateIdRaw = pick(body, ["agent_template_id", "template_id"], "");
  const templateId = String(templateIdRaw || "")
    .toLowerCase()
    .trim();

  const fromTemplate = TEMPLATE_ROLE_MAP[templateId];

  const fromRoleField = String(pick(body, ["agent_role", "role"], "receptionist"))
    .toLowerCase()
    .trim();

  const resolved = fromTemplate || fromRoleField || "receptionist";

  if (!ALLOWED_ROLES.has(resolved)) {
    const err = new Error(
      `Invalid role "${resolved}". Allowed roles: ${Array.from(ALLOWED_ROLES).join(
        ", "
      )}`
    );
    err.statusCode = 400;
    err.debug = { templateId, fromTemplate, fromRoleField };
    throw err;
  }

  return { role: resolved, templateId };
}

// --- 4. WEBSITE / FORM QUALITY GUARDRAILS ---
function normalizeWebsite(url) {
  const u = String(url || "").trim();
  if (!u || u === "Not provided") return "";
  return u;
}

function safePhoneDigits(input) {
  const digits = String(input || "")
    .replace(/[^\d]/g, "")
    .trim();
  return digits || "";
}

function speakPhone(phoneDigits) {
  if (!phoneDigits) return "";
  return phoneDigits.split("").join("-");
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

// --- 5. MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const body = await readJsonBody(req);

    const headers = {
      Authorization: `Bearer ${process.env.RETELL_API_KEY}`,
      "Content-Type": "application/json",
    };

    // --- STRIPE/ZAPIER MAPPED DATA ---
    const biz_name = String(pick(body, ["business_name", "company"], "McDuffy and Son Asphalt")).trim();
    const agent_name = String(pick(body, ["agent_name"], "Samuel")).trim();
    const client_email = String(pick(body, ["email", "user_email"], "not-provided@example.com")).trim();

    const { role, templateId } = resolveRole(body);

    const website = normalizeWebsite(pick(body, ["website", "site", "business_website"], ""));
    const business_hours = String(pick(body, ["business_hours", "hours"], "")).trim();
    const services = String(pick(body, ["services", "primary_business_type", "service_type"], "")).trim();
    const extra_info = String(pick(body, ["extra_info", "notes", "additional_info"], "")).trim();

    const calendar_link = String(pick(body, ["calendar_link", "booking_link"], "")).trim();

    const emergencyPrimary = safePhoneDigits(pick(body, ["emergency_phone", "primary_emergency_phone"], ""));
    const emergencySecondary = safePhoneDigits(pick(body, ["emergency_secondary_phone"], ""));
    const urgent_instructions = String(pick(body, ["urgent_instructions"], "")).trim();

    // fallback only if missing
    const fallbackEmergencyDigits =
      emergencyPrimary || safePhoneDigits(pick(body, ["emergency_phone"], "5082910787")) || "5082910787";

    const speech_emergency = speakPhone(fallbackEmergencyDigits);

    // --- ROLE CAPSULES (LOCKED PROMPTS PER ROLE) ---
    const offer = String(pick(body, ["lead_revival_offer", "revival_offer"], "")).trim();

    const ROLE_PROMPTS = {
      receptionist: {
        begin: `Thanks for calling ${biz_name}, this is ${agent_name}. How can I help you today?`,
        tone: "Warm, professional, and efficient.",
        body: `
## CORE ROLE: RECEPTIONIST
- Greet callers and identify whether they are a new or returning customer.
- Collect: caller name, best callback number, service address (or town/city), and a short description of what they need.
- Do not guess pricing, timelines, or guarantees.
- If information is missing or unclear, ask 1–2 focused questions.
- If the caller needs urgent help, follow the Emergency Rule below.
`.trim(),
      },

      intake: {
        begin: `Thanks for calling ${biz_name}, this is ${agent_name}. What can I help you with today?`,
        tone: "Warm, calm, and organized.",
        body: `
## CORE ROLE: INTAKE SPECIALIST
- Your job is to gather complete details and route to the right next step.
- Collect: name, callback, address/town, type of service needed, and any timing constraints.
- If the caller is requesting an estimate, collect the project details and preferred time window.
- If you cannot schedule directly, take a message and promise a callback.
- Use the Emergency Rule when appropriate.
`.trim(),
      },

      scheduler: {
        begin: `Thanks for calling ${biz_name}, this is ${agent_name}. Are you looking to schedule an estimate or service?`,
        tone: "Friendly, efficient, and confident.",
        body: `
## CORE ROLE: SCHEDULER
- Your job is to schedule appointments or collect details for scheduling.
- If a booking link is provided, offer to schedule using it: ${calendar_link || "[no booking link provided]"}.
- If no booking link is provided, collect: name, callback, address/town, requested service, and preferred days/times.
- Confirm time zone if relevant.
- Use the Emergency Rule when appropriate.
`.trim(),
      },

      emergency_dispatch: {
        begin: `Emergency dispatch for ${biz_name}. This is ${agent_name}. What is the situation?`,
        tone: "Calm, authoritative, and urgent.",
        body: `
## CORE ROLE: EMERGENCY DISPATCH
- Quickly assess whether there is immediate danger (traffic hazard, safety hazard, blocked access, etc.).
- If there is a hazard: instruct the caller to mark off the area and keep people away.
- Gather: location/address, what happened, whether anyone is injured, and best callback number.
- Provide the emergency contact if needed: ${speech_emergency}.
- Keep the caller calm and move fast.
`.trim(),
      },

      lead_revival: {
        begin: `Hi, this is ${agent_name} from ${biz_name}. I'm following up on your recent quote—do you have a quick minute?`,
        tone: "Calm, friendly, never pushy.",
        body: `
## CORE ROLE: LEAD REVIVAL
- Confirm they received the quote and ask where they are in the decision process.
- Ask if scope/timing changed.
- Offer next step: schedule a follow-up or answer a quick question.
- If not interested, thank them and close politely.
${offer ? `- Current Offer: ${offer}` : `- If no offer is provided, do not invent one.`}
- Use the Emergency Rule if the caller mentions a hazard.
`.trim(),
      },

      operations: {
        begin: `Operations for ${biz_name}, this is ${agent_name}. How can I help you today?`,
        tone: "Confident, organized, and leadership-level.",
        body: `
## CORE ROLE: FULL STAFF OPERATIONS (MULTI-SKILL)
You can perform Reception, Intake, Scheduling, Lead Revival, and Emergency Dispatch.

### How to operate:
1) First, identify intent: scheduling, new intake, emergency, or follow-up.
2) Then, switch to the matching skill and proceed.
3) Never guess missing policies/pricing—ask clarifying questions or take a message for callback.
4) Always apply the Emergency Rule when there is a hazard.
`.trim(),
      },
    };

    const roleConfig = ROLE_PROMPTS[role] || ROLE_PROMPTS.receptionist;

    // --- BUSINESS CONTEXT (OPTIONAL ENRICHMENT) ---
    const websiteContext = website
      ? `Website provided: ${website}. If asked about services, prefer what is on the website. If you are unsure, ask clarifying questions instead of guessing.`
      : `No website provided. Do not invent services. Ask clarifying questions and capture details for a callback when needed.`;

    const contextLines = [
      biz_name ? `Business name: ${biz_name}` : "",
      business_hours ? `Business hours: ${business_hours}` : "",
      services ? `Primary services / business type: ${services}` : "",
      extra_info ? `Extra notes: ${extra_info}` : "",
      urgent_instructions ? `Urgent instructions: ${urgent_instructions}` : "",
      emergencySecondary ? `Secondary emergency phone (digits): ${emergencySecondary}` : "",
    ].filter(Boolean);

    // --- EMERGENCY RULE (GLOBAL) ---
    const EMERGENCY_RULE = `
## EMERGENCY RULE (ALWAYS ACTIVE)
If the caller mentions a hazard, immediate danger, or a dangerous situation:
- Tell them to mark off the area and keep people away.
- Collect location/address and callback number.
- Provide the emergency contact: ${speech_emergency}.
- Do not provide legal/safety guarantees; prioritize calm instructions and escalation.
`.trim();

    // --- BASE RULES (STABLE SYSTEM BEHAVIOR) ---
    const BASE_RULES = `
## BASE RULES
- Do NOT mention you are an AI.
- Be concise: 1–2 sentences per turn when possible.
- Ask up to 2 clarifying questions if needed.
- Never invent pricing, guarantees, or policies.
- If information is missing or the form data looks wrong, default to: gather details + promise a callback.
- No symbols: say "dollars" instead of "$".
- Close with: "Thank you for calling. Someone will reach out soon."
`.trim();

    // --- FINAL PROMPT ASSEMBLY (ONE PLACE ONLY) ---
    const FINAL_PROMPT = `
## IDENTITY
You are ${agent_name}, a professional representative for ${biz_name}.
Role: ${role.toUpperCase()}.
Template ID: ${templateId || "none"}.

## BUSINESS CONTEXT
${websiteContext}
${contextLines.length ? `\n${contextLines.join("\n")}` : ""}

${roleConfig.body}

${EMERGENCY_RULE}

${BASE_RULES}
`.trim();

    const prompt_hash = sha256(FINAL_PROMPT);

    // --- CREATE RETELL LLM ---
    const llmResp = await axios.post(
      "https://api.retellai.com/create-retell-llm",
      {
        general_prompt: FINAL_PROMPT,
        begin_message: roleConfig.begin,
        model: "gpt-4o-mini",
      },
      { headers }
    );

    // --- CREATE AGENT ---
    const agentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        agent_name: `${biz_name} - ${agent_name}`,
        voice_id: resolveVoiceId(body),
        response_engine: { type: "retell-llm", llm_id: llmResp.data.llm_id },
        metadata: {
          business_name: biz_name,
          agent_role: role,
          agent_template_id: templateId || "",
          notification_email: client_email,
          prompt_hash,
        },
      },
      { headers }
    );

    // --- DEBUG RETURN (keep for now; remove later) ---
    return res.status(200).json({
      ok: true,
      agent_id: agentResp.data.agent_id,
      debug: {
        resolved_role: role,
        templateId,
        voice_id: resolveVoiceId(body),
        prompt_hash,
        has_website: Boolean(website),
        has_calendar_link: Boolean(calendar_link),
      },
    });
  } catch (error) {
    const status = error?.statusCode || 500;
    return res.status(status).json({
      error: status === 400 ? String(error.message) : "Server error",
      debug: error?.debug || undefined,
    });
  }
};
