// /api/cal.js
const axios = require("axios");
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

function getCalRedirectUri() {
  return (
    process.env.CAL_REDIRECT_URI ||
    process.env.CAL_OAUTH_REDIRECT_URI ||
    process.env.CAL_OAUTH_REDIRECT_URL ||
    ""
  );
}

function getCalOauthScopes() {
  return process.env.CAL_OAUTH_SCOPES || "BOOKING_READ BOOKING_WRITE";
}

async function fetchCalMe(accessToken) {
  const resp = await axios.get("https://api.cal.com/v2/me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "cal-api-version": "2024-09-04"
    }
  });

  return resp.data?.data || resp.data || {};
}

// -------------------- OAUTH HANDLERS --------------------
async function handleOauthStart(req, res, url) {
  const agentId = asString(url.searchParams.get("agent_id"));
  const email = asString(url.searchParams.get("email"));

  const clientId = process.env.CAL_CLIENT_ID;
  const redirectUri = getCalRedirectUri();
  const scope = getCalOauthScopes();

  if (!clientId || !redirectUri) {
    return json(res, 500, {
      error: "Missing OAuth env vars",
      version: "ATTENDEE_TIMEZONE_LANG_V3",
      detail: "Need CAL_CLIENT_ID and a redirect URI",
      debug: {
        hasClientId: !!clientId,
        hasRedirectUri: !!redirectUri
      }
    });
  }

  const statePayload = {
    agent_id: agentId,
    email
  };

  const state = Buffer.from(JSON.stringify(statePayload)).toString("base64");

  const authUrl =
    `https://app.cal.com/auth/oauth2/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scope)}` +
    `&state=${encodeURIComponent(state)}`;

  console.log("CAL OAUTH START", {
    version: "ATTENDEE_TIMEZONE_LANG_V3",
    agentId,
    email,
    redirectUri,
    scope
  });

  return redirect(res, authUrl);
}

async function handleOauthCallback(req, res, url) {
  const code = asString(url.searchParams.get("code"));
  const state = asString(url.searchParams.get("state"));

  if (!code) {
    return json(res, 400, {
      error: "Missing code",
      version: "ATTENDEE_TIMEZONE_LANG_V3"
    });
  }

  let decodedState = {};
  try {
    decodedState = JSON.parse(Buffer.from(state, "base64").toString("utf8"));
  } catch {
    decodedState = {};
  }

  const agentId = asString(decodedState.agent_id);
  const email = asString(decodedState.email);

  const clientIdEnv = process.env.CAL_CLIENT_ID;
  const clientSecret = process.env.CAL_CLIENT_SECRET;
  const redirectUri = getCalRedirectUri();

  if (!clientIdEnv || !clientSecret || !redirectUri) {
    return json(res, 500, {
      error: "Missing OAuth env vars",
      version: "ATTENDEE_TIMEZONE_LANG_V3",
      detail: "Need CAL_CLIENT_ID, CAL_CLIENT_SECRET, and redirect URI",
      debug: {
        hasClientId: !!clientIdEnv,
        hasClientSecret: !!clientSecret,
        hasRedirectUri: !!redirectUri
      }
    });
  }

  try {
    const tokenResp = await axios.post(
      "https://api.cal.com/v2/auth/oauth2/token",
      {
        grant_type: "authorization_code",
        code,
        client_id: clientIdEnv,
        client_secret: clientSecret,
        redirect_uri: redirectUri
      },
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    const tokenData = tokenResp.data || {};
    const accessToken = asString(tokenData.access_token);
    const refreshToken = asString(tokenData.refresh_token);

    if (!accessToken) {
      return json(res, 500, {
        error: "OAuth callback failed",
        version: "ATTENDEE_TIMEZONE_LANG_V3",
        message: "No access_token returned from Cal.com"
      });
    }

    const me = await fetchCalMe(accessToken);

    const username =
      asString(me.username) ||
      asString(me.user?.username) ||
      asString(me.defaultUsername);

    const timeZone =
      asString(me.timeZone) ||
      asString(me.timezone) ||
      asString(me.user?.timeZone) ||
      asString(me.user?.timezone);

    let client_id = "";
    let calKey = "";
    let kvSaved = false;

    if (agentId) {
      client_id = asString(await kv.get(`agent:${agentId}:client`), "");

      if (client_id) {
        calKey = `client:${client_id}:cal`;
        const prev = (await kv.get(calKey)) || {};

        await kv.set(calKey, {
          ...prev,
          username: username || prev.username || undefined,
          timeZone: timeZone || prev.timeZone || undefined,
          eventTypeSlug: prev.eventTypeSlug || undefined,
          eventTypeSlugs: prev.eventTypeSlugs || undefined,
          accessToken,
          refreshToken: refreshToken || prev.refreshToken || undefined,
          email: email || prev.email || undefined,
          connected_at: prev.connected_at || new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

        kvSaved = true;
      }
    }

    console.log("CAL OAUTH CALLBACK SUCCESS", JSON.stringify({
      version: "ATTENDEE_TIMEZONE_LANG_V3",
      state: decodedState,
      agentId,
      client_id,
      username,
      timeZone,
      kvSaved,
      calKey
    }, null, 2));

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Calendar Connected</title>
        </head>
        <body style="font-family: Georgia, serif; background: #f8f6f2; color: #123b2f; text-align: center; padding: 60px 24px;">
          <div style="max-width: 620px; margin: 0 auto; background: white; border: 1px solid #d8c27a; padding: 32px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.06);">
            <h1>✅ Calendar Connected</h1>
            <p style="font-size: 20px; line-height: 1.6;">Your calendar authorization was received successfully.</p>
            <p style="font-size: 20px; line-height: 1.6;">You can now return to your email.</p>
            <p style="font-size: 14px; color: #666; margin-top: 18px;">
              ${username ? `Connected account: ${username}` : ""}
            </p>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    console.log("CAL OAUTH CALLBACK ERROR", JSON.stringify({
      version: "ATTENDEE_TIMEZONE_LANG_V3",
      responseStatus: err.response?.status,
      responseData: err.response?.data,
      message: err.message
    }, null, 2));

    return json(res, 500, {
      error: "OAuth callback failed",
      version: "ATTENDEE_TIMEZONE_LANG_V3",
      message: err.response?.data || err.message
    });
  }
}

// -------------------- MAIN HANDLERS --------------------
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

  console.log("CAL AVAILABILITY REQUEST", {
    version: "ATTENDEE_TIMEZONE_LANG_V3",
    username,
    eventTypeSlug,
    start,
    end
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

  console.log("CAL BOOKING REQUEST", JSON.stringify({
    version: "ATTENDEE_TIMEZONE_LANG_V3",
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
    received_action: action || null
  });
};
::contentReference[oaicite:1]{index=1}
