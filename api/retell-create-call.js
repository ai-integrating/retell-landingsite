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

function pick(obj, keys, fallback = "") {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return String(obj[k]);
  }
  return String(fallback);
}

// --- MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  try {
    const body = await readJsonBody(req);
    const RETELL_API_KEY = process.env.RETELL_API_KEY;
    const headers = { Authorization: `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" };

    // 1. EXTRACT DATA FOR PERSONALIZATION
    const biz_name = pick(body, ["business_name"], "New Client");
    const lead_name = pick(body, ["name"], "Lead");
    const isDryRun = pick(body, ["is_test_mode", "Is_Test_mode"], "false").toLowerCase() === "true";

    // 2. CREATE A UNIQUE LLM (The Personalized "Brain")
    const llmResp = await axios.post(
      "https://api.retellai.com/create-retell-llm",
      {
        // We "bake" the business name directly into the prompt here
        general_prompt: `You are a professional AI receptionist for ${biz_name}. Your context: {{extra_info}}. Caller: {{name}}.`,
        begin_message: `Hi! Thanks for calling ${biz_name}. How can I help you today?`,
        model: "gpt-4o-mini",
        // Define variables so they show up in the dashboard
        retell_llm_dynamic_variables: [
          { name: "name", type: "string" },
          { name: "extra_info", type: "string" }
        ]
      },
      { headers, timeout: 10000 }
    );
    const llm_id = llmResp.data?.llm_id;

    // 3. CREATE THE AGENT (The Personalized "Body")
    const createAgentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        agent_name: `${biz_name} - Personalized Agent`,
        voice_id: pick(body, ["voice_id"], process.env.DEFAULT_VOICE_ID),
        response_engine: {
          type: "retell-llm",
          llm_id: llm_id
        }
      },
      { headers, timeout: 10000 }
    );
    const agent_id = createAgentResp.data?.agent_id;

    // 4. SAFETY: STOP IF TEST MODE
    if (isDryRun) {
      return res.status(200).json({
        ok: true,
        message: "SUCCESS: Unique LLM and Agent created.",
        agent_id,
        llm_id,
        variables_received: { biz_name, lead_name }
      });
    }

    // 5. LIVE MODE: PURCHASE NUMBER
    const numberResp = await axios.post(
      "https://api.retellai.com/create-phone-number",
      {
        inbound_agent_id: agent_id,
        nickname: `${biz_name} Main Line`
      },
      { headers, timeout: 10000 }
    );

    return res.status(200).json({
      ok: true,
      agent_id,
      phone_number: numberResp.data?.phone_number
    });

  } catch (error) {
    return res.status(500).json({ error: "Failed", details: error.response?.data || error.message });
  }
};
