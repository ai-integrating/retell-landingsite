const { kv } = require("@vercel/kv");

const ALLOWED_ORIGINS = new Set([
  "https://www.aiintegrating.com",
  "https://aiintegrating.com",
  "https://app.landingsite.ai"
]);

function getRequestOrigin(req) {
  return String(req.headers.origin || "").trim();
}

function setCorsHeaders(req, res) {
  const origin = getRequestOrigin(req);

  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function send(res, status, body) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(status).json(body);
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return await new Promise((resolve) => {
    let data = "";

    req.on("data", (chunk) => {
      data += chunk;
    });

    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function requestBaseUrl(req) {
  const proto = String(
    req.headers["x-forwarded-proto"] || "https"
  )
    .split(",")[0]
    .trim();

  const host = String(
    req.headers["x-forwarded-host"] || req.headers.host || ""
  )
    .split(",")[0]
    .trim();

  return `${proto}://${host}`;
}

function isAllowedOrigin(req) {
  const origin = getRequestOrigin(req);

  if (!origin) {
    return true;
  }

  try {
    const normalizedOrigin = new URL(origin).origin;

    return (
      normalizedOrigin === new URL(requestBaseUrl(req)).origin ||
      ALLOWED_ORIGINS.has(normalizedOrigin)
    );
  } catch {
    return false;
  }
}

async function checkRateLimit(submissionId, req, kv) {
  const ip = String(
    req.headers["x-forwarded-for"] || "unknown"
  )
    .split(",")[0]
    .trim();

  const minute = Math.floor(Date.now() / 60000);
  const key = `cal:setup:rate:${submissionId}:${ip}:${minute}`;

  const count = await kv.incr(key);

  if (count === 1) {
    await kv.expire(key, 90);
  }

  return count <= 15;
}
async function checkPortalReadiness(clientId, fetch, env) {
  const secret = String(
    env.PORTAL_READINESS_SECRET || ""
  ).trim();

  if (!secret) {
    return { portal_ready: false, portal_status: "unavailable" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(
      "https://aiintegrating-portal.replit.app/api/internal/portal-readiness",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Portal-Readiness-Secret": secret
        },
        body: JSON.stringify({
          client_id: String(clientId).trim()
        }),
        signal: controller.signal,
        redirect: "error"
      }
    );

    if (!response.ok) {
      return { portal_ready: false, portal_status: "unavailable" };
    }

    const data = await response.json();

    if (data.portal_ready !== true) {
      return { portal_ready: false, portal_status: "pending" };
    }

    if (
      data.portal_login_url !==
      "https://aiintegrating-portal.replit.app/login"
    ) {
      return { portal_ready: false, portal_status: "unavailable" };
    }

    return {
      portal_ready: true,
      portal_status: "ready",
      portalUrl: data.portal_login_url
    };
  } catch {
    return { portal_ready: false, portal_status: "unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}
function createHandler({ store = kv, request = globalThis.fetch, env = process.env } = {}) {
const kv = store;
const fetch = request;
return async (req, res) => {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    if (!isAllowedOrigin(req)) {
      return res.status(403).end();
    }

    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return send(res, 405, {
      ok: false,
      error: "Method not allowed"
    });
  }

  if (!isAllowedOrigin(req)) {
    return send(res, 403, {
      ok: false,
      error: "Invalid request origin"
    });
  }

  const body = await readBody(req);
  const submissionId = String(body.submission_id || "").trim();

  if (!/^\d{10,25}$/.test(submissionId)) {
    return send(res, 400, {
      ok: false,
      error: "Invalid submission"
    });
  }

  if (!(await checkRateLimit(submissionId, req, kv))) {
    return send(res, 429, {
      ok: false,
      error: "Too many requests. Please wait a minute."
    });
  }

  const record = await kv.get(`prov:${submissionId}`);

  if (!record || typeof record !== "object") {
    return send(res, 202, {
      ok: true,
      ready: false,
      status: "waiting_for_provisioning",
      message: "We are still locating your AI employee setup."
    });
  }
  if (record.status === "failed") {
    return send(res, 409, {
      ok: false,
        error: "Your AI employee setup needs our attention."
    });
  }
const savedPhone = record.agent_id
  ? await kv.get(`agent:${String(record.agent_id).trim()}:phone`)
  : "";

const phoneNumber = String(
  record.phone_number || savedPhone || ""
).trim();
const validPhone = /^\+[1-9]\d{7,14}$/.test(phoneNumber);

if (
  record.status !== "completed" ||
  !record.agent_id ||
  !validPhone
) {
  return send(res, 202, {
    ok: true,
    ready: false,
    status:
      record.status === "completed"
        ? "finishing_phone_setup"
        : record.status || "provisioning",
    ...(validPhone ? { phone_number: phoneNumber } : {}),
    message:
      "Your AI employee and phone number are still being prepared. This page will keep checking automatically."
  });
}


  const agentId = String(record.agent_id).trim();
  const clientId = await kv.get(`agent:${agentId}:client`);

  if (!clientId) {
    return send(res, 202, {
      ok: true,
      ready: false,
      status: "finishing_workspace",
      phone_number: phoneNumber,
      message:
        "Your phone number is ready. We are finishing your workspace connection."
    });
  }
const needsCalendar =
  record.role === "scheduler" ||
  record.role === "operations";

const portalDetails = await checkPortalReadiness(clientId, fetch, env);

const publicDetails = {
  status: "completed",
  role: record.role,
  phone_number: phoneNumber,
  agent_name: String(record.agent_name || "Your AI employee"),
  needsCalendar,
  ...portalDetails
};

if (!needsCalendar) {
  return send(res, 200, {
    ok: true,
    ready: true,
    connected: false,
    ...publicDetails
  });
}
  const existingToken = await kv.get(
    `cal:tokens:client:${clientId}`
  );

  if (existingToken?.access_token) {
return send(res, 200, {
  ok: true,
  ready: true,
  connected: true,
  ...publicDetails
});
  }
  // Status polling never creates OAuth states or provisions accounts/agents.
  if (body.status_only === true) {
    return send(res, 200, {
      ok: true, ready: true, connected: false, ...publicDetails
    });
  }
  const setupSecret = String(
    env.AI_INTEGRATING_SETUP_SECRET || ""
  ).trim();

  if (!setupSecret) {
    return send(res, 503, {
      ok: false,
      error: "Calendar setup is temporarily unavailable."
    });
  }

  let response;
  try {
  response = await fetch(
    `${requestBaseUrl(
      req
    )}/api/cal-strengthened?action=create_oauth_link`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-setup-key": setupSecret
      },
      body: JSON.stringify({
        agent_id: agentId
      }),
      signal: AbortSignal.timeout(10000),
      redirect: "error"
    }
  );
  } catch {
    return send(res, 502, { ok: false, ...publicDetails,
      error: "Calendar connection is temporarily unavailable." });
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.authorizationUrl) {
    return send(res, 502, {
      ok: false,
      ...publicDetails,
      error:
        "We could not prepare the calendar connection yet."
    });
  }
return send(res, 200, {
  ok: true,
  ready: true,
  connected: false,
  ...publicDetails,
  authorizationUrl: data.authorizationUrl,
  expiresInSeconds: data.expiresInSeconds || 600
  });
};
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
