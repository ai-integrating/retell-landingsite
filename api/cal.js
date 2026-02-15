// /api/cal.js
// ONE file that supports:
// - OAuth connect:  GET  /api/cal?action=oauth_start&agent_id=...&email=... (email optional)
// - OAuth callback: GET  /api/cal?action=oauth_callback&code=...&state=...
// - Availability:   POST /api/cal?action=availability   (or action=slots)   (agent_id preferred)
// - Book:           POST /api/cal?action=book          (agent_id preferred)
// - Auto-book:      POST /api/cal?action=auto          (or action=autobook) (agent_id preferred)
//
// NOTES:
// - Uses OAuth access token from KV when connected; otherwise falls back to CAL_API_KEY.
// - Stores tokens in KV under: cal:tokens:agent:<agent_id>
// - Keeps backward-compatible email token keys: cal:tokens:<emailLower> (fallback only)
// - Uses env var CAL_OAUTH_REDIRECT_URI (must EXACTLY match what you set in Cal.com OAuth client).

const axios = require("axios");
const crypto = require("crypto");
const { kv } = require("@vercel/kv");

// -------------------- CORS & RESPONSES --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Idempotency-Key"
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

function asString(v, fallback = "") {
  return v === undefined || v === null ? fallback : String(v).trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(asString(email));
}

function ymd(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function tokenKeyForAgent(agentId) {
  const a = asString(agentId);
  return a ? `cal:tokens:agent:${a}` : "";
}

function tokenKeyForEmail(email) {
  const e = asString(email).toLowerCase();
  return e ? `cal:tokens:${e}` : "";
}

// -------------------- OAuth TOKEN STORAGE + REFRESH --------------------
// Refresh by agent_id (preferred). Falls back to email if needed.
async function handleRefresh({ agent_id, email }) {
  const agentKey = tokenKeyForAgent(agent_id);
  const emailKey = tokenKeyForEmail(email);

  const record =
    (agentKey ? await kv.get(agentKey) : null) ||
    (emailKey ? await kv.get(emailKey) : null);

  if (!record?.refresh_token) return null;

  const resp = await axios.post("https://api.cal.com/v2/auth/oauth2/token", {
    client_id: process.env.CAL_CLIENT_ID,
    client_secret: process.env.CAL_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: record.refresh_token,
  });

  const data = resp.data || {};
  const access_token = data.access_token;
  const refresh_token = data.refresh_token || record.refresh_token;
  const expires_in = Number(data.expires_in || 0);

  if (!access_token) return null;

  const updated = {
    access_token,
    refresh_token,
    token_type: data.token_type || record.token_type || "bearer",
    expires_at: expires_in ? Date.now() + expires_in * 1000 : 0,
  };

  // Save back to the same place we found it, preferring agent key if present
  if (agentKey) {
    await kv.set(agentKey, updated);
  } else if (emailKey) {
    await kv.set(emailKey, updated);
  }

  return updated;
}

// Returns headers using OAuth token if connected; else uses CAL_API_KEY
// Prefers agent_id token store; falls back to email token store.
async function getHeaders({ agent_id, email }) {
  const base = { "cal-api-version": "2024-09-04" };
  const fallback = {
    ...base,
    Authorization: `Bearer ${process.env.CAL_API_KEY}`,
  };

  const agentKey = tokenKeyForAgent(agent_id);
  const emailKey = tokenKeyForEmail(email);

  const tokens =
    (agentKey ? await kv.get(agentKey) : null) ||
    (emailKey ? await kv.get(emailKey) : null);

  if (!tokens?.access_token) return fallback;

  const expiresAt = Number(tokens.expires_at || 0);
  const stillValid = !expiresAt || expiresAt > Date.now() + 60_000; // 60s buffer

  if (stillValid) {
    return { ...base, Authorization: `Bearer ${tokens.access_token}` };
  }

  // Expired -> refresh
  const refreshed = await handleRefresh({ agent_id, email });
  if (refreshed?.access_token) {
    return { ...base, Authorization: `Bearer ${refreshed.access_token}` };
  }

  return fallback;
}

// -------------------- OAUTH (START + CALLBACK) --------------------
async function handleOAuthStart(req, res) {
  const agent_id = asString(req.query.agent_id);
  const email = asString(req.query.email); // optional

  if (!agent_id) {
    return json(res, 400, { error: "agent_id param required" });
  }
  if (email && !isValidEmail(email)) {
    return json(res, 400, { error: "If provided, email must be valid" });
  }

  const clientId = process.env.CAL_CLIENT_ID;
  const redirectUri = process.env.CAL_OAUTH_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return json(res, 500, { error: "Missing CAL_CLIENT_ID or CAL_OAUTH_REDIRECT_URI" });
  }

  // CSRF nonce stored server-side for 10 minutes
  const nonce = crypto.randomBytes(16).toString("hex");
  await kv.set(
    `cal:oauth:state:${nonce}`,
    { agent_id, email: email || "" },
    { ex: 600 }
  );

  // Cal authorize endpoint
  const authUrl =
    `https://app.cal.com/auth/oauth2/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(nonce)}`;

  res.writeHead(302, { Location: authUrl });
  res.end();
}

async function handleOAuthCallback(req, res) {
  const { code, state, error, error_description } = req.query || {};

  // ✅ UPDATED: Redirect on error (instead of JSON)
  if (error) {
    const loc =
      "https://retell-landingsite-iota.vercel.app/cal-error" +
      `?error=${encodeURIComponent(asString(error))}` +
      `&desc=${encodeURIComponent(asString(error_description))}`;
    res.writeHead(302, { Location: loc });
    return res.end();
  }

  if (!code || !state) return json(res, 400, { error: "Missing code/state" });

  const stateRecord = await kv.get(`cal:oauth:state:${asString(state)}`);
  if (!stateRecord?.agent_id) {
    return json(res, 400, { error: "Invalid or expired state" });
  }

  // one-time use
  await kv.del(`cal:oauth:state:${asString(state)}`);

  const clientId = process.env.CAL_CLIENT_ID;
  const clientSecret = process.env.CAL_CLIENT_SECRET;
  const redirectUri = process.env.CAL_OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return json(res, 500, {
      error: "Missing CAL_CLIENT_ID / CAL_CLIENT_SECRET / CAL_OAUTH_REDIRECT_URI",
    });
  }

  try {
    const tokenResp = await axios.post("https://api.cal.com/v2/auth/oauth2/token", {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code: asString(code),
      redirect_uri: redirectUri,
    });

    const data = tokenResp.data || {};
    const agent_id = asString(stateRecord.agent_id);
    const emailLower = asString(stateRecord.email).toLowerCase();

    const tokenPayload = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || "",
      token_type: data.token_type || "bearer",
      expires_at: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : 0,
    };

    // ✅ Primary: store by agent_id
    await kv.set(tokenKeyForAgent(agent_id), tokenPayload);

    // ✅ Optional fallback: if email exists, ALSO store under email to avoid breaking older calls
    if (emailLower && isValidEmail(emailLower)) {
      await kv.set(tokenKeyForEmail(emailLower), tokenPayload);
    }

    // ✅ UPDATED: Redirect success into Cal so they can create Event Types
    res.writeHead(302, { Location: "https://app.cal.com/event-types" });
    return res.end();
  } catch (err) {
    return json(res, 500, {
      error: "OAuth Exchange Failed",
      detail: err.response?.data || err.message,
    });
  }
}

// -------------------- CAL ACTIONS (AVAILABILITY / BOOK / AUTO) --------------------
async function handleAvailability(req, res, body) {
  const agent_id = asString(req.query.agent_id || body.agent_id);
  const email = asString(req.query.email || body.email);
  const headers = await getHeaders({ agent_id, email });

  const username = process.env.CAL_USERNAME || "ai-integrating";
  const eventTypeSlug = process.env.CAL_EVENT_SLUG || "ai-intake-call-test";

  const start = asString(body.start_date, ymd(Date.now()));
  const end = asString(body.end_date, ymd(Date.now() + 7 * 24 * 60 * 60 * 1000));

  const url =
    `https://api.cal.com/v2/slots` +
    `?username=${encodeURIComponent(username)}` +
    `&eventTypeSlug=${encodeURIComponent(eventTypeSlug)}` +
    `&start=${encodeURIComponent(start)}` +
    `&end=${encodeURIComponent(end)}`;

  const resp = await axios.get(url, { headers });
  return json(res, 200, {
    ok: true,
    slots: resp.data?.data || resp.data,
    agent_id: agent_id || undefined,
  });
}

async function handleBook(req, res, body) {
  const agent_id = asString(req.query.agent_id || body.agent_id);
  const email = asString(req.query.email || body.email);
  const headers = await getHeaders({ agent_id, email });

  const username = process.env.CAL_USERNAME || "ai-integrating";
  const eventTypeSlug = process.env.CAL_EVENT_SLUG || "ai-intake-call-test";

  const start = asString(body.start);
  const attendeeName = asString(body.attendee_name);
  const attendeeEmail = asString(body.attendee_email);
  const attendeePhone = asString(body.attendee_phone);

  if (!start) return json(res, 400, { error: "Missing start" });
  if (!attendeeName) return json(res, 400, { error: "Missing attendee_name" });
  if (!attendeeEmail) return json(res, 400, { error: "Missing attendee_email" });

  const idKey =
    asString(req.headers["x-idempotency-key"]) || asString(body.idempotency_key);

  if (idKey) {
    const dedupeKey = `cal:book:dedupe:${eventTypeSlug}:${idKey}`;
    const existing = await kv.get(dedupeKey);
    if (existing) return json(res, 200, { ok: true, deduped: true, booking: existing });
    await kv.set(dedupeKey, { locking: true }, { ex: 60 });
  }

  const payload = {
    username,
    eventTypeSlug,
    start,
    attendee: {
      name: attendeeName,
      email: attendeeEmail,
      phoneNumber: attendeePhone || undefined,
    },
    metadata: body.metadata || {},
  };

  const resp = await axios.post("https://api.cal.com/v2/bookings", payload, { headers });
  const booking = resp.data?.data || resp.data;

  if (idKey) {
    const dedupeKey = `cal:book:dedupe:${eventTypeSlug}:${idKey}`;
    await kv.set(dedupeKey, booking, { ex: 24 * 60 * 60 });
  }

  return json(res, 200, { ok: true, booking, agent_id: agent_id || undefined });
}

async function handleAuto(req, res, body) {
  const agent_id = asString(req.query.agent_id || body.agent_id);
  const email = asString(req.query.email || body.email);
  const headers = await getHeaders({ agent_id, email });

  const username = process.env.CAL_USERNAME || "ai-integrating";
  const eventTypeSlug = process.env.CAL_EVENT_SLUG || "ai-intake-call-test";

  const startDate = asString(body.start_date, ymd(Date.now()));
  const endDate = asString(body.end_date, ymd(Date.now() + 14 * 24 * 60 * 60 * 1000));

  const slotsUrl =
    `https://api.cal.com/v2/slots` +
    `?username=${encodeURIComponent(username)}` +
    `&eventTypeSlug=${encodeURIComponent(eventTypeSlug)}` +
    `&start=${encodeURIComponent(startDate)}` +
    `&end=${encodeURIComponent(endDate)}`;

  const slotsResp = await axios.get(slotsUrl, { headers });
  const slotsData = slotsResp.data?.data || slotsResp.data;

  let allStarts = [];
  if (Array.isArray(slotsData)) {
    allStarts = slotsData;
  } else if (slotsData?.slots && Array.isArray(slotsData.slots)) {
    allStarts = slotsData.slots;
  } else if (typeof slotsData === "object" && slotsData) {
    for (const k of Object.keys(slotsData)) {
      const v = slotsData[k];
      if (Array.isArray(v)) allStarts.push(...v);
    }
  }

  const earliest = allStarts
    .map((s) => (typeof s === "string" ? s : s?.start || s?.time || null))
    .filter(Boolean)
    .sort()[0];

  if (!earliest) return json(res, 200, { ok: true, booked: false, reason: "No available slots" });

  const attendeeName = asString(body.attendee_name);
  const attendeeEmail = asString(body.attendee_email);
  const attendeePhone = asString(body.attendee_phone);
  if (!attendeeName || !attendeeEmail) {
    return json(res, 400, { error: "Missing attendee_name or attendee_email" });
  }

  const idKey =
    asString(req.headers["x-idempotency-key"]) ||
    asString(body.idempotency_key) ||
    `auto:${attendeeEmail}:${earliest}`;

  const dedupeKey = `cal:auto:dedupe:${eventTypeSlug}:${idKey}`;
  const existing = await kv.get(dedupeKey);
  if (existing) return json(res, 200, { ok: true, deduped: true, booking: existing });

  await kv.set(dedupeKey, { locking: true }, { ex: 60 });

  const payload = {
    username,
    eventTypeSlug,
    start: earliest,
    attendee: {
      name: attendeeName,
      email: attendeeEmail,
      phoneNumber: attendeePhone || undefined,
    },
    metadata: body.metadata || {},
  };

  const bookResp = await axios.post("https://api.cal.com/v2/bookings", payload, { headers });
  const booking = bookResp.data?.data || bookResp.data;

  await kv.set(dedupeKey, booking, { ex: 24 * 60 * 60 });
  return json(res, 200, {
    ok: true,
    booked: true,
    booking,
    picked_start: earliest,
    agent_id: agent_id || undefined,
  });
}

// -------------------- MAIN HANDLER --------------------
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const body = req.method === "POST" ? await readJsonBody(req) : {};
  const action = asString(req.query.action || body.action).toLowerCase();

  try {
    if (req.method === "GET" && action === "oauth_start") return await handleOAuthStart(req, res);
    if (req.method === "GET" && action === "oauth_callback") return await handleOAuthCallback(req, res);

    if (req.method === "POST" && (action === "availability" || action === "slots")) {
      return await handleAvailability(req, res, body);
    }
    if (req.method === "POST" && action === "book") {
      return await handleBook(req, res, body);
    }
    if (req.method === "POST" && (action === "auto" || action === "autobook")) {
      return await handleAuto(req, res, body);
    }

    return json(res, 400, { error: "Unknown action or method", action, method: req.method });
  } catch (err) {
    return json(res, 500, {
      error: "Server error",
      message: err.message,
      detail: err.response?.data,
    });
  }
};
