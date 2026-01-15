
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

// ✅ Single Zapier-safe pick()
function pick(obj, keys, fallback = undefined) {
  for (const k of keys) {
    let val = obj?.[k];
    if (val !== undefined && val !== null && val !== "") {
      if (typeof val === "object" && val.output) return val.output;
      return val;
    }
  }
  return fallback;
}

// ✅ Voice resolver (NO energetic)
function resolveVoiceId(body) {
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

  return VOICE_MAP[`${gender}_${tone}`] || process.env.DEFAULT_VOICE_ID;
}

const RETELL_BASE = "https://api.retellai.com";

function retellHeaders() {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) throw new Error("Missing RETELL_API_KEY in Environment Variables.");
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = await readJsonBody(req);

    const mode = String(pick(body, ["mode"], "agent_only")).toLowerCase().trim();

    const bizName = pick(body, ["business_name", "biz_name", "company"], "Client Business");
    const voiceId = resolveVoiceId(body);

    const prompt = pick(body, ["general_prompt", "final_prompt", "prompt"], "");
    const beginMessage = pick(body, ["begin_message", "greeting"], "");

    // --- 1) Create LLM ---
    const llmPayload = {
      general_prompt: prompt || `You are Allie, the AI receptionist for ${bizName}.`,
      model: pick(body, ["llm_model"], "gpt-4o-mini"),
    };
    if (beginMessage) llmPayload.begin_message = beginMessage;

    const llmResp = await axios.post(
      `${RETELL_BASE}/create-retell-llm`,
      llmPayload,
      { headers: retellHeaders(), timeout: 12000 }
    );

    const llmId = llmResp.data.llm_id || llmResp.data.id;
    if (!llmId) throw new Error("LLM creation failed (no llm_id returned).");

    // --- 2) Create Agent ---
    const agentResp = await axios.post(
      `${RETELL_BASE}/create-agent`,
      {
        agent_name: `${bizName} - Allie`,
        voice_id: voiceId,
        response_engine: { type: "retell-llm", llm_id: llmId },
        metadata: {
          business_name: bizName,
          client_email: pick(body, ["email", "client_email"], ""),
          mode,
        },
      },
      { headers: retellHeaders(), timeout: 12000 }
    );

    const agentId = agentResp.data.agent_id || agentResp.data.id;
    if (!agentId) throw new Error("Agent creation failed (no agent_id returned).");

    // ✅ AGENT ONLY RESPONSE
    return res.status(200).json({
      ok: true,
      mode,
      llm_id: llmId,
      agent_id: agentId,
      phone_number: "(not purchased)",
    });

  } catch (err) {
    console.error("provision failed:", err?.response?.data || err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "Provisioning Failed",
      details: err?.response?.data || err?.message,
    });
  }
};
