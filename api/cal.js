const axios = require("axios");
const { kv } = require("@vercel/kv");

const CAL_API_VERSION = "2024-09-04";

// -------------------- CORS & RESPONSES --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Agent-Id, X-Cal-Username, X-Cal-Slug");
}
const axios = require("axios");
const { kv } = require("@vercel/kv");

const CAL_API_VERSION = "2026-02-25";

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

function asString(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function normalizeSlug(slug = "") {
  return String(slug)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/_/g, "-");
}

function getCalHeaders(tokenOverride) {
  return {
    "Content-Type": "application/json",
    "cal-api-version": CAL_API_VERSION,
    Authorization: `Bearer ${tokenOverride || process.env.CAL_API_KEY}`,
  };
}

function extractError(err) {
  return err?.response?.data || err?.message || "Unknown error";
}

// -------------------- IDENTITY RESOLUTION --------------------
async function getCalConfig(req, body) {
  const args = body.args || body || {};

  const agentId = asString(
    req.headers["x-agent-id"] || body.agent_id || body.agentId || args.agent_id
  );

  let kvConfig = null;

  if (agentId) {
    try {
      const clientId = await kv.get(`agent:${agentId}:client`);
      if (clientId) {
        kvConfig = await kv.get(`client:${clientId}:cal`);
      }
    } catch (e) {
      console.error("KV Error", e?.message || e);
    }
  }

  const username = asString(
    req.headers["x-cal-username"] ||
      kvConfig?.username ||
      args.username ||
      body.username
  );

  const eventTypeSlug = normalizeSlug(
    req.headers["x-cal-slug"] ||
      kvConfig?.eventTypeSlug ||
      args.event_slug ||
      args.eventTypeSlug ||
      args.slug ||
      body.event_slug ||
      body.eventTypeSlug ||
      body.slug
  );

  const timeZone = asString(
    args.timeZone ||
      args.time_zone ||
      body.timeZone ||
      body.time_zone ||
      kvConfig?.timeZone ||
      "America/New_York"
  );

  return { agentId, username, eventTypeSlug, timeZone };
}

// -------------------- HANDLERS --------------------
async function handleAvailability(req, res, body) {
  const { username, eventTypeSlug, timeZone } = await getCalConfig(req, body);
  const args = body.args || body || {};

  if (!username || !eventTypeSlug) {
    return json(res, 400, {
      error: "Config missing",
      debug: {
        username,
        eventTypeSlug,
        hasUsername: !!username,
        hasSlug: !!eventTypeSlug,
      },
    });
  }

  const start =
    asString(args.start_date || body.start_date) ||
    new Date().toISOString().slice(0, 10);

  const end =
    asString(args.end_date || body.end_date) ||
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const url =
    `https://api.cal.com/v2/slots` +
    `?username=${encodeURIComponent(username)}` +
    `&eventTypeSlug=${encodeURIComponent(eventTypeSlug)}` +
    `&start=${encodeURIComponent(start)}` +
    `&end=${encodeURIComponent(end)}` +
    `&timeZone=${encodeURIComponent(timeZone)}`;

  console.log(
    "CAL AVAILABILITY TARGET",
    JSON.stringify({ url, username, eventTypeSlug, timeZone, start, end }, null, 2)
  );

  try {
    const resp = await axios.get(url, {
      headers: getCalHeaders(),
    });

    const starts = Object.values(resp.data?.data || {})
      .flat()
      .map((s) => s.start)
      .filter(Boolean);

    return json(res, 200, { ok: true, available_slots: starts });
  } catch (err) {
    console.log(
      "CAL AVAILABILITY ERROR",
      JSON.stringify(
        {
          status: err.response?.status,
          data: err.response?.data,
          headers: err.response?.headers,
          message: err.message,
        },
        null,
        2
      )
    );

    return json(res, 500, {
      error: "Availability failed",
      detail: extractError(err),
    });
  }
}

async function handleBook(req, res, body) {
  const { username, eventTypeSlug } = await getCalConfig(req, body);
  const args = body.args || body || {};

  const start = asString(
    args.selected_start ||
      body.selected_start ||
      args.start ||
      body.start ||
      args.start_time ||
      body.start_time
  );

  const name = asString(
    args.name || body.name || args.attendee_name || body.attendee_name
  );

  const email = asString(
    args.email || body.email || args.attendee_email || body.attendee_email
  ).toLowerCase();

  const phone = asString(args.phone || body.phone || args.phoneNumber || body.phoneNumber);

  if (!start || !name || !email || !username || !eventTypeSlug) {
    return json(res, 400, {
      error: "Details missing",
      debug: {
        hasStart: !!start,
        hasName: !!name,
        hasEmail: !!email,
        hasUser: !!username,
        hasSlug: !!eventTypeSlug,
      },
    });
  }

  const payload = {
    username,
    eventTypeSlug,
    start,
    attendee: {
      name,
      email,
      ...(phone ? { phoneNumber: phone } : {}),
      timeZone: "America/New_York",
      language: "en",
    },
  };

  console.log(
    "CAL BOOK TARGET",
    JSON.stringify(
      {
        url: "https://api.cal.com/v2/bookings",
        calApiVersion: CAL_API_VERSION,
        payload,
      },
      null,
      2
    )
  );

  try {
    const resp = await axios.post(
      "https://api.cal.com/v2/bookings",
      payload,
      { headers: getCalHeaders() }
    );

    return json(res, 200, { ok: true, booking: resp.data });
  } catch (err) {
    console.log(
      "CAL BOOK ERROR",
      JSON.stringify(
        {
          status: err.response?.status,
          data: err.response?.data,
          headers: err.response?.headers,
          message: err.message,
        },
        null,
        2
      )
    );

    return json(res, 500, {
      error: "Booking failed",
      detail: extractError(err),
    });
  }
}

// -------------------- ROUTER --------------------
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const body = req.method === "POST" ? await readJsonBody(req) : {};
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action")?.toLowerCase();

  if (action === "availability") return await handleAvailability(req, res, body);
  if (action === "book") return await handleBook(req, res, body);

  return json(res, 400, { error: "Unknown action" });
};
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
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

function asString(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

// -------------------- IDENTITY RESOLUTION --------------------
async function getCalConfig(req, body) {
  const args = body.args || {};
  
  // 1. Try to find Agent ID for KV lookup
  const agentId = asString(req.headers["x-agent-id"] || body.agent_id || args.agent_id);
  let kvConfig = null;
  
  if (agentId) {
    try {
      const clientId = await kv.get(`agent:${agentId}:client`);
      if (clientId) kvConfig = await kv.get(`client:${clientId}:cal`);
    } catch (e) { console.error("KV Error"); }
  }

  // 2. Resolve Username and Slug (Priority: Headers > KV > Body)
  // This ensures your hardcoded Retell headers ALWAYS work.
  const username = asString(req.headers["x-cal-username"] || kvConfig?.username || args.username || body.username);
  const eventTypeSlug = asString(req.headers["x-cal-slug"] || kvConfig?.eventTypeSlug || args.event_slug || args.eventTypeSlug || body.event_slug);

  return { username, eventTypeSlug };
}

// -------------------- HANDLERS --------------------
async function handleAvailability(req, res, body) {
  const { username, eventTypeSlug } = await getCalConfig(req, body);
  const args = body.args || body;

  if (!username || !eventTypeSlug) {
    return json(res, 400, { error: "Config missing", debug: { username: !!username, slug: !!eventTypeSlug } });
  }

  const start = asString(args.start_date || body.start_date) || new Date().toISOString().slice(0, 10);
  const end = asString(args.end_date || body.end_date) || new Date(Date.now() + 604800000).toISOString().slice(0, 10);

  const url = `https://api.cal.com/v2/slots?username=${encodeURIComponent(username)}&eventTypeSlug=${encodeURIComponent(eventTypeSlug)}&start=${start}&end=${end}`;

  try {
    const resp = await axios.get(url, { 
      headers: { "cal-api-version": CAL_API_VERSION, Authorization: `Bearer ${process.env.CAL_API_KEY}` } 
    });
    const starts = Object.values(resp.data?.data || {}).flat().map(s => s.start).filter(Boolean);
    return json(res, 200, { ok: true, available_slots: starts });
  } catch (err) {
    return json(res, 500, { error: "Availability failed", message: err.message });
  }
}

async function handleBook(req, res, body) {
  const { username, eventTypeSlug } = await getCalConfig(req, body);
  const args = body.args || body;

  const start = asString(args.start || body.start || args.start_time || body.start_time);
  const name = asString(args.name || body.name || args.attendee_name || body.attendee_name);
  const email = asString(args.email || body.email || args.attendee_email || body.attendee_email).toLowerCase();

  if (!start || !name || !email || !username || !eventTypeSlug) {
    return json(res, 400, { 
      error: "Details missing", 
      debug: { hasStart: !!start, hasName: !!name, hasEmail: !!email, hasUser: !!username, hasSlug: !!eventTypeSlug } 
    });
  }

  const payload = {
    username,
    eventTypeSlug,
    start,
    attendee: { name, email, timeZone: "America/New_York" }
  };

  try {
    const resp = await axios.post("https://api.cal.com/v2/bookings", payload, {
      headers: { 
        "Content-Type": "application/json", 
        "cal-api-version": CAL_API_VERSION, 
        "Authorization": `Bearer ${process.env.CAL_API_KEY}` 
      }
    });
    return json(res, 200, { ok: true, booking: resp.data });
  } catch (err) {
    return json(res, 500, { error: "Booking failed", detail: err.response?.data || err.message });
  }
}

// -------------------- ROUTER --------------------
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  
  const body = await readJsonBody(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action")?.toLowerCase();

  if (action === "availability") return await handleAvailability(req, res, body);
  if (action === "book") return await handleBook(req, res, body);
  
  return json(res, 400, { error: "Unknown action" });
};
