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
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

const decodeHtml = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");

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
  if (!t || t === "[]" || t === "No data" || t === "/" || t === "null" || t.toLowerCase() === "not provided")
    return "Not provided";
  return t.replace(/\[\]/g, "Not provided");
}

function uniq(arr) {
  return Array.from(new Set((arr || []).map(x => String(x).trim()).filter(Boolean)));
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
  const codeHits = ["@keyframes", "view-transition", "webkit", "transform:", "opacity:", "{", "}", "::", "function(", "window.", "document."];
  return codeHits.filter(k => t.includes(k)).length >= 2;
}

async function getWebsiteContext(url) {
  if (!url || url === "Not provided") return null;
  try {
    const response = await axios.get(url, {
      timeout: 8000,
      maxRedirects: 5,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    let text = String(response.data || "")
      .replace(/<script[^>]*>([\s\S]*?)<\/script>/gim, "")
      .replace(/<style[^>]*>([\s\S]*?)<\/style>/gim, "")
      .replace(/<header[^>]*>([\s\S]*?)<\/header>/gim, "")
      .replace(/<nav[^>]*>([\s\S]*?)<\/nav>/gim, "")
      .replace(/<footer[^>]*>([\s\S]*?)<\/footer>/gim, "")
      .replace(/<form[^>]*>([\s\S]*?)<\/form>/gim, "")
      .replace(/<[^>]*>?/gm, " ").replace(/\s+/g, " ").trim();

    text = decodeHtml(text);
    if (text.length >= 200 && !looksLikeCode(text)) return text.substring(0, 2000);
  } catch (e) { /* fall through */ }

  try {
    const proxyUrl = `https://r.jina.ai/${url.replace(/^https?:\/\//, "https://")}`;
    const r = await axios.get(proxyUrl, { timeout: 9000 });
    const txt = decodeHtml(String(r.data || "")).replace(/\s+/g, " ").trim();
    if (txt.length >= 200 && !looksLikeCode(txt)) return txt.substring(0, 2000);
  } catch (e) { return null; }
  return null;
}

// --- 3. SMART FACT EXTRACTION ---
function buildWebsiteFacts(text, businessTypeHint = "") {
  if (!text) return "";
  const raw = String(text);
  const lower = raw.toLowerCase();

  const tradeBoosters = {
    hvac: ["air conditioning", "ac", "heating", "furnace", "boiler", "heat pump", "duct repair"],
    plumbing: ["drain cleaning", "pipe repair", "leak detection", "water heater", "sewer", "sump pump"],
    paving: ["asphalt paving", "sealcoating", "patchwork", "crack filling", "line painting", "excavation", "curbing", "sidewalks", "snow removal"],
    roofing: ["roof repair", "shingle replacement", "flat roof", "leak repair", "siding", "gutters"]
  };

  let booster = [];
  const hint = String(businessTypeHint || "").toLowerCase();
  for (const key of Object.keys(tradeBoosters)) { if (hint.includes(key)) booster = tradeBoosters[key]; }

  if (!booster.length) {
    if (lower.includes("asphalt") || lower.includes("paving") || lower.includes("sealcoating")) booster = tradeBoosters.paving;
    else if (lower.includes("plumbing") || lower.includes("drain")) booster = tradeBoosters.plumbing;
    else if (lower.includes("hvac") || lower.includes("furnace")) booster = tradeBoosters.hvac;
  }

  const allPossible = Array.from(new Set([...booster, "repair", "installation", "maintenance", "service", "emergency service", "free estimate"]));
  const services = allPossible.filter(k => {
    const kk = k.toLowerCase();
    if (lower.includes(kk)) return true;
    const token = kk.split(" ").sort((a,b) => b.length - a.length)[0];
    return token && token.length >= 5 && lower.includes(token);
  }).slice(0, 12);

  return services.length ? `WEBSITE FACTS:\n- Services: ${services.join(", ")}.` : "";
}

// --- 4. MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const body = await readJsonBody(req);
    const headers = { "Authorization": `Bearer ${process.env.RETELL_API_KEY}`, "Content-Type": "application/json" };

    const biz_name = pick(body, ["business_name"], "the business");
    const biz_type = cleanValue(pick(body, ["primary_type_of_business", "industry"], ""));
    const website_url = normalizeWebsite(pick(body, ["website"], "Not provided"));
    const website_content = await getWebsiteContext(website_url);
    const structured_facts = buildWebsiteFacts(website_content, biz_type);

    let scheduling = String(cleanValue(pick(body, ["scheduling_details"], ""))).replace("Calandar", "Calendar");
    if (!/https?:\/\/\S+/i.test(scheduling)) {
      scheduling = "Calendar Link: Not provided. Scheduling is NOT enabled. Take a message for a callback.";
    }

    const FINAL_PROMPT = `
IDENTITY:
- You are Allie with ${biz_name}.
- If asked "who are you?", say: "This is Allie with ${biz_name}."
- Do NOT volunteer that you are an AI. Only acknowledge if explicitly asked.

STYLE: Warm, human, concise.

${structured_facts}

RAW WEBSITE EXCERPT:
---
${website_content ? website_content.substring(0, 800) : "No website data found."}
---

SCHEDULING: ${scheduling}
EMERGENCY: ${cleanValue(pick(body, ["emergency_dispatch_questions"]))}
INTAKE: ${cleanValue(pick(body, ["job_intake_details"]))}

RULE: If a caller asks to book, collect preferred windows and callback number. Do NOT confirm a time.
`.trim();

    // ✅ UPDATE: LLM Creation with Suffix for visibility
    const llmResp = await axios.post("https://api.retellai.com/create-retell-llm", {
        general_prompt: FINAL_PROMPT,
        begin_message: cleanValue(pick(body, ["greeting"], `Hi, thanks for calling ${biz_name}.`)),
        model: "gpt-4o-mini",
    }, { headers });

    // ✅ UPDATE: llm_id Sanity Check
    const llm_id = llmResp?.data?.llm_id;
    if (!llm_id) throw new Error("Retell failed to provide an llm_id.");

    const timestamp = new Date().toISOString().slice(0,16).replace(/[:T]/g,"");
    const agentResp = await axios.post("https://api.retellai.com/create-agent", {
        agent_name: `${biz_name} Agent - ${timestamp}`,
        voice_id: pick(body, ["voice_id"], process.env.DEFAULT_VOICE_ID),
        response_engine: { type: "retell-llm", llm_id: llm_id },
        metadata: { 
          notify_phone: pick(body, ["notify_phone", "cell_phone"]), 
          client_email: pick(body, ["email_for_call_summaries", "email"]),
          business_name: biz_name 
        }
    }, { headers });

    return res.status(200).json({ ok: true, agent_id: agentResp.data.agent_id });

  } catch (error) {
    // ✅ UPDATE: Real Error Details
    return res.status(500).json({ 
      error: "Provisioning Failed", 
      details: error?.response?.data || error?.message || String(error) 
    });
  }
};
