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

function getCalRedirectUri() {
  return (
    process.env.CAL_OAUTH_REDIRECT_URI ||
    process.env.CAL_REDIRECT_URI ||
    process.env.CAL_OAUTH_REDIRECT_URL ||
    ""
  );
}

// -------------------- TOKEN HELPERS --------------------
async function getCalAccessTokenForAgent(agentId) {
  const key = tokenKeyForAgent(agentId);
  if (!key) return null;

  const tokenRecord = await kv.get(key);
  if (!tokenRecord || typeof tokenRecord !== "object") return null;

  const accessToken = asString(tokenRecord.access_token);
  if (!accessToken) return null;

  return {
    accessToken,
    refreshToken: asString(tokenRecord.refresh_token),
    tokenType: asString(tokenRecord.token_type, "bearer"),
    expiresAt: Number(tokenRecord.expires_at || 0),
  };
}

async function getCalHeadersForAgent(agentId) {
  const token = await getCalAccessTokenForAgent(agentId);

  if (token?.accessToken) {
    return {
      headers: {
        "Content-Type": "application/json",
        "cal-api-version": CAL_API_VERSION,
        Authorization: `Bearer ${token.accessToken}`,
      },
      authMode: "oauth_token",
    };
  }

  return {
    headers: {
      "Content-Type": "application/json",
      "cal-api-version": CAL_API_VERSION,
      Authorization: `Bearer ${process.env.CAL_API_KEY}`,
    },
    authMode: "api_key",
  };
}

// -------------------- DEBUG --------------------
async function handleDebugLookup(req, res, url) {
  const agent_id = asString(url.searchParams.get("agent_id"));
  if (!agent_id) {
    return json(res, 400, { ok: false, error: "agent_id param required" });
  }

  const key = `agent:${agent_id}:client`;
  const value = await kv.get(key);

  // If we found a client ID, let's also look up the cal config
  let calConfig = null;
  if (value) {
    calConfig = await kv.get(`client:${value}:cal`);
  }

  return json(res, 200, {
    ok: true,
    agent_id,
    lookup_key: key,
    client_id: value,
    cal_config: calConfig,
    kv_url_present: !!process.env.KV_REST_API_URL,
  });
}

// -------------------- OAUTH HANDLERS --------------------
async function handleOauthStart(req, res, url) {
  const agent_id = asString(url.searchParams.get("agent_id"));
  const email = asString(url.searchParams.get("email"));

  if (!agent_id) {
    return json(res, 400, { error: "agent_id param required" });
  }

  const clientId = process.env.CAL_CLIENT_ID;
  const redirectUri = getCalRedirectUri();

  if (!clientId || !redirectUri) {
    return json(res, 500, {
      error: "Missing CAL_CLIENT_ID or CAL_OAUTH_REDIRECT_URI",
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

  res.writeHead(302, { Location: authUrl });
  return res.end();
}

async function handleOauthCallback(req, res, url) {
  const code = asString(url.searchParams.get("code"));
  const state = asString(url.searchParams.get("state"));

  if (!code || !state) {
    return json(res, 400, { error: "Missing code/state" });
  }

  const stateRecord = await kv.get(`cal:oauth:state:${state}`);
  if (!stateRecord?.agent_id) {
    return json(res, 400, { error: "Invalid or expired state" });
  }

  await kv.del(`cal:oauth:state:${state}`);

  try {
    const tokenResp = await axios.post(
      "https://api.cal.com/v2/auth/oauth2/token",
      {
        client_id: process.env.CAL_CLIENT_ID,
        client_secret: process.env.CAL_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: getCalRedirectUri(),
      }
    );

    const data = tokenResp.data || {};
    const agent_id = asString(stateRecord.agent_id);
    
    const tokenPayload = {
      access_token: asString(data.access_token),
      refresh_token: asString(data.refresh_token),
      token_type: asString(data.token_type, "bearer"),
      expires_at: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : 0,
    };

    await kv.set(tokenKeyForAgent(agent_id), tokenPayload);

    // --- UPDATED: FETCH PROFILE AND SLUGS ---
    const lookupKey = `agent:${agent_id}:client`;
    const mappedClientId = asString(await kv.get(lookupKey), "");

    if (mappedClientId) {
      const calHeaders = {
        Authorization: `Bearer ${tokenPayload.access_token}`,
        "Content-Type": "application/json",
        "cal-api-version": CAL_API_VERSION,
      };

      // 1. Get Username/Timezone
      const meResp = await axios.get("https://api.cal.com/v2/me", { headers: calHeaders });
      const me = meResp?.data?.data || {};
      const username = asString(me.username, "");
      const timeZone = asString(me.timeZone || me.timezone || "America/New_York");

      // 2. Get Event Type Slugs (The fix!)
      const etResp = await axios.get("https://api.cal.com/v1/event-types", {
          params: { apiKey: tokenPayload.access_token } 
      });
      const eventTypes = etResp?.data?.event_types || [];
      const eventTypeSlug = eventTypes.length > 0 ? eventTypes[0].slug : "";

      const calKey = `client:${mappedClientId}:cal`;
      const prevCalRaw = await kv.get(calKey);
      const prevCal = (prevCalRaw && typeof prevCalRaw === 'object') ? prevCalRaw : {};

      const nextCal = {
        ...prevCal,
        ...(username ? { username } : {}),
        ...(timeZone ? { timeZone } : {}),
        ...(eventTypeSlug ? { eventTypeSlug } : {}),
        updated_at: new Date().toISOString(),
      };

      await kv.set(calKey, nextCal);
    }

    res.writeHead(302, { Location: "https://app.cal.com/event-types" });
    return res.end();
  } catch (err) {
    return json(res, 500, { error: "OAuth Exchange Failed", detail: err.message });
  }
}

// -------------------- RESOLVERS --------------------
async function resolveCalFromAgent(req, body) {
  const args = body.args || body || {};
  const agentId = asString(req.headers["x-agent-id"] || body.agent_id || args.agent_id, "");
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
    eventTypeSlug: asString(cal.eventTypeSlug || cal.event_type_slug, ""),
    timeZone: asString(cal.timeZone || cal.time_zone, "America/New_York"),
  };
}

function resolveEventTypeSlug(req, body, resolved) {
  const args = body.args || body || {};
  const explicitSlug = args.eventTypeSlug || args.event_slug || args.slug || "";
  if (explicitSlug) return normalizeSlug(explicitSlug);
  return normalizeSlug(resolved?.eventTypeSlug || "");
}

// -------------------- MAIN HANDLERS --------------------
async function handleAvailability(req, res, body) {
  const resolved = await resolveCalFromAgent(req, body);
  const args = body.args || body || {};
  const username = asString(resolved?.username);
  const eventTypeSlug = resolveEventTypeSlug(req, body, resolved);

  if (!username || !eventTypeSlug) {
    return json(res, 400, { error: "Missing Client Config", debug: { username, eventTypeSlug } });
  }

  const start = asString(args.start_date, ymd(Date.now()));
  const end = asString(args.end_date, ymd(Date.now() + 7 * 24 * 60 * 60 * 1000));
  const timeZone = asString(args.timeZone) || resolved?.timeZone || "America/New_York";

  const url = `https://api.cal.com/v2/slots?username=${username}&eventTypeSlug=${eventTypeSlug}&start=${start}&end=${end}&timeZone=${timeZone}`;

  try {
    const { headers } = await getCalHeadersForAgent(resolved?.agentId);
    const resp = await axios.get(url, { headers });
    const starts = Object.values(resp.data?.data || {}).flat().map((s) => s.start).filter(Boolean);
    return json(res, 200, { ok: true, available_slots: starts });
  } catch (err) {
    return json(res, 500, { error: "Cal fetch failed", message: extractCalError(err) });
  }
}

async function handleBook(req, res, body) {
  const resolved = await resolveCalFromAgent(req, body);
  const args = body.args || body || {};
  const username = asString(resolved?.username);
  const eventTypeSlug = resolveEventTypeSlug(req, body, resolved);

  const start = asString(args.start || args.slot);
  const name = asString(args.name);
  const email = asString(args.email).toLowerCase();

  if (!start || !name || !email || !username || !eventTypeSlug) {
    return json(res, 400, { error: "Missing details", debug: { username, eventTypeSlug } });
  }

  const v1Payload = {
    start, name, email, username, eventTypeSlug,
    timeZone: resolved?.timeZone || "America/New_York",
    language: "en",
    metadata: {}
  };

  try {
    const token = await getCalAccessTokenForAgent(resolved?.agentId);
    const config = token?.accessToken 
      ? { headers: { Authorization: `Bearer ${token.accessToken}`, "Content-Type": "application/json" } }
      : { params: { apiKey: process.env.CAL_API_KEY } };

    const resp = await axios.post("https://api.cal.com/v1/bookings", v1Payload, config);
    return json(res, 200, { ok: true, booking: resp.data });
  } catch (err) {
    return json(res, 500, { error: "Booking failed", message: extractCalError(err) });
  }
}

// -------------------- ROUTER --------------------
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action")?.toLowerCase();

  if (action === "oauth_start") return await handleOauthStart(req, res, url);
  if (action === "oauth_callback") return await handleOauthCallback(req, res, url);
  if (action === "debug_lookup") return await handleDebugLookup(req, res, url);

  const body = req.method === "POST" ? await readJsonBody(req) : {};
  if (action === "availability") return await handleAvailability(req, res, body);
  if (action === "book") return await handleBook(req, res, body);

  return json(res, 400, { error: "Unknown action" });
};
