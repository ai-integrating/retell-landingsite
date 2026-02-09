// /api/usage.js
const { kv } = require("@vercel/kv");

function ok(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

// ---- TZ helpers (no deps) ----
function ymdInTZ(date = new Date(), tz = "America/New_York") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}
function ymInTZ(date = new Date(), tz = "America/New_York") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  return `${y}-${m}`;
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const agent_id = url.searchParams.get("agent_id");
  if (!agent_id) return ok(res, 400, { ok: false, error: "agent_id required" });

  // ✅ per-agent timezone from KV first
  const tz =
    (await kv.get(`tz:${agent_id}`)) ||
    process.env.DEFAULT_TZ ||
    "America/New_York";

  const day = ymdInTZ(new Date(), tz);
  const month = ymInTZ(new Date(), tz);

  const base = `metrics:${agent_id}`;
  const dayBase = `${base}:day:${day}`;
  const monthBase = `${base}:month:${month}`;

  const keys = [
    `${base}:calls_total`,
    `${base}:minutes_total`,
    `${dayBase}:calls`,
    `${dayBase}:minutes`,
    `${monthBase}:calls`,
    `${monthBase}:minutes`,
    `${base}:last_call`,
    `plan:${agent_id}`,
  ];

  const [
    calls_total,
    minutes_total,
    day_calls,
    day_minutes,
    month_calls,
    month_minutes,
    last_call,
    plan,
  ] = await Promise.all(keys.map((k) => kv.get(k)));

  return ok(res, 200, {
    ok: true,
    agent_id,
    tz,
    day,
    month,
    plan: plan || "trial",
    totals: {
      calls: Number(calls_total || 0),
      minutes: Number(minutes_total || 0),
    },
    today: {
      calls: Number(day_calls || 0),
      minutes: Number(day_minutes || 0),
    },
    this_month: {
      calls: Number(month_calls || 0),
      minutes: Number(month_minutes || 0),
    },
    last_call: last_call ? JSON.parse(last_call) : null,
  });
};
