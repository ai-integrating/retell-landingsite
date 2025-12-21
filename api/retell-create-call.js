const axios = require("axios");

// --- 1. HELPERS (REQUIRED) ---
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

// --- 2. MAIN PROVISIONING HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  try {
    const body = await readJsonBody(req);
    const RETELL_API_KEY = process.env.RETELL_API_KEY;
    if (!RETELL_API_KEY) return res.status(500).json({ error: "Missing RETELL_API_KEY" });

    const headers = { Authorization: `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" };

    // ---- A. Client Data Extraction ----
    const biz_name = pick(body, ["business_name", "businessName"], "New Client");
    const website = pick(body, ["website"], "");
    const business_hours = pick(body, ["business_hours"], "");
    const services = pick(body, ["services"], "");
    const extra_info = pick(body, ["extra_info"], "");
    const package_type = pick(body, ["package_type", "package"], "Receptionist");
    const voice_id = pick(body, ["voice_id", "voiceId"], process.env.DEFAULT_VOICE_ID);
    const isDryRun = String(pick(body, ["is_test_mode", "dry_run"], "false")).toLowerCase() === "true";

    // ---- B. Package-Specific Brain Logic ----
    let package_instructions = "";
    if (package_type === "Full Staff") {
        package_instructions = `
ROLE: FULL STAFF AI
- You have full authority to schedule appointments.
- You should actively collect lead details and push for a booking.
- Act as a senior team member who knows the business inside out.`;
    } else {
        package_instructions = `
ROLE: BASIC RECEPTIONIST
- Your primary goal is to take messages and answer basic questions.
- Do NOT schedule appointments; tell the caller a manager will contact them.
- Keep interactions professional but brief.`;
    }

    // ---- C. Master Prompt (Universal Rules) ----
    const MASTER_PROMPT = `
You are a professional AI receptionist.
STYLE: Warm, calm, concise, human. Do not mention you are an AI.
GOAL: Help inbound callers quickly. Confirm spelling for names and numbers.
INTAKE: Caller name, callback number, and what they need help with.
CLOSING: Summarize what you captured and tell them someone will call back.`.trim();

    // ---- D. Business Profile (Locked-in Data) ----
    const BUSINESS_PROFILE = `
BUSINESS PROFILE (Source of Truth)
- Business Name: ${biz_name}
- Website: ${website || "Not provided"}
- Business Hours: ${business_hours || "Not provided"}
- Services: ${services || "Not provided"}
- Additional Notes: ${extra_info || "None provided"}`.trim();

    const FINAL_PROMPT = `${MASTER_PROMPT}\n\n${BUSINESS_PROFILE}\n\n${package_instructions}`;

    // ---- E. Create LLM (The Brain) ----
    const llmResp = await axios.post("https://api.retellai.com/create-retell-llm", {
        general_prompt: FINAL_PROMPT,
        begin_message: `Hi! Thanks for calling ${biz_name}. How can I help you today?`,
        model: "gpt-4o-mini",
    }, { headers, timeout: 15000 });

    const llm_id = llmResp.data?.llm_id;

    // ---- F. Create Agent (The Body) ----
    const agentResp = await axios.post("https://api.retellai.com/create-agent", {
        agent_name: `${biz_name} - ${package_type}`,
        voice_id,
        response_engine: { type: "retell-llm", llm_id },
    }, { headers, timeout: 15000 });

    const agent_id = agentResp.data?.agent_id;
    const agent_version = agentResp.data?.version ?? 0;

    // ---- G. Safety Check ----
    if (isDryRun) {
      return res.status(200).json({ ok: true, test_mode: true, agent_id, llm_id });
    }

    // ---- H. Buy Number ----
    const numberResp = await axios.post("https://api.retellai.com/create-phone-number", {
        inbound_agent_id: agent_id,
        inbound_agent_version: agent_version,
        nickname: `${biz_name} Main Line`,
    }, { headers, timeout: 15000 });

    return res.status(200).json({
      ok: true,
      agent_id,
      phone_number: numberResp.data?.phone_number,
      phone_number_pretty: numberResp.data?.phone_number_pretty || numberResp.data?.phone_number,
    });
  } catch (error) {
    return res.status(500).json({ error: "Provisioning Failed", details: error?.response?.data || error?.message });
  }
};
