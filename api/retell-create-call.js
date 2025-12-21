const axios = require("axios");

// --- STABLE HELPERS ---
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

// --- MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  
  try {
    const body = await readJsonBody(req);
    const RETELL_API_KEY = process.env.RETELL_API_KEY;

    // API Key Guard
    if (!RETELL_API_KEY) {
      console.error("CRITICAL: RETELL_API_KEY is missing from Vercel Env Vars");
      return res.status(500).json({ error: "Server Configuration Error" });
    }

    const headers = { Authorization: `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" };

    // 1. DATA EXTRACTION
    const biz_name = body.business_name || "New Client";
    const biz_info = body.extra_info || "A professional service provider.";
    const isDryRun = String(body.is_test_mode).toLowerCase() === "true";

    // 2. CREATE UNIQUE LLM (The Brain)
    // Hardcoding biz_name here means we don't need a webhook to "fetch" it later
    const llmResp = await axios.post(
      "https://api.retellai.com/create-retell-llm",
      {
        general_prompt: `You are a professional AI receptionist for ${biz_name}. Your background info: ${biz_info}. If you don't know a caller's name, refer to them as 'valued guest'.`,
        begin_message: `Hi! Thanks for calling ${biz_name}. How can I help you?`,
        model: "gpt-4o-mini",
      },
      { headers, timeout: 8000 }
    );
    const llm_id = llmResp.data.llm_id;

    // 3. CREATE AGENT (The Body)
    const agentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        agent_name: `${biz_name} - Personalized Agent`,
        voice_id: body.voice_id || process.env.DEFAULT_VOICE_ID,
        response_engine: { type: "retell-llm", llm_id: llm_id }
      },
      { headers, timeout: 8000 }
    );
    const agent_id = agentResp.data.agent_id;
    // Capture version to ensure number binding works
    const agent_version = agentResp.data.agent_version ?? 0; 

    // 4. STOP IF TEST MODE
    if (isDryRun) {
      return res.status(200).json({ ok: true, agent_id, llm_id, message: "Test Successful: No number purchased." });
    }

    // 5. LIVE PURCHASE
    const numberResp = await axios.post(
      "https://api.retellai.com/create-phone-number",
      {
        inbound_agent_id: agent_id,
        inbound_agent_version: agent_version, // Critical version parameter
        nickname: `${biz_name} Main Line`
      },
      { headers, timeout: 8000 }
    );

    return res.status(200).json({
      ok: true,
      agent_id,
      phone_number: numberResp.data.phone_number
    });

  } catch (error) {
    console.error("PROVISIONING FAILED:", error.response?.data || error.message);
    return res.status(500).json({ error: "Provisioning Failed", details: error.message });
  }
};
