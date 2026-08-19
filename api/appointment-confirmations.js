// /api/appointment-confirmations.js
//
// DAILY DAY-BEFORE CONFIRMATION CHECKER
//
// Zapier runs this endpoint once per day at 1:30 PM.
// This endpoint:
// 1. Looks at tomorrow's Cal.com bookings stored in Vercel KV
// 2. Finds bookings whose confirmation_status is "pending"
// 3. Returns those appointments to Zapier
//
// This endpoint DOES NOT place the call.
// The existing /api/outgoing-call remains responsible for calling Retell.

const { kv } = require("@vercel/kv");

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload, null, 2));
}

function formatAppointmentDate(date, timeZone = "America/New_York") {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatAppointmentTime(date, timeZone = "America/New_York") {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function getDateKey(date, timeZone = "America/New_York") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return `${values.year}-${values.month}-${values.day}`;
}

// --------------------------------------------------
// CLIENT CONFIG
// --------------------------------------------------

async function getConfirmationConfig(clientId) {
  return await kv.get(`client:${clientId}:confirmation_config`);
}

// --------------------------------------------------
// MAIN HANDLER
// --------------------------------------------------

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      return json(res, 405, {
        ok: false,
        error: "Method not allowed",
      });
    }

    const url = new URL(
      req.url,
      `https://${req.headers.host || "localhost"}`
    );

    const clientId =
      url.searchParams.get("client_id") ||
      req.body?.client_id ||
      "";

    if (!clientId) {
      return json(res, 400, {
        ok: false,
        error: "Missing client_id",
      });
    }

    // --------------------------------------------------
    // GET CLIENT CONFIRMATION SETTINGS
    // --------------------------------------------------

    const config = await getConfirmationConfig(clientId);

    if (!config) {
      return json(res, 400, {
        ok: false,
        error: "No confirmation configuration found for client",
        client_id: clientId,
      });
    }

    if (config.enabled === false) {
      return json(res, 200, {
        ok: true,
        client_id: clientId,
        confirmations_enabled: false,
        appointments_found: 0,
        appointments: [],
      });
    }

    const timeZone =
      config.time_zone ||
      config.timeZone ||
      "America/New_York";

    // --------------------------------------------------
    // FIND TOMORROW
    // --------------------------------------------------

    const now = new Date();

    const tomorrow = new Date(
      now.getTime() + 24 * 60 * 60 * 1000
    );

    const tomorrowDateKey = getDateKey(
      tomorrow,
      timeZone
    );

    // cal.js already creates this index when Ava books.
    const indexKey =
      `client:${clientId}:confirmations:${tomorrowDateKey}`;

    const bookingUids =
      (await kv.smembers(indexKey)) || [];

    // --------------------------------------------------
    // READ TOMORROW'S BOOKINGS
    // --------------------------------------------------

    const appointments = [];

    for (const bookingUid of bookingUids) {
      const bookingKey = `booking:${bookingUid}`;

      const booking = await kv.get(bookingKey);

      if (!booking) {
        continue;
      }

      // Do not send appointments already handled.
      if (booking.confirmation_status !== "pending") {
        continue;
      }

      if (!booking.appointment_start) {
        continue;
      }

      if (!booking.customer_phone) {
        continue;
      }

      const appointmentDate =
        new Date(booking.appointment_start);

      if (Number.isNaN(appointmentDate.getTime())) {
        continue;
      }

      // Safety check:
      // Make sure the booking itself is actually tomorrow
      // in the client's timezone.
      const actualAppointmentDateKey =
        getDateKey(appointmentDate, timeZone);

      if (actualAppointmentDateKey !== tomorrowDateKey) {
        continue;
      }

      // --------------------------------------------------
      // BUILD THE DATA ZAPIER NEEDS
      // --------------------------------------------------

      appointments.push({
        agent_id:
          config.outbound_agent_id || "",

        to_number:
          booking.customer_phone || "",

        from_number:
          config.from_number || "",

        client_name:
          booking.customer_name || "",

        business_name:
          config.business_name || "",

        agent_name:
          config.agent_name || "",

        reason_for_call:
          config.reason_for_call ||
          "your upcoming appointment",

        appointment_type:
          booking.appointment_type || "",

        appointment_date:
          formatAppointmentDate(
            appointmentDate,
            timeZone
          ),

        appointment_time:
          formatAppointmentTime(
            appointmentDate,
            timeZone
          ),

        booking_uid:
          booking.booking_uid || bookingUid,

        client_id:
          booking.client_id || clientId,
      });
    }

    // --------------------------------------------------
    // RETURN RESULTS TO ZAPIER
    // --------------------------------------------------

    return json(res, 200, {
      ok: true,

      client_id: clientId,

      confirmations_enabled: true,

      confirmation_type: "day_before",

      appointment_date_checked:
        tomorrowDateKey,

      appointments_found:
        appointments.length,

      appointments,
    });
  } catch (error) {
    console.error(
      "APPOINTMENT CONFIRMATION CHECK ERROR",
      error
    );

    return json(res, 500, {
      ok: false,
      error:
        "Appointment confirmation check failed",
      message: error.message,
    });
  }
};
