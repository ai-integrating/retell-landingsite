// /api/cal.js
const axios = require("axios");

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

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.end();
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

// -------------------- OAUTH --------------------
async function handleOauthStart(req, res, url) {
  const agentId = url.searchParams.get("agent_id") || "";
  const email = url.searchParams.get("email") || "";

  const statePayload = {
    agent_id: agentId,
    email
  };

  const state = Buffer.from(JSON.stringify(statePayload)).toString("base64");

  const clientId = process.env.CAL_CLIENT_ID;
  const redirectUri = process.env.CAL_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return json(res, 500, {
      error: "Missing OAuth env vars",
      need: ["CAL_CLIENT_ID", "CAL_REDIRECT_URI"]
    });
  }

  const authUrl =
    `https://cal.com/api/oauth/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent("default")}` +
    `&state=${encodeURIComponent(state)}`;

  return redirect(res, authUrl);
}

async function handleOauthCallback(req, res, url) {
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";

  if (!code) {
    return json(res, 400, { error: "Missing code" });
  }

  let decodedState = {};
  try {
    decodedState = JSON.parse(Buffer.from(state, "base64").toString("utf8"));
  } catch {
    decodedState = {};
  }

  try {
    const tokenResp = await axios.post(
      "https://cal.com/api/oauth/token",
      {
        grant_type: "authorization_code",
        code,
        client_id: process.env.CAL_CLIENT_ID,
        client_secret: process.env.CAL_CLIENT_SECRET,
        redirect_uri: process.env.CAL_REDIRECT_URI
      },
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    // TODO:
    // Save tokenResp.data plus decodedState.agent_id / decodedState.email
    // into your KV, database, or wherever you store client calendar config.

    return json(res, 200, {
      ok: true,
      message: "OAuth connected successfully",
      state: decodedState,
      token_received: !!tokenResp.data
    });
  } catch (err) {
    return json(res, 500, {
      error: "OAuth callback failed",
      message: err.response?.data || err.message
    });
  }
}

// -------------------- AVAILABILITY --------------------
async function handleAvailability(req, res, body) {
  const username = req.headers["x-cal-username"];
  const eventTypeSlug = resolveEventTypeSlug(req, body);

  if (!username || !eventTypeSlug) {
    return json(res, 400, {
      error: "Missing Client Config",
      detail: "Ensure X-Cal-Username and a valid event slug are provided."
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

  try {
    const resp = await axios.get(url, { headers });

    const slotsByDate = resp.data?.data || {};
    const starts = Object.values(slotsByDate)
      .flat()
      .map((s) => s.start)
      .filter(Boolean);

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

// -------------------- BOOK --------------------
async function handleBook(req, res, body) {
  const username = req.headers["x-cal-username"];
  const eventTypeSlug = resolveEventTypeSlug(req, body);

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
    return json(res, 500, {
      error: "Booking failed",
      version: "ATTENDEE_TIMEZONE_LANG_V3",
      message: err.response?.data || err.message,
      debug: { payload }
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
  const action = url.searchParams.get("action")?.toLowerCase() || "";

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

  return json(res, 400, {
    error: "Unknown action",
    version: "ATTENDEE_TIMEZONE_LANG_V3",
    received_action: action,
    received_url: req.url
  });
};
