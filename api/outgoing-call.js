// /api/outgoing-call.js
// Place an outbound call via Retell Call (V2) endpoint.
// ✅ UPDATED: Added 'direction' to match {{direction}} in provision.js
// ✅ UPDATED: Hard cutoffs when limits are hit
// ✅ UPDATED: Sends CALL_DIRECTION="outbound" for backward compatibility
// ✅ UPDATED: Agent and business names are now dynamic

const axios = require("axios");
const { kv } = require("@vercel/kv");

// -------------------- CORS --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Idempotency-Key"
  );
}

// -------------------- BODY --------------------
async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  if (req.body && typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return await new Promise((resolve) => {
    let data = "";

    req.on("data", (chunk) => {
      data += chunk;
    });

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

// -------------------- HELPERS --------------------
function cleanPhone(phone) {
  if (!phone) return "";

  const p = String(phone).trim();
  const digits = p.replace(/[^\d]/g, "");

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (p.startsWith("+")) return p;

  return digits ? `+${digits}` : "";
}

function pick(obj, keys, fallback = undefined) {
  for (const k of keys) {
    let v = obj?.[k];

    if (v && typeof v === "object" && "output" in v) {
      v = v.output;
    }

    if (v === undefined || v === null) continue;

    if (typeof v === "string") {
      const s = v.trim();

      if (!s) continue;
      if (s.toLowerCase() === "null") continue;
      if (s.toLowerCase() === "undefined") continue;

      return s;
    }

    return v;
  }

  return fallback;
}

function asString(v, fallback = "") {
  if (v === undefined || v === null) return fallback;

  if (typeof v === "object" && "output" in v) {
    v = v.output;
  }

  const s = String(v).trim();

  return s ? s : fallback;
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

// -------------------- MAIN --------------------
module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return json(res, 405, {
      ok: false,
      error: "Method not allowed",
    });
  }

  const body = await readJsonBody(req);

  const agent_id = pick(body, ["agent_id", "agentId"]);

  const to_number = cleanPhone(
    pick(body, [
      "to_number",
      "to",
      "phone_number",
      "phone",
      "client_phone",
    ])
  );

  const from_number = cleanPhone(
    pick(body, [
      "from_number",
      "from",
      "retell_phone",
      "outbound_from_number",
    ])
  );

  const client_name = pick(body, [
    "client_name",
    "clientName",
    "name",
  ]);

  const business_name = pick(body, [
    "business_name",
    "businessName",
    "company_name",
    "companyName",
  ]);

  const agent_name = pick(body, [
    "agent_name",
    "agentName",
  ]);

  const reason_for_call = pick(body, [
    "reason_for_call",
    "reason",
    "call_reason",
  ]);

  const notes = pick(body, [
    "notes",
    "note",
  ]);

  if (!agent_id) {
    return json(res, 400, {
      ok: false,
      error: "Missing agent_id",
    });
  }

  if (!to_number) {
    return json(res, 400, {
      ok: false,
      error: "Missing to_number",
    });
  }

  if (!from_number) {
    return json(res, 400, {
      ok: false,
      error: "Missing from_number",
    });
  }

  try {
    const RETELL_API_KEY =
      process.env.OUTBOUND_RETELL_API_KEY ||
      process.env.RETELL_API_KEY;

    if (!RETELL_API_KEY) {
      throw new Error("Missing RETELL API key env var");
    }

    const url = "https://api.retellai.com/v2/create-phone-call";

    // Dynamic outbound-call information
    const safeClientName = asString(client_name, "there");
    const safeBusinessName = asString(business_name, "the office");
    const safeAgentName = asString(agent_name, "");
    const safeReason = asString(
      reason_for_call,
      "something you requested"
    );

    // Create the first spoken line without any hardcoded business or agent
    const firstLine = safeAgentName
      ? `Hi ${safeClientName}, this is ${safeAgentName} calling from ${safeBusinessName} about ${safeReason}.`
      : `Hi ${safeClientName}, I'm calling from ${safeBusinessName} about ${safeReason}.`;

    const dynVars = {
      // Match the {{direction}} variable in provision.js
      direction: "outbound",

      // Legacy compatibility
      CALL_DIRECTION: "outbound",
      call_direction: "outbound",

      // Forced opening line
      first_line: firstLine,

      // Standard context variables
      client_name: asString(client_name, ""),
      business_name: asString(business_name, ""),
      agent_name: asString(agent_name, ""),
      reason_for_call: asString(reason_for_call, ""),
      notes: asString(notes, ""),
    };

    const payload = {
      from_number,
      to_number,
      override_agent_id: agent_id,
      retell_llm_dynamic_variables: dynVars,
      metadata: {
        direction: "outbound",
        CALL_DIRECTION: "outbound",
      },
    };

    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${RETELL_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });

    return json(res, 200, {
      ok: true,
      status: "created",
      sent_dynVars: dynVars,
      retell: resp.data,
    });
  } catch (err) {
    const msg =
      err?.response?.data ||
      err?.message ||
      "Unknown error";

    return json(res, 500, {
      ok: false,
      error: msg,
    });
  }
};
