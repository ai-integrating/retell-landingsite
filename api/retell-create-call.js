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
      try { resolve(data ? JSON.parse(data) : {}); } 
      catch { resolve({}); }
    });
  });
}

function extractFirstUrl(text) {
  if (!text) return null;
  const m = String(text).match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : null;
}

function normalizeWebsite(raw) {
  if (!raw || raw === "Not provided") return "Not provided";
  if (typeof raw === "object" && raw.output) raw = raw.output;
  raw = String(raw).trim();
  const extracted = extractFirstUrl(raw);
  if (extracted) return extracted;
  if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(raw)) return `https://${raw}`;
  return raw.startsWith("http") ? raw : "Not provided";
}

const decodeHtml = (s) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");

// ✅ FIX 1: Add back the Code-Junk Filter
function looksLikeCode(text) {
  const t = (text || "").slice(0, 1200).toLowerCase();
  const codeHits = ["@keyframes", "view-transition", "webkit", "transform:", "opacity:", "{", "}", "::", "function(", "window.", "document."];
  return codeHits.filter(k => t.includes(k)).length >= 2;
}

function cleanValue(text) {
  if (!text || text === "[]" || text === "" || text === "/" || text === "null") return "Not provided";
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

async function getWebsiteContext(url) {
  if (!url || url === "Not provided") return null;
  
  // 1) Direct Fetch with Heavy Stripping
  try {
    const response = await axios.get(url, {
      timeout: 8000,
      maxRedirects: 5,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      },
    });
    let text = response.data
      .replace(/<script[^>]*>([\s\S]*?)<\/script>/gim, "")
      .replace(/<style[^>]*>([\s\S]*?)<\/style>/gim, "")
      .replace(/<header[^>]*>([\s\S]*?)<\/header>/gim, "")
      .replace(/<nav[^>]*>([\s\S]*?)<\/nav>/gim, "")
      .replace(/<footer[^>]*>([\s\S]*?)<\/footer>/gim, "")
      .replace(/<form[^>]*>([\s\S]*?)<\/form>/gim, "")
      .replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();

    text = decodeHtml(text);
    if (text.length >= 200 && !looksLikeCode(text)) return text.substring(0, 2000);
  } catch (e) { console.log("Direct fetch failed, trying proxy..."); }

  // 2) ✅ FIX 2: Correct Jina Proxy URL Format
  try {
    const proxyUrl = `https://r.jina.ai/${url.replace(/^https?:\/\//, "https://")}`;
    const r = await axios.get(proxyUrl, { timeout: 9000 });
    const txt = String(r.data || "").replace(/\s+/g, " ").trim();
    const cleanTxt = decodeHtml(txt);
    if (cleanTxt.length >= 200 && !looksLikeCode(cleanTxt)) return cleanTxt.substring(0, 2000);
  } catch (e) { return null; }
  return null;
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" }); // ✅ Explicit 405

  try {
    const body = await readJsonBody(req);
    const RETELL_API_KEY = process.env.RETELL_API_KEY;
    const headers = { "Authorization": `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" };

    const biz_name = pick(body, ["business_name", "businessName"], "the business");
    const website_url = normalizeWebsite(pick(body, ["website"]));
    const website_content = await getWebsiteContext(website_url);

    // ✅ FIX 3: Robust Scheduling & Prompt Integrity
    let scheduling = cleanValue(pick(body, ["scheduling_details"])).replace("Calandar", "Calendar");
    if (!/https?:\/\/\S+/i.test(scheduling)) {
      scheduling = "Calendar Link: Not provided. Scheduling is NOT enabled. Take a message for a callback.";
    }

    const FINAL_PROMPT = `
IDENTITY: Ava, professional AI receptionist for ${biz_name}.
STYLE: Warm, human, concise. Never guess. If info is missing or unclear, ask briefly; otherwise take a message and confirm callback details.
WEBSITE CONTEXT (REFERENCE ONLY):
---
${website_content || "No additional website context available."}
---
SCHEDULING: ${scheduling}
EMERGENCY: ${cleanValue(pick(body, ["emergency_dispatch_questions"]))}
INTAKE: ${cleanValue(pick(body, ["job_intake_details"]))}
`.trim();

    const llmResp = await axios.post("https://api.retellai.com/create-retell-llm", {
        general_prompt: FINAL_PROMPT,
        begin_message: pick(body, ["greeting"], `Hi, thanks for calling ${biz_name}.`),
        model: "gpt-4o-mini",
    }, { headers });

    const agentResp = await axios.post("https://api.retellai.com/create-agent", {
        agent_name: `${biz_name} Agent`,
        voice_id: pick(body, ["voice_id"], process.env.DEFAULT_VOICE_ID),
        response_engine: { type: "retell-llm", llm_id: llmResp.data.llm_id },
    }, { headers });

    return res.status(200).json({ 
      ok: true, 
      agent_id: agentResp.data.agent_id, 
      website_context_included: Boolean(website_content),
      website_url_used: website_url
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
