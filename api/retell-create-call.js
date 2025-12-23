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
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function pick(obj, keys, fallback = "") {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "")
      return obj[k];
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
    if (!RETELL_API_KEY)
      return res.status(500).json({ error: "Missing RETELL_API_KEY" });

    const headers = {
      Authorization: `Bearer ${RETELL_API_KEY}`,
      "Content-Type": "application/json",
    };

    console.log("RECEIVED BODY KEYS:", Object.keys(body));

    // ---- Client data extraction ----
    const biz_name = pick(body, ["business_name", "businessName"], "New Client");
    const website = pick(body, ["website"], "");
    const business_hours = pick(body, ["business_hours"], "");
    const services = pick(body, ["services", "primary_type_of_business"], "");
    const extra_info = pick(body, ["extra_info"], "");
    const greeting = pick(body, ["greeting", "how_callers_should_be_greeted"], "");
    
    // ✅ Specific Add-on Details
    const emergency_details = pick(body, ["emergency_dispatch_questions", "emergency_info"], "None");
    const scheduling_details = pick(body, ["scheduling_details", "scheduling_info"], "None");
    const intake_details = pick(body, ["job_intake_details", "intake_info"], "None");
    const lead_revival_details = pick(body, ["lead_revival_questions", "lead_revival_info"], "None");

    const package_type = String(pick(body, ["package_type"], "")).toLowerCase();
    let addons = pick(body, ["addons"], "");
    const time_zone = pick(body, ["time_zone"], "");

    if (package_type === "full_staff") {
      addons = "Ava (Scheduling), Mia (Job Intake), Lexi (Emergency Dispatch), Samuel (Lead Revival)";
    } else if (package_type === "receptionist") {
      addons = "None";
    } else if (package_type === "custom") {
      addons = addons || "None";
    } else {
      addons = addons || "None";
    }

    const voice_id = pick(body, ["voice_id", "voiceId"], process.env.DEFAULT_VOICE_ID);

    // ---- MASTER prompt ----
    const MASTER_PROMPT = `
You are a professional AI receptionist.

STYLE
- Warm, calm, concise, human.
- Do not mention you are an AI unless asked.
- Do not invent facts. If unsure, take a message.

GOAL
- Help inbound callers quickly: answer basic questions OR take a detailed message.
- Confirm spelling for names, phone numbers, emails.

INTAKE (Standard)
- Caller name, Best callback number, What they need help with.
`.trim();

    // ---- Business Profile (Updated with Specific Add-on Logic) ----
    const BUSINESS_PROFILE = `
BUSINESS PROFILE
- Business Name: ${biz_name}
- Website: ${website || "Not provided"}
- Business Hours: ${business_hours || "Not provided"}
- Services: ${services || "Not provided"}
- Time Zone: ${time_zone || "Not provided"}
- Additional Notes: ${extra_info || "None provided"}

ACTIVE ADD-ONS & PROTOCOLS:
${addons.includes("Lexi") || addons.includes("Emergency") ? `- EMERGENCY DISPATCH: Follow these requirements: ${emergency_details}` : ""}
${addons.includes("Ava") || addons.includes("Scheduling") ? `- SCHEDULING: Collect these details for booking: ${scheduling_details}` : ""}
${addons.includes("Mia") || addons.includes("Intake") ? `- JOB INTAKE: Ask these specific questions: ${intake_details}` : ""}
${addons.includes("Samuel") || addons.includes("Lead") ? `- LEAD REVIVAL: Use this info: ${lead_revival_details}` : ""}

IF ANY FIELD IS "Not provided":
- politely ask the caller for what you need, or offer to take a message.
`.trim();

    const FINAL_PROMPT = `${MASTER_PROMPT}\n\n${BUSINESS_PROFILE}`;

    // 1) Create LLM
    const llmResp = await axios.post(
      "https://api.retellai.com/create-retell-llm",
      {
        general_prompt: FINAL_PROMPT,
        // Use custom greeting if provided, otherwise fallback to default
        begin_message: greeting || `Hi! Thanks for calling ${biz_name}. How can I help you today?`,
        model: "gpt-4o-mini",
      },
      { headers, timeout: 15000 }
    );

    const llm_id = llmResp.data?.llm_id;
    if (!llm_id)
      return res.status(500).json({ error: "No llm_id returned from Retell" });

    // 2) Create Agent
    const agentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        agent_name: `${biz_name} - Receptionist`,
        voice_id,
        response_engine: { type: "retell-llm", llm_id },
        metadata: {
          business_name: biz_name,
          package_type,
          addons,
          time_zone,
        },
      },
      { headers, timeout: 15000 }
    );

    const agent_id = agentResp.data?.agent_id;

    return res.status(200).json({
      ok: true,
      agent_id,
      llm_id,
      agent_name: `${biz_name} - Receptionist`,
    });
  } catch (error) {
    return res.status(500).json({
      error: "Provisioning Failed",
      details: error?.response?.data || error?.message,
    });
  }
};
