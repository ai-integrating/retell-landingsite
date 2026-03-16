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

function normalizeServiceKey(v = "") {
  return String(v)
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_");
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

// IMPORTANT: old working flow used CAL_OAUTH_REDIRECT_URI
function getCalRedirectUri() {
  return (
    process.env.CAL_OAUTH_REDIRECT_URI ||
    process.env.CAL_REDIRECT_URI ||
    process.env.CAL_OAUTH_REDIRECT_URL ||
    ""
  );
}

// -------------------- AUTO-RESOLVE CAL CONFIG FROM AGENT --------------------
// Reads:
// agent:<agent_id>:client -> client_id
// client:<client_id>:cal  -> { username, eventTypeSlug, eventTypeSlugs, timeZone }
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

// -------------------- OAUTH HANDLERS (FROM OLD WORKING FLOW) --------------------
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

// -------------------- CURRENT AVAILABILITY HANDLER (MINIMALLY PATCHED) --------------------
async function handleAvailability(req, res, body) {
  const resolved = await resolveCalFromAgent(req, body);

  let username = req.headers["x-cal-username"];
  let eventTypeSlug = resolveEventTypeSlug(req, body);

  if (!username && resolved?.username) {
    username = resolved.username;
  }

  if (!eventTypeSlug) {
    eventTypeSlug = pickResolvedSlug(body, resolved);
  }

  if (!username || !eventTypeSlug) {
    return json(res, 400, {
      error: "Missing Client Config",
      detail: "Ensure X-Cal-Username and a valid event slug are provided.",
      debug: {
        hasHeaderUsername: !!req.headers["x-cal-username"],
        hasResolvedUsername: !!resolved?.username,
        hasHeaderOrBodySlug: !!resolveEventTypeSlug(req, body),
        hasResolvedSlug: !!pickResolvedSlug(body, resolved),
        agentId: resolved?.agentId || null,
        clientId: resolved?.clientId || null
      }
    });
  }

  const headers = {
    "cal-api-version": "2024-09-04",
    Authorization: `Bearer ${process.env.CAL_API_KEY}`
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
    `https://api.cal.com/v2/slots?username=${encodeURIComponent(username)}` +
    `&eventTypeSlug=${encodeURIComponent(eventTypeSlug)}` +
    `&start=${encodeURIComponent(start)}` +
    `&end=${encodeURIComponent(end)}`;

  console.log("CAL AVAILABILITY REQUEST", {
    version: "ATTENDEE_TIMEZONE_LANG_V3",
    username,
    eventTypeSlug,
    start,
    end,
    resolvedFromAgent: !!resolved,
    agentId: resolved?.agentId || null,
    clientId: resolved?.clientId || null
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
      version: "ATTENDEE_TIMEZONE_LANG_V3",
      available_slots: starts
    });

  } catch (err) {
    return json(res, 500, {
      error: "Cal fetch failed",
      version: "ATTENDEE_TIMEZONE_LANG_V3",
      message: err.response?.data || err.message
    });
  }
}

// -------------------- CURRENT BOOK HANDLER (MINIMALLY PATCHED) --------------------
async function handleBook(req, res, body) {
  const resolved = await resolveCalFromAgent(req, body);

  let username = req.headers["x-cal-username"];
  let eventTypeSlug = resolveEventTypeSlug(req, body);

  if (!username && resolved?.username) {
    username = resolved.username;
  }

  if (!eventTypeSlug) {
    eventTypeSlug = pickResolvedSlug(body, resolved);
  }

  const args = body.args || body;

  const start = asString(
    args.start ||
    args.slot ||
    args.selected_start
  );

  const name = asString(args.attendee_name || args.name);
  const email = asString(args.attendee_email || args.email);
  const phone = asString(args.phone);

  if (!start || !name || !email || !username || !eventTypeSlug) {
    return json(res, 400, {
      error: "Missing details",
      version: "ATTENDEE_TIMEZONE_LANG_V3",
      debug: {
        hasStart: !!start,
        hasName: !!name,
        hasEmail: !!email,
        hasUser: !!username,
        hasEventSlug: !!eventTypeSlug,
        resolvedFromAgent: !!resolved,
        agentId: resolved?.agentId || null,
        clientId: resolved?.clientId || null,
        body
      }
    });
  }

  const payload = {
    username,
    eventTypeSlug,
    start,
    attendee: {
      name,
      email,
      phoneNumber: phone || undefined,
      timeZone: "America/New_York",
      language: "en"
    }
  };

  const headers = {
    "Content-Type": "application/json",
    "cal-api-version": "2026-02-25",
    Authorization: `Bearer ${process.env.CAL_API_KEY}`
  };

  console.log("CAL BOOKING REQUEST", JSON.stringify({
    version: "ATTENDEE_TIMEZONE_LANG_V3",
    payload,
    resolvedFromAgent: !!resolved,
    agentId: resolved?.agentId || null,
    clientId: resolved?.clientId || null
  }, null, 2));

  try {
    const resp = await axios.post(
      "https://api.cal.com/v2/bookings",
      payload,
      { headers }
    );

    return json(res, 200, {
      ok: true,
      version: "ATTENDEE_TIMEZONE_LANG_V3",
      booking: resp.data
    });

  } catch (err) {
    console.log("CAL BOOKING ERROR", JSON.stringify({
      version: "ATTENDEE_TIMEZONE_LANG_V3",
      payload,
      responseStatus: err.response?.status,
      responseData: err.response?.data,
      message: err.message
    }, null, 2));

    return json(res, 500, {
      error: "Booking failed",
      version: "ATTENDEE_TIMEZONE_LANG_V3",
      message: err.response?.data || err.message,
      debug: {
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
    version: "ATTENDEE_TIMEZONE_LANG_V3",
    received_action: action || null,
    method: req.method
  });
};
