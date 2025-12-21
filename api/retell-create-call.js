const axios = require("axios");

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

function pick(obj, keys, fallback = "") {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return String(obj[k]);
  }
  return String(fallback);
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  try {
    const body = await readJsonBody(req);
    const RETELL_API_KEY = process.env.RETELL_API_KEY;
    if (!RETELL_API_KEY) return res.status(500).json({ error: "Missing RETELL_API_KEY" });

    const headers = {
      Authorization: `Bearer ${RETELL_API_KEY}`,
      "Content-Type": "application/json",
    };

    // ---- 1. Client data extraction ----
    const biz_name = pick(body, ["business_name", "businessName"], "New Client");
    const website = pick(body, ["website"], "Not provided");
    const business_hours = pick(body, ["business_hours"], "Not provided");
    const services = pick(body, ["services"], "Not provided");
    const extra_info = pick(body, ["extra_info"], "None provided");
    const package_type = pick(body, ["package_type", "agent_role"], "Receptionist");
    const voice_id = pick(body, ["voice_id", "voiceId"], process.env.DEFAULT_VOICE_ID);

    // ---- 2. MASTER prompt (Behavioral instructions) ----
    const MASTER_PROMPT = `
You are a professional AI receptionist.
STYLE: Warm, calm, concise, human. Do not mention you are an AI.
GOAL: ${package_type === 'full_staff' ? 'Handle full intake and scheduling.' : 'Take a detailed message only.'}
INTAKE: Caller name, callback number, and what they need help with.
CLOSING: Summarize the intake and confirm someone will call back.`.trim();

    // ---- 3. Business Profile (Baked-in data) ----
    const BUSINESS_PROFILE = `
BUSINESS PROFILE (Source of Truth)
- Business Name: ${biz_name}
- Website: ${website}
- Business Hours: ${business_hours}
- Services: ${services}
- Additional Notes: ${extra_info}`.trim();

    const FINAL_PROMPT = `${MASTER_PROMPT}\n\n${BUSINESS_PROFILE}`;

    // ---- 4. Create LLM (The Brain) ----
    const llmResp = await axios.post(
      "https://api.retellai.com/create-retell-llm",
      {
        general_prompt: FINAL_PROMPT,
        begin_message: `Hi! Thanks for calling ${biz_name}. How can I help you today?`,
        model: "gpt-4o-mini",
      },
      { headers, timeout: 15000 }
    );

    const llm_id = llmResp.data?.llm_id;
    if (!llm_id) return res.status(500).json({ error: "No llm_id returned" });

    // ---- 5. Create Agent (The Body) ----
    const agentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        agent_name: `${biz_name} - ${package_type}`, 
        voice_id,
        response_engine: { type: "retell-llm", llm_id },
      },
      { headers, timeout: 15000 }
    );

    const agent_id = agentResp.data?.agent_id;

    // ---- 6. Final Return (Successfully stopped before number purchase) ----
    return res.status(200).json({
      ok: true,
      message: "Agent and LLM created successfully. No phone number purchased.",
      agent_id,
      llm_id,
      agent_name: `${biz_name} - ${package_type}`
    });

  } catch (error) {
    return res.status(500).json({ error: "Provisioning Failed", details: error?.response?.data || error?.message });
  }
};
