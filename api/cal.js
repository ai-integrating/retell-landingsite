// /api/cal.js
const axios = require("axios");
const crypto = require("crypto");
const { kv } = require("@vercel/kv");

const CAL_API_VERSION = "2024-09-04";

// -------------------- CORS --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

function pick(obj, keys) {
  for (const key of keys) {
    const val = obj?.[key];
    if (val == null) continue;

    if (typeof val === "string") {
      const trimmed = val.trim();
      if (!trimmed) continue;

      // handle Zapier-ish { output: "..." } accidentally stringified
      if (trimmed === "null" || trimmed === "undefined") continue;
      return trimmed;
    }

    return val;
  }
  return undefined;
}

function safeJsonParse(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeServiceKey(input = "") {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

function uniqueVariants(serviceKey = "") {
  const raw = String(serviceKey || "").trim().toLowerCase();
  const underscore = raw.replace(/\s+/g, "_").replace(/-/g, "_");
  const hyphen = raw.replace(/\s+/g, "-").replace(/_/g, "-");
  const plain = raw.replace(/[\s_-]+/g, "");
  return [...new Set([raw, underscore, hyphen, plain].filter(Boolean))];
}

function formatDateOnly(dateInput) {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function getTimeWindowLabel(isoString) {
  const d = new Date(isoString);
  const hour = d.getHours();
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

function filterByTimeWindow(slots = [], timeWindow) {
  if (!timeWindow) return slots;

  const wanted = String(timeWindow).toLowerCase().trim();
  return slots.filter((slot) => getTimeWindowLabel(slot.start) === wanted);
}

function flattenSlotsResponse(data) {
  // Supports common Cal slots shapes
  if (!data) return [];

  // shape: { data: { slots: { "2026-03-25": [ ... ] } } }
  const slotsObj = data?.data?.slots || data?.slots || null;
  if (!slotsObj || typeof slotsObj !== "object") return [];

  const out = [];
  for (const day of Object.keys(slotsObj)) {
    const arr = Array.isArray(slotsObj[day]) ? slotsObj[day] : [];
    for (const slot of arr) {
      if (slot?.start) {
        out.push({
          start: slot.start,
          end: slot.end || null,
        });
      }
    }
  }

  out.sort((a, b) => new Date(a.start) - new Date(b.start));
  return out;
}

function buildHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "cal-api-version": CAL_API_VERSION,
    "Content-Type": "application/json",
  };
}

// -------------------- KV LOOKUP --------------------
async function getClientIdForAgent(agentId) {
  if (!agentId) return null;

  const direct = await kv.get(`agent:${agentId}:client`);
  if (direct) return direct;

  const legacy = await kv.get(`agent:${agentId}:client_id`);
  if (legacy) return legacy;

  return null;
}

async function getCalConfig({ agentId, clientId }) {
  let resolvedClientId = clientId || (await getClientIdForAgent(agentId));
  let config = null;

  if (resolvedClientId) {
    config = await kv.get(`client:${resolvedClientId}:cal`);
    config = safeJsonParse(config, config);
  }

  // fallback legacy key
  if (!config && agentId) {
    const legacy = await kv.get(`agent:${agentId}:cal`);
    config = safeJsonParse(legacy, legacy);
  }

  return {
    clientId: resolvedClientId || null,
    config: config || null,
  };
}

async function getStoredToken({ agentId, clientId, email }) {
  if (agentId) {
    const t = await kv.get(`cal:tokens:agent:${agentId}`);
    if (t) return t;
  }

  if (clientId) {
    const t = await kv.get(`cal:tokens:client:${clientId}`);
    if (t) return t;
  }

  if (email) {
    const t = await kv.get(`cal:tokens:${String(email).toLowerCase()}`);
    if (t) return t;
  }

  return null;
}

async function storeToken({ agentId, clientId, email, tokenData }) {
  if (agentId) {
    await kv.set(`cal:tokens:agent:${agentId}`, tokenData);
  }

  if (clientId) {
    await kv.set(`cal:tokens:client:${clientId}`, tokenData);
  }

  if (email) {
    await kv.set(`cal:tokens:${String(email).toLowerCase()}`, tokenData);
  }
}

function resolveEventTypeSlug(calConfig, serviceKey, explicitSlug) {
  if (explicitSlug) return explicitSlug;

  const map = safeJsonParse(calConfig?.eventTypeSlugs, calConfig?.eventTypeSlugs) || {};
  const fallbackSingle = calConfig?.eventTypeSlug || calConfig?.cal_eventTypeSlug || null;

  if (!serviceKey) return fallbackSingle;

  const variants = uniqueVariants(serviceKey);
  for (const variant of variants) {
    if (map[variant]) return map[variant];
  }

  return fallbackSingle;
}

function resolveUsername(calConfig, explicitUsername) {
  return (
    explicitUsername ||
    calConfig?.username ||
    calConfig?.cal_username ||
    null
  );
}

function resolveTimezone(calConfig, explicitTimezone) {
  return (
    explicitTimezone ||
    calConfig?.timeZone ||
    calConfig?.timezone ||
    calConfig?.cal_timezone ||
    "America/New_York"
  );
}

// -------------------- OAUTH --------------------
function makeState(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function parseState(state) {
  try {
    return JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

async function exchangeCodeForToken(code) {
  const tokenUrl = "https://api.cal.com/v2/oauth-clients/access-token";

  const body = {
    clientId: process.env.CAL_CLIENT_ID,
    clientSecret: process.env.CAL_CLIENT_SECRET,
    code,
    redirectUri: process.env.CAL_REDIRECT_URI,
    grantType: "authorization_code",
  };

  const response = await axios.post(tokenUrl, body, {
    headers: {
      "Content-Type": "application/json",
      "cal-api-version": CAL_API_VERSION,
    },
  });

  return response.data?.data || response.data;
}

// -------------------- CAL API --------------------
async function getSlots({
  token,
  username,
  eventTypeSlug,
  startDate,
  endDate,
  timeZone,
}) {
  const url = "https://api.cal.com/v2/slots";

  const response = await axios.get(url, {
    headers: buildHeaders(token),
    params: {
      username,
      eventTypeSlug,
      start: startDate,
      end: endDate,
      timeZone,
    },
  });

  return response.data;
}

async function createBooking({
  token,
  start,
  attendeeName,
  attendeeEmail,
  attendeePhone,
  timeZone,
  eventTypeSlug,
}) {
  const url = "https://api.cal.com/v2/bookings";

  const body = {
    start,
    eventTypeSlug,
    attendee: {
      name: attendeeName,
      email: attendeeEmail,
      timeZone,
      phoneNumber: attendeePhone || undefined,
    },
  };

  const response = await axios.post(url, body, {
    headers: buildHeaders(token),
  });

  return response.data;
}

// -------------------- HANDLER --------------------
module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    const query = req.query || {};
    const body = req.method === "POST" ? await readJsonBody(req) : {};

    const action = pick(query, ["action"]) || pick(body, ["action"]) || "";
    const agentId =
      pick(query, ["agent_id"]) ||
      pick(body, ["agent_id"]) ||
      req.headers["x-agent-id"] ||
      null;

    const clientId =
      pick(query, ["client_id"]) ||
      pick(body, ["client_id"]) ||
      null;

    const email =
      pick(query, ["email"]) ||
      pick(body, ["email"]) ||
      null;

    // -------- OAUTH START --------
    if (action === "oauth_start") {
      if (!process.env.CAL_CLIENT_ID || !process.env.CAL_REDIRECT_URI) {
        return json(res, 500, {
          ok: false,
          error: "Missing CAL_CLIENT_ID or CAL_REDIRECT_URI env vars",
        });
      }

      const state = makeState({
        agentId,
        clientId,
        email,
        nonce: crypto.randomBytes(8).toString("hex"),
      });

      const authUrl =
        `https://app.cal.com/oauth/authorize?` +
        new URLSearchParams({
          client_id: process.env.CAL_CLIENT_ID,
          response_type: "code",
          redirect_uri: process.env.CAL_REDIRECT_URI,
          state,
        }).toString();

      return json(res, 200, {
        ok: true,
        auth_url: authUrl,
      });
    }

    // -------- OAUTH CALLBACK --------
    if (action === "oauth_callback") {
      const code = pick(query, ["code"]);
      const state = pick(query, ["state"]);

      if (!code) {
        return json(res, 400, { ok: false, error: "Missing code" });
      }

      const parsedState = parseState(state || "");
      const stateAgentId = parsedState?.agentId || null;
      const stateClientId = parsedState?.clientId || null;
      const stateEmail = parsedState?.email || null;

      const tokenData = await exchangeCodeForToken(code);

      await storeToken({
        agentId: stateAgentId,
        clientId: stateClientId,
        email: stateEmail,
        tokenData,
      });

      res.statusCode = 302;
      res.setHeader("Location", "https://app.cal.com/event-types");
      return res.end();
    }

    // -------- LOAD CONFIG + TOKEN FOR API ACTIONS --------
    const { clientId: resolvedClientId, config: calConfig } = await getCalConfig({
      agentId,
      clientId,
    });

    const tokenData = await getStoredToken({
      agentId,
      clientId: resolvedClientId,
      email,
    });

    const accessToken =
      tokenData?.accessToken ||
      tokenData?.access_token ||
      null;

    if (
      ["availability", "slots", "book", "auto", "autobook"].includes(action) &&
      !accessToken
    ) {
      return json(res, 400, {
        ok: false,
        error: "No Cal access token found for this agent/client",
        agent_id: agentId,
        client_id: resolvedClientId,
      });
    }

    // -------- AVAILABILITY / SLOTS --------
    if (action === "availability" || action === "slots") {
      const serviceKey =
        pick(body, ["service_key", "service", "appointment_type"]) ||
        pick(query, ["service_key", "service", "appointment_type"]) ||
        null;

      const explicitSlug =
        pick(body, ["eventTypeSlug", "event_type_slug", "cal_slug"]) ||
        pick(query, ["eventTypeSlug", "event_type_slug", "cal_slug"]) ||
        req.headers["x-cal-slug"] ||
        null;

      const explicitUsername =
        pick(body, ["username", "cal_username"]) ||
        pick(query, ["username", "cal_username"]) ||
        req.headers["x-cal-username"] ||
        null;

      const timeZone =
        pick(body, ["time_zone", "timezone"]) ||
        pick(query, ["time_zone", "timezone"]) ||
        resolveTimezone(calConfig);

      const startDate =
        formatDateOnly(
          pick(body, ["start_date", "date", "from"]) ||
          pick(query, ["start_date", "date", "from"]) ||
          new Date()
        ) || formatDateOnly(new Date());

      const endDate =
        formatDateOnly(
          pick(body, ["end_date", "to"]) ||
          pick(query, ["end_date", "to"]) ||
          addDays(startDate, 7)
        ) || addDays(startDate, 7);

      const timeWindow =
        pick(body, ["time_window"]) ||
        pick(query, ["time_window"]) ||
        null;

      const username = resolveUsername(calConfig, explicitUsername);
      const eventTypeSlug = resolveEventTypeSlug(
        calConfig,
        normalizeServiceKey(serviceKey),
        explicitSlug
      );

      if (!username || !eventTypeSlug) {
        return json(res, 400, {
          ok: false,
          error: "Missing cal username or eventTypeSlug",
          username,
          eventTypeSlug,
          service_key: serviceKey,
        });
      }

      const raw = await getSlots({
        token: accessToken,
        username,
        eventTypeSlug,
        startDate,
        endDate,
        timeZone,
      });

      let slots = flattenSlotsResponse(raw);
      slots = filterByTimeWindow(slots, timeWindow);

      return json(res, 200, {
        ok: true,
        agent_id: agentId,
        client_id: resolvedClientId,
        username,
        eventTypeSlug,
        service_key: serviceKey || null,
        time_zone: timeZone,
        start_date: startDate,
        end_date: endDate,
        time_window: timeWindow,
        count: slots.length,
        first_two: slots.slice(0, 2),
        options: slots,
        raw,
      });
    }

    // -------- BOOK --------
    if (action === "book") {
      const serviceKey =
        pick(body, ["service_key", "service", "appointment_type"]) ||
        pick(query, ["service_key", "service", "appointment_type"]) ||
        null;

      const explicitSlug =
        pick(body, ["eventTypeSlug", "event_type_slug", "cal_slug"]) ||
        pick(query, ["eventTypeSlug", "event_type_slug", "cal_slug"]) ||
        req.headers["x-cal-slug"] ||
        null;

      const start =
        pick(body, ["start", "slot_start", "start_time"]) ||
        pick(query, ["start", "slot_start", "start_time"]) ||
        null;

      const attendeeName =
        pick(body, ["name", "attendee_name"]) ||
        pick(query, ["name", "attendee_name"]) ||
        null;

      const attendeeEmail =
        pick(body, ["email", "attendee_email"]) ||
        pick(query, ["email", "attendee_email"]) ||
        null;

      const attendeePhone =
        pick(body, ["phone", "attendee_phone"]) ||
        pick(query, ["phone", "attendee_phone"]) ||
        null;

      const timeZone =
        pick(body, ["time_zone", "timezone"]) ||
        pick(query, ["time_zone", "timezone"]) ||
        resolveTimezone(calConfig);

      const eventTypeSlug = resolveEventTypeSlug(
        calConfig,
        normalizeServiceKey(serviceKey),
        explicitSlug
      );

      if (!start || !attendeeName || !attendeeEmail || !eventTypeSlug) {
        return json(res, 400, {
          ok: false,
          error: "Missing start, attendee name, attendee email, or eventTypeSlug",
          start,
          attendeeName,
          attendeeEmail,
          eventTypeSlug,
        });
      }

      const booking = await createBooking({
        token: accessToken,
        start,
        attendeeName,
        attendeeEmail,
        attendeePhone,
        timeZone,
        eventTypeSlug,
      });

      return json(res, 200, {
        ok: true,
        booking,
      });
    }

    // -------- AUTOBOOK EARLIEST --------
    if (action === "auto" || action === "autobook") {
      const serviceKey =
        pick(body, ["service_key", "service", "appointment_type"]) ||
        pick(query, ["service_key", "service", "appointment_type"]) ||
        null;

      const explicitSlug =
        pick(body, ["eventTypeSlug", "event_type_slug", "cal_slug"]) ||
        pick(query, ["eventTypeSlug", "event_type_slug", "cal_slug"]) ||
        req.headers["x-cal-slug"] ||
        null;

      const explicitUsername =
        pick(body, ["username", "cal_username"]) ||
        pick(query, ["username", "cal_username"]) ||
        req.headers["x-cal-username"] ||
        null;

      const attendeeName =
        pick(body, ["name", "attendee_name"]) ||
        pick(query, ["name", "attendee_name"]) ||
        null;

      const attendeeEmail =
        pick(body, ["email", "attendee_email"]) ||
        pick(query, ["email", "attendee_email"]) ||
        null;

      const attendeePhone =
        pick(body, ["phone", "attendee_phone"]) ||
        pick(query, ["phone", "attendee_phone"]) ||
        null;

      const timeZone =
        pick(body, ["time_zone", "timezone"]) ||
        pick(query, ["time_zone", "timezone"]) ||
        resolveTimezone(calConfig);

      const startDate =
        formatDateOnly(
          pick(body, ["start_date", "date", "from"]) ||
          pick(query, ["start_date", "date", "from"]) ||
          new Date()
        ) || formatDateOnly(new Date());

      const endDate =
        formatDateOnly(
          pick(body, ["end_date", "to"]) ||
          pick(query, ["end_date", "to"]) ||
          addDays(startDate, 7)
        ) || addDays(startDate, 7);

      const timeWindow =
        pick(body, ["time_window"]) ||
        pick(query, ["time_window"]) ||
        null;

      const username = resolveUsername(calConfig, explicitUsername);
      const eventTypeSlug = resolveEventTypeSlug(
        calConfig,
        normalizeServiceKey(serviceKey),
        explicitSlug
      );

      if (!username || !eventTypeSlug) {
        return json(res, 400, {
          ok: false,
          error: "Missing cal username or eventTypeSlug",
          username,
          eventTypeSlug,
        });
      }

      if (!attendeeName || !attendeeEmail) {
        return json(res, 400, {
          ok: false,
          error: "Missing attendee name or attendee email",
        });
      }

      const raw = await getSlots({
        token: accessToken,
        username,
        eventTypeSlug,
        startDate,
        endDate,
        timeZone,
      });

      let slots = flattenSlotsResponse(raw);
      slots = filterByTimeWindow(slots, timeWindow);

      if (!slots.length) {
        return json(res, 404, {
          ok: false,
          error: "No available slots found",
          eventTypeSlug,
          username,
        });
      }

      const earliest = slots[0];

      const booking = await createBooking({
        token: accessToken,
        start: earliest.start,
        attendeeName,
        attendeeEmail,
        attendeePhone,
        timeZone,
        eventTypeSlug,
      });

      return json(res, 200, {
        ok: true,
        selected_slot: earliest,
        booking,
      });
    }

    // -------- DEFAULT --------
    return json(res, 200, {
      ok: true,
      message: "cal.js is running",
      supported_actions: [
        "oauth_start",
        "oauth_callback",
        "availability",
        "slots",
        "book",
        "auto",
        "autobook",
      ],
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    return json(res, status, {
      ok: false,
      error: err?.response?.data || err.message || "Unknown error",
    });
  }
};
