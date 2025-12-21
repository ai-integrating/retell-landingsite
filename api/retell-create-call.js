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

    const headers = {
      Authorization: `Bearer ${RETELL_API_KEY}`,
      "Content-Type": "application/json",
    };

    // ---- Client data ----
    const biz_name = pick(body, ["business_name", "businessName"], "New Client");
    const website = pick(body, ["website"], "");
    const business_hours = pick(body, ["business_hours"], "");
    const services = pick(body, ["services"], "");
    const extra_info = pick(body, ["extra_info"], "");
    const voice_id = pick(body, ["voice_id", "voiceId"], process.env.DEFAULT_VOICE_ID);

    const isDryRunRaw = pick(body, ["is_test_mode", "dry_run"], "false");
    const isDryRun = String(isDryRunRaw).toLowerCase() === "true";

    // ---- MASTER prompt (behavior) ----
    // Paste your full universal receptionist rules here (the long one).
    const MASTER_PROMPT = `
You are a professional AI receptionist.

STYLE
- Warm, calm, concise, human.
- Do not mention you are an AI unless asked.
- Do not invent facts. If unsure, take a message.

GOAL
- Help inbound callers quickly: answer basic questions OR take a detailed message.
- Never sell anything. Never discuss your own packages/pricing.
- Confirm spelling for names, phone numbers, emails.

INTAKE (when needed)
- Caller name
- Best callback number
- Address/city (if relevant)
- What they need help with (1–2 sentences)
- Timeframe/urgency
- Preferred contact method

CLOSING
- Summarize what you captured.
- Tell them what will happen next: someone will call them back.
`.trim();

    // ---- Business Profile (data) ----
    // This gets "locked in" per agent at creation time.
    const BUSINESS_PROFILE = `
BUSINESS PROFILE (use this as the source of truth)
- Business Name: ${biz_name}
- Website: ${website || "Not provided"}
- Business Hours: ${business_hours || "Not provided"}
- Services: ${services || "Not provided"}
- Additional Notes: ${extra_info || "None provided"}

IF ANY FIELD IS "Not provided":
- politely ask the caller for what you need, or offer to take a message.
`.trim();

    const FINAL_PROMPT = `${MASTER_PROMPT}\n\n${BUSINESS_PROFILE}`;

    // 1) Create LLM (the brain)
    const llmResp = await axios.post(
      "https://api.retellai.com/create-retell-llm",
      {
        general_prompt: FINAL_PROMPT,
        begin_message: `Hi! Thanks for calling ${biz_name}. How can I help you today?`,
        model: "gpt-4o-mini",
      },
      { headers, timeout: 15000 }
    );

    const llm_id = llmResp.data?.llm_id;
    if (!llm_id) return res.status(500).json({ error: "No llm_id returned from Retell" });

    // 2) Create agent (the body)
    const agentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        agent_name: `${biz_name} - Receptionist`,
        voice_id,
        response_engine: { type: "retell-llm", llm_id },
        metadata: {
          business_name: biz_name,
          website,
          business_hours,
          services,
          extra_info,
        },
      },
      { headers, timeout: 15000 }
    );

    const agent_id = agentResp.data?.agent_id;
    const agent_version = agentResp.data?.version ?? 0;

    if (isDryRun) {
      return res.status(200).json({ ok: true, test_mode: true, agent_id, agent_version, llm_id });
    }

    // 3) Buy phone number (inbound line)
    const numberResp = await axios.post(
      "https://api.retellai.com/create-phone-number",
      {
        inbound_agent_id: agent_id,
        inbound_agent_version: agent_version,
        nickname: `${biz_name} Main Line`,
      },
      { headers, timeout: 15000 }
    );

    return res.status(200).json({
      ok: true,
      agent_id,
      agent_version,
      llm_id,
      phone_number: numberResp.data?.phone_number,
      phone_number_pretty: numberResp.data?.phone_number_pretty || numberResp.data?.phone_number,
    });
  } catch (error) {
    return res.status(500).json({ error: "Provisioning Failed", details: error?.response?.data || error?.message });
  }
};
