const axios = require("axios");
const crypto = require("crypto");

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
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

const decodeHtml = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
const uniq = (arr) => [...new Set((arr || []).filter(Boolean))];

function pick(obj, keys, fallback = "Not provided") {
  for (const k of keys) {
    let val = obj?.[k];
    if (val !== undefined && val !== null && val !== "" && val !== "No data") {
      if (typeof val === "object" && val.output !== undefined) return val.output;
      return val;
    }
  }
  return fallback;
}

// Handles Zapier flattened keys like "meta.agent_role" or "core__business_name"
function normalizeIncomingBody(rawBody) {
  if (!rawBody || typeof rawBody !== "object") return rawBody;
  const looksNested = rawBody.meta && typeof rawBody.meta === "object" && rawBody.core && typeof rawBody.core === "object";
  if (looksNested) return rawBody;
  const out = { ...rawBody };
  for (const [k, v] of Object.entries(rawBody)) {
    if (v === undefined) continue;
    if (k.includes(".")) {
      const parts = k.split(".").filter(Boolean);
      if (parts.length >= 2) setDeep(out, parts, v);
    } else if (k.includes("__")) {
      const parts = k.split("__").filter(Boolean);
      if (parts.length >= 2) setDeep(out, parts, v);
    }
  }
  return out;
}

function setDeep(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  obj[path[path.length - 1]] = value;
}

function pickCanonical(body, blockName, keys, legacyKeys = [], fallback = "Not provided") {
  const fromBlock = pick(body[blockName] || {}, keys, "__MISSING__");
  if (fromBlock !== "__MISSING__") return fromBlock;
  return pick(body, legacyKeys, fallback);
}

// --- 2. WEBSITE SCRAPER (PROVEN VERSION) ---
function extractFirstUrl(text) {
  if (!text) return null;
  const m = String(text).match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : null;
}

function normalizeWebsite(raw) {
  if (!raw || raw === "Not provided") return "";
  const extracted = extractFirstUrl(String(raw));
  if (extracted) return extracted;
  if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(raw)) return `https://${raw}`;
  return String(raw).startsWith("http") ? raw : "";
}

async function getWebsiteContext(url) {
  if (!url) return null;
  try {
    const response = await axios.get(url, {
      timeout: 8000,
      headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
    });
    let text = String(response.data || "")
      .replace(/<(script|style|header|nav|footer|form)[^>]*>([\s\S]*?)<\/\1>/gim, "")
      .replace(/<[^>]*>?/gm, " ").replace(/\s+/g, " ").trim();
    if (text.length >= 200) return decodeHtml(text).substring(0, 2000);
  } catch (e) { /* fall through to proxy */ }

  try {
    const proxyUrl = `https://r.jina.ai/${url.replace(/^https?:\/\//, "")}`;
    const r = await axios.get(proxyUrl, { timeout: 9000 });
    const txt = decodeHtml(String(r.data || "")).replace(/\s+/g, " ").trim();
    if (txt.length >= 200) return txt.substring(0, 2000);
  } catch (e) { return null; }
  return null;
}

function buildWebsiteFacts(text, hint = "") {
  if (!text) return "";
  const raw = String(text).toLowerCase();
  const areaMatch = raw.match(/including\s+([A-Za-z,\s]+?)(?:and\s+surrounding|area|towns|\.)/i);
  const areas = areaMatch ? areaMatch[1].split(",").map(s => s.trim()).filter(s => s.length >= 3).slice(0, 10) : [];
  const paving = ["asphalt paving", "sealcoating", "crack filling", "patchwork"].filter(k => raw.includes(k));
  
  const lines = [];
  if (areas.length) lines.push(`- Service area: ${areas.join(", ")}.`);
  if (paving.length) lines.push(`- Services: ${paving.join(", ")}.`);
  return lines.length ? `## WEBSITE FACTS\n${lines.join("\n")}` : "";
}

// --- 3. VOICE RESOLUTION ---
function resolveVoiceProfile(body) {
  const gender = String(pickCanonical(body, "meta", ["agent_gender"], ["agent_gender", "gender"], "female")).toLowerCase().trim();
  const tone = String(pickCanonical(body, "meta", ["voice_tone"], ["voice_tone", "tone"], "warm")).toLowerCase().trim();

  const VOICE_MAP = {
    female_authoritative: process.env.VOICE_FEMALE_AUTHORITATIVE,
    female_warm: process.env.VOICE_FEMALE_WARM,
    female_calm: process.env.VOICE_FEMALE_CALM,
    male_authoritative: process.env.VOICE_MALE_AUTHORITATIVE,
    male_warm: process.env.VOICE_MALE_WARM, // Fixed mapping
    male_calm: process.env.VOICE_MALE_CALM,
  };

  return VOICE_MAP[`${gender}_${tone}`] || process.env.DEFAULT_VOICE_ID;
}

// --- 4. MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    let body = await readJsonBody(req);
    body = normalizeIncomingBody(body);

    // --- MISSING FIELD DETECTOR ---
    const missing = [];
    if (pickCanonical(body, "meta", ["agent_name"], ["agent_name"]) === "Not provided") missing.push("meta.agent_name");
    if (pickCanonical(body, "core", ["business_name"], ["business_name"]) === "Not provided") missing.push("core.business_name");
    if (pickCanonical(body, "core", ["time_zone"], ["time_zone"]) === "Not provided") missing.push("core.time_zone");

    // --- DATA CAPTURE ---
    const biz_name = pickCanonical(body, "core", ["business_name"], ["business_name"], "McDuffy and Son Asphalt");
    const agent_name = pickCanonical(body, "meta", ["agent_name"], ["agent_name"], "Samuel");
    const role = pickCanonical(body, "meta", ["agent_role"], ["agent_role"], "receptionist").toLowerCase();
    
    // Time Zone standardization (Core first, Scheduler fallback)
    const time_zone = pickCanonical(body, "core", ["time_zone"], ["time_zone", "timezone"], "") || 
                      pickCanonical(body, "scheduler", ["time_zone"], ["time_zone"], "America/New_York");

    const website_url = normalizeWebsite(pickCanonical(body, "core", ["website_url"], ["website"], ""));
    const website_raw = await getWebsiteContext(website_url);
    const website_facts = buildWebsiteFacts(website_raw, biz_name);

    // --- PROMPT ASSEMBLY ---
    const FINAL_PROMPT = `
## IDENTITY
You are ${agent_name}, a professional representative for ${biz_name}.
Role: ${role.toUpperCase()}.
Business Time Zone: ${time_zone}.

## BUSINESS CONTEXT
${website_facts}
- Business Name: ${biz_name}
- Services: ${pickCanonical(body, "core", ["home_service_type"], ["services"])}

## BASE RULES
- Do NOT mention you are an AI.
- Be concise (1-2 sentences).
- Current Local Time: ${time_zone}.
- Closing: "Someone will reach out soon. Have a great day."
`.trim();

    const llmResp = await axios.post("https://api.retellai.com/create-retell-llm", {
      general_prompt: FINAL_PROMPT,
      begin_message: `Thanks for calling ${biz_name}, this is ${agent_name}. How can I help?`,
      model: "gpt-4o-mini",
    }, { headers: { Authorization: `Bearer ${process.env.RETELL_API_KEY}`, "Content-Type": "application/json" } });

    const agentResp = await axios.post("https://api.retellai.com/create-agent", {
      agent_name: `${biz_name} - ${agent_name}`,
      voice_id: resolveVoiceProfile(body),
      response_engine: { type: "retell-llm", llm_id: llmResp.data.llm_id },
      metadata: { business_name: biz_name, role, missing_fields: missing }
    }, { headers: { Authorization: `Bearer ${process.env.RETELL_API_KEY}`, "Content-Type": "application/json" } });

    return res.status(200).json({ ok: true, agent_id: agentResp.data.agent_id, debug: { missing } });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
