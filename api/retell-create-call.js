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
      message: "Provision endpoint is live.",
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

    // --- LOOKING FOR YOUR KEY "is test mode" ---
  // --- TEST MODE (from env OR body) ---
const envTest = (process.env.IS_TEST_MODE || "").toLowerCase();
const envIsTestMode = envTest === "true" || envTest === "1" || envTest === "yes";

const bodyTest = pick(body, ["is_test_mode", "dry_run", "dryRun"], false);
const bodyIsTestMode = bodyTest === true || bodyTest === "true" || bodyTest === "1" || bodyTest === "yes";

// final flag
const isDryRun = envIsTestMode || bodyIsTestMode;

    // 1) Create agent (This is usually free/cheap, so we let it run to give you a real agent_id)
    const createAgentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        voice_id,
        response_engine,
        metadata: { business_name, ...metadata },
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
      return res.status(500).json({ error: "Retell did not return agent_id." });
    }

    // --- SAFETY CHECK: IF TEST MODE IS ACTIVE, STOP HERE ---
    if (isDryRun) {
      return res.status(200).json({
        ok: true,
        is_test_mode: true,
        message: "SUCCESS (TEST MODE): Agent created, but no phone number was purchased.",
        business_name,
        agent_id,
        agent_version: agent_version ?? 0,
        phone_number: "+15550000000",
        phone_number_pretty: "(555) 000-0000",
        inbound_agent_id: agent_id,
        dynamic_variables,
      });
    }

    // 2) Buy/provision phone number (REAL ACTION - ONLY IF NOT TEST MODE)
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
    const details = error?.response?.data || error?.message || "Unknown error";
    return res.status(500).json({ error: "Failed to provision", details });
  }
};
