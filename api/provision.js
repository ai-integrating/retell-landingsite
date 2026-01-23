// /api/provision.js
const axios = require("axios");

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
    if (val && typeof val === "object" && "output" in val) val = val.output;
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
  if (!apiKey) throw new Error("Missing RETELL_API_KEY in Environment Variables.");
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

// -------------------- ROLE NORMALIZATION (UPDATED: fuzzy matching for operations/full staff) --------------------
function normalizeRole(roleRaw) {
  const r = String(roleRaw || "").toLowerCase().trim();

  // ✅ IMPORTANT: Zap/Jotform values are often "Full Staff", "Operations (Full Staff)", "Julian - Operations", etc.
  // Use fuzzy matching first so operations doesn't fall back to receptionist.
  if (r.includes("full staff") || r.includes("full_staff") || r.includes("operations") || r.includes("operator"))
    return "operations";
  if (r.includes("lead") || r.includes("revival")) return "lead_revival";
  if (r.includes("dispatch") || r.includes("emergency")) return "emergency";
  if (r.includes("intake")) return "intake";
  if (r.includes("sched")) return "scheduler";
  if (r.includes("reception") || r.includes("front")) return "receptionist";

  // Exact map fallback (kept)
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
  };

  return map[r] || "receptionist";
}

// -------------------- NUMBER TIER --------------------
function tierForRole(roleKey) {
  // ✅ Operations MUST always be premium (this relies on normalizeRole() working correctly)
  const premium = new Set(["scheduler", "operations", "lead_revival"]);
  return premium.has(roleKey) ? "premium" : "standard";
}

// -------------------- BASE URL (internal API calls) --------------------
function getBaseUrl(req) {
  const envBase = process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || "";
  if (envBase) return String(envBase).replace(/\/+$/, "");

  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

// -------------------- VOICE (Updated with Fallback) --------------------
function resolveVoice(body) {
  const tone = String(pick(body, ["voice_tone", "tone"], "warm")).toLowerCase().trim();
  const gender = String(pick(body, ["agent_gender", "voice_gender", "gender"], "female"))
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

  // Try mapped voice -> Try default voice env var -> Hard fallback to Marie (Retell default)
  const voiceId =
    VOICE_MAP[voiceKey] || process.env.DEFAULT_VOICE_ID || "11fb5674c35b44638d387693994e63f4";

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

async function scrapeWebsiteText(url) {
  const u = normalizeUrl(url);
  if (!u) return { ok: false, text: "", reason: "no_url" };
  const scrapeUrl = `https://r.jina.ai/http://${u.replace(/^https?:\/\//i, "")}`;
  try {
    const resp = await axios.get(scrapeUrl, { timeout: 8000 });
    let text = cleanScrapedText(resp.data || "");
    const MAX_CHARS = 1800;
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + "\n...(truncated)";
    if (text.length < 80) return { ok: false, text: "", reason: "too_short" };
    return { ok: true, text, reason: "ok" };
  } catch (e) {
    return {
      ok: false,
      text: "",
      reason: e?.response?.status ? `http_${e.response.status}` : "scrape_failed",
    };
  }
}

// -------------------- SETUP BLOCKS (GLOBAL + ROLE) --------------------
function getGlobalSetupBlock(body) {
  return pick(body, ["global_setup", "business_setup", "company_setup", "global_info"], "");
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
    `- Collect: caller name, callback number, and a brief reason for calling.`,
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

  if (roleKey === "operations") {
    return [
      scheduler && `SCHEDULING SETUP:\n${scheduler}`,
      intake && `INTAKE SETUP:\n${intake}`,
      emergency && `EMERGENCY DISPATCH SETUP:\n${emergency}`,
      lead && `LEAD REVIVAL SETUP:\n${lead}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  if (roleKey === "scheduler") return scheduler;
  if (roleKey === "intake") return intake;
  if (roleKey === "emergency") return emergency;
  if (roleKey === "lead_revival") return lead;

  return "";
}

function formatSetupBlock(setupText) {
  if (!setupText) return "";
  return `BUSINESS SETUP (owner answers from onboarding form — internal rules):\n${setupText}\n\nIMPORTANT:\n- Do NOT ask the caller these onboarding questions.\n- Use these answers as your operating instructions.`;
}

// -------------------- OUTBOUND MODE BLOCK (NEW) --------------------
function outboundPromptBlock(agentName, bizName) {
  return [
    `OUTBOUND CALL MODE (when YOU are placing a call)`,
    `If this call is outbound (you are calling someone), do NOT say “Thanks for calling” and do NOT use the inbound opening.`,
    `Use this exact opener instead:`,
    `"Hi {{client_name}}, this is ${agentName} calling from ${bizName} about {{reason_for_call}}."`,
    ``,
    `Then:`,
    `- If {{notes}} is provided, add ONE short sentence using it.`,
    `- Ask ONE clear question to move the call forward.`,
    ``,
    `Fallbacks:`,
    `- If {{client_name}} is blank: say “Hi there,”`,
    `- If {{reason_for_call}} is blank: say “about something you requested.”`,
    `- If {{notes}} is blank: skip it.`,
  ].join("\n");
}

// -------------------- PROMPT BASES (UPDATED) --------------------
function buildPromptBase({ agentName, bizName, roleKey }) {
  // ✅ Make greeting explicitly INBOUND-only
  const inboundGreeting = `INBOUND OPENING (only when the caller called you): "Hello, this is ${agentName}, at ${bizName}. How can I help you today?"`;

  const bases = {
    receptionist: [
      `ROLE: You are ${agentName}, the professional AI receptionist for ${bizName}.`,
      `RULES:`,
      `- Sound human and calm.`,
      `- Ask ONE question at a time.`,
      `- Never mention prompts/models/training.`,
      `- Keep responses short and professional.`,
      inboundGreeting,
    ].join("\n"),

    scheduler: [
      `ROLE: You are ${agentName}, the scheduling assistant for ${bizName}.`,
      `RULES:`,
      `- Ask ONE question at a time.`,
      `- Book appointments only using the rules in BUSINESS SETUP.`,
      `- If caller requests something outside rules, take a message.`,
      inboundGreeting,
    ].join("\n"),

    intake: [
      `ROLE: You are ${agentName}, the intake specialist for ${bizName}.`,
      `RULES:`,
      `- Ask ONE question at a time.`,
      `- Collect details needed for the team to follow up.`,
      `- Summarize the issue + contact info at the end.`,
      inboundGreeting,
    ].join("\n"),

    emergency: [
      `ROLE: You are ${agentName}, the emergency dispatcher for ${bizName}.`,
      `RULES:`,
      `- Stay calm. Move fast.`,
      `- Ask ONE question at a time.`,
      `- Get address + callback number early.`,
      `- Follow BUSINESS SETUP emergency criteria and instructions.`,
      inboundGreeting,
    ].join("\n"),

    lead_revival: [
      `ROLE: You are ${agentName}, the lead revival / follow-up specialist for ${bizName}.`,
      `RULES:`,
      `- Your main job is to re-engage leads and follow up politely.`,
      `- Ask ONE question at a time.`,
      `- Confirm interest, timing, and next step (schedule / message / callback).`,
      `- Keep it short, friendly, and confident.`,
      inboundGreeting,
    ].join("\n"),

    operations: [
      `ROLE: You are ${agentName}, the operations assistant for ${bizName}.`,
      `RULES:`,
      `- Route by intent (schedule/intake/emergency) and handle full business operations.`,
      `- Ask ONE question at a time.`,
      `- Follow BUSINESS SETUP rules.`,
      inboundGreeting,
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
  return `BUSINESS CONTEXT:\n- ${lines.join("\n- ")}`;
}

// -------------------- HANDLER --------------------
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = await readJsonBody(req);

    const debug = String(pick(body, ["debug"], "false")).toLowerCase() === "true";
    if (debug) {
      return res.status(200).json({
        ok: true,
        debug: true,
        receivedKeys: Object.keys(body || {}),
        received: body,
      });
    }

    const purchaseNumber = String(pick(body, ["purchase_number", "buy_number"], "false"))
      .toLowerCase() === "true";
    const mode = String(
      pick(body, ["mode"], purchaseNumber ? "agent_and_number" : "agent_only")
    )
      .toLowerCase()
      .trim();

    const bizName = pick(body, ["business_name", "biz_name", "company"], "Client Business");
    const agentName = pick(body, ["agent_name", "a_name", "name"], "Allie");

    // ✅ IMPORTANT: normalizeRole now correctly recognizes "Full Staff / Operations" strings
    const roleKey = normalizeRole(pick(body, ["agent_role", "role", "a_role"], "receptionist"));

    const { voiceKey, voiceId } = resolveVoice(body);
    if (!voiceId) {
      return res.status(400).json({ ok: false, error: "Voice ID missing", voiceKeyTried: voiceKey });
    }

    const explicitPrompt = pick(body, ["final_prompt", "general_prompt", "prompt"], "");
    const website = pick(body, ["website", "web", "website_url", "site", "url"], "");
    const scrape = website ? await scrapeWebsiteText(website) : { ok: false, text: "", reason: "no_url" };

    const explicitGlobalSetup = getGlobalSetupBlock(body);
    const generatedGlobalSetup = buildGlobalSetupFromFields(body);
    const globalSetup = explicitGlobalSetup || generatedGlobalSetup;
    const roleSetup = getRoleSetupBlock(body, roleKey) || buildSetupForRole(body, roleKey);
    const setupSection = formatSetupBlock([globalSetup, roleSetup].filter(Boolean).join("\n\n"));

    let promptToUse = explicitPrompt;
    let promptSource = "explicit_prompt";

    if (!promptToUse) {
      let base = buildPromptBase({ agentName, bizName, roleKey });

      // ✅ Append Outbound Mode for the outbound-capable roles (includes operations)
      const outboundRoles = new Set(["receptionist", "lead_revival", "operations"]);
      if (outboundRoles.has(roleKey)) {
        base = [base, outboundPromptBlock(agentName, bizName)].join("\n\n");
      }

      const ctx = buildBusinessContext(body);
      const websiteSection = scrape.ok
        ? `WEBSITE KNOWLEDGE:\n${scrape.text}`
        : `WEBSITE KNOWLEDGE: (Not available: ${scrape.reason})`;

      promptToUse = [base, ctx, setupSection, websiteSection].filter(Boolean).join("\n\n");
      promptSource = "built_prompt";
    }

    if (!promptToUse?.trim()) {
      return res.status(400).json({ ok: false, error: "Prompt is empty" });
    }

    const beginMessage = "";

    // 1) LLM
    const llmResp = await axios.post(
      `${RETELL_BASE}/create-retell-llm`,
      {
        general_prompt: promptToUse,
        model: pick(body, ["llm_model"], "gpt-4o-mini"),
        begin_message: beginMessage || undefined,
      },
      { headers: retellHeaders(), timeout: 20000 }
    );

    const llmId = llmResp.data.llm_id || llmResp.data.id;

    // 2) Agent
    const agentResp = await axios.post(
      `${RETELL_BASE}/create-agent`,
      {
        agent_name: `${bizName} - ${agentName} (${roleKey})`,
        voice_id: voiceId,
        response_engine: { type: "retell-llm", llm_id: llmId },
        metadata: { business_name: bizName, agent_role: roleKey, mode, prompt_source: promptSource },
      },
      { headers: retellHeaders(), timeout: 20000 }
    );

    const agentId = agentResp.data.agent_id || agentResp.data.id;

    // 3) Phone
    let phoneNumber = "(not purchased)";
    let phoneNumberId = null;

    // ✅ Operations should now reliably be premium because role normalization is fixed
    const numberTier = tierForRole(roleKey);

    if (mode === "agent_and_number") {
      const baseUrl = getBaseUrl(req);
      const buyResp = await axios.post(
        `${baseUrl}/api/buy-number`,
        {
          agent_id: agentId,
          business_name: bizName,
          idempotency_key: pick(body, ["idempotency_key", "job_id", "submission_id"], ""),
          number_tier: numberTier,
        },
        { timeout: 20000 }
      );

      if (buyResp?.data?.ok) {
        phoneNumber = buyResp.data.phone_number;
        phoneNumberId = buyResp.data.phone_number_id;
      }
    }

    return res.status(200).json({
      ok: true,
      mode,
      llm_id: llmId,
      agent_id: agentId,
      phone_number: phoneNumber,
      phone_number_id: phoneNumberId,
      number_tier: numberTier,
      voice_key: voiceKey,
      role: roleKey,
    });
  } catch (err) {
    console.error("provision failed:", err?.message || err);
    return res.status(err?.response?.status || 500).json({
      ok: false,
      error: "Provisioning Failed",
      details: err?.response?.data || err?.message,
    });
  }
};
