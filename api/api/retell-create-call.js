/api/retell-create-call.js
const axios = require("axios");

module.exports = async function handler(req, res) {
  // Basic CORS (so browser + Zapier can call it)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  try {
    const RETELL_API_KEY = process.env.RETELL_API_KEY;

    // Either use env AGENT_ID (demo mode) OR allow request to provide it (per-client mode)
    const agent_id = req.body?.agent_id || process.env.AGENT_ID;

    if (!RETELL_API_KEY) {
      return res.status(500).json({ error: "Missing RETELL_API_KEY in Vercel env vars." });
    }
    if (!agent_id) {
      return res.status(400).json({ error: "Missing agent_id (send in body or set AGENT_ID env var)." });
    }

    // Retell create web call endpoint (your server.js used v2/create-web-call)
    const url = "https://api.retellai.com/v2/create-web-call";

    const retellResp = await axios.post(
      url,
      { agent_id },
      {
        headers: {
          Authorization: `Bearer ${RETELL_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Return only what the front-end needs
    return res.status(200).json({
      access_token: retellResp.data.access_token,
      call_id: retellResp.data.call_id,
      agent_id,
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    const details = err?.response?.data || err?.message || "Unknown error";

    return res.status(status).json({
      error: "Failed to create Retell web call",
      details,
    });
  }
};

