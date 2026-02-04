// /api/outgoing-call.js
// Place an outbound call via Retell Call (V2) endpoint.

const axios = require("axios");
const { kv } = require("@vercel/kv");

// -------------------- CORS --------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Idempotency-Key"
  );
}

// -------------------- BODY --------------------
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

// -------------------- HELPERS --------------------
function cleanPhone(phone) {
  if (!phone) return "";
  let p = String(phone).trim();
  const digits = p.replace(/[^\d]/g, "");

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (p.startsWith("+")) return p;
  return digits ? `+${digits}` : "";
}

// ✅ Better pick(): ignores "", whitespace, null-ish strings, Zapier {output:"..."}
function pick(obj, keys, fallback = undefined) {
  for (const k of keys) {
    let v = obj?.[k];
    if (v && typeof v === "object" && "output" in v) v = v.output;
    if (v === undefined || v === null) continue;
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) continue;
      return s;
    }
    return v;
  }
  return fallback;
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

// -------------------- MAIN --------------------
module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const body = await readJsonBody(req);

  // Pull fields from Zapier body (support multiple key names)
  const agent_id = pick(body, ["agent_id", "agentId"]);
  const to_number_raw = pick(body, ["to_number", "to", "phone_number", "phone", "client_phone"]);
  const from_number_raw = pick(body, ["from_number", "from", "retell_phone", "outbound_from_number"]);
  const idempotency_key =
    req.headers["x-idempotency-key"] ||
    pick(body, ["idempotency_key", "request_id", "call_request_id", "submission_id"]);

  const to_number = cleanPhone(to_number_raw);
  const from_number = cleanPhone(from_number_raw);

  if (!to_number) return json(res, 400, { error: "Missing to_number" });
  if (!from_number) return json(res, 400, { error: "Missing from_number" });

  // --- idempotency: dedupe Zap retries ---
  if (idempotency_key) {
    const idemKey = `outbound:idem:${idempotency_key}`;
    const existing = await kv.get(idemKey);
    if (existing) return json(res, 200, existing);

    // store placeholder quickly to block race
    await kv.set(idemKey, { ok: true, status: "processing" }, { ex: 60 * 10 });
  }

  // --- usage counters (optional, but recommended) ---
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const dailyKey = agent_id ? `outbound:${agent_id}:${ymd}:count` : null;
  const activeKey = agent_id ? `outbound:${agent_id}:active` : null;

  try {
    // Increment counters BEFORE dialing (so it counts attempts)
    if (dailyKey) await kv.incr(dailyKey);
    if (activeKey) {
      await kv.incr(activeKey);
      // TTL on active so it doesn’t get stuck forever if webhook fails
      await kv.expire(activeKey, 60 * 20);
    }

    // --- Call Retell V2 ---
    const RETELL_API_KEY = process.env.OUTBOUND_RETELL_API_KEY || process.env.RETELL_API_KEY;
    if (!RETELL_API_KEY) throw new Error("Missing RETELL API key env var");

    // This is the typical V2 endpoint name in your earlier work:
    const url = "https://api.retellai.com/v2/create-phone-call";

    const payload = {
      from_number,
      to_number,
      // If your Retell setup requires specifying an LLM/agent, you may need additional fields.
      // Some setups infer agent from from_number; others need agent_id.
      ...(agent_id ? { agent_id } : {}),
    };

    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${RETELL_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });

    const result = { ok: true, retell: resp.data };

    if (idempotency_key) {
      await kv.set(`outbound:idem:${idempotency_key}`, result, { ex: 60 * 60 * 24 });
    }

    return json(res, 200, result);
  } catch (err) {
    const msg = err?.response?.data || err?.message || "Unknown error";

    // If dial failed, roll back concurrency counter (and optionally daily count—your choice)
    if (activeKey) {
      try {
        const v = await kv.decr(activeKey);
        if (v < 0) await kv.set(activeKey, 0, { ex: 60 * 20 });
      } catch {}
    }

    if (idempotency_key) {
      await kv.set(
        `outbound:idem:${idempotency_key}`,
        { ok: false, error: msg },
        { ex: 60 * 15 }
      );
    }

    return json(res, 500, { ok: false, error: msg });
  }
};
