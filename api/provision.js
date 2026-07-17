// /api/provision.js
const axios = require("axios");
const { kv } = require("@vercel/kv");

// -------------------- CORS --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// -------------------- BODY --------------------
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
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

// ✅ Better pick(): ignores "", whitespace, null-ish strings, Zapier {output:"..."}
function pick(obj, keys, fallback = undefined) {
  for (const k of keys) {
    let val = obj?.[k];

    if (val && typeof val === "object" && "output" in val) {
      val = val.output;
    }

    if (val === undefined || val === null) continue;

    if (typeof val === "string") {
      const s = val.trim();
      if (!s) continue;
      if (s.toLowerCase() === "null") continue;
      if (s.toLowerCase() === "undefined") continue;
      return s;
    }

    return val;
  }

  return fallback;
}

// -------------------- RETELL --------------------
const RETELL_BASE = "https://api.retellai.com";

function retellHeaders() {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) {
    throw new Error("Missing RETELL_API_KEY in Environment Variables.");
  }

  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

// Pull the exact working tools from a manually configured template LLM
async function getTemplateLlmTools(templateLlmId) {
  const id = String(templateLlmId || "").trim();
  if (!id) return null;

  const resp = await axios.get(
    `${RETELL_BASE}/get-retell-llm/${encodeURIComponent(id)}`,
    {
      headers: retellHeaders(),
      timeout: 20000,
    }
  );

  const tools = resp.data?.general_tools;
  return Array.isArray(tools) && tools.length ? tools : null;
}

function replaceAgentIdInTools(tools, agentId) {
  if (!Array.isArray(tools) || !agentId) return tools;

  return tools.map((tool) => {
    const cloned = JSON.parse(JSON.stringify(tool));

    if (Array.isArray(cloned?.api?.headers)) {
      cloned.api.headers = cloned.api.headers.map((h) => {
        const key = String(h?.key || "").toLowerCase();
        if (key === "x-agent-id") {
          return { ...h, value: agentId };
        }
        return h;
      });
    }

    return cloned;
  });
}

async function updateRetellLlmTools(llmId, generalTools) {
  if (!llmId || !Array.isArray(generalTools)) return;

  await axios.patch(
    `${RETELL_BASE}/update-retell-llm/${encodeURIComponent(llmId)}`,
    {
      general_tools: generalTools,
    },
    {
      headers: retellHeaders(),
      timeout: 20000,
    }
  );
}

// -------------------- ROLE NORMALIZATION --------------------
function normalizeRole(roleRaw) {
  const r = String(roleRaw || "").toLowerCase().trim();

  if (
    r.includes("full staff") ||
    r.includes("full_staff") ||
    r.includes("operations") ||
    r.includes("operator")
  ) {
    return "operations";
  }

  if (r.includes("estimate")) return "estimator";
  if (r.includes("lead") || r.includes("revival")) return "lead_revival";
  if (r.includes("dispatch") || r.includes("emergency")) return "emergency";
  if (r.includes("intake")) return "intake";
  if (r.includes("sched")) return "scheduler";
  if (r.includes("reception") || r.includes("front")) return "receptionist";

  const map = {
    receptionist: "receptionist",
    front_desk: "receptionist",
    scheduler: "scheduler",
    scheduling: "scheduler",
    intake: "intake",
    intake_specialist: "intake",
    emergency: "emergency",
    emergency_dispatch: "emergency",
    dispatcher: "emergency",
    lead_revival: "lead_revival",
    revival: "lead_revival",
    operations: "operations",
    full_staff: "operations",
    operator: "operations",
    estimator: "estimator",
  };

  return map[r] || "receptionist";
}

// -------------------- BASE URL (internal API calls) --------------------
function getBaseUrl(req) {
  const envBase = process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || "";
  if (envBase) return String(envBase).replace(/\/+$/, "");

  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

// -------------------- VOICE --------------------
function resolveVoice(body) {
  const tone = String(pick(body, ["voice_tone", "tone"], "warm"))
    .toLowerCase()
    .trim();

  const gender = String(
    pick(body, ["agent_gender", "voice_gender", "gender"], "female")
  )
    .toLowerCase()
    .trim();

  const VOICE_MAP = {
    female_warm: process.env.VOICE_FEMALE_WARM,
    female_calm: process.env.VOICE_FEMALE_CALM,
    female_authoritative: process.env.VOICE_FEMALE_AUTHORITATIVE,
    male_warm: process.env.VOICE_MALE_WARM,
    male_calm: process.env.VOICE_MALE_CALM,
    male_authoritative: process.env.VOICE_MALE_AUTHORITATIVE,
  };

  const voiceKey = `${gender}_${tone}`;
  const voiceId =
    VOICE_MAP[voiceKey] ||
    process.env.DEFAULT_VOICE_ID ||
    "11fb5674c35b44638d387693994e63f4";

  return { voiceKey, voiceId, gender, tone };
}

// -------------------- WEBSITE SCRAPE --------------------
function normalizeUrl(url) {
  if (!url) return "";
  let u = String(url).trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u;
}

function cleanScrapedText(raw) {
  if (!raw) return "";

  let text = String(raw);
  text = text.replace(/!\[.*?\]\(.*?\)\s*/g, "");
  text = text.replace(/Markdown Content:\s*/gi, "");
  text = text.replace(/-{3,}/g, "");
  text = text.replace(/\r/g, "");
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

function extractWebsiteFromText(text) {
  if (!text) return "";

  const s = String(text);
  const m1 = s.match(/website\s*[:=]\s*(https?:\/\/[^\s]+)/i);
  if (m1?.[1]) return m1[1].trim();

  const m2 = s.match(/website\s*[:=]\s*([a-z0-9.-]+\.[a-z]{2,}[^\s]*)/i);
  if (m2?.[1]) return m2[1].trim();

  return "";
}

async function scrapeWebsiteText(url) {
  const u = normalizeUrl(url);
  if (!u) return { ok: false, text: "", reason: "no_url" };

  const scrapeUrl = `https://r.jina.ai/${u}`;

  try {
    const resp = await axios.get(scrapeUrl, {
      timeout: 15000,
      headers: { "X-Return-Format": "markdown" },
    });

    let text = cleanScrapedText(resp.data || "");
    const MAX_CHARS = 1800;

    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS) + "\n...(truncated)";
    }

    if (text.length < 80) {
      return { ok: false, text: "", reason: "too_short" };
    }

    return { ok: true, text, reason: "ok" };
  } catch (e) {
    return {
      ok: false,
      text: "",
      reason: e?.response?.status ? `http_${e.response.status}` : "scrape_failed",
    };
  }
}

// -------------------- CALENDAR CONFIG HELPERS --------------------
function normalizeTimeZone(tz) {
  const raw = String(tz || "").trim();
  if (!raw) return "America/New_York";

  const map = {
    est: "America/New_York",
    edt: "America/New_York",
    eastern: "America/New_York",
    "eastern time": "America/New_York",
    cst: "America/Chicago",
    cdt: "America/Chicago",
    central: "America/Chicago",
    "central time": "America/Chicago",
    mst: "America/Denver",
    mdt: "America/Denver",
    mountain: "America/Denver",
    "mountain time": "America/Denver",
    pst: "America/Los_Angeles",
    pdt: "America/Los_Angeles",
    pacific: "America/Los_Angeles",
    "pacific time": "America/Los_Angeles",
  };

  const lower = raw.toLowerCase();
  return map[lower] || raw;
}

function normalizeServiceKeyToSlug(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/_/g, "-");
}

function extractCalendarConfig(body) {
  const calUsername = pick(
    body,
    [
      "cal_username",
      "calendar_username",
      "calcom_username",
      "cal_com_username",
      "booking_username",
    ],
    ""
  );

  const calSlugRaw = pick(
    body,
    [
      "cal_slug",
      "calendar_slug",
      "event_type_slug",
      "eventTypeSlug",
      "service_key",
      "booking_service_key",
    ],
    ""
  );

  const serviceKey = pick(
    body,
    ["service_key", "booking_service_key", "default_service_key"],
    calSlugRaw || ""
  );

  const timeZone = normalizeTimeZone(
    pick(body, ["timezone", "tz", "time_zone"], "America/New_York")
  );

  return {
    cal_username: calUsername,
    cal_slug: normalizeServiceKeyToSlug(calSlugRaw),
    service_key: String(serviceKey || "").trim(),
    timezone: timeZone,
  };
}

// -------------------- SETUP BLOCKS (GLOBAL + ROLE) --------------------
function getGlobalSetupBlock(body) {
  return pick(
    body,
    ["global_setup", "business_setup", "company_setup", "global_info"],
    ""
  );
}

function buildGlobalSetupFromFields(body) {
  const bizName = pick(body, ["business_name", "biz_name", "company"], "");
  const website = pick(body, ["website", "web", "website_url", "site", "url"], "");
  const tz = pick(body, ["timezone", "tz", "time_zone"], "");
  const hours = pick(body, ["business_hours", "hours"], "");
  const area = pick(body, ["service_area", "service_area_cities", "cities", "towns"], "");
  const industry = pick(body, ["industry", "primary_business_type", "business_type"], "");
  const phone = pick(body, ["business_phone", "phone"], "");
  const email = pick(body, ["email", "client_email", "summary_email", "alert_email"], "");

  const facts = [];
  if (bizName) facts.push(`Business Name: ${bizName}`);
  if (industry) facts.push(`Industry: ${industry}`);
  if (area) facts.push(`Service Area: ${area}`);
  if (hours) facts.push(`Business Hours: ${hours}`);
  if (tz) facts.push(`Time Zone: ${tz}`);
  if (phone) facts.push(`Primary Phone: ${phone}`);
  if (email) facts.push(`Email for Summaries/Alerts: ${email}`);
  if (website) facts.push(`Website: ${website}`);

  if (!facts.length) return "";

  const instructions = [
    `Receptionist Instructions:`,
    `- Be warm, calm, and professional.`,
    `- Ask one question at a time.`,
    `- Collect: caller name, callback number, and a brief service goal.`,
    `- Do NOT give exact pricing or guarantees; offer to have the team follow up.`,
    `- If unsure about a service detail, take a message rather than guessing.`,
  ];

  return [
    `GLOBAL BUSINESS INFO (internal reference):`,
    ...facts.map((l) => `- ${l}`),
    ``,
    ...instructions,
  ].join("\n");
}

function getRoleSetupBlock(body, roleKey) {
  return pick(body, [`${roleKey}_setup`, "role_setup", "setup_block"], "");
}

function buildSetupForRole(body, roleKey) {
  const scheduler = pick(body, ["scheduler_setup", "scheduler_config"], "");
  const intake = pick(body, ["intake_setup", "intake_config"], "");
  const emergency = pick(body, ["emergency_setup", "dispatch_setup", "dispatch_config"], "");
  const lead = pick(body, ["lead_revival_setup", "lead_revival_config"], "");
  const estimator = pick(body, ["Estimator", "estimator_setup", "estimate_setup"], "");

  const blocks = [];

  if (roleKey === "operations") {
    if (scheduler) blocks.push(`SCHEDULING SETUP:\n${scheduler}`);
    if (intake) blocks.push(`INTAKE SETUP:\n${intake}`);
    if (emergency) blocks.push(`EMERGENCY DISPATCH SETUP:\n${emergency}`);
    if (lead) blocks.push(`LEAD REVIVAL SETUP:\n${lead}`);
  }

  if (roleKey === "scheduler" && scheduler) blocks.push(`SCHEDULING SETUP:\n${scheduler}`);
  if (roleKey === "intake" && intake) blocks.push(`INTAKE SETUP:\n${intake}`);
  if (roleKey === "emergency" && emergency) blocks.push(`EMERGENCY DISPATCH SETUP:\n${emergency}`);
  if (roleKey === "lead_revival" && lead) blocks.push(`LEAD REVIVAL SETUP:\n${lead}`);

  // Package capability — attach to any role when present
  if (estimator) blocks.push(`ESTIMATOR SETUP:\n${estimator}`);

  return blocks.join("\n\n");
}

function formatSetupBlock(setupText) {
  if (!setupText) return "";

  return `BUSINESS SETUP (owner answers from onboarding form — internal rules):
${setupText}

IMPORTANT:
- Do NOT ask the caller these onboarding questions.
- Use these answers as your operating instructions.`;
}

// -------------------- URGENCY FALLBACKS (CODED) --------------------
function buildUrgencyFallbackBlock(roleKey) {
  const common = [
    `URGENCY & EMERGENCY CLASSIFICATION (ALWAYS ON — even without Emergency Dispatch):`,
    `- "Urgent" means: caller says they need a call back ASAP / immediately / right away, or describes time-sensitive risk or safety concerns.`,
    `- "Emergency" means: immediate danger to life, severe injury, active fire, gas leak, ongoing crime, or anything requiring 911.`,
    ``,
    `URGENCY TRIGGERS (treat as URGENT if any are present):`,
    `- Caller explicitly says: "urgent", "emergency", "ASAP", "right away", "immediately", "call me back now", "I need someone today".`,
    `- Safety/property risk language: "flooding", "sparking", "smoke", "leak", "no heat", "no water", "break-in", "unsafe", "locked out" (depends on business).`,
    `- Deadline language: "today", "before close", "missed deadline", "court", "inspection", "insurance".`,
    ``,
    `CRITICAL RESPONSE RULES WHEN URGENT/EMERGENCY IS DETECTED:`,
    `1) Stay calm. Acknowledge: "Okay — I understand this is urgent."`,
    `2) IMMEDIATELY collect (one question at a time):`,
    `    - Caller name`,
    `    - Best callback number (repeat it back to confirm)`,
    `    - Short issue summary in 1 sentence`,
    `    - Location/address ONLY if relevant to the business (e.g., service call)`,
    `3) Ask this exact question: "Is anyone in immediate danger right now? Yes or no."`,
    `    - If YES: advise calling 911 immediately (do not debate).`,
    `4) Promise language (IMPORTANT):`,
    `    - You MAY say: "I’m flagging this as urgent for the team."`,
    `    - You MUST NOT guarantee response times unless the business setup explicitly promises it.`,
    ``,
    `LOGGING REQUIREMENTS (non-negotiable):`,
    `- Ensure the call summary clearly includes:`,
    `  - urgency_level: urgent (or emergency if 911-level)`,
    `  - callback_needed: yes`,
    `  - a short "urgent_reason" phrase (e.g., "requested immediate callback" / "leak reported")`,
  ];

  const dispatchOnly = [
    ``,
    `EMERGENCY DISPATCH UPGRADE BEHAVIOR (only if your BUSINESS SETUP includes dispatch rules/contacts):`,
    `- If dispatch contacts/rules exist in BUSINESS SETUP, follow them precisely.`,
    `- If no dispatch contact is available, still follow the fallback above and flag as URGENT.`,
  ];

  if (roleKey === "emergency" || roleKey === "operations") {
    return common.concat(dispatchOnly).join("\n");
  }

  return common.join("\n");
}

// -------------------- PROMPT BASES --------------------
function buildPromptBase({ agentName, bizName, roleKey }) {
  const stabilityLogic = [
    `# ANTI-REPEAT / BARGE-IN RULES (CRITICAL STABILITY)`,
    `- You MUST NOT restart, repeat, or re-say your greeting because of background noise, phone line "clunks", or early talk-over.`,
    `- If you hear noise while speaking your OPENER, DO NOT FLINCH. Continue your sentence to the end.`,
    `- If the caller interrupts you during the first 5 seconds, finish your current sentence before pausing.`,
    `- NEVER repeat the phrase "I'm calling from..." more than once per call.`,
    `- If the audio is unclear at the start, wait 1 second for the line to stabilize BEFORE speaking the opener.`,
  ].join("\n");

  const stagingLogic = [
    `# CONVERSATION FLOW CONTROL (STRICT STAGES)`,
    `Stage 1: DISCOVERY - If the caller asks about services, pricing, or "what you do," stay here. Provide information and wait for a reaction.`,
    `Stage 2: INTEREST - If the caller expresses a desire to move forward (e.g., "that sounds good"), ask if they would like to check availability.`,
    `Stage 3: BOOKING - ONLY move to booking/confirming if the caller explicitly says "Yes" or provides a specific day/time.`,
    ``,
    `# DATA VERIFICATION & SLOW PRONUNCIATION RULES (CRITICAL)`,
    `- When repeating the phone number or email back to the caller to confirm accuracy, you MUST drop your speed and speak normally, slowly, and clearly. Do NOT rush.`,
    `- For phone numbers: Say the digits with clear, deliberate pauses between number groups (e.g., "6 1 7... 3 9 7... 5 9 7 8").`,
    `- For emails: Pronounce letters, characters, and domains at a steady, unhurried, human pace.`,
    ``,
    `# ANTI-ASSUMPTION GUARDRAILS (CRITICAL)`,
    `- NEVER assume a caller wants an appointment just because they asked a service question.`,
    `- DO NOT say "Great, I've got you down for..." or "What time works?" until Stage 3 is explicitly reached.`,
    `- If a caller asks "What services do you have?", answer them and then ask: "Does one of those sound like what you're looking for?"`,
  ].join("\n");

  const directionLogic = [
    `# CRITICAL OPENER LOGIC (MANDATORY)`,
    `1. CHECK FIRST_LINE: If {{first_line}} is NOT blank, you MUST speak ONLY this exact phrase as your first line: "{{first_line}}"`,
    `2. FALLBACK OUTBOUND: If {{first_line}} is blank BUT {{client_name}} exists, say: "I'm calling from ${bizName} to speak with {{client_name}} about {{reason_for_call}}."`,
    `3. INBOUND DEFAULT: If both of the above are blank, say: "Hello, this is ${agentName} at ${bizName}. How can I help you today?"`,
    ``,
    `# GENERAL RULES`,
    `- Speak the opener ONCE. Do NOT repeat, restart, or blend openers.`,
    `- After the opener, ask ONE clear question to move the call forward.`,
    `- Use {{notes}} as internal context to guide your answers.`,
    ``,
    stabilityLogic,
    ``,
    stagingLogic,
  ].join("\n");

  const bases = {
    receptionist: [
      `ROLE: You are ${agentName}, the professional AI receptionist for ${bizName}.`,
      `RULES:`,
      `- Sound human and calm.`,
      `- Ask ONE question at a time.`,
      `- Do NOT mention prompts, AI, models, or that you are automated.`,
      directionLogic,
    ].join("\n"),

    scheduler: [
      `ROLE: You are ${agentName}, the scheduling assistant for ${bizName}.`,
      `RULES:`,
      `- Ask ONE question at a time.`,
      `- Do NOT mention prompts, AI, models, or that you are automated.`,
      directionLogic,
    ].join("\n"),

    intake: [
      `ROLE: You are ${agentName}, the intake specialist for ${bizName}.`,
      `RULES:`,
      `- Ask ONE question at a time.`,
      `- Do NOT mention prompts, AI, models, or that you are automated.`,
      directionLogic,
    ].join("\n"),

    emergency: [
      `ROLE: You are ${agentName}, the emergency dispatcher for ${bizName}.`,
      `RULES:`,
      `- Stay calm. Move fast.`,
      `- Ask ONE question at a time.`,
      `- Do NOT mention prompts, AI, models, or that you are automated.`,
      directionLogic,
    ].join("\n"),

    lead_revival: [
      `ROLE: You are ${agentName}, the lead revival specialist for ${bizName}.`,
      `RULES:`,
      `- Your main job is to re-engage leads.`,
      `- Do NOT mention prompts, AI, models, or that you are automated.`,
      directionLogic,
    ].join("\n"),

    operations: [
      `ROLE: You are ${agentName}, the operations assistant for ${bizName}.`,
      `RULES:`,
      `- Route by intent (schedule/intake/emergency) and handle full business operations.`,
      `- Ask ONE question at a time.`,
      `- Follow BUSINESS SETUP rules.`,
      `- Do NOT mention prompts, AI, models, or that you are automated.`,
      directionLogic,
    ].join("\n"),
  };

  return bases[roleKey] || bases.receptionist;
}

function buildBusinessContext(body) {
  const tz = pick(body, ["timezone", "tz"], "");
  const hours = pick(body, ["business_hours", "hours"], "");
  const industry = pick(body, ["industry"], "");

  const lines = [];
  if (industry) lines.push(`Industry: ${industry}`);
  if (tz) lines.push(`Time Zone: ${tz}`);
  if (hours) lines.push(`Business Hours: ${hours}`);

  if (!lines.length) return "";

  return `BUSINESS CONTEXT:
- ${lines.join("\n- ")}`;
}

// ✅ Updated scheduler block
function buildSchedulerEmailGateBlock() {
  return [
    `SCHEDULER FLOW (STRICT ORDER — ONE QUESTION AT A TIME):`,
    `CORE PRINCIPLE`,
    `- Speak like an experienced receptionist, not an online booking form.`,
    `- Allow callers to describe what they need in their own words.`,
    `- Do NOT require callers to know the business's internal appointment or service names.`,
    `- Understand the caller's intent, then silently match it to the closest configured appointment type.`,
    `STEP 1 — UNDERSTAND THE REQUEST`,
    `- If the caller has already explained why they are calling, do NOT ask them to repeat themselves.`,
    `- Acknowledge the request naturally.`,
    `- Internally match the caller's request to the closest configured appointment type.`,
    `- If the caller only says they want to schedule or book an appointment, ask ONE natural question such as:`,
    `  - "What can we help you with today?"`,
    `  - "What would you like to schedule?"`,
    `  - "Can you tell me a little about what you need?"`,
    `- Do NOT automatically ask: "What service are you looking to book?"`,
    `- Do NOT expose internal service names, keys, IDs, slugs, hyphens, or underscores.`,
    `- If multiple appointment types could apply, ask ONE clarifying question.`,
    `- If there is one clear match, continue without asking the caller to choose from a list.`,
    `STEP 2 — CHECK AVAILABILITY`,
    `- Say: "Let me check the schedule for you."`,
    `- Call the availability tool using the internally matched appointment type.`,
    `- Do NOT ask: "Would you like me to check availability?"`,
    `- Do NOT guess or manually suggest appointment times.`,
    `STEP 3 — OFFER FIRST AVAILABLE`,
    `- Offer ONE available appointment at a time.`,
    `- ALWAYS begin with the earliest available slot returned by the scheduling tool.`,
    `- Example: "The first opening I have is Tuesday at 10:00 AM. Would that work for you?"`,
    `- If declined, offer the next available slot.`,
    `- Do NOT list multiple appointment times unless the caller asks.`,
    `STEP 4 — SLOT CONFIRMATION (CRITICAL GATE)`,
    `- Wait until the caller clearly accepts a specific appointment time.`,
    `- Do NOT collect personal information before an appointment time has been selected.`,
    `STEP 5 — COLLECT DETAILS (STRICT ORDER)`,
    `1) Ask: "Can I get your full name for the appointment?"`,
    `2) Ask: "What's the best email to send your appointment confirmation to?"`,
    `   - Convert spoken email wording into normal email format whenever obvious.`,
    `   - Repeat the completed email back in standard email format.`,
    `   - Example: "I have rosedossantos331@gmail.com. Is that correct?"`,
    `   - Do NOT read emails with spaces unless the caller is spelling them out for correction.`,
    `   - Do NOT continue until the email is confirmed.`,
    `3) Ask: "What's the best phone number for your appointment?"`,
    `STEP 6 — BOOK APPOINTMENT`,
    `- Call the booking tool ONLY after:`,
    `  - the appointment type has been determined`,
    `  - a specific appointment time has been accepted`,
    `  - the caller's required information has been collected`,
    `- Use the selected appointment type, selected appointment time, name, email, and phone.`,
    `- Never claim an appointment has been booked before the booking tool succeeds.`,
    `STEP 7 — CONFIRMATION`,
    `- If the booking succeeds, confirm the appointment using the exact date and time returned by the booking tool.`,
    `- If a confirmation email is available, tell the caller it has been sent.`,
    `- If a meeting link exists, do NOT read the URL aloud. Simply let the caller know it is included in the confirmation email.`,
    `- Example: "You're all set for Tuesday, July 14th at 5:00 PM. I've sent your confirmation email with all of the appointment details and your meeting link."`,
    `- Only read a meeting link aloud if the caller specifically requests it or cannot access their email.`,
    `- If the booking fails, apologize briefly and offer the next appropriate step.`,
    ``,
    `CRITICAL RULES:`,
    `- You do NOT know availability unless returned by the system.`,
    `- NEVER suggest times without checking.`,
    `- ALWAYS offer the earliest slot first.`,
    `- NEVER collect user details before a slot is accepted.`,
    `- NEVER confirm a booking without tool success.`,
    `- Ask ONE question at a time.`,
    `- Speak naturally.`,
    `- Never say internal field names, tool names, raw service keys, or slugs out loud.`,
  ].join("\n");
}

function buildReceptionistNoBookingBlock() {
  return [
    `SCHEDULER LIMIT (PLAN-BASED):`,
    `- You do NOT book appointments.`,
    `- You do NOT reschedule or cancel appointments.`,
    `- If a caller wants to book/reschedule/cancel:`,
    `  1) Collect caller name`,
    `  2) Collect callback number`,
    `  3) Collect best email`,
    `  4) Ask what service they want (one service)`,
    `  5) Ask preferred day + time window (morning/afternoon/evening)`,
    `  6) Say: "I’ll pass this to the scheduling team and they’ll confirm shortly."`,
    `- Do NOT promise a reserved time. Do NOT call any booking tools/APIs.`,
    `- If asked why: "I can take your details and have the team confirm—so we get it right."`,
  ].join("\n");
}

// -------------------- IDEMPOTENCY HELPERS --------------------
async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getSubmissionId(body) {
  return String(
    pick(body, ["jotform_submission_id", "submission_id", "idempotency_key", "job_id"], "")
  ).trim();
}

async function getExistingProvision(idemKey) {
  const existing = await kv.get(idemKey);
  if (existing && typeof existing === "object" && existing.agent_id) return existing;
  return null;
}

async function acquireLock(lockKey, ttlSeconds = 120) {
  return kv.set(lockKey, "1", { nx: true, ex: ttlSeconds });
}

async function releaseLock(lockKey) {
  try {
    await kv.del(lockKey);
  } catch {}
}

function normalizeProvisionRecord({
  mode,
  llmId,
  agentId,
  phoneNumber,
  phoneNumberId,
  numberTierFinal,
  voiceKey,
  roleKey,
}) {
  return {
    mode,
    llm_id: llmId,
    agent_id: agentId,
    phone_number: phoneNumber ?? "(not purchased)",
    phone_number_id: phoneNumberId ?? null,
    number_tier: numberTierFinal ?? null,
    voice_key: voiceKey ?? null,
    role: roleKey ?? null,
    created_at: new Date().toISOString(),
  };
}

// -------------------- HANDLER --------------------
module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  let lockKey = null;

  try {
    const body = await readJsonBody(req);
    const debug = String(pick(body, ["debug"], "false")).toLowerCase() === "true";

    if (debug) {
      return res.status(200).json({ ok: true, debug: true, received: body });
    }

    const submissionId = getSubmissionId(body);
    if (!submissionId) {
      return res.status(400).json({ ok: false, error: "Missing submission ID." });
    }

    const idemKey = `prov:${submissionId}`;
    lockKey = `provlock:${submissionId}`;

    const existing = await getExistingProvision(idemKey);
    if (existing) {
      return res.status(200).json({ ok: true, idempotent: true, ...existing });
    }

    const locked = await acquireLock(lockKey, 120);
    if (!locked) {
      for (let i = 0; i < 8; i++) {
        await sleep(600);
        const after = await getExistingProvision(idemKey);
        if (after) {
          return res.status(200).json({ ok: true, idempotent: true, ...after });
        }
      }

      return res.status(409).json({ ok: false, error: "Provisioning in progress" });
    }

    const purchaseNumber =
      String(pick(body, ["purchase_number", "buy_number"], "false")).toLowerCase() === "true";

    const mode = String(
      pick(body, ["mode"], purchaseNumber ? "agent_and_number" : "agent_only")
    )
      .toLowerCase()
      .trim();

    // ---------------------------------------------------------
    // V2 ARCHITECTURE: SINGLE SOURCE OF TRUTH (HARDENED)
    // ---------------------------------------------------------
    const rawSubscription = pick(
      body,
      [
        "my_subscriptions_text",
        "my_subscriptions",
        "subscription",
        "product_name",
      ],
      ""
    );

    const subscription = String(rawSubscription)
      .split(/\r?\n/)[0]
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");

    const MASTER_TEMPLATE_LLM_ID = "llm_18a432fcc18b235399fc298809ef";

    const AI_EMPLOYEES = {
      "peter — estimator": {
        agent_name: "Peter",
        gender: "male",
        tone: "calm",
        role: "estimator",
        template_llm_id: MASTER_TEMPLATE_LLM_ID,
        number_tier: "standard"
      },
      "marcus — front desk receptionist": {
        agent_name: "Marcus",
        gender: "male",
        tone: "calm",
        role: "receptionist",
        template_llm_id: MASTER_TEMPLATE_LLM_ID,
        number_tier: "standard",
      },
      "ava — ai scheduler": {
        agent_name: "Ava",
        gender: "female",
        tone: "warm",
        role: "scheduler",
        template_llm_id: MASTER_TEMPLATE_LLM_ID,
        number_tier: "premium"
      }
      // Add future AI employees here
    };

    const config = AI_EMPLOYEES[subscription];

    if (!config) {
      throw new Error(`Unknown or missing subscription selected: "${rawSubscription}". Cannot provision AI.`);
    }

    // Inject the configuration into the body payload ONLY if not already provided
    body.agent_name ??= config.agent_name;
    body.agent_gender ??= config.gender;
    body.voice_tone ??= config.tone;
    body.agent_role ??= config.role;
    body.template_llm_id ??= config.template_llm_id;
    body.number_tier ??= config.number_tier;
    // ---------------------------------------------------------

    const bizName = pick(body, ["business_name", "biz_name", "company"], "Roots and Daiseys");
    
    // Values extracted safely via map injection
    const agentName = pick(body, ["agent_name", "a_name", "name"]); 
    const roleKey = normalizeRole(pick(body, ["agent_role", "role", "a_role"]));

    const { voiceKey, voiceId } = resolveVoice(body);
    const explicitPrompt = pick(body, ["final_prompt", "general_prompt", "prompt"], "");

    const globalSetup = getGlobalSetupBlock(body) || buildGlobalSetupFromFields(body);
    const roleSetup = getRoleSetupBlock(body, roleKey) || buildSetupForRole(body, roleKey);
    const setupSection = formatSetupBlock([globalSetup, roleSetup].filter(Boolean).join("\n\n"));

    let website = pick(body, ["website", "web", "website_url", "site", "url"], "");
    if (!website) {
      website = extractWebsiteFromText(globalSetup);
    }

    const scrape = website
      ? await scrapeWebsiteText(website)
      : { ok: false, text: "", reason: "no_url" };

    let promptToUse = explicitPrompt;
    let promptSource = "explicit_prompt";

    if (!promptToUse) {
      let base = buildPromptBase({ agentName, bizName, roleKey });

      const outboundRules = [
        `OUTBOUND BEHAVIOR RULES (apply ONLY when {{first_line}} is NOT blank):`,
        `- You initiated the call.`,
        `- Use the first_line opener precisely.`,
        `- Never forget to state you are from ${bizName}.`,
        `- Never ask "How can I help you?" as your first line on outbound.`,
      ].join("\n");

      const outboundRoles = new Set(["receptionist", "lead_revival", "operations"]);
      if (outboundRoles.has(roleKey)) {
        base = [base, outboundRules].join("\n\n");
      }

      const urgencyFallback = buildUrgencyFallbackBlock(roleKey);

      const tierProtection =
        roleKey === "receptionist"
          ? buildReceptionistNoBookingBlock()
          : roleKey === "scheduler" || roleKey === "operations"
          ? buildSchedulerEmailGateBlock()
          : "";

      const ctx = buildBusinessContext(body);

      const websiteSection = scrape.ok
        ? `WEBSITE KNOWLEDGE:\n${scrape.text}`
        : `WEBSITE KNOWLEDGE: (Not available: ${scrape.reason})`;

      promptToUse = [base, urgencyFallback, tierProtection, ctx, setupSection, websiteSection]
        .filter(Boolean)
        .join("\n\n");

      promptSource = "built_prompt";
    }

    const baseUrl = getBaseUrl(req);
    const schedulingCapable = roleKey !== "emergency";

    // ✅ Uses the injected template_llm_id from the map
    const templateLlmId =
      pick(body, ["template_llm_id", "retell_template_llm_id"], "");

    const templateTools = await getTemplateLlmTools(templateLlmId);

    const llmPayload = {
      general_prompt: promptToUse,
      model: pick(body, ["llm_model"], "gpt-4o-mini"),
      ...(templateTools ? { general_tools: templateTools } : {}),
    };

    const llmResp = await axios.post(
      `${RETELL_BASE}/create-retell-llm`,
      llmPayload,
      { headers: retellHeaders(), timeout: 20000 }
    );

    const llmId = llmResp.data.llm_id || llmResp.data.id;

    const agentResp = await axios.post(
      `${RETELL_BASE}/create-agent`,
      {
        agent_name: `${bizName} - ${agentName} (${roleKey})`,
        voice_id: voiceId,
        response_engine: {
          type: "retell-llm",
          llm_id: llmId,
        },
        metadata: {
          business_name: bizName,
          agent_role: roleKey,
          submission_id: submissionId,
        },
      },
      { headers: retellHeaders(), timeout: 20000 }
    );

    const agentId = agentResp.data.agent_id || agentResp.data.id;

    // ✅ FORCE speech settings AFTER creation
    await axios.patch(
      `${RETELL_BASE}/update-agent/${encodeURIComponent(agentId)}`,
      {
        interruption_sensitivity: 0,
        responsiveness: 1,
      },
      { headers: retellHeaders(), timeout: 20000 }
    );

    // After the new agent exists, replace any template X-Agent-Id headers
    // so the cloned functions point to this specific provisioned agent.
    if (templateTools && templateTools.length) {
      const toolsWithNewAgentId = replaceAgentIdInTools(templateTools, agentId);
      await updateRetellLlmTools(llmId, toolsWithNewAgentId);
    }

    // -------------------- SAVE CALENDAR CONFIG FOR THIS AGENT --------------------
    const calendarConfig = extractCalendarConfig(body);

    if (calendarConfig.cal_username && calendarConfig.cal_slug) {
      await kv.set(
        `agentcfg:${agentId}`,
        {
          agent_id: agentId,
          submission_id: submissionId,
          business_name: bizName,
          role: roleKey,
          cal_username: calendarConfig.cal_username,
          cal_slug: calendarConfig.cal_slug,
          service_key: calendarConfig.service_key || calendarConfig.cal_slug,
          timezone: calendarConfig.timezone || "America/New_York",
          created_at: new Date().toISOString(),
        },
        { ex: 60 * 60 * 24 * 30 }
      );
    }

    let phoneNumber = "(not purchased)";
    let phoneNumberId = null;
    const numberTierFinal = body.number_tier || "standard";

    await kv.set(
      idemKey,
      normalizeProvisionRecord({
        mode,
        llmId,
        agentId,
        phoneNumber,
        phoneNumberId,
        numberTierFinal,
        voiceKey,
        roleKey,
      }),
      { ex: 60 * 60 * 24 * 30 }
    );

    if (mode === "agent_and_number") {
      const buyResp = await axios.post(`${baseUrl}/api/buy-number`, {
        agent_id: agentId,
        business_name: bizName,
        idempotency_key: submissionId,
        number_tier: numberTierFinal,
      });

      if (buyResp?.data?.ok) {
        phoneNumber = buyResp.data.phone_number;
        phoneNumberId = buyResp.data.phone_number_id;

        await kv.set(
          idemKey,
          normalizeProvisionRecord({
            mode,
            llmId,
            agentId,
            phoneNumber,
            phoneNumberId,
            numberTierFinal,
            voiceKey,
            roleKey,
          }),
          { ex: 60 * 60 * 24 * 30 }
        );
      }
    }

    return res.status(200).json({
      ok: true,
      agent_id: agentId,
      phone_number: phoneNumber,
      role: roleKey,
      prompt_source: promptSource,
      website_used: website ? normalizeUrl(website) : "",
      website_scrape_reason: scrape.reason,
      calendar_config_saved: !!(calendarConfig.cal_username && calendarConfig.cal_slug),
      cal_username: calendarConfig.cal_username || "",
      cal_slug: calendarConfig.cal_slug || "",
      timezone: calendarConfig.timezone || "America/New_York",
      scheduling_capable: schedulingCapable,
      tools_cloned_from_template: !!templateTools,
      template_llm_id_used: templateLlmId || "",
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.response?.data || err.message,
    });
  } finally {
    if (lockKey) {
      await releaseLock(lockKey);
    }
  }
};
