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

    if (!RETELL_API_KEY) {
      return res.status(500).json({ error: "Missing RETELL_API_KEY env var." });
    }

    // --- 1. EXTRACT DATA FROM ZAPIER ---
    const business_name = pick(body, ["business_name", "businessName"], "New Client");
    const voice_id = pick(body, ["voice_id", "voiceId"], null) || process.env.DEFAULT_VOICE_ID;
    
    // Safety check for your Zapier key "is test mode"
    const bodyTest = pick(body, ["is test mode", "is_test_mode", "dry_run"], false);
    const isDryRun = bodyTest === true || bodyTest === "true" || bodyTest === "yes" || process.env.IS_TEST_MODE === "true";

    const area_code = pick(body, ["area_code", "areaCode"], process.env.DEFAULT_AREA_CODE || null);
    const metadata = pick(body, ["metadata"], {}) || {};

    // Gather all dynamic variables for Retell
    const dynamic_variables = {
      business_name,
      name: pick(body, ["name"], "Lead"),
      website: pick(body, ["website"], ""),
      extra_info: pick(body, ["extra_info"], ""),
      // Also include anything sent in the nested block just in case
      ...(pick(body, ["retell_llm_dynamic_variables", "dynamic_variables"], {}) || {})
    };

    // Setup Response Engine
    let response_engine = pick(body, ["response_engine", "responseEngine"], null);
    if (!response_engine && process.env.DEFAULT_RESPONSE_ENGINE_JSON) {
      response_engine = JSON.parse(process.env.DEFAULT_RESPONSE_ENGINE_JSON);
    }

    if (!voice_id || !response_engine) {
      return res.status(400).json({ error: "voice_id or response_engine not found." });
    }

    // --- 2. CREATE RETELL AGENT (WITH VARIABLES INJECTED) ---
    const createAgentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        voice_id,
        response_engine: {
          ...response_engine,
          // DATA IS INJECTED HERE SO TEST MODE WORKS
          retell_llm_dynamic_variables: dynamic_variables 
        },
        metadata: { business_name, ...metadata },
      },
      {
        headers: { Authorization: `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" },
        timeout: 30000,
      }
    );

    const agent_id = createAgentResp.data?.agent_id;
    const agent_version = createAgentResp.data?.version;

    // --- 3. THE SAFETY CHECK (TEST MODE STOP) ---
    if (isDryRun) {
      return res.status(200).json({
        ok: true,
        is_test_mode: true,
        message: "SUCCESS (TEST MODE): Agent created with variables. No number purchased.",
        business_name,
        agent_id,
        phone_number: "+15550000000",
        variables_sent: dynamic_variables // Verification for Zapier
      });
    }

    // --- 4. REAL PURCHASE (ONLY IF NOT TEST MODE) ---
    const createNumberResp = await axios.post(
      "https://api.retellai.com/create-phone-number",
      {
        inbound_agent_id: agent_id,
        inbound_agent_version: agent_version ?? 0,
        ...(area_code ? { area_code: Number(area_code) } : {}),
        nickname: `${business_name} Receptionist`,
      },
      {
        headers: { Authorization: `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" },
        timeout: 30000,
      }
    );

    return res.status(200).json({
      ok: true,
      business_name,
      agent_id,
      phone_number: createNumberResp.data?.phone_number,
      variables_sent: dynamic_variables
    });

  } catch (error) {
    const details = error?.response?.data || error?.message || "Unknown error";
    return res.status(500).json({ error: "Failed to provision", details });
  }
};
