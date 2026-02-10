// /api/usage.js
// Read usage counters from Vercel KV for an agent.
// ✅ FIXED: real ymdInTZ / ymInTZ helpers
// ✅ FIXED: last_call parsing safe for string OR object

const { kv } = require("@vercel/kv");

function ok(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

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

  return `${y}-${m}-${d}`; // YYYY-MM-DD
}

function ymInTZ(date = new Date(), tz = "America/New_York") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;

  return `${y}-${m}`; // YYYY-MM
}

function safeParseMaybeJson(v) {
  if (!v) return null;
  if (typeof v === "object") return v; // already parsed
  if (typeof v !== "string") return { value: v };
  try {
    return JSON.parse(v);
  } catch {
    return { value: v };
  }
}

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const agent_id = url.searchParams.get("agent_id");
    if (!agent_id) return ok(res, 400, { ok: false, error: "agent_id required" });

    // Prefer tz stored per agent; otherwise fallback
    const tz =
      (await kv.get(`tz:${agent_id}`)) ||
      process.env.DEFAULT_TZ ||
      "America/New_York";

    const day = ymdInTZ(new Date(), tz);
    const month = ymInTZ(new Date(), tz);

    const base = `metrics:${agent_id}`;
    const dayBase = `${base}:day:${day}`;
    const monthBase = `${base}:month:${month}`;

    // Keys must match what retell-call-ended writes
    const keys = [
      `${base}:calls_total`,
      `${base}:minutes_total`,
      `${dayBase}:calls`,
      `${dayBase}:minutes`,
      `${monthBase}:calls`,
      `${monthBase}:minutes`,
      `${base}:last_call`,
      `plan:${agent_id}`,
      `tz:${agent_id}`,
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
      tz_saved,
    ] = await Promise.all(keys.map((k) => kv.get(k)));

    return ok(res, 200, {
      ok: true,
      agent_id,
      tz: tz_saved || tz,
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
      last_call: safeParseMaybeJson(last_call),
    });
  } catch (err) {
    console.error("usage.js ERROR", err);
    return ok(res, 500, { ok: false, error: err?.message || "Server error" });
  }
};
