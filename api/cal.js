const axios = require("axios");
const crypto = require("crypto");
const { kv } = require("@vercel/kv");

const CAL_API_VERSION = "2024-09-04";

// -------------------- CORS & RESPONSES --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Agent-Id, X-Cal-Username, X-Cal-Slug, X-Cal-Event-Id"
  );
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
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
      try {
        resolve(data ? JSON.parse(data) : {});
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

function getCalHeaders() {
  return {
    "Content-Type": "application/json",
    "cal-api-version": CAL_API_VERSION,
    Authorization: `Bearer ${process.env.CAL_API_KEY}`,
  };
}

function extractCalError(err) {
  return (
    err?.response?.data?.error?.message ||
    err?.response?.data?.message ||
    err?.message ||
    "Unknown Cal.com error"
  );
}

function tokenKeyForAgent(agentId) {
  const a = asString(agentId);
  return a ? `cal:tokens:agent:${a}` : "";
}

function tokenKeyForEmail(email) {
  const e = asString(email).toLowerCase();
  return e ? `cal:tokens:${e}` : "";
}

// IMPORTANT: preserve old working redirect lookup order
function getCalRedirectUri() {
  return (
    process.env.CAL_OAUTH_REDIRECT_URI ||
    process.env.CAL_REDIRECT_URI ||
    process.env.CAL_OAUTH_REDIRECT_URL ||
    ""
  );
}

// -------------------- OAUTH HANDLERS --------------------
async function handleOauthStart(req, res, url) {
  const agent_id = asString(url.searchParams.get("agent_id"));
  const email = asString(url.searchParams.get("email"));

  if (!agent_id) {
    return json(res, 400, { error: "agent_id param required" });
  }

  if (email && !isValidEmail(email)) {
    return json(res, 400, { error: "If provided, email must be valid" });
  }

  const clientId = process.env.CAL_CLIENT_ID;
  const redirectUri = getCalRedirectUri();

  if (!clientId || !redirectUri) {
    return json(res, 500, {
      error: "Missing CAL_CLIENT_ID or CAL_OAUTH_REDIRECT_URI",
      debug: {
        hasClientId: !!clientId,
        hasRedirectUri: !!redirectUri,
      },
    });
  }

  const nonce = crypto.randomBytes(16).toString("hex");

  await kv.set(
    `cal:oauth:state:${nonce}`,
    { agent_id, email: email || "" },
    { ex: 600 }
  );

  const authUrl =
    `https://app.cal.com/auth/oauth2/authorize` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(nonce)}`;

  console.log("CAL OAUTH START", {
    agent_id,
    email,
    redirectUri,
  });

  res.writeHead(302, { Location: authUrl });
  return res.end();
}

async function handleOauthCallback(req, res, url) {
  const code = asString(url.searchParams.get("code"));
  const state = asString(url.searchParams.get("state"));
  const error = asString(url.searchParams.get("error"));
  const error_description = asString(url.searchParams.get("error_description"));

  if (error) {
    const loc =
      "https://retell-landingsite-iota.vercel.app/cal-error" +
      `?error=${encodeURIComponent(error)}` +
      `&desc=${encodeURIComponent(error_description)}`;
    res.writeHead(302, { Location: loc });
    return res.end();
  }

  if (!code || !state) {
    return json(res, 400, { error: "Missing code/state" });
  }

  const stateRecord = await kv.get(`cal:oauth:state:${state}`);
  if (!stateRecord?.agent_id) {
    return json(res, 400, { error: "Invalid or expired state" });
  }

  await kv.del(`cal:oauth:state:${state}`);

  const clientId = process.env.CAL_CLIENT_ID;
  const clientSecret = process.env.CAL_CLIENT_SECRET;
  const redirectUri = getCalRedirectUri();

  if (!clientId || !clientSecret || !redirectUri) {
    return json(res, 500, {
      error: "Missing CAL_CLIENT_ID / CAL_CLIENT_SECRET / CAL_OAUTH_REDIRECT_URI",
      debug: {
        hasClientId: !!clientId,
        hasClientSecret: !!clientSecret,
        hasRedirectUri: !!redirectUri,
      },
    });
  }

  try {
    const tokenResp = await axios.post(
      "https://api.cal.com/v2/auth/oauth2/token",
      {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const data = tokenResp.data || {};
    const agent_id = asString(stateRecord.agent_id);
    const emailLower = asString(stateRecord.email).toLowerCase();

    const tokenPayload = {
      access_token: asString(data.access_token),
      refresh_token: asString(data.refresh_token),
      token_type: asString(data.token_type, "bearer"),
      expires_at: data.expires_in
        ? Date.now() + Number(data.expires_in) * 1000
        : 0,
    };

    if (!tokenPayload.access_token) {
      return json(res, 500, {
        error: "OAuth Exchange Failed",
        detail: "No access_token returned from Cal.com",
      });
    }

    await kv.set(tokenKeyForAgent(agent_id), tokenPayload);

    if (emailLower && isValidEmail(emailLower)) {
      await kv.set(tokenKeyForEmail(emailLower), tokenPayload);
    }

    console.log("CAL OAUTH CALLBACK SUCCESS", {
      agent_id,
      emailLower: emailLower || null,
      storedAgentKey: tokenKeyForAgent(agent_id),
      storedEmailKey: emailLower ? tokenKeyForEmail(emailLower) : null,
    });

    res.writeHead(302, { Location: "https://app.cal.com/event-types" });
    return res.end();
  } catch (err) {
    console.log(
      "CAL OAUTH CALLBACK ERROR",
      JSON.stringify(
        {
          responseStatus: err.response?.status,
          responseData: err.response?.data,
          message: err.message,
        },
        null,
        2
      )
    );

    return json(res, 500, {
      error: "OAuth Exchange Failed",
      detail: err.response?.data || err.message,
    });
  }
}

// -------------------- AUTO-RESOLVE CAL CONFIG FROM AGENT --------------------
async function resolveCalFromAgent(req, body) {
  const args = body.args || body || {};
  const agentId = asString(
    req.headers["x-agent-id"] || body.agent_id || body.agentId || args.agent_id,
    ""
  );

  if (!agentId) return null;

  const clientId = await kv.get(`agent:${agentId}:client`);
  if (!clientId) return { agentId, error: "no_client_mapping" };

  const cal = await kv.get(`client:${clientId}:cal`);
  if (!cal || typeof cal !== "object" || Array.isArray(cal)) {
    return { agentId, clientId: String(clientId), error: "no_cal_config" };
  }

  return {
    agentId,
    clientId: String(clientId),
    username: asString(cal.username, ""),
    eventTypeSlug: asString(cal.eventTypeSlug || cal.event_type_slug, ""),
    eventTypeSlugs: cal.eventTypeSlugs || cal.event_type_slugs || null,
    eventTypeIds: cal.eventTypeIds || cal.event_type_ids || null,
    timeZone: asString(cal.timeZone || cal.time_zone, "America/New_York"),
  };
}

// Prefer explicit slug first, then KV map by service_key, then fallback service_key->slug
function resolveEventTypeSlug(req, body, resolved) {
  const args = body.args || body || {};

  const explicitSlug =
    args.eventTypeSlug ||
    args.event_slug ||
    args.eventSlug ||
    args.slug ||
    body.eventTypeSlug ||
    body.event_slug ||
    req.headers["x-cal-slug"] ||
    "";

  if (explicitSlug) return normalizeSlug(explicitSlug);

  const serviceKey = normalizeServiceKey(
    args.service_key || args.serviceKey || args.service || ""
  );

  if (serviceKey && resolved?.eventTypeSlugs) {
    const mapped =
      resolved.eventTypeSlugs[serviceKey] ||
      resolved.eventTypeSlugs[serviceKey.replace(/-/g, "_")];

    if (mapped) return normalizeSlug(mapped);
  }

  if (serviceKey) {
    return normalizeSlug(serviceKey);
  }

  if (resolved?.eventTypeSlug) {
    return normalizeSlug(resolved.eventTypeSlug);
  }

  return "";
}

function resolveEventTypeId(body, resolved, req) {
  const args = body.args || body || {};

  const direct =
    args.eventTypeId ||
    args.event_type_id ||
    body.eventTypeId ||
    body.event_type_id ||
    req.headers["x-cal-event-id"];

  if (direct !== undefined && direct !== null && direct !== "") {
    const num = Number(direct);
    if (Number.isFinite(num)) return num;
  }

  const serviceKey = normalizeServiceKey(
    args.service_key || args.serviceKey || args.service || ""
  );

  if (
    serviceKey &&
    resolved?.eventTypeIds &&
    Object.prototype.hasOwnProperty.call(resolved.eventTypeIds, serviceKey)
  ) {
    const num = Number(resolved.eventTypeIds[serviceKey]);
    if (Number.isFinite(num)) return num;
  }

  return null;
}

// -------------------- AVAILABILITY (V2) --------------------
async function handleAvailability(req, res, body) {
  const resolved = await resolveCalFromAgent(req, body);
  const args = body.args || body || {};

  const username = asString(
    req.headers["x-cal-username"] || body.username || args.username || resolved?.username
  );

  const eventTypeSlug = resolveEventTypeSlug(req, body, resolved);

  const timeZone =
    asString(args.timeZone || args.time_zone || body.timeZone) ||
    resolved?.timeZone ||
    "America/New_York";

  if (!username || !eventTypeSlug) {
    return json(res, 400, {
      error: "Missing Client Config",
      debug: {
        agentId: resolved?.agentId || "not_found",
        username,
        eventTypeSlug,
        service_key: args.service_key || args.serviceKey || args.service || null,
        hasEventTypeSlugsMap: !!resolved?.eventTypeSlugs,
      },
    });
  }

  const start = asString(body.start_date || args.start_date, ymd(Date.now()));
  const end = asString(
    body.end_date || args.end_date,
    ymd(Date.now() + 7 * 24 * 60 * 60 * 1000)
  );

  const url = `https://api.cal.com/v2/slots?username=${encodeURIComponent(
    username
  )}&eventTypeSlug=${encodeURIComponent(eventTypeSlug)}&start=${encodeURIComponent(
    start
  )}&end=${encodeURIComponent(end)}&timeZone=${encodeURIComponent(timeZone)}`;

  try {
    const resp = await axios.get(url, { headers: getCalHeaders() });
    const starts = Object.values(resp.data?.data || {})
      .flat()
      .map((s) => s.start)
      .filter(Boolean);

    return json(res, 200, {
      ok: true,
      available_slots: starts,
      debug: { username, eventTypeSlug, timeZone },
    });
  } catch (err) {
    return json(res, 500, {
      error: "Cal fetch failed",
      message: extractCalError(err),
      debug: { username, eventTypeSlug, timeZone },
    });
  }
}

// -------------------- BOOK (V1 STABLE) --------------------
async function handleBook(req, res, body) {
  const resolved = await resolveCalFromAgent(req, body);
  const args = body.args || body || {};

  const username = asString(
    req.headers["x-cal-username"] || body.username || args.username || resolved?.username
  );

  const eventTypeSlug = resolveEventTypeSlug(req, body, resolved);
  const eventTypeId = resolveEventTypeId(body, resolved, req);

  const start = asString(args.start || args.slot || args.selected_start || args.time);
  const name = asString(
    args.attendee_name || args.name || args.customer_name || args.full_name
  );
  const email = asString(
    args.attendee_email || args.email || args.customer_email
  ).toLowerCase();
  const phone = asString(args.phone || args.phoneNumber || args.phone_number);
  const timeZone =
    asString(args.timeZone || args.time_zone) ||
    resolved?.timeZone ||
    "America/New_York";

  if (!start || !name || !email || !username || (!eventTypeSlug && !eventTypeId)) {
    return json(res, 400, {
      error: "Missing details",
      debug: {
        hasStart: !!start,
        hasName: !!name,
        hasEmail: !!email,
        username,
        eventTypeSlug,
        eventTypeId,
      },
    });
  }

  const v1Payload = {
    start,
    name,
    email,
    username,
    timeZone,
    language: "en",
    metadata: {},
    ...(phone ? { smsReminderNumber: phone } : {}),
  };

  if (eventTypeId) {
    v1Payload.eventTypeId = eventTypeId;
  } else {
    v1Payload.eventTypeSlug = eventTypeSlug;
  }

  try {
    const resp = await axios.post("https://api.cal.com/v1/bookings", v1Payload, {
      params: { apiKey: process.env.CAL_API_KEY },
    });

    return json(res, 200, {
      ok: true,
      booking: resp.data,
      debug: { username, eventTypeSlug, eventTypeId },
    });
  } catch (err) {
    const msg = extractCalError(err);

    console.error("CAL V1 BOOK ERROR:", msg, {
      username,
      eventTypeSlug,
      eventTypeId,
      start,
    });

    return json(res, 500, {
      error: "Booking failed",
      message: msg,
      debug: { username, eventTypeSlug, eventTypeId },
    });
  }
}

// -------------------- ROUTER --------------------
module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  const body = req.method === "POST" ? await readJsonBody(req) : {};
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action")?.toLowerCase();

  if (req.method === "GET" && action === "oauth_start") {
    return await handleOauthStart(req, res, url);
  }

  if (req.method === "GET" && action === "oauth_callback") {
    return await handleOauthCallback(req, res, url);
  }

  if (req.method === "POST" && action === "availability") {
    return await handleAvailability(req, res, body);
  }

  if (req.method === "POST" && action === "book") {
    return await handleBook(req, res, body);
  }

  return json(res, 400, {
    error: "Unknown action",
    received_action: action || null,
    method: req.method,
  });
};
