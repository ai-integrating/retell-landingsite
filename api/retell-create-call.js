const axios = require("axios");

// --- 1. CORE UTILITIES ---
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

// Ensure this utility is present to prevent scraper crashes
const decodeHtml = (s) =>
  String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

function pick(obj, keys, fallback = "Not provided") {
  for (const k of keys) {
    let val = obj?.[k];
    if (val !== undefined && val !== null && val !== "") {
      return val;
    }
  }
  return fallback;
}

// --- 2. SCRAPER UTILITIES ---
function normalizeWebsite(raw) {
  if (!raw || raw === "Not provided") return "Not provided";
  if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(raw)) return `https://${raw}`;
  return String(raw).startsWith("http") ? raw : "Not provided";
}

async function getWebsiteContext(url) {
  if (!url || url === "Not provided") return null;
  try {
    const response = await axios.get(url, { timeout: 4000 });
    let text = String(response.data || "")
      .replace(/<(script|style|header|nav|footer|form)[^>]*>([\s\S]*?)<\/\1>/gim, "")
      .replace(/<[^>]*>?/gm, " ")
      .replace(/\s+/g, " ").trim();
    return text.length >= 200 ? decodeHtml(text).substring(0, 2500) : null;
  } catch (e) {
    return null; 
  }
}

// --- 3. MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  
  try {
    const body = await readJsonBody(req);
    const headers = { 
      Authorization: `Bearer ${process.env.RETELL_API_KEY}`, 
      "Content-Type": "application/json" 
    };

    // Extract Metadata
    const biz_name = pick(body, ["business_name", "company"], "our client");
    const agent_name = pick(body, ["agent_name", "name"], "Lexi");

    // 1. Run Scraper with Timeout
    const website_url = normalizeWebsite(pick(body, ["website", "url", "web"]));
    let website_content = null;
    if (website_url !== "Not provided") {
      website_content = await Promise.race([
        getWebsiteContext(website_url),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 5000))
      ]).catch(() => null);
    }

    // 2. Build Final Prompt (The Handshake)
    const pythonInstructions = pick(body, ["instructions", "agent_instructions"], "");
    let FINAL_PROMPT = pythonInstructions;
    
    if (website_content) {
      FINAL_PROMPT += `\n\n## WEBSITE KNOWLEDGE\n${website_content}`;
    }

    // 3. Create Retell LLM
    const llmResp = await axios.post("https://api.retellai.com/create-retell-llm", {
      general_prompt: FINAL_PROMPT,
      begin_message: pick(body, ["begin_message", "welcome_message"], "Hello!"),
      model: "gpt-4o-mini",
    }, { headers });

    // 4. Create Retell Agent
    const agentResp = await axios.post("https://api.retellai.com/create-agent", {
      agent_name: `${biz_name} Agent`,
      voice_id: process.env.DEFAULT_VOICE_ID,
      response_engine: { type: "retell-llm", llm_id: llmResp.data.llm_id },
    }, { headers });

    return res.status(200).json({ ok: true, agent_id: agentResp.data.agent_id });

  } catch (error) {
    return res.status(500).json({ error: "Server error", details: error.message });
  }
};
