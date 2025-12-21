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

  try {
    const body = await readJsonBody(req);
    console.log("INCOMING DATA FROM ZAPIER:", JSON.stringify(body)); // See this in Vercel Logs

    const RETELL_API_KEY = process.env.RETELL_API_KEY;
    const headers = { Authorization: `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" };

    // 1. DATA EXTRACTION
    const biz_name = pick(body, ["business_name", "businessName"], "New Client");
    const website = pick(body, ["website"], "Not provided");
    const hours = pick(body, ["business_hours"], "Not provided");
    const services = pick(body, ["services"], "Not provided");
    const extra = pick(body, ["extra_info"], "None");
    const package_type = pick(body, ["package_type"], "Receptionist");
    const isDryRun = pick(body, ["is_test_mode"], "false").toLowerCase() === "true";

    // 2. BUILD THE FINAL PROMPT
    const FINAL_PROMPT = `
You are a professional AI receptionist for ${biz_name}.
BUSINESS PROFILE:
- Website: ${website}
- Hours: ${hours}
- Services: ${services}
- Extra Info: ${extra}

GOAL: ${package_type === 'full_staff' ? 'Handle full intake and scheduling.' : 'Take a message only.'}
`.trim();

    // 3. CREATE LLM (The Brain)
    const llmResp = await axios.post("https://api.retellai.com/create-retell-llm", {
      general_prompt: FINAL_PROMPT,
      begin_message: `Hi! Thanks for calling ${biz_name}. How can I help you?`,
      model: "gpt-4o-mini"
    }, { headers });

    const llm_id = llmResp.data.llm_id;

    // 4. CREATE AGENT (The Body)
    const agentResp = await axios.post("https://api.retellai.com/create-agent", {
      agent_name: `${biz_name} - ${package_type}`, // This names the agent in dashboard
      voice_id: pick(body, ["voice_id"], process.env.DEFAULT_VOICE_ID),
      response_engine: { type: "retell-llm", llm_id: llm_id }
    }, { headers });

    const agent_id = agentResp.data.agent_id;
    const agent_version = agentResp.data.agent_version ?? 0;

    // 5. SAFETY CHECK
    if (isDryRun) {
      return res.status(200).json({ ok: true, agent_id, message: "TEST MODE: No number bought." });
    }

    // 6. BUY NUMBER
    const numberResp = await axios.post("https://api.retellai.com/create-phone-number", {
      inbound_agent_id: agent_id,
      inbound_agent_version: agent_version,
      nickname: `${biz_name} Line`
    }, { headers });

    return res.status(200).json({ ok: true, agent_id, phone_number: numberResp.data.phone_number });

  } catch (error) {
    console.error("ERROR DETAILS:", error.response?.data || error.message);
    return res.status(500).json({ error: "Failed", details: error.message });
  }
};
