// /api/retell-create-call.js
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
      if (typeof val === "object" && val.output) return val.output;
      return val;
    }
  }
  return fallback;
}

function cleanValue(text) {
  const t = String(text || "").trim();
  if (
    !t ||
    t === "[]" ||
    t === "No data" ||
    t === "/" ||
    t === "null" ||
    t.toLowerCase() === "not provided"
  )
    return "Not provided";
  return t.replace(/\[\]/g, "Not provided");
}

function uniq(arr) {
  return Array.from(
    new Set((arr || []).map((x) => String(x).trim()).filter(Boolean))
  );
}

// --- ✅ VOICE RESOLUTION (MINIMAL & SAFE) ---
function resolveVoiceId(body) {
  // If Zap explicitly sends voice_id, use it
  const direct = pick(body, ["voice_id"], "");
  if (direct && direct !== "Not provided") return direct;

  const tone = String(pick(body, ["voice_tone"], "")).toLowerCase();
  const gender = String(pick(body, ["agent_gender"], "")).toLowerCase();

  const VOICE_MAP = {
    female_authoritative: process.env.Voice_Female_AUTHORITATIVE,
    female_warm: process.env.VOICE_FEMALE_WARM,
    female_calm: process.env.VOICE_FEMALE_CALM,
    female_energetic: process.env.VOICE_FEMALE_ENERGETIC,
    male_authoritative: process.env.VOICE_MALE_AUTHORITATIVE,
    male_warm: process.env.VOICE_MALE_WARM,
    male_calm: process.env.VOICE_MALE_CALM,
  };

  return VOICE_MAP[`${gender}_${tone}`] || process.env.DEFAULT_VOICE_ID;
}

// --- 2. URL & SCRAPER LOGIC ---
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

function looksLikeCode(text) {
  const t = (text || "").slice(0, 1200).toLowerCase();
  const codeHits = [
    "@keyframes",
    "view-transition",
    "webkit",
    "transform:",
    "opacity:",
    "{",
    "}",
    "::",
    "function(",
    "window.",
    "document.",
  ];
  return codeHits.filter((k) => t.includes(k)).length >= 2;
}

async function getWebsiteContext(url) {
  if (!url || url === "Not provided") return null;

  try {
    const response = await axios.get(url, {
      timeout: 8000,
      maxRedirects: 5,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    let text = String(response.data || "")
      .replace(/<script[^>]*>([\s\S]*?)<\/script>/gim, "")
      .replace(/<style[^>]*>([\s\S]*?)<\/style>/gim, "")
      .replace(/<header[^>]*>([\s\S]*?)<\/header>/gim, "")
      .replace(/<nav[^>]*>([\s\S]*?)<\/nav>/gim, "")
      .replace(/<footer[^>]*>([\s\S]*?)<\/footer>/gim, "")
      .replace(/<form[^>]*>([\s\S]*?)<\/form>/gim, "")
      .replace(/<[^>]*>?/gm, " ")
      .replace(/\s+/g, " ")
      .trim();

    text = decodeHtml(text);
    if (text.length >= 200 && !looksLikeCode(text))
      return text.substring(0, 2000);
  } catch {}

  try {
    const proxyUrl = `https://r.jina.ai/${url.replace(
      /^https?:\/\//,
      "https://"
    )}`;
    const r = await axios.get(proxyUrl, { timeout: 9000 });
    const txt = decodeHtml(String(r.data || ""))
      .replace(/\s+/g, " ")
      .trim();
    if (txt.length >= 200 && !looksLikeCode(txt))
      return txt.substring(0, 2000);
  } catch {}

  return null;
}

// --- 3. MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const body = await readJsonBody(req);

    const headers = {
      Authorization: `Bearer ${process.env.RETELL_API_KEY}`,
      "Content-Type": "application/json",
    };

    const biz_name = pick(body, ["business_name", "businessName"], "the business");
    const agent_name = pick(body, ["agent_name"], "Allie");

    const GREETING = `Thanks for calling ${biz_name}, this is ${agent_name}. How can I help you today?`;

    const website_url = normalizeWebsite(pick(body, ["website"], "Not provided"));
    const website_content = await getWebsiteContext(website_url);

    const FINAL_PROMPT = `
IDENTITY:
- You are ${agent_name} with ${biz_name}.
- If asked who you are, say: "This is ${agent_name} with ${biz_name}."
- Do not volunteer AI status unless asked.

STYLE: Human, calm, concise.

RAW WEBSITE CONTEXT:
${website_content || "No website data available."}
`.trim();

    const llmResp = await axios.post(
      "https://api.retellai.com/create-retell-llm",
      {
        general_prompt: FINAL_PROMPT,
        begin_message: GREETING,
        model: "gpt-4o-mini",
      },
      { headers }
    );

    const voiceId = resolveVoiceId(body);

    const agentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        agent_name: `${biz_name} Agent`,
        voice_id: voiceId,
        response_engine: {
          type: "retell-llm",
          llm_id: llmResp.data.llm_id,
        },
        metadata: {
          business_name: biz_name,
          notify_phone: pick(body, ["notify_phone", "cell_phone"]),
        },
      },
      { headers }
    );

    return res.status(200).json({
      ok: true,
      agent_id: agentResp.data.agent_id,
    });
  } catch (error) {
    console.error("retell-create-call failed:", error);
    return res.status(500).json({ error: "Server error" });
  }
};
