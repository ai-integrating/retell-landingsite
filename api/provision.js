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

function pick(obj, keys, fallback = undefined) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return fallback;
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
    try {
      await axios.patch(
        `${RETELL_BASE}/update-phone-number/${encodeURIComponent(phoneNumber)}`,
        { inbound_agent_id: agentId, outbound_agent_id: agentId },
        { headers: retellHeaders(), timeout: 7000 }
      );
      return { phone_number: phoneNumber };
    } catch (_) {}
  }

  if (phoneId) {
    await axios.patch(
      `${RETELL_BASE}/update-phone-number/${encodeURIComponent(phoneId)}`,
      { inbound_agent_id: agentId, outbound_agent_id: agentId },
      { headers: retellHeaders(), timeout: 7000 }
    );
    return { phone_number: phoneNumber || "(assigned)" };
  }

  throw new Error(`Could not bind phone number: phoneData=${JSON.stringify(phoneData)}`);
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = await readJsonBody(req);

    const bizName = pick(body, ["business_name", "biz_name", "company"], "Client Business");
    const voiceId = pick(body, ["voice_id"], process.env.DEFAULT_VOICE_ID);
    const areaCode = inferAreaCode(body);

    // ✅ IMPORTANT: Zapier should send THIS as the full finished prompt
    const prompt = pick(body, ["general_prompt", "final_prompt", "prompt"], "");

    // Optional greeting (✅ belongs on the LLM call)
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
        },
      },
      { headers: retellHeaders(), timeout: 12000 }
    );

    const agentId = agentResp.data.agent_id || agentResp.data.id;
    if (!agentId) throw new Error("Agent creation failed (no agent_id returned).");

    // --- 3) Buy & Bind Phone Number (best effort) ---
    let phoneNumber = "Provisioning...";
    try {
      const phoneData = await createPhoneNumber({
        areaCode,
        nickname: `${bizName} - Main Line`,
      });

      const bound = await bindPhoneNumberToAgent({ phoneData, agentId });
      phoneNumber = bound.phone_number || phoneNumber;
    } catch (e) {
      console.warn("Phone buy/bind failed:", e?.response?.data || e?.message || e);
    }

    return res.status(200).json({
      ok: true,
      agent_id: agentId,
      phone_number: phoneNumber,
    });

  } catch (error) {
    console.error("provision failed:", error?.response?.data || error?.message || error);
    return res.status(500).json({
      ok: false,
      error: "Provisioning Failed",
      details: error?.response?.data || error?.message,
    });
  }
};
