const axios = require("axios");

// --- HELPERS ---
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

function uniq(arr) {
  return Array.from(new Set((arr || []).map(x => String(x).trim()).filter(Boolean)));
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
  if (!text || text === "[]" || text === "No data" || text === "" || text === "/" || text === "null")
    return "Not provided";
  return String(text).replace(/\[\]/g, "Not provided");
}

// --- URL NORMALIZATION ---
function extractFirstUrl(text) {
  if (!text) return null;
  const m = String(text).match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : null;
}

function normalizeWebsite(raw) {
  if (!raw || raw === "Not provided") return "Not provided";
  if (typeof raw === "object" && raw.output) raw = raw.output;
  raw = String(raw).trim();
  if (!raw) return "Not provided";

  const extracted = extractFirstUrl(raw);
  if (extracted) return extracted;

  if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(raw)) return `https://${raw}`;
  return raw.startsWith("http") ? raw : "Not provided";
}

// --- WEBSITE SCRAPER + QUALITY FILTER ---
function looksLikeCode(text) {
  const t = (text || "").slice(0, 1200).toLowerCase();
  const codeHits = [
    "@keyframes", "view-transition", "webkit", "transform:", "opacity:",
    "{", "}", "::", "function(", "window.", "document."
  ];
  return codeHits.filter(k => t.includes(k)).length >= 2;
}

async function getWebsiteContext(url) {
  if (!url || url === "Not provided") return null;

  try {
    const response = await axios.get(url, {
      timeout: 8000,
      maxRedirects: 5,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
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
    if (text.length >= 200 && !looksLikeCode(text)) return text.substring(0, 2000);
  } catch (e) {
    // fall through to Jina
  }

  try {
    const proxyUrl = `https://r.jina.ai/${url.replace(/^https?:\/\//, "https://")}`;
    const r = await axios.get(proxyUrl, { timeout: 9000 });
    const txt = decodeHtml(String(r.data || "")).replace(/\s+/g, " ").trim();
    if (txt.length >= 200 && !looksLikeCode(txt)) return txt.substring(0, 2000);
  } catch (e) {
    return null;
  }
  return null;
}

// --- FACT EXTRACTOR ---
function extractIncludingAreas(text) {
  const m = text.match(/including\s+([A-Za-z,\s]+?)(?:and\s+surrounding|surrounding|area|towns|cities|\.)/i);
  if (!m || !m[1]) return [];
  return uniq(m[1].split(",").map(s => s.trim()).filter(s => s.length >= 3)).slice(0, 10);
}

function extractCommaPlaceLists(text) {
  const m = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)(?:,\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)+\b/g);
  return m ? m.slice(0, 2) : [];
}

function extractEstablished(text) {
  return (
    text.match(/\bestablished\s+in\s+\d{4}\b/i) ||
    text.match(/\bsince\s+\d{4}\b/i) ||
    text.match(/\bfounded\s+\d{4}\b/i) ||
    []
  )[0] || null;
}

function buildWebsiteFacts(text, businessTypeHint = "") {
  if (!text) return "";
  const raw = String(text);
  const lower = raw.toLowerCase();

  const areas = uniq([
    ...extractIncludingAreas(raw),
    ...extractCommaPlaceLists(raw).join(", ").split(",").map(s => s.trim())
  ]).filter(a => a.length >= 3).slice(0, 10);

  const tradeBoosters = {
    hvac: ["air conditioning", "ac", "heating", "furnace", "boiler", "heat pump", "duct"],
    plumbing: ["drain", "pipe", "leak", "water heater", "sewer", "toilet", "faucet", "sump pump"],
    electrical: ["panel", "breaker", "wiring", "generator", "lighting", "outlet", "ev charger"],
    paving: ["asphalt", "paving", "sealcoating", "patch", "crack filling", "line painting", "excavation", "curbing", "sidewalk", "hauling", "snow removal"],
    roofing: ["roof", "shingle", "flat roof", "leak repair", "siding", "gutters"]
  };

  const hint = String(businessTypeHint || "").toLowerCase();
  let booster = [];
  for (const key of Object.keys(tradeBoosters)) {
    if (hint.includes(key)) booster = tradeBoosters[key];
  }

  const generic = ["repair", "installation", "maintenance", "service", "free estimate", "free quote", "residential", "commercial"];
  const services = uniq([...booster, ...generic]).filter(k => lower.includes(k)).slice(0, 10);

  const established = extractEstablished(raw);
  const lines = [];
  if (areas.length) lines.push(`- Service area mentioned: ${areas.join(", ")}.`);
  if (services.length) lines.push(`- Services mentioned: ${services.join(", ")}.`);
  if (established) lines.push(`- Business history: ${established}.`);
  if (lower.includes("free quote") || lower.includes("free estimate")) lines.push(`- Offers: free quotes/estimates.`);

  return lines.length ? `WEBSITE FACTS (FAST REFERENCE):\n${lines.join("\n")}` : "";
}

// --- MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const body = await readJsonBody(req);
    const RETELL_API_KEY = process.env.RETELL_API_KEY;
    const headers = { Authorization: `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" };

    const biz_name = pick(body, ["business_name", "businessName"], "the business");
    const biz_type = cleanValue(pick(body, ["primary_type_of_business", "business_industry", "industry"], ""));

    const website_url = normalizeWebsite(pick(body, ["website"], "Not provided"));
    const website_content = await getWebsiteContext(website_url);
    const structured_facts = buildWebsiteFacts(website_content, biz_type);

    let scheduling = String(cleanValue(pick(body, ["scheduling_details"], ""))).replace("Calandar", "Calendar");
    if (!/https?:\/\/\S+/i.test(scheduling)) {
      scheduling = "Calendar Link: Not provided. Scheduling is NOT enabled. Take a message for a callback.";
    }

    const emergency = cleanValue(pick(body, ["emergency_dispatch_questions"], "Not provided"));
    const intake = cleanValue(pick(body, ["job_intake_details"], "Not provided"));
    const excerpt = website_content ? website_content.substring(0, 800) : "No website data found.";

    const FINAL_PROMPT = `
IDENTITY: Ava, professional AI receptionist for ${biz_name}.
STYLE: Warm, human, concise. Never guess. If unsure, ask briefly or take a message.

${structured_facts}

RAW WEBSITE EXCERPT (IF NEEDED):
---
${excerpt}
---

SCHEDULING: ${scheduling}
EMERGENCY: ${emergency}
INTAKE: ${intake}

RULE: If a caller asks to book, collect preferred windows and callback number. Do NOT confirm a time.
`.trim();

    const llmResp = await axios.post(
      "https://api.retellai.com/create-retell-llm",
      {
        general_prompt: FINAL_PROMPT,
        begin_message: pick(body, ["greeting"], `Hi, thanks for calling ${biz_name}.`),
        model: "gpt-4o-mini",
      },
      { headers }
    );

    const agentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        agent_name: `${biz_name} Agent`,
        voice_id: pick(body, ["voice_id"], process.env.DEFAULT_VOICE_ID),
        response_engine: { type: "retell-llm", llm_id: llmResp.data.llm_id },
      },
      { headers }
    );

    return res.status(200).json({
      ok: true,
      agent_id: agentResp.data.agent_id,
      website_context_included: Boolean(website_content),
      website_url_used: website_url,
      facts_included: Boolean(structured_facts),
    });
  } catch (error) {
    return res.status(500).json({ error: error?.response?.data || error?.message || "Unknown error" });
  }
};
