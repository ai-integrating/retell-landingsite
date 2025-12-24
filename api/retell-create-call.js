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
      } catch { resolve({}); }
    });
  });
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
    const biz_name = pick(body, ["business_name", "businessName"], "the business");
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

    // Protocol Details from Zapier
    const emergency_details = pick(body, ["emergency_dispatch_questions"], "");
    const scheduling_details = pick(body, ["scheduling_details"], "");
    const intake_details = pick(body, ["job_intake_details"], "");
    const lead_revival_details = pick(body, ["lead_revival_questions"], "");
    
    // ✅ Dynamic Package Naming Logic
    const raw_pkg = pick(body, ["package_type"], "Receptionist");
    const package_type = String(raw_pkg).toLowerCase();
    
    // Formats "full_staff" -> "Full Staff" for the Retell dashboard name
    const package_suffix = String(raw_pkg)
        .replace(/_/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase());

    // Identity Logic
    let identityName = "a professional AI receptionist";
    if (scheduling_details && package_type !== "receptionist") identityName = "Ava, a professional AI receptionist";

    // ---- MASTER PROMPT ----
    const MASTER_PROMPT = `
IDENTITY & ROLE
You are ${identityName} for ${biz_name}.
Answer calls clearly and confidently, follow business rules exactly, and never guess.
If information is missing, politely ask the caller or offer to take a message.

STYLE
- Warm, calm, concise, human.
- Do not mention you are an AI unless asked.
- Do not invent facts.

GOAL
- Help inbound callers quickly: answer basic questions OR take a detailed message.
- Confirm spelling for names, phone numbers, emails.
`.trim();

    // ---- BUSINESS PROFILE ----
    const BUSINESS_PROFILE = `
BUSINESS PROFILE
- Business Name: ${biz_name}
- Package Type: ${package_type}
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

RECEPTIONIST PACKAGE SCHEDULING POLICY (DO NOT OVERRIDE):
If package_type is "receptionist", you do NOT directly book appointments or confirm exact time slots unless a valid Calendar Link is provided in Scheduling Details.
- If Scheduling Details include a usable Calendar Link and clear booking rules, you may offer to schedule within those rules.
- If the Calendar Link is missing, blank, or "Not provided/No data", do NOT schedule. Instead:
  1) Collect the caller’s name, callback number, address/location, service needed, and preferred day/time windows.
  2) Confirm you will pass the message to the main contact for scheduling.
  3) End politely and confidently without guessing availability.

ACTIVE PROTOCOLS:
${emergency_details ? `- EMERGENCY DISPATCH: ${emergency_details}` : ""}
${scheduling_details ? `- SCHEDULING: ${scheduling_details}` : ""}
${intake_details ? `- JOB INTAKE: ${intake_details}` : ""}
${lead_revival_details ? `- LEAD REVIVAL: ${lead_revival_details}` : ""}

IF ANY FIELD IS "Not provided":
- politely ask the caller for what you need, or offer to take a message.
`.trim();

    const FINAL_PROMPT = `${MASTER_PROMPT}\n\n${BUSINESS_PROFILE}`;

    // 1) Create LLM
    const llmResp = await axios.post("https://api.retellai.com/create-retell-llm", {
        general_prompt: FINAL_PROMPT,
        begin_message: greeting || `Hi! Thanks for calling ${biz_name}. How can I help you today?`,
        model: "gpt-4o-mini",
    }, { headers, timeout: 15000 });

    const llm_id = llmResp.data?.llm_id;
    if (!llm_id) return res.status(500).json({ error: "No llm_id returned" });

    // 2) Create Agent with Dynamic Name
    const agentResp = await axios.post("https://api.retellai.com/create-agent", {
        agent_name: `${biz_name} - ${package_suffix}`,
        voice_id: pick(body, ["voice_id", "voiceId"], process.env.DEFAULT_VOICE_ID),
        response_engine: { type: "retell-llm", llm_id },
        metadata: { business_name: biz_name, package_type },
    }, { headers, timeout: 15000 });

    return res.status(200).json({ ok: true, agent_id: agentResp.data?.agent_id, llm_id });
  } catch (error) {
    return res.status(500).json({ error: "Provisioning Failed", details: error?.response?.data || error?.message });
  }
};
