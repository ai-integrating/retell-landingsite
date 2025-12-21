// /api/retell-create-call.js
const axios = require("axios");

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

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  try {
    const body = await readJsonBody(req);
    const RETELL_API_KEY = process.env.RETELL_API_KEY;

    if (!RETELL_API_KEY) return res.status(500).json({ error: "Missing RETELL_API_KEY." });

    // --- 1. CAPTURE DATA FROM ZAPIER ---
    const business_name = pick(body, ["business_name", "businessName"], "New Client");
    const voice_id = pick(body, ["voice_id", "voiceId"], null) || process.env.DEFAULT_VOICE_ID;
    
    // Safety flag
    const bodyTest = pick(body, ["is test mode", "is_test_mode", "dry_run"], false);
    const isDryRun = bodyTest === true || bodyTest === "true" || bodyTest === "yes";

    // Clean up variables for Retell
    const dynamic_variables = {
      business_name,
      name: pick(body, ["name"], "Lead"),
      website: pick(body, ["website"], ""),
      // Specifically grabbing that long JotForm question by its exact key name
      extra_info: pick(body, ["extra_info", "Areas And Business Information To Answer Calls More Accurately"], ""),
      agent_role: pick(body, ["agent_role"], "receptionist"),
      business_hours: pick(body, ["business_hours"], "Not Specified"),
      services: pick(body, ["services"], "Not Specified")
    };

    let response_engine = pick(body, ["response_engine", "responseEngine"], null);
    if (!response_engine && process.env.DEFAULT_RESPONSE_ENGINE_JSON) {
      response_engine = JSON.parse(process.env.DEFAULT_RESPONSE_ENGINE_JSON);
    }

    // --- 2. CREATE AGENT WITH INJECTED DATA ---
    const createAgentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        voice_id,
        // We pass variables here so they persist even without a call
        retell_llm_dynamic_variables: dynamic_variables, 
        response_engine: {
          ...response_engine,
          retell_llm_dynamic_variables: dynamic_variables 
        },
        metadata: { business_name, ...dynamic_variables },
      },
      {
        headers: { Authorization: `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" },
        timeout: 30000,
      }
    );

    const agent_id = createAgentResp.data?.agent_id;

    // --- 3. TEST MODE RETURN ---
    if (isDryRun) {
      return res.status(200).json({
        ok: true,
        is_test_mode: true,
        message: "SUCCESS: Agent created with variables.",
        business_name,
        agent_id,
        phone_number: "+15550000000",
        variables_sent: dynamic_variables // Look for this in Zapier Output!
      });
    }

    // --- 4. REAL PURCHASE (Only happens if test mode is false) ---
    // (Existing phone number purchase code goes here)

  } catch (error) {
    const details = error?.response?.data || error?.message || "Unknown error";
    return res.status(500).json({ error: "Failed to provision", details });
  }
};
