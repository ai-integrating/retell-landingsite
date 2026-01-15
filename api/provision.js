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
  const tone = String(pick(body, ["voice_tone", "tone"], "warm"))
    .toLowerCase()
    .trim();

  const gender = String(pick(body, ["agent_gender", "gender"], "female"))
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

  return VOICE_MAP[`${gender}_${tone}`] || process.env.DEFAULT_VOICE_ID;
}

function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

function inferAreaCode(body) {
  const preferred = digitsOnly(pick(body, ["preferred_area_code", "area_code"], "")).slice(0, 3);
  if (preferred.length === 3) return preferred;

  const bizPhone = pick(body, ["business_phone", "phone", "company_phone"], "");
  const d = digitsOnly(bizPhone);
  if (d.length === 10) return d.slice(0, 3);
  if (d.length === 11 && d.startsWith("1")) return d.slice(1, 4);

  return "508";
}

const RETELL_BASE = "https://api.retellai.com";

function retellHeaders() {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) throw new Error("Missing RETELL_API_KEY in Environment Variables.");
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function createPhoneNumber({ areaCode, nickname }) {
  const resp = await axios.post(
    `${RETELL_BASE}/create-phone-number`,
    { area_code: Number(areaCode), nickname },
    { headers: retellHeaders(), timeout: 12000 }
  );
  return resp.data;
}

async function bindPhoneNumberToAgent({ phoneData, agentId }) {
  const phoneNumber = phoneData.phone_number || phoneData.e164 || phoneData.number || null;
  const phoneId = phoneData.phone_number_id || phoneData.id || null;

  if (phoneNumber) {
    await axios.patch(
      `${RETELL_BASE}/update-phone-number/${encodeURIComponent(phoneNumber)}`,
      { inbound_agent_id: agentId, outbound_agent_id: agentId },
      { headers: retellHeaders(), timeout: 7000 }
    );
    return { phone_number: phoneNumber };
  }

  if (phoneId) {
    await axios.patch(
      `${RETELL_BASE}/update-phone-number/${encodeURIComponent(phoneId)}`,
      { inbound_agent_id: agentId, outbound_agent_id: agentId },
      { headers: retellHeaders(), timeout: 7000 }
    );
    return { phone_number: phoneNumber || "(assigned)" };
  }

  throw new Error("Could not bind phone number");
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  try {
    const body = await readJsonBody(req);

    const bizName = pick(body, ["business_name", "biz_name", "company"], "Client Business");
    const voiceId = resolveVoiceId(body);
    const areaCode = inferAreaCode(body);

    const prompt = pick(body, ["general_prompt", "final_prompt", "prompt"], "");
    const beginMessage = pick(body, ["begin_message", "greeting"], "");

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

    const agentResp = await axios.post(
      `${RETELL_BASE}/create-agent`,
      {
        agent_name: `${bizName} - Allie`,
        voice_id: voiceId,
        response_engine: { type: "retell-llm", llm_id: llmResp.data.llm_id },
      },
      { headers: retellHeaders(), timeout: 12000 }
    );

    const phoneData = await createPhoneNumber({
      areaCode,
      nickname: `${bizName} - Main Line`,
    });

    const bound = await bindPhoneNumberToAgent({
      phoneData,
      agentId: agentResp.data.agent_id,
    });

    return res.status(200).json({
      ok: true,
      agent_id: agentResp.data.agent_id,
      phone_number: bound.phone_number,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
