// /api/cal.js
const axios = require("axios");
const crypto = require("crypto");
const { kv } = require("@vercel/kv");

// -------------------- CORS & RESPONSES --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Idempotency-Key"
  );
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

// -------------------- QUERY PARSING --------------------
function getQuery(req) {
  const u = new URL(req.url, "http://localhost");
  const q = {};
  for (const [k, v] of u.searchParams.entries()) q[k] = v;
  return q;
}

// -------------------- HELPERS --------------------
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
    req.on("data", (chunk) => (data += chunk));
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

function asString(v, fallback = "") {
  return v === undefined || v === null ? fallback : String(v).trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(asString(email));
}

function ymd(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function tokenKeyForAgent(agentId) {
  const a = asString(agentId);
  return a ? `cal:tokens:agent:${a}` : "";
}

function tokenKeyForEmail(email) {
  const e = asString(email).toLowerCase();
  return e ? `cal:tokens:${e}` : "";
}

function normalizeServiceKey(v) {
  const s = asString(v, "").toLowerCase();
  if (!s) return "";
  return s
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .trim();
}

function dashedServiceKey(v) {
  const s = asString(v, "").toLowerCase();
  if (!s) return "";
  return s
    .replace(/[^\w\s-]/g, "")
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

function compactServiceKey(v) {
  const s = asString(v, "").toLowerCase();
  if (!s) return "";
  return s.replace(/[^\w]/g, "");
}

function serviceKeyVariants(v) {
  const raw = asString(v, "");
  if (!raw) return [];

  const variants = new Set();

  const underscored = normalizeServiceKey(raw);
  const dashed = dashedServiceKey(raw);
  const compact = compactServiceKey(raw);
  const spaced = underscored.replace(/_/g, " ");

  [raw, underscored, dashed, compact, spaced].forEach((item) => {
    const val = asString(item, "").toLowerCase();
    if (val) variants.add(val);
  });

  return Array.from(variants);
}

function isTemplateLike(value) {
  const s = asString(value);
  return !s || s.includes("{{") || s.includes("}}") || s.includes("{") || s.includes("}");
}

function extractStartTimes(raw) {
  const candidate = raw?.slots ?? raw;
  let starts = [];

  if (Array.isArray(candidate)) {
    starts = candidate
      .map((s) => (typeof s === "string" ? s : s?.start || s?.time || null))
      .filter(Boolean);
  } else if (candidate && typeof candidate === "object") {
    for (const k of Object.keys(candidate)) {
      const v = candidate[k];
      if (!Array.isArray(v)) continue;
      for (const item of v) {
        const st = typeof item === "string" ? item : item?.start || item?.time || null;
        if (st) starts.push(st);
      }
    }
  }

  return starts.sort();
}

function hourOfIso(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.getHours();
}

function filterByTimeWindow(starts, time_window) {
  const w = normalizeServiceKey(time_window);
  if (!w) return starts;

  return starts.filter((iso) => {
    const h = hourOfIso(iso);
    if (h === null) return false;
    if (w === "morning") return h >= 8 && h < 12;
    if (w === "afternoon") return h >= 12 && h < 16;
    if (w === "evening") return h >= 16 && h < 20;
    return true;
  });
}

// -------------------- CLIENT CAL CONFIG (KV) --------------------
async function getClientCalConfig(agent_id) {
  const aid = asString(agent_id, "");
  if (!aid) return null;

  const client_id = await kv.get(`agent:${aid}:client`);
  if (!client_id) return null;

  const calKey = `client:${client_id}:cal`;
  let cfg = null;

  try {
    cfg = await kv.get(calKey);
  } catch (err) {
    if (String(err?.message || "").includes("WRONGTYPE")) {
      try {
        cfg = await kv.json.get(calKey);
      } catch {
        return { client_id: String(client_id) };
      }
    } else {
      throw err;
    }
  }

  if (typeof cfg === "string") {
    try {
      cfg = JSON.parse(cfg);
    } catch {
      return { client_id: String(client_id) };
    }
  }

  if (!cfg || typeof cfg !== "object") return { client_id: String(client_id) };
  return { client_id: String(client_id), ...cfg };
}

function findMappedSlugFromService(map, rawServiceKey) {
  if (!map || typeof map !== "object") return "";

  const normalizedMap = {};

  for (const originalKey of Object.keys(map)) {
    const slug = asString(map[originalKey], "");
    if (!slug) continue;

    for (const variant of serviceKeyVariants(originalKey)) {
      normalizedMap[variant] = slug;
    }
  }

  for (const variant of serviceKeyVariants(rawServiceKey)) {
    if (normalizedMap[variant]) return normalizedMap[variant];
  }

  return "";
}

async function resolveCalContext({ agent_id, body }) {
  const clientCfg = await getClientCalConfig(agent_id);

  const username = asString(
    body?.username,
    asString(clientCfg?.username, process.env.CAL_USERNAME)
  );

  const rawServiceKey =
    body?.service_key ||
    body?.service ||
    body?.serviceKey ||
    body?.appointment_type ||
    body?.appointmentType ||
    body?.service_type ||
    body?.serviceType ||
    "";

  const service_key = normalizeServiceKey(rawServiceKey);

  const map =
    clientCfg?.eventTypeSlugs && typeof clientCfg.eventTypeSlugs === "object"
      ? clientCfg.eventTypeSlugs
      : null;

  const mappedSlug = findMappedSlugFromService(map, rawServiceKey);

  const eventTypeSlug = asString(
    body?.eventTypeSlug,
    asString(
      mappedSlug,
      asString(clientCfg?.eventTypeSlug, process.env.CAL_EVENT_SLUG || "")
    )
  );

  const timeZone = asString(
    body?.timeZone,
    asString(clientCfg?.timeZone, process.env.CAL_TIMEZONE || "America/New_York")
  );

  return {
    client_id: clientCfg?.client_id,
    username,
    eventTypeSlug,
    timeZone,
    service_key: service_key || undefined,
    used_mapped_slug: !!mappedSlug,
    service_key_variants: serviceKeyVariants(rawServiceKey),
  };
}

// -------------------- OAuth TOKEN STORAGE + REFRESH --------------------
async function handleRefresh({ agent_id, email }) {
  const agentKey = tokenKeyForAgent(agent_id);
  const emailKey = tokenKeyForEmail(email);
  const record =
    (agentKey ? await kv.get(agentKey) : null) ||
    (emailKey ? await kv.get(emailKey) : null);

  if (!record?.refresh_token) return null;

  const resp = await axios.post("https://api.cal.com/v2/auth/oauth2/token", {
    client_id: process.env.CAL_CLIENT_ID,
    client_secret: process.env.CAL_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: record.refresh_token,
  });

  const data = resp.data || {};
  const updated = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || record.refresh_token,
    token_type: data.token_type || record.token_type || "bearer",
    expires_at: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : 0,
  };

  if (agentKey) await kv.set(agentKey, updated);
  else if (emailKey) await kv.set(emailKey, updated);

  return updated;
}

async function getHeaders({ agent_id, email }) {
  const base = { "cal-api-version": "2024-09-04" };
  const fallback = { ...base, Authorization: `Bearer ${process.env.CAL_API_KEY}` };

  const agentKey = tokenKeyForAgent(agent_id);
  const emailKey = tokenKeyForEmail(email);
  const tokens =
    (agentKey ? await kv.get(agentKey) : null) ||
    (emailKey ? await kv.get(emailKey) : null);

  if (!tokens?.access_token) return fallback;

  const stillValid = !tokens.expires_at || tokens.expires_at > Date.now() + 60_000;
  if (stillValid) return { ...base, Authorization: `Bearer ${tokens.access_token}` };

  const refreshed = await handleRefresh({ agent_id, email });
  if (refreshed?.access_token) {
    return { ...base, Authorization: `Bearer ${refreshed.access_token}` };
  }

  return fallback;
}

// -------------------- OAUTH HANDLERS --------------------
async function handleOAuthStart(req, res) {
  const agent_id = asString(req.query.agent_id);
  const email = asString(req.query.email);

  if (!agent_id) return json(res, 400, { error: "agent_id param required" });

  const nonce = crypto.randomBytes(16).toString("hex");
  await kv.set(`cal:oauth:state:${nonce}`, { agent_id, email: email || "" }, { ex: 600 });

  const authUrl =
    `https://app.cal.com/auth/oauth2/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(process.env.CAL_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(process.env.CAL_OAUTH_REDIRECT_URI)}` +
    `&state=${encodeURIComponent(nonce)}`;

  res.writeHead(302, { Location: authUrl });
  res.end();
}

async function handleOAuthCallback(req, res) {
  const { code, state, error } = req.query || {};
  if (error) return json(res, 500, { error });

  const stateRecord = await kv.get(`cal:oauth:state:${asString(state)}`);
  if (!stateRecord?.agent_id) return json(res, 400, { error: "Invalid state" });

  try {
    const tokenResp = await axios.post("https://api.cal.com/v2/auth/oauth2/token", {
      client_id: process.env.CAL_CLIENT_ID,
      client_secret: process.env.CAL_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: asString(code),
      redirect_uri: process.env.CAL_OAUTH_REDIRECT_URI,
    });

    const data = tokenResp.data || {};
    const tokenPayload = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || "",
      token_type: data.token_type || "bearer",
      expires_at: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : 0,
    };

    await kv.set(tokenKeyForAgent(stateRecord.agent_id), tokenPayload);
    res.writeHead(302, { Location: "https://app.cal.com/event-types" });
    res.end();
  } catch (err) {
    return json(res, 500, { error: "OAuth Failed", detail: err.message });
  }
}

// -------------------- CAL ACTIONS --------------------
async function handleAvailability(req, res, body) {
  const agent_id = asString(req.query.agent_id || body.agent_id);

  if (isTemplateLike(agent_id)) {
    return json(res, 400, { error: "Invalid agent_id" });
  }

  const ctx = await resolveCalContext({ agent_id, body });

  if (!ctx.eventTypeSlug) {
    return json(res, 400, {
      error: "Missing eventTypeSlug",
      agent_id,
      debug: {
        client_id: ctx?.client_id || null,
        username: ctx?.username || null,
        bodyEventTypeSlug: body?.eventTypeSlug || null,
        rawServiceKey:
          body?.service_key ||
          body?.service ||
          body?.serviceKey ||
          body?.appointment_type ||
          body?.appointmentType ||
          null,
        normalizedServiceKey: ctx?.service_key || null,
        serviceKeyVariants: ctx?.service_key_variants || [],
        envSlug: process.env.CAL_EVENT_SLUG || null,
      },
    });
  }

  const headers = await getHeaders({ agent_id, email: body.email });
  const start = asString(body.start_date, ymd(Date.now()));
  const end = asString(body.end_date, ymd(Date.now() + 7 * 24 * 60 * 60 * 1000));

  const url =
    `https://api.cal.com/v2/slots?username=${encodeURIComponent(ctx.username)}` +
    `&eventTypeSlug=${encodeURIComponent(ctx.eventTypeSlug)}` +
    `&start=${encodeURIComponent(start)}` +
    `&end=${encodeURIComponent(end)}`;

  const resp = await axios.get(url, { headers });
  let starts = extractStartTimes(resp.data?.data || resp.data);

  const time_window = asString(body.time_window || body.timeWindow, "");
  if (time_window) {
    const filtered = filterByTimeWindow(starts, time_window);
    if (filtered.length) starts = filtered;
  }

  return json(res, 200, {
    ok: true,
    available_slots: starts,
    count: starts.length,
    eventTypeSlug: ctx.eventTypeSlug,
    service_key: ctx.service_key || null,
    timeZone: ctx.timeZone || "America/New_York",
  });
}

async function handleBook(req, res, body) {
  const mergedBody = {
    ...body,
    ...(body?.args && typeof body.args === "object" ? body.args : {}),
  };

  const agent_id = asString(req.query.agent_id || mergedBody.agent_id);

  if (isTemplateLike(agent_id)) {
    return json(res, 400, {
      error: "Invalid agent_id",
      received_agent_id: agent_id || null,
    });
  }

  const ctx = await resolveCalContext({ agent_id, body: mergedBody });

  if (!ctx.eventTypeSlug) {
    return json(res, 400, {
      error: "Missing eventTypeSlug",
      agent_id,
      debug: {
        client_id: ctx?.client_id || null,
        username: ctx?.username || null,
        service_key:
          mergedBody?.service_key ||
          mergedBody?.service ||
          mergedBody?.serviceKey ||
          mergedBody?.appointment_type ||
          mergedBody?.appointmentType ||
          mergedBody?.service_type ||
          mergedBody?.serviceType ||
          null,
        normalizedServiceKey: ctx?.service_key || null,
        serviceKeyVariants: ctx?.service_key_variants || [],
        bodyEventTypeSlug: mergedBody?.eventTypeSlug || null,
        envSlug: process.env.CAL_EVENT_SLUG || null,
      },
    });
  }

  const start = asString(
    mergedBody.start ||
      mergedBody.selected_start ||
      mergedBody.slot ||
      mergedBody.start_time ||
      mergedBody.startTime
  );

  const name = asString(
    mergedBody.attendee_name ||
      mergedBody.name ||
      mergedBody.customer_name ||
      mergedBody.full_name
  );

  const email = asString(
    mergedBody.attendee_email ||
      mergedBody.email ||
      mergedBody.customer_email
  );

  const phone = asString(
    mergedBody.phone ||
      mergedBody.phone_number ||
      mergedBody.customer_phone
  );

  if (!start || !name || !email) {
    return json(res, 400, {
      error: "Missing booking details",
      debug: {
        hasStart: !!start,
        hasName: !!name,
        hasEmail: !!email,
        received: {
          start:
            mergedBody.start ||
            mergedBody.selected_start ||
            mergedBody.slot ||
            mergedBody.start_time ||
            mergedBody.startTime ||
            null,
          name:
            mergedBody.attendee_name ||
            mergedBody.name ||
            mergedBody.customer_name ||
            mergedBody.full_name ||
            null,
          email:
            mergedBody.attendee_email ||
            mergedBody.email ||
            mergedBody.customer_email ||
            null,
          phone:
            mergedBody.phone ||
            mergedBody.phone_number ||
            mergedBody.customer_phone ||
            null,
        },
      },
    });
  }

  if (!isValidEmail(email)) {
    return json(res, 400, {
      error: "Invalid email",
      attendee_email: email,
    });
  }

  const headers = await getHeaders({ agent_id, email });

  const payload = {
    username: ctx.username,
    eventTypeSlug: ctx.eventTypeSlug,
    start,
    attendee: {
      name,
      email,
      phoneNumber: phone || undefined,
    },
  };

  try {
    const resp = await axios.post("https://api.cal.com/v2/bookings", payload, { headers });

    return json(res, 200, {
      ok: true,
      booking: resp.data?.data || resp.data,
      eventTypeSlug: ctx.eventTypeSlug,
      service_key: ctx.service_key || null,
    });
  } catch (err) {
    return json(res, err?.response?.status || 500, {
      error: "Booking failed",
      message: err?.response?.data || err?.message || "Unknown booking error",
      debug: {
        agent_id,
        eventTypeSlug: ctx.eventTypeSlug,
        service_key: ctx.service_key || null,
        start,
        attendee_name: name,
        attendee_email: email,
      },
    });
  }
}

// -------------------- MAIN HANDLER --------------------
module.exports = async (req, res) => {
  req.query = req.query || getQuery(req);
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();

  const body = req.method === "POST" ? await readJsonBody(req) : {};
  const action = asString(req.query.action, asString(body.action, "")).toLowerCase();

  try {
    if (action === "oauth_start") return await handleOAuthStart(req, res);
    if (action === "oauth_callback") return await handleOAuthCallback(req, res);
    if (action === "availability" || action === "slots") {
      return await handleAvailability(req, res, body);
    }
    if (action === "book") return await handleBook(req, res, body);

    return json(res, 400, { error: "Unknown action" });
  } catch (err) {
    return json(res, 500, { error: "Server error", message: err.message });
  }
};
