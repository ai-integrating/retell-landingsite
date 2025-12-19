// /api/retell-create-call.js
const axios = require("axios");

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function readJsonBody(req) {
  // Vercel sometimes gives req.body already; sometimes it's a string; sometimes you must read the stream.
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

module.exports = async function handler(req, res) {
  setCors(res);

  // Preflight
  if (req.method === "OPTIONS") return res.status(200).end();

  // Friendly GET (so visiting the URL in a browser doesn't look "broken")
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message: "retell-create-call is live. Send a POST with JSON to create a call.",
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
      return res.status(500).json({ error: "Missing RETELL_API_KEY in Vercel environment variables." });
    }
    if (!agent_id) {
      return res.status(400).json({ error: "Missing agent_id. Provide it in POST body or set AGENT_ID in env." });
    }

    // If your Retell endpoint differs, change this URL to match Retell’s docs/account.
    const url = "https://api.retellai.com/v2/create-web-call";

    const payload = {
      agent_id,
      // Optional: pass dynamic variables for the agent prompt
      retell_llm_dynamic_variables: body.retell_llm_dynamic_variables || body.dynamic_variables || {},
      // Optional: metadata
      metadata: body.metadata || {},
    };

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

    return res.status(200).json({ access_token, call_id });
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
