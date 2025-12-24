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

// ✅ Fix 1: Extract URL even if it has extra text around it
function extractFirstUrl(text) {
  if (!text) return null;
  const m = String(text).match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : null;
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

// ✅ Fix 2: Enhanced Scraper with Logging & Proxy Fallback
async function getWebsiteContext(url) {
  if (!url || url === "Not provided") return null;

  // Extract clean URL from potentially messy input
  if (!url.startsWith("http")) {
    const extracted = extractFirstUrl(url);
    if (extracted) url = extracted;
    else return null;
  }

  // Normalize trailing slash
  if (!url.endsWith("/")) url = url + "/";

  // 1) Try direct fetch with logging
  try {
    const response = await axios.get(url, {
      timeout: 9000,
      maxRedirects: 5,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });

    const html = response.data || "";
    const textOnly = html
      .replace(/<script[^>]*>([\s\S]*?)<\/script>/gim, "")
      .replace(/<style[^>]*>([\s\S]*?)<\/style>/gim, "")
      .replace(/<nav[^>]*>([\s\S]*?)<\/nav>/gim, "")
      .replace(/<footer[^>]*>([\s\S]*?)<\/footer>/gim, "")
      .replace(/<[^>]*>?/gm, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (textOnly.length >= 200) {
      console.log("Direct scrape success:", { url, length: textOnly.length });
      return textOnly.substring(0, 2000);
    }
  } catch (e) {
    console.log("Direct fetch failed, trying proxy:", { url, status: e?.response?.status, message: e?.message });
  }

  // 2) Fallback: Reliable Proxy (Jina AI Reader)
  try {
    const proxyUrl = `https://r.jina.ai/${url}`;
    const r = await axios.get(proxyUrl, { timeout: 9000 });
    const txt = String(r.data || "").replace(/\s+/g, " ").trim();
    if (txt.length >= 200) {
      console.log("Proxy scrape success:", { url, length: txt.length });
      return txt.substring(0, 2000);
    }
  } catch (e) {
    console.log("Proxy fetch failed:", { url, message: e?.message });
  }

  return null;
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
    const website_input = pick(body, ["website"]);
    const website_content = await getWebsiteContext(website_input);

    const website_url = cleanValue(website_input);
    const contact_name = cleanValue(pick(body, ["name", "main_contact_name"]));
    const biz_email = cleanValue(pick(body, ["business_email"]));
    const biz_phone = cleanValue(pick(body, ["business_phone"]));
    const service_area = cleanValue(pick(body, ["service_area"]));
    const business_hours = cleanValue(pick(body, ["business_hours"]));
    const services = cleanValue(pick(body, ["services"])).replace("aspahlt", "asphalt");
    const extra_info = cleanValue(pick(body, ["extra_info"]));
    const time_zone = cleanValue(pick(body, ["time_zone"]));

    const emergency_details = cleanValue(pick(body, ["emergency_dispatch_questions"])).replace("floor", "flood");
    const scheduling_details = cleanValue(pick(body, ["scheduling_details"])).replace("Calandar", "Calendar");
    const intake_details = cleanValue(pick(body, ["job_intake_details"])).replace("[Location]", "[Service address or city/town]");
    
    const raw_pkg = pick(body, ["package_type"], "Receptionist");
    const package_type = String(raw_pkg).toLowerCase();
    const package_suffix = String(raw_pkg).replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    const MASTER_PROMPT = `
IDENTITY & ROLE
You are Ava for ${biz_name}. Follow business rules exactly and never guess.
If website info conflicts with caller, defer to the caller and take a message.

STYLE
- Warm, concise, human. Do not invent facts.

GOAL
- Help inbound callers quickly or take a message.
`.trim();

    const BUSINESS_PROFILE = `
BUSINESS PROFILE
- Business Name: ${biz_name}
- Website: ${website_url}
- Business Hours: ${business_hours}
- Services: ${services}

${website_content ? `WEBSITE-DERIVED CONTEXT (REFERENCE ONLY):
---
${website_content}
---` : ""}

RECEPTIONIST PACKAGE SCHEDULING POLICY (DO NOT OVERRIDE):
If package_type is "custom" OR "receptionist", you do NOT book appointments without a Calendar Link.
Empty or "Not provided" values indicate scheduling is NOT enabled.

ACTIVE PROTOCOLS:
${emergency_details !== "Not provided" ? `- EMERGENCY DISPATCH: ${emergency_details}` : ""}
${scheduling_details !== "Not provided" ? `- SCHEDULING: ${scheduling_details}` : ""}
${intake_details !== "Not provided" ? `- JOB INTAKE: ${intake_details}` : ""}

IF ANY FIELD IS "Not provided": ask or take a message.
`.trim();

    const FINAL_PROMPT = `${MASTER_PROMPT}\n\n${BUSINESS_PROFILE}`;

    const llmResp = await axios.post("https://api.retellai.com/create-retell-llm", {
        general_prompt: FINAL_PROMPT,
        begin_message: pick(body, ["greeting"], `Hi! Thanks for calling ${biz_name}. How can I help you?`),
        model: "gpt-4o-mini",
    }, { headers, timeout: 15000 });

    const agentResp = await axios.post("https://api.retellai.com/create-agent", {
        agent_name: `${biz_name} - ${package_suffix}`,
        voice_id: pick(body, ["voice_id"], process.env.DEFAULT_VOICE_ID),
        response_engine: { type: "retell-llm", llm_id: llmResp.data.llm_id },
    }, { headers, timeout: 15000 });

    return res.status(200).json({ ok: true, agent_id: agentResp.data.agent_id });
  } catch (error) {
    return res.status(500).json({ error: "Provisioning Failed", details: error?.response?.data || error?.message });
  }
};
