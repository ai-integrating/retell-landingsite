// /api/retell-create-call.js
const axios = require("axios");

function toE164US(raw) {
  if (!raw) return raw;

  const trimmed = String(raw).trim();

  // If they already typed +something, keep it
  if (trimmed.startsWith("+")) return trimmed;

  // Keep only digits
  const digits = trimmed.replace(/\D/g, "");

  // US number with country code + 10 digits
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  // Plain 10-digit US number
  if (digits.length === 10) return `+1${digits}`;

  // Fallback: best effort (adds + in front of remaining digits)
  return digits ? `+${digits}` : raw;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function readJsonBody(req) {
  // Vercel sometimes gives req.body already; sometimes it's a string; sometimes you must read the stream.
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

module.exports = async function handler(req, res) {
  setCors(res);

  // Preflight
  if (req.method === "OPTIONS") return res.status(200).end();

  // Friendly GET (so visiting the URL in a browser doesn't look "broken")
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message: "retell-create-call is live. Send a POST with JSON to create a web call.",
      expected_fields: {
        to_number: "recommended (string) - phone number in any format; will be normalized to E.164",
        business_name: "optional",
        package_type: "optional",
        retell_llm_dynamic_variables: "optional object",
        metadata: "optional object",
      },
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  try {
    const body = await readJsonBody(req);

    const RETELL_API_KEY = process.env.RETELL_API_KEY;
    const agent_id = body.agent_id || process.env.AGENT_ID;

    if (!RETELL_API_KEY) {
      return res
        .status(500)
        .json({ error: "Missing RETELL_API_KEY in Vercel environment variables." });
    }

    if (!agent_id) {
      return res.status(400).json({
        error: "Missing agent_id. Provide it in POST body or set AGENT_ID in env.",
      });
    }

    // Normalize phone if provided (you can choose to require it by uncommenting the required check below)
    const to_number_raw = body.to_number || body.phone_number || body.toNumber;
    const to_number = toE164US(to_number_raw);

    // If you want to REQUIRE phone number, uncomment this:
    // if (!to_number_raw) {
    //   return res.status(400).json({ error: "Missing to_number (phone number)." });
    // }

    // Retell endpoint (keep as you had it)
    const url = "https://api.retellai.com/v2/create-web-call";

    // Build payload
    const payload = {
      agent_id,

      // If you want Retell to prefill a phone field inside your agent (as a dynamic var), keep using dynamic vars.
      // This does NOT "call" the number; it just passes info.
      retell_llm_dynamic_variables:
        body.retell_llm_dynamic_variables || body.dynamic_variables || {},

      metadata: body.metadata || {},
    };

    // OPTIONAL: If Retell supports a direct "to_number" param for your use-case, you can pass it here.
    // Only do this if Retell's API expects it for the endpoint you're using.
    // if (to_number) payload.to_number = to_number;

    // OPTIONAL: Add your own metadata consistently
    if (to_number) payload.metadata.to_number = to_number;
    if (body.business_name) payload.metadata.business_name = body.business_name;
    if (body.package_type) payload.metadata.package_type = body.package_type;

    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${RETELL_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });

    const { access_token, call_id } = response.data || {};

    if (!access_token) {
      return res.status(500).json({
        error: "Retell did not return access_token",
        raw: response.data || null,
      });
    }

    return res.status(200).json({
      access_token,
      call_id,
      normalized_to_number: to_number || null,
    });
  } catch (error) {
    const status = error?.response?.status || 500;
    const details = error?.response?.data || error?.message || "Unknown error";

    console.error("retell-create-call error:", details);

    return res.status(status).json({
      error: "Failed to create Retell web call",
      details,
    });
  }
};
