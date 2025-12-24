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

// Cleans data and removes risky empty brackets
function cleanValue(text) {
  if (!text || text === "[]" || text === "No data" || text === "" || text === "/") return "Not provided";
  return String(text).replace(/\[\]/g, "Not provided");
}

function pick(obj, keys, fallback = "Not provided") {
  for (const k of keys) {
    let val = obj[k];
    if (val !== undefined && val !== null && val !== "") {
      if (typeof val === 'object' && val.output) return val.output;
      return val;
    }
  }
  return fallback;
}

// ✅ ENHANCED SCRAPER: With error logging for Vercel
async function getWebsiteContext(url) {
  if (!url || url === "Not provided" || !url.startsWith("http")) return null;
  console.log(`Attempting to scrape: ${url}`);
  try {
    const response = await axios.get(url, { 
        timeout: 7000, 
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AI-Integrating-Bot/1.0' } 
    });
    const html = response.data;
    
    // Strip scripts, styles, and tags while preserving spacing
    const textOnly = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/gim, "")
                         .replace(/<style[^>]*>([\s\S]*?)<\/style>/gim, "")
                         .replace(/<[^>]*>?/gm, ' ')
                         .replace(/\s+/g, ' ')
                         .trim();
                         
    console.log(`Scrape successful. Characters found: ${textOnly.length}`);
    return textOnly.substring(0, 2500); 
  } catch (e) {
    console.error(`SCRAPE ERROR for ${url}: ${e.message}`);
    return null;
  }
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  try {
    const body = await readJsonBody(req);
    const RETELL_API_KEY = process.env.RETELL_API_KEY;
    const headers = { Authorization: `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" };

    const biz_name = pick(body, ["business_name", "businessName"], "the business");
    const website_url = cleanValue(pick(body, ["website"]));
    
    // ✅ SCRAPE BEFORE BUILDING THE PROMPT
    const website_content = await getWebsiteContext(website_url);

    const contact_name = cleanValue(pick(body, ["name", "main_contact_name"]));
    const biz_email = cleanValue(pick(body, ["business_email"]));
    const biz_phone = cleanValue(pick(body, ["business_phone"]));
    const service_area = cleanValue(pick(body, ["service_area"]));
    const summary_req = cleanValue(pick(body, ["post_call_summary_request"]));
    const business_hours = cleanValue(pick(body, ["business_hours"]));
    const services = cleanValue(pick(body, ["services", "primary_type_of_business"])).replace("aspahlt", "asphalt");
    const extra_info = cleanValue(pick(body, ["extra_info"]));
    const greeting = pick(body, ["greeting", "how_callers_should_be_greeted"], "");
    const time_zone = cleanValue(pick(body, ["time_zone"]));

    const emergency_details = cleanValue(pick(body, ["emergency_dispatch_questions"])).replace("floor", "flood");
    const scheduling_details = cleanValue(pick(body, ["scheduling_details"])).replace("Calandar", "Calendar");
    const intake_details = cleanValue(pick(body, ["job_intake_details"])).replace("[Location]", "[Service address or city/town]");
    const lead_revival_details = cleanValue(pick(body, ["lead_revival_questions"]));
    
    const raw_pkg = pick(body, ["package_type"], "Receptionist");
    const package_type = String(raw_pkg).toLowerCase();
    const package_suffix = String(raw_pkg).replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    let identityName = "a professional AI receptionist";
    if (scheduling_details !== "Not provided" && package_type !== "receptionist") {
        identityName = "Ava, a professional AI receptionist";
    }

    const MASTER_PROMPT = `
IDENTITY & ROLE
You are ${identityName} for ${biz_name}.
Answer calls clearly and confidently, follow business rules exactly, and never guess.
If information is missing, politely ask the caller or offer to take a message.
If website-derived information conflicts with caller statements or is unclear, defer to the caller and offer to take a message.

STYLE
- Warm, calm, concise, human.
- Do not mention you are an AI unless asked.
- Do not invent facts.

GOAL
- Help inbound callers quickly: answer basic questions OR take a detailed message.
- Confirm spelling for names, phone numbers, emails.
`.trim();

    const BUSINESS_PROFILE = `
BUSINESS PROFILE
- Business Name: ${biz_name}
- Package Type: ${package_type}
- Main Contact: ${contact_name}
- Business Email: ${biz_email}
- Business Phone: ${biz_phone}
- Website: ${website_url}
- Business Hours: ${business_hours}
- Service Area: ${service_area}
- Services: ${services}
- Time Zone: ${time_zone}
- Summary Requirements: ${summary_req}
- Additional Notes: ${extra_info}

${website_content ? `WEBSITE-DERIVED CONTEXT (REFERENCE ONLY):
---
${website_content}
---` : ""}

RECEPTIONIST PACKAGE SCHEDULING POLICY (DO NOT OVERRIDE):
If package_type is "custom" OR "receptionist", you do NOT directly book appointments or confirm exact time slots unless a valid Calendar Link is provided in Scheduling Details.
- If Scheduling Details include a usable Calendar Link and clear booking rules, you may offer to schedule within those rules.
- If the Calendar Link is missing, blank, or "Not provided", do NOT schedule. Instead:
  1) Collect the caller’s name, callback number, address/location, service needed, and preferred day/time windows.
  2) Confirm you will pass the message to the main contact for scheduling.
  3) End politely and confidently without guessing availability.
Empty or "Not provided" values indicate scheduling is NOT enabled.

ACTIVE PROTOCOLS:
${emergency_details !== "Not provided" ? `- EMERGENCY DISPATCH: ${emergency_details}` : ""}
${scheduling_details !== "Not provided" ? `- SCHEDULING: ${scheduling_details}` : ""}
${intake_details !== "Not provided" ? `- JOB INTAKE: ${intake_details}` : ""}
${lead_revival_details !== "Not provided" ? `- LEAD REVIVAL: ${lead_revival_details}` : ""}

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
