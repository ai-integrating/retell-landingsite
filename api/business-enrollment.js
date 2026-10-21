const { timingSafeEqual } = require("node:crypto");
const { enrollment } = require("../lib/business-enrollment");
function createHandler({ kv, axios, secret, apiKey }) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
    const a = Buffer.from(typeof req.headers["x-maintenance-secret"] === "string" ? req.headers["x-maintenance-secret"] : "");
    const b = Buffer.from(secret || "");
    if (!b.length || a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ error: "UNAUTHORIZED" });
    try {
      return res.json(await enrollment({ body: req.body, kv, axios, base: "https://api.retellai.com",
        headers: { Authorization: `Bearer ${apiKey}` } }));
    } catch (error) {
      return res.status([400, 403, 409, 423].includes(error.status) ? error.status : 503)
        .json({ error: /^[A-Z_]+$/.test(error.code || "") ? error.code : "ENROLLMENT_UNAVAILABLE" });
    }
  };
}
module.exports = (req, res) => createHandler({ kv: require("@vercel/kv").kv, axios: require("axios"),
  secret: process.env.REFINEMENT_MAINTENANCE_SECRET, apiKey: process.env.RETELL_API_KEY })(req, res);
module.exports.createHandler = createHandler;
