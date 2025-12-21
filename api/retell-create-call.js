const axios = require("axios");

// --- HELPERS (Keep these for stability) ---
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

    // 1. DATA EXTRACTION
    const business_name = pick(body, ["business_name", "businessName"], "New Client");
    const person_name = pick(body, ["name"], "Lead");
    
    const dynamic_variables = {
      business_name: business_name,
      name: person_name,
      website: pick(body, ["website"], ""),
      extra_info: pick(body, ["extra_info"], "No info"),
      services: pick(body, ["services"], "Receptionist")
    };

    // 2. CREATE PERSONALIZED AGENT
    const createAgentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        agent_name: `${business_name} - Personalized Agent`, // Sets the name in dashboard
        voice_id: pick(body, ["voice_id"], process.env.DEFAULT_VOICE_ID),
        // This injects the variables into the Agent's permanent knowledge
        retell_llm_dynamic_variables: dynamic_variables, 
        response_engine: {
          ...(JSON.parse(process.env.DEFAULT_RESPONSE_ENGINE_JSON || '{}')),
          retell_llm_dynamic_variables: dynamic_variables // Double-injection for safety
        }
      },
      { headers, timeout: 10000 }
    );

    const agent_id = createAgentResp.data?.agent_id;

    // 3. BUY NUMBER (Linked to this new agent)
    const numberResp = await axios.post(
      "https://api.retellai.com/create-phone-number",
      {
        inbound_agent_id: agent_id,
        nickname: `${business_name} Main Line`
      },
      { headers, timeout: 10000 }
    );

    return res.status(200).json({
      ok: true,
      agent_id: agent_id,
      agent_name: `${business_name} - Personalized Agent`,
      phone_number: numberResp.data?.phone_number,
      variables_injected: dynamic_variables
    });

  } catch (error) {
    return res.status(500).json({ error: "Failed", details: error.response?.data || error.message });
  }
};
