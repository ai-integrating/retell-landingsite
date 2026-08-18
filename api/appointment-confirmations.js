// /api/appointment-confirmations.js
//
// Finds upcoming Cal.com bookings that were saved in Vercel KV
// and sends appointments needing confirmation to Zapier.
//
// This does NOT place the Retell call itself.
// Zapier continues to call the existing /api/outgoing-call endpoint.

const axios = require("axios");
const { kv } = require("@vercel/kv");

// --------------------------------------------------
// SETTINGS
// --------------------------------------------------

// Zapier Catch Hook that starts the existing confirmation-call Zap.
// Add this in Vercel as:
// APPOINTMENT_CONFIRMATION_ZAP_URL=https://hooks.zapier.com/...
const ZAP_URL = process.env.APPOINTMENT_CONFIRMATION_ZAP_URL;

// For the first version, confirmations are approximately 24 hours before.
const TARGET_HOURS_BEFORE = 24;

// Because this endpoint may run periodically, allow a window.
// Example: if it runs hourly, appointments 23.5–24.5 hours away qualify.
const WINDOW_MINUTES = 30;

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
  // Produces YYYY-MM-DD in the client's timezone.
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

function hoursUntil(date) {
  return (date.getTime() - Date.now()) / (1000 * 60 * 60);
}

function isInsideConfirmationWindow(appointmentDate) {
  const difference = hoursUntil(appointmentDate);
  const toleranceHours = WINDOW_MINUTES / 60;

  return (
    difference >= TARGET_HOURS_BEFORE - toleranceHours &&
    difference <= TARGET_HOURS_BEFORE + toleranceHours
  );
}

// --------------------------------------------------
// CLIENT CONFIG
// --------------------------------------------------
//
// For now this looks for confirmation settings in KV:
//
// client:{clientId}:confirmation_config
//
// Example:
// {
//   enabled: true,
//   business_name: "Len's office",
//   agent_name: "Ava",
//   outbound_agent_id: "agent_xxxxx",
//   from_number: "+1617xxxxxxx",
//   reason_for_call: "your upcoming appointment with Len",
//   time_zone: "America/New_York"
// }
//
// Later these settings can be controlled from your portal.

async function getConfirmationConfig(clientId) {
  const config = await kv.get(`client:${clientId}:confirmation_config`);

  if (!config) {
    return null;
  }

  return config;
}

// --------------------------------------------------
// PROCESS ONE BOOKING
// --------------------------------------------------

async function processBooking(bookingUid) {
  const bookingKey = `booking:${bookingUid}`;
  const booking = await kv.get(bookingKey);

  if (!booking) {
    return {
      booking_uid: bookingUid,
      action: "skipped",
      reason: "booking_not_found",
    };
  }

  // Already handled = do not call again.
  if (booking.confirmation_status !== "pending") {
    return {
      booking_uid: bookingUid,
      action: "skipped",
      reason: `status_${booking.confirmation_status}`,
    };
  }

  if (!booking.appointment_start) {
    return {
      booking_uid: bookingUid,
      action: "skipped",
      reason: "missing_appointment_start",
    };
  }

  if (!booking.customer_phone) {
    return {
      booking_uid: bookingUid,
      action: "skipped",
      reason: "missing_customer_phone",
    };
  }

  const appointmentDate = new Date(booking.appointment_start);

  if (Number.isNaN(appointmentDate.getTime())) {
    return {
      booking_uid: bookingUid,
      action: "skipped",
      reason: "invalid_appointment_start",
    };
  }

  // Only trigger appointments inside our 24-hour window.
  if (!isInsideConfirmationWindow(appointmentDate)) {
    return {
      booking_uid: bookingUid,
      action: "skipped",
      reason: "outside_confirmation_window",
      hours_until: hoursUntil(appointmentDate),
    };
  }

  const config = await getConfirmationConfig(booking.client_id);

  if (!config) {
    return {
      booking_uid: bookingUid,
      action: "skipped",
      reason: "missing_confirmation_config",
    };
  }

  if (config.enabled === false) {
    return {
      booking_uid: bookingUid,
      action: "skipped",
      reason: "confirmations_disabled",
    };
  }

  if (!config.outbound_agent_id) {
    return {
      booking_uid: bookingUid,
      action: "skipped",
      reason: "missing_outbound_agent_id",
    };
  }

  if (!config.from_number) {
    return {
      booking_uid: bookingUid,
      action: "skipped",
      reason: "missing_from_number",
    };
  }

  const timeZone =
    config.time_zone ||
    config.timeZone ||
    "America/New_York";

  // This payload matches the fields in your working Zap.
  const zapPayload = {
    agent_id: config.outbound_agent_id,
    to_number: booking.customer_phone,
    from_number: config.from_number,

    client_name: booking.customer_name || "",

    business_name: config.business_name || "",
    agent_name: config.agent_name || "",

    reason_for_call:
      config.reason_for_call || "your upcoming appointment",

    appointment_type: booking.appointment_type || "",

    appointment_date: formatAppointmentDate(
      appointmentDate,
      timeZone
    ),

    appointment_time: formatAppointmentTime(
      appointmentDate,
      timeZone
    ),

    booking_uid: booking.booking_uid || bookingUid,

    // Extra identifiers Zap
