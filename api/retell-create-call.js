const axios = require("axios");

// --- HELPERS (Keep for stability) ---
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
    const isDryRun = String(pick(body, ["is_test_mode", "Is_Test_mode", "dry_run"], "false")).toLowerCase() === "true";

    const dynamic_variables = {
      business_name,
      name: pick(body, ["name"], "Lead"),
      extra_info: pick(body, ["extra_info"], "N/A"),
      services: pick(body, ["services"], "AI Services")
    };

    // 2. CREATE PERSONALIZED AGENT
    const createAgentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        agent_name: `${business_name} - Personalized Agent`,
        voice_id: pick(body, ["voice_id"], process.env.DEFAULT_VOICE_ID),
        // This makes the variables available to be fetched later
        response_engine: JSON.parse(process.env.DEFAULT_RESPONSE_ENGINE_JSON || "{}"),
        metadata: { ...dynamic_variables } 
      },
      { headers, timeout: 10000 }
    );
    const agent_id = createAgentResp.data?.agent_id;

    // --- STOP HERE IF TEST MODE ---
    if (isDryRun) {
      return res.status(200).json({
        ok: true,
        message: "TEST MODE: Agent created, no number purchased.",
        agent_id,
        variables_received: dynamic_variables
      });
    }

    // 3. LIVE PURCHASE (Only runs if isDryRun is false)
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
      agent_id,
      phone_number: numberResp.data?.phone_number,
      status: "Live provisioning complete"
    });

  } catch (error) {
    return res.status(500).json({ error: "Failed", details: error.response?.data || error.message });
  }
};
