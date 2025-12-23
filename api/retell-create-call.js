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

// Improved formatting to help the AI read concatenated strings
function formatDetails(text) {
  if (!text) return "";
  return String(text)
    .replace(/([0-9])([a-zA-Z])/g, '$1 $2') 
    .replace(/([a-z])([A-Z])/g, '$1 $2')   
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2'); 
}

function pick(obj, keys, fallback = "") {
  for (const k of keys) {
    let val = obj[k];
    if (val !== undefined && val !== null && val !== "") {
      if (typeof val === 'object' && val.output) return val.output;
      return val;
    }
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

    // ---- Data Extraction ----
    const biz_name = pick(body, ["business_name", "businessName"], "New Client");
    const contact_name = pick(body, ["name", "main_contact_name"], "Not provided");
    const biz_email = pick(body, ["business_email"], "Not provided");
    const biz_phone = pick(body, ["business_phone"], "Not provided");
    const service_area = pick(body, ["service_area"], "Not provided");
    const summary_req = pick(body, ["post_call_summary_request"], "Not provided");
    
    const website = pick(body, ["website"], "");
    const business_hours = pick(body, ["business_hours"], "");
    const services = pick(body, ["services", "primary_type_of_business"], "");
    const extra_info = pick(body, ["extra_info"], "");
    const greeting = pick(body, ["greeting", "how_callers_should_be_greeted"], "");
    const time_zone = pick(body, ["time_zone"], "");

    // Protocol Details
    const emergency_details = formatDetails(pick(body, ["emergency_dispatch_questions"], ""));
    const scheduling_details = formatDetails(pick(body, ["scheduling_details"], ""));
    const intake_details = formatDetails(pick(body, ["job_intake_details"], ""));
    const lead_revival_details = formatDetails(pick(body, ["lead_revival_questions"], ""));
    
    const package_type = String(pick(body, ["package_type"], "custom")).toLowerCase();
    const voice_id = pick(body, ["voice_id", "voiceId"], process.env.DEFAULT_VOICE_ID);

    // ---- MASTER PROMPT (Original Behavioral Info) ----
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

    // ---- BUSINESS PROFILE (Updated with missing info) ----
    const BUSINESS_PROFILE = `
BUSINESS PROFILE
- Business Name: ${biz_name}
- Main Contact: ${contact_name}
- Business Email: ${biz_email}
- Business Phone: ${biz_phone}
- Website: ${website || "Not provided"}
- Business Hours: ${business_hours || "Not provided"}
- Service Area: ${service_area}
- Services: ${services || "Not provided"}
- Time Zone: ${time_zone || "Not provided"}
- Summary Requirements: ${summary_req}
- Additional Notes: ${extra_info || "None provided"}

ACTIVE PROTOCOLS:
${emergency_details ? `- EMERGENCY DISPATCH: ${emergency_details}` : ""}
${scheduling_details ? `- SCHEDULING: ${scheduling_details}` : ""}
${intake_details ? `- JOB INTAKE: ${intake_details}` : ""}
${lead_revival_details ? `- LEAD REVIVAL: ${lead_revival_details}` : ""}

IF ANY FIELD IS "Not provided":
- politely ask the caller for what you need, or offer to take a message.
`.trim();

    const FINAL_PROMPT = `${MASTER_PROMPT}\n\n${BUSINESS_PROFILE}`;

    const llmResp = await axios.post("https://api.retellai.com/create-retell-llm", {
        general_prompt: FINAL_PROMPT,
        begin_message: greeting || `Hi! Thanks for calling ${biz_name}. How can I help you today?`,
        model: "gpt-4o-mini",
    }, { headers, timeout: 15000 });

    const llm_id = llmResp.data?.llm_id;
    if (!llm_id) return res.status(500).json({ error: "No llm_id returned" });

    const agentResp = await axios.post("https://api.retellai.com/create-agent", {
        agent_name: `${biz_name} - Receptionist`,
        voice_id,
        response_engine: { type: "retell-llm", llm_id },
        metadata: { business_name: biz_name, package_type },
    }, { headers, timeout: 15000 });

    return res.status(200).json({ ok: true, agent_id: agentResp.data?.agent_id, llm_id, agent_name: `${biz_name} - Receptionist` });
  } catch (error) {
    return res.status(500).json({ error: "Provisioning Failed", details: error?.response?.data || error?.message });
  }
};
