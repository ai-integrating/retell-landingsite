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

// ✅ STEP 1: JUNK DETECTION HELPERS
function normalize(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isJunk(val) {
  const v = normalize(val);
  if (!v) return true;
  return ["not provided", "no data", "n a", "na", "none", "idk", "test", "asdf", "/"].includes(v) || v.length < 3;
}

function looksLikeBizName(val, bizName) {
  const v = normalize(val);
  const b = normalize(bizName);
  if (!v || !b) return false;
  return v === b || v.includes(b) || b.includes(v);
}

function isGood(val, bizName) {
  return !isJunk(val) && !looksLikeBizName(val, bizName);
}

// ✅ STEP 2: WEBSITE INFERENCE LOGIC
function inferFromWebsite(text) {
  if (!text) return {};
  const t = text.toLowerCase();
  
  const serviceKeywords = [
    "paving", "sealcoating", "patch", "crack", "line painting", "excavation",
    "curbing", "sidewalk", "snow removal", "hauling", "driveway", "parking lot"
  ];
  const foundServices = serviceKeywords.filter(k => t.includes(k));

  let area = null;
  const m = text.match(/including\s+([A-Za-z,\s]+?)\s+(and\s+surrounding|surrounding|area)/i);
  if (m && m[1]) area = m[1].replace(/\s+/g, " ").trim();

  let hours = null;
  const hm = text.match(/(mon|monday)\s*[-–to]+\s*(fri|friday)[^\.]{0,40}(\d{1,2}(:\d{2})?\s*(am|pm)?)[^\.]{0,40}(\d{1,2}(:\d{2})?\s*(am|pm)?)/i);
  if (hm) hours = hm[0].replace(/\s+/g, " ").trim();

  return {
    inferred_services: foundServices.length ? foundServices.join(", ") : null,
    inferred_service_area: area || null,
    inferred_hours: hours || null
  };
}

const decodeHtml = (s) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");

async function getWebsiteContext(urlInput) {
  if (!urlInput || urlInput === "/" || urlInput.length < 5) return null;
  const url = urlInput.startsWith("http") ? urlInput : `https://${urlInput}`;
  try {
    const response = await axios.get(url, { timeout: 8000 });
    let textOnly = response.data.replace(/<script[^>]*>([\s\S]*?)<\/script>/gim, "").replace(/<form[^>]*>([\s\S]*?)<\/form>/gim, "").replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
    return decodeHtml(textOnly).substring(0, 1800);
  } catch (e) {
    try {
      const r = await axios.get(`https://r.jina.ai/${url}`, { timeout: 8000 });
      return decodeHtml(String(r.data || "")).substring(0, 1800);
    } catch (err) { return null; }
  }
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const body = await readJsonBody(req);
    const RETELL_API_KEY = process.env.RETELL_API_KEY;
    const biz_name = body.business_name || "the business";
    const website_content = await getWebsiteContext(body.website);
    const inferred = inferFromWebsite(website_content);

    // ✅ STEP 3: APPLY HIERARCHY (Form > Website > Not provided)
    let services = body.services || "";
    if (!isGood(services, biz_name)) services = inferred.inferred_services || "Not provided";

    let business_hours = body.business_hours || "";
    if (!isGood(business_hours, biz_name)) business_hours = inferred.inferred_hours || "Not provided";

    let service_area = body.service_area || "";
    if (!isGood(service_area, biz_name)) service_area = inferred.inferred_service_area || "Not provided";

    // ✅ STEP 4: CREATE INFERENCE DISCLAIMER
    const inferredNote = [];
    if (services === inferred.inferred_services) inferredNote.push("Services");
    if (service_area === inferred.inferred_service_area) inferredNote.push("Service Area");
    if (business_hours === inferred.inferred_hours) inferredNote.push("Business Hours");
    const INFERENCE_DISCLAIMER = inferredNote.length 
      ? `\nNOTE: The following fields were inferred from the website due to missing/low-quality form inputs: ${inferredNote.join(", ")}. Confirm with the caller if they state otherwise.` 
      : "";

    const FINAL_PROMPT = `
IDENTITY & ROLE
You are Ava for ${biz_name}. Follow rules exactly.

BUSINESS PROFILE
- Name: ${biz_name}
- Hours: ${business_hours}
- Area: ${service_area}
- Services: ${services}
${INFERENCE_DISCLAIMER}

${website_content ? `WEBSITE CONTEXT:\n---\n${website_content}\n---` : ""}

SCHEDULING: ${body.scheduling_details || "Not enabled"}`.trim();

    const llmResp = await axios.post("https://api.retellai.com/create-retell-llm", {
        general_prompt: FINAL_PROMPT,
        begin_message: body.greeting || `Hi, thanks for calling ${biz_name}.`,
        model: "gpt-4o-mini",
    }, { headers: { Authorization: `Bearer ${RETELL_API_KEY}` } });

    const agentResp = await axios.post("https://api.retellai.com/create-agent", {
        agent_name: `${biz_name} Agent`,
        voice_id: body.voice_id || process.env.DEFAULT_VOICE_ID,
        response_engine: { type: "retell-llm", llm_id: llmResp.data.llm_id },
    }, { headers: { Authorization: `Bearer ${RETELL_API_KEY}` } });

    return res.status(200).json({ ok: true, agent_id: agentResp.data.agent_id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
