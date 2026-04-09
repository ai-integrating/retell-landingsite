// /api/daily-summary.js

module.exports = async function handler(req, res) {
  try {
    const agentId =
      req.body?.agent_id ||
      req.body?.call?.agent_id ||
      req.body?.CallAgentId;

    if (!agentId) {
      return res.status(400).json({
        error: "Missing agent_id",
      });
    }

    // TEMP summary (we’ll replace this with real data next)
    const summary =
      "Today you had 5 calls, 2 urgent matters, and 1 callback needed.";

    return res.status(200).json({
      summary,
      execution_message:
        "Sure thing, one moment while I read my notes.",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      summary: "",
      error: "Failed to generate summary",
    });
  }
};
