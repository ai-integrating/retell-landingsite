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
      } catch {
        resolve({});
      }
    });
  });
}

function pick(obj, keys, fallback = "Not provided") {
  for (const k of keys) {
    let val = obj?.[k];
    if (val !== undefined && val !== null && val !== "") {
      return val;
    }
  }
  return fallback;
}

// --- 2. VOICE RESOLUTION ---
function resolveVoiceId(body) {
  const tone = String(pick(body, ["voice_tone", "tone"], "warm")).toLowerCase().trim();
  const gender = String(pick(body, ["agent_gender", "gender"], "female")).toLowerCase().trim();

  const VOICE_MAP = {
    female_authoritative: process.env.VOICE_FEMALE_AUTHORITATIVE,
    female_warm: process.env.VOICE_FEMALE_WARM,
    female_calm: process.env.VOICE_FEMALE_CALM,
    female_energetic: process.env.VOICE_FEMALE_ENERGETIC,
    male_authoritative: process.env.VOICE_MALE_AUTHORITATIVE,
    male_warm: process.env.VOICE_MALE_WARM,
    male_calm: process.env.VOICE_MALE_CALM,
  };

  return VOICE_MAP[`${gender}_${tone}`] || process.env.DEFAULT_VOICE_ID;
}

// --- 3. MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const body = await readJsonBody(req);
    const headers = { 
        Authorization: `Bearer ${process.env.RETELL_API_KEY}`, 
        "Content-Type": "application/json" 
    };

    const biz_name = pick(body, ["business_name", "company"], "our client");
    const agent_name = pick(body, ["agent_name", "name"], "Ava");
    
    // RESOLVE ROLE FOR LABELING
    const resolved_role = String(pick(body, ["agent_role", "role"], "operations")).toLowerCase().trim();
    const roleLabelMap = {
      operations: "Operations Manager",
      receptionist: "Receptionist",
      intake: "Intake Specialist",
      scheduler: "Scheduler",
      emergency_dispatch: "Emergency Dispatcher",
      lead_revival: "Lead Revival Specialist",
    };
    const roleLabel = roleLabelMap[resolved_role] || "Operations Manager";

    // --- THE MASTER LOGIC GATE ---
    // If 'instructions' exists in the Webhook, use it. Otherwise, use a simple fallback.
    const customInstructions = pick(body, ["instructions", "agent_instructions"], null);
    
    const FINAL_PROMPT = (customInstructions && customInstructions !== "Not provided") 
      ? customInstructions 
      : `You are ${agent_name}, the ${roleLabel} for ${biz_name}. Handle calls professionally and take messages.`;

    // 1. Create Retell LLM (The Brain)
    const llmResp = await axios.post(
      "https://api.retellai.com/create-retell-llm",
      {
        general_prompt: FINAL_PROMPT,
        begin_message: `Thank you for calling ${biz_name}, this is ${agent_name}. How can I help you?`,
        model: "gpt-4o-mini",
      },
      { headers }
    );

    // 2. Create Retell Agent (The Voice & Identity)
    const agentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        agent_name: `${biz_name} - ${roleLabel}`,
        voice_id: resolveVoiceId(body),
        response_engine: { type: "retell-llm", llm_id: llmResp.data.llm_id },
      },
      { headers }
    );

    return res.status(200).json({ ok: true, agent_id: agentResp.data.agent_id });
  } catch (error) {
    console.error("CRITICAL ERROR:", error?.response?.data || error.message);
    return res.status(500).json({ error: "Server error", details: error.message });
  }
};
