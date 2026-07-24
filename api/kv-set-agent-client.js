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

    req.on("data", (chunk) => {
      data += chunk;
    });

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
function asString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;

  const result = String(value).trim();

  return result || fallback;
}

// -------------------- AUTH --------------------
function isAdmin(body) {
  const secret = process.env.KV_ADMIN_SECRET;

  if (!secret) return false;

  return asString(body?.admin_secret) === asString(secret);
}

// -------------------- SAVE OPTIONAL VALUES --------------------
async function saveOptionalClientValues({
  agentId,
  clientId,
  plan,
  sheetId,
  phone,
  enrollmentLink,
}) {
  const sheetKey = `client:${clientId}:sheet`;
  const phoneKey = `agent:${agentId}:phone`;
  const enrollmentKey = `client:${clientId}:enrollment_link`;

  if (plan) {
    await kv.set(`plan:${agentId}`, plan);
  }

  if (sheetId) {
    await kv.set(sheetKey, sheetId);
  }

  if (phone) {
    await kv.set(phoneKey, phone);
  }

  if (enrollmentLink) {
    await kv.set(enrollmentKey, enrollmentLink);
  }
}

// -------------------- HANDLER --------------------
module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    return res.end("ok");
  }

  if (req.method !== "POST") {
    return okJson(res, 405, {
      ok: false,
      error: "Use POST",
    });
  }

  try {
    const body = await readJsonBody(req);

    if (!isAdmin(body)) {
      return okJson(res, 401, {
        ok: false,
        error: "Unauthorized",
      });
    }

    const agentId = asString(body?.agent_id);
    const clientId = asString(body?.client_id);
    const plan = asString(body?.plan);
    const sheetId = asString(body?.sheet_id);
    const phone = asString(body?.phone);
    const enrollmentLink = asString(body?.enrollment_link);

    if (!agentId || !clientId) {
      return okJson(res, 400, {
        ok: false,
        error: "Missing agent_id or client_id",
      });
    }

    const mapKey = `agent:${agentId}:client`;
    const existing = await kv.get(mapKey);

    // -------------------- EXISTING SAME --------------------
    if (existing && String(existing) === clientId) {
      await saveOptionalClientValues({
        agentId,
        clientId,
        plan,
        sheetId,
        phone,
        enrollmentLink,
      });

      return okJson(res, 200, {
        ok: true,
        agent_id: agentId,
        client_id: clientId,
        phone_saved: Boolean(phone),
        enrollment_link_saved: Boolean(enrollmentLink),
        phone,
        enrollment_link: enrollmentLink,
        already_set: true,
      });
    }

    // -------------------- EXISTING DIFFERENT --------------------
    if (existing && String(existing) !== clientId) {
      return okJson(res, 409, {
        ok: false,
        error: "agent_already_mapped_to_different_client",
      });
    }

    // -------------------- NEW SET --------------------
    await kv.set(mapKey, clientId);

    await saveOptionalClientValues({
      agentId,
      clientId,
      plan,
      sheetId,
      phone,
      enrollmentLink,
    });

    return okJson(res, 200, {
      ok: true,
      agent_id: agentId,
      client_id: clientId,
      phone_saved: Boolean(phone),
      enrollment_link_saved: Boolean(enrollmentLink),
      phone,
      enrollment_link: enrollmentLink,
      set: true,
    });
  } catch (error) {
    console.error("kv-set-agent-client ERROR", error);

    return okJson(res, 500, {
      ok: false,
      error: error?.message || "Server error",
    });
  }
};
