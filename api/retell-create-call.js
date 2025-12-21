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
    if (!RETELL_API_KEY) return res.status(500).json({ error: "Missing RETELL_API_KEY" });

    console.log("RECEIVED KEYS:", Object.keys(body));

    const business_name = pick(body, ["business_name", "businessName"], "New Client");
    const voice_id = pick(body, ["voice_id", "voiceId"], process.env.DEFAULT_VOICE_ID);
    const to_number = pick(body, ["to_number", "phone_number", "lead_phone"], "");

    const isDryRunRaw = pick(body, ["is_test_mode", "Is_Test_mode", "is test mode", "dry_run"], "false");
    const isDryRun = String(isDryRunRaw).toLowerCase() === "true";

    const dynamic_variables = {
      business_name,
      name: pick(body, ["name"], "Lead"),
      website: pick(body, ["website"], ""),
      extra_info: pick(body, ["extra_info"], "No extra info provided"),
      business_hours: pick(body, ["business_hours"], "Mon-Fri 9-5"),
      services: pick(body, ["services"], "AI Receptionist")
    };

    let response_engine = {};
    try {
      response_engine = JSON.parse(process.env.DEFAULT_RESPONSE_ENGINE_JSON || "{}");
    } catch {
      return res.status(500).json({ error: "DEFAULT_RESPONSE_ENGINE_JSON invalid JSON" });
    }

    const headers = {
      Authorization: `Bearer ${RETELL_API_KEY}`,
      "Content-Type": "application/json"
    };

    const createAgentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      { voice_id, response_engine, metadata: { business_name, ...dynamic_variables } },
      { headers, timeout: 10000 }
    );

    const agent_id = createAgentResp.data?.agent_id;

    if (isDryRun) {
      return res.status(200).json({
        ok: true,
        test_mode: true,
        agent_id,
        variables_echo: dynamic_variables
      });
    }

    if (to_number) {
      const callResp = await axios.post(
        "https://api.retellai.com/create-call",
        { agent_id, to_number, retell_llm_dynamic_variables: dynamic_variables },
        { headers, timeout: 10000 }
      );

      return res.status(200).json({
        ok: true,
        agent_id,
        call_id: callResp.data?.call_id,
        variables_echo: dynamic_variables
      });
    }

    return res.status(200).json({ ok: true, agent_id, message: "No phone number provided for call." });

  } catch (error) {
    return res.status(500).json({ error: "Failed", details: error.response?.data || error.message });
  }
};
