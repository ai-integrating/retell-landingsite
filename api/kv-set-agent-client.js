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

function normalizeSlug(slug = "") {
  return String(slug)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/_/g, "-");
}

function normalizeServiceKey(v = "") {
  return String(v)
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_");
}

function tryParseJson(value) {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function cleanStringMap(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const out = {};
  for (const k of Object.keys(obj)) {
    const key = normalizeServiceKey(k);
    if (!key) continue;
    const val = normalizeSlug(obj[k]);
    if (!val) continue;
    out[key] = val;
  }
  return Object.keys(out).length ? out : null;
}

function cleanIdMap(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const out = {};
  for (const k of Object.keys(obj)) {
    const key = normalizeServiceKey(k);
    if (!key) continue;

    const raw = obj[k];
    if (raw === undefined || raw === null || raw === "") continue;

    const num = Number(raw);
    if (!Number.isFinite(num)) continue;

    out[key] = num;
  }
  return Object.keys(out).length ? out : null;
}

// -------------------- CAL CONFIG --------------------
function extractCalConfig(body, existingCal = {}) {
  const calObj = tryParseJson(body?.cal) || {};

  const username = asString(
    calObj.username,
    asString(body?.username, asString(existingCal?.username, ""))
  );

  const eventTypeSlug = normalizeSlug(
    asString(
      calObj.eventTypeSlug,
      asString(body?.eventTypeSlug, asString(existingCal?.eventTypeSlug, ""))
    )
  );

  const timeZone = asString(
    calObj.timeZone,
    asString(body?.timeZone, asString(existingCal?.timeZone, ""))
  );

  const eventTypeSlugs = cleanStringMap(
    calObj.eventTypeSlugs || body?.eventTypeSlugs || existingCal?.eventTypeSlugs
  );

  const eventTypeIds = cleanIdMap(
    calObj.eventTypeIds || body?.eventTypeIds || existingCal?.eventTypeIds
  );

  const hasAny = !!(
    username ||
    eventTypeSlug ||
    eventTypeSlugs ||
    eventTypeIds ||
    timeZone
  );

  if (!hasAny) return null;

  return {
    username: username || undefined,
    eventTypeSlug: eventTypeSlug || undefined,
    eventTypeSlugs: eventTypeSlugs || undefined,
    eventTypeIds: eventTypeIds || undefined,
    timeZone: timeZone || undefined,
    updated_at: new Date().toISOString(),
  };
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

    if (!agent_id || !client_id) {
      return okJson(res, 400, {
        ok: false,
        error: "Missing agent_id or client_id",
      });
    }

    const mapKey = `agent:${agent_id}:client`;
    const calKey = `client:${client_id}:cal`;

    const existing = await kv.get(mapKey);
    const prevCal = (await kv.get(calKey)) || {};
    const calConfig = extractCalConfig(body, prevCal);

    // -------------------- EXISTING SAME --------------------
    if (existing && String(existing) === client_id) {
      if (plan) await kv.set(`plan:${agent_id}`, plan);

      let mergedCal = prevCal;
      if (calConfig) {
        mergedCal = { ...prevCal, ...calConfig };
        await kv.set(calKey, mergedCal);
      }

      // ✅ VERIFY
      const verify = await kv.get(mapKey);
      console.log("VERIFY MAP AFTER SET (existing):", verify);

      return okJson(res, 200, {
        ok: true,
        agent_id,
        client_id,
        already_set: true,
        map_key: mapKey,
        map_value: verify,
        cal_preview: mergedCal,
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

    let mergedCal = prevCal;
    if (calConfig) {
      mergedCal = { ...prevCal, ...calConfig };
      await kv.set(calKey, mergedCal);
    }

    // ✅ VERIFY
    const verify = await kv.get(mapKey);
    console.log("VERIFY MAP AFTER SET:", verify);

    return okJson(res, 200, {
      ok: true,
      agent_id,
      client_id,
      set: true,
      map_key: mapKey,
      map_value: verify,
      cal_preview: mergedCal,
    });
  } catch (err) {
    console.error("kv-set-agent-client ERROR", err);
    return okJson(res, 500, {
      ok: false,
      error: err?.message || "Server error",
    });
  }
};
