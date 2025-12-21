const axios = require("axios");

// --- HELPERS (Keep these exactly as they are) ---
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
    const headers = { Authorization: `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" };

    // 1. CAPTURE CONTROL FLAGS
    const call_mode = String(pick(body, ["call_mode"], "inbound")).toLowerCase(); // "inbound" or "outbound"
    const isDryRun = String(pick(body, ["is_test_mode", "Is_Test_mode"], "false")).toLowerCase() === "true";
    const to_number = pick(body, ["to_number", "phone_number", "lead_phone"], "");

    // 2. DATA MAPPING
    const business_name = pick(body, ["business_name"], "New Client");
    const dynamic_variables = {
      business_name,
      name: pick(body, ["name"], "Lead"),
      extra_info: pick(body, ["extra_info"], "N/A"),
      services: pick(body, ["services"], "AI Services")
    };

    // 3. ALWAYS CREATE AGENT
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

    if (isDryRun) {
      return res.status(200).json({ ok: true, test_mode: true, agent_id, variables: dynamic_variables });
    }

    // 4. ALWAYS PROVISION INBOUND NUMBER
    const numberResp = await axios.post(
      "https://api.retellai.com/create-phone-number",
      {
        inbound_agent_id: agent_id,
        nickname: `${business_name} Main Line`
      },
      { headers, timeout: 10000 }
    );

    // 5. CONDITIONALLY TRIGGER OUTBOUND CALL
    let outbound_call = null;
    if (call_mode === "outbound" && to_number) {
      const callResp = await axios.post(
        "https://api.retellai.com/create-call",
        {
          agent_id,
          to_number,
          retell_llm_dynamic_variables: dynamic_variables
        },
        { headers, timeout: 10000 }
      );
      outbound_call = callResp.data;
    }

    return res.status(200).json({
      ok: true,
      call_mode,
      agent_id,
      inbound_number: numberResp.data?.phone_number,
      outbound_call_id: outbound_call?.call_id || "none"
    });

  } catch (error) {
    return res.status(500).json({ error: "Failed", details: error.response?.data || error.message });
  }
};
