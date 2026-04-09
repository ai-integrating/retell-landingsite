// /api/daily-summary.js
const { kv } = require("@vercel/kv");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed. Use POST"
    });
  }

  try {
    console.log("daily-summary body:", req.body);
    console.log("daily-summary headers:", req.headers);

    const agentId =
      req.body?.agent_id ||
      req.body?.call?.agent_id ||
      req.body?.data?.agent_id ||
      req.body?.CallAgentId ||
      req.headers?.agentid ||
      null;

    if (!agentId) {
      return res.status(400).json({
        error: "Missing agent_id"
      });
    }

    const clientId = await kv.get(`agent:${agentId}:client`);
    const sheetId = clientId
      ? await kv.get(`client:${clientId}:sheet`)
      : null;

    console.log("KV lookup:", { agentId, clientId, sheetId });

    const summary = clientId && sheetId
      ? `I found client ${clientId} and sheet ${sheetId}.`
      : `I couldn't find the client or sheet for this agent yet.`;

    return res.status(200).json({
      summary,
      execution_message: "Sure thing, one moment while I read my notes."
    });

  } catch (error) {
    console.error("daily-summary error:", error);

    return res.status(500).json({
      summary: "",
      error: "Failed to generate summary"
    });
  }
};
