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
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch { resolve({}); }
    });
  });
}

const decodeHtml = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");

function pick(obj, keys, fallback = "Not provided") {
  for (const k of keys) {
    let val = obj?.[k];
    if (val !== undefined && val !== null && val !== "") {
      if (typeof val === "object" && val.output) return val.output;
      return val;
    }
  }
  return fallback;
}

function cleanValue(text, fallback = "Not provided") {
  const t = String(text || "").trim();
  if (!t || t === "[]" || t === "No data" || t === "/" || t === "null" || t.toLowerCase() === "not provided") return fallback;
  return t.replace(/\[\]/g, fallback);
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
    male_warm: process.env.VOICE_MALE_WARM,
    male_authoritative: process.env.VOICE_MALE_AUTHORITATIVE,
  };
  return VOICE_MAP[`${gender}_${tone}`] || process.env.DEFAULT_VOICE_ID;
}

// --- 3. URL & SCRAPER LOGIC ---
async function getWebsiteContext(url) {
  if (!url || url === "Not provided") return null;
  try {
    const response = await axios.get(url, { timeout: 4000, headers: { "User-Agent": "Mozilla/5.0" } });
    let text = String(response.data || "").replace(/<(script|style|header|nav|footer|form)[^>]*>([\s\S]*?)<\/\1>/gim, "").replace(/<[^>]*>?/gm, " ").replace(/\s+/g, " ").trim();
    return decodeHtml(text).substring(0, 3000);
  } catch (e) { return null; }
}

// --- 4. MAPPED FIELD BUILDERS ---
function buildSchedulingFromMapped(body) {
  const link = cleanValue(pick(body, ["calendar_link", "calendarLink"]));
  return link === "Not provided" ? "Scheduling is NOT enabled. Take a message." : `Calendar Link: ${link}`;
}

function buildLeadRevivalFromMapped(body) {
  const offer = cleanValue(pick(body, ["lead_revival_offer"]));
  return offer === "Not provided" ? "Proactive follow-up on recent quotes." : `Current Offer: ${offer}`;
}

// --- 5. MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  
  try {
    const body = await readJsonBody(req);
    const headers = { Authorization: `Bearer ${process.env.RETELL_API_KEY}`, "Content-Type": "application/json" };

    // --- BASE DATA ---
    const biz_name = pick(body, ["business_name", "company"], "the business");
    const agent_name = pick(body, ["agent_name", "name"], "Ava");
    const client_email = pick(body, ["email", "user_email"], "not-provided@example.com");

    // --- SKILL UPGRADES (BOOLEANS) ---
    const hasEmergency = pick(body, ["upgrade_emergency"], "false").toLowerCase() === "true";
    const hasLeadRevival = pick(body, ["upgrade_lead_revival"], "false").toLowerCase() === "true";
    const hasScheduling = pick(body, ["upgrade_scheduling"], "false").toLowerCase() === "true";

    // --- DYNAMIC MODULES ---
    const emergency_phone = cleanValue(pick(body, ["emergency_phone"]), "5082910787").split('').join('-');
    const emergencyPrompt = hasEmergency ? `## EMERGENCY SKILL: ACTIVE. Triage safety issues immediately. Direct calls to ${emergency_phone}.` : `## EMERGENCY: INACTIVE. Tell safety emergencies to dial 911.`;
    
    const schedulingPrompt = hasScheduling ? `## SCHEDULING SKILL: ACTIVE. ${buildSchedulingFromMapped(body)}` : `## SCHEDULING: INACTIVE. Take a message for a callback.`;
    
    const leadRevivalPrompt = hasLeadRevival ? `## LEAD REVIVAL SKILL: ACTIVE. ${buildLeadRevivalFromMapped(body)}` : `## LEAD REVIVAL: INACTIVE. Do not mention discounts.`;

    // --- FINAL PROMPT ---
    const FINAL_PROMPT = `
## IDENTITY
- You are ${agent_name}, a professional front-desk representative for ${biz_name}.
- Personality: Warm, conversational, and highly efficient.
- Rule: Do NOT mention you are an AI.

## CORE SKILL: FRONT DESK & INTAKE
- Greet every caller warmly.
- For new inquiries: Capture Name, Phone, and Service Address.

${emergencyPrompt}
${schedulingPrompt}
${leadRevivalPrompt}

## CALL RULES
1. Be Brief: 1-2 sentences per response.
2. No Symbols: Say "dollars" instead of "$".
3. Closing: "Thank you for calling ${biz_name}. Someone will be in touch soon."
`.trim();

    const llmResp = await axios.post("https://api.retellai.com/create-retell-llm", {
      general_prompt: FINAL_PROMPT,
      begin_message: hasEmergency ? `Emergency Dispatch for ${biz_name}, this is ${agent_name}. How can I help?` : `Thanks for calling ${biz_name}, this is ${agent_name}. How can I help you?`,
      model: "gpt-4o-mini",
    }, { headers });

    const agentResp = await axios.post("https://api.retellai.com/create-agent", {
      agent_name: `${biz_name} - ${agent_name}`,
      voice_id: resolveVoiceId(body),
      response_engine: { type: "retell-llm", llm_id: llmResp.data.llm_id },
      metadata: { business_name: biz_name, notification_email: client_email, unlocked_skills: `Emergency:${hasEmergency}, LeadRevival:${hasLeadRevival}, Scheduling:${hasScheduling}` }
    }, { headers });

    return res.status(200).json({ ok: true, agent_id: agentResp.data.agent_id });
  } catch (error) { return res.status(500).json({ error: "Server error" }); }
};
