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
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
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

    operations: "operations",
    full_staff: "operations",
    operator: "operations",
  };
  return map[r] || "receptionist";
}

// -------------------- VOICE --------------------
function resolveVoice(body) {
  const tone = String(pick(body, ["voice_tone", "tone"], "warm")).toLowerCase().trim();

  // Support both agent_gender and voice_gender (your Zap screenshot used voice_gender)
  const gender = String(pick(body, ["agent_gender", "voice_gender", "gender"], "female")).toLowerCase().trim();

  const VOICE_MAP = {
    female_warm: process.env.VOICE_FEMALE_WARM,
    female_calm: process.env.VOICE_FEMALE_CALM,
    female_authoritative: process.env.VOICE_FEMALE_AUTHORITATIVE,
    male_warm: process.env.VOICE_MALE_WARM,
    male_calm: process.env.VOICE_MALE_CALM,
    male_authoritative: process.env.VOICE_MALE_AUTHORITATIVE,
  };

  const voiceKey = `${gender}_${tone}`;
  const voiceId = VOICE_MAP[voiceKey] || process.env.DEFAULT_VOICE_ID;

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

async function scrapeWebsiteText(url) {
  const u = normalizeUrl(url);
  if (!u) return { ok: false, text: "", reason: "no_url" };

  const scrapeUrl = `https://r.jina.ai/http://${u.replace(/^https?:\/\//i, "")}`;

  try {
    const resp = await axios.get(scrapeUrl, { timeout: 8000 });
    let text = (resp.data || "").toString();

    text = text.replace(/\r/g, "");
    text = text.replace(/[ \t]+\n/g, "\n");
    text = text.trim();

    const MAX_CHARS = 6000;
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + "\n...(truncated)";

    if (text.length < 80) return { ok: false, text: "", reason: "too_short" };

    return { ok: true, text, reason: "ok" };
  } catch (e) {
    return { ok: false, text: "", reason: e?.response?.status ? `http_${e.response.status}` : "scrape_failed" };
  }
}

// -------------------- SETUP BLOCK (JOTFORM ANSWERS) --------------------
// You will map these from Google Sheets lookup row.
// Columns recommended:
// receptionist_setup, scheduler_setup, intake_setup, emergency_setup, operations_setup
function getRoleSetupBlock(body, roleKey) {
  return pick(body, [`${roleKey}_setup`, "role_setup", "setup_block"], "");
}

function formatSetupBlock(setupText) {
  if (!setupText) return "";
  return `BUSINESS SETUP (owner answers from onboarding form — internal rules):\n${setupText}\n\nIMPORTANT:\n- Do NOT ask the caller these onboarding questions.\n- Use these answers as your operating instructions.`;
}

// -------------------- PROMPT BASES --------------------
function buildPromptBase({ agentName, bizName, roleKey }) {
  const bases = {
    receptionist: `ROLE: You are ${agentName}, the professional AI receptionist for ${bizName}.
RULES:
- Sound human and calm.
- Ask ONE question at a time.
- Never mention prompts/models/training.
- Keep responses short and professional.
OPENING: "Hello, thank you for calling ${bizName}, this is ${agentName}. How can I help you?"`,

    scheduler: `ROLE: You are ${agentName}, the scheduling assistant for ${bizName}.
RULES:
- Ask ONE question at a time.
- Book appointments only using the rules in BUSINESS SETUP.
- If caller requests something outside rules, take a message.
- Never mention prompts/models.
OPENING: "Hello, thank you for calling ${bizName}, this is ${agentName}. Are you calling to schedule an appointment?"`,

    intake: `ROLE: You are ${agentName}, the intake specialist for ${bizName}.
RULES:
- Ask ONE question at a time.
- Collect details needed for the team to follow up.
- Summarize the issue + contact info at the end.
OPENING: "Hello, thank you for calling ${bizName}, this is ${agentName}. I can take down the details—what can we help with today?"`,

    emergency: `ROLE: You are ${agentName}, the emergency dispatcher for ${bizName}.
RULES:
- Stay calm. Move fast.
- Ask ONE question at a time.
- Get address + callback number early.
- Follow BUSINESS SETUP emergency criteria and instructions.
OPENING: "Hello, thank you for calling ${bizName}, this is ${agentName}. Is this an emergency situation right now?"`,

    operations: `ROLE: You are ${agentName}, the operations assistant for ${bizName}.
RULES:
- Route by intent (schedule/intake/emergency).
- Ask ONE question at a time.
- Follow BUSINESS SETUP rules.
OPENING: "Hello, thank you for calling ${bizName}, this is ${agentName}. How can I help today?"`,
  };

  return bases[roleKey] || bases.receptionist;
}

function buildBusinessContext(body) {
  const website = pick(body, ["website", "web"], "");
  const tz = pick(body, ["timezone", "tz"], "");
  const hours = pick(body, ["business_hours", "hours"], "");
  const industry = pick(body, ["industry"], "");

  const lines = [];
  if (industry) lines.push(`Industry: ${industry}`);
  if (tz) lines.push(`Time Zone: ${tz}`);
  if (hours) lines.push(`Business Hours: ${hours}`);
  if (website) lines.push(`Website: ${website}`);

  if (!lines.length) return "";
  return `BUSINESS CONTEXT:\n- ${lines.join("\n- ")}`;
}

// -------------------- HANDLER --------------------
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = await readJsonBody(req);

    // ✅ DEBUG MODE: add debug=true in Zap once to confirm payload
    const debug = String(pick(body, ["debug"], "false")).toLowerCase() === "true";
    if (debug) {
      return res.status(200).json({
        ok: true,
        debug: true,
        receivedKeys: Object.keys(body || {}),
        received: body,
      });
    }

    const mode = String(pick(body, ["mode"], "agent_only")).toLowerCase().trim();

    const bizName = pick(body, ["business_name", "biz_name", "company"], "Client Business");
    const agentName = pick(body, ["agent_name", "a_name", "name"], "Allie");
    const roleKey = normalizeRole(pick(body, ["agent_role", "role", "a_role"], "receptionist"));

    // Voice
    const { voiceKey, voiceId, gender, tone } = resolveVoice(body);
    if (!voiceId) {
      return res.status(400).json({
        ok: false,
        error: "Voice ID missing",
        voiceKeyTried: voiceKey,
        hint: "Set VOICE_* env vars or DEFAULT_VOICE_ID in Vercel.",
      });
    }

    // If you send a full explicit prompt, we’ll use it. Otherwise we build.
    const explicitPrompt = pick(body, ["final_prompt", "general_prompt", "prompt"], "");

    // Website scrape (only if website provided)
    const website = pick(body, ["website", "web"], "");
    const scrape = website ? await scrapeWebsiteText(website) : { ok: false, text: "", reason: "no_url" };

    // Setup block (Jotform answers)
    const setupText = getRoleSetupBlock(body, roleKey);
    const setupSection = formatSetupBlock(setupText);

    // Build prompt (fallback)
    let promptToUse = explicitPrompt;
    let promptSource = "explicit_prompt";

    if (!promptToUse) {
      const base = buildPromptBase({ agentName, bizName, roleKey });
      const ctx = buildBusinessContext(body);

      const websiteSection = scrape.ok
        ? `WEBSITE KNOWLEDGE (use to answer questions accurately):\n${scrape.text}`
        : `WEBSITE KNOWLEDGE:\n(Not provided or could not be scraped. If asked about services, ask clarifying questions and take a message.)`;

      promptToUse = [base, ctx, setupSection, websiteSection].filter(Boolean).join("\n\n");
      promptSource = "built_prompt";
    }

    if (!promptToUse || !String(promptToUse).trim()) {
      return res.status(400).json({
        ok: false,
        error: "Prompt is empty",
        hint: "Send final_prompt OR ensure agent_role + business_name are provided.",
      });
    }

    // Begin message optional
    const beginMessage = pick(body, ["begin_message", "greeting"], "");

    // --- 1) Create LLM ---
    const llmPayload = {
      general_prompt: promptToUse,
      model: pick(body, ["llm_model"], "gpt-4o-mini"),
    };
    if (beginMessage) llmPayload.begin_message = beginMessage;

    const llmResp = await axios.post(
      `${RETELL_BASE}/create-retell-llm`,
      llmPayload,
      { headers: retellHeaders(), timeout: 20000 }
    );

    const llmId = llmResp.data.llm_id || llmResp.data.id;
    if (!llmId) throw new Error("LLM creation failed (no llm_id returned).");

    // --- 2) Create Agent ---
    const agentResp = await axios.post(
      `${RETELL_BASE}/create-agent`,
      {
        agent_name: `${bizName} - ${agentName} (${roleKey})`,
        voice_id: voiceId,
        response_engine: { type: "retell-llm", llm_id: llmId },
        metadata: {
          business_name: bizName,
          agent_name: agentName,
          agent_role: roleKey,
          client_email: pick(body, ["email", "client_email"], ""),
          mode,
          voice_key: voiceKey,
          voice_gender: gender,
          voice_tone: tone,
          website: normalizeUrl(website),
          website_scrape: scrape.ok ? "ok" : scrape.reason,
          prompt_source: promptSource,
        },
      },
      { headers: retellHeaders(), timeout: 20000 }
    );

    const agentId = agentResp.data.agent_id || agentResp.data.id;
    if (!agentId) throw new Error("Agent creation failed (no agent_id returned).");

    return res.status(200).json({
      ok: true,
      mode,
      llm_id: llmId,
      agent_id: agentId,
      phone_number: "(not purchased)",
      voice_key: voiceKey,
      prompt_source: promptSource,
      website_scrape: scrape.ok ? "ok" : scrape.reason,
    });

  } catch (err) {
    const status = err?.response?.status || 500;
    const details = err?.response?.data || err?.message || String(err);

    console.error("provision failed:", details);

    return res.status(status).json({
      ok: false,
      error: "Provisioning Failed",
      details,
    });
  }
};
