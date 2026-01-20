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
    const from_phone_number_id = pick(body, [
      "from_phone_number_id",
      "fromPhoneNumberId",
      "phone_number_id",
      "phoneNumberId",
    ]);

    const metadata = pick(body, ["metadata"], {});
    const context = pick(body, ["context"], {});
    const dynamic_variables = pick(body, ["dynamic_variables", "dynamicVariables"], {});

    // Idempotency key (recommended for Zapier retries)
    const idempotency_key =
      req.headers["x-idempotency-key"] ||
      pick(body, ["idempotency_key", "idempotencyKey"], "");

    if (!process.env.RETELL_API_KEY) {
      return okJson(res, 500, { ok: false, error: "Missing RETELL_API_KEY" });
    }

    if (!agent_id) {
      return okJson(res, 400, { ok: false, error: "Missing agent_id" });
    }

    const to_number = cleanPhone(to_phone_raw);
    if (!to_number) {
      return okJson(res, 400, { ok: false, error: "Missing/invalid to_phone" });
    }

    // -------------------- RETELL OUTBOUND CALL --------------------
    // IMPORTANT:
    // - This endpoint assumes the agent already exists.
    // - Best practice is to pass a from_phone_number_id that is already bound / approved for your agent/account.
    // - If your Retell account allows agent-level default outbound number, you may omit from_phone_number_id.
    //
    // You MUST update the URL/path below to match Retell's current outbound API endpoint.
    // Keep it in one place so it's easy to change if Retell updates.
    const RETELL_BASE = "https://api.retellai.com/v2";
    const OUTBOUND_PATH = "/create-phone-call"; // <-- adjust if your Retell docs use a different path

    const payload = {
      // Required
      agent_id,
      to_number,

      // Optional: specify from number id if you want strict control
      ...(from_phone_number_id ? { from_phone_number_id } : {}),

      // Helpful for routing + summaries
      metadata: {
        ...(typeof metadata === "object" && metadata ? metadata : {}),
        // Put your own trace fields here:
        idempotency_key: idempotency_key || undefined,
        outbound: true,
      },

      // If Retell supports dynamic vars / context injection, include them.
      // These names may differ in Retell—keep them here and adjust once.
      dynamic_variables:
        typeof dynamic_variables === "object" && dynamic_variables
          ? dynamic_variables
          : {},

      // Also include a plain "context" object in case your agent prompt expects it via metadata
      context: typeof context === "object" && context ? context : {},
    };

    const headers = {
      Authorization: `Bearer ${process.env.RETELL_API_KEY}`,
      "Content-Type": "application/json",
    };

    // If Retell supports explicit idempotency headers, this is where you’d add it.
    // (Many APIs use "Idempotency-Key".)
    if (idempotency_key) {
      headers["Idempotency-Key"] = idempotency_key;
    }

    const resp = await axios.post(`${RETELL_BASE}${OUTBOUND_PATH}`, payload, {
      headers,
      timeout: 60_000,
      validateStatus: () => true, // we’ll handle non-200s ourselves
    });

    if (resp.status < 200 || resp.status >= 300) {
      return okJson(res, 502, {
        ok: false,
        error: "Retell outbound call failed",
        status: resp.status,
        data: resp.data,
      });
    }

    // Return the call object (or whatever Retell returns)
    return okJson(res, 200, {
      ok: true,
      mode: "outbound_call",
      agent_id,
      to_number,
      from_phone_number_id: from_phone_number_id || null,
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
