// /api/retell-create-call.js
const axios = require("axios");

// CORS and Body Reader helpers remain as before...

module.exports = async function handler(req, res) {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  try {
    const body = await readJsonBody(req);
    const RETELL_API_KEY = process.env.RETELL_API_KEY;

    // 1. CAPTURE DATA
    const business_name = pick(body, ["business_name", "businessName"], "New Client");
    const voice_id = pick(body, ["voice_id", "voiceId"], null) || process.env.DEFAULT_VOICE_ID;
    const bodyTest = pick(body, ["is test mode", "is_test_mode", "dry_run"], false);
    const isDryRun = bodyTest === true || bodyTest === "true" || bodyTest === "yes";

    const dynamic_variables = {
      business_name,
      name: pick(body, ["name"], "Lead"),
      website: pick(body, ["website"], ""),
      extra_info: pick(body, ["extra_info", "Areas And Business Information To Answer Calls More Accurately"], "")
    };

    // 2. IMMEDIATE RESPONSE FOR TEST MODE
    // We create the agent, then return immediately to avoid Zapier timeouts
    if (isDryRun) {
      const createAgentResp = await axios.post(
        "https://api.retellai.com/create-agent",
        {
          voice_id,
          retell_llm_dynamic_variables: dynamic_variables,
          response_engine: {
             ...(JSON.parse(process.env.DEFAULT_RESPONSE_ENGINE_JSON || '{}')),
             retell_llm_dynamic_variables: dynamic_variables
          }
        },
        { headers: { Authorization: `Bearer ${RETELL_API_KEY}` }, timeout: 15000 }
      );

      return res.status(200).json({
        ok: true,
        is_test_mode: true,
        agent_id: createAgentResp.data.agent_id,
        variables_sent: dynamic_variables
      });
    }

    // ... Real Purchase Logic below (for non-test mode) ...

  } catch (error) {
    const msg = error.response?.data || error.message;
    return res.status(500).json({ error: "Failed", details: msg });
  }
};
