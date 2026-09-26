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
const CAL_SCHEDULES_API_VERSION = "2024-06-11";
const CAL_BOOKINGS_API_VERSION = "2026-02-25";
const SCHEDULER_CONFIG_FEATURE_VERSION = 1;
const DEFAULT_SCHEDULER_CONFIG_PAIR =
  "lets-go-6659962517436476386:agent_67e9dc0ab56576c4b9d3264eaa";

// -------------------- CORS & RESPONSES --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Agent-Id, X-Cal-Username, X-Cal-Slug, X-Setup-Key, X-Idempotency-Key"
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
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeServiceKey(value = "") {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}
// East Providence display/service names map to Len's existing Cal.com slugs.
const SERVICE_KEY_ALIASES = {
  existing_client: "existing_client_phone",
  new_prospect: "new_prospect_phone",
  new_couple: "new_couple_phone",

  new_prospect_east_providence:
    "new_prospect_providence",

  existing_client_east_providence:
    "existing_client_providence",

  new_couple_east_providence:
    "new_couple_providence"
};
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

async function fetchAllEventTypes(accessToken) {
  const eventTypeHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "cal-api-version": CAL_EVENT_TYPES_API_VERSION
  };
  const etResp = await axios.get("https://api.cal.com/v2/event-types", {
    headers: eventTypeHeaders
  });
  return extractEventTypeRows(etResp.data);
}

function buildEventTypeIndexes(rows = []) {
  const eventTypeSlugs = {};
  const eventTypeIds = {};

  for (const et of rows) {
    const slug = asString(et?.slug);
    const id = Number(et?.id);
    if (!slug) continue;
    const key = normalizeServiceKey(slug);
    eventTypeSlugs[key] = slug;
    if (Number.isInteger(id) && id > 0) eventTypeIds[key] = id;
  }

  return { eventTypeSlugs, eventTypeIds };
}

async function fetchAllEventTypeSlugs(accessToken) {
  try {
    const rows = await fetchAllEventTypes(accessToken);
    return buildEventTypeIndexes(rows).eventTypeSlugs;
  } catch (err) {
    console.log("CAL EVENT TYPES FETCH ERROR", err.message);
    return {};
  }
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

async function getValidAccessToken(clientId, agentId = "") {
  let token = await kv.get(tokenKeyForClient(clientId));
  if (!token?.access_token && agentId) {
    token = await kv.get(tokenKeyForAgent(agentId));
  }
  if (!token?.access_token) throw new Error("No OAuth token found for client");

  const expiresAt = Number(token.expires_at || 0);
  if (expiresAt && expiresAt <= Date.now() + 60_000) {
    token = await refreshAccessTokenForClient(clientId);
  }
  return asString(token.access_token);
}

function requireSetupKey(req) {
  const expected = asString(process.env.AI_INTEGRATING_SETUP_SECRET);
  const supplied = asString(req.headers["x-setup-key"]);
  if (!expected) return { ok: false, status: 503, error: "Setup API is not configured" };
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok
    ? { ok: true }
    : { ok: false, status: 401, error: "Unauthorized setup request" };
}

function isSchedulerConfigPairAllowed(clientId, agentId) {
  const configured = asString(process.env.SCHEDULER_CONFIG_ALLOWED_PAIRS);
  const pairs = (configured || DEFAULT_SCHEDULER_CONFIG_PAIR)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return pairs.includes(`${clientId}:${agentId}`);
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

function normalizeAvailability(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new Error("availability must contain between 1 and 50 time windows");
  }

  const canonicalDays = {
    sunday: "Sunday",
    monday: "Monday",
    tuesday: "Tuesday",
    wednesday: "Wednesday",
    thursday: "Thursday",
    friday: "Friday",
    saturday: "Saturday"
  };
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const normalized = value.map((window, index) => {
    const rawDays = Array.isArray(window?.days)
      ? window.days
      : window?.day
        ? [window.day]
        : [];
    const days = [...new Set(rawDays.map((day) => canonicalDays[asString(day).toLowerCase()]))];
    const startTime = asString(window?.startTime || window?.start_time);
    const endTime = asString(window?.endTime || window?.end_time);

    if (!days.length || days.some((day) => !day)) {
      throw new Error(`availability[${index}] contains an invalid day`);
    }
    if (!timePattern.test(startTime) || !timePattern.test(endTime)) {
      throw new Error(`availability[${index}] must use 24-hour HH:MM times`);
    }
    if (startTime >= endTime) {
      throw new Error(`availability[${index}] startTime must be before endTime`);
    }
    return { days, startTime, endTime };
  });

  const byDay = {};
  for (const window of normalized) {
    for (const day of window.days) {
      byDay[day] = byDay[day] || [];
      byDay[day].push([window.startTime, window.endTime]);
    }
  }
  for (const [day, windows] of Object.entries(byDay)) {
    windows.sort((a, b) => a[0].localeCompare(b[0]));
    for (let index = 1; index < windows.length; index += 1) {
      if (windows[index][0] < windows[index - 1][1]) {
        throw new Error(`${day} availability windows overlap`);
      }
    }
  }
  return normalized;
}

function integerSetting(value, name, minimum, maximum, fallback = 0) {
  const number = value === undefined || value === null || value === ""
    ? fallback
    : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be a whole number from ${minimum} to ${maximum}`);
  }
  return number;
}

function buildAppointmentLocations(meetingMethod, location) {
  if (meetingMethod === "video") return undefined;
  if (meetingMethod === "phone") return [{ type: "attendeePhone" }];
  return [{ type: "address", address: location, public: true }];
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

  const searchEnd = new Date(targetDate);
  searchEnd.setUTCDate(targetDate.getUTCDate() + 120);

  return {
    start: targetIsoDate,
    end: searchEnd.toISOString().slice(0, 10)
  };
}

  // No specific date or weekday = normal next-available search.
  const fallbackEnd = new Date(today);
  fallbackEnd.setUTCDate(today.getUTCDate() + 120);

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

const mappedServiceKey =
  SERVICE_KEY_ALIASES[serviceKey] || serviceKey;

// ADDED: Overrides fallback hierarchy if portal explicit mapping exists
let eventTypeSlug = calConfig?.serviceMap?.[mappedServiceKey]?.slug;

if (!eventTypeSlug) {
  eventTypeSlug = calConfig?.eventTypeSlugs?.[mappedServiceKey];
}

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
      return {
        error: "No configured Cal.com event type for service_key",
        agentId,
        clientId,
        serviceKey: mappedServiceKey
      };
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
async function handleCreateOauthLink(req, res, url, body) {
  const auth = requireSetupKey(req);
  if (!auth.ok) return json(res, auth.status, { error: auth.error });

  const args = body.args || body || {};
  const agent_id = cleanAgentId(args.agent_id || args.agentId);
  const email = asString(args.email);
  if (!agent_id) return json(res, 400, { error: "agent_id required" });

  const client_id = await kv.get(`agent:${agent_id}:client`);
  if (!client_id) {
    return json(res, 400, { error: "No client_id found for agent", agent_id });
  }

  const connectToken = crypto.randomBytes(32).toString("hex");
  await kv.set(
    `cal:oauth:connect:${connectToken}`,
    { agent_id, client_id, email },
    { ex: 600 }
  );

  const startUrl = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  startUrl.search = "";
  startUrl.searchParams.set("action", "oauth_start");
  startUrl.searchParams.set("connect_token", connectToken);

  return json(res, 200, {
    ok: true,
    authorizationUrl: startUrl.toString(),
    expiresInSeconds: 600
  });
}

async function handleOauthStart(req, res, url) {
  const connectToken = asString(url.searchParams.get("connect_token"));
  if (!connectToken) return json(res, 400, { error: "connect_token required" });

  const connectKey = `cal:oauth:connect:${connectToken}`;
  const connectRecord = await kv.get(connectKey);
  if (!connectRecord?.agent_id || !connectRecord?.client_id) {
    return json(res, 400, { error: "Invalid or expired connection link" });
  }
  await kv.del(connectKey);

  const agent_id = cleanAgentId(connectRecord.agent_id);
  const client_id = asString(connectRecord.client_id);
  const currentClientId = asString(await kv.get(`agent:${agent_id}:client`));
  if (!currentClientId || currentClientId !== client_id) {
    return json(res, 409, { error: "Agent-to-client mapping changed" });
  }

  const clientId = process.env.CAL_CLIENT_ID;
  const redirectUri = getCalRedirectUri();
  const nonce = crypto.randomBytes(16).toString("hex");

  await kv.set(
    `cal:oauth:state:${nonce}`,
    { agent_id, client_id, email: asString(connectRecord.email) },
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

if (asString(stateRecord.client_id) !== asString(client_id)) {
  return json(res, 409, {
    error: "Agent-to-client mapping changed during OAuth"
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
      let fetchedRows = [];
      try {
        fetchedRows = await fetchAllEventTypes(tokenPayload.access_token);
      } catch (eventTypeErr) {
        console.log("CAL EVENT TYPES FETCH ERROR", eventTypeErr.message);
      }
      const fetched = buildEventTypeIndexes(fetchedRows);

      await kv.set(`client:${client_id}:cal`, {
        ...existingConfig,
        username,
        eventTypeSlugs:
          Object.keys(fetched.eventTypeSlugs).length > 0
            ? fetched.eventTypeSlugs
            : existingConfig.eventTypeSlugs,
        eventTypeIds:
          Object.keys(fetched.eventTypeIds).length > 0
            ? fetched.eventTypeIds
            : existingConfig.eventTypeIds,
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
async function markOriginalBookingRescheduled(
  originalBookingUid,
  replacementBookingUid
) {
  if (!originalBookingUid || !replacementBookingUid) {
    return false;
  }

  const originalKey = `booking:${originalBookingUid}`;
  const originalBooking = await kv.get(originalKey);

  if (!originalBooking) {
    console.warn("ORIGINAL BOOKING NOT FOUND", {
      originalBookingUid,
    });
    return false;
  }

  await kv.set(originalKey, {
    ...originalBooking,
    confirmation_status: "rescheduled",
    needs_manual_cancellation: true,
    replacement_booking_uid: replacementBookingUid,
    updated_at: new Date().toISOString(),
  });

  return true;
}

// -------------------- CORE ACTIONS --------------------
async function handleAvailability(req, res, body) {
  const ctx = await resolveCalContext(req, body);
  if (ctx.error) return json(res, 400, { error: ctx.error });

const args = body.args || body || {};

const rawRequestedWeekday = asString(
  args.requested_weekday ||
  args.weekday ||
  args.day_of_week
).toLowerCase();

const executionMessage = asString(
  args.execution_message
).toLowerCase();

const isGeneralAvailabilityRequest =
  /\b(soonest|next available|first available|earliest available|any day)\b/i.test(
    executionMessage
  );

const requestedWeekday = isGeneralAvailabilityRequest
  ? ""
  : rawRequestedWeekday;

const { start, end } = resolveDateRange({
  requestedWeekday,
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

let starts = Object.values(slotsByDate)
  .flat()
  .map((s) => s.start)
  .filter(Boolean);
// Remove duplicate slots, sort chronologically, and keep the
// tool response small enough for the voice agent.
starts = [...new Set(starts)]
  .sort((a, b) => new Date(a) - new Date(b));
// If the caller requested a weekday, only return slots
// that actually fall on that weekday.
const cleanRequestedWeekday = requestedWeekday;
    
if (cleanRequestedWeekday in WEEKDAYS) {
  starts = starts.filter((slotStart) => {
    const weekdayName = new Intl.DateTimeFormat("en-US", {
      timeZone: ctx.timeZone,
      weekday: "long"
    })
      .format(new Date(slotStart))
      .toLowerCase();

    return weekdayName === cleanRequestedWeekday;
  });
}
starts = starts.slice(0, 12);
if (starts.length === 0) {
  return json(res, 200, {
    ok: false,
    error: "NO_AVAILABILITY_RETURNED",
    available_slots: [],
    agent_response:
      "No appointment times were returned. Do not offer or invent any dates or times, and do not call Book_Appointment."
  });
}

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
  const originalBookingUid = asString(
  args.original_booking_uid ||
  args.originalBookingUid
);
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
const savedBooking = await saveBookingForConfirmation(
  ctx,
  resp.data
);

const originalBookingMarked =
  await markOriginalBookingRescheduled(
    originalBookingUid,
    savedBooking?.booking_uid
  );

return json(res, 200, {
  ok: true,
  booking: resp.data,
  confirmation_record_saved: !!savedBooking,
  original_booking_marked_rescheduled:
    originalBookingMarked,
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
const savedBooking = await saveBookingForConfirmation(
  ctx,
  retryResp.data
);

const originalBookingMarked =
  await markOriginalBookingRescheduled(
    originalBookingUid,
    savedBooking?.booking_uid
  );

return json(res, 200, {
  ok: true,
  booking: retryResp.data,
  token_refreshed: true,
  confirmation_record_saved: !!savedBooking,
  original_booking_marked_rescheduled:
    originalBookingMarked,
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

  let fetchedRows;
  try {
    fetchedRows = await fetchAllEventTypes(token.access_token);
  } catch (err) {
    if (err?.response?.status !== 401) {
      return json(res, 502, {
        error: "Unable to fetch Cal.com event types",
        detail: err?.response?.data || err.message
      });
    }
    const refreshed = await refreshAccessTokenForClient(clientId);
    fetchedRows = await fetchAllEventTypes(refreshed.access_token);
  }
  const fetched = buildEventTypeIndexes(fetchedRows);

  const existingConfig = (await kv.get(`client:${clientId}:cal`)) || {};
  await kv.set(`client:${clientId}:cal`, {
    ...existingConfig,
    eventTypeSlugs:
      Object.keys(fetched.eventTypeSlugs).length > 0
        ? fetched.eventTypeSlugs
        : existingConfig.eventTypeSlugs,
    eventTypeIds:
      Object.keys(fetched.eventTypeIds).length > 0
        ? fetched.eventTypeIds
        : existingConfig.eventTypeIds,
    updated_at: new Date().toISOString()
  });

  return json(res, 200, {
    ok: true,
    eventTypes: fetchedRows.map((et) => ({
      id: et.id,
      title: et.title,
      slug: et.slug,
      lengthInMinutes: et.lengthInMinutes
    }))
  });
}

// Server-to-server onboarding action. Never call this directly from browser code;
// route it through an authenticated backend that holds AI_INTEGRATING_SETUP_SECRET.
async function handleUpsertEventType(req, res, url, body) {
  const auth = requireSetupKey(req);
  if (!auth.ok) return json(res, auth.status, { error: auth.error });

  const args = body.args || body || {};
  const agentId = cleanAgentId(
    url.searchParams.get("agent_id") ||
      req.headers["x-agent-id"] ||
      args.agent_id ||
      args.agentId
  );
  if (!agentId) return json(res, 400, { error: "Missing agent_id" });

  const serviceKey = normalizeServiceKey(args.service_key || args.serviceKey);
  const title = asString(args.title);
  const slug = normalizeSlug(args.slug || title);
  const lengthInMinutes = Number(args.lengthInMinutes || args.duration);

  if (!serviceKey || !/^[a-z0-9_]+$/.test(serviceKey)) {
    return json(res, 400, { error: "Invalid service_key" });
  }
  if (!title) return json(res, 400, { error: "Missing event type title" });
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return json(res, 400, { error: "Invalid event type slug" });
  }
  if (!Number.isInteger(lengthInMinutes) || lengthInMinutes < 5 || lengthInMinutes > 720) {
    return json(res, 400, {
      error: "lengthInMinutes must be a whole number from 5 to 720"
    });
  }

  const clientId = await kv.get(`agent:${agentId}:client`);
  if (!clientId) return json(res, 400, { error: "No client_id found" });

  const calKey = `client:${clientId}:cal`;
  const existingConfig = (await kv.get(calKey)) || {};
  const serviceMap = { ...(existingConfig.serviceMap || {}) };
  const priorMapping = serviceMap[serviceKey] || {};
  let accessToken;
  try {
    accessToken = await getValidAccessToken(clientId, agentId);
  } catch (err) {
    return json(res, 401, {
      error: "Cal.com authorization is missing or expired",
      detail: err.message
    });
  }
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "cal-api-version": CAL_EVENT_TYPES_API_VERSION
  };

  let rows;
  try {
    rows = await fetchAllEventTypes(accessToken);
  } catch (err) {
    return json(res, err?.response?.status || 502, {
      error: "Unable to read Cal.com event types",
      detail: err?.response?.data || err.message
    });
  }

  const mappedId = Number(priorMapping.eventTypeId);
  let target = Number.isInteger(mappedId)
    ? rows.find((et) => Number(et?.id) === mappedId)
    : null;
  const slugOwner = rows.find((et) => normalizeSlug(et?.slug) === slug);

  if (!target && slugOwner) {
    if (args.adopt_existing !== true) {
      return json(res, 409, {
        error: "Slug already belongs to an unmanaged Cal.com event type",
        slug,
        existingEventType: {
          id: slugOwner.id,
          title: slugOwner.title,
          slug: slugOwner.slug
        },
        nextStep: "Choose another slug or explicitly set adopt_existing to true"
      });
    }
    target = slugOwner;
  }

  if (target && slugOwner && Number(target.id) !== Number(slugOwner.id)) {
    return json(res, 409, {
      error: "Requested slug is already used by a different event type",
      slug,
      conflictingEventTypeId: slugOwner.id
    });
  }

  const payload = { title, slug, lengthInMinutes };
  let saved;
  let operation;
  try {
    if (target) {
      const updateResp = await axios.patch(
        `https://api.cal.com/v2/event-types/${encodeURIComponent(target.id)}`,
        payload,
        { headers }
      );
      saved = updateResp.data?.data || updateResp.data;
      operation = "updated";
    } else {
      const createResp = await axios.post(
        "https://api.cal.com/v2/event-types",
        payload,
        { headers }
      );
      saved = createResp.data?.data || createResp.data;
      operation = "created";
    }
  } catch (err) {
    return json(res, err?.response?.status || 502, {
      error: "Cal.com rejected the event type change",
      detail: err?.response?.data || err.message
    });
  }

  const eventTypeId = Number(saved?.id || target?.id);
  if (!Number.isInteger(eventTypeId) || eventTypeId <= 0) {
    return json(res, 502, { error: "Cal.com response did not include an event type ID" });
  }

  serviceMap[serviceKey] = {
    eventTypeId,
    slug: asString(saved?.slug, slug),
    title: asString(saved?.title, title),
    lengthInMinutes: Number(saved?.lengthInMinutes || lengthInMinutes),
    managedBy: "ai-integrating",
    updated_at: new Date().toISOString()
  };

  await kv.set(calKey, {
    ...existingConfig,
    serviceMap,
    eventTypeSlugs: {
      ...(existingConfig.eventTypeSlugs || {}),
      [serviceKey]: serviceMap[serviceKey].slug
    },
    eventTypeIds: {
      ...(existingConfig.eventTypeIds || {}),
      [serviceKey]: eventTypeId
    },
    updated_at: new Date().toISOString()
  });

  return json(res, 200, {
    ok: true,
    operation,
    serviceKey,
    eventType: serviceMap[serviceKey]
  });
}

async function resolveSchedulerConfigIdentity(req, res, url, args) {
  const agentId = cleanAgentId(
    url.searchParams.get("agent_id") ||
      req.headers["x-agent-id"] ||
      args.agent_id ||
      args.agentId
  );
  const suppliedClientId = asString(
    url.searchParams.get("client_id") || args.client_id || args.clientId
  );
  if (!agentId || !suppliedClientId) {
    json(res, 400, { error: "Both client_id and agent_id are required" });
    return null;
  }

  const mappedClientId = asString(await kv.get(`agent:${agentId}:client`));
  if (!mappedClientId || mappedClientId !== suppliedClientId) {
    json(res, 403, { error: "Client and Scheduler agent mapping does not match" });
    return null;
  }
  if (!isSchedulerConfigPairAllowed(mappedClientId, agentId)) {
    json(res, 403, { error: "Appointment-type configuration is not enabled for this client" });
    return null;
  }
  return { clientId: mappedClientId, agentId };
}

async function handleManagedAppointmentTypes(req, res, url, body) {
  const auth = requireSetupKey(req);
  if (!auth.ok) return json(res, auth.status, { error: auth.error });

  const args = body.args || body || {};
  const identity = await resolveSchedulerConfigIdentity(req, res, url, args);
  if (!identity) return;

  const existingConfig = (await kv.get(`client:${identity.clientId}:cal`)) || {};
  const appointmentTypes = Object.entries(existingConfig.serviceMap || {})
    .filter(([, item]) => item?.managedBy === "ai-integrating-appointment-types")
    .map(([serviceKey, item]) => ({ serviceKey, ...item }));

  return json(res, 200, {
    ok: true,
    clientId: identity.clientId,
    agentId: identity.agentId,
    appointmentTypes
  });
}

// Isolated portal configuration action. This does not replace or alter the
// existing upsert_event_type action used by other workflows.
async function handleUpsertAppointmentType(req, res, url, body) {
  const auth = requireSetupKey(req);
  if (!auth.ok) return json(res, auth.status, { error: auth.error });
  if (req.method !== "POST") {
    return json(res, 405, { error: "POST required" });
  }

  const args = body.args || body || {};
  const identity = await resolveSchedulerConfigIdentity(req, res, url, args);
  if (!identity) return;
  const { clientId, agentId } = identity;

  const serviceKey = normalizeServiceKey(args.service_key || args.serviceKey);
  const title = asString(args.title);
  const slug = normalizeSlug(args.slug || title);
  const lengthInMinutes = Number(args.lengthInMinutes || args.duration);
  const timeZone = asString(args.timeZone || args.time_zone);
  const meetingMethod = asString(args.meetingMethod || args.meeting_method).toLowerCase();
  const location = asString(args.location);
  const idempotencyKey = asString(
    req.headers["x-idempotency-key"] || args.idempotency_key || args.idempotencyKey
  );

  if (!serviceKey || !/^[a-z0-9_]+$/.test(serviceKey)) {
    return json(res, 400, { error: "Invalid service_key" });
  }
  if (!title || title.length > 120) {
    return json(res, 400, { error: "title is required and must be 120 characters or fewer" });
  }
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return json(res, 400, { error: "Invalid event type slug" });
  }
  if (!Number.isInteger(lengthInMinutes) || lengthInMinutes < 5 || lengthInMinutes > 720) {
    return json(res, 400, { error: "duration must be a whole number from 5 to 720" });
  }
  if (!timeZone || !isValidTimeZone(timeZone)) {
    return json(res, 400, { error: "A valid IANA timeZone is required" });
  }
  if (!["phone", "video", "in_person"].includes(meetingMethod)) {
    return json(res, 400, { error: "meetingMethod must be phone, video, or in_person" });
  }
  if (meetingMethod === "in_person" && !location) {
    return json(res, 400, { error: "location is required for in-person appointments" });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)) {
    return json(res, 400, {
      error: "An idempotency key containing 8 to 128 safe characters is required"
    });
  }

  let availability;
  let beforeEventBuffer;
  let afterEventBuffer;
  let minimumBookingNotice;
  try {
    availability = normalizeAvailability(args.availability);
    beforeEventBuffer = integerSetting(
      args.beforeEventBuffer ?? args.before_event_buffer,
      "beforeEventBuffer",
      0,
      1440
    );
    afterEventBuffer = integerSetting(
      args.afterEventBuffer ?? args.after_event_buffer,
      "afterEventBuffer",
      0,
      1440
    );
    minimumBookingNotice = integerSetting(
      args.minimumBookingNotice ?? args.minimum_booking_notice,
      "minimumBookingNotice",
      0,
      525600
    );
  } catch (err) {
    return json(res, 400, { error: err.message });
  }

  const normalizedRequest = {
    clientId,
    agentId,
    serviceKey,
    title,
    slug,
    lengthInMinutes,
    timeZone,
    meetingMethod,
    location: meetingMethod === "in_person" ? location : "",
    availability,
    beforeEventBuffer,
    afterEventBuffer,
    minimumBookingNotice
  };
  const payloadHash = stableHash(normalizedRequest);
  const operationKey = `scheduler:appointment-type-op:${clientId}:${idempotencyKey}`;
  const existingOperation = await kv.get(operationKey);

  const calKey = `client:${clientId}:cal`;
  let existingConfig = (await kv.get(calKey)) || {};
  let serviceMap = { ...(existingConfig.serviceMap || {}) };
  let priorMapping = serviceMap[serviceKey] || {};

  const finalizeOperation = async (remoteResult) => {
    const currentConfig = (await kv.get(calKey)) || {};
    const currentMap = { ...(currentConfig.serviceMap || {}) };
    const previousVersion = Number(currentMap[serviceKey]?.version || 0);
    const alreadyFinalized = currentMap[serviceKey]?.configurationHash === payloadHash;
    const mapping = {
      eventTypeId: Number(remoteResult.eventTypeId),
      scheduleId: Number(remoteResult.scheduleId),
      slug,
      title,
      lengthInMinutes,
      timeZone,
      meetingMethod,
      location: meetingMethod === "in_person" ? location : "",
      availability,
      beforeEventBuffer,
      afterEventBuffer,
      minimumBookingNotice,
      managedBy: "ai-integrating-appointment-types",
      featureVersion: SCHEDULER_CONFIG_FEATURE_VERSION,
      configurationHash: payloadHash,
      version: alreadyFinalized ? previousVersion : previousVersion + 1,
      updated_at: new Date().toISOString()
    };
    currentMap[serviceKey] = mapping;
    await kv.set(calKey, {
      ...currentConfig,
      serviceMap: currentMap,
      eventTypeSlugs: {
        ...(currentConfig.eventTypeSlugs || {}),
        [serviceKey]: slug
      },
      eventTypeIds: {
        ...(currentConfig.eventTypeIds || {}),
        [serviceKey]: mapping.eventTypeId
      },
      updated_at: new Date().toISOString()
    });
    const response = {
      ok: true,
      operation: remoteResult.operation,
      serviceKey,
      appointmentType: mapping
    };
    await kv.set(operationKey, {
      payloadHash,
      status: "completed",
      response,
      completed_at: new Date().toISOString()
    });
    return response;
  };

  if (existingOperation) {
    if (existingOperation.payloadHash !== payloadHash) {
      return json(res, 409, { error: "Idempotency key was already used for different settings" });
    }
    if (existingOperation.status === "completed") {
      return json(res, 200, existingOperation.response);
    }
    if (existingOperation.status === "remote_completed" && existingOperation.remoteResult) {
      try {
        return json(res, 200, await finalizeOperation(existingOperation.remoteResult));
      } catch (err) {
        return json(res, 503, { error: "Remote changes succeeded but local finalization must be retried" });
      }
    }
    if (existingOperation.status === "ambiguous") {
      return json(res, 409, {
        error: "A prior Cal.com request has an ambiguous result and requires manual review",
        operation: existingOperation
      });
    }
    return json(res, 409, { error: "This configuration request is already processing" });
  }

  const lockResult = await kv.set(
    operationKey,
    { payloadHash, status: "processing", started_at: new Date().toISOString() },
    { nx: true }
  );
  if (!lockResult) {
    return json(res, 409, { error: "This configuration request is already processing" });
  }

  const isUpdate = Boolean(priorMapping.eventTypeId || priorMapping.scheduleId);
  const expectedVersionRaw = args.expected_version ?? args.expectedVersion;
  if (isUpdate) {
    if (
      priorMapping.managedBy !== "ai-integrating-appointment-types" ||
      Number(priorMapping.featureVersion) !== SCHEDULER_CONFIG_FEATURE_VERSION ||
      !Number.isInteger(Number(priorMapping.eventTypeId)) ||
      !Number.isInteger(Number(priorMapping.scheduleId))
    ) {
      await kv.set(operationKey, { payloadHash, status: "rejected", reason: "unowned_resource" });
      return json(res, 409, { error: "Existing resources are not owned by this appointment-type feature" });
    }
    if (expectedVersionRaw === undefined || Number(expectedVersionRaw) !== Number(priorMapping.version)) {
      await kv.set(operationKey, { payloadHash, status: "rejected", reason: "version_mismatch" });
      return json(res, 409, {
        error: "Appointment type version changed; refresh before saving",
        currentVersion: priorMapping.version
      });
    }
  }

  let accessToken;
  try {
    accessToken = await getValidAccessToken(clientId, agentId);
  } catch (err) {
    await kv.set(operationKey, { payloadHash, status: "failed", reason: "oauth" });
    return json(res, 401, { error: "Cal.com authorization is missing or expired", detail: err.message });
  }

  let rows;
  try {
    rows = await fetchAllEventTypes(accessToken);
  } catch (err) {
    await kv.set(operationKey, { payloadHash, status: "failed", reason: "event_type_read" });
    return json(res, err?.response?.status || 502, {
      error: "Unable to read Cal.com event types",
      detail: err?.response?.data || err.message
    });
  }

  const targetEventTypeId = Number(priorMapping.eventTypeId);
  const target = isUpdate
    ? rows.find((eventType) => Number(eventType?.id) === targetEventTypeId)
    : null;
  if (isUpdate && !target) {
    await kv.set(operationKey, { payloadHash, status: "rejected", reason: "managed_event_missing" });
    return json(res, 409, { error: "The managed Cal.com event type no longer exists" });
  }
  const slugOwner = rows.find((eventType) => normalizeSlug(eventType?.slug) === slug);
  if (slugOwner && (!target || Number(slugOwner.id) !== Number(target.id))) {
    await kv.set(operationKey, { payloadHash, status: "rejected", reason: "slug_conflict" });
    return json(res, 409, {
      error: "Slug already belongs to another Cal.com event type",
      slug
    });
  }

  const scheduleHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "cal-api-version": CAL_SCHEDULES_API_VERSION
  };
  const eventTypeHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "cal-api-version": CAL_EVENT_TYPES_API_VERSION
  };
  const schedulePayload = {
    name: `AI Integrating - ${serviceKey}`,
    timeZone,
    isDefault: false,
    availability
  };

  let scheduleId = Number(priorMapping.scheduleId);
  try {
    if (isUpdate) {
      await axios.patch(
        `https://api.cal.com/v2/schedules/${encodeURIComponent(scheduleId)}`,
        schedulePayload,
        { headers: scheduleHeaders }
      );
    } else {
      const scheduleResponse = await axios.post(
        "https://api.cal.com/v2/schedules",
        schedulePayload,
        { headers: scheduleHeaders }
      );
      scheduleId = Number(scheduleResponse.data?.data?.id || scheduleResponse.data?.id);
      if (!Number.isInteger(scheduleId) || scheduleId <= 0) {
        throw new Error("Cal.com response did not include a schedule ID");
      }
      await kv.set(operationKey, {
        payloadHash,
        status: "schedule_created",
        scheduleId,
        updated_at: new Date().toISOString()
      });
    }
  } catch (err) {
    const ambiguous = !err?.response;
    await kv.set(operationKey, {
      payloadHash,
      status: ambiguous ? "ambiguous" : "failed",
      stage: "schedule",
      scheduleId: Number.isInteger(scheduleId) ? scheduleId : null,
      detail: err?.response?.data || err.message,
      updated_at: new Date().toISOString()
    });
    return json(res, ambiguous ? 409 : err?.response?.status || 502, {
      error: ambiguous
        ? "Schedule result is ambiguous and requires manual review"
        : "Cal.com rejected the schedule change",
      detail: err?.response?.data || err.message
    });
  }

  const eventTypePayload = {
    title,
    slug,
    lengthInMinutes,
    scheduleId,
    beforeEventBuffer,
    afterEventBuffer,
    minimumBookingNotice
  };
  const locations = buildAppointmentLocations(meetingMethod, location);
  if (locations) eventTypePayload.locations = locations;

  let savedEventType;
  try {
    if (isUpdate) {
      const response = await axios.patch(
        `https://api.cal.com/v2/event-types/${encodeURIComponent(targetEventTypeId)}`,
        eventTypePayload,
        { headers: eventTypeHeaders }
      );
      savedEventType = response.data?.data || response.data;
    } else {
      const response = await axios.post(
        "https://api.cal.com/v2/event-types",
        eventTypePayload,
        { headers: eventTypeHeaders }
      );
      savedEventType = response.data?.data || response.data;
    }
  } catch (err) {
    const ambiguous = !err?.response;
    await kv.set(operationKey, {
      payloadHash,
      status: ambiguous ? "ambiguous" : "failed",
      stage: "event_type",
      scheduleId,
      orphanedSchedulePossible: !isUpdate,
      detail: err?.response?.data || err.message,
      updated_at: new Date().toISOString()
    });
    return json(res, ambiguous ? 409 : err?.response?.status || 502, {
      error: ambiguous
        ? "Event type result is ambiguous and requires manual review"
        : "Cal.com rejected the event type change",
      detail: err?.response?.data || err.message,
      scheduleId,
      cleanupRequired: !isUpdate
    });
  }

  const eventTypeId = Number(savedEventType?.id || targetEventTypeId);
  if (!Number.isInteger(eventTypeId) || eventTypeId <= 0) {
    await kv.set(operationKey, {
      payloadHash,
      status: "ambiguous",
      stage: "event_type_response",
      scheduleId
    });
    return json(res, 409, { error: "Cal.com response did not include an event type ID" });
  }

  const remoteResult = {
    operation: isUpdate ? "updated" : "created",
    eventTypeId,
    scheduleId
  };
  await kv.set(operationKey, {
    payloadHash,
    status: "remote_completed",
    remoteResult,
    updated_at: new Date().toISOString()
  });

  try {
    return json(res, 200, await finalizeOperation(remoteResult));
  } catch (err) {
    return json(res, 503, {
      error: "Cal.com changes succeeded but local finalization must be retried",
      detail: err.message
    });
  }
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

  if (action === "create_oauth_link") {
    return await handleCreateOauthLink(req, res, url, body);
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

  if (action === "upsert_event_type") {
    return await handleUpsertEventType(req, res, url, body);
  }

  if (action === "managed_appointment_types") {
    return await handleManagedAppointmentTypes(req, res, url, body);
  }

  if (action === "upsert_appointment_type") {
    return await handleUpsertAppointmentType(req, res, url, body);
  }

  if (action === "select_event_type") {
    return await handleSelectEventType(req, res, url, body);
  }

  return json(res, 400, {
    error: "Unknown action",
    method: req.method
  });
};
