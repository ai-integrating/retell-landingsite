// /api/buy-number.js
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

// ✅ Zapier-safe pick (supports {output: "..."} shapes)
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

function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

// ✅ Pretty formatter (US)
function formatPrettyPhone(number) {
  if (!number) return "";
  const d = digitsOnly(number);

  if (d.length === 11 && d.startsWith("1")) {
    return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  }
  if (d.length === 10) {
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return String(number);
}

function inferAreaCode(body) {
  const preferred = digitsOnly(pick(body, ["preferred_area_code", "area_code"], "")).slice(0, 3);
  if (preferred.length === 3) return preferred;

  const bizPhone = pick(body, ["business_phone", "phone", "company_phone"], "");
  const d = digitsOnly(bizPhone);
  if (d.length === 10) return d.slice(0, 3);
  if (d.length === 11 && d.startsWith("1")) return d.slice(1, 4);

  // default fallback
  return String(process.env.DEFAULT_AREA_CODE || "508");
}

const RETELL_BASE = "https://api.retellai.com";

function retellHeaders() {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) throw new Error("Missing RETELL_API_KEY in Environment Variables.");
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

// --- Retell helpers ---
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

  // Try binding by phone number (common)
  if (phoneNumber) {
    try {
      await axios.patch(
        `${RETELL_BASE}/update-phone-number/${encodeURIComponent(phoneNumber)}`,
        { inbound_agent_id: agentId, outbound_agent_id: agentId },
        { headers: retellHeaders(), timeout: 7000 }
      );
      return { phone_number: phoneNumber, phone_number_id: phoneId || null };
    } catch (_) {}
  }

  // Fallback: bind by id
  if (phoneId) {
    await axios.patch(
      `${RETELL_BASE}/update-phone-number/${encodeURIComponent(phoneId)}`,
      { inbound_agent_id: agentId, outbound_agent_id: agentId },
      { headers: retellHeaders(), timeout: 7000 }
    );
    return { phone_number: phoneNumber || "(assigned)", phone_number_id: phoneId };
  }

  throw new Error(`Could not bind phone number: phoneData=${JSON.stringify(phoneData)}`);
}

// Optional: attempt to detect if agent already has a bound inbound number.
// NOTE: If your Retell account supports an "agent get" endpoint, we can enhance this later.
async function tryDetectAlreadyBoundNumber() {
  return null; // keep simple for now
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = await readJsonBody(req);

    // Required
    const agentId = pick(body, ["agent_id", "retell_agent_id"], "");
    if (!agentId) {
      return res.status(400).json({ ok: false, error: "Missing agent_id" });
    }

    // Optional tracking (for your Sheets / logs)
    const idempotencyKey = pick(body, ["idempotency_key", "job_id", "submission_id"], "");
    const bizName = pick(body, ["business_name", "biz_name", "company"], "Client Business");

    // ✅ Tier support (accept from provision, normalize)
    const numberTierRaw = String(pick(body, ["number_tier", "tier"], "standard")).toLowerCase().trim();
    const numberTier = numberTierRaw === "premium" ? "premium" : "standard";

    // If caller already has number recorded in sheet, they should NOT call this endpoint.
    // But just in case, we can accept an existing number and no-op.
    const existingNumber = pick(body, ["retell_phone_number", "phone_number"], "");
    if (existingNumber && String(existingNumber).trim() && String(existingNumber) !== "(not purchased)") {
      return res.status(200).json({
        ok: true,
        agent_id: agentId,
        phone_number: existingNumber,
        pretty_phone_number: formatPrettyPhone(existingNumber),
        phone_number_id: pick(body, ["retell_phone_number_id", "phone_number_id"], null),
        number_tier: numberTier,
        message: "Already has phone_number in payload; skipping purchase.",
        idempotency_key: idempotencyKey || null,
      });
    }

    // Area code preference
    const areaCode = inferAreaCode(body);

    // Optional: very lightweight "already bound" detection (placeholder)
    const detected = await tryDetectAlreadyBoundNumber();
    if (detected) {
      return res.status(200).json({
        ok: true,
        agent_id: agentId,
        phone_number: detected.phone_number,
        pretty_phone_number: formatPrettyPhone(detected.phone_number),
        phone_number_id: detected.phone_number_id || null,
        number_tier: numberTier,
        message: "Detected existing bound number; skipping purchase.",
        idempotency_key: idempotencyKey || null,
      });
    }

    // ✅ Buy + bind in one transaction-like flow
    const phoneData = await createPhoneNumber({
      areaCode,
      // ✅ include tier in nickname so you can audit in Retell
      nickname: `${bizName} - Main Line [${numberTier}]${idempotencyKey ? ` (${idempotencyKey})` : ""}`,
    });

    const bound = await bindPhoneNumberToAgent({ phoneData, agentId });

    return res.status(200).json({
      ok: true,
      agent_id: agentId,

      phone_number: bound.phone_number,
      pretty_phone_number: formatPrettyPhone(bound.phone_number),

      phone_number_id: bound.phone_number_id || phoneData.phone_number_id || phoneData.id || null,
      area_code: areaCode,
      number_tier: numberTier,
      idempotency_key: idempotencyKey || null,
    });

  } catch (err) {
    console.error("buy-number failed:", err?.response?.data || err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "Buy Number Failed",
      details: err?.response?.data || err?.message,
    });
  }
};
