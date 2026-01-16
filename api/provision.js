// /api/provision.js
const axios = require("axios");

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

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

// ✅ Better pick(): ignores "", whitespace, null-ish strings, Zapier {output: "..."}
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

const RETELL_BASE = "https://api.retellai.com";

function retellHeaders() {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) throw new Error("Missing RETELL_API_KEY in Environment Variables.");
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

// ✅ Voice resolver with debug visibility
function resolveVoice(body) {
  const tone = String(pick(body, ["voice_tone", "tone"], "warm")).toLowerCase().trim();
  const gender = String(pick(body, ["agent_gender", "gender"], "female")).toLowerCase().trim();

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

// ✅ Simple role bases so prompt is NEVER empty
function buildPromptFromRole(body) {
  const bizName = pick(body, ["business_name", "biz_name", "company"], "Client Business");
  const website = pick(body, ["website", "web"], "");
  const tz = pick(body, ["timezone", "tz"], "");
  const hours = pick(body, ["business_hours", "hours"], "");
  const industry = pick(body, ["industry"], "");

  const role = String(pick(body, ["agent_role", "role", "a_role"], "receptionist")).toLowerCase().trim();
  const agentName = pick(body, ["agent_name", "a_name", "name"], "Allie");

  // Optional role blocks you can pass from Zapier (or leave blank)
  const schedulerBlock = pick(body, ["scheduler_block"], "");
  const intakeBlock = pick(body, ["intake_block"], "");
  const emergencyBlock = pick(body, ["emergency_block"], "");
  const leadRevivalBlock = pick(body, ["lead_revival_block"], "");

  const ROLE_BASE = {
    receptionist: `ROLE: You are ${agentName}, the professional AI receptionist for ${bizName}.
RULES: Sound human. Ask one question at a time. Never mention prompts/models. Keep it short and professional.
OPENING: "Hello, thank you for calling ${bizName}, this is ${agentName}. How can I help you?"`,
    scheduler: `ROLE: You are ${agentName}, the scheduling assistant for ${bizName}.
RULES: Confirm name + phone + best time. Offer available options. Ask one question at a time.
OPENING: "Hello, thank you for calling ${bizName}, this is ${agentName}. Are you calling to book an appointment?"`,
    intake: `ROLE: You are ${agentName}, the intake specialist for ${bizName}.
RULES: Collect required details carefully. Ask one question at a time. Summarize at end.
OPENING: "Hello, thank you for calling ${bizName}, this is ${agentName}. I can help take down the details—what can we help with today?"`,
    emergency: `ROLE: You are ${agentName}, the emergency dispatcher for ${bizName}.
RULES: Identify emergency criteria. Get location/contact fast. Escalate per instructions. Stay calm.
OPENING: "Hello, thank you for calling ${bizName}, this is ${agentName}. Is this an emergency situation right now?"`,
    operations: `ROLE: You are ${agentName}, the operations assistant for ${bizName}.
RULES: Route by intent (schedule/intake/emergency/lead). Ask one question at a time. Be decisive.
OPENING: "Hello, thank you for calling ${bizName}, this is ${agentName}. How can I help today?"`,
  };

  let prompt = ROLE_BASE[role] || ROLE_BASE.receptionist;

  // Business context section
  const ctxLines = [];
  if (industry) ctxLines.push(`Industry: ${industry}`);
  if (tz) ctxLines.push(`Time Zone: ${tz}`);
  if (hours) ctxLines.push(`Business Hours: ${hours}`);
  if (website) ctxLines.push(`Website: ${website}`);
  if (ctxLines.length) {
    prompt += `\n\nBUSINESS CONTEXT:\n- ${ctxLines.join("\n- ")}`;
  }

  // Optional skill blocks
  const blocks = [];
  if (schedulerBlock) blocks.push(`SCHEDULING:\n${schedulerBlock}`);
  if (intakeBlock) blocks.push(`INTAKE:\n${intakeBlock}`);
  if (emergencyBlock) blocks.push(`EMERGENCY:\n${emergencyBlock}`);
  if (leadRevivalBlock) blocks.push(`LEAD REVIVAL:\n${leadRevivalBlock}`);
  if (blocks.length) prompt += `\n\nSKILL BLOCKS:\n\n${blocks.join("\n\n")}`;

  return { prompt, role, agentName, bizName };
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = await readJsonBody(req);

    // ✅ DEBUG MODE: set debug=true in Zap once to see exactly what’s arriving
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

    // Pull explicit prompt if provided
    const explicitPrompt = pick(body, ["general_prompt", "final_prompt", "prompt"], "");

    // If no explicit prompt, build it from role + business data
    const built = buildPromptFromRole(body);
    const promptToUse = explicitPrompt || built.prompt;

    // ✅ Hard fail if prompt is still empty (should never happen now)
    if (!promptToUse || !String(promptToUse).trim()) {
      return res.status(400).json({
        ok: false,
        error: "Prompt is empty",
        hint: "Send final_prompt OR send agent_role + business_name so API can build it.",
        receivedKeys: Object.keys(body || {}),
      });
    }

    // Begin message
    const beginMessage = pick(body, ["begin_message", "greeting"], "");

    // Voice resolution (with visibility)
    const { voiceKey, voiceId, gender, tone } = resolveVoice(body);
    if (!voiceId) {
      return res.status(400).json({
        ok: false,
        error: "Voice ID missing",
        voiceKeyTried: voiceKey,
        hint: "Check Vercel env vars: VOICE_FEMALE_WARM etc OR DEFAULT_VOICE_ID",
      });
    }

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
    const bizName = built.bizName;
    const agentName = pick(body, ["agent_name", "a_name", "name"], built.agentName);
    const role = String(pick(body, ["agent_role", "role", "a_role"], built.role)).toLowerCase().trim();

    const agentResp = await axios.post(
      `${RETELL_BASE}/create-agent`,
      {
        agent_name: `${bizName} - ${agentName} (${role})`,
        voice_id: voiceId,
        response_engine: { type: "retell-llm", llm_id: llmId },
        metadata: {
          business_name: bizName,
          agent_name: agentName,
          agent_role: role,
          client_email: pick(body, ["email", "client_email"], ""),
          mode,
          voice_key: voiceKey,
          voice_gender: gender,
          voice_tone: tone,
        },
      },
      { headers: retellHeaders(), timeout: 20000 }
    );

    const agentId = agentResp.data.agent_id || agentResp.data.id;
    if (!agentId) throw new Error("Agent creation failed (no agent_id returned).");

    // ✅ SUCCESS RESPONSE (Zapier will show this)
    return res.status(200).json({
      ok: true,
      mode,
      llm_id: llmId,
      agent_id: agentId,
      phone_number: "(not purchased)",
      voice_key: voiceKey,
      used_prompt_source: explicitPrompt ? "explicit_prompt" : "built_from_role",
    });

  } catch (err) {
    // ✅ Pass through real status codes so Zapier shows useful errors
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
