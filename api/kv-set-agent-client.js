// /api/kv-set-agent-client.js
// Sets agent->client mapping (and optionally plan) in Vercel KV.
// Designed to be IDEMPOTENT:
// - If mapping already matches, returns 200 ok (no conflict).
// - If mapping exists but differs, returns 409 with details.

const { kv } = require("@vercel/kv");

// -------------------- CORS --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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

function okJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function isAdmin(req) {
  const secret = process.env.KV_ADMIN_SECRET;
  // If you didn't set env var, allow in dev
  if (!secret) return true;

  const auth = req.headers["authorization"] || "";
  // Expect: Authorization: Bearer <KV_ADMIN_SECRET>
  return auth === `Bearer ${secret}`;
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    return res.end("ok");
  }
  if (req.method !== "POST") {
    return okJson(res, 405, { ok: false, error: "Use POST" });
  }

  if (!isAdmin(req)) {
    return okJson(res, 401, { ok: false, error: "Unauthorized" });
  }

  try {
    const body = await readJsonBody(req);

    const agent_id = String(body?.agent_id || "").trim();
    const client_id = String(body?.client_id || "").trim();
    const plan = String(body?.plan || "").trim(); // optional: trial/basic/pro

    if (!agent_id || !client_id) {
      return okJson(res, 400, { ok: false, error: "Missing agent_id or client_id" });
    }

    const mapKey = `agent:${agent_id}:client`;
    const existing = await kv.get(mapKey);

    // If already set to same client -> idempotent success
    if (existing && String(existing) === client_id) {
      if (plan) await kv.set(`plan:${agent_id}`, plan);
      return okJson(res, 200, {
        ok: true,
        agent_id,
        client_id,
        already_set: true,
        plan_set: !!plan,
      });
    }

    // If set to DIFFERENT client -> conflict (this prevents cross-client abuse)
    if (existing && String(existing) !== client_id) {
      return okJson(res, 409, {
        ok: false,
        error: "agent_already_mapped_to_different_client",
        agent_id,
        attempted_client_id: client_id,
        existing_client_id: String(existing),
      });
    }

    // Otherwise set mapping
    await kv.set(mapKey, client_id);

    if (plan) await kv.set(`plan:${agent_id}`, plan);

    return okJson(res, 200, {
      ok: true,
      agent_id,
      client_id,
      set: true,
      plan_set: !!plan,
    });
  } catch (err) {
    console.error("kv-set-agent-client: ERROR", err);
    return okJson(res, 500, { ok: false, error: err?.message || "Server error" });
  }
};
