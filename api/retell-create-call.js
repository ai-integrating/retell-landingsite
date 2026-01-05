const axios = require("axios");

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
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

const decodeHtml = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");

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

  const tone = String(pick(body, ["voice_tone", "voiceTone", "tone"], "warm")).toLowerCase().trim();
  const gender = String(pick(body, ["agent_gender", "agentGender", "gender"], "female")).toLowerCase().trim();

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

// --- 3. DYNAMIC CONTENT HELPERS ---
function buildLeadRevivalModule(body) {
  const offer = pick(body, ["lead_revival_offer", "revival_offer"]);
  return offer === "Not provided" ? "Active follow-up on recent quotes." : `Current Offer: ${offer}`;
}

// --- 4. MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  
  try {
    const body = await readJsonBody(req);
    const headers = { Authorization: `Bearer ${process.env.RETELL_API_KEY}`, "Content-Type": "application/json" };

    // --- STRIPE/ZAPIER MAPPED DATA ---
    const biz_name = pick(body, ["business_name", "company"], "McDuffy and Son Asphalt");
    const agent_name = pick(body, ["agent_name"], "Samuel");
    const role = pick(body, ["agent_role"], "receptionist").toLowerCase();
    const client_email = pick(body, ["email", "user_email"], "not-provided@example.com");

    const raw_emergency = pick(body, ["emergency_phone"], "5082910787");
    const speech_emergency = raw_emergency.split('').join('-');
    const calendar_link = pick(body, ["calendar_link"]);

    // --- MODULE BLOCKS ---
    const modules = {
      reception: `## CORE SKILL: FRONT DESK & INTAKE\n- Greet callers warmly. For new customers, capture Name, Phone, and Service Address.`,
      dispatch: `## PRIMARY SKILL: EMERGENCY DISPATCH\n- Triage: Ask about the hazard nature and traffic safety.\n- Critical: Instruct to "mark off the area" and alert supervisor immediately.\n- Contact: ${speech_emergency}.`,
      revival: `## PRIMARY SKILL: LEAD REVIVAL\n- Follow-up: Ask about their project status.\n- Offer: ${buildLeadRevivalModule(body)}.`,
      scheduler: `## PRIMARY SKILL: SCHEDULING\n- Booking: Use the link ${calendar_link} to schedule appointments.`,
      safety_net: `## EMERGENCY SAFETY NET\n- If a caller mentions a hazard, tell them to "mark off the area" and provide the emergency contact: ${speech_emergency}.`
    };

    // --- ROLE LOGIC SELECTION ---
    let prompt_body = "";
    let begin_msg = "";
    let tone_instruction = "Warm and professional.";

    switch(role) {
      case 'emergency_dispatch':
        prompt_body = `${modules.dispatch}\n\n${modules.reception}`;
        begin_msg = `Emergency Dispatch for ${biz_name}, this is ${agent_name}. What is the nature of your emergency?`;
        tone_instruction = "Calm, authoritative, and urgent.";
        break;
      case 'lead_revival':
        prompt_body = `${modules.revival}\n\n${modules.reception}\n\n${modules.safety_net}`;
        begin_msg = `Hi, this is ${agent_name} from ${biz_name}. I'm following up on your recent asphalt quote. How are you today?`;
        break;
      case 'scheduler':
        prompt_body = `${modules.scheduler}\n\n${modules.reception}\n\n${modules.safety_net}`;
        begin_msg = `Thanks for calling ${biz_name}, this is ${agent_name}. Are you looking to schedule an estimate today?`;
        break;
      case 'operations':
        prompt_body = `## ROLE: OPERATIONS DIRECTOR\nManage all aspects of the business.\n\n${modules.dispatch}\n\n${modules.scheduler}\n\n${modules.revival}\n\n${modules.reception}`;
        begin_msg = `Operations for ${biz_name}, this is ${agent_name}. How can I help you?`;
        break;
      default: // Mia (Intake) or Allie/Marcus (Receptionist)
        prompt_body = `${modules.reception}\n\n${modules.safety_net}`;
        begin_msg = `Thanks for calling ${biz_name}, this is ${agent_name}. How can I help you?`;
    }

    const FINAL_PROMPT = `
## IDENTITY
- You are ${agent_name}, a professional representative for ${biz_name}.
- Role: ${role.replace('_', ' ')}.
- Rule: Do NOT mention you are an AI.

## BUSINESS KNOWLEDGE
- Website Context: Rely on industry standards for ${biz_name}.

${prompt_body}

## CALL RULES
1. Tone: ${tone_instruction}
2. Be Brief: 1-2 sentences max.
3. No Symbols: Say "dollars" instead of "$".
4. Closing: "Thank you for calling. Someone will reach out soon."
`.trim();

    const llmResp = await axios.post("https://api.retellai.com/create-retell-llm", {
      general_prompt: FINAL_PROMPT,
      begin_message: begin_msg,
      model: "gpt-4o-mini",
    }, { headers });

    const agentResp = await axios.post("https://api.retellai.com/create-agent", {
      agent_name: `${biz_name} - ${agent_name}`,
      voice_id: resolveVoiceId(body),
      response_engine: { type: "retell-llm", llm_id: llmResp.data.llm_id },
      metadata: { business_name: biz_name, agent_role: role, notification_email: client_email }
    }, { headers });

    return res.status(200).json({ ok: true, agent_id: agentResp.data.agent_id });
  } catch (error) { return res.status(500).json({ error: "Server error" }); }
};
