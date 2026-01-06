// /api/retell-create-agent.js
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
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// Treat "No data" as empty, and Zapier token objects {output:"..."} as values
function pick(obj, keys, fallback = "Not provided") {
  for (const k of keys) {
    let val = obj?.[k];
    if (val !== undefined && val !== null && val !== "" && val !== "No data") {
      if (typeof val === "object" && val.output) return val.output;
      return val;
    }
  }
  return fallback;
}

// Block helpers (new canonical payload)
function getBlock(body, blockName) {
  const b = body?.[blockName];
  return b && typeof b === "object" ? b : {};
}

function pickBlock(body, blockName, keys, fallback = "Not provided") {
  return pick(getBlock(body, blockName), keys, fallback);
}

/**
 * Canonical-first picker:
 * 1) Try body[blockName][key]
 * 2) Fallback to legacy flat keys (so old zaps won't break)
 */
function pickCanonical(body, blockName, keys, legacyKeys = [], fallback = "Not provided") {
  const fromBlock = pickBlock(body, blockName, keys, "__MISSING__");
  if (fromBlock !== "__MISSING__") return fromBlock;
  if (legacyKeys?.length) return pick(body, legacyKeys, fallback);
  return fallback;
}

// --- 2. NORMALIZERS / HELPERS ---
const decodeHtml = (s) =>
  String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

const uniq = (arr) => [...new Set(arr)];

function safePhoneDigits(input) {
  const digits = String(input || "").replace(/[^\d]/g, "").trim();
  return digits || "";
}

function speakPhone(phoneDigits) {
  if (!phoneDigits) return "";
  return phoneDigits.split("").join("-");
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function toYesNo(val) {
  const s = String(val || "").trim().toLowerCase();
  if (!s || s === "not provided") return "";
  if (["yes", "y", "true", "1"].includes(s)) return "Yes";
  if (["no", "n", "false", "0"].includes(s)) return "No";
  return String(val).trim();
}

// Convert "10 minutes" -> "10" (string) safely; keep original if not numeric
function extractMinutes(val) {
  const s = String(val || "").trim();
  if (!s || s === "Not provided") return "";
  const m = s.match(/(\d+)/);
  return m ? m[1] : s;
}

// --- 3. WEBSITE SCRAPER (PROVEN) ---
function extractFirstUrl(text) {
  if (!text) return null;
  const m = String(text).match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : null;
}

// Strict: return "" when not a real URL (so you don’t inject junk into prompt)
function normalizeWebsiteStrict(raw) {
  if (!raw || raw === "Not provided") return "";
  if (typeof raw === "object" && raw.output) raw = raw.output;
  raw = String(raw).trim();

  const extracted = extractFirstUrl(raw);
  if (extracted) return extracted;

  if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(raw)) return `https://${raw}`;
  if (raw.startsWith("http")) return raw;

  return "";
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
  if (!url) return null;

  // Direct fetch
  try {
    const response = await axios.get(url, {
      timeout: 8000,
      maxRedirects: 5,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    let text = String(response.data || "")
      .replace(/<(script|style|header|nav|footer|form)[^>]*>([\s\S]*?)<\/\1>/gim, "")
      .replace(/<[^>]*>?/gm, " ")
      .replace(/\s+/g, " ")
      .trim();

    text = decodeHtml(text);

    if (text.length >= 200 && !looksLikeCode(text)) return text.substring(0, 2000);
  } catch (e) {
    // fall through
  }

  // Fallback proxy (jina)
  try {
    const proxyUrl = `https://r.jina.ai/${url.replace(/^https?:\/\//, "")}`;
    const r = await axios.get(proxyUrl, { timeout: 9000 });
    const txt = decodeHtml(String(r.data || "")).replace(/\s+/g, " ").trim();
    if (txt.length >= 200 && !looksLikeCode(txt)) return txt.substring(0, 2000);
  } catch (e) {
    return null;
  }

  return null;
}

// Keep “facts” short + stable (do NOT paste full site text into prompt)
function buildWebsiteFacts(text, businessTypeHint = "") {
  if (!text) return "";

  const raw = String(text);
  const lower = raw.toLowerCase();

  // light area extraction
  const areaMatch = raw.match(
    /including\s+([A-Za-z,\s]+?)(?:and\s+surrounding|surrounding|area|towns|cities|\.)/i
  );
  const areas = areaMatch
    ? uniq(
        areaMatch[1]
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length >= 3)
      ).slice(0, 10)
    : [];

  const tradeBoosters = {
    paving: ["asphalt", "paving", "sealcoating", "crack", "patch", "driveway", "parking lot", "excavation", "curbing"],
    plumbing: ["plumbing", "drain", "pipe", "leak", "water heater", "sewer", "sump"],
    hvac: ["hvac", "air conditioning", "ac", "heating", "furnace", "boiler", "heat pump"],
    roofing: ["roof", "roofing", "shingle", "leak", "gutter", "siding"],
  };

  const hint = String(businessTypeHint || "").toLowerCase();
  let booster = [];
  for (const key of Object.keys(tradeBoosters)) {
    if (hint.includes(key)) booster = tradeBoosters[key];
  }

  if (!booster.length) {
    if (lower.includes("asphalt") || lower.includes("paving")) booster = tradeBoosters.paving;
    else if (lower.includes("plumb") || lower.includes("drain")) booster = tradeBoosters.plumbing;
    else if (lower.includes("hvac") || lower.includes("furnace") || lower.includes("air conditioning")) booster = tradeBoosters.hvac;
    else if (lower.includes("roof") || lower.includes("shingle")) booster = tradeBoosters.roofing;
  }

  const services = uniq(booster.filter((k) => lower.includes(k.toLowerCase()))).slice(0, 12);

  const lines = [];
  if (areas.length) lines.push(`- Service area (from website): ${areas.join(", ")}.`);
  if (services.length) lines.push(`- Services (from website): ${services.join(", ")}.`);

  return lines.length ? `WEBSITE FACTS (AUTO-SCRAPED):\n${lines.join("\n")}` : "";
}

// --- 4. VOICE RESOLUTION (CANONICAL-FIRST) ---
function resolveVoiceProfile(body) {
  // Direct override support (canonical + legacy)
  const direct = pickCanonical(body, "meta", ["voice_id"], ["voice_id", "voiceId", "VOICE_ID"], "");
  if (direct && direct !== "Not provided") {
    return { voice_id: String(direct).trim(), gender: "", tone: "", source: "direct" };
  }

  const tone = String(
    pickCanonical(body, "meta", ["voice_tone"], ["voice_tone", "voiceTone", "tone"], "warm")
  )
    .toLowerCase()
    .trim();

  const gender = String(
    pickCanonical(body, "meta", ["agent_gender"], ["agent_gender", "agentGender", "gender"], "female")
  )
    .toLowerCase()
    .trim();

  // ✅ includes male_warm
  const VOICE_MAP = {
    female_warm: process.env.VOICE_FEMALE_WARM,
    female_authoritative: process.env.VOICE_FEMALE_AUTHORITATIVE,
    female_calm: process.env.VOICE_FEMALE_CALM,
    male_warm: process.env.VOICE_MALE_WARM,
    male_authoritative: process.env.VOICE_MALE_AUTHORITATIVE,
    male_calm: process.env.VOICE_MALE_CALM,
  };

  const resolved = VOICE_MAP[`${gender}_${tone}`] || process.env.DEFAULT_VOICE_ID;

  return { voice_id: resolved, gender, tone, source: "mapped" };
}

// --- 5. ROLE RESOLUTION (DETERMINISTIC) ---
const TEMPLATE_ROLE_MAP = {
  receptionist_female_v1: "receptionist",
  receptionist_male_v1: "receptionist",
  scheduler_female_v1: "scheduler",
  intake_female_v1: "intake",
  dispatch_female_v1: "emergency_dispatch",
  leadrevival_male_v1: "lead_revival",
  operations_female_v1: "operations",
  operations_male_v1: "operations",
};

const ALLOWED_ROLES = new Set([
  "receptionist",
  "scheduler",
  "intake",
  "emergency_dispatch",
  "lead_revival",
  "operations",
]);

function resolveRole(body) {
  // canonical first: meta.agent_template_id / meta.agent_role
  const templateIdRaw = pickCanonical(
    body,
    "meta",
    ["agent_template_id"],
    ["agent_template_id", "template_id"],
    ""
  );
  const templateId = String(templateIdRaw || "").toLowerCase().trim();

  const fromTemplate = TEMPLATE_ROLE_MAP[templateId];

  const fromRoleField = String(
    pickCanonical(body, "meta", ["agent_role"], ["agent_role", "role"], "receptionist")
  )
    .toLowerCase()
    .trim();

  const resolved = fromTemplate || fromRoleField || "receptionist";

  if (!ALLOWED_ROLES.has(resolved)) {
    const err = new Error(
      `Invalid role "${resolved}". Allowed roles: ${Array.from(ALLOWED_ROLES).join(", ")}`
    );
    err.statusCode = 400;
    err.debug = { templateId, fromTemplate, fromRoleField };
    throw err;
  }

  return { role: resolved, templateId };
}

// --- 6. MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const body = await readJsonBody(req);

    const headers = {
      Authorization: `Bearer ${process.env.RETELL_API_KEY}`,
      "Content-Type": "application/json",
    };

    // --- ROLE (deterministic) ---
    const { role, templateId } = resolveRole(body);

    // --- CANONICAL: META + CORE ---
    const agent_name = String(pickCanonical(body, "meta", ["agent_name"], ["agent_name"], "Samuel")).trim();

    const purchased_package = String(
      pickCanonical(body, "meta", ["purchased_package"], ["purchased_package"], role)
    ).trim();

    const purchased_add_ons = pickCanonical(body, "meta", ["purchased_add_ons"], ["purchased_add_ons"], "");
    const hasSamuelAddon =
      Array.isArray(purchased_add_ons)
        ? purchased_add_ons.map(String).map((s) => s.toLowerCase()).includes("samuel")
        : String(purchased_add_ons || "")
            .toLowerCase()
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .includes("samuel");

    const biz_name = String(
      pickCanonical(body, "core", ["business_name"], ["business_name", "company"], "McDuffy and Son Asphalt")
    ).trim();

    const client_email = String(
      pickCanonical(
        body,
        "core",
        ["business_email"],
        ["email", "user_email", "business_email"],
        "not-provided@example.com"
      )
    ).trim();

    // ✅ TIME ZONE FOR ALL AGENTS (core first, then scheduler fallback, then default)
    const time_zone =
      String(pickCanonical(body, "core", ["time_zone"], ["time_zone", "timezone"], "")).trim() ||
      String(pickCanonical(body, "scheduler", ["time_zone"], ["time_zone", "timezone"], "")).trim() ||
      "America/New_York";

    // Website (strict) + scrape
    const website = normalizeWebsiteStrict(
      pickCanonical(body, "core", ["website_url"], ["website", "site", "business_website", "website_url"], "")
    );

    const business_hours = String(
      pickCanonical(body, "core", ["business_hours"], ["business_hours", "hours"], "")
    ).trim();

    const services = String(
      pickCanonical(
        body,
        "core",
        ["home_service_type"],
        ["services", "primary_business_type", "service_type", "home_service_type"],
        ""
      )
    ).trim();

    const extra_info = String(
      pickCanonical(body, "core", ["extra_info"], ["extra_info", "notes", "additional_info"], "")
    ).trim();

    // --- SCHEDULER BLOCK (canonical) ---
    const calendar_system = String(pickCanonical(body, "scheduler", ["calendar_system"], ["calendar_system"], "")).trim();

    const calendar_link = String(
      pickCanonical(body, "scheduler", ["calendar_link"], ["calendar_link", "booking_link"], "")
    ).trim();

    const after_hours_rules = toYesNo(pickCanonical(body, "scheduler", ["after_hours_rules"], ["after_hours_rules"], ""));

    const buffer_minutes = extractMinutes(
      pickCanonical(body, "scheduler", ["buffer_minutes"], ["buffer_time"], "")
    );

    const same_day_allowed = toYesNo(
      pickCanonical(body, "scheduler", ["same_day_allowed"], ["same_day_appointment_rules"], "")
    );

    const weekend_allowed = toYesNo(
      pickCanonical(body, "scheduler", ["weekend_allowed"], ["weekend_appointments"], "")
    );

    const service_durations = String(pickCanonical(body, "scheduler", ["service_durations"], ["service_durations"], "")).trim();

    // --- INTAKE BLOCK (canonical) ---
    const intake_required_details = String(
      pickCanonical(body, "intake", ["required_details_selected"], ["intake_details", "required_job_details"], "")
    ).trim();

    const intake_questions = String(
      pickCanonical(body, "intake", ["questions"], ["intake_questions"], "")
    ).trim();

    const intake_request_photos = toYesNo(
      pickCanonical(body, "intake", ["request_photos_via_text"], ["photo_request"], "")
    );

    const intake_additional_info = String(
      pickCanonical(body, "intake", ["additional_info"], ["additional_intake_info"], "")
    ).trim();

    // --- EMERGENCY BLOCK (canonical) ---
    const emergency_definition = String(
      pickCanonical(body, "emergency", ["definition"], ["emergency_definition"], "")
    ).trim();

    const emergency_primary_phone_digits = safePhoneDigits(
      pickCanonical(body, "emergency", ["primary_phone"], ["emergency_phone", "primary_emergency_phone"], "")
    );

    const emergency_alert_email = String(
      pickCanonical(body, "emergency", ["alert_email"], ["emergency_alert_email"], "")
    ).trim();

    const emergency_sms_phone_digits = safePhoneDigits(
      pickCanonical(body, "emergency", ["sms_phone"], ["emergency_sms_phone"], "")
    );

    const urgent_instructions = String(
      pickCanonical(body, "emergency", ["urgent_instructions"], ["urgent_instructions"], "")
    ).trim();

    const hasClientEmergencyNumber = Boolean(emergency_primary_phone_digits);
    const speech_emergency = hasClientEmergencyNumber ? speakPhone(emergency_primary_phone_digits) : "";

    // --- LEAD REVIVAL BLOCK (canonical) ---
    const lead_offer = String(
      pickCanonical(body, "lead_revival", ["follow_up_offer"], ["lead_revival_offer", "revival_offer"], "")
    ).trim();

    const lead_notification_email = String(
      pickCanonical(body, "lead_revival", ["notification_email"], ["notification_email"], "")
    ).trim();

    const includeLeadRevival = role === "lead_revival" || role === "operations" || hasSamuelAddon;

    // --- OPTIONAL: missing field detector (for debugging only) ---
    const missing_fields = [];
    const requiredAlways = [
      { label: "meta.agent_name", val: agent_name },
      { label: "core.business_name", val: biz_name },
      { label: "time_zone", val: time_zone },
      { label: "meta.agent_role/agent_template_id", val: role },
    ];
    for (const r of requiredAlways) {
      if (!r.val || r.val === "Not provided") missing_fields.push(r.label);
    }

    // Website scraping (facts only)
    const website_raw = website ? await getWebsiteContext(website) : null;
    const website_facts = buildWebsiteFacts(website_raw, services || biz_name);

    // --- BUSINESS CONTEXT ---
    const websiteContext = website
      ? `Website provided: ${website}. If asked about services, prefer what is on the website. If you are unsure, ask clarifying questions instead of guessing.`
      : `No website provided. Do not invent services. Ask clarifying questions and capture details for a callback when needed.`;

    // Always-on core context lines (now includes time zone)
    const coreContextLines = [
      biz_name ? `Business name: ${biz_name}` : "",
      `Business time zone: ${time_zone}`,
      business_hours ? `Business hours: ${business_hours}` : "",
      services ? `Primary services / business type: ${services}` : "",
      extra_info ? `Extra notes: ${extra_info}` : "",
    ].filter(Boolean);

    // Role-specific context lines (kept clean)
    const schedulerContextLines =
      role === "scheduler" || role === "operations"
        ? [
            calendar_system ? `Calendar system: ${calendar_system}` : "",
            calendar_link ? `Calendar link: ${calendar_link}` : "",
            service_durations ? `Service durations: ${service_durations}` : "",
            same_day_allowed ? `Same-day allowed: ${same_day_allowed}` : "",
            weekend_allowed ? `Weekend allowed: ${weekend_allowed}` : "",
            after_hours_rules ? `After-hours allowed: ${after_hours_rules}` : "",
            buffer_minutes ? `Buffer minutes: ${buffer_minutes}` : "",
          ].filter(Boolean)
        : [];

    const intakeContextLines =
      role === "intake" || role === "operations"
        ? [
            intake_required_details ? `Intake required details: ${intake_required_details}` : "",
            intake_questions ? `Intake questions: ${intake_questions}` : "",
            intake_request_photos ? `Request photos via text: ${intake_request_photos}` : "",
            intake_additional_info ? `Additional intake info: ${intake_additional_info}` : "",
          ].filter(Boolean)
        : [];

    const emergencyContextLines =
      role === "emergency_dispatch" || role === "operations"
        ? [
            emergency_definition ? `Emergency definition: ${emergency_definition}` : "",
            urgent_instructions ? `Urgent instructions: ${urgent_instructions}` : "",
            emergency_alert_email ? `Emergency alert email: ${emergency_alert_email}` : "",
            emergency_primary_phone_digits ? `Emergency phone (digits): ${emergency_primary_phone_digits}` : "",
            emergency_sms_phone_digits ? `Emergency SMS phone (digits): ${emergency_sms_phone_digits}` : "",
          ].filter(Boolean)
        : [];

    const leadRevivalContextLines =
      includeLeadRevival
        ? [
            lead_notification_email ? `Lead revival notification email: ${lead_notification_email}` : "",
            lead_offer ? `Lead revival offer: ${lead_offer}` : "",
          ].filter(Boolean)
        : [];

    // --- EMERGENCY RULE (STRICT: ONLY emergency_dispatch OR operations) ---
    const EMERGENCY_RULE =
      role === "emergency_dispatch" || role === "operations"
        ? `
## EMERGENCY DISPATCH RULES
${emergency_definition ? `Emergency definition for this business:\n- ${emergency_definition}\n` : ""}If the caller reports immediate danger, injury, fire, active hazard, or a truly urgent situation:
- Stay calm and ask for the location/address first.
- Collect name and callback number.
- Tell them to contact local emergency services if appropriate.
${
  hasClientEmergencyNumber
    ? `- Provide the business emergency contact: ${speech_emergency}.`
    : `- No business emergency number is on file. Take details and escalate immediately.`
}
${urgent_instructions ? `- Follow urgent instructions: ${urgent_instructions}` : ""}
${emergency_alert_email ? `- Route emergency alerts to: ${emergency_alert_email}` : ""}
${emergency_sms_phone_digits ? `- Emergency SMS escalation number (digits): ${emergency_sms_phone_digits}` : ""}
- Do not guess or reassure beyond what you know; escalate.
`.trim()
        : "";

    // --- ROLE CAPSULES (LOCKED) ---
    const schedulerDetails = [
      calendar_link
        ? `Booking link: ${calendar_link}`
        : `Booking link: (not provided — you must take details for manual scheduling)`,
      buffer_minutes ? `Buffer minutes between appointments: ${buffer_minutes}` : "",
      same_day_allowed ? `Same-day appointments allowed: ${same_day_allowed}` : "",
      weekend_allowed ? `Weekend appointments allowed: ${weekend_allowed}` : "",
      after_hours_rules ? `After-hours booking allowed: ${after_hours_rules}` : "",
      service_durations ? `Service durations: ${service_durations}` : "",
      `Time zone: ${time_zone}`,
      calendar_system ? `Calendar system: ${calendar_system}` : "",
    ]
      .filter(Boolean)
      .join("\n- ");

    const ROLE_PROMPTS = {
      receptionist: {
        begin: `Thanks for calling ${biz_name}, this is ${agent_name}. How can I help you today?`,
        body: `
## CORE ROLE: RECEPTIONIST
- Greet callers and identify whether they are a new or returning customer.
- Collect: caller name, best callback number, address/town, and a short description of what they need.
- Do not guess pricing, timelines, or guarantees.
- If unsure, ask 1–2 focused questions, then take a message for callback.
`.trim(),
      },

      intake: {
        begin: `Thanks for calling ${biz_name}, this is ${agent_name}. What can I help you with today?`,
        body: `
## CORE ROLE: INTAKE SPECIALIST
- Gather complete details and route to the right next step.
- Collect: name, callback, address/town, service needed, and urgency.
- Ask intake questions exactly as provided when available.
- If photos are requested, ask politely and explain how to send them.
- If the caller requests an estimate, capture details and preferred day/time window.
- If you cannot schedule directly, take a message and promise a callback.
${intake_required_details ? `\n### Required details to collect:\n- ${intake_required_details}` : ""}
${intake_questions ? `\n### Intake questions to ask:\n- ${intake_questions}` : ""}
${intake_request_photos ? `\n### Photo request:\n- Request photos via text: ${intake_request_photos}` : ""}
${intake_additional_info ? `\n### Additional intake instructions:\n- ${intake_additional_info}` : ""}
`.trim(),
      },

      scheduler: {
        begin: `Thanks for calling ${biz_name}, this is ${agent_name}. Are you looking to schedule an appointment?`,
        body: `
## CORE ROLE: SCHEDULER
- Your job is to schedule appointments OR collect details for manual scheduling.
- Apply these scheduling rules exactly:

- ${schedulerDetails}

### Scheduling flow:
1) Identify what service they want.
2) Confirm preferred day/time window (and time zone if needed).
3) If a booking link exists, guide them through booking OR confirm you will book it for them (depending on your workflow).
4) If no booking link exists, collect details and say: "I’ll have the office reach out to confirm the next available time."
5) Confirm constraints (same-day, weekend, after-hours, buffer time) BEFORE promising a slot.
`.trim(),
      },

      emergency_dispatch: {
        begin: `Emergency dispatch for ${biz_name}. This is ${agent_name}. What is the situation?`,
        body: `
## CORE ROLE: EMERGENCY DISPATCH
- Quickly assess immediate danger.
- Collect: location/address, what happened, whether anyone is injured, and best callback number.
- Escalate immediately using the emergency rules below.
`.trim(),
      },

      lead_revival: {
        begin: `Hi, this is ${agent_name} from ${biz_name}. I'm following up on your recent quote—do you have a quick minute?`,
        body: `
## CORE ROLE: LEAD REVIVAL
- Confirm they received the quote and ask where they are in the decision process.
- Ask if scope/timing changed.
- Offer next steps (schedule follow-up or answer a quick question).
- If not interested, thank them and close politely.
${lead_offer ? `- Current Offer: ${lead_offer}` : `- If no offer is provided, do not invent one.`}
${lead_notification_email ? `- Send follow-up outcome notifications to: ${lead_notification_email}` : ""}
`.trim(),
      },

      operations: {
        begin: `Operations for ${biz_name}, this is ${agent_name}. How can I help you today?`,
        body: `
## CORE ROLE: FULL STAFF OPERATIONS (MULTI-SKILL)
You can perform Reception, Intake, Scheduling, Lead Revival, and Emergency Dispatch.

### How to operate:
1) Identify intent (scheduling, new intake, emergency, follow-up).
2) Switch to the matching skill and proceed.
3) Never guess missing pricing/policies; ask or take a message for callback.
${includeLeadRevival ? `\n### Lead revival enabled:\n- Yes (Samuel add-on or Lead Revival package)` : ""}
`.trim(),
      },
    };

    const roleConfig = ROLE_PROMPTS[role] || ROLE_PROMPTS.receptionist;

    // --- BASE RULES (STABLE) ---
    const BASE_RULES = `
## BASE RULES
- Do NOT mention you are an AI.
- Be concise: 1–2 sentences per turn when possible.
- Ask up to 2 clarifying questions if needed.
- Never invent pricing, guarantees, or policies.
- If info is missing or form data looks wrong: gather details + promise a callback.
- No symbols: say "dollars" instead of "$".
- Close with: "Thank you for calling. Someone will reach out soon."
`.trim();

    // --- VOICE SELECTION ---
    const voiceProfile = resolveVoiceProfile(body);

    // --- FINAL PROMPT (clean + stable) ---
    const FINAL_PROMPT = `
## IDENTITY
You are ${agent_name}, a professional representative for ${biz_name}.
Role: ${role.toUpperCase()}.
Template ID: ${templateId || "none"}.
Business time zone: ${time_zone}.
Voice profile: ${voiceProfile.gender && voiceProfile.tone ? `${voiceProfile.gender} / ${voiceProfile.tone}` : "default"}.

## BUSINESS CONTEXT
${websiteContext}
${coreContextLines.length ? `\n${coreContextLines.join("\n")}` : ""}

${website_facts ? `\n## WEBSITE FACTS (AUTO-SCRAPED)\n${website_facts}` : ""}

${schedulerContextLines.length ? `\n## SCHEDULER CONTEXT\n${schedulerContextLines.join("\n")}` : ""}
${intakeContextLines.length ? `\n## INTAKE CONTEXT\n${intakeContextLines.join("\n")}` : ""}
${emergencyContextLines.length ? `\n## EMERGENCY CONTEXT\n${emergencyContextLines.join("\n")}` : ""}
${leadRevivalContextLines.length ? `\n## LEAD REVIVAL CONTEXT\n${leadRevivalContextLines.join("\n")}` : ""}

${roleConfig.body}

${EMERGENCY_RULE ? `\n${EMERGENCY_RULE}\n` : ""}

${BASE_RULES}
`.trim();

    const prompt_hash = sha256(FINAL_PROMPT);

    // --- CREATE RETELL LLM ---
    const llmResp = await axios.post(
      "https://api.retellai.com/create-retell-llm",
      {
        general_prompt: FINAL_PROMPT,
        begin_message: roleConfig.begin,
        model: "gpt-4o-mini",
      },
      { headers }
    );

    // --- CREATE AGENT ---
    const agentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        agent_name: `${biz_name} - ${agent_name}`,
        voice_id: voiceProfile.voice_id,
        response_engine: { type: "retell-llm", llm_id: llmResp.data.llm_id },
        metadata: {
          business_name: biz_name,
          agent_role: role,
          purchased_package,
          purchased_add_ons: purchased_add_ons || "",
          agent_template_id: templateId || "",
          notification_email: client_email,
          voice_source: voiceProfile.source,
          voice_gender: voiceProfile.gender,
          voice_tone: voiceProfile.tone,
          time_zone,
          has_website: Boolean(website),
          prompt_hash,
          missing_fields,
        },
      },
      { headers }
    );

    return res.status(200).json({
      ok: true,
      agent_id: agentResp.data.agent_id,
      debug: {
        resolved_role: role,
        templateId,
        prompt_hash,
        time_zone,
        has_website: Boolean(website),
        website_scraped: Boolean(website_raw),
        has_calendar_link: Boolean(calendar_link),
        has_client_emergency_number: hasClientEmergencyNumber,
        voice_id: voiceProfile.voice_id,
        voice_gender: voiceProfile.gender,
        voice_tone: voiceProfile.tone,
        voice_source: voiceProfile.source,
        missing_fields,
      },
    });
  } catch (error) {
    const status = error?.statusCode || 500;
    return res.status(status).json({
      error: status === 400 ? String(error.message) : "Server error",
      debug: error?.debug || undefined,
    });
  }
};
