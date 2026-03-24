// /api/cal.js
const axios = require("axios");
const crypto = require("crypto");
const { kv } = require("@vercel/kv");

const CAL_API_VERSION = "2024-09-04";
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
  const defaultHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "cal-api-version": CAL_API_VERSION
  };

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

  // 1) Personal event types
  try {
    const etResp = await axios.get("https://api.cal.com/v2/event-types", {
      headers: eventTypeHeaders
    });

    console.log("CAL PERSONAL EVENT TYPES RAW", JSON.stringify(etResp.data, null, 2));
    addRows(extractEventTypeRows(etResp.data));
  } catch (err) {
    console.log("CAL PERSONAL EVENT TYPES ERROR", JSON.stringify({
      responseStatus: err.response?.status,
      responseData: err.response?.data,
      message: err.message
    }, null, 2));
  }

  // 2) Team fallback
  try {
    const teamsResp = await axios.get("https://api.cal.com/v2/teams", {
      headers: defaultHeaders
    });

    console.log("CAL TEAMS RAW", JSON.stringify(teamsResp.data, null, 2));

    const teamRows = extractTeamRows(teamsResp.data);

    for (const team of teamRows) {
      const teamId = team?.id;
      if (!teamId) continue;

      try {
        const teamEtResp = await axios.get(
          `https://api.cal.com/v2/teams/${teamId}/event-types`,
          { headers: defaultHeaders }
        );

        console.log(
          `CAL TEAM EVENT TYPES RAW teamId=${teamId}`,
          JSON.stringify(teamEtResp.data, null, 2)
        );

        addRows(extractEventTypeRows(teamEtResp.data));
      } catch (teamErr) {
        console.log("CAL TEAM EVENT TYPES ERROR", JSON.stringify({
          teamId,
          responseStatus: teamErr.response?.status,
          responseData: teamErr.response?.data,
          message: teamErr.message
        }, null, 2));
      }
    }
  } catch (teamsErr) {
    console.log("CAL TEAMS FETCH ERROR", JSON.stringify({
      responseStatus: teamsErr.response?.status,
      responseData: teamsErr.response?.data,
      message: teamsErr.message
    }, null, 2));
  }

  return slugMap;
}

async function resolveCalContext(req, body) {
  const args = body.args || body || {};
  const agentId = asString(
    req.headers["x-agent-id"] ||
    body.agent_id ||
    args.agent_id
  );

  if (!agentId) {
    return { error: "Missing agent_id" };
  }

  const clientId = await kv.get(`agent:${agentId}:client`);
  if (!clientId) {
    return { error: "No client_id found for agent", agentId };
  }

  const calConfig = await kv.get(`client:${clientId}:cal`);
  if (!calConfig || !calConfig.username) {
    return { error: "No Cal config found for client", agentId, clientId };
  }

  const token = await kv.get(tokenKeyForAgent(agentId));
  if (!token?.access_token) {
    return { error: "No OAuth token found for agent", agentId, clientId };
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
  const eventTypeSlug =
    calConfig?.eventTypeSlugs?.[serviceKey] ||
    normalizeSlug(rawServiceKey);

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
          "Content-Type": "application/json"
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

    // -------------------- AUTO ENRICH CLIENT CONFIG --------------------
    try {
      const accessToken = tokenPayload.access_token;
      const client_id = await kv.get(`agent:${agent_id}:client`);

      const meResp = await axios.get("https://api.cal.com/v2/me", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "cal-api-version": CAL_API_VERSION
        }
      });

      const username = asString(meResp.data?.data?.username);

      if (client_id && username) {
        const existingConfig = (await kv.get(`client:${client_id}:cal`)) || {};

        let eventTypeSlugs = existingConfig.eventTypeSlugs || {};
        const fetchedSlugs = await fetchAllEventTypeSlugs(accessToken);

        if (Object.keys(fetchedSlugs).length > 0) {
          eventTypeSlugs = fetchedSlugs;
        }

        await kv.set(`client:${client_id}:cal`, {
          ...existingConfig,
          username,
          timeZone: asString(existingConfig.timeZone, "America/New_York"),
          eventTypeSlugs,
          updated_at: new Date().toISOString()
        });

        console.log("CAL CONFIG SAVED", {
          agent_id,
          client_id,
          username,
          eventTypeSlugs
        });
      } else {
        console.log("CAL CONFIG SAVE SKIPPED", {
          agent_id,
          client_id,
          username
        });
      }
    } catch (enrichErr) {
      console.log("CAL CONFIG ENRICH ERROR", JSON.stringify({
        responseStatus: enrichErr.response?.status,
        responseData: enrichErr.response?.data,
        message: enrichErr.message
      }, null, 2));
    }

    console.log("CAL OAUTH CALLBACK SUCCESS", {
      agent_id,
      emailLower: emailLower || null,
      storedAgentKey: tokenKeyForAgent(agent_id),
      storedEmailKey: emailLower ? tokenKeyForEmail(emailLower) : null
    });

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
      detail: err.response?.data || err.message
    });
  }
}

// -------------------- AUTOMATED AVAILABILITY HANDLER --------------------
async function handleAvailability(req, res, body) {
  const ctx = await resolveCalContext(req, body);

  if (ctx.error) {
    return json(res, 400, {
      error: ctx.error,
      debug: ctx
    });
  }

  if (!ctx.username || !ctx.eventTypeSlug) {
    return json(res, 400, {
      error: "Missing Client Config",
      detail: "Could not resolve username or eventTypeSlug from agent_id",
      debug: {
        agentId: ctx.agentId,
        clientId: ctx.clientId,
        username: ctx.username,
        eventTypeSlug: ctx.eventTypeSlug,
        serviceKey: ctx.serviceKey
      }
    });
  }

  const headers = {
    "cal-api-version": CAL_API_VERSION,
    Authorization: `Bearer ${ctx.accessToken}`
  };

  const start = asString(
    body.start_date || body.args?.start_date,
    ymd(Date.now())
  );

  const end = asString(
    body.end_date || body.args?.end_date,
    ymd(Date.now() + 7 * 24 * 60 * 60 * 1000)
  );

  const url =
    `https://api.cal.com/v2/slots?username=${encodeURIComponent(ctx.username)}` +
    `&eventTypeSlug=${encodeURIComponent(ctx.eventTypeSlug)}` +
    `&start=${encodeURIComponent(start)}` +
    `&end=${encodeURIComponent(end)}` +
    `&timeZone=${encodeURIComponent(ctx.timeZone)}`;

  console.log("CAL AVAILABILITY REQUEST", {
    version: "AUTOMATED_AGENT_CONTEXT_V1",
    agentId: ctx.agentId,
    clientId: ctx.clientId,
    username: ctx.username,
    eventTypeSlug: ctx.eventTypeSlug,
    serviceKey: ctx.serviceKey,
    start,
    end,
    timeZone: ctx.timeZone
  });

  try {
    const resp = await axios.get(url, { headers });

    const slotsByDate = resp.data?.data || {};
    const starts = Object.values(slotsByDate)
      .flat()
      .map((s) => s.start)
      .filter(Boolean);

    console.log("CAL RAW RESPONSE DATA", JSON.stringify(resp.data?.data || {}, null, 2));
    console.log("CAL AVAILABLE SLOT COUNT", starts.length);
    console.log("CAL FIRST 5 SLOTS", starts.slice(0, 5));

    return json(res, 200, {
      ok: true,
      version: "AUTOMATED_AGENT_CONTEXT_V1",
      agent_id: ctx.agentId,
      client_id: ctx.clientId,
      username: ctx.username,
      eventTypeSlug: ctx.eventTypeSlug,
      service_key: ctx.serviceKey,
      available_slots: starts
    });
  } catch (err) {
    return json(res, 500, {
      error: "Cal fetch failed",
      version: "AUTOMATED_AGENT_CONTEXT_V1",
      message: err.response?.data || err.message
    });
  }
}

// -------------------- AUTOMATED BOOK HANDLER --------------------
async function handleBook(req, res, body) {
  const ctx = await resolveCalContext(req, body);

  if (ctx.error) {
    return json(res, 400, {
      error: ctx.error,
      debug: ctx
    });
  }

  const args = body.args || body;

  const rawStart = asString(
    args.start ||
    args.slot ||
    args.selected_start
  );

  const name = asString(args.attendee_name || args.name);
  const email = asString(args.attendee_email || args.email);
  const phone = asString(args.phone);

  if (!rawStart || !name || !email || !ctx.username || !ctx.eventTypeSlug) {
    return json(res, 400, {
      error: "Missing details",
      version: "AUTOMATED_AGENT_CONTEXT_V1",
      debug: {
        hasStart: !!rawStart,
        hasName: !!name,
        hasEmail: !!email,
        hasUser: !!ctx.username,
        hasEventSlug: !!ctx.eventTypeSlug,
        agentId: ctx.agentId,
        clientId: ctx.clientId,
        serviceKey: ctx.serviceKey,
        body
      }
    });
  }

  const parsedStart = new Date(rawStart);
  if (Number.isNaN(parsedStart.getTime())) {
    return json(res, 400, {
      error: "Invalid start datetime",
      version: "AUTOMATED_AGENT_CONTEXT_V1",
      debug: { rawStart }
    });
  }

  const start = parsedStart.toISOString();

  const payload = {
    username: ctx.username,
    eventTypeSlug: ctx.eventTypeSlug,
    start,
    attendee: {
      name,
      email,
      phoneNumber: phone || undefined,
      timeZone: ctx.timeZone,
      language: "en"
    }
  };

  const headers = {
    "Content-Type": "application/json",
    "cal-api-version": CAL_BOOKINGS_API_VERSION,
    Authorization: `Bearer ${ctx.accessToken}`
  };

  console.log("CAL BOOKING REQUEST", JSON.stringify({
    version: "AUTOMATED_AGENT_CONTEXT_V1",
    agentId: ctx.agentId,
    clientId: ctx.clientId,
    serviceKey: ctx.serviceKey,
    rawStart,
    utcStart: start,
    payload
  }, null, 2));

  try {
    const resp = await axios.post(
      "https://api.cal.com/v2/bookings",
      payload,
      { headers }
    );

    return json(res, 200, {
      ok: true,
      version: "AUTOMATED_AGENT_CONTEXT_V1",
      booking: resp.data
    });
  } catch (err) {
    console.log("CAL BOOKING ERROR", JSON.stringify({
      version: "AUTOMATED_AGENT_CONTEXT_V1",
      agentId: ctx.agentId,
      clientId: ctx.clientId,
      serviceKey: ctx.serviceKey,
      rawStart,
      utcStart: start,
      payload,
      responseStatus: err.response?.status,
      responseData: err.response?.data,
      message: err.message
    }, null, 2));

    return json(res, 500, {
      error: "Booking failed",
      version: "AUTOMATED_AGENT_CONTEXT_V1",
      message: err.response?.data || err.message,
      debug: {
        rawStart,
        utcStart: start,
        payload
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
    version: "AUTOMATED_AGENT_CONTEXT_V1",
    received_action: action || null,
    method: req.method
  });
};
