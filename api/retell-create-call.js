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

    // Debug logs for Zapier mapping
    console.log("PROVISION BODY KEYS:", Object.keys(body));

    const business_name = pick(body, ["business_name", "businessName"], "New Client");
    const to_number = pick(body, ["to_number", "phone_number", "lead_phone"], "");
    const isDryRun = String(pick(body, ["is_test_mode", "Is_Test_mode"], "false")).toLowerCase() === "true";

    const dynamic_variables = {
      business_name,
      name: pick(body, ["name"], "Lead"),
      extra_info: pick(body, ["extra_info"], "No info"),
      services: pick(body, ["services"], "Receptionist")
    };

    // 1. Create Agent
    const createAgentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      { 
        voice_id: pick(body, ["voice_id"], process.env.DEFAULT_VOICE_ID), 
        response_engine: JSON.parse(process.env.DEFAULT_RESPONSE_ENGINE_JSON || "{}"),
        metadata: { business_name, ...dynamic_variables } 
      },
      { headers, timeout: 10000 }
    );
    const agent_id = createAgentResp.data?.agent_id;
    const agent_version = createAgentResp.data?.version ?? 0;

    if (isDryRun) {
      return res.status(200).json({ ok: true, test_mode: true, agent_id, variables: dynamic_variables });
    }

    // 2. Buy Phone Number & Auto-Set Inbound Webhook
    // REPLACE THIS URL with your live Endpoint B URL once deployed
    const INBOUND_VARS_URL = "https://your-project.vercel.app/api/retell-inbound-vars";

    const numberResp = await axios.post(
      "https://api.retellai.com/create-phone-number",
      {
        inbound_agent_id: agent_id,
        inbound_agent_version: agent_version, 
        nickname: `${business_name} Main Line`,
        inbound_webhook_url: INBOUND_VARS_URL // Automated handshake
      },
      { headers, timeout: 10000 }
    );

    // 3. Optional Outbound Call
    let outbound_call_id = "none";
    if (to_number) {
      const callResp = await axios.post(
        "https://api.retellai.com/create-call",
        { agent_id, to_number, retell_llm_dynamic_variables: dynamic_variables },
        { headers, timeout: 10000 }
      );
      outbound_call_id = callResp.data?.call_id;
    }

    return res.status(200).json({
      ok: true,
      agent_id,
      phone_number: numberResp.data?.phone_number,
      outbound_call_id,
      variables_echo: dynamic_variables
    });

  } catch (error) {
    return res.status(500).json({ error: "Failed", details: error.response?.data || error.message });
  }
};
