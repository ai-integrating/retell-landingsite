// /api/kv-set-agent-client.js
const { kv } = require("@vercel/kv");

// -------------------- CORS --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
    req.on("data", (c) => (data += c));
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

function okJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

// -------------------- HELPERS --------------------
function asString(v, fallback = "") {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  return s ? s : fallback;
}

// -------------------- AUTH --------------------
function isAdmin(body) {
  const secret = process.env.KV_ADMIN_SECRET;
  if (!secret) return false;
  return asString(body?.admin_secret) === asString(secret);
}

// -------------------- HANDLER --------------------
module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    return res.end("ok");
  }

  if (req.method !== "POST") {
    return okJson(res, 405, { ok: false, error: "Use POST" });
  }

  try {
    const body = await readJsonBody(req);

    if (!isAdmin(body)) {
      return okJson(res, 401, { ok: false, error: "Unauthorized" });
    }

    const agent_id = asString(body?.agent_id);
    const client_id = asString(body?.client_id);
    const plan = asString(body?.plan);
    const sheet_id = asString(body?.sheet_id);
    const phone = asString(body?.phone); // ✅ ADDED

    if (!agent_id || !client_id) {
      return okJson(res, 400, {
        ok: false,
        error: "Missing agent_id or client_id",
      });
    }

    const mapKey = `agent:${agent_id}:client`;
    const sheetKey = `client:${client_id}:sheet`;
    const phoneKey = `agent:${agent_id}:phone`; // ✅ ADDED

    const existing = await kv.get(mapKey);

    // -------------------- EXISTING SAME --------------------
    if (existing && String(existing) === client_id) {
      if (plan) await kv.set(`plan:${agent_id}`, plan);

      if (sheet_id) {
        await kv.set(sheetKey, sheet_id);
      }

      if (phone) {
        await kv.set(phoneKey, phone); // ✅ ADDED
      }

      return okJson(res, 200, {
        ok: true,
        agent_id,
        client_id,
        already_set: true,
      });
    }

    // -------------------- EXISTING DIFFERENT --------------------
    if (existing && String(existing) !== client_id) {
      return okJson(res, 409, {
        ok: false,
        error: "agent_already_mapped_to_different_client",
      });
    }

    // -------------------- NEW SET --------------------
    await kv.set(mapKey, client_id);

    if (plan) await kv.set(`plan:${agent_id}`, plan);

    if (sheet_id) {
      await kv.set(sheetKey, sheet_id);
    }

    if (phone) {
      await kv.set(phoneKey, phone); // ✅ ADDED
    }

    return okJson(res, 200, {
      ok: true,
      agent_id,
      client_id,
      set: true,
    });

  } catch (err) {
    console.error("kv-set-agent-client ERROR", err);
    return okJson(res, 500, {
      ok: false,
      error: err?.message || "Server error",
    });
  }
};
