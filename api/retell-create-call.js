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

// ✅ CLEANUP: Decode HTML entities for professional context
const decodeHtml = (s) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");

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
  try {
    const response = await axios.get(url, {
      timeout: 8000,
      headers: { "User-Agent": "Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36", "Accept": "text/html" }
    });
    let text = response.data.replace(/<script[^>]*>([\s\S]*?)<\/script>/gim, "").replace(/<style[^>]*>([\s\S]*?)<\/style>/gim, "").replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
    return decodeHtml(text).substring(0, 2000);
  } catch (e) {
    try {
      const r = await axios.get(`https://r.jina.ai/${url}`, { timeout: 9000 });
      return decodeHtml(String(r.data || "")).substring(0, 2000);
    } catch (err) { return null; }
  }
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

    let scheduling = cleanValue(pick(body, ["scheduling_details"])).replace("Calandar", "Calendar");
    if (!/https?:\/\/\S+/i.test(scheduling)) {
      scheduling = "Calendar Link: Not provided. Scheduling is NOT enabled. Take a message for a callback.";
    }

    const FINAL_PROMPT = `
IDENTITY: Ava, professional AI receptionist for ${biz_name}.
STYLE: Warm, human, concise. Never guess.
WEBSITE CONTEXT (REFERENCE ONLY):
---
${website_content || "No website data found."}
---
SCHEDULING: ${scheduling}
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

    // ✅ NEW: Diagnostic response for Zapier
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
