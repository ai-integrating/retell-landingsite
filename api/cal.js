// /api/cal.js
const axios = require("axios");
const crypto = require("crypto");
const { kv } = require("@vercel/kv");

const CAL_API_VERSION = "2024-09-04";
const WEEKDAYS = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};
const CAL_EVENT_TYPES_API_VERSION = "2024-06-14";
const CAL_BOOKINGS_API_VERSION = "2026-02-25";

// -------------------- CORS & RESPONSES --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Agent-Id, X-Cal-Username, X-Cal-Slug"
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

// -------------------- SYSTEM FORMATTING TOOLKIT STYLES UNTOUCHED --------------------
function asString(v, fallback = "") {
  return v === undefined || v === null ? fallback : String(v).trim();
}

function cleanAgentId(value = "") {
  return String(value || "")
    .trim()
    .replace(/\s+class=.*$/i, "")
    .trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(asString(email));
}

function normalizeEmailInput(email = "") {
  return String(email || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

// ADDED: Normalize phone numbers for Cal.com booking payloads
function normalizePhoneNumber(phone = "") {
  const raw = String(phone || "").trim();

  if (!raw) return "";

  const digits = raw.replace(/\D/g, "");

  // US 10-digit number
  if (digits.length === 10) {
    return `+1${digits}`;
  }

  // US number already includes country code
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  // Already looks international
  if (raw.startsWith("+")) {
    return `+${digits}`;
  }

  return raw;
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

function normalizeServiceKey(value = "") {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

function tokenKeyForAgent(agentId) {
  const a = asString(agentId);
  return a ? `cal:tokens:agent:${a}` : "";
}
  function tokenKeyForClient(clientId) {
  const c = asString(clientId);
  return c ? `cal:tokens:client:${c}` : "";
}

function tokenKeyForEmail(email) {
  const e = asString(email).toLowerCase();
  return e ? `cal:tokens:${e}` : "";
}

function getCalRedirectUri() {
  return (
    process.env.CAL_OAUTH_REDIRECT_URI ||
    process.env.CAL_REDIRECT_URI ||
    process.env.CAL_OAUTH_REDIRECT_URL ||
    ""
  );
}

function extractEventTypeRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.eventTypes)) return payload.data.eventTypes;
  if (Array.isArray(payload?.eventTypes)) return payload.eventTypes;
  if (Array.isArray(payload?.collection)) return payload.collection;
  return [];
}

function extractTeamRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.teams)) return payload.data.teams;
  if (Array.isArray(payload?.teams)) return payload.teams;
  if (Array.isArray(payload?.collection)) return payload.collection;
  return [];
}

async function fetchAllEventTypeSlugs(accessToken) {
  const eventTypeHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "cal-api-version": CAL_EVENT_TYPES_API_VERSION
  };

  const slugMap = {};

  const addRows = (rows = []) => {
    for (const et of rows) {
      const slug = asString(et?.slug);
      if (!slug) continue;
      slugMap[normalizeServiceKey(slug)] = slug;
    }
  };

  try {
    const etResp = await axios.get("https://api.cal.com/v2/event-types", {
      headers: eventTypeHeaders
    });
    addRows(extractEventTypeRows(etResp.data));
  } catch (err) {
    console.log("CAL EVENT TYPES FETCH ERROR", err.message);
  }

  return slugMap;
}
async function refreshAccessTokenForClient(clientId) {
  const existing = await kv.get(tokenKeyForClient(clientId));
  const refreshToken = asString(existing?.refresh_token);

  if (!refreshToken) {
    throw new Error("No refresh token available");
  }

  const oauthClientId = process.env.CAL_CLIENT_ID;
  const clientSecret = process.env.CAL_CLIENT_SECRET;

  const resp = await axios.post("https://api.cal.com/v2/auth/oauth2/token", {
    client_id: oauthClientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });

  const data = resp.data || {};

  const refreshed = {
    access_token: asString(data.access_token),
    refresh_token: asString(data.refresh_token || refreshToken),
    token_type: asString(data.token_type, "bearer"),
    expires_at: data.expires_in
      ? Date.now() + Number(data.expires_in) * 1000
      : 0
  };

  await kv.set(tokenKeyForClient(clientId), refreshed);

  return refreshed;
}
function resolveDateRange({
  requestedWeekday,
  explicitStartDate,
  explicitEndDate,
  timeZone = "America/New_York"
}) {
  // A caller gave an exact date.
  // Trust the explicit date rather than doing weekday math.
  if (explicitStartDate) {
    return {
      start: explicitStartDate,
      end: explicitEndDate || explicitStartDate
    };
  }

  // Determine "today" in the client's timezone.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);

  const today = new Date(Date.UTC(year, month - 1, day));

  const cleanDay = String(requestedWeekday || "")
    .trim()
    .toLowerCase();

  // Named weekday: backend determines the real calendar date.
  if (cleanDay in WEEKDAYS) {
    const targetDayIndex = WEEKDAYS[cleanDay];
    const currentDayIndex = today.getUTCDay();
    const daysUntil = (targetDayIndex - currentDayIndex + 7) % 7;

    const targetDate = new Date(today);
    targetDate.setUTCDate(today.getUTCDate() + daysUntil);

    const targetIsoDate = targetDate.toISOString().slice(0, 10);

    return {
      start: targetIsoDate,
      end: targetIsoDate
    };
  }

  // No specific date or weekday = normal next-available search.
  const fallbackEnd = new Date(today);
  fallbackEnd.setUTCDate(today.getUTCDate() + 7);

  return {
    start: today.toISOString().slice(0, 10),
    end: fallbackEnd.toISOString().slice(0, 10)
  };
}
// -------------------- CONTEXT RESOLUTION --------------------
async function resolveCalContext(req, body) {
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const args = body.args || body || {};

  const agentId = cleanAgentId(
    url.searchParams.get("agent_id") ||
      req.headers["x-agent-id"] ||
      body.agent_id ||
      body?.call?.agent_id ||
      args.agent_id ||
      args.agentId
  );

  if (!agentId) return { error: "Missing agent_id" };

  const clientId = await kv.get(`agent:${agentId}:client`);
  if (!clientId) return { error: "No client_id found for agent", agentId };

  const calConfig = await kv.get(`client:${clientId}:cal`);
  if (!calConfig || !calConfig.username) {
    return { error: "No Cal config found for client", agentId, clientId };
  }
let token = await kv.get(tokenKeyForClient(clientId));

if (!token?.access_token) {
  token = await kv.get(tokenKeyForAgent(agentId));
}

if (!token?.access_token) {
  return { error: "No OAuth token found for client", agentId, clientId };
}
  const rawServiceKey = asString(
    args.service_key ||
      body.service_key ||
      args.eventTypeSlug ||
      args.event_slug ||
      args.eventSlug ||
      args.slug
  );

  const serviceKey = normalizeServiceKey(rawServiceKey);

  // ADDED: Overrides fallback hierarchy if portal explicit mapping exists
let eventTypeSlug = calConfig?.eventTypeSlugs?.[serviceKey];

if (!eventTypeSlug) {
  eventTypeSlug = calConfig?.selectedEventTypeSlug;

    if (!eventTypeSlug && calConfig?.eventTypeSlugs) {
      const keys = Object.keys(calConfig.eventTypeSlugs);
      const compactServiceKey = serviceKey.replace(/_/g, "");

      const match = keys.find((k) =>
        k.replace(/_/g, "").includes(compactServiceKey)
      );

      if (match) {
        eventTypeSlug = calConfig.eventTypeSlugs[match];
      }
    }

    if (!eventTypeSlug) {
      eventTypeSlug = normalizeSlug(rawServiceKey);
    }
  }

  return {
    agentId,
    clientId,
    username: asString(calConfig.username),
    timeZone: asString(calConfig.timeZone, "America/New_York"),
    eventTypeSlug,
    accessToken: asString(token.access_token),
    serviceKey,
    calConfig
  };
}

// -------------------- OAUTH HANDLERS --------------------
async function handleOauthStart(req, res, url) {
  const agent_id = cleanAgentId(url.searchParams.get("agent_id"));
  const email = asString(url.searchParams.get("email"));
  if (!agent_id) return json(res, 400, { error: "agent_id param required" });

  const clientId = process.env.CAL_CLIENT_ID;
  const redirectUri = getCalRedirectUri();
  const nonce = crypto.randomBytes(16).toString("hex");

  await kv.set(
    `cal:oauth:state:${nonce}`,
    { agent_id, email: email || "" },
    { ex: 600 }
  );

  const authUrl = `https://app.cal.com/auth/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(
    clientId
  )}&redirect_uri=${encodeURIComponent(
    redirectUri
  )}&state=${encodeURIComponent(nonce)}`;

  res.writeHead(302, { Location: authUrl });
  return res.end();
}

async function handleOauthCallback(req, res, url) {
  const code = asString(url.searchParams.get("code"));
  const state = asString(url.searchParams.get("state"));
  const stateRecord = await kv.get(`cal:oauth:state:${state}`);

  if (!stateRecord?.agent_id) {
    return json(res, 400, { error: "Invalid or expired state" });
  }

  await kv.del(`cal:oauth:state:${state}`);

  const clientId = process.env.CAL_CLIENT_ID;
  const clientSecret = process.env.CAL_CLIENT_SECRET;
  const redirectUri = getCalRedirectUri();

  try {
    const tokenResp = await axios.post(
      "https://api.cal.com/v2/auth/oauth2/token",
      {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri
      }
    );

    const data = tokenResp.data || {};
    const agent_id = cleanAgentId(stateRecord.agent_id);

    const tokenPayload = {
      access_token: asString(data.access_token),
      refresh_token: asString(data.refresh_token),
      token_type: asString(data.token_type, "bearer"),
      expires_at: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : 0
    };

const client_id = await kv.get(`agent:${agent_id}:client`);

if (!client_id) {
  return json(res, 400, {
    error: "No client_id found for agent",
    agent_id
  });
}

await kv.set(tokenKeyForClient(client_id), tokenPayload);

// Keep legacy agent token temporarily during migration
await kv.set(tokenKeyForAgent(agent_id), tokenPayload);

    const meResp = await axios.get("https://api.cal.com/v2/me", {
      headers: {
        Authorization: `Bearer ${tokenPayload.access_token}`,
        "cal-api-version": CAL_API_VERSION
      }
    });

    const username = asString(meResp.data?.data?.username);

    if (client_id && username) {
      const existingConfig = (await kv.get(`client:${client_id}:cal`)) || {};
      const fetchedSlugs = await fetchAllEventTypeSlugs(tokenPayload.access_token);

      await kv.set(`client:${client_id}:cal`, {
        ...existingConfig,
        username,
        eventTypeSlugs:
          Object.keys(fetchedSlugs).length > 0
            ? fetchedSlugs
            : existingConfig.eventTypeSlugs,
        updated_at: new Date().toISOString()
      });
    }

    res.writeHead(302, { Location: "https://app.cal.com/event-types" });
    return res.end();
  } catch (err) {
    return json(res, 500, {
      error: "OAuth Exchange Failed",
      detail: err.message
    });
  }
}
// -------------------- BOOKING STORAGE --------------------
async function saveBookingForConfirmation(ctx, calResponse) {
  const booking = calResponse?.data;

  if (!booking?.uid) {
    console.log("BOOKING STORAGE SKIPPED: No Cal.com booking UID", calResponse);
    return null;
  }

  const attendee = Array.isArray(booking.attendees)
    ? booking.attendees[0]
    : null;

  const bookingRecord = {
    booking_uid: booking.uid,
    booking_id: booking.id || null,

    client_id: ctx.clientId,
    agent_id: ctx.agentId,

    customer_name: attendee?.name || "",
    customer_phone: attendee?.phoneNumber || "",
    customer_email: attendee?.email || "",

    appointment_start: booking.start || "",
    appointment_end: booking.end || "",
    appointment_type: booking.eventType?.slug || ctx.serviceKey || "",

    confirmation_status: "pending",
    confirmation_attempted_at: null,

    created_at: new Date().toISOString()
  };

  // Store the complete booking record by Cal.com UID
  await kv.set(`booking:${booking.uid}`, bookingRecord);

  // Create an index so we can find appointments by appointment date
  if (booking.start) {
    const appointmentDate = booking.start.slice(0, 10);
    const dateIndexKey =
      `client:${ctx.clientId}:confirmations:${appointmentDate}`;

    await kv.sadd(dateIndexKey, booking.uid);
  }

  console.log(
    "BOOKING SAVED FOR CONFIRMATION:",
    booking.uid,
    booking.start
  );

  return bookingRecord;
}
// -------------------- CORE ACTIONS --------------------
async function handleAvailability(req, res, body) {
  const ctx = await resolveCalContext(req, body);
  if (ctx.error) return json(res, 400, { error: ctx.error });

const args = body.args || body || {};

const { start, end } = resolveDateRange({
  requestedWeekday:
    args.requested_weekday ||
    args.weekday ||
    args.day_of_week,
  explicitStartDate: asString(args.start_date),
  explicitEndDate: asString(args.end_date),
  timeZone: ctx.timeZone
});

  const url = `https://api.cal.com/v2/slots?username=${encodeURIComponent(
    ctx.username
  )}&eventTypeSlug=${encodeURIComponent(
    ctx.eventTypeSlug
  )}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(
    end
  )}&timeZone=${encodeURIComponent(ctx.timeZone)}`;

  try {
    const resp = await axios.get(url, {
      headers: {
        "cal-api-version": CAL_API_VERSION,
        Authorization: `Bearer ${ctx.accessToken}`
      }
    });

    const slotsByDate = resp.data?.data || {};
    const starts = Object.values(slotsByDate)
      .flat()
      .map((s) => s.start)
      .filter(Boolean);

    return json(res, 200, {
      ok: true,
      available_slots: starts
    });
  } catch (err) {
    return json(res, 500, {
      error: "Cal fetch failed",
      message: err.message,
      detail: err?.response?.data || null
    });
  }
}

async function handleBook(req, res, body) {
  const ctx = await resolveCalContext(req, body);
  if (ctx.error) return json(res, 400, { error: ctx.error });

  const args = body.args || body;
  const rawStart = asString(args.start || args.slot || args.selected_start);

  if (!rawStart) {
    return json(res, 400, { error: "Missing selected start time" });
  }

  const name = asString(args.attendee_name || args.name);
  const email = normalizeEmailInput(args.attendee_email || args.email);

  // UPDATED: Normalize phone before sending it to Cal.com
  const phone = normalizePhoneNumber(
    args.phone || args.attendee_phone || ""
  );

  if (!name) {
    return json(res, 400, { error: "Missing attendee name" });
  }

  if (!isValidEmail(email)) {
    return json(res, 400, {
      error: "Invalid attendee email",
      received: email
    });
  }

  const start = new Date(rawStart).toISOString();

  const payload = {
    start,
    eventTypeSlug: ctx.eventTypeSlug,
    username: ctx.username,
    attendee: {
      name,
      email,
      timeZone: ctx.timeZone,
      language: "en",
      ...(phone ? { phoneNumber: phone } : {})
    }
  };

  const bookingUrl = "https://api.cal.com/v2/bookings";

  try {
    const resp = await axios.post(bookingUrl, payload, {
      headers: {
        "Content-Type": "application/json",
        "cal-api-version": CAL_BOOKINGS_API_VERSION,
        Authorization: `Bearer ${ctx.accessToken}`
      }
    });
const savedBooking = await saveBookingForConfirmation(ctx, resp.data);
return json(res, 200, {
  ok: true,
  booking: resp.data,
  confirmation_record_saved: !!savedBooking
});
  } catch (err) {
    const status = err?.response?.status || null;

    if (status === 401) {
      try {
      const refreshed = await refreshAccessTokenForClient(ctx.clientId);

        const retryResp = await axios.post(bookingUrl, payload, {
          headers: {
            "Content-Type": "application/json",
            "cal-api-version": CAL_BOOKINGS_API_VERSION,
            Authorization: `Bearer ${refreshed.access_token}`
          }
        });
const savedBooking = await saveBookingForConfirmation(ctx, retryResp.data);
        
               return json(res, 200, {
          ok: true,
          booking: retryResp.data,
          token_refreshed: true,
          confirmation_record_saved: !!savedBooking
      
        });
      } catch (retryErr) {
        return json(res, 500, {
          error: "Booking failed after token refresh",
          message: retryErr.message,
          status: retryErr?.response?.status || null,
          detail: retryErr?.response?.data || null,
          payloadSent: payload
        });
      }
    }

    return json(res, 500, {
      error: "Booking failed",
      message: err.message,
      status,
      detail: err?.response?.data || null,
      payloadSent: payload
    });
  }
}

// ADDED: Minimal actions for updating and saving chosen event types
async function handleEventTypes(req, res, url, body) {
  const args = body.args || body || {};
  const agentId = cleanAgentId(
    url.searchParams.get("agent_id") ||
      req.headers["x-agent-id"] ||
      args.agent_id ||
      args.agentId
  );

  if (!agentId) return json(res, 400, { error: "Missing agent_id" });

  const clientId = await kv.get(`agent:${agentId}:client`);
  if (!clientId) return json(res, 400, { error: "No client_id found" });

let token = await kv.get(tokenKeyForClient(clientId));

if (!token?.access_token) {
  token = await kv.get(tokenKeyForAgent(agentId));
}

if (!token?.access_token) {
  return json(res, 400, { error: "No OAuth token" });
}

  const fetchedSlugs = await fetchAllEventTypeSlugs(token.access_token);

  const existingConfig = (await kv.get(`client:${clientId}:cal`)) || {};
  await kv.set(`client:${clientId}:cal`, {
    ...existingConfig,
    eventTypeSlugs:
      Object.keys(fetchedSlugs).length > 0
        ? fetchedSlugs
        : existingConfig.eventTypeSlugs,
    updated_at: new Date().toISOString()
  });

  return json(res, 200, { ok: true, eventTypes: fetchedSlugs });
}

async function handleSelectEventType(req, res, url, body) {
  const args = body.args || body || {};
  const agentId = cleanAgentId(
    url.searchParams.get("agent_id") ||
      req.headers["x-agent-id"] ||
      args.agent_id ||
      args.agentId
  );

  if (!agentId) return json(res, 400, { error: "Missing agent_id" });

  const slug = asString(
    args.selectedEventTypeSlug ||
      args.eventTypeSlug ||
      args.slug
  );

  if (!slug) {
    return json(res, 400, { error: "Missing selected event type slug" });
  }

  const clientId = await kv.get(`agent:${agentId}:client`);
  if (!clientId) return json(res, 400, { error: "No client_id found" });

  const existingConfig = (await kv.get(`client:${clientId}:cal`)) || {};

  // ADDED: Validation block ensuring saved slug exists within known values
  const eventTypeSlugs = existingConfig.eventTypeSlugs || {};
  const validSlugs = Object.values(eventTypeSlugs);

  if (!validSlugs.includes(slug)) {
    return json(res, 400, {
      error: "Selected event type slug not found",
      selectedEventTypeSlug: slug,
      availableEventTypes: eventTypeSlugs
    });
  }

  await kv.set(`client:${clientId}:cal`, {
    ...existingConfig,
    selectedEventTypeSlug: slug,
    updated_at: new Date().toISOString()
  });

  return json(res, 200, {
    ok: true,
    selectedEventTypeSlug: slug
  });
}

// -------------------- ROUTER --------------------
module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const body = req.method === "POST" ? await readJsonBody(req) : {};
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const action = url.searchParams.get("action")?.toLowerCase();

  if (action === "oauth_start") {
    return await handleOauthStart(req, res, url);
  }

  if (action === "oauth_callback") {
    return await handleOauthCallback(req, res, url);
  }

  if (action === "availability") {
    return await handleAvailability(req, res, body);
  }

  if (action === "book") {
    return await handleBook(req, res, body);
  }

  // ADDED: Extends route patterns explicitly
  if (action === "event_types") {
    return await handleEventTypes(req, res, url, body);
  }

  if (action === "select_event_type") {
    return await handleSelectEventType(req, res, url, body);
  }

  return json(res, 400, {
    error: "Unknown action",
    method: req.method
  });
};
