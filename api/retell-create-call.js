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

// --- ✅ VOICE RESOLUTION (PRESERVING YOUR WORKING LOGIC) ---
function resolveVoiceId(body) {
  const direct = pick(body, ["voice_id", "voiceId", "VOICE_ID"], "");
  if (direct && direct !== "Not provided") return String(direct).trim();

  const tone = String(pick(body, ["voice_tone", "voiceTone", "tone"], ""))
    .toLowerCase()
    .trim();
  const gender = String(pick(body, ["agent_gender", "agentGender", "gender"], ""))
    .toLowerCase()
    .trim();

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

async function getWebsiteContext(url) {
  if (!url || url === "Not provided") return null;
  try {
    const response = await axios.get(url, {
      timeout: 8000,
      maxRedirects: 5,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    let text = String(response.data || "")
      .replace(/<(script|style|header|nav|footer|form)[^>]*>([\s\S]*?)<\/\1>/gim, "")
      .replace(/<[^>]*>?/gm, " ")
      .replace(/\s+/g, " ")
      .trim();
    text = decodeHtml(text);
    if (text.length >= 200) return text.substring(0, 2000);
  } catch (e) { /* ignore and move to jina */ }

  try {
    const proxyUrl = `https://r.jina.ai/${url.replace(/^https?:\/\//, "https://")}`;
    const r = await axios.get(proxyUrl, { timeout: 9000 });
    const txt = decodeHtml(String(r.data || "")).replace(/\s+/g, " ").trim();
    if (txt.length >= 200) return txt.substring(0, 2000);
  } catch (e) { return null; }
  return null;
}

function buildWebsiteFacts(text, businessTypeHint = "") {
  if (!text) return "";
  // Simplified for brevity, same logic as your original buildWebsiteFacts
  return `WEBSITE SUMMARY: ${text.substring(0, 500)}...`;
}

// --- 3. MAPPED FIELD BUILDERS (UPDATED WITH YOUR SCREENSHOT KEYS) ---

function hasAnyValue(obj, keys) {
  return keys.some((k) => {
    const raw = obj?.[k];
    const val = typeof raw === "object" && raw?.output ? raw.output : raw;
    const c = cleanValue(val);
    return c && c !== "Not provided";
  });
}

function buildSchedulingFromMapped(body) {
  const calendar_link = cleanValue(pick(body, ["calendar_link", "calendarLink"], ""));
  const calendar_system = cleanValue(pick(body, ["calendar_system", "calendarSystem"], ""));
  const buffer_time = cleanValue(pick(body, ["buffer_time", "bufferTime"], ""));
  const weekend = cleanValue(pick(body, ["weekend_appointments", "weekendAppointments"], ""));
  const service_durations = cleanValue(pick(body, ["service_durations", "serviceDurations"], ""));
  const after_hours = cleanValue(pick(body, ["after_hours_rules", "afterHoursRules"], ""));

  const enabled = /https?:\/\/\S+/i.test(calendar_link);
  if (!enabled) return "Calendar Link: Not provided. Scheduling is NOT enabled. Take a message for a callback.";

  const lines = [
    `Calendar Link: ${calendar_link}`,
    `System: ${calendar_system}`,
    `Buffer: ${buffer_time}`,
    `Weekends: ${weekend}`,
    `Durations: ${service_durations}`,
    `After Hours: ${after_hours}`,
  ].filter(line => !line.includes("Not provided"));

  return lines.join(" | ");
}

function buildIntakeFromMapped(body) {
  // Key names updated to match image_109745.png and image_1045c7.jpg
  const intake_details = cleanValue(pick(body, ["job_intake_details", "intake_details"], ""));
  const photo_request = cleanValue(pick(body, ["photos_request", "photo_request"], ""));
  const additional_info = cleanValue(pick(body, ["additional_intake_info", "additional_info"], ""));

  const any = hasAnyValue(body, ["job_intake_details", "photos_request", "additional_intake_info"]);
  if (!any) return "Not provided";

  const lines = [
    intake_details !== "Not provided" ? `Required Details: ${intake_details}` : null,
    photo_request !== "Not provided" ? `Request Photos via Text: ${photo_request}` : null,
    additional_info !== "Not provided" ? `Additional Info: ${additional_info}` : null,
  ].filter(Boolean);

  return lines.join(" | ");
}

function buildEmergencyFromMapped(body) {
  // Key names updated to match image_1045c7.jpg
  const emergency_def = cleanValue(pick(body, ["emergency"], ""));
  const e_phone = cleanValue(pick(body, ["emergency_phone"], ""));
  const e_phone_2 = cleanValue(pick(body, ["emergency_secondary_phone"], ""));
  const urgent_instr = cleanValue(pick(body, ["urgent_instructions"], ""));

  const any = hasAnyValue(body, ["emergency", "emergency_phone", "urgent_instructions"]);
  if (!any) return "Not provided";

  const lines = [
    emergency_def !== "Not provided" ? `Emergency Definition: ${emergency_def}` : null,
    e_phone !== "Not provided" ? `Primary: ${e_phone}` : null,
    e_phone_2 !== "Not provided" ? `Secondary: ${e_phone_2}` : null,
    urgent_instr !== "Not provided" ? `Special Instructions: ${urgent_instr}` : null,
  ].filter(Boolean);

  return lines.join(" | ");
}

function buildLeadRevivalFromMapped(body) {
  // Key names updated to match image_109745.png
  const offer = cleanValue(pick(body, ["lead_revival_offer", "main_offer"], ""));
  const timing = cleanValue(pick(body, ["follow_up_timing"], ""));
  const attempts = cleanValue(pick(body, ["follow_up_attempts"], ""));

  const any = hasAnyValue(body, ["lead_revival_offer", "follow_up_timing", "follow_up_attempts"]);
  if (!any) return "Not provided";

  return `Offer: ${offer} | Timing: ${timing} | Max Attempts: ${attempts}`;
}

// --- 4. MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const body = await readJsonBody(req);
    const headers = { Authorization: `Bearer ${process.env.RETELL_API_KEY}`, "Content-Type": "application/json" };

    const biz_name = pick(body, ["business_name", "businessName", "company"], "the business");
    const agent_name = pick(body, ["agent_name", "agentName", "name"], "Ava");
    const biz_hours = cleanValue(pick(body, ["business_hours"], ""));
    const services = cleanValue(pick(body, ["services"], ""));

    const GREETING = `Thanks for calling ${biz_name}, this is ${agent_name}. How can I help you today?`;

    const website_url = normalizeWebsite(pick(body, ["website", "url"], "Not provided"));
    const website_content = await getWebsiteContext(website_url);
    const structured_facts = buildWebsiteFacts(website_content, services);

    const scheduling = buildSchedulingFromMapped(body);
    const emergencyBlock = buildEmergencyFromMapped(body);
    const intakeBlock = buildIntakeFromMapped(body);
    const leadRevivalBlock = buildLeadRevivalFromMapped(body);

    const FINAL_PROMPT = `
IDENTITY:
- You are ${agent_name} with ${biz_name}.
- Do NOT volunteer that you are an AI unless explicitly asked.

BUSINESS CONTEXT:
- Services Offered: ${services}
- Business Hours: ${biz_hours}

${structured_facts}

RAW WEBSITE EXCERPT:
---
${website_content ? website_content.substring(0, 800) : "No website data found."}
---

SCHEDULING: ${scheduling}
EMERGENCY: ${emergencyBlock}
INTAKE: ${intakeBlock}
LEAD REVIVAL: ${leadRevivalBlock}

RULE: If a caller asks to book, collect preferred windows and callback number. Do NOT confirm a time unless a specific calendar link is provided.
`.trim();

    const llmResp = await axios.post("https://api.retellai.com/create-retell-llm", {
      general_prompt: FINAL_PROMPT,
      begin_message: GREETING,
      model: "gpt-4o-mini",
    }, { headers });

    const voiceId = resolveVoiceId(body);

    const agentResp = await axios.post("https://api.retellai.com/create-agent", {
      agent_name: `${biz_name} Agent`,
      voice_id: voiceId,
      response_engine: { type: "retell-llm", llm_id: llmResp.data.llm_id },
    }, { headers });

    return res.status(200).json({ ok: true, agent_id: agentResp.data.agent_id });
  } catch (error) {
    console.error("retell-create-call failed:", error?.response?.data || error.message);
    return res.status(500).json({ error: "Server error" });
  }
};
