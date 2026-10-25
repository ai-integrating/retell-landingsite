const { timingSafeEqual } = require("node:crypto");
const { maintenance } = require("../lib/refinement-maintenance");
const { verifyOwnership } = require("../lib/retell-ownership");
function createHandler({ kv, axios, secret, apiKey }) {
  return require("../lib/ownership-budget").handler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
    const supplied = req.headers["x-maintenance-secret"];
    const a = Buffer.from(typeof supplied === "string" ? supplied : "");
    const b = Buffer.from(secret || "");
    if (!b.length || a.length !== b.length || !timingSafeEqual(a, b)) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }
    const body = req.body;
    if (!body || Object.keys(body).sort().join(",") !== "action,agent_id,client_id,maintenance_id" ||
        !/^agent_[A-Za-z0-9_-]+$/.test(body.agent_id) || typeof body.client_id !== "string") {
      return res.status(400).json({ error: "INVALID_REQUEST" });
    }
    try {
      if (await kv.get(`agent:${body.agent_id}:client`) !== body.client_id) {
        return res.status(403).json({ error: "CLIENT_AGENT_MISMATCH" });
      }
      const base = "https://api.retellai.com";
      const options = { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 10000 };
      const agent = (await axios.get(`${base}/get-agent/${body.agent_id}`, options)).data;
      const llmId = agent?.response_engine?.llm_id;
      if (agent?.response_engine?.type !== "retell-llm" || typeof llmId !== "string") {
        return res.status(409).json({ error: "INVALID_AGENT_LLM" });
      }
      await verifyOwnership(axios, base, options, body.agent_id, llmId);
      return res.json(await maintenance(kv, llmId, body.action, body.maintenance_id));
    } catch (error) {
      const known = new Set(["INVALID_MAINTENANCE_REQUEST", "UNRESOLVED_WRITER",
        "WRITER_IN_FLIGHT", "MAINTENANCE_OWNER_MISMATCH"]);
      return res.status(known.has(error.code) ? error.status : 503)
        .json({ error: known.has(error.code) ? error.code : "MAINTENANCE_UNAVAILABLE" });
    }
  });
}
module.exports = (req, res) => createHandler({
  kv: require("@vercel/kv").kv, axios: require("axios"),
  secret: process.env.REFINEMENT_MAINTENANCE_SECRET, apiKey: process.env.RETELL_API_KEY,
})(req, res);
module.exports.createHandler = createHandler;
