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

// -------------------- ROLE NORMALIZATION --------------------
function normalizeRole(roleRaw) {
  const r = String(roleRaw || "").toLowerCase().trim();
  if (
    r.includes("full staff") ||
    r.includes("full_staff") ||
    r.includes("operations") ||
    r.includes("operator")
  )
    return "operations";
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
  };

  return map[r] || "receptionist";
}

// -------------------- NUMBER TIER --------------------
function tierForRole(roleKey) {
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

// -------------------- VOICE --------------------
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

// ✅ NEW: Extract website from global setup text if website field missing
function extractWebsiteFromText(text) {
  if (!text) return "";
  const s = String(text);

  // Prefer explicit http(s) URL
  const m1 = s.match(/website\s*[:=]\s*(https?:\/\/[^\s]+)/i);
  if (m1?.[1]) return m1[1].trim();

  // Fallback: domain without protocol (e.g., www.example.com)
  const m2 = s.match(/website\s*[:=]\s*([a-z0-9.-]+\.[a-z]{2,}[^\s]*)/i);
  if (m2?.[1]) return m2[1].trim();

  return "";
}

async function scrapeWebsiteText(url) {
  const u = normalizeUrl(url);
  if (!u) return { ok: false, text: "", reason: "no_url" };

  // Use the full secure URL and increase timeout for Jina Reader
  const scrapeUrl = `https://r.jina.ai/${u}`;
  try {
    const resp = await axios.get(scrapeUrl, {
      timeout: 15000,
      headers: { "X-Return-Format": "markdown" },
    });
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
    `- Collect: caller name, callback number, and a brief hair-service goal.`,
    `- Do NOT give exact pricing or guarantees; offer to have the team follow up.`,
    `- If unsure about a service detail, take a message rather than guessing.`,
  ];

  return [`GLOBAL BUSINESS INFO (internal reference):`, ...facts.map((l) => `- ${l}`), ``, ...instructions].join(
    "\n"
  );
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

// -------------------- PROMPT BASES --------------------
function buildPromptBase({ agentName, bizName, roleKey }) {
  // ✅ NEW: Outbound/inbound direction is explicit & resilient
  const directionLogic = [
    `CRITICAL CALL-START LOGIC:`,
    `- You may be given CALL_DIRECTION = "outbound" or "inbound".`,
    `- If CALL_DIRECTION is "outbound": YOU are calling the customer first.`,
    `  - Do NOT start with "How can I help you?"`,
    `  - Use the OUTBOUND OPENER.`,
    `- If CALL_DIRECTION is "inbound" OR missing: assume this is an INBOUND call.`,
    `  - Use the INBOUND OPENER.`,
    ``,
    `VARIABLES YOU MAY RECEIVE (may be blank):`,
    `- CLIENT_NAME (or client_name): name of the person you are calling (outbound)`,
    `- REASON_FOR_CALL (or reason_for_call): why you are calling (outbound)`,
    `- NOTES (or notes): extra context to include in ONE short sentence (outbound)`,
    ``,
    `INBOUND OPENER:`,
    `"Hello, this is ${agentName} at ${bizName}. How can I help you today?"`,
    ``,
    `OUTBOUND OPENER (must sound natural even if fields are blank):`,
    `"Hi there — this is ${agentName} calling from ${bizName}. I'm calling about something you requested."`,
    `- If CLIENT_NAME is provided, replace "Hi there" with "Hi CLIENT_NAME".`,
    `- If REASON_FOR_CALL is provided, replace "something you requested" with REASON_FOR_CALL.`,
    `- If NOTES is provided, add ONE short sentence using it.`,
    `- Then ask ONE clear question to move the call forward.`,
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
  return `BUSINESS CONTEXT:\n- ${lines.join("\n- ")}`;
}

// -------------------- IDEMPOTENCY HELPERS --------------------
async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getSubmissionId(body) {
  return String(pick(body, ["jotform_submission_id", "submission_id", "idempotency_key", "job_id"], "")).trim();
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

function normalizeProvisionRecord({ mode, llmId, agentId, phoneNumber, phoneNumberId, numberTierFinal, voiceKey, roleKey }) {
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
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

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
    if (existing) return res.status(200).json({ ok: true, idempotent: true, ...existing });

    const locked = await acquireLock(lockKey, 120);
    if (!locked) {
      for (let i = 0; i < 8; i++) {
        await sleep(600);
        const after = await getExistingProvision(idemKey);
        if (after) return res.status(200).json({ ok: true, idempotent: true, ...after });
      }
      return res.status(409).json({ ok: false, error: "Provisioning in progress" });
    }

    const purchaseNumber = String(pick(body, ["purchase_number", "buy_number"], "false")).toLowerCase() === "true";
    const mode = String(pick(body, ["mode"], purchaseNumber ? "agent_and_number" : "agent_only"))
      .toLowerCase()
      .trim();

    const bizName = pick(body, ["business_name", "biz_name", "company"], "Roots and Daiseys");
    const agentName = pick(body, ["agent_name", "a_name", "name"], "Julian");

    const roleKey = normalizeRole(pick(body, ["agent_role", "role", "a_role"], "receptionist"));
    const { voiceKey, voiceId } = resolveVoice(body);

    const explicitPrompt = pick(body, ["final_prompt", "general_prompt", "prompt"], "");

    // ✅ Build setup blocks first (so we can extract website from global_setup if needed)
    const globalSetup = getGlobalSetupBlock(body) || buildGlobalSetupFromFields(body);
    const roleSetup = getRoleSetupBlock(body, roleKey) || buildSetupForRole(body, roleKey);
    const setupSection = formatSetupBlock([globalSetup, roleSetup].filter(Boolean).join("\n\n"));

    // ✅ Website: prefer explicit field, else extract from global setup text
    let website = pick(body, ["website", "web", "website_url", "site", "url"], "");
    if (!website) website = extractWebsiteFromText(globalSetup);

    const scrape = website ? await scrapeWebsiteText(website) : { ok: false, text: "", reason: "no_url" };

    let promptToUse = explicitPrompt;
    let promptSource = "explicit_prompt";

    if (!promptToUse) {
      let base = buildPromptBase({ agentName, bizName, roleKey });

      // ✅ UPDATED outbound rules: no hard dependency on {{client_name}} templates
      const outboundRules = [
        `OUTBOUND BEHAVIOR RULES (apply ONLY when CALL_DIRECTION is "outbound"):`,
        `- You initiate the conversation (you called them).`,
        `- If CLIENT_NAME (or client_name) is blank: start with "Hi there".`,
        `- If REASON_FOR_CALL (or reason_for_call) is blank: say "calling about something you requested."`,
        `- If NOTES (or notes) is provided: add ONE short sentence using it.`,
        `- Then ask ONE clear question to move the call forward.`,
        `- NEVER ask "How can I help you?" as your first line on outbound.`,
      ].join("\n");

      const outboundRoles = new Set(["receptionist", "lead_revival", "operations"]);
      if (outboundRoles.has(roleKey)) {
        base = [base, outboundRules].join("\n\n");
      }

      const ctx = buildBusinessContext(body);
      const websiteSection = scrape.ok
        ? `WEBSITE KNOWLEDGE:\n${scrape.text}`
        : `WEBSITE KNOWLEDGE: (Not available: ${scrape.reason})`;

      promptToUse = [base, ctx, setupSection, websiteSection].filter(Boolean).join("\n\n");
      promptSource = "built_prompt";
    }

    const llmResp = await axios.post(
      `${RETELL_BASE}/create-retell-llm`,
      { general_prompt: promptToUse, model: pick(body, ["llm_model"], "gpt-4o-mini") },
      { headers: retellHeaders(), timeout: 20000 }
    );
    const llmId = llmResp.data.llm_id || llmResp.data.id;

    const agentResp = await axios.post(
      `${RETELL_BASE}/create-agent`,
      {
        agent_name: `${bizName} - ${agentName} (${roleKey})`,
        voice_id: voiceId,
        response_engine: { type: "retell-llm", llm_id: llmId },
        metadata: { business_name: bizName, agent_role: roleKey, submission_id: submissionId },
      },
      { headers: retellHeaders(), timeout: 20000 }
    );
    const agentId = agentResp.data.agent_id || agentResp.data.id;

    let phoneNumber = "(not purchased)";
    let phoneNumberId = null;
    const numberTierFinal = tierForRole(roleKey);

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
      const baseUrl = getBaseUrl(req);
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
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (lockKey) await releaseLock(lockKey);
  }
};
