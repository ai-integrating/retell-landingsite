const axios = require("axios");

// --- CRITICAL HELPERS (DO NOT REMOVE) ---
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

    // 1. EXTRACT DATA AS STRINGS (Retell requirement)
    const dynamic_variables = {
      business_name: pick(body, ["business_name"], "New Client"),
      name: pick(body, ["name"], "Lead"),
      extra_info: pick(body, ["extra_info"], "None provided"),
      services: pick(body, ["services"], "AI Support")
    };

    // 2. STOP 504 TIMEOUT: If this is just a Zapier test, reply immediately
    const isDryRun = pick(body, ["is_test_mode", "Is_Test_mode"], "false").toLowerCase() === "true";
    if (isDryRun) {
      return res.status(200).json({ ok: true, message: "Test successful", variables_received: dynamic_variables });
    }

    // 3. HANDLE LIVE INBOUND/OUTBOUND
    const createAgentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      { 
        voice_id: pick(body, ["voice_id"], process.env.DEFAULT_VOICE_ID),
        response_engine: JSON.parse(process.env.DEFAULT_RESPONSE_ENGINE_JSON || "{}"),
        metadata: { ...dynamic_variables } 
      },
      { headers: { Authorization: `Bearer ${RETELL_API_KEY}` }, timeout: 8000 } // Shortened timeout
    );

    return res.status(200).json({
      ok: true,
      agent_id: createAgentResp.data?.agent_id,
      retell_llm_dynamic_variables: dynamic_variables
    });

  } catch (error) {
    return res.status(500).json({ error: "Failed", details: error.message });
  }
};
