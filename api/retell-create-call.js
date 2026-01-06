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

function cleanValue(text, fallback = "Not provided") {
  const t = String(text || "").trim();
  if (
    !t ||
    t === "[]" ||
    t === "No data" ||
    t === "/" ||
    t === "null" ||
    t.toLowerCase() === "not provided"
  )
    return fallback;
  return t.replace(/\[\]/g, fallback);
}

// --- 2. VOICE RESOLUTION ---
function resolveVoiceId(body) {
  const direct = pick(body, ["voice_id", "voiceId", "VOICE_ID"], "");
  if (direct && direct !== "Not provided") return String(direct).trim();

  const tone = String(pick(body, ["voice_tone", "voiceTone", "tone"], "warm")).toLowerCase().trim();
  const gender = String(pick(body, ["agent_gender", "agentGender", "gender"], "female")).toLowerCase().trim();

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

// --- 3. URL & SCRAPER LOGIC ---
function extractFirstUrl(text) {
  if (!text) return null;
  const m = String(text).match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : null;
}

function normalizeWebsite(raw) {
  if (!raw || raw === "Not provided") return "Not provided";
  const extracted = extractFirstUrl(String(raw));
  if (extracted) return extracted;
  if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(raw)) return `https://${raw}`;
  return String(raw).startsWith("http") ? raw : "Not provided";
}

async function getWebsiteContext(url) {
  if (!url || url === "Not provided") return null;
  try {
    const response = await axios.get(url, {
      timeout: 4000,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    let text = String(response.data || "")
      .replace(/<(script|style|header|nav|footer|form)[^>]*>([\s\S]*?)<\/\1>/gim, "")
      .replace(/<[^>]*>?/gm, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length >= 200) return decodeHtml(text).substring(0, 3000);
  } catch (e) {}

  try {
    const r = await axios.get(`https://r.jina.ai/${url}`, { timeout: 5000 });
    const txt = decodeHtml(String(r.data || "")).replace(/\s+/g, " ").trim();
    if (txt.length >= 200) return txt.substring(0, 3000);
  } catch (e) {}
  return null;
}

// --- 4. MAPPED FIELD BUILDERS ---
function buildSchedulingFromMapped(body) {
  const link = cleanValue(pick(body, ["calendar_link", "calendarLink"]));
  if (link === "Not provided") return "Scheduling is NOT enabled. Take a message and callback number.";
  return `Calendar Link: ${link} | System: ${cleanValue(pick(body, ["calendar_system"]))}`;
}

function buildLeadRevivalFromMapped(body) {
  const offer = cleanValue(pick(body, ["lead_revival_offer"]));
  const timing = cleanValue(pick(body, ["follow_up_timing"]));
  const attempts = cleanValue(pick(body, ["follow_up_attempts"]));
  if (offer === "Not provided") return "No active lead revival offer.";
  return `Offer: ${offer} | Timing: ${timing} | Max Attempts: ${attempts}`;
}

// --- 5. MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const body = await readJsonBody(req);
    const headers = { Authorization: `Bearer ${process.env.RETELL_API_KEY}`, "Content-Type": "application/json" };

    const biz_name = pick(body, ["business_name", "company"], "McDuffy and Son Asphalt");
    const agent_name = pick(body, ["agent_name", "name"], "Lexi");
    const client_email = pick(body, ["email", "user_email"], "not-provided@example.com");
    const services = cleanValue(pick(body, ["services"]), "Asphalt paving, sealcoating, and driveway repairs");
    const biz_hours = cleanValue(pick(body, ["business_hours"]), "Monday through Friday, 8 AM to 5 PM");

    const raw_emergency = cleanValue(pick(body, ["emergency_phone"]), "5082910787");
    const speech_emergency = raw_emergency.split("").join("-");

    const website_url = normalizeWebsite(pick(body, ["website", "url"]));
    let website_content = null;

    if (website_url && website_url !== "Not provided") {
      try {
        website_content = await Promise.race([
          getWebsiteContext(website_url),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 6000)),
        ]);
      } catch (e) {
        console.log("Website timeout.");
      }
    }

    // ✅ ONLY CHANGE: IDENTITY uses resolved role from payload (no hardcoded "Emergency Dispatcher")
    const resolved_role = String(pick(body, ["agent_role", "role"], "emergency_dispatch"))
      .toLowerCase()
      .trim();

    const roleLabelMap = {
      operations: "Operations",
      receptionist: "Receptionist",
      intake: "Intake",
      scheduler: "Scheduler",
      emergency_dispatch: "Emergency Dispatch",
      lead_revival: "Lead Revival",
    };

    const roleLabel = roleLabelMap[resolved_role] || "Emergency Dispatch";

    const FINAL_PROMPT = `
## IDENTITY
- You are ${agent_name}, the ${roleLabel} for ${biz_name}.
- Role: ${resolved_role.toUpperCase()}.
- Rule: Do NOT mention you are an AI.

## BUSINESS KNOWLEDGE
- Services: ${services}
- Hours: Dispatch is active 24/7 for emergency safety concerns.
- Website Context: ${website_content ? website_content : "Rely on industry standards for asphalt safety and emergency repair."}

## DISPATCH TRIAGE PROTOCOL
1. **Identify the Hazard:** Immediately ask: "What is the nature of the emergency, and is the area currently safe for traffic?"
2. **Assign Severity:** - **CRITICAL:** Active sinkholes, hazards in traffic lanes, or immediate pedestrian danger. 
     *Action:* Instruct them to "mark off the area" and state "I am alerting our on-call supervisor and nearest crew right now."
   - **URGENT:** Equipment damage or major failures that aren't life-threatening.
     *Action:* State "I am moving this to the top of our priority list for today."

## OPERATIONAL GUIDELINES
- INTAKE (Critical Dispatch): You MUST get the exact street address/location and a secondary contact number before hanging up.
- EMERGENCY CONTACT: ${speech_emergency}. 
- Instructions: Tell the caller we are reaching out via mobile to the nearest crew immediately.
- SCHEDULING: ${buildSchedulingFromMapped(body)}
- LEAD REVIVAL: ${buildLeadRevivalFromMapped(body)}

## CALL RULES
1. **Leading the Call:** Do not wait for the caller to talk. As a dispatcher, you lead the conversation to get the facts quickly.
2. **Be Brief:** 1-2 sentences max. 
3. **No Symbols:** Say "dollars" instead of "$".
4. **Closing:** "Stay safe. I am transmitting your emergency details to our team now."
`.trim();

    const llmResp = await axios.post(
      "https://api.retellai.com/create-retell-llm",
      {
        general_prompt: FINAL_PROMPT,
        begin_message: `Emergency Dispatch for ${biz_name}, this is ${agent_name}. What is the nature of your emergency?`,
        model: "gpt-4o-mini",
      },
      { headers }
    );

    const agentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        agent_name: `${biz_name} Dispatch Agent`,
        voice_id: resolveVoiceId(body) || process.env.DEFAULT_VOICE_ID,
        response_engine: { type: "retell-llm", llm_id: llmResp.data.llm_id },
        metadata: {
          business_name: String(biz_name),
          notification_email: String(client_email),
          agent_type: "emergency_dispatcher",
        },
      },
      { headers }
    );

    return res.status(200).json({ ok: true, agent_id: agentResp.data.agent_id });
  } catch (error) {
    console.error("CRITICAL ERROR:", error?.response?.data || error.message);
    return res.status(500).json({ error: "Server error", details: error.message });
  }
};
