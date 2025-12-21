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
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return String(obj[k]);
  }
  return String(fallback);
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  try {
    const body = await readJsonBody(req);
    const RETELL_API_KEY = process.env.RETELL_API_KEY;

    // 1. Map Variables as Strings (Crucial!)
    const dynamic_variables = {
      business_name: pick(body, ["business_name"], "New Client"),
      name: pick(body, ["name"], "Lead"),
      website: pick(body, ["website"], "N/A"),
      extra_info: pick(body, ["extra_info"], "None provided"),
      services: pick(body, ["services"], "AI Support")
    };

    // 2. Identify if this is a live Inbound call request
    const isRetellInboundRequest = body.event === "call_inbound";

    if (isRetellInboundRequest) {
      // Return variables in the specific format Retell's Inbound Webhook requires
      return res.status(200).json({
        call_inbound: {
          retell_llm_dynamic_variables: dynamic_variables
        }
      });
    }

    // 3. For Provisioning (Zapier Trigger)
    const isDryRun = String(pick(body, ["is_test_mode", "Is_Test_mode"], "false")).toLowerCase() === "true";
    
    // Create Agent with shorter timeout to prevent Vercel 504
    const createAgentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      { 
        voice_id: pick(body, ["voice_id"], process.env.DEFAULT_VOICE_ID),
        response_engine: JSON.parse(process.env.DEFAULT_RESPONSE_ENGINE_JSON || "{}"),
        metadata: { ...dynamic_variables } 
      },
      { headers: { Authorization: `Bearer ${RETELL_API_KEY}` }, timeout: 8000 }
    );

    const agent_id = createAgentResp.data?.agent_id;

    return res.status(200).json({
      ok: true,
      agent_id,
      variables_received: dynamic_variables
    });

  } catch (error) {
    // Log the actual error to Vercel dashboard for visibility
    console.error("CRASH ERROR:", error.response?.data || error.message);
    return res.status(500).json({ error: "Server Error", details: error.message });
  }
};
