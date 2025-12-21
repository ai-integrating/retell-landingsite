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
    req.on("data", () => {});
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

    // ---- DEBUG (helps confirm Zap keys) ----
    console.log("PROVISION BODY KEYS:", Object.keys(body || {}));

    // ---- Client data extraction ----
    const biz_name = pick(body, ["business_name", "businessName"], "New Client");
const website = pick(body, ["website", "Website", "site_url", "Site"], "");
const business_hours = pick(body, ["business_hours", "Business Hours", "hours", "business hours"], "");
const services = pick(body, ["services", "Services", "service_list", "business_services", "Primary Type Of Business"], "");
const extra_info = pick(body, ["extra_info", "Extra Info", "notes", "compiled_notes", "additional_notes"], "");

const time_zone = pick(body, ["time_zone", "timezone", "timeStamp", "time_stamp", "time zone"], "");


    // ✅ NEW: package/add-ons/timezone fields (clean + flexible)
    const package_type = pick(body, ["package_type", "packageType"], "");
    const addons = pick(body, ["addons", "add_ons", "addOns"], "");
    const time_zone = pick(body, ["time_zone", "timezone", "timeStamp"], "");

    const voice_id = pick(body, ["voice_id", "voiceId"], process.env.DEFAULT_VOICE_ID);

    // ---- MASTER prompt (Behavioral rules) ----
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

    // ---- Business Profile (Baked-in data) ----
    const BUSINESS_PROFILE = `
BUSINESS PROFILE (use this as the source of truth)
- Business Name: ${biz_name}
- Website: ${website || "Not provided"}
- Business Hours: ${business_hours || "Not provided"}
- Services: ${services || "Not provided"}
- Package Type: ${package_type || "Not provided"}
- Add-Ons Enabled: ${addons || "None"}
- Time Zone: ${time_zone || "Not provided"}
- Additional Notes: ${extra_info || "None provided"}

IF ANY FIELD IS "Not provided":
- politely ask the caller for what you need, or offer to take a message.
`.trim();

    const FINAL_PROMPT = `${MASTER_PROMPT}\n\n${BUSINESS_PROFILE}`;

    // 1) Create LLM (The Brain)
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

    // 2) Create Agent (The Body)
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
          // ✅ NEW: store these in metadata too
          package_type,
          addons,
          time_zone,
        },
      },
      { headers, timeout: 15000 }
    );

    const agent_id = agentResp.data?.agent_id;

    // ---- SUCCESSFUL COMPLETION WITHOUT NUMBER PURCHASE ----
    return res.status(200).json({
      ok: true,
      message: "Agent and LLM created successfully. No phone number was purchased.",
      agent_id,
      llm_id,
      agent_name: `${biz_name} - Receptionist`,
      // ✅ NEW: echo back so Zap “Data Out” proves the mapping
      variables_echo: {
        business_name: biz_name,
        website,
        business_hours,
        services,
        extra_info,
        package_type,
        addons,
        time_zone,
      },
    });

  } catch (error) {
    return res.status(500).json({ error: "Provisioning Failed", details: error?.response?.data || error?.message });
  }
};
