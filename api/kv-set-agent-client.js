// /api/kv-set-agent-client.js
// Sets agent->client mapping (and optionally plan + client cal config) in Vercel KV.
// Designed to be IDEMPOTENT:
// - If mapping already matches, returns 200 ok (no conflict).
// - If mapping exists but differs, returns 409 with details.
//
// AUTH (no headers required):
// - Provide { admin_secret: "<KV_ADMIN_SECRET>" } in the JSON body.
// - KV_ADMIN_SECRET must be set in Vercel env vars (Production).

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

// Shallow-clean an object map:
// - Only keep string values
// - Trim
// - Drop empty values
function cleanStringMap(obj) {
  if (!obj || typeof obj !== "object") return null;
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

// Accept cal config in multiple shapes:
// - body.cal = { username, eventTypeSlug, eventTypeSlugs, timeZone }
// - OR flat keys: cal_username, cal_event_slug, cal_eventTypeSlug, cal_timezone
// - OR mapping at body.cal_eventTypeSlugs (object)
// - OR additional common aliases: username, calUsername, eventTypeSlug, event_slug, timeZone
function extractCalConfig(body, existingCal = {}) {
  const calObj = body?.cal && typeof body.cal === "object" ? body.cal : {};

  const username = asString(
    calObj.username,
    asString(
      body?.cal_username,
      asString(
        body?.CAL_USERNAME,
        asString(
          body?.username,
          asString(body?.calUsername, asString(existingCal?.username, ""))
        )
      )
    )
  );

  const eventTypeSlug = normalizeSlug(
    asString(
      calObj.eventTypeSlug,
      asString(
        calObj.event_slug,
        asString(
          body?.cal_eventTypeSlug,
          asString(
            body?.cal_event_slug,
            asString(
              body?.CAL_EVENT_SLUG,
              asString(
                body?.eventTypeSlug,
                asString(body?.event_slug, asString(existingCal?.eventTypeSlug, ""))
              )
            )
          )
        )
      )
    )
  );

  const timeZone = asString(
    calObj.timeZone,
    asString(
      body?.cal_timezone,
      asString(
        body?.CAL_TIMEZONE,
        asString(body?.timeZone, asString(existingCal?.timeZone, ""))
      )
    )
  );

  const eventTypeSlugsRaw =
    (calObj.eventTypeSlugs && typeof calObj.eventTypeSlugs === "object"
      ? calObj.eventTypeSlugs
      : null) ||
    (body?.cal_eventTypeSlugs && typeof body.cal_eventTypeSlugs === "object"
      ? body.cal_eventTypeSlugs
      : null) ||
    (body?.eventTypeSlugs && typeof body.eventTypeSlugs === "object"
      ? body.eventTypeSlugs
      : null) ||
    existingCal?.eventTypeSlugs ||
    null;

  const eventTypeSlugs = cleanStringMap(eventTypeSlugsRaw);

  const hasAny = !!(username || eventTypeSlug || eventTypeSlugs || timeZone);
  if (!hasAny) return null;

  return {
    username: username || undefined,
    eventTypeSlug: eventTypeSlug || undefined,
    eventTypeSlugs: eventTypeSlugs || undefined,
    timeZone: timeZone || undefined,
    updated_at: new Date().toISOString(),
  };
}

// -------------------- AUTH --------------------
function isAdmin(body) {
  const secret = process.env.KV_ADMIN_SECRET;
  if (!secret) return false;

  const provided = asString(body?.admin_secret, "");
  return provided === asString(secret, "");
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

  try {
    const body = await readJsonBody(req);

    if (!isAdmin(body)) {
      return okJson(res, 401, { ok: false, error: "Unauthorized" });
    }

    const agent_id = asString(body?.agent_id, "");
    const client_id = asString(body?.client_id, "");
    const plan = asString(body?.plan, "");

    if (!agent_id || !client_id) {
      return okJson(res, 400, { ok: false, error: "Missing agent_id or client_id" });
    }

    const mapKey = `agent:${agent_id}:client`;
    const calKey = `client:${client_id}:cal`;

    const existing = await kv.get(mapKey);
    const prevCal = (await kv.get(calKey)) || {};
    const calConfig = extractCalConfig(body, prevCal);

    // If already set to same client -> idempotent success
    if (existing && String(existing) === client_id) {
      if (plan) await kv.set(`plan:${agent_id}`, plan);

      let mergedCal = null;
      if (calConfig) {
        mergedCal = { ...prevCal, ...calConfig };
        await kv.set(calKey, mergedCal);
      }

      return okJson(res, 200, {
        ok: true,
        agent_id,
        client_id,
        already_set: true,
        plan_set: !!plan,
        cal_set: !!calConfig,
        cal_key: calConfig ? calKey : undefined,
        cal_fields: calConfig
          ? {
              username: !!mergedCal?.username,
              eventTypeSlug: !!mergedCal?.eventTypeSlug,
              eventTypeSlugs: !!mergedCal?.eventTypeSlugs,
              timeZone: !!mergedCal?.timeZone,
            }
          : undefined,
        cal_preview: calConfig
          ? {
              username: mergedCal?.username || null,
              eventTypeSlug: mergedCal?.eventTypeSlug || null,
              eventTypeSlugs: mergedCal?.eventTypeSlugs || null,
              timeZone: mergedCal?.timeZone || null,
            }
          : undefined,
      });
    }

    // If set to DIFFERENT client -> conflict
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

    let mergedCal = null;
    if (calConfig) {
      mergedCal = { ...prevCal, ...calConfig };
      await kv.set(calKey, mergedCal);
    }

    return okJson(res, 200, {
      ok: true,
      agent_id,
      client_id,
      set: true,
      plan_set: !!plan,
      cal_set: !!calConfig,
      cal_key: calConfig ? calKey : undefined,
      cal_fields: calConfig
        ? {
            username: !!mergedCal?.username,
            eventTypeSlug: !!mergedCal?.eventTypeSlug,
            eventTypeSlugs: !!mergedCal?.eventTypeSlugs,
            timeZone: !!mergedCal?.timeZone,
          }
        : undefined,
      cal_preview: calConfig
        ? {
            username: mergedCal?.username || null,
            eventTypeSlug: mergedCal?.eventTypeSlug || null,
            eventTypeSlugs: mergedCal?.eventTypeSlugs || null,
            timeZone: mergedCal?.timeZone || null,
          }
        : undefined,
    });
  } catch (err) {
    console.error("kv-set-agent-client: ERROR", err);
    return okJson(res, 500, { ok: false, error: err?.message || "Server error" });
  }
};
