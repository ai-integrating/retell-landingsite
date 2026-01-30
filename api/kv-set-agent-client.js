// /api/kv-set-agent-client.js
// Purpose: Set KV mapping agent_id -> client_id (called from Zapier or provisioning code)

const { kv } = require("@vercel/kv");

function ok(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (req.body && typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

function isAuthorized(req) {
  const secret = process.env.KV_ADMIN_SECRET;
  if (!secret) return false;
  const got = req.headers["x-admin-secret"];
  return String(got || "") === String(secret);
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return ok(res, 200, { ok: true });
  if (req.method !== "POST") return ok(res, 405, { ok: false, error: "Use POST" });

  if (!isAuthorized(req)) {
    return ok(res, 401, { ok: false, error: "Unauthorized" });
  }

  const body = await readJsonBody(req);
  const agent_id = body?.agent_id;
  const client_id = body?.client_id;

  if (!agent_id || !client_id) {
    return ok(res, 400, { ok: false, error: "agent_id and client_id required" });
  }

  await kv.set(`agent:${agent_id}:client_id`, client_id);

  // Optional: keep reverse index (helps reporting)
  await kv.set(`client:${client_id}:primary_agent`, agent_id, { ex: 60 * 60 * 24 * 365 });

  return ok(res, 200, { ok: true, agent_id, client_id });
};
