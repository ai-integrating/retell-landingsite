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
  const templateId = String(templateIdRaw || "").toLowerCase().trim();

  const fromTemplate = TEMPLATE_ROLE_MAP[templateId];

  const fromRoleField = String(pick(body, ["agent_role", "role"], "receptionist"))
    .toLowerCase()
    .trim();

  const resolved = fromTemplate || fromRoleField || "receptionist";

  if (!ALLOWED_ROLES.has(resolved)) {
    const err = new Error(
      `Invalid role "${resolved}". Allowed roles: ${Array.from(ALLOWED_ROLES).join(", ")}`
    );
    err.statusCode = 400;
    err.debug = { templateId, fromTemplate, fromRoleField };
    throw err;
  }

  return { role: resolved, templateId };
}

// --- 4. HELPERS ---
function normalizeWebsite(url) {
  const u = String(url || "").trim();
  if (!u || u === "Not provided") return "";
  return u;
}

function safePhoneDigits(input) {
  const digits = String(input || "").replace(/[^\d]/g, "").trim();
  return digits || "";
}

function speakPhone(phoneDigits) {
  if (!phoneDigits) return "";
  return phoneDigits.split("").join("-");
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function toYesNo(val) {
  const s = String(val || "").trim().toLowerCase();
  if (!s || s === "not provided") return "";
  if (["yes", "y", "true"].includes(s)) return "Yes";
  if (["no", "n", "false"].includes(s)) return "No";
  return String(val).trim();
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

    // Scheduler fields (from your screenshot)
    const time_zone = String(pick(body, ["time_zone", "timezone"], "")).trim();
    const calendar_system = String(pick(body, ["calendar_system"], "")).trim();
    const calendar_link = String(pick(body, ["calendar_link", "booking_link"], "")).trim();

    const after_hours_rules = toYesNo(pick(body, ["after_hours_rules"], ""));
    const buffer_time = String(pick(body, ["buffer_time"], "")).trim(); // e.g. "10 minutes"
    const same_day_appointment_rules = toYesNo(pick(body, ["same_day_appointment_rules"], ""));
    const weekend_appointments = toYesNo(pick(body, ["weekend_appointments"], ""));
    const service_durations = String(pick(body, ["service_durations"], "")).trim();

    // Emergency fields (CLIENT-SPECIFIC ONLY)
    const emergencyPrimary = safePhoneDigits(pick(body, ["emergency_phone", "primary_emergency_phone"], ""));
    const emergencySecondary = safePhoneDigits(pick(body, ["emergency_secondary_phone"], ""));
    const urgent_instructions = String(pick(body, ["urgent_instructions"], "")).trim();

    const hasClientEmergencyNumber = Boolean(emergencyPrimary);
    const speech_emergency = hasClientEmergencyNumber ? speakPhone(emergencyPrimary) : "";

    // --- BUSINESS CONTEXT ---
    const websiteContext = website
      ? `Website provided: ${website}. If asked about services, prefer what is on the website. If you are unsure, ask clarifying questions instead of guessing.`
      : `No website provided. Do not invent services. Ask clarifying questions and capture details for a callback when needed.`;

    const contextLines = [
      biz_name ? `Business name: ${biz_name}` : "",
      business_hours ? `Business hours: ${business_hours}` : "",
      services ? `Primary services / business type: ${services}` : "",
      extra_info ? `Extra notes: ${extra_info}` : "",
      time_zone ? `Business time zone: ${time_zone}` : "",
      calendar_system ? `Calendar system: ${calendar_system}` : "",
      urgent_instructions ? `Urgent instructions: ${urgent_instructions}` : "",
      emergencySecondary ? `Secondary emergency phone (digits): ${emergencySecondary}` : "",
    ].filter(Boolean);

    // --- CONDITIONAL EMERGENCY RULE ---
    // Include ONLY if (a) role is emergency_dispatch OR (b) the client provided emergency_phone
    const EMERGENCY_RULE = (role === "emergency_dispatch" || hasClientEmergencyNumber)
      ? `
## EMERGENCY RULE (ONLY WHEN NEEDED)
If the caller reports immediate danger, injury, fire, active hazard, or a truly urgent situation:
- Stay calm and ask for the location/address first.
- Tell them to follow safety guidance and contact local emergency services if appropriate.
- Collect name and callback number.
${hasClientEmergencyNumber ? `- Provide the business emergency contact: ${speech_emergency}.` : `- No business emergency number is on file. Take details and escalate immediately.`}
- Do not guess or reassure beyond what you know; escalate.
`.trim()
      : ""; // IMPORTANT: completely removed for normal clients

    // --- ROLE CAPSULES (LOCKED) ---
    const offer = String(pick(body, ["lead_revival_offer", "revival_offer"], "")).trim();

    const schedulerDetails = [
      calendar_link ? `Booking link: ${calendar_link}` : `Booking link: (not provided — you must take details for manual scheduling)`,
      buffer_time ? `Buffer time between appointments: ${buffer_time}` : "",
      same_day_appointment_rules ? `Same-day appointments allowed: ${same_day_appointment_rules}` : "",
      weekend_appointments ? `Weekend appointments allowed: ${weekend_appointments}` : "",
      after_hours_rules ? `After-hours booking allowed: ${after_hours_rules}` : "",
      service_durations ? `Service durations: ${service_durations}` : "",
      time_zone ? `Time zone: ${time_zone}` : "",
      calendar_system ? `Calendar system: ${calendar_system}` : "",
    ].filter(Boolean).join("\n- ");

    const ROLE_PROMPTS = {
      receptionist: {
        begin: `Thanks for calling ${biz_name}, this is ${agent_name}. How can I help you today?`,
        tone: "Warm, professional, and efficient.",
        body: `
## CORE ROLE: RECEPTIONIST
- Greet callers and identify whether they are a new or returning customer.
- Collect: caller name, best callback number, address/town, and a short description of what they need.
- Do not guess pricing, timelines, or guarantees.
- If unsure, ask 1–2 focused questions, then take a message for callback.
`.trim(),
      },

      intake: {
        begin: `Thanks for calling ${biz_name}, this is ${agent_name}. What can I help you with today?`,
        tone: "Warm, calm, and organized.",
        body: `
## CORE ROLE: INTAKE SPECIALIST
- Gather complete details and route to the right next step.
- Collect: name, callback, address/town, service needed, and urgency.
- If the caller requests an estimate, capture details and preferred day/time window.
- If you cannot schedule directly, take a message and promise a callback.
`.trim(),
      },

      scheduler: {
        begin: `Thanks for calling ${biz_name}, this is ${agent_name}. Are you looking to schedule an appointment?`,
        tone: "Friendly, efficient, and confident.",
        body: `
## CORE ROLE: SCHEDULER
- Your job is to schedule appointments OR collect details for manual scheduling.
- Apply these scheduling rules exactly:

- ${schedulerDetails}

### Scheduling flow:
1) Identify what service they want.
2) Confirm preferred day/time window (and time zone if needed).
3) If a booking link exists, guide them through booking OR confirm you will book it for them (depending on your workflow).
4) If no booking link exists, collect details and say: "I’ll have the office reach out to confirm the next available time."
5) Confirm constraints (same-day, weekend, after-hours, buffer time) BEFORE promising a slot.
`.trim(),
      },

      emergency_dispatch: {
        begin: `Emergency dispatch for ${biz_name}. This is ${agent_name}. What is the situation?`,
        tone: "Calm, authoritative, urgent.",
        body: `
## CORE ROLE: EMERGENCY DISPATCH
- Quickly assess immediate danger.
- Collect: location/address, what happened, whether anyone is injured, and best callback number.
- Escalate immediately to the business emergency contact if provided.
`.trim(),
      },

      lead_revival: {
        begin: `Hi, this is ${agent_name} from ${biz_name}. I'm following up on your recent quote—do you have a quick minute?`,
        tone: "Calm, friendly, never pushy.",
        body: `
## CORE ROLE: LEAD REVIVAL
- Confirm they received the quote and ask where they are in the decision process.
- Ask if scope/timing changed.
- Offer next steps (schedule follow-up or answer a quick question).
- If not interested, thank them and close politely.
${offer ? `- Current Offer: ${offer}` : `- If no offer is provided, do not invent one.`}
`.trim(),
      },

      operations: {
        begin: `Operations for ${biz_name}, this is ${agent_name}. How can I help you today?`,
        tone: "Confident, organized, leadership-level.",
        body: `
## CORE ROLE: FULL STAFF OPERATIONS (MULTI-SKILL)
You can perform Reception, Intake, Scheduling, Lead Revival, and Emergency Dispatch.

### How to operate:
1) Identify intent (scheduling, new intake, emergency, follow-up).
2) Switch to the matching skill and proceed.
3) Never guess missing pricing/policies; ask or take a message for callback.
`.trim(),
      },
    };

    const roleConfig = ROLE_PROMPTS[role] || ROLE_PROMPTS.receptionist;

    // --- BASE RULES (STABLE) ---
    const BASE_RULES = `
## BASE RULES
- Do NOT mention you are an AI.
- Be concise: 1–2 sentences per turn when possible.
- Ask up to 2 clarifying questions if needed.
- Never invent pricing, guarantees, or policies.
- If info is missing or form data looks wrong: gather details + promise a callback.
- No symbols: say "dollars" instead of "$".
- Close with: "Thank you for calling. Someone will reach out soon."
`.trim();

    // --- FINAL PROMPT ---
    const FINAL_PROMPT = `
## IDENTITY
You are ${agent_name}, a professional representative for ${biz_name}.
Role: ${role.toUpperCase()}.
Template ID: ${templateId || "none"}.

## BUSINESS CONTEXT
${websiteContext}
${contextLines.length ? `\n${contextLines.join("\n")}` : ""}

${roleConfig.body}

${EMERGENCY_RULE ? `\n${EMERGENCY_RULE}\n` : ""}

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

    return res.status(200).json({
      ok: true,
      agent_id: agentResp.data.agent_id,
      debug: {
        resolved_role: role,
        templateId,
        prompt_hash,
        has_website: Boolean(website),
        has_calendar_link: Boolean(calendar_link),
        has_client_emergency_number: hasClientEmergencyNumber,
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
