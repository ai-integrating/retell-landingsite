// /api/retell-outbound-call.js
// Purpose: Place an outbound call using an *existing* Retell agent.
// ✅ Does NOT create agents
// ✅ Does NOT buy numbers
// ✅ Safe to call from Zapier / your portal

const axios = require("axios");

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

// -------------------- HELPERS --------------------
function cleanPhone(phone) {
  if (!phone) return "";
  let p = String(phone).trim();

  // If user gave 10 digits, assume US and add +1
  const digits = p.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  // If already has +, keep it
  if (p.startsWith("+")) return p;

  // Fallback: best effort
  return digits ? `+${digits}` : "";
}

function pick(obj, keys, fallback = undefined) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return fallback;
}

function okJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

// -------------------- MAIN --------------------
module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    return res.end("ok");
  }

  if (req.method !== "POST") {
    return okJson(res, 405, { ok: false, error: "Use POST" });
  }

  try {
    const body = await readJsonBody(req);

    // Accept either snake_case or camelCase to make Zap mapping easier
    const agent_id = pick(body, ["agent_id", "agentId"]);
    const to_phone_raw = pick(body, ["to_phone", "toPhone", "phone", "to"]);

    // ✅ Support either Retell phone number ID (pn_...) OR a literal from_number (+1...)
    const from_phone_number_id = pick(body, [
      "from_phone_number_id",
      "fromPhoneNumberId",
      "phone_number_id",
      "phoneNumberId",
    ]);

    const from_number_raw = pick(body, [
      "from_number",
      "fromNumber",
      "from_phone",
      "fromPhone",
      "caller_id",
      "callerId",
    ]);

    const metadata = pick(body, ["metadata"], {});
    const context = pick(body, ["context"], {});
    const dynamic_variables = pick(body, ["dynamic_variables", "dynamicVariables"], {});

    // Idempotency key (recommended for Zapier retries)
    const idempotency_key =
      req.headers["x-idempotency-key"] ||
      pick(body, ["idempotency_key", "idempotencyKey"], "");

    if (!process.env.OUTBOUND_RETELL_API_KEY) {
      return okJson(res, 500, { ok: false, error: "Missing OUTBOUND_RETELL_API_KEY" });
    }

    if (!agent_id) {
      return okJson(res, 400, { ok: false, error: "Missing agent_id" });
    }

    const to_number = cleanPhone(to_phone_raw);
    if (!to_number) {
      return okJson(res, 400, { ok: false, error: "Missing/invalid to_phone" });
    }

    const from_number = cleanPhone(from_number_raw);

    // -------------------- RETELL OUTBOUND CALL --------------------
    const RETELL_BASE = "https://api.retellai.com";
    const OUTBOUND_PATH = "/create-phone-call"; // <-- may vary by Retell account/version

    const payload = {
      // Required
      agent_id,
      to_number,

      // Optional: specify from number id if you want strict control
      ...(from_phone_number_id ? { from_phone_number_id } : {}),

      // ✅ If you don't have the pn_... id, allow a literal outbound caller ID number
      ...(!from_phone_number_id && from_number ? { from_number } : {}),

      metadata: {
        ...(typeof metadata === "object" && metadata ? metadata : {}),
        idempotency_key: idempotency_key || undefined,
        outbound: true,
      },

      dynamic_variables:
        typeof dynamic_variables === "object" && dynamic_variables
          ? dynamic_variables
          : {},

      context: typeof context === "object" && context ? context : {},
    };

    const headers = {
      Authorization: `Bearer ${process.env.OUTBOUND_RETELL_API_KEY}`,
      "Content-Type": "application/json",
    };

    if (idempotency_key) {
      headers["Idempotency-Key"] = idempotency_key;
    }

    const resp = await axios.post(`${RETELL_BASE}${OUTBOUND_PATH}`, payload, {
      headers,
      timeout: 60_000,
      validateStatus: () => true,
    });

    if (resp.status < 200 || resp.status >= 300) {
      return okJson(res, 502, {
        ok: false,
        error: "Retell outbound call failed",
        status: resp.status,
        data: resp.data,
        sent: {
          agent_id,
          to_number,
          from_phone_number_id: from_phone_number_id || null,
          from_number: !from_phone_number_id ? (from_number || null) : null,
        },
      });
    }

    return okJson(res, 200, {
      ok: true,
      mode: "outbound_call",
      agent_id,
      to_number,
      from_phone_number_id: from_phone_number_id || null,
      from_number: !from_phone_number_id ? (from_number || null) : null,
      idempotency_key: idempotency_key || null,
      retell: resp.data,
    });
  } catch (err) {
    return okJson(res, 500, {
      ok: false,
      error: err?.message || "Server error",
    });
  }
};
