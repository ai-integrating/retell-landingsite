const axios = require("axios");

// --- HELPER FUNCTIONS (DO NOT REMOVE) ---
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (req.body && typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

function pick(obj, keys, fallback = undefined) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return fallback;
}

// --- MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  try {
    const body = await readJsonBody(req);
    const RETELL_API_KEY = process.env.RETELL_API_KEY;

    if (!RETELL_API_KEY) return res.status(500).json({ error: "Missing RETELL_API_KEY env var." });

    // 1. EXTRACT DATA FROM ZAPIER
    const business_name = pick(body, ["business_name", "businessName"], "New Client");
    const voice_id = pick(body, ["voice_id", "voiceId"], null) || process.env.DEFAULT_VOICE_ID;
    
    // Safety check for your Zapier key "Is_Test_mode"
    const bodyTest = pick(body, ["Is_Test_mode", "is test mode", "dry_run"], false);
    const isDryRun = bodyTest === true || bodyTest === "true" || bodyTest === "yes";

    // Bundle variables for Retell
    const dynamic_variables = {
      business_name,
      name: pick(body, ["name"], "Lead"),
      website: pick(body, ["website"], ""),
      extra_info: pick(body, ["extra_info", "Areas And Business Information To Answer Calls More Accurately"], ""),
      business_hours: pick(body, ["business_hours"], "Not Specified"),
      services: pick(body, ["services"], "Not Specified")
    };

    // 2. CREATE RETELL AGENT
    const createAgentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        voice_id,
        // Injected here so variables are present during tests
        retell_llm_dynamic_variables: dynamic_variables, 
        response_engine: {
          ...(JSON.parse(process.env.DEFAULT_RESPONSE_ENGINE_JSON || '{}')),
          retell_llm_dynamic_variables: dynamic_variables 
        }
      },
      {
        headers: { Authorization: `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" },
        timeout: 15000,
      }
    );

    const agent_id = createAgentResp.data?.agent_id;

    // 3. TEST MODE RETURN (Stops the 504 Timeout)
    if (isDryRun) {
      return res.status(200).json({
        ok: true,
        is_test_mode: true,
        message: "SUCCESS: Agent created with variables.",
        agent_id,
        variables_sent: dynamic_variables
      });
    }

    // 4. REAL PURCHASE (Only happens if Is_Test_mode is NOT true)
    // ... logic for create-phone-number would follow here ...

  } catch (error) {
    const details = error?.response?.data || error?.message || "Unknown error";
    return res.status(500).json({ error: "Failed to provision", details });
  }
};
