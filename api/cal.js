// /api/cal.js
// Combines Cal.com availability + booking + AUTO booking into ONE Vercel function.
// ✅ UPDATE: HARD REQUIRE EMAIL TO BOOK/AUTOBOOK (no fallback paths)

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

// -------------------- JSON RESPONSE --------------------
function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
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
function asString(v, fallback = "") {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  return s ? s : fallback;
}

function cleanPhone(phone) {
  if (!phone) return "";
  let p = String(phone).trim();
  const digits = p.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (p.startsWith("+")) return p;
  return digits ? `+${digits}` : "";
}

function ymd(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function toMinutesLocalHHMM(isoString, timeZone) {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = dtf.formatToParts(new Date(isoString));
    const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    return hh * 60 + mm;
  } catch {
    const d = new Date(isoString);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}

function matchesWindow(isoStart, timeZone, timeWindow) {
  const w = (timeWindow || "anytime").toLowerCase();
  if (w === "anytime" || w === "any") return true;

  const mins = toMinutesLocalHHMM(isoStart, timeZone);

  if (w === "morning") return mins >= 8 * 60 && mins < 12 * 60;
  if (w === "afternoon") return mins >= 12 * 60 && mins < 17 * 60;
  if (w === "evening") return mins >= 17 * 60 && mins <= 20 * 60;

  return true;
}

function isSameYMDInTZ(isoStart, targetYmd, timeZone) {
  if (!targetYmd) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetYmd)) return true;

  try {
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const ymdLocal = dtf.format(new Date(isoStart)); // "YYYY-MM-DD"
    return ymdLocal === targetYmd;
  } catch {
    return true;
  }
}

// ✅ Strict email validation (simple + reliable)
function isValidEmail(email) {
  const e = asString(email, "");
  if (!e) return false;
  // basic sanity check; avoids garbage but not over-strict
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// ✅ Unified "email required" response helper
function emailRequired(res) {
  return json(res, 400, {
    ok: false,
    error: "Email is required to book an appointment",
    action_required: "request_email",
  });
}

async function fetchStarts({
  CAL_API_KEY,
  username,
  eventTypeSlug,
  timeZone,
  start,
  end,
}) {
  const url =
    `https://api.cal.com/v2/slots` +
    `?eventTypeSlug=${encodeURIComponent(eventTypeSlug)}` +
    `&username=${encodeURIComponent(username)}` +
    `&start=${encodeURIComponent(start)}` +
    `&end=${encodeURIComponent(end)}` +
    `&timeZone=${encodeURIComponent(timeZone)}` +
    `&format=time`;

  const resp = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${CAL_API_KEY}`,
      "cal-api-version": "2024-09-04",
    },
    timeout: 30000,
  });

  const byDate = resp?.data?.data || {};
  const starts = [];
  for (const day of Object.keys(byDate).sort()) {
    const slots = byDate[day] || [];
    for (const s of slots) {
      if (s?.start) starts.push(s.start);
    }
  }
  return starts;
}

async function createBooking({ CAL_API_KEY, payload }) {
  const resp = await axios.post("https://api.cal.com/v2/bookings", payload, {
    headers: {
      Authorization: `Bearer ${CAL_API_KEY}`,
      "Content-Type": "application/json",
      "cal-api-version": "2024-08-13",
    },
    timeout: 30000,
  });

  return resp.data;
}

// -------------------- MAIN --------------------
module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  const body = req.method === "POST" ? await readJsonBody(req) : {};

  const action = asString(req.query.action, asString(body.action, "")).toLowerCase();

  // env
  const CAL_API_KEY = process.env.CAL_API_KEY;
  const username = process.env.CAL_USERNAME || "ai-integrating";
  const eventTypeSlug = process.env.CAL_EVENT_SLUG || "ai-intake-call-test";
  const timeZone = process.env.CAL_TIMEZONE || "America/New_York";

  if (!CAL_API_KEY) return json(res, 500, { ok: false, error: "Missing CAL_API_KEY" });

  try {
    // -------------------- AVAILABILITY --------------------
    if (action === "availability" || action === "slots") {
      const days = Number(req.query.days || body.days || 7);
      const limit = Number(req.query.limit || body.limit || 10);

      const now = new Date();
      const start = ymd(now);
      const end = ymd(new Date(now.getTime() + days * 24 * 60 * 60 * 1000));

      const starts = await fetchStarts({
        CAL_API_KEY,
        username,
        eventTypeSlug,
        timeZone,
        start,
        end,
      });

      return json(res, 200, {
        ok: true,
        action: "availability",
        username,
        eventTypeSlug,
        timeZone,
        start,
        end,
        starts: starts.slice(0, limit),
        rawCount: starts.length,
      });
    }

    // -------------------- BOOK --------------------
    if (action === "book" || action === "booking") {
      if (req.method !== "POST")
        return json(res, 405, { ok: false, error: "Booking requires POST" });

      const startISO = asString(body.start, "");
      if (!startISO) return json(res, 400, { ok: false, error: "Missing start (ISO time)" });

      const attendee = body.attendee || {};
      const attendeeName = asString(attendee.name, asString(body.name, ""));
      const attendeeEmail = asString(attendee.email, asString(body.email, ""));
      const attendeePhone = cleanPhone(attendee.phoneNumber || body.phone || body.phoneNumber);
      const attendeeTZ = asString(attendee.timeZone, asString(body.timeZone, timeZone));

      if (!attendeeName) return json(res, 400, { ok: false, error: "Missing attendee name" });

      // ✅ HARD REQUIRE EMAIL (and validate)
      if (!isValidEmail(attendeeEmail)) return emailRequired(res);

      if (!attendeePhone)
        return json(res, 400, { ok: false, error: "Missing attendee phoneNumber" });

      const idempotency_key =
        req.headers["x-idempotency-key"] ||
        asString(body.idempotency_key, asString(body.request_id, ""));

      const payload = {
        start: startISO,
        eventTypeSlug,
        username,
        attendee: {
          name: attendeeName,
          email: attendeeEmail,
          phoneNumber: attendeePhone,
          timeZone: attendeeTZ,
        },
        metadata: {
          agent_id: asString(body.agent_id, ""),
          client_id: asString(body.client_id, ""),
          retell_call_id: asString(body.retell_call_id, ""),
          idempotency_key: asString(idempotency_key, ""),
          reason_for_call: asString(body.reason_for_call, ""),
          notes: asString(body.notes, ""),
        },
      };

      const booking = await createBooking({ CAL_API_KEY, payload });

      return json(res, 200, { ok: true, action: "book", booking });
    }

    // -------------------- AUTO --------------------
    // POST /api/cal?action=auto
    if (action === "auto" || action === "autobook") {
      if (req.method !== "POST")
        return json(res, 405, { ok: false, error: "Auto booking requires POST" });

      const attendeeName = asString(body.name, "");
      const attendeeEmail = asString(body.email, "");
      const attendeePhone = cleanPhone(body.phone || body.phoneNumber);
      const attendeeTZ = asString(body.timeZone, timeZone);

      if (!attendeeName) return json(res, 400, { ok: false, error: "Missing name" });

      // ✅ HARD REQUIRE EMAIL (and validate)
      if (!isValidEmail(attendeeEmail)) return emailRequired(res);

      if (!attendeePhone) return json(res, 400, { ok: false, error: "Missing phone" });

      const days = Number(body.days || req.query.days || 7);
      const time_window = asString(body.time_window, "anytime").toLowerCase();
      const preferred_day_raw = asString(body.preferred_day, "next_available").toLowerCase();
      const preferred_day = preferred_day_raw === "next_available" ? "" : preferred_day_raw;

      // Strong idempotency: prefer caller provided key; otherwise derive from retell_call_id or email+window+day
      const headerIdem = req.headers["x-idempotency-key"];
      const providedIdem = asString(body.idempotency_key, asString(body.request_id, ""));
      const retellCall = asString(body.retell_call_id, "");
      const idem =
        asString(headerIdem, "") ||
        providedIdem ||
        (retellCall
          ? `retell:${retellCall}`
          : `auto:${attendeeEmail}:${preferred_day || "next"}:${time_window}`);

      const idemKey = `cal:auto:idem:${idem}`;

      // if already booked, return same result
      const existing = await kv.get(idemKey);
      if (existing && existing.status === "booked") {
        return json(res, 200, { ok: true, action: "auto", reused: true, ...existing });
      }

      // lock for 2 minutes to block retries/races
      const lockKey = `cal:auto:lock:${idem}`;
      const gotLock = await kv.set(lockKey, "1", { nx: true, ex: 120 });
      if (!gotLock) {
        return json(res, 202, { ok: true, action: "auto", status: "processing", idempotency_key: idem });
      }

      // mark processing (10 min TTL)
      await kv.set(idemKey, { status: "processing", idempotency_key: idem }, { ex: 600 });

      const now = new Date();
      const start = ymd(now);
      const end = ymd(new Date(now.getTime() + days * 24 * 60 * 60 * 1000));

      const starts = await fetchStarts({
        CAL_API_KEY,
        username,
        eventTypeSlug,
        timeZone,
        start,
        end,
      });

      // filter by preferred day + window
      const filtered = starts.filter((s) => {
        if (!isSameYMDInTZ(s, preferred_day, attendeeTZ)) return false;
        return matchesWindow(s, attendeeTZ, time_window);
      });

      const chosen = filtered[0] || starts[0];
      if (!chosen) {
        await kv.set(
          idemKey,
          { status: "failed", error: "No available slots found", idempotency_key: idem },
          { ex: 900 }
        );
        await kv.del(lockKey);
        return json(res, 409, { ok: false, action: "auto", error: "No available slots found" });
      }

      const payload = {
        start: chosen,
        eventTypeSlug,
        username,
        attendee: {
          name: attendeeName,
          email: attendeeEmail,
          phoneNumber: attendeePhone,
          timeZone: attendeeTZ,
        },
        metadata: {
          agent_id: asString(body.agent_id, ""),
          client_id: asString(body.client_id, ""),
          retell_call_id: retellCall,
          idempotency_key: idem,
          reason_for_call: asString(body.reason_for_call, ""),
          notes: asString(body.notes, ""),
          time_window,
          preferred_day: preferred_day || "next_available",
        },
      };

      const booking = await createBooking({ CAL_API_KEY, payload });

      const saved = { status: "booked", idempotency_key: idem, chosen_start: chosen, booking };
      await kv.set(idemKey, saved, { ex: 60 * 60 * 24 }); // 24h
      await kv.del(lockKey);

      return json(res, 200, { ok: true, action: "auto", ...saved });
    }

    // -------------------- HELP --------------------
    return json(res, 400, {
      ok: false,
      error: "Missing/unknown action. Use action=availability, action=book, or action=auto.",
      examples: {
        availability: "/api/cal?action=availability&days=7&limit=10",
        book: "POST /api/cal?action=book with { start, attendee{...} }",
        auto: "POST /api/cal?action=auto with { name,email,phone,time_window,preferred_day }",
      },
    });
  } catch (err) {
    const msg = err?.response?.data || err?.message || "Unknown error";
    return json(res, 500, { ok: false, error: msg });
  }
};
