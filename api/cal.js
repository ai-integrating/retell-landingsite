const axios = require("axios");
const crypto = require("crypto");
const { kv } = require("@vercel/kv");

// Endpoint-specific API versions
const CAL_API_VERSION_SLOTS = "2024-09-04";
const CAL_API_VERSION_EVENT_TYPES = "2024-06-14";
const CAL_API_VERSION_BOOKINGS = "2026-02-25";

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

// IMPORTANT: DO NOT treat service_key as the Cal slug.
// service_key should map through KV -> eventTypeSlugs.
function resolveEventTypeSlug(req, body) {
  const args = body.args || body || {};
  const bodySlug =
    args.eventTypeSlug ||
    args.event_slug ||
    args.eventSlug ||
    args.slug ||
    null;

  const headerSlug = req.headers["x-cal-slug"] || null;
  const chosen = bodySlug || headerSlug || "";
  return normalizeSlug(chosen);
}

function getCalHeaders(version) {
  return {
    "Content-Type": "application/json",
    "cal-api-version": version,
    Authorization: `Bearer ${process.env.CAL_API_KEY}`
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

function getCalRedirectUri() {
  return process.env.CAL_OAUTH_REDIRECT_URI || process.env.CAL_REDIRECT_URI || "";
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
  if (!cal || typeof cal !== "object") {
    return { agentId, clientId: String(clientId), error: "no_cal_config" };
  }

  return {
    agentId,
    clientId: String(clientId),
    username: asString(cal.username, ""),
    teamSlug: asString(cal.teamSlug || cal.team_slug, ""),
    organizationSlug: asString(cal.organizationSlug || cal.organization_slug, ""),
    eventTypeSlug: asString(cal.eventTypeSlug || cal.event_type_slug, ""),
    eventTypeSlugs: cal.eventTypeSlugs || cal.event_type_slugs || null,
    timeZone: asString(cal.timeZone || cal.time_zone, "America/New_York")
  };
}

function pickResolvedSlug(body, resolved) {
  if (!resolved) return "";

  if (resolved.eventTypeSlug) {
    return normalizeSlug(resolved.eventTypeSlug);
  }

  const args = body.args || body || {};
  const serviceKey = normalizeServiceKey(
    args.service_key || args.serviceKey || args.service
  );

  if (
    serviceKey &&
    resolved.eventTypeSlugs &&
    (
      resolved.eventTypeSlugs[serviceKey] ||
      resolved.eventTypeSlugs[serviceKey.replace(/-/g, "_")]
    )
  ) {
    return normalizeSlug(
      resolved.eventTypeSlugs[serviceKey] ||
      resolved.eventTypeSlugs[serviceKey.replace(/-/g, "_")]
    );
  }

  return "";
}

// -------------------- RESOLVE EVENT TYPE ID --------------------
async function resolveEventTypeId({ username, slug }) {
  if (!username || !slug) return null;

  try {
    const resp = await axios.get("https://api.cal.com/v2/event-types", {
      headers: getCalHeaders(CAL_API_VERSION_EVENT_TYPES),
      params: { username }
    });

    const items = Array.isArray(resp.data?.data)
      ? resp.data.data
      : Array.isArray(resp.data?.data?.eventTypes)
      ? resp.data.data.eventTypes
      : [];

    const match = items.find(
      (et) => normalizeSlug(et.slug) === normalizeSlug(slug)
    );

    console.log("EVENT TYPE LOOKUP", {
      username,
      slug,
      found: !!match,
      eventTypeId: match?.id || null,
      allSlugs: items.map((x) => x.slug)
    });

    return match?.id || null;
  } catch (err) {
    console.error("EVENT TYPE LOOKUP ERROR:", err?.response?.data || err.message);
    return null;
  }
}

// -------------------- AVAILABILITY (V2) --------------------
async function handleAvailability(req, res, body) {
  const resolved = await resolveCalFromAgent(req, body);

  let username = asString(
    req.headers["x-cal-username"] || body.username || body.args?.username
  );
  let eventTypeSlug = resolveEventTypeSlug(req, body);

  if (!username && resolved?.username) username = resolved.username;
  if (!eventTypeSlug) eventTypeSlug = pickResolvedSlug(body, resolved);

  const args = body.args || body || {};
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
        slug: eventTypeSlug
      }
    });
  }

  const start = asString(
    body.start_date || body.args?.start_date,
    ymd(Date.now())
  );

  const end = asString(
    body.end_date || body.args?.end_date,
    ymd(Date.now() + 7 * 24 * 60 * 60 * 1000)
  );

  const url =
    `https://api.cal.com/v2/slots?username=${encodeURIComponent(username)}` +
    `&eventTypeSlug=${encodeURIComponent(eventTypeSlug)}` +
    `&start=${encodeURIComponent(start)}` +
    `&end=${encodeURIComponent(end)}` +
    `&timeZone=${encodeURIComponent(timeZone)}`;

  try {
    console.log("AVAILABILITY DEBUG", {
      username,
      eventTypeSlug,
      start,
      end,
      timeZone
    });

    const resp = await axios.get(url, {
      headers: getCalHeaders(CAL_API_VERSION_SLOTS)
    });

    const starts = Object.values(resp.data?.data || {})
      .flat()
      .map((s) => s.start)
      .filter(Boolean);

    return json(res, 200, { ok: true, available_slots: starts });
  } catch (err) {
    console.error("CAL AVAILABILITY ERROR:", err?.response?.data || err.message);
    return json(res, 500, {
      error: "Cal fetch failed",
      message: extractCalError(err)
    });
  }
}

// -------------------- BOOK (V2) --------------------
async function handleBook(req, res, body) {
  const resolved = await resolveCalFromAgent(req, body);

  let username = asString(
    req.headers["x-cal-username"] || body.username || body.args?.username
  );
  let eventTypeSlug = resolveEventTypeSlug(req, body);

  if (!username && resolved?.username) username = resolved.username;
  if (!eventTypeSlug) eventTypeSlug = pickResolvedSlug(body, resolved);

  const args = body.args || body || {};
  const start = asString(
    args.start || args.slot || args.selected_start || args.time
  );
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

  const teamSlug = asString(args.teamSlug || args.team_slug || resolved?.teamSlug);
  const organizationSlug = asString(
    args.organizationSlug || args.organization_slug || resolved?.organizationSlug
  );

  if (!start || !name || !email || !eventTypeSlug) {
    return json(res, 400, {
      error: "Missing details",
      debug: {
        hasStart: !!start,
        hasName: !!name,
        hasEmail: !!email,
        username,
        eventTypeSlug
      }
    });
  }

  // Prefer numeric ID whenever possible
  let eventTypeId = null;
  const rawId =
    args.eventTypeId ||
    args.event_type_id ||
    req.headers["x-cal-event-id"];

  if (rawId && !isNaN(rawId)) {
    eventTypeId = Number(rawId);
  } else if (username && eventTypeSlug) {
    eventTypeId = await resolveEventTypeId({ username, slug: eventTypeSlug });
  }

  const payload = {
    start,
    attendee: {
      name,
      email,
      timeZone,
      language: "en",
      ...(phone ? { phoneNumber: phone } : {})
    },
    ...(eventTypeId
      ? { eventTypeId }
      : {
          eventTypeSlug,
          ...(teamSlug ? { teamSlug } : { username }),
          ...(organizationSlug ? { organizationSlug } : {})
        })
  };

  console.log("BOOK DEBUG", {
    service_key: args.service_key || null,
    username,
    eventTypeSlug,
    eventTypeId,
    teamSlug: teamSlug || null,
    organizationSlug: organizationSlug || null,
    payload
  });

  try {
    const resp = await axios.post("https://api.cal.com/v2/bookings", payload, {
      headers: getCalHeaders(CAL_API_VERSION_BOOKINGS)
    });

    return json(res, 200, { ok: true, booking: resp.data });
  } catch (err) {
    console.error("CAL V2 BOOK ERROR:", err?.response?.data || err.message);
    return json(res, 500, {
      error: "Booking failed",
      message: extractCalError(err),
      debug: {
        username,
        eventTypeSlug,
        eventTypeId,
        teamSlug: teamSlug || null,
        organizationSlug: organizationSlug || null,
        calResponse: err?.response?.data || null
      }
    });
  }
}

// -------------------- ROUTER --------------------
module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const body = req.method === "POST" ? await readJsonBody(req) : {};
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action")?.toLowerCase();

  if (req.method === "POST" && action === "availability") {
    return await handleAvailability(req, res, body);
  }

  if (req.method === "POST" && action === "book") {
    return await handleBook(req, res, body);
  }

  return json(res, 400, { error: "Unknown action" });
};
