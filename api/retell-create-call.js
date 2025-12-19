// /api/retell-create-call.js
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

// Helper: safe JSON
function pick(obj, keys, fallback = undefined) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return fallback;
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message:
        "Provision endpoint is live. POST JSON to create a new Retell agent + phone number bound for inbound calls.",
      expects: {
        business_name: "string (recommended)",
        area_code: "string (optional) e.g. '617'",
        voice_id: "string (optional; can be set in env)",
        response_engine: "object (optional; can be set in env)",
        dynamic_variables: "object (optional)",
        metadata: "object (optional)",
      },
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  try {
    const body = await readJsonBody(req);

    const RETELL_API_KEY = process.env.RETELL_API_KEY;
    if (!RETELL_API_KEY) {
      return res.status(500).json({
        error: "Missing RETELL_API_KEY in Vercel environment variables.",
      });
    }

    const business_name = pick(body, ["business_name", "businessName"], "New Client");

    // Required for create-agent: voice_id + response_engine
    const voice_id = pick(body, ["voice_id", "voiceId"], null) || process.env.DEFAULT_VOICE_ID;

    const response_engine_from_body = pick(body, ["response_engine", "responseEngine"], null);

    let response_engine_from_env = null;
    if (process.env.DEFAULT_RESPONSE_ENGINE_JSON) {
      try {
        response_engine_from_env = JSON.parse(process.env.DEFAULT_RESPONSE_ENGINE_JSON);
      } catch (e) {
        return res.status(500).json({
          error: "DEFAULT_RESPONSE_ENGINE_JSON is not valid JSON in Vercel env vars.",
        });
      }
    }

    const response_engine = response_engine_from_body || response_engine_from_env;

    if (!voice_id || !response_engine) {
      return res.status(400).json({
        error:
          "Missing voice_id or response_engine. Provide in POST body OR set DEFAULT_VOICE_ID and DEFAULT_RESPONSE_ENGINE_JSON env vars.",
        hint:
          'DEFAULT_RESPONSE_ENGINE_JSON example: {"type":"retell-llm","llm_id":"...","version":0}',
      });
    }

    const area_code = pick(
      body,
      ["area_code", "areaCode"],
      process.env.DEFAULT_AREA_CODE || null
    );

    const dynamic_variables =
      pick(body, ["retell_llm_dynamic_variables", "dynamic_variables", "dynamicVariables"], {}) ||
      {};

    const metadata = pick(body, ["metadata"], {}) || {};

    // 1) Create agent
    const createAgentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        voice_id,
        response_engine,
        metadata: {
          business_name,
          ...metadata,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${RETELL_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    const agent_id = createAgentResp.data?.agent_id;
    const agent_version = createAgentResp.data?.version;

    if (!agent_id) {
      return res.status(500).json({
        error: "Retell did not return agent_id from create-agent.",
        raw: createAgentResp.data || null,
      });
    }

    // 2) Buy/provision phone number bound to inbound agent
    const createNumberBody = {
      inbound_agent_id: agent_id,
      inbound_agent_version: agent_version ?? 0,
      ...(area_code ? { area_code: Number(area_code) } : {}),
      nickname: `${business_name} Receptionist`,
    };

    const createNumberResp = await axios.post(
      "https://api.retellai.com/create-phone-number",
      createNumberBody,
      {
        headers: {
          Authorization: `Bearer ${RETELL_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    const phone_number = createNumberResp.data?.phone_number;
    const phone_number_pretty = createNumberResp.data?.phone_number_pretty;

    if (!phone_number) {
      return res.status(500).json({
        error: "Retell did not return phone_number from create-phone-number.",
        raw: createNumberResp.data || null,
      });
    }

    return res.status(200).json({
      ok: true,
      business_name,
      agent_id,
      agent_version: agent_version ?? 0,
      phone_number,
      phone_number_pretty: phone_number_pretty || phone_number,
      inbound_agent_id: agent_id,
      dynamic_variables,
    });
  } catch (error) {
    const status = error?.response?.status || 500;
    const details = error?.response?.data || error?.message || "Unknown error";
    console.error("provision-receptionist error:", details);
    return res.status(status).json({
      error: "Failed to provision receptionist line",
      details,
    });
  }
};
