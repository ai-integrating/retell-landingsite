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
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return fallback;
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  try {
    const body = await readJsonBody(req);
    const RETELL_API_KEY = process.env.RETELL_API_KEY;
    const headers = { Authorization: `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" };

    // 1. EXTRACT PERSONALIZED DATA
    const business_name = pick(body, ["business_name"], "New Client");
    const person_name = pick(body, ["name"], "Lead");
    const isDryRun = String(pick(body, ["is_test_mode", "Is_Test_mode"], "false")).toLowerCase() === "true";

    const dynamic_variables = {
      business_name,
      name: person_name,
      website: pick(body, ["website"], ""),
      extra_info: pick(body, ["extra_info"], "N/A"),
      services: pick(body, ["services"], "AI Receptionist")
    };

    // 2. STEP 1: CREATE A PERSONALIZED LLM (The Brain)
    const llmResp = await axios.post(
      "https://api.retellai.com/create-retell-llm",
      {
        general_prompt: `You are a professional AI receptionist for ${business_name}. Your goal is to assist callers using the following context: {{extra_info}}. Current caller is {{name}}.`,
        begin_message: `Hi there! Thanks for calling ${business_name}. How can I help you today?`,
        // Required for LLM agents to recognize your Zapier keys
        retell_llm_dynamic_variables: [
          { name: "business_name", type: "string" },
          { name: "name", type: "string" },
          { name: "extra_info", type: "string" }
        ],
        model: "gpt-4.1-mini",
        start_speaker: "agent"
      },
      { headers, timeout: 10000 }
    );
    const llm_id = llmResp.data?.llm_id;

    // 3. STEP 2: CREATE THE AGENT (The Body)
    const createAgentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        agent_name: `${business_name} - Personalized Agent`,
        voice_id: pick(body, ["voice_id"], process.env.DEFAULT_VOICE_ID),
        response_engine: {
          type: "retell-llm",
          llm_id: llm_id
        }
      },
      { headers, timeout: 10000 }
    );
    const agent_id = createAgentResp.data?.agent_id;

    if (isDryRun) {
      return res.status(200).json({ ok: true, test_mode: true, agent_id, llm_id });
    }

    // 4. STEP 3: BUY NUMBER & LINK WEBHOOK
    const numberResp = await axios.post(
      "https://api.retellai.com/create-phone-number",
      {
        inbound_agent_id: agent_id,
        nickname: `${business_name} Main Line`,
        // Point this to your Endpoint B URL
        inbound_webhook_url: "https://your-project.vercel.app/api/retell-inbound-vars"
      },
      { headers, timeout: 10000 }
    );

    return res.status(200).json({
      ok: true,
      agent_id,
      llm_id,
      phone_number: numberResp.data?.phone_number,
      variables_injected: dynamic_variables
    });

  } catch (error) {
    return res.status(500).json({ error: "Failed", details: error.response?.data || error.message });
  }
};
