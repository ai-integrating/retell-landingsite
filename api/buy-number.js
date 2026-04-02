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
  const preferred = digitsOnly(
    pick(body, ["preferred_area_code", "area_code"], "")
  ).slice(0, 3);
  if (preferred.length === 3) return preferred;

  const bizPhone = pick(body, ["business_phone", "phone", "company_phone"], "");
  const d = digitsOnly(bizPhone);
  if (d.length === 10) return d.slice(0, 3);
  if (d.length === 11 && d.startsWith("1")) return d.slice(1, 4);

  return String(process.env.DEFAULT_AREA_CODE || "508");
}

const RETELL_BASE = "https://api.retellai.com";

function retellHeaders() {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) throw new Error("Missing RETELL_API_KEY in Environment Variables.");
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function buildAgentBindingPayload(agentId) {
  return {
    inbound_agents: [
      {
        agent_id: agentId,
        weight: 1,
      },
    ],
    outbound_agents: [
      {
        agent_id: agentId,
        weight: 1,
      },
    ],
  };
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
  const bindingPayload = buildAgentBindingPayload(agentId);

  let firstErr = null;

  if (phoneNumber) {
    try {
      await axios.patch(
        `${RETELL_BASE}/update-phone-number/${encodeURIComponent(phoneNumber)}`,
        bindingPayload,
        { headers: retellHeaders(), timeout: 7000 }
      );
      return { phone_number: phoneNumber, phone_number_id: phoneId || null };
    } catch (err) {
      firstErr = err;
      console.error(
        "PATCH by phone_number failed:",
        err?.response?.data || err?.message || err
      );
    }
  }

  if (phoneId) {
    try {
      await axios.patch(
        `${RETELL_BASE}/update-phone-number/${encodeURIComponent(phoneId)}`,
        bindingPayload,
        { headers: retellHeaders(), timeout: 7000 }
      );
      return { phone_number: phoneNumber || "(assigned)", phone_number_id: phoneId };
    } catch (err) {
      console.error(
        "PATCH by phone_id failed:",
        err?.response?.data || err?.message || err
      );
      throw err;
    }
  }

  throw new Error(
    `Could not bind phone number. patch_error=${
      JSON.stringify(firstErr?.response?.data || firstErr?.message || null)
    } phoneData=${JSON.stringify(phoneData)}`
  );
}

async function tryDetectAlreadyBoundNumber() {
  return null;
}

function isNoInventoryError(err) {
  const d = err?.response?.data;
  const msg =
    (typeof d === "string" ? d : d?.error || d?.message || "") +
    " " +
    (err?.message || "");
  return /no phone numbers of this area code/i.test(msg);
}

function unique3(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    const s = String(x || "").trim();
    if (/^\d{3}$/.test(s) && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function getFallbackAreaCodes(primaryAreaCode) {
  const envList = String(process.env.FALLBACK_AREA_CODES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const defaultList = ["508", "774", "617", "857", "781", "339"];

  return unique3([primaryAreaCode, ...envList, ...defaultList]);
}

async function createPhoneNumberWithFallback({ areaCode, nickname }) {
  const candidates = getFallbackAreaCodes(areaCode);
  let lastErr = null;

  for (const ac of candidates) {
    try {
      const data = await createPhoneNumber({ areaCode: ac, nickname });
      return { phoneData: data, usedAreaCode: ac };
    } catch (err) {
      lastErr = err;
      if (!isNoInventoryError(err)) throw err;
    }
  }

  throw lastErr || new Error("No available phone numbers in any fallback area codes.");
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const body = await readJsonBody(req);

    const agentId = pick(body, ["agent_id", "retell_agent_id"], "");
    if (!agentId) {
      return res.status(400).json({ ok: false, error: "Missing agent_id" });
    }

    const idempotencyKey = pick(body, ["idempotency_key", "job_id", "submission_id"], "");
    const bizName = pick(body, ["business_name", "biz_name", "company"], "Client Business");

    const numberTierRaw = String(pick(body, ["number_tier", "tier"], "standard"))
      .toLowerCase()
      .trim();
    const numberTier = numberTierRaw === "premium" ? "premium" : "standard";

    const existingNumber = pick(body, ["retell_phone_number", "phone_number"], "");
    if (
      existingNumber &&
      String(existingNumber).trim() &&
      String(existingNumber) !== "(not purchased)"
    ) {
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

    const areaCode = inferAreaCode(body);

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

    const nickname = `${bizName} - Main Line [${numberTier}]${
      idempotencyKey ? ` (${idempotencyKey})` : ""
    }`;

    const { phoneData, usedAreaCode } = await createPhoneNumberWithFallback({
      areaCode,
      nickname,
    });

    const bound = await bindPhoneNumberToAgent({ phoneData, agentId });

    return res.status(200).json({
      ok: true,
      agent_id: agentId,
      phone_number: bound.phone_number,
      pretty_phone_number: formatPrettyPhone(bound.phone_number),
      phone_number_id: bound.phone_number_id || phoneData.phone_number_id || phoneData.id || null,
      requested_area_code: areaCode,
      area_code: usedAreaCode,
      number_tier: numberTier,
      idempotency_key: idempotencyKey || null,
    });
  } catch (err) {
    console.error("buy-number failed:", err?.response?.data || err?.message || err);

    const noInventory = isNoInventoryError(err);

    return res.status(500).json({
      ok: false,
      error: "Buy Number Failed",
      reason: noInventory ? "NO_NUMBER_INVENTORY" : "UNKNOWN",
      details: err?.response?.data || err?.message,
    });
  }
};
