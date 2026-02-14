// /api/retell-create-call.js
// Creates a Retell LLM + Agent + (optionally) purchases & binds an inbound phone number.
// NOTE: Uses Node-style responses (safe for Vercel serverless functions).

const axios = require("axios");

// --- 1. CORE UTILITIES ---
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (req.body && typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
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
      if (typeof val === "object" && val.output) return val.output; // Zapier-safe
      return val;
    }
  }
  return fallback;
}

// --- 2. VOICE RESOLUTION ---
function resolveVoiceId(body) {
  const tone = String(pick(body, ["voice_tone", "tone"], "warm")).toLowerCase().trim();
  const gender = String(pick(body, ["agent_gender", "gender"], "female")).toLowerCase().trim();

  const VOICE_MAP = {
    female_authoritative: process.env.VOICE_FEMALE_AUTHORITATIVE,
    female_warm: process.env.VOICE_FEMALE_WARM,
    female_calm: process.env.VOICE_FEMALE_CALM,
    female_energetic: process.env.VOICE_FEMALE_ENERGETIC,
    male_authoritative: process.env.VOICE_MALE_AUTHORITATIVE,
    male_warm: process.env.VOICE_MALE_WARM,
    male_calm: process.env.VOICE_MALE_CALM,
  };

  return VOICE_MAP[`${gender}_${tone}`] || process.env.DEFAULT_VOICE_ID;
}

// --- 3. SCRAPER UTILITIES ---
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
      .replace(/\s+/g, " ")
      .trim();
    return text.length >= 200 ? decodeHtml(text).substring(0, 2500) : null;
  } catch {
    return null;
  }
}

// --- 4. MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.end("ok");
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Use POST" });

  try {
    const body = await readJsonBody(req);

    const apiKey = process.env.RETELL_API_KEY;
    if (!apiKey) return json(res, 500, { ok: false, error: "Missing RETELL_API_KEY" });

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    const biz_name = pick(body, ["business_name", "company"], "our client");
    const agent_name = pick(body, ["agent_name", "name"], "Lexi");

    // A) Website scraper (optional)
    const website_url = normalizeWebsite(pick(body, ["website", "url", "web"]));
    let website_content = null;

    if (website_url !== "Not provided") {
      website_content = await Promise.race([
        getWebsiteContext(website_url),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 5000)),
      ]).catch(() => null);
    }

    // B) Prompt
    const pythonInstructions = pick(body, ["instructions", "agent_instructions"], "");
    let FINAL_PROMPT = pythonInstructions;

    if (!FINAL_PROMPT || FINAL_PROMPT === "Not provided") {
      FINAL_PROMPT = `## IDENTITY
- You are ${agent_name} for ${biz_name}.
- Rule: Do NOT mention AI.`;
    }

    if (website_content) {
      FINAL_PROMPT += `\n\n## WEBSITE KNOWLEDGE\n${website_content}`;
    }

    // C) Create Retell LLM
    const llmResp = await axios.post(
      "https://api.retellai.com/create-retell-llm",
      {
        general_prompt: FINAL_PROMPT,
        begin_message: pick(body, ["begin_message", "welcome_message"], "Hello!"),
        model: "gpt-4o-mini",
      },
      { headers }
    );

    // D) Create Retell Agent
    const agentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        agent_name: `${biz_name} Agent`,
        voice_id: resolveVoiceId(body),
        response_engine: { type: "retell-llm", llm_id: llmResp.data.llm_id },
      },
      { headers }
    );

    const agent_id = agentResp?.data?.agent_id;
    if (!agent_id) {
      return json(res, 500, { ok: false, error: "Retell did not return agent_id", agentResp: agentResp?.data });
    }

    // E) Optional: skip buying a number in test mode
    const mode = String(pick(body, ["mode"], "live")).toLowerCase().trim();
    if (mode !== "live") {
      return json(res, 200, { ok: true, agent_id, mode, note: "Skipped phone number purchase (mode != live)" });
    }

    // F) Buy & bind inbound phone number
    const area_code_raw = pick(body, ["area_code"], "");
    const area_code =
      area_code_raw && area_code_raw !== "Not provided"
        ? Number(String(area_code_raw).replace(/\D/g, "").slice(0, 3))
        : Number(process.env.DEFAULT_AREA_CODE || 508);

    const phoneResp = await axios.post(
      "https://api.retellai.com/create-phone-number",
      {
        inbound_agent_id: agent_id,
        area_code,
        nickname: `${biz_name} - ${agent_name}`,
      },
      { headers }
    );

    return json(res, 200, {
      ok: true,
      agent_id,
      phone_number: phoneResp?.data?.phone_number,
      phone_number_pretty: phoneResp?.data?.phone_number_pretty,
      mode,
    });
  } catch (error) {
    return json(res, 500, { ok: false, error: "Server error", details: error?.message || String(error) });
  }
};
