const axios = require("axios");

// --- HELPERS (DO NOT CHANGE) ---
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

// --- MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  try {
    const body = await readJsonBody(req);
    const RETELL_API_KEY = process.env.RETELL_API_KEY;
    if (!RETELL_API_KEY) return res.status(500).json({ error: "Missing RETELL_API_KEY env var" });

    // 1. DATA EXTRACTION
    const business_name = pick(body, ["business_name"], "New Client");
    const isDryRun = String(pick(body, ["is_test_mode", "Is_Test_mode"], "false")).toLowerCase() === "true";

    // 2. CREATE AGENT
    const createAgentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        voice_id: pick(body, ["voice_id"], process.env.DEFAULT_VOICE_ID),
        response_engine: JSON.parse(process.env.DEFAULT_RESPONSE_ENGINE_JSON || "{}"),
        // This is the important part for Inbound Vars
        inbound_dynamic_variable_webhook_url: "https://your-project.vercel.app/api/retell-inbound-vars"
      },
      { 
        headers: { 
          Authorization: `Bearer ${RETELL_API_KEY}`, 
          "Content-Type": "application/json" 
        }, 
        timeout: 9000 // Keep under Vercel's 10s limit
      }
    );

    const agent_id = createAgentResp.data?.agent_id;

    // 3. STOP HERE FOR TEST (Prevents buying numbers or making calls yet)
    if (isDryRun) {
      return res.status(200).json({
        ok: true,
        message: "SUCCESS: Agent Created.",
        agent_id: agent_id,
        received_keys: Object.keys(body)
      });
    }

    // (Code for buying numbers would follow here for live mode)
    return res.status(200).json({ ok: true, agent_id });

  } catch (error) {
    const details = error.response?.data || error.message;
    console.error("FAILED TO CREATE AGENT:", details);
    return res.status(500).json({ error: "Failed to provision", details });
  }
};
