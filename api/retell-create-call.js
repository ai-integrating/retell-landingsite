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

function extractFirstUrl(text) {
  if (!text || text === "Not provided") return null;
  const m = String(text).match(/https?:\/\/[^\s)]+/i);
  if (m) return m[0];
  if (text.includes(".") && !text.startsWith("http")) return `https://${text.trim()}`;
  return null;
}

function cleanValue(text) {
  if (!text || text === "[]" || text === "No data" || text === "" || text === "/" || text === "null") return "Not provided";
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

// ✅ NEW: Decode HTML entities for a cleaner prompt
const decodeHtml = (s) =>
  s.replace(/&amp;/g, "&")
   .replace(/&quot;/g, '"')
   .replace(/&#39;/g, "'")
   .replace(/&nbsp;/g, " ")
   .replace(/&lt;/g, "<")
   .replace(/&gt;/g, ">");

async function getWebsiteContext(urlInput) {
  let url = extractFirstUrl(urlInput);
  if (!url) return null;

  try {
    const response = await axios.get(url, {
      timeout: 8000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AI-Integrating-Bot/1.0" }
    });
    let textOnly = response.data
      .replace(/<script[^>]*>([\s\S]*?)<\/script>/gim, "")
      .replace(/<style[^>]*>([\s\S]*?)<\/style>/gim, "")
      .replace(/<nav[^>]*>([\s\S]*?)<\/nav>/gim, "")
      .replace(/<footer[^>]*>([\s\S]*?)<\/footer>/gim, "")
      .replace(/<form[^>]*>([\s\S]*?)<\/form>/gim, "") // ✅ Strip messy forms
      .replace(/<[^>]*>?/gm, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // ✅ Clean and tighten length to ~1800 chars
    return decodeHtml(textOnly).substring(0, 1800);
  } catch (e) {
    // Fallback Proxy logic (Jina AI Reader)
    try {
      const proxyUrl = `https://r.jina.ai/${url}`;
      const r = await axios.get(proxyUrl, { timeout: 8000 });
      let txt = String(r.data || "").replace(/\s+/g, " ").trim();
      return decodeHtml(txt).substring(0, 1800);
    } catch (err) { return null; }
  }
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const body = await readJsonBody(req);
    const RETELL_API_KEY = process.env.RETELL_API_KEY;
    const headers = { Authorization: `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" };

    const biz_name = pick(body, ["business_name", "businessName"], "the business");
    const website_input = pick(body, ["website"]);
    const website_content = await getWebsiteContext(website_input);
    const website_url = cleanValue(website_input);

    const scheduling_details = cleanValue(pick(body, ["scheduling_details"])).replace("Calandar", "Calendar");

    // ✅ Logic fix: If no Calendar Link, force scheduling to "Not enabled"
    let finalized_scheduling = scheduling_details;
    if (scheduling_details.toLowerCase().includes("calendar:not provided")) {
        finalized_scheduling = "Calendar Link: Not provided. Scheduling is NOT enabled. Collect preferred windows and notify the main contact for a callback.";
    }

    const biz_email = cleanValue(pick(body, ["business_email"]));
    const services = cleanValue(pick(body, ["services"])).replace("aspahlt", "asphalt");
    const emergency_details = cleanValue(pick(body, ["emergency_dispatch_questions"])).replace("floor", "flood");
    const intake_details = cleanValue(pick(body, ["job_intake_details"])).replace("[Location]", "[Service address or city/town]");
    
    const raw_pkg = pick(body, ["package_type"], "Receptionist");
    const package_type = String(raw_pkg).toLowerCase();
    const package_suffix = String(raw_pkg).replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    const MASTER_PROMPT = `
IDENTITY & ROLE
You are a professional AI receptionist for ${biz_name}. Follow business rules exactly and never guess.
If website info conflicts with caller, defer to the caller and offer to take a message.

STYLE
- Warm, calm, concise, human. Do not mention you are an AI.
- Do not invent facts. Confidently admit if you don't know something.
`.trim();

    const BUSINESS_PROFILE = `
BUSINESS PROFILE
- Business Name: ${biz_name}
- Package: ${package_suffix}
- Email: ${biz_email}
- Website: ${website_url}
- Services: ${services}

${website_content ? `WEBSITE-DERIVED CONTEXT (REFERENCE ONLY):
---
${website_content}
---` : ""}

RECEPTIONIST PACKAGE SCHEDULING POLICY:
If package_type is "custom" OR "receptionist", you do NOT book appointments without a valid Calendar Link.
If "Not provided", you must take a message for a callback instead.

ACTIVE PROTOCOLS:
${emergency_details !== "Not provided" ? `- EMERGENCY: ${emergency_details}` : ""}
- SCHEDULING: ${finalized_scheduling}
${intake_details !== "Not provided" ? `- JOB INTAKE: ${intake_details}` : ""}

IF ANY FIELD IS "Not provided": ask the caller or offer to take a message.
`.trim();

    const llmResp = await axios.post("https://api.retellai.com/create-retell-llm", {
        general_prompt: `${MASTER_PROMPT}\n\n${BUSINESS_PROFILE}`,
        begin_message: pick(body, ["greeting"], `Hi! Thanks for calling ${biz_name}. How can I help you today?`),
        model: "gpt-4o-mini",
    }, { headers });

    const agentResp = await axios.post("https://api.retellai.com/create-agent", {
        agent_name: `${biz_name} - ${package_suffix}`,
        voice_id: pick(body, ["voice_id"], process.env.DEFAULT_VOICE_ID),
        response_engine: { type: "retell-llm", llm_id: llmResp.data.llm_id },
    }, { headers });

    return res.status(200).json({ ok: true, agent_id: agentResp.data.agent_id });
  } catch (error) {
    return res.status(500).json({ error: "Provisioning Failed", details: error.message });
  }
};
