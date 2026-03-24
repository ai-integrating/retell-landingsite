const axios = require("axios");
const crypto = require("crypto");
const { kv } = require("@vercel/kv");

const CAL_API_VERSION = "2024-06-11"; 

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

function tokenKeyForAgent(agentId) {
  return agentId ? `cal:tokens:agent:${agentId}` : "";
}

function getCalRedirectUri() {
  return process.env.CAL_OAUTH_REDIRECT_URI || process.env.CAL_REDIRECT_URI || "";
}

// -------------------- OAUTH HANDLERS --------------------
async function handleOauthStart(req, res, url) {
  const agent_id = asString(url.searchParams.get("agent_id"));
  if (!agent_id) return json(res, 400, { error: "agent_id required" });

  const clientId = process.env.CAL_CLIENT_ID;
  const redirectUri = getCalRedirectUri();
  const nonce = crypto.randomBytes(16).toString("hex");

  await kv.set(`cal:oauth:state:${nonce}`, { agent_id }, { ex: 600 });

  const authUrl = `https://app.cal.com/auth/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${nonce}`;
  res.writeHead(302, { Location: authUrl });
  res.end();
}

async function handleOauthCallback(req, res, url) {
  const code = asString(url.searchParams.get("code"));
  const state = asString(url.searchParams.get("state"));

  const stateRecord = await kv.get(`cal:oauth:state:${state}`);
  if (!stateRecord?.agent_id) return json(res, 400, { error: "Invalid state" });
  await kv.del(`cal:oauth:state:${state}`);

  try {
    const tokenResp = await axios.post("https://api.cal.com/v2/auth/oauth2/token", {
      client_id: process.env.CAL_CLIENT_ID,
      client_secret: process.env.CAL_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: getCalRedirectUri()
    });

    const tokenPayload = {
      access_token: tokenResp.data.access_token,
      refresh_token: tokenResp.data.refresh_token,
      expires_at: Date.now() + (tokenResp.data.expires_in * 1000)
    };

    const agent_id = stateRecord.agent_id;
    await kv.set(tokenKeyForAgent(agent_id), tokenPayload);

    // --- CRITICAL MAPPING LOGIC ---
    const lookupKey = `agent:${agent_id}:client`;
    const mappedClientId = await kv.get(lookupKey);

    if (mappedClientId) {
      const headers = { Authorization: `Bearer ${tokenPayload.access_token}`, "cal-api-version": CAL_API_VERSION };
      
      // Fetch Profile
      const meResp = await axios.get("https://api.cal.com/v2/me", { headers });
      const username = meResp.data.data.username;

      // Fetch Slug
      const etResp = await axios.get("https://api.cal.com/v1/event-types", { headers });
      const eventTypeSlug = etResp.data.event_types?.[0]?.slug || "";

      await kv.set(`client:${mappedClientId}:cal`, {
        username,
        eventTypeSlug,
        timeZone: meResp.data.data.timeZone || "America/New_York",
        updated_at: new Date().toISOString()
      });
    }

    res.writeHead(302, { Location: "https://app.cal.com/event-types" });
    res.end();
  } catch (err) {
    return json(res, 500, { error: "Exchange failed", detail: err.response?.data || err.message });
  }
}

// -------------------- RESOLVER & MAIN HANDLERS --------------------
async function resolveCalConfig(req, body) {
  const agentId = asString(req.headers["x-agent-id"] || body.agent_id || body.args?.agent_id);
  if (!agentId) return null;

  const clientId = await kv.get(`agent:${agentId}:client`);
  if (!clientId) return null;

  return await kv.get(`client:${clientId}:cal`);
}

async function handleAvailability(req, res, body) {
  const config = await resolveCalConfig(req, body);
  if (!config) return json(res, 400, { error: "No config found for agent" });

  const url = `https://api.cal.com/v2/slots?username=${config.username}&eventTypeSlug=${config.eventTypeSlug}&start=${ymd(Date.now())}&end=${ymd(Date.now() + 7*24*60*60*1000)}`;
  
  try {
    const resp = await axios.get(url, { headers: { "cal-api-version": CAL_API_VERSION, Authorization: `Bearer ${process.env.CAL_API_KEY}` } });
    const starts = Object.values(resp.data.data).flat().map(s => s.start).filter(Boolean);
    return json(res, 200, { ok: true, available_slots: starts });
  } catch (err) {
    return json(res, 500, { error: "Failed", message: err.message });
  }
}

// -------------------- ROUTER --------------------
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action")?.toLowerCase();
  const body = req.method === "POST" ? await readJsonBody(req) : {};

  if (action === "oauth_start") return await handleOauthStart(req, res, url);
  if (action === "oauth_callback") return await handleOauthCallback(req, res, url);
  if (action === "availability") return await handleAvailability(req, res, body);

  return json(res, 400, { error: "Action unknown" });
};
