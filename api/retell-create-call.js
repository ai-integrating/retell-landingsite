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

const decodeHtml = (s) =>
  String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

const uniq = (arr) => [...new Set((arr || []).filter(Boolean))];

// Treat "No data" as empty, and Zapier token objects {output:"..."} as values
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

// --- 1.1 BODY NORMALIZER (fixes Zapier flattened keys) ---
function setDeep(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[path[path.length - 1]] = value;
}

/**
 * Some Zapier webhook payloads arrive flattened like:
 * - "meta.agent_role": "intake"
 * - "meta__agent_role": "intake"
 * - "meta[agent_role]": "intake"
 * This normalizer rebuilds nested blocks so pickCanonical works reliably.
 */
function normalizeIncomingBody(rawBody) {
  if (!rawBody || typeof rawBody !== "object") return rawBody;

  // If already nested, keep it
  const looksNested =
    rawBody.meta && typeof rawBody.meta === "object" &&
    rawBody.core && typeof rawBody.core === "object";
  if (looksNested) return rawBody;

  const out = { ...rawBody };

  for (const [k, v] of Object.entries(rawBody)) {
    if (v === undefined) continue;

    // meta.agent_role
    if (k.includes(".")) {
      const parts = k.split(".").filter(Boolean);
      if (parts.length >= 2) setDeep(out, parts, v);
      continue;
    }

    // meta__agent_role
    if (k.includes("__")) {
      const parts = k.split("__").filter(Boolean);
      if (parts.length >= 2) setDeep(out, parts, v);
      continue;
    }

    // meta[agent_role]
    const bracket = k.match(/^([^\[]+)\[([^\]]+)\]$/);
    if (bracket) {
      setDeep(out, [bracket[1], bracket[2]], v);
      continue;
    }
  }

  return out;
}

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
 * 2) Fallback to legacy flat keys (keeps old zaps working)
 */
function pickCanonical(body, blockName, keys, legacyKeys = [], fallback = "Not provided") {
  const fromBlock = pickBlock(body, blockName, keys, "__MISSING__");
  if (fromBlock !== "__MISSING__") return fromBlock;
  if (legacyKeys?.length) return pick(body, legacyKeys, fallback);
  return fallback;
}

// --- 2. NORMALIZERS ---
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

function extractMinutes(val) {
  const s = String(val || "").trim();
  if (!s || s === "Not provided") return "";
  const m = s.match(/(\d+)/);
  return m ? m[1] : s;
}

// --- 3. WEBSITE SCRAPER (PROVEN SAFE VERSION) ---
function extractFirstUrl(text) {
  if (!text) return null;
  const m = String(text).match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : null;
}

function normalizeWebsite(raw) {
  if (!raw || raw === "Not provided") return "";
  if (typeof raw === "object" && raw.output) raw = raw.output;
  raw = String(raw).trim();

  // If the form answer is a long sentence containing a URL, extract it.
  const extracted = extractFirstUrl(raw);
  if (extracted) return extracted;

  // If they typed "example.com"
  if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(raw)) return `https://${raw}`;

  // If it already starts with http(s)
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;

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
    // fall through to proxy
  }

  // Proxy fallback (Jina)
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

// Optional: quick extraction summary (safe + short)
function buildWebsiteFacts(text, businessTypeHint = "") {
  if (!text) return "";

  const raw = String(text);
  const lower = raw.toLowerCase();

  const areaMatch = raw.match(
    /including\s+([A-Za-z,\s]+?)(?:and\s+surrounding|surrounding|area|towns|cities|\.)/i
  );
  const areas = areaMatch
    ? areaMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length >= 3)
        .slice(0, 10)
    : [];

  const tradeBoosters = {
    hvac: ["air conditioning", "heating", "furnace", "boiler", "heat pump"],
    plumbing: ["drain cleaning", "pipe repair", "leak detection", "water heater", "sewer"],
    paving: ["asphalt paving", "sealcoating", "patchwork", "crack filling", "excavation", "snow removal"],
    roofing: ["roof repair", "shingle replacement", "leak repair", "gutters", "siding"],
  };

  let booster = [];
  const hint = String(businessTypeHint || "").toLowerCase();
  for (const key of Object.keys(tradeBoosters)) {
    if (hint.includes(key)) booster = tradeBoosters[key];
  }
  if (!booster.length) {
    if (lower.includes("asphalt") || lower.includes("paving") || lower.includes("sealcoat")) booster = tradeBoosters.paving;
    else if (lower.includes("plumbing") || lower.includes("drain")) booster = tradeBoosters.plumbing;
    else if (lower.includes("hvac") || lower.includes("furnace") || lower.includes("air conditioning")) booster = tradeBoosters.hvac;
    else if (lower.includes("roof") || lower.includes("shingle")) booster = tradeBoosters.roofing;
  }

  const services = booster.filter((k) => lower.includes(k)).slice(0, 12);

  const lines = [];
  if (areas.length) lines.push(`- Service area: ${areas.join(", ")}.`);
  if (services.length) lines.push(`- Services: ${services.join(", ")}.`);

  return lines.length ? `WEBSITE FACTS (AUTO):\n${lines.join("\n")}` : "";
}

// --- 4. VOICE RESOLUTION (meta first + legacy fallback, includes male_warm) ---
function resolveVoiceProfile(body) {
  // Direct override support (meta + legacy)
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

  const VOICE_MAP = {
    female_authoritative: process.env.VOICE_FEMALE_AUTHORITATIVE,
    female_warm: process.env.VOICE_FEMALE_WARM,
    female_calm: process.env.VOICE_FEMALE_CALM,
    female_energetic: process.env.VOICE_FEMALE_ENERGETIC,
    male_authoritative: process.env.VOICE_MALE_AUTHORITATIVE,
    male_warm: process.env.VOICE_MALE_WARM,
    male_calm: process.env.VOICE_MALE_CALM,
  };

  const resolved = VOICE_MAP[`${gender}_${tone}`] || process.env.DEFAULT_VOICE_ID;
  return { voice_id: resolved, gender, tone, source: "mapped" };
}

// --- 5. ROLE RESOLUTION (deterministic + trimmed) ---
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
  const templateIdRaw = pickCanonical(body, "meta", ["agent_template_id"], ["agent_template_id", "template_id"], "");
  const templateId = String(templateIdRaw || "").toLowerCase().trim();

  const fromTemplate = templateId ? TEMPLATE_ROLE_MAP[templateId] : "";

  const roleRaw = pickCanonical(body, "meta", ["agent_role"], ["agent_role", "role"], "receptionist");
  const fromRoleField = String(roleRaw || "").toLowerCase().trim();

  const resolved = (fromTemplate || fromRoleField || "receptionist").trim();

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
    let body = await readJsonBody(req);
    body = normalizeIncomingBody(body); // ✅ critical fix for Zapier flattening

    const headers = {
      Authorization: `Bearer ${process.env.RETELL_API_KEY}`,
      "Content-Type": "application/json",
    };

    const missing_fields = [];
    const requiredCanonical = [
      ["meta", "agent_name"],
      ["meta", "agent_role"],
      ["core", "business_name"],
      ["core", "time_zone"],
    ];
    for (const [block, key] of requiredCanonical) {
      const v = pickCanonical(body, block, [key], [key], "Not provided");
      if (String(v) === "Not provided" || String(v).trim() === "") missing_fields.push(`${block}.${key}`);
    }

    const { role, templateId } = resolveRole(body);

    const agent_name = String(pickCanonical(body, "meta", ["agent_name"], ["agent_name"], "Samuel")).trim();

    const purchased_package = String(
      pickCanonical(body, "meta", ["purchased_package"], ["purchased_package"], role)
    ).trim();

    const purchased_add_ons = pickCanonical(
      body,
      "meta",
      ["purchased_add_ons"],
      ["purchased_add_ons", "Purchased Add Ons", "purchased_addons"],
      ""
    );

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
        ["business_email", "email", "user_email"],
        "not-provided@example.com"
      )
    ).trim();

    // ✅ Time zone for ALL agents (core first, scheduler fallback)
    const time_zone =
      String(pickCanonical(body, "core", ["time_zone"], ["time_zone", "timezone"], "")).trim() ||
      String(pickCanonical(body, "scheduler", ["time_zone"], ["time_zone", "timezone"], "")).trim() ||
      "America/New_York";

    const website = normalizeWebsite(
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
        ["services", "service_type", "primary_business_type", "home_service_type"],
        ""
      )
    ).trim();

    const extra_info = String(
      pickCanonical(body, "core", ["extra_info"], ["extra_info", "notes", "additional_info"], "")
    ).trim();

    // --- SCHEDULER BLOCK ---
    const calendar_system = String(
      pickCanonical(body, "scheduler", ["calendar_system"], ["calendar_system"], "")
    ).trim();
    const calendar_link = String(
      pickCanonical(body, "scheduler", ["calendar_link"], ["calendar_link", "booking_link"], "")
    ).trim();
    const after_hours_rules = toYesNo(
      pickCanonical(body, "scheduler", ["after_hours_rules"], ["after_hours_rules"], "")
    );
    const buffer_minutes = extractMinutes(
      pickCanonical(body, "scheduler", ["buffer_minutes"], ["buffer_time"], "")
    );
    const same_day_allowed = toYesNo(
      pickCanonical(body, "scheduler", ["same_day_allowed"], ["same_day_appointment_rules"], "")
    );
    const weekend_allowed = toYesNo(
      pickCanonical(body, "scheduler", ["weekend_allowed"], ["weekend_appointments"], "")
    );
    const service_durations = String(
      pickCanonical(body, "scheduler", ["service_durations"], ["service_durations"], "")
    ).trim();

    // --- INTAKE BLOCK ---
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

    // --- EMERGENCY BLOCK ---
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

    // --- LEAD REVIVAL BLOCK ---
    const lead_offer = String(
      pickCanonical(body, "lead_revival", ["follow_up_offer"], ["lead_revival_offer", "revival_offer"], "")
    ).trim();
    const lead_notification_email = String(
      pickCanonical(body, "lead_revival", ["notification_email"], ["notification_email"], "")
    ).trim();
    const includeLeadRevival = role === "lead_revival" || role === "operations" || hasSamuelAddon;

    // --- WEBSITE SCRAPE (non-blocking) ---
    let website_raw = null;
    let website_facts = "";
    if (website) {
      website_raw = await getWebsiteContext(website);
      website_facts = buildWebsiteFacts(website_raw, services || biz_name);
    }

    const websiteContext = website
      ? `Website: ${website}\n${website_facts ? website_facts : ""}\nIf asked about services/areas, prefer website facts. If unsure, ask clarifying questions.`
      : `No website provided. Do not invent services. Ask clarifying questions and capture details for a callback when needed.`;

    // --- PROMPT SECTIONS ---
    const coreContextLines = [
      `Business name: ${biz_name}`,
      `Business time zone: ${time_zone}`,
      business_hours ? `Business hours: ${business_hours}` : "",
      services ? `Primary services / business type: ${services}` : "",
      extra_info ? `Extra notes: ${extra_info}` : "",
    ].filter(Boolean);

    const schedulerDetails = [
      calendar_link ? `Booking link: ${calendar_link}` : `Booking link: (not provided — take details for manual scheduling)`,
      service_durations ? `Service durations: ${service_durations}` : "",
      buffer_minutes ? `Buffer minutes: ${buffer_minutes}` : "",
      same_day_allowed ? `Same-day allowed: ${same_day_allowed}` : "",
      weekend_allowed ? `Weekend allowed: ${weekend_allowed}` : "",
      after_hours_rules ? `After-hours rules: ${after_hours_rules}` : "",
      calendar_system ? `Calendar system: ${calendar_system}` : "",
      `Time zone: ${time_zone}`,
    ]
      .filter(Boolean)
      .join("\n- ");

    const EMERGENCY_RULE =
      role === "emergency_dispatch" || role === "operations"
        ? `
## EMERGENCY DISPATCH RULES
${emergency_definition ? `Emergency definition:\n- ${emergency_definition}\n` : ""}If the caller reports immediate danger, injury, fire, active hazard, or a truly urgent situation:
- Stay calm and ask for location/address first.
- Collect name and callback number.
- Tell them to contact local emergency services if appropriate.
${hasClientEmergencyNumber ? `- Business emergency contact: ${speech_emergency}.` : `- No business emergency number on file. Escalate immediately.`}
${urgent_instructions ? `- Follow urgent instructions: ${urgent_instructions}` : ""}
${emergency_alert_email ? `- Route emergency alerts to: ${emergency_alert_email}` : ""}
${emergency_sms_phone_digits ? `- Emergency SMS escalation (digits): ${emergency_sms_phone_digits}` : ""}
- Do not guess; escalate.
`.trim()
        : "";

    const ROLE_PROMPTS = {
      receptionist: {
        begin: `Thanks for calling ${biz_name}, this is ${agent_name}. How can I help you today?`,
        body: `
## CORE ROLE: RECEPTIONIST
- Greet callers and identify new vs returning.
- Collect: name, callback number, address/town, and a short description.
- Do not guess pricing/timelines/guarantees.
- If unsure, ask up to 2 focused questions, then take a message for callback.
`.trim(),
      },

      intake: {
        begin: `Thanks for calling ${biz_name}, this is ${agent_name}. What can I help you with today?`,
        body: `
## CORE ROLE: INTAKE
- Gather complete details and route to the right next step.
- Collect: name, callback, address/town, service needed, and urgency.
- Ask intake questions exactly as provided when available.
${intake_required_details ? `\n### Required details:\n- ${intake_required_details}` : ""}
${intake_questions ? `\n### Intake questions:\n- ${intake_questions}` : ""}
${intake_request_photos ? `\n### Photos via text:\n- Request photos: ${intake_request_photos}` : ""}
${intake_additional_info ? `\n### Additional intake instructions:\n- ${intake_additional_info}` : ""}
`.trim(),
      },

      scheduler: {
        begin: `Thanks for calling ${biz_name}, this is ${agent_name}. Are you looking to schedule an appointment?`,
        body: `
## CORE ROLE: SCHEDULER
- Schedule appointments OR collect details for manual scheduling.
- Apply these rules exactly:
- ${schedulerDetails}

### Flow:
1) Identify service.
2) Confirm preferred day/time window (confirm time zone if needed).
3) If booking link exists, guide them to book or confirm you will book it (per workflow).
4) If no booking link, take details and promise a callback to confirm availability.
`.trim(),
      },

      emergency_dispatch: {
        begin: `Emergency dispatch for ${biz_name}. This is ${agent_name}. What is the situation?`,
        body: `
## CORE ROLE: EMERGENCY DISPATCH
- Quickly assess danger.
- Collect: location/address, what happened, injuries, callback number.
- Escalate using the emergency rules below.
`.trim(),
      },

      lead_revival: {
        begin: `Hi, this is ${agent_name} from ${biz_name}. I'm following up on your recent quote—do you have a quick minute?`,
        body: `
## CORE ROLE: LEAD REVIVAL
- Confirm they received the quote and ask where they are in the decision process.
- Ask if scope/timing changed.
- Offer next steps (schedule follow-up or answer a quick question).
${lead_offer ? `- Offer: ${lead_offer}` : `- If no offer is provided, do not invent one.`}
${lead_notification_email ? `- Notify outcomes to: ${lead_notification_email}` : ""}
`.trim(),
      },

      operations: {
        begin: `Operations for ${biz_name}, this is ${agent_name}. How can I help you today?`,
        body: `
## CORE ROLE: OPERATIONS (MULTI-SKILL)
You can perform Reception, Intake, Scheduling, Lead Revival, and Emergency Dispatch.

### How to operate:
1) Identify intent (schedule, intake, emergency, follow-up).
2) Switch to the matching skill and proceed.
3) Never guess missing pricing/policies; ask or take a message for callback.
${includeLeadRevival ? `\nLead revival enabled: Yes` : ""}
`.trim(),
      },
    };

    const roleConfig = ROLE_PROMPTS[role] || ROLE_PROMPTS.receptionist;

    const BASE_RULES = `
## BASE RULES
- Do NOT mention you are an AI.
- Be concise: 1–2 sentences per turn when possible.
- Ask up to 2 clarifying questions if needed.
- Never invent pricing, guarantees, or policies.
- If info is missing or looks wrong: gather details + promise a callback.
- No symbols: say "dollars" instead of "$".
- Close with: "Thank you for calling. Someone will reach out soon."
`.trim();

    const voiceProfile = resolveVoiceProfile(body);

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

${roleConfig.body}

${EMERGENCY_RULE ? `\n${EMERGENCY_RULE}\n` : ""}

${BASE_RULES}
`.trim();

    const prompt_hash = sha256(FINAL_PROMPT);

    const llmResp = await axios.post(
      "https://api.retellai.com/create-retell-llm",
      {
        general_prompt: FINAL_PROMPT,
        begin_message: roleConfig.begin,
        model: "gpt-4o-mini",
      },
      { headers }
    );

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
          website: website || "",
          prompt_hash,
          debug_missing_fields: missing_fields,
          // Helpful for debugging Zapier flattening without breaking anything:
          debug_body_has_meta: Boolean(body.meta && typeof body.meta === "object"),
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
        missing_fields,
        website_received: Boolean(website),
        website_scraped: Boolean(website_raw),
        has_calendar_link: Boolean(calendar_link),
        has_client_emergency_number: Boolean(emergency_primary_phone_digits),
        voice_id: voiceProfile.voice_id,
        voice_gender: voiceProfile.gender,
        voice_tone: voiceProfile.tone,
        voice_source: voiceProfile.source,
        time_zone,
        // Uncomment for quick Zapier diagnosis if needed:
        // body_keys: Object.keys(body).slice(0, 50),
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
