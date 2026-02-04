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

function asString(v, fallback = "") {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "object" && "output" in v) v = v.output;
  const s = String(v).trim();
  return s ? s : fallback;
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
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });

  const body = await readJsonBody(req);

  // Pull fields from Zapier body (support multiple key names)
  const agent_id = pick(body, ["agent_id", "agentId"]); // we'll send this as override_agent_id
  const to_number_raw = pick(body, ["to_number", "to", "phone_number", "phone", "client_phone"]);
  const from_number_raw = pick(body, ["from_number", "from", "retell_phone", "outbound_from_number"]);

  // These are the dynamic variables your provision prompt is looking for:
  const client_name = pick(body, ["client_name", "clientName", "name"]);
  const reason_for_call = pick(body, ["reason_for_call", "reason", "call_reason"]);
  const notes = pick(body, ["notes", "note"]);

  const idempotency_key =
    req.headers["x-idempotency-key"] ||
    pick(body, ["idempotency_key", "request_id", "call_request_id", "submission_id", "retell_call_id"]);

  const to_number = cleanPhone(to_number_raw);
  const from_number = cleanPhone(from_number_raw);

  if (!to_number) return json(res, 400, { ok: false, error: "Missing to_number" });
  if (!from_number) return json(res, 400, { ok: false, error: "Missing from_number" });

  // --- idempotency: dedupe Zap retries ---
  if (idempotency_key) {
    const idemKey = `outbound:idem:${idempotency_key}`;
    const existing = await kv.get(idemKey);
    if (existing && existing.status !== "processing") return json(res, 200, existing);

    // store placeholder quickly to block race
    await kv.set(idemKey, { ok: true, status: "processing" }, { ex: 60 * 10 });
  }

  // --- usage counters (attempts) ---
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const dailyKey = agent_id ? `outbound:${agent_id}:${ymd}:count` : null;
  const activeKey = agent_id ? `outbound:${agent_id}:active` : null;

  try {
    const RETELL_API_KEY = process.env.OUTBOUND_RETELL_API_KEY || process.env.RETELL_API_KEY;
    if (!RETELL_API_KEY) throw new Error("Missing RETELL API key env var");

    // Retell V2 create call endpoint
    const url = "https://api.retellai.com/v2/create-phone-call";

    // ✅ UPDATED PAYLOAD: Including CALL_DIRECTION to trigger the Outbound Opener in your prompt
    const payload = {
      from_number,
      to_number,
      ...(agent_id ? { override_agent_id: agent_id } : {}),
      retell_llm_dynamic_variables: {
        CALL_DIRECTION: "outbound",
        client_name: asString(client_name, ""),
        reason_for_call: asString(reason_for_call, ""),
        notes: asString(notes, ""),
      },
      // Optional: keep metadata if you want it searchable in Retell dashboard
      metadata: {
        idempotency_key: asString(idempotency_key, ""),
      },
    };

    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${RETELL_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });

    // ✅ Count attempt AFTER successful create
    if (dailyKey) await kv.incr(dailyKey);

    // ✅ Concurrency: mark active AFTER successful create
    if (activeKey) {
      await kv.incr(activeKey);
      await kv.expire(activeKey, 60 * 20); // safety TTL
    }

    const result = { ok: true, status: "created", retell: resp.data };

    if (idempotency_key) {
      await kv.set(`outbound:idem:${idempotency_key}`, result, { ex: 60 * 60 * 24 });
    }

    return json(res, 200, result);
  } catch (err) {
    const msg = err?.response?.data || err?.message || "Unknown error";

    if (idempotency_key) {
      await kv.set(
        `outbound:idem:${idempotency_key}`,
        { ok: false, status: "failed", error: msg },
        { ex: 60 * 15 }
      );
    }

    return json(res, 500, { ok: false, error: msg });
  }
};
