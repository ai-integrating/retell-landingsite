// /api/cal.js
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

function isIsoUtcString(v) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(asString(v));
}

function resolveEventTypeSlug(req, body) {
  const args = body.args || body || {};

  const bodySlug =
    args.eventTypeSlug ||
    args.event_slug ||
    args.eventSlug ||
    args.slug ||
    args.service_key ||
    null;

  const headerSlug = req.headers["x-cal-slug"] || null;

  const chosen = bodySlug || headerSlug || "";
  return normalizeSlug(chosen);
}

function tokenKeyForAgent(agentId) {
  const a = asString(agentId);
  return a ? `cal:tokens:agent:${a}` : "";
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

// -------------------- AUTO-RESOLVE CAL CONFIG FROM AGENT --------------------
async function resolveCalFromAgent(req, body) {
  const args = body.args || body || {};

  const agentId = asString(
    req.headers["x-agent-id"] ||
      body.agent_id ||
      args.agent_id,
    ""
  );

  if (!agentId) return null;

  const clientId = await kv.get(`agent:${agentId}:client`);
  if (!clientId) return null;

  const cal = await kv.get(`client:${clientId}:cal`);
  if (!cal || typeof cal !== "object") {
    return {
      agentId,
      clientId: String(clientId)
    };
  }

  return {
    agentId,
    clientId: String(clientId),
    username: asString(cal.username, ""),
    eventTypeSlug: asString(cal.eventTypeSlug, ""),
    eventTypeSlugs:
      cal.eventTypeSlugs && typeof cal.eventTypeSlugs === "object"
        ? cal.eventTypeSlugs
        : null,
    timeZone: asString(cal.timeZone, "")
  };
}

function pickResolvedSlug(body, resolved) {
  if (!resolved) return "";

  if (resolved.eventTypeSlug) {
    return normalizeSlug(resolved.eventTypeSlug);
  }

  const args = body.args || body || {};
  const serviceKey = normalizeServiceKey(
    args.service_key ||
      args.serviceKey ||
      args.service
  );

  if (
    serviceKey &&
    resolved.eventTypeSlugs &&
    resolved.eventTypeSlugs[serviceKey]
  ) {
    return normalizeSlug(resolved.eventTypeSlugs[serviceKey]);
  }

  return "";
}

function getCalHeaders() {
  return {
    "Content-Type": "application/json",
    "cal-api-version": CAL_API_VERSION,
    Authorization: `Bearer ${process.env.CAL_API_KEY}`
  };
}

function extractCalError(err) {
  return (
    err?.response?.data?.error?.message ||
    err?.response?.data?.message ||
    err?.response?.data ||
    err?.message ||
    "Unknown Cal.com error"
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
        hasRedirectUri: !!redirectUri
      }
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
    redirectUri
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
        hasRedirectUri: !!redirectUri
      }
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
        redirect_uri: redirectUri
      },
      {
        headers: {
          "Content-Type": "application/json",
          "cal-api-version": CAL_API_VERSION
        }
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
        : 0
    };

    if (!tokenPayload.access_token) {
      return json(res, 500, {
        error: "OAuth Exchange Failed",
        detail: "No access_token returned from Cal.com"
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
      storedEmailKey: emailLower ? tokenKeyForEmail(emailLower) : null
    });

    // Fetch authenticated Cal profile to get username/timezone
    let calUsername = "";
    let calTimeZone = "";

    try {
      const meResp = await axios.get("https://api.cal.com/v2/me", {
        headers: {
          Authorization: `Bearer ${tokenPayload.access_token}`,
          "cal-api-version": CAL_API_VERSION
        }
      });

      console.log("CAL /v2/me RESPONSE", JSON.stringify(meResp.data, null, 2));

      const me = meResp.data?.data || meResp.data || {};

      calUsername =
        asString(me.username) ||
        asString(me?.user?.username) ||
        "";

      calTimeZone =
        asString(me.timeZone) ||
        asString(me?.user?.timeZone) ||
        "";
    } catch (profileErr) {
      console.log("CAL PROFILE FETCH ERROR", JSON.stringify({
        agent_id,
        message: extractCalError(profileErr)
      }, null, 2));
    }

    const mappedClientId = await kv.get(`agent:${agent_id}:client`);

    if (mappedClientId && calUsername) {
      const calKey = `client:${mappedClientId}:cal`;
      const prevCal = (await kv.get(calKey)) || {};

      await kv.set(calKey, {
        ...prevCal,
        username: calUsername,
        ...(calTimeZone ? { timeZone: calTimeZone } : {}),
        updated_at: new Date().toISOString()
      });

      const savedCal = await kv.get(calKey);

      console.log("CAL PROFILE STORED", {
        agent_id,
        client_id: String(mappedClientId),
        username: calUsername,
        timeZone: calTimeZone || null,
        calKey
      });

      console.log("CAL SAVED CONFIG", JSON.stringify(savedCal, null, 2));
    } else {
      console.log("CAL PROFILE NOT STORED", {
        agent_id,
        mappedClientId: mappedClientId ? String(mappedClientId) : null,
        calUsername: calUsername || null
      });
    }

    res.writeHead(302, { Location: "https://app.cal.com/event-types" });
    return res.end();
  } catch (err) {
    console.log("CAL OAUTH CALLBACK ERROR", JSON.stringify({
      responseStatus: err.response?.status,
      responseData: err.response?.data,
      message: err.message
    }, null, 2));

    return json(res, 500, {
      error: "OAuth Exchange Failed",
      detail: extractCalError(err)
    });
  }
}

// -------------------- AVAILABILITY --------------------
async function handleAvailability(req, res, body) {
  const resolved = await resolveCalFromAgent(req, body);

  let username = asString(
    req.headers["x-cal-username"] ||
      body.username ||
      body.args?.username
  );

  let eventTypeSlug = resolveEventTypeSlug(req, body);

  if (!username && resolved?.username) username = resolved.username;
  if (!eventTypeSlug) eventTypeSlug = pickResolvedSlug(body, resolved);

  const args = body.args || body || {};
  const timeZone =
    asString(args.timeZone || args.time_zone || body.timeZone) ||
    resolved?.timeZone ||
    "America/New_York";

  console.log("CAL AVAILABILITY INPUT", JSON.stringify({
    rawBody: body,
    resolvedFromAgent: !!resolved,
    agentId: resolved?.agentId || null,
    clientId: resolved?.clientId || null,
    username,
    eventTypeSlug,
    timeZone
  }, null, 2));

  if (!username || !eventTypeSlug) {
    return json(res, 400, {
      error: "Missing Client Config",
      detail: "Ensure X-Cal-Username and a valid event slug are provided.",
      debug: {
        username,
        eventTypeSlug,
        agentId: resolved?.agentId || null,
        clientId: resolved?.clientId || null
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

  console.log("CAL AVAILABILITY REQUEST", JSON.stringify({
    username,
    eventTypeSlug,
    start,
    end,
    timeZone,
    url,
    version: CAL_API_VERSION
  }, null, 2));

  try {
    const resp = await axios.get(url, { headers: getCalHeaders() });

    const slotsByDate = resp.data?.data || {};
    const starts = Object.values(slotsByDate)
      .flat()
      .map((s) => s.start)
      .filter(Boolean);

    console.log("CAL AVAILABILITY RESPONSE", JSON.stringify({
      count: starts.length,
      firstFive: starts.slice(0, 5)
    }, null, 2));

    return json(res, 200, {
      ok: true,
      version: CAL_API_VERSION,
      available_slots: starts
    });
  } catch (err) {
    console.log("CAL AVAILABILITY ERROR", JSON.stringify({
      responseStatus: err.response?.status,
      responseData: err.response?.data,
      message: err.message
    }, null, 2));

    return json(res, 500, {
      error: "Cal fetch failed",
      version: CAL_API_VERSION,
      message: extractCalError(err)
    });
  }
}

// -------------------- BOOK --------------------
async function handleBook(req, res, body) {
  const resolved = await resolveCalFromAgent(req, body);

  let username = asString(
    req.headers["x-cal-username"] ||
      body.username ||
      body.args?.username
  );

  let eventTypeSlug = resolveEventTypeSlug(req, body);

  if (!username && resolved?.username) username = resolved.username;
  if (!eventTypeSlug) eventTypeSlug = pickResolvedSlug(body, resolved);

  const args = body.args || body || {};

  const start = asString(
    args.start ||
      args.slot ||
      args.selected_start
  );

  const name = asString(args.attendee_name || args.name);
  const email = asString(args.attendee_email || args.email).toLowerCase();
  const phone = asString(args.phone || args.phoneNumber);
  const attendeeTimeZone =
    asString(args.timeZone || args.time_zone) ||
    resolved?.timeZone ||
    "America/New_York";
  const attendeeLanguage = asString(args.language, "en");

  console.log("CAL BOOK INPUT", JSON.stringify({
    rawBody: body,
    resolvedFromAgent: !!resolved,
    agentId: resolved?.agentId || null,
    clientId: resolved?.clientId || null,
    username,
    eventTypeSlug,
    start,
    name,
    email,
    attendeeTimeZone
  }, null, 2));

  if (!start || !name || !email || !username || !eventTypeSlug) {
    return json(res, 400, {
      error: "Missing details",
      version: CAL_API_VERSION,
      debug: {
        hasStart: !!start,
        hasName: !!name,
        hasEmail: !!email,
        hasUser: !!username,
        hasEventSlug: !!eventTypeSlug,
        resolvedFromAgent: !!resolved,
        agentId: resolved?.agentId || null,
        clientId: resolved?.clientId || null
      }
    });
  }

  if (!isValidEmail(email)) {
    return json(res, 400, {
      error: "Invalid attendee email",
      version: CAL_API_VERSION,
      debug: { email }
    });
  }

  if (!isIsoUtcString(start)) {
    return json(res, 400, {
      error: "Invalid start",
      detail: "start must be an ISO 8601 UTC string like 2026-03-18T15:00:00Z",
      version: CAL_API_VERSION,
      debug: { start }
    });
  }

  const payload = {
    start,
    attendee: {
      name,
      email,
      ...(phone ? { phoneNumber: phone } : {}),
      timeZone: attendeeTimeZone,
      language: attendeeLanguage
    },
    eventTypeSlug,
    username
  };

  console.log("CAL BOOK REQUEST", JSON.stringify({
    payload,
    version: CAL_API_VERSION
  }, null, 2));

  try {
    const resp = await axios.post(
      "https://api.cal.com/v2/bookings",
      payload,
      { headers: getCalHeaders() }
    );

    console.log("CAL BOOK RESPONSE", JSON.stringify(resp.data, null, 2));

    return json(res, 200, {
      ok: true,
      version: CAL_API_VERSION,
      booking: resp.data
    });
  } catch (err) {
    console.log("CAL BOOK ERROR", JSON.stringify({
      responseStatus: err.response?.status,
      responseData: err.response?.data,
      message: err.message
    }, null, 2));

    return json(res, 500, {
      error: "Booking failed",
      version: CAL_API_VERSION,
      message: extractCalError(err),
      debug: { payload }
    });
  }
}

// -------------------- ROUTER --------------------
module.exports = async (req, res) => {
  console.log("CAL HIT", JSON.stringify({
    method: req.method,
    url: req.url,
    host: req.headers.host
  }, null, 2));

  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const body = req.method === "POST" ? await readJsonBody(req) : {};
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action")?.toLowerCase();

  console.log("CAL ACTION", JSON.stringify({
    action: action || null,
    method: req.method,
    body
  }, null, 2));

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
    version: CAL_API_VERSION,
    received_action: action || null,
    method: req.method
  });
};
