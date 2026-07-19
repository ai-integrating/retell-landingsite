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
    throw new Error(
      "Missing RETELL_API_KEY in Environment Variables."
    );
  }

  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

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

  return Array.isArray(tools) && tools.length
    ? tools
    : null;
}

function replaceAgentIdInTools(tools, agentId) {
  if (!Array.isArray(tools) || !agentId) return tools;

  return tools.map((tool) => {
    const cloned = JSON.parse(JSON.stringify(tool));

    if (Array.isArray(cloned?.api?.headers)) {
      cloned.api.headers = cloned.api.headers.map((h) => {
        const key = String(h?.key || "").toLowerCase();

        if (key === "x-agent-id") {
          return {
            ...h,
            value: agentId,
          };
        }

        return h;
      });
    }

    return cloned;
  });
}

async function updateRetellLlmTools(
  llmId,
  generalTools
) {
  if (!llmId || !Array.isArray(generalTools)) return;

  await axios.patch(
    `${RETELL_BASE}/update-retell-llm/${encodeURIComponent(
      llmId
    )}`,
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
  const r = String(roleRaw || "")
    .toLowerCase()
    .trim();

  if (
    r.includes("full staff") ||
    r.includes("full_staff") ||
    r.includes("operations") ||
    r.includes("operator")
  ) {
    return "operations";
  }

  if (r.includes("estimate")) return "estimator";

  if (
    r.includes("lead") ||
    r.includes("revival")
  ) {
    return "lead_revival";
  }

  if (
    r.includes("dispatch") ||
    r.includes("emergency")
  ) {
    return "emergency";
  }

  if (r.includes("intake")) return "intake";
  if (r.includes("sched")) return "scheduler";

  if (
    r.includes("reception") ||
    r.includes("front")
  ) {
    return "receptionist";
  }

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
    receptionist_estimator: "estimator",
    estimator_receptionist: "estimator",
  };

  return map[r] || "receptionist";
}

// -------------------- BASE URL --------------------
function getBaseUrl(req) {
  const envBase =
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    "";

  if (envBase) {
    return String(envBase).replace(/\/+$/, "");
  }

  const proto =
    req.headers["x-forwarded-proto"] || "https";

  const host =
    req.headers["x-forwarded-host"] ||
    req.headers.host;

  return `${proto}://${host}`;
}

// -------------------- VOICE --------------------
function resolveVoice(body) {
  const tone = String(
    pick(body, ["voice_tone", "tone"], "")
  )
    .toLowerCase()
    .trim();

  const gender = String(
    pick(
      body,
      ["agent_gender", "voice_gender", "gender"],
      ""
    )
  )
    .toLowerCase()
    .trim();

  if (!tone || !gender) {
    throw new Error(
      `Missing voice configuration. agent="${pick(
        body,
        ["agent_name", "a_name", "voice_name"],
        ""
      )}" gender="${gender}" tone="${tone}".`
    );
  }

  const VOICE_MAP = {
    female_warm:
      process.env.VOICE_FEMALE_WARM,
    female_calm:
      process.env.VOICE_FEMALE_CALM,
    female_authoritative:
      process.env.VOICE_FEMALE_AUTHORITATIVE,

    male_warm:
      process.env.VOICE_MALE_WARM,
    male_calm:
      process.env.VOICE_MALE_CALM,
    male_authoritative:
      process.env.VOICE_MALE_AUTHORITATIVE,
  };

  const voiceKey = `${gender}_${tone}`;

  const voiceId = VOICE_MAP[voiceKey];

  if (!voiceId) {
    throw new Error(
      `No voice configured for "${voiceKey}".`
    );
  }

  return {
    voiceKey,
    voiceId,
    gender,
    tone,
  };
}

// -------------------- UTILS --------------------
function normalizeUrl(url) {
  if (!url) return "";

  let u = String(url).trim();

  if (!u) return "";

  if (!/^https?:\/\//i.test(u)) {
    u = `https://${u}`;
  }

  return u;
}

function cleanScrapedText(raw) {
  if (!raw) return "";

  let text = String(raw);

  text = text.replace(
    /!\[.*?\]\(.*?\)\s*/g,
    ""
  );

  text = text.replace(
    /Markdown Content:\s*/gi,
    ""
  );

  text = text.replace(/-{3,}/g, "");
  text = text.replace(/\r/g, "");
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

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

  return map[raw.toLowerCase()] || raw;
}

function normalizeServiceKeyToSlug(value) {
  return String(value || "")
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
    [
      "service_key",
      "booking_service_key",
      "default_service_key",
    ],
    calSlugRaw || ""
  );

  const timeZone = normalizeTimeZone(
    pick(
      body,
      ["timezone", "tz", "time_zone"],
      "America/New_York"
    )
  );

  return {
    cal_username: calUsername,
    cal_slug:
      normalizeServiceKeyToSlug(calSlugRaw),
    service_key: String(serviceKey || "").trim(),
    timezone: timeZone,
  };
}

function getGlobalSetupBlock(body) {
  return pick(
    body,
    [
      "universal_info",
      "universal_setup",
      "universal_business_info",
      "global_setup",
      "business_setup",
      "company_setup",
      "global_info",
    ],
    ""
  );
}
function buildGlobalSetupFromFields(body) {
  const bizName = pick(
    body,
    [
      "business_name",
      "biz_name",
      "company",
      "company_name",
    ],
    ""
  );

  const website = pick(
    body,
    [
      "website",
      "web",
      "website_url",
      "site",
      "url",
    ],
    ""
  );

  const tz = pick(
    body,
    ["timezone", "tz", "time_zone"],
    ""
  );

  const hours = pick(
    body,
    ["business_hours", "hours"],
    ""
  );

  const area = pick(
    body,
    [
      "service_area",
      "service_area_cities",
      "cities",
      "towns",
    ],
    ""
  );

  const industry = pick(
    body,
    [
      "industry",
      "primary_business_type",
      "business_type",
    ],
    ""
  );

  const phone = pick(
    body,
    ["business_phone", "phone"],
    ""
  );

  const email = pick(
    body,
    [
      "email",
      "client_email",
      "summary_email",
      "alert_email",
    ],
    ""
  );

  const facts = [];

  if (bizName) {
    facts.push(`Business Name: ${bizName}`);
  }

  if (industry) {
    facts.push(`Industry: ${industry}`);
  }

  if (area) {
    facts.push(`Service Area: ${area}`);
  }

  if (hours) {
    facts.push(`Business Hours: ${hours}`);
  }

  if (tz) {
    facts.push(`Time Zone: ${tz}`);
  }

  if (phone) {
    facts.push(`Primary Phone: ${phone}`);
  }

  if (email) {
    facts.push(
      `Email for Summaries/Alerts: ${email}`
    );
  }

  if (website) {
    facts.push(`Website: ${website}`);
  }

  if (!facts.length) return "";

  const instructions = [
    `Receptionist Instructions:`,
    `- Be warm, calm, and professional.`,
    `- Ask one question at a time.`,
    `- Collect the caller's name, callback number, and brief service goal.`,
    `- Do not give exact pricing or guarantees; offer to have the team follow up.`,
    `- If unsure about a service detail, take a message rather than guessing.`,
  ];

  return [
    `GLOBAL BUSINESS INFO (internal reference):`,
    ...facts.map((line) => `- ${line}`),
    ``,
    ...instructions,
  ].join("\n");
}

function getRoleSetupBlock(body, roleKey) {
  return pick(
    body,
    [
      `${roleKey}_setup`,
      "role_setup",
      "setup_block",
    ],
    ""
  );
}

function buildSetupForRole(body, roleKey) {
  const receptionist = pick(
    body,
    [
      "receptionist_setup",
      "receptionist_config",
    ],
    ""
  );

  const scheduler = pick(
    body,
    [
      "scheduler_setup",
      "scheduler_config",
    ],
    ""
  );

  const intake = pick(
    body,
    [
      "intake_setup",
      "intake_config",
    ],
    ""
  );

  const emergency = pick(
    body,
    [
      "emergency_setup",
      "dispatch_setup",
      "dispatch_config",
    ],
    ""
  );

  const lead = pick(
    body,
    [
      "lead_revival_setup",
      "lead_revival_config",
    ],
    ""
  );

  const estimator = pick(
    body,
    [
      "Estimator",
      "estimator_setup",
      "estimator_config",
      "estimate_setup",
    ],
    ""
  );

  const blocks = [];

  if (receptionist) {
    blocks.push(
      `RECEPTIONIST SETUP:\n${receptionist}`
    );
  }

  if (roleKey === "operations") {
    if (scheduler) {
      blocks.push(
        `SCHEDULING SETUP:\n${scheduler}`
      );
    }

    if (intake) {
      blocks.push(
        `INTAKE SETUP:\n${intake}`
      );
    }

    if (emergency) {
      blocks.push(
        `EMERGENCY DISPATCH SETUP:\n${emergency}`
      );
    }

    if (lead) {
      blocks.push(
        `LEAD REVIVAL SETUP:\n${lead}`
      );
    }

    if (estimator) {
      blocks.push(
        `ESTIMATOR SETUP:\n${estimator}`
      );
    }
  }

  if (
    roleKey === "scheduler" &&
    scheduler
  ) {
    blocks.push(
      `SCHEDULING SETUP:\n${scheduler}`
    );
  }

  if (
    roleKey === "intake" &&
    intake
  ) {
    blocks.push(
      `INTAKE SETUP:\n${intake}`
    );
  }

  if (
    roleKey === "emergency" &&
    emergency
  ) {
    blocks.push(
      `EMERGENCY DISPATCH SETUP:\n${emergency}`
    );
  }

  if (
    roleKey === "lead_revival" &&
    lead
  ) {
    blocks.push(
      `LEAD REVIVAL SETUP:\n${lead}`
    );
  }

  if (
    roleKey === "estimator" &&
    estimator
  ) {
    blocks.push(
      `ESTIMATOR SETUP:\n${estimator}`
    );
  }

  return blocks.join("\n\n");
}

function formatSetupBlock(setupText) {
  if (!setupText) return "";

  return [
    `BUSINESS SETUP (owner answers from onboarding form — internal rules):`,
    setupText,
    ``,
    `IMPORTANT:`,
    `- Do not ask the caller these onboarding questions.`,
    `- Use these answers as your operating instructions.`,
  ].join("\n");
}

function buildUrgencyFallbackBlock(roleKey) {
  const common = [
    `URGENCY & EMERGENCY CLASSIFICATION (ALWAYS ON — even without Emergency Dispatch):`,
    `- "Urgent" means the caller asks for an immediate or time-sensitive callback, or describes safety or property risk.`,
    `- "Emergency" means immediate danger to life, severe injury, active fire, gas leak, ongoing crime, or anything requiring 911.`,
    ``,
    `URGENCY TRIGGERS:`,
    `- The caller says urgent, emergency, ASAP, right away, immediately, call me back now, or I need someone today.`,
    `- Safety or property risk such as flooding, sparking, smoke, a leak, no heat, no water, a break-in, or an unsafe condition.`,
    `- Deadline language such as today, before close, inspection, insurance, or court.`,
    ``,
    `WHEN URGENCY IS DETECTED:`,
    `1. Stay calm and acknowledge that the issue is urgent.`,
    `2. Collect one item at a time:`,
    `    - Caller name`,
    `    - Best callback number`,
    `    - A short issue summary`,
    `    - Address or location when relevant`,
    `3. Ask: "Is anyone in immediate danger right now? Yes or no."`,
    `4. If yes, advise the caller to call 911 immediately.`,
    `5. Say that the issue will be flagged as urgent, but do not guarantee a response time.`,
    ``,
    `LOGGING REQUIREMENTS:`,
    `- urgency_level: urgent or emergency`,
    `- callback_needed: yes`,
    `- urgent_reason: a short explanation`,
  ];

  const dispatchOnly = [
    ``,
    `EMERGENCY DISPATCH UPGRADE BEHAVIOR:`,
    `- If dispatch contacts or rules exist in BUSINESS SETUP, follow them exactly.`,
    `- If no dispatch contact exists, collect the details and flag the message as urgent.`,
  ];

  if (
    roleKey === "emergency" ||
    roleKey === "operations"
  ) {
    return common
      .concat(dispatchOnly)
      .join("\n");
  }

  return common.join("\n");
}

function buildPromptBase({
  agentName,
  bizName,
  roleKey,
}) {
  const stabilityLogic = [
    `# ANTI-REPEAT / BARGE-IN RULES`,
    `- Do not restart or repeat the greeting because of background noise, phone-line sounds, or early talk-over.`,
    `- If noise occurs while speaking the opener, continue the sentence naturally.`,
    `- If the caller interrupts during the first few seconds, finish the current sentence before pausing.`,
    `- Speak the opener only once.`,
    `- If the line is unclear at the start, pause briefly before speaking.`,
  ].join("\n");

  const stagingLogic = [
    `# CONVERSATION FLOW CONTROL`,
    `Stage 1: DISCOVERY — Identify what the person needs and answer basic questions.`,
    `Stage 2: INTEREST — If the person wants to move forward, explain the next step.`,
    `Stage 3: ACTION — Only schedule, dispatch, estimate, or complete intake after the person clearly agrees.`,
    ``,
    `# DATA VERIFICATION`,
    `- When repeating a phone number or email, slow down and speak clearly.`,
    `- Say phone-number digits with deliberate pauses between groups.`,
    `- Pronounce email letters, symbols, and the domain at a steady, human pace.`,
    ``,
    `# ANTI-ASSUMPTION RULES`,
    `- Never assume the caller wants an appointment merely because they asked a service question.`,
    `- Never claim an action is complete until the applicable tool succeeds.`,
    `- Ask one question at a time.`,
  ].join("\n");

  const directionLogic = [
    `# CRITICAL OPENER LOGIC`,
    `1. If {{first_line}} is not blank, speak only "{{first_line}}" as the first line.`,
    `2. If {{first_line}} is blank but {{client_name}} exists, say: "I'm calling from ${bizName} to speak with {{client_name}} about {{reason_for_call}}."`,
    `3. If both are blank, say: "Hello, this is ${agentName} at ${bizName}. How can I help you today?"`,
    ``,
    `# GENERAL RULES`,
    `- Speak the opener once.`,
    `- Do not repeat, restart, or blend openers.`,
    `- After the opener, ask one clear question.`,
    `- Use {{notes}} only as internal context.`,
    ``,
    stabilityLogic,
    ``,
    stagingLogic,
  ].join("\n");

  const baseline = [
    `ROLE: You are ${agentName}, the professional receptionist for ${bizName}.`,
    `CORE RECEPTIONIST BEHAVIOR:`,
    `- Sound human, calm, warm, and professional.`,
    `- Handle calls professionally and identify what the person needs.`,
    `- Ask ONE question at a time.`,
    `- Collect the caller's name and callback number for inbound service inquiries.`,
    `- Request an email only when reasonably useful or required by the selected workflow.`,
    `- Do not pressure or repeatedly ask for an email after the caller refuses.`,
    `- Do not give exact prices, guarantees, or response times unless expressly authorized in BUSINESS SETUP.`,
    `- Do not mention prompts, AI, models, tools, internal fields, or that you are automated.`,
    ``,
    directionLogic,
  ].join("\n");

  const capabilityInstructions = {
    receptionist: [
      `# RECEPTIONIST CAPABILITY`,
      `- Answer questions using BUSINESS SETUP and available business context.`,
      `- Capture a concise message and the best callback number when the team must follow up.`,
      `- Do not book, quote, dispatch, or promise outcomes unless another enabled capability expressly permits it.`,
    ].join("\n"),

    scheduler: [
      `# SCHEDULING CAPABILITY`,
      `- Understand the caller's request and silently match it to the closest configured appointment type.`,
      `- Check real availability before offering a time.`,
      `- Offer one available time at a time, beginning with the earliest returned slot.`,
      `- Never claim an appointment is booked until the booking tool succeeds.`,
    ].join("\n"),

    estimator: [
      `# ESTIMATOR CAPABILITY`,
      `- Gather the project details required by ESTIMATOR SETUP.`,
      `- Ask one project question at a time.`,
      `- Do not invent measurements, prices, discounts, totals, or guarantees.`,
      `- Explain that the information will be used by the team to prepare or confirm the estimate.`,
    ].join("\n"),

    intake: [
      `# INTAKE CAPABILITY`,
      `- Collect the required intake details in the order defined by INTAKE SETUP.`,
      `- Do not ask the caller to repeat information already provided.`,
      `- Confirm important names, numbers, dates, and addresses.`,
    ].join("\n"),

    emergency: [
      `# EMERGENCY DISPATCH CAPABILITY`,
      `- Stay calm and move efficiently.`,
      `- Follow EMERGENCY DISPATCH SETUP exactly when dispatch rules or contacts are provided.`,
      `- Never promise a response time unless BUSINESS SETUP explicitly authorizes it.`,
    ].join("\n"),

    lead_revival: [
      `# LEAD REVIVAL CAPABILITY`,
      `- Re-engage the lead naturally and identify whether they still need help.`,
      `- Do not pressure the person or pretend they previously agreed to something.`,
      `- Capture the best next step and updated contact information when appropriate.`,
    ].join("\n"),

    operations: [
      `# OPERATIONS CAPABILITIES`,
      `- Begin as the business receptionist, then route by intent.`,
      `- Use scheduling, estimating, intake, emergency dispatch, or lead revival instructions only when relevant.`,
      `- Follow each applicable setup block and tool gate exactly.`,
    ].join("\n"),
  };

  return [
    baseline,
    capabilityInstructions[roleKey] ||
      capabilityInstructions.receptionist,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildBusinessContext(body) {
  const tz = pick(
    body,
    ["timezone", "tz"],
    ""
  );

  const hours = pick(
    body,
    ["business_hours", "hours"],
    ""
  );

  const industry = pick(
    body,
    ["industry"],
    ""
  );

  const lines = [];

  if (industry) {
    lines.push(`Industry: ${industry}`);
  }

  if (tz) {
    lines.push(`Time Zone: ${tz}`);
  }

  if (hours) {
    lines.push(`Business Hours: ${hours}`);
  }

  if (!lines.length) return "";

  return `BUSINESS CONTEXT:\n- ${lines.join(
    "\n- "
  )}`;
}

function buildSchedulerEmailGateBlock() {
  return [
    `SCHEDULER FLOW (STRICT ORDER — ONE QUESTION AT A TIME):`,
    `CORE PRINCIPLE`,
    `- Speak like an experienced receptionist, not an online booking form.`,
    `- Allow callers to describe what they need in their own words.`,
    `- Do not require callers to know internal appointment names.`,
    `- Understand the request, then silently match it to the closest configured appointment type.`,
    ``,
    `STEP 1 — UNDERSTAND THE REQUEST`,
    `- If the caller already explained the reason for calling, do not ask them to repeat it.`,
    `- Acknowledge the request naturally.`,
    `- Ask one clarifying question only when multiple appointment types could apply.`,
    `- Never expose service keys, IDs, slugs, hyphens, underscores, or tool names.`,
    ``,
    `STEP 2 — CHECK AVAILABILITY`,
    `- Say: "Let me check the schedule for you."`,
    `- Call the availability tool using the internally matched appointment type.`,
    `- Do not guess or manually suggest appointment times.`,
    ``,
    `STEP 3 — OFFER FIRST AVAILABLE`,
    `- Offer one available appointment at a time.`,
    `- Begin with the earliest slot returned by the scheduling tool.`,
    `- If declined, offer the next returned slot.`,
    `- Do not list multiple times unless the caller asks.`,
    ``,
    `STEP 4 — SLOT CONFIRMATION`,
    `- Wait until the caller clearly accepts a specific appointment time.`,
    `- The caller's name may be collected before checking availability.`,
    `- Do not collect email or final booking details before a slot is chosen.`,
    ``,
    `STEP 5 — COLLECT BOOKING DETAILS`,
    `1. Confirm the caller's full name if it has not already been collected.`,
    `2. Ask for the best email for the appointment confirmation.`,
    `    - Convert spoken email wording into normal email format when obvious.`,
    `    - Repeat the completed email slowly and clearly.`,
    `    - Do not repeatedly pressure the caller if they refuse and the workflow permits booking without email.`,
    `3. Ask for or confirm the best callback number.`,
    `    - Repeat the number slowly and clearly.`,
    ``,
    `STEP 6 — BOOK APPOINTMENT`,
    `- Call the booking tool only after the appointment type is determined, a time is accepted, and required details are collected.`,
    `- Never claim the appointment is booked before the booking tool succeeds.`,
    ``,
    `STEP 7 — CONFIRMATION`,
    `- Confirm the exact date and time returned by the booking tool.`,
    `- Tell the caller the confirmation email contains appointment details and the meeting link.`,
    `- Do not read a meeting URL aloud unless the caller specifically requests it or cannot access email.`,
    `- If booking fails, apologize briefly and explain the next appropriate step.`,
    ``,
    `CRITICAL RULES`,
    `- Availability must come from the scheduling tool.`,
    `- Always offer the earliest returned slot first.`,
    `- Never collect email or final booking details before a slot is accepted.`,
    `- Never confirm a booking without tool success.`,
    `- Ask one question at a time.`,
  ].join("\n");
}

function buildReceptionistNoBookingBlock() {
  return [
    `SCHEDULER LIMIT (PLAN-BASED):`,
    `- You do not book appointments.`,
    `- You do not reschedule or cancel appointments.`,
    `- If a caller wants to book, reschedule, or cancel:`,
    `  1. Collect the caller's name.`,
    `  2. Collect the callback number.`,
    `  3. Ask for an email only when reasonably useful.`,
    `  4. Ask what service they need.`,
    `  5. Ask for their preferred day and time window.`,
    `  6. Say: "I'll pass this to the scheduling team and they'll confirm shortly."`,
    `- Do not promise a reserved time.`,
    `- Do not call booking tools.`,
  ].join("\n");
}

// -------------------- IDEMPOTENCY HELPERS --------------------
const PROVISION_TTL_SECONDS =
  60 * 60 * 24 * 30;

const PROVISION_LOCK_TTL_SECONDS = 180;

async function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

function getSubmissionId(body) {
  return String(
    pick(
      body,
      [
        "jotform_submission_id",
        "submission_id",
        "idempotency_key",
        "job_id",
      ],
      ""
    )
  ).trim();
}

async function getProvisionRecord(idemKey) {
  const record = await kv.get(idemKey);

  return record &&
    typeof record === "object"
    ? record
    : null;
}

async function saveProvisionRecord(
  idemKey,
  record
) {
  const now = new Date().toISOString();

  const next = {
    ...record,
    updated_at: now,
    created_at:
      record?.created_at || now,
  };

  await kv.set(idemKey, next, {
    ex: PROVISION_TTL_SECONDS,
  });

  return next;
}

async function acquireLock(
  lockKey,
  ttlSeconds = PROVISION_LOCK_TTL_SECONDS
) {
  return kv.set(lockKey, "1", {
    nx: true,
    ex: ttlSeconds,
  });
}

async function releaseLock(lockKey) {
  try {
    await kv.del(lockKey);
  } catch {}
}

function publicProvisionResult(
  record,
  extra = {}
) {
  return {
    ok: true,
    status: record?.status || null,
    mode: record?.mode || null,
    llm_id: record?.llm_id || null,
    agent_id: record?.agent_id || null,

    phone_number:
      record?.phone_number ||
      "(not purchased)",

    phone_number_id:
      record?.phone_number_id || null,

    number_tier:
      record?.number_tier || null,

    voice_key:
      record?.voice_key || null,

    agent_name:
      record?.agent_name || null,

    agent_gender:
      record?.agent_gender || null,

    voice_tone:
      record?.voice_tone || null,

    role:
      record?.role || null,

    prompt_source:
      record?.prompt_source || null,

    ...extra,
  };
}

// -------------------- HANDLER --------------------
module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  let lockKey = "";
  let lockAcquired = false;
  let idemKey = "";
  let submissionId = "";

  try {
    const body = await readJsonBody(req);

    const debug =
      String(
        pick(body, ["debug"], "false")
      ).toLowerCase() === "true";

    if (debug) {
      return res.status(200).json({
        ok: true,
        debug: true,
        received: body,
      });
    }

    submissionId = getSubmissionId(body);

    if (!submissionId) {
      return res.status(400).json({
        ok: false,
        error: "Missing submission ID.",
      });
    }

    idemKey = `prov:${submissionId}`;
    lockKey = `provlock:${submissionId}`;

    let record =
      await getProvisionRecord(idemKey);

    if (record?.status === "completed") {
      return res.status(200).json(
        publicProvisionResult(record, {
          idempotent: true,
          resumed: false,
        })
      );
    }

    const locked =
      await acquireLock(lockKey);

    lockAcquired = Boolean(locked);

    if (!lockAcquired) {
      for (
        let i = 0;
        i < 10;
        i += 1
      ) {
        await sleep(600);

        const after =
          await getProvisionRecord(idemKey);

        if (
          after?.status === "completed"
        ) {
          return res.status(200).json(
            publicProvisionResult(after, {
              idempotent: true,
              resumed: false,
            })
          );
        }
      }

      const inProgress =
        await getProvisionRecord(idemKey);

      return res.status(202).json({
        ok: true,
        completed: false,
        provisioning_status:
          inProgress?.status ||
          "provisioning_in_progress",
        agent_id:
          inProgress?.agent_id || null,
        idempotency_key: submissionId,
      });
    }

    record =
      await getProvisionRecord(idemKey);

    if (record?.status === "completed") {
      return res.status(200).json(
        publicProvisionResult(record, {
          idempotent: true,
          resumed: false,
        })
      );
    }

    const purchaseNumber =
      String(
        pick(
          body,
          [
            "purchase_number",
            "buy_number",
          ],
          "false"
        )
      ).toLowerCase() === "true";

    const requestedMode = String(
      pick(
        body,
        ["mode"],
        purchaseNumber
          ? "agent_and_number"
          : "agent_only"
      )
    )
      .toLowerCase()
      .trim();

    const mode =
      record?.mode ||
      (requestedMode ===
      "agent_and_number"
        ? "agent_and_number"
        : "agent_only");

    const rawSubscription = pick(
      body,
      [
        "my_subscriptions_text",
        "my_subscriptions",
        "subscription",
        "product_name",
        "purchased_package",
      ],
      ""
    );

    const subscription =
      String(rawSubscription)
        .split(/\r?\n/)[0]
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");

    const MASTER_TEMPLATE_LLM_ID =
      "llm_18a432fcc18b235399fc298809ef";

    const AI_EMPLOYEES = {
      "peter — estimator": {
        agent_name: "Peter",
        gender: "male",
        tone: "calm",
        role: "estimator",
        template_llm_id:
          MASTER_TEMPLATE_LLM_ID,
        number_tier: "standard",
      },

      "marcus — front desk receptionist": {
        agent_name: "Marcus",
        gender: "male",
        tone: "calm",
        role: "receptionist",
        template_llm_id:
          MASTER_TEMPLATE_LLM_ID,
        number_tier: "standard",
      },

      "ava — ai scheduler": {
        agent_name: "Ava",
        gender: "female",
        tone: "warm",
        role: "scheduler",
        template_llm_id:
          MASTER_TEMPLATE_LLM_ID,
        number_tier: "premium",
      },
    };

    const requestedAgentName = String(
      pick(
        body,
        [
          "agent_name",
          "a_name",
          "voice_name",
        ],
        ""
      )
    )
      .trim()
      .toLowerCase();

    const AI_EMPLOYEES_BY_NAME = {
      peter:
        AI_EMPLOYEES[
          "peter — estimator"
        ],

      marcus:
        AI_EMPLOYEES[
          "marcus — front desk receptionist"
        ],

      ava:
        AI_EMPLOYEES[
          "ava — ai scheduler"
        ],
    };

    const config =
      AI_EMPLOYEES_BY_NAME[
        requestedAgentName
      ] ||
      AI_EMPLOYEES[subscription] ||
      null;

    if (!config) {
      throw new Error(
        `Unknown agent selection. Received agent_name "${requestedAgentName}" and subscription "${rawSubscription}".`
      );
    }

    body.agent_name =
      config.agent_name;

    body.agent_gender =
      config.gender;

    body.voice_tone =
      config.tone;

    body.agent_role =
      config.role;

    body.template_llm_id =
      pick(
        body,
        [
          "template_llm_id",
          "retell_template_llm_id",
        ],
        config.template_llm_id
      );

    body.number_tier =
      pick(
        body,
        ["number_tier"],
        config.number_tier
      );
    const agentName = pick(
      body,
      [
        "agent_name",
        "a_name",
        "voice_name",
      ],
      config?.agent_name || ""
    );

    const roleRaw = pick(
      body,
      [
        "agent_role",
        "role",
        "a_role",
      ],
      config?.role || ""
    );

    if (!agentName || !roleRaw) {
      throw new Error(
        `Missing agent configuration. Received subscription "${rawSubscription}" with agent_name "${agentName}" and agent_role "${roleRaw}".`
      );
    }

    const bizName = pick(
      body,
      [
        "business_name",
        "biz_name",
        "company",
        "company_name",
      ],
      "Your Business"
    );

    const roleKey =
      normalizeRole(roleRaw);

    const {
      voiceKey,
      voiceId,
    } = resolveVoice(body);

    const explicitPrompt = pick(
      body,
      [
        "final_prompt",
        "general_prompt",
        "prompt",
      ],
      ""
    );

    const universalLeadCapturePolicy =
      pick(
        body,
        [
          "universal_lead_capture_policy",
        ],
        ""
      );

    const globalSetup =
      getGlobalSetupBlock(body) ||
      buildGlobalSetupFromFields(body);

    const roleSetup =
      getRoleSetupBlock(
        body,
        roleKey
      ) ||
      buildSetupForRole(
        body,
        roleKey
      );

    const setupSection =
      formatSetupBlock(
        [
          globalSetup,
          roleSetup,
        ]
          .filter(Boolean)
          .join("\n\n")
      );

    const website = pick(
      body,
      [
        "website",
        "web",
        "website_url",
        "site",
        "url",
      ],
      ""
    );

    const scrape = {
      ok: false,
      text: "",
      reason: website
        ? "scraper_not_configured"
        : "no_url",
    };

    let promptToUse = "";
    let promptSource = "";

    if (explicitPrompt) {
      promptToUse = [
        explicitPrompt,
        universalLeadCapturePolicy
          ? `# UNIVERSAL LEAD CAPTURE POLICY\n${universalLeadCapturePolicy}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      promptSource =
        "explicit_prompt";
    } else {
      let base = buildPromptBase({
        agentName,
        bizName,
        roleKey,
      });

      const outboundRules = [
        `OUTBOUND BEHAVIOR RULES (apply only when {{first_line}} is not blank):`,
        `- You initiated the call.`,
        `- Use {{first_line}} precisely as the opener.`,
        `- State that you are calling from ${bizName}.`,
        `- Do not ask "How can I help you?" as the first outbound line.`,
      ].join("\n");

      const outboundRoles = new Set([
        "receptionist",
        "lead_revival",
        "operations",
      ]);

      if (
        outboundRoles.has(roleKey)
      ) {
        base = [
          base,
          outboundRules,
        ].join("\n\n");
      }

      const urgencyFallback =
        buildUrgencyFallbackBlock(
          roleKey
        );

      const tierProtection =
        roleKey === "receptionist"
          ? buildReceptionistNoBookingBlock()
          : roleKey === "scheduler" ||
              roleKey === "operations"
            ? buildSchedulerEmailGateBlock()
            : "";

      const context =
        buildBusinessContext(body);

      const websiteSection =
        scrape.ok
          ? `WEBSITE KNOWLEDGE:\n${scrape.text}`
          : `WEBSITE KNOWLEDGE: (Not available: ${scrape.reason})`;

      promptToUse = [
        base,

        universalLeadCapturePolicy
          ? `# UNIVERSAL LEAD CAPTURE POLICY\n${universalLeadCapturePolicy}`
          : "",

        urgencyFallback,
        tierProtection,
        context,
        setupSection,
        websiteSection,
      ]
        .filter(Boolean)
        .join("\n\n");

      promptSource =
        "built_prompt";
    }

    const baseUrl =
      getBaseUrl(req);

    const schedulingCapable =
      roleKey === "scheduler" ||
      roleKey === "operations";

    const templateLlmId = pick(
      body,
      [
        "template_llm_id",
        "retell_template_llm_id",
      ],
      config?.template_llm_id || ""
    );

    const numberTierFinal =
      pick(
        body,
        ["number_tier"],
        config?.number_tier ||
          "standard"
      ) || "standard";

    let llmId =
      record?.llm_id || null;

    let agentId =
      record?.agent_id || null;

    let phoneNumber =
      record?.phone_number &&
      record.phone_number !==
        "(not purchased)"
        ? record.phone_number
        : null;

    let phoneNumberId =
      record?.phone_number_id ||
      null;

    let templateTools = null;

    let calendarConfig =
      extractCalendarConfig(body);

    let resumed =
      Boolean(agentId);

    // -------------------- STATE 1: CREATE AGENT --------------------
    if (!agentId) {
      record =
        await saveProvisionRecord(
          idemKey,
          {
            ...(record || {}),
            status:
              "creating_agent",
            mode,
            submission_id:
              submissionId,
            business_name:
              bizName,
            agent_name:
              agentName,
            agent_gender:
              body.agent_gender,
            voice_tone:
              body.voice_tone,
            role:
              roleKey,
            voice_key:
              voiceKey,
            number_tier:
              numberTierFinal,
            prompt_source:
              promptSource,
            last_error: null,
          }
        );

      templateTools =
        await getTemplateLlmTools(
          templateLlmId
        );

      const llmPayload = {
        general_prompt:
          promptToUse,

        model: pick(
          body,
          ["llm_model"],
          "gpt-4o-mini"
        ),

        ...(templateTools
          ? {
              general_tools:
                templateTools,
            }
          : {}),
      };

      const llmResp =
        await axios.post(
          `${RETELL_BASE}/create-retell-llm`,
          llmPayload,
          {
            headers:
              retellHeaders(),
            timeout: 20000,
          }
        );

      llmId =
        llmResp.data?.llm_id ||
        llmResp.data?.id;

      if (!llmId) {
        throw new Error(
          "Retell created no LLM ID."
        );
      }

      const agentResp =
        await axios.post(
          `${RETELL_BASE}/create-agent`,
          {
            agent_name:
              `${bizName} - ${agentName} (${roleKey})`,

            voice_id:
              voiceId,

            response_engine: {
              type:
                "retell-llm",
              llm_id: llmId,
            },

            metadata: {
              business_name:
                bizName,

              agent_role:
                roleKey,

              submission_id:
                submissionId,
            },
          },
          {
            headers:
              retellHeaders(),
            timeout: 20000,
          }
        );

      agentId =
        agentResp.data?.agent_id ||
        agentResp.data?.id;

      if (!agentId) {
        throw new Error(
          "Retell created no agent ID."
        );
      }

      await axios.patch(
        `${RETELL_BASE}/update-agent/${encodeURIComponent(
          agentId
        )}`,
        {
          interruption_sensitivity: 0,
          responsiveness: 1,
        },
        {
          headers:
            retellHeaders(),
          timeout: 20000,
        }
      );

      if (
        templateTools?.length
      ) {
        const toolsWithNewAgentId =
          replaceAgentIdInTools(
            templateTools,
            agentId
          );

        await updateRetellLlmTools(
          llmId,
          toolsWithNewAgentId
        );
      }

      calendarConfig =
        extractCalendarConfig(body);

      if (
        calendarConfig.cal_username &&
        calendarConfig.cal_slug
      ) {
        await kv.set(
          `agentcfg:${agentId}`,
          {
            agent_id:
              agentId,

            submission_id:
              submissionId,

            business_name:
              bizName,

            role: roleKey,

            cal_username:
              calendarConfig
                .cal_username,

            cal_slug:
              calendarConfig
                .cal_slug,

            service_key:
              calendarConfig
                .service_key ||
              calendarConfig
                .cal_slug,

            timezone:
              calendarConfig
                .timezone ||
              "America/New_York",

            created_at:
              new Date()
                .toISOString(),
          },
          {
            ex:
              PROVISION_TTL_SECONDS,
          }
        );
      }

      record =
        await saveProvisionRecord(
          idemKey,
          {
            ...record,

            status:
              "agent_created",

            mode,

            submission_id:
              submissionId,

            business_name:
              bizName,

            agent_name:
              agentName,

            agent_gender:
              body.agent_gender,

            voice_tone:
              body.voice_tone,

            llm_id: llmId,

            agent_id:
              agentId,

            phone_number:
              null,

            phone_number_id:
              null,

            number_tier:
              numberTierFinal,

            voice_key:
              voiceKey,

            role: roleKey,

            prompt_source:
              promptSource,

            template_llm_id:
              templateLlmId ||
              null,

            calendar_config_saved:
              Boolean(
                calendarConfig
                  .cal_username &&
                  calendarConfig
                    .cal_slug
              ),

            cal_username:
              calendarConfig
                .cal_username ||
              "",

            cal_slug:
              calendarConfig
                .cal_slug ||
              "",

            timezone:
              calendarConfig
                .timezone ||
              "America/New_York",

            last_error: null,
          }
        );
    } else {
      llmId =
        record.llm_id ||
        llmId;

      promptSource =
        record.prompt_source ||
        promptSource;

      resumed = true;
    }

    // -------------------- STATE 2: BUY/BIND NUMBER --------------------
    if (
      mode ===
      "agent_and_number"
    ) {
      if (
        !phoneNumberId &&
        !phoneNumber
      ) {
        record =
          await saveProvisionRecord(
            idemKey,
            {
              ...record,

              status:
                "purchasing_number",

              mode,

              llm_id:
                llmId,

              agent_id:
                agentId,

              last_error:
                null,
            }
          );

        const buyResp =
          await axios.post(
            `${baseUrl}/api/buy-number`,
            {
              agent_id:
                agentId,

              business_name:
                bizName,

              idempotency_key:
                submissionId,

              number_tier:
                numberTierFinal,
            },
            {
              timeout: 30000,

              headers: {
                "Content-Type":
                  "application/json",
              },
            }
          );

        if (
          !buyResp?.data?.ok
        ) {
          throw new Error(
            `Phone purchase failed: ${JSON.stringify(
              buyResp?.data || {}
            )}`
          );
        }

        phoneNumber =
          buyResp.data
            .phone_number ||
          null;

        phoneNumberId =
          buyResp.data
            .phone_number_id ||
          null;

        if (
          !phoneNumber &&
          !phoneNumberId
        ) {
          throw new Error(
            "Phone purchase returned no phone number or phone number ID."
          );
        }
      }

      record =
        await saveProvisionRecord(
          idemKey,
          {
            ...record,

            status:
              "completed",

            mode,

            llm_id:
              llmId,

            agent_id:
              agentId,

            agent_name:
              agentName,

            agent_gender:
              body.agent_gender,

            voice_tone:
              body.voice_tone,

            phone_number:
              phoneNumber,

            phone_number_id:
              phoneNumberId,

            number_tier:
              numberTierFinal,

            voice_key:
              voiceKey,

            role: roleKey,

            prompt_source:
              promptSource,

            completed_at:
              new Date()
                .toISOString(),

            last_error:
              null,
          }
        );
    } else {
      record =
        await saveProvisionRecord(
          idemKey,
          {
            ...record,

            status:
              "completed",

            mode,

            llm_id:
              llmId,

            agent_id:
              agentId,

            agent_name:
              agentName,

            agent_gender:
              body.agent_gender,

            voice_tone:
              body.voice_tone,

            phone_number:
              null,

            phone_number_id:
              null,

            number_tier:
              numberTierFinal,

            voice_key:
              voiceKey,

            role: roleKey,

            prompt_source:
              promptSource,

            completed_at:
              new Date()
                .toISOString(),

            last_error:
              null,
          }
        );
    }

    return res.status(200).json(
      publicProvisionResult(
        record,
        {
          completed: true,

          idempotent:
            resumed,

          resumed,

          idempotency_key:
            submissionId,

          website_used:
            website
              ? normalizeUrl(
                  website
                )
              : "",

          website_scrape_reason:
            scrape.reason,

          calendar_config_saved:
            Boolean(
              record
                .calendar_config_saved
            ),

          cal_username:
            record
              .cal_username ||
            "",

          cal_slug:
            record
              .cal_slug ||
            "",

          timezone:
            record.timezone ||
            "America/New_York",

          scheduling_capable:
            schedulingCapable,

          tools_cloned_from_template:
            Boolean(
              templateTools?.length
            ),

          template_llm_id_used:
            templateLlmId ||
            "",
        }
      )
    );
  } catch (err) {
    const details =
      err?.response?.data ||
      err?.message ||
      String(err);

    if (idemKey) {
      try {
        const current =
          (await getProvisionRecord(
            idemKey
          )) || {};

        const failureStatus =
          current.agent_id
            ? "agent_created"
            : "failed";

        await saveProvisionRecord(
          idemKey,
          {
            ...current,

            status:
              failureStatus,

            submission_id:
              current
                .submission_id ||
              submissionId,

            last_error:
              typeof details ===
              "string"
                ? details
                : JSON.stringify(
                    details
                  ),

            failed_at:
              new Date()
                .toISOString(),
          }
        );
      } catch {
        // Keep the original provisioning error.
      }
    }

    return res.status(500).json({
      ok: false,

      completed: false,

      error:
        "Provisioning failed",

      idempotency_key:
        submissionId || "",

      details,
    });
  } finally {
    if (
      lockAcquired &&
      lockKey
    ) {
      await releaseLock(
        lockKey
      );
    }
  }
};
