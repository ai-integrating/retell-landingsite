// /api/google-calendar-event.js

const { kv } = require("@vercel/kv");

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
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

function asString(value) {
  return value === undefined || value === null
    ? ""
    : String(value).trim();
}

function normalizePhoneNumber(phone = "") {
  const raw = asString(phone);
  const digits = raw.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  if (raw.startsWith("+") && digits.length >= 10) {
    return `+${digits}`;
  }

  return "";
}

function extractPhone(...values) {
  for (const value of values) {
    const text = asString(value);

    const match = text.match(
      /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/
    );

    if (match) {
      const normalized = normalizePhoneNumber(match[0]);

      if (normalized) {
        return normalized;
      }
    }
  }

  return "";
}

function extractName(attendeeName, title) {
  const cleanTitle = asString(title);
  const cleanAttendee = asString(attendeeName);

  // Example: "Google Ads Consultation (Rose Dos Santos)"
  const parenthesesMatch = cleanTitle.match(
    /\(([^()]+)\)\s*$/
  );

  if (parenthesesMatch) {
    return parenthesesMatch[1].trim();
  }

  // Example: "Rose Dos Santos-Zoom Video-Medicare Meeting"
  const firstTitleSection =
    cleanTitle.split(/\s*[-–—]\s*/)[0];

  // Ignore Zapier's combined attendee-information block.
  const attendeeLooksStructured =
    /email:|responsestatus:|organizer:|self:/i.test(
      cleanAttendee
    );

  if (cleanAttendee && !attendeeLooksStructured) {
    return cleanAttendee;
  }

  return firstTitleSection || cleanTitle;
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

function normalizeText(value) {
  return asString(value).toLowerCase().replace(/\s+/g, " ");
}

async function findMatchingCalBooking({
  clientId,
  dateIndexKey,
  appointmentStart,
  customerName,
  customerEmail,
}) {
  const bookingUids = (await kv.smembers(dateIndexKey)) || [];
  const requestedStart = new Date(appointmentStart).getTime();

  for (const bookingUid of bookingUids) {
    // Google records begin with gcal:
    if (String(bookingUid).startsWith("gcal:")) {
      continue;
    }

    const booking = await kv.get(`booking:${bookingUid}`);

    if (!booking?.appointment_start) {
      continue;
    }

    const existingStart = new Date(
      booking.appointment_start
    ).getTime();

    // Allow a one-minute difference.
    const sameStart =
      Number.isFinite(existingStart) &&
      Math.abs(existingStart - requestedStart) <= 60000;

    if (!sameStart) {
      continue;
    }

    const sameEmail =
      customerEmail &&
      booking.customer_email &&
      normalizeText(customerEmail) ===
        normalizeText(booking.customer_email);

    const existingName = normalizeText(
      booking.customer_name
    );

    const incomingName = normalizeText(customerName);

    const sameName =
      incomingName &&
      existingName &&
      (incomingName === existingName ||
        incomingName.includes(existingName) ||
        existingName.includes(incomingName));

    if (sameEmail || sameName) {
      return {
        bookingUid,
        booking,
      };
    }
  }

  return null;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return json(res, 405, {
        ok: false,
        error: "Method not allowed",
      });
    }

    const body = await readJsonBody(req);

    const expectedSecret =
      process.env.GOOGLE_CALENDAR_SYNC_SECRET;

    if (
      !expectedSecret ||
      asString(body.sync_secret) !== expectedSecret
    ) {
      return json(res, 401, {
        ok: false,
        error: "Unauthorized",
      });
    }

    const clientId = asString(body.client_id);
    const googleEventId = asString(body.event_id);
    const title = asString(body.title);
    const description = asString(body.description);
    const location = asString(body.location);
    const status = asString(body.status).toLowerCase();
    const appointmentStart = asString(body.start);
    const appointmentEnd = asString(body.end);
    const attendeeName = asString(body.attendee_name);
    const attendeeEmail = asString(body.attendee_email);
    const timeZone =
      asString(body.time_zone) || "America/New_York";

    if (!clientId || !googleEventId || !appointmentStart) {
      return json(res, 400, {
        ok: false,
        error:
          "Missing client_id, event_id, or appointment start",
      });
    }

    const startDate = new Date(appointmentStart);

    if (Number.isNaN(startDate.getTime())) {
      return json(res, 400, {
        ok: false,
        error: "Invalid appointment start",
      });
    }

    const customerName = extractName(
      attendeeName,
      title
    );

    const customerPhone = extractPhone(
      body.phone,
      description,
      location,
      title
    );

    const appointmentDateKey = getDateKey(
      startDate,
      timeZone
    );

    const dateIndexKey =
      `client:${clientId}:confirmations:${appointmentDateKey}`;

    const mappingKey =
      `gcal:${clientId}:${googleEventId}:booking_uid`;

    let bookingUid = await kv.get(mappingKey);
    let existingBooking = null;

    if (bookingUid) {
      existingBooking = await kv.get(
        `booking:${bookingUid}`
      );
    }

    // See if cal.js already saved the same Cal.com booking.
    if (!bookingUid) {
      const match = await findMatchingCalBooking({
        clientId,
        dateIndexKey,
        appointmentStart,
        customerName,
        customerEmail: attendeeEmail,
      });

      if (match) {
        bookingUid = match.bookingUid;
        existingBooking = match.booking;
      }
    }

    // Non-Cal.com appointments use the Google event ID.
    if (!bookingUid) {
      bookingUid =
        `gcal:${clientId}:${googleEventId}`;
    }

    // Remove the appointment from its former date index
    // if Len changed the appointment date.
    if (existingBooking?.appointment_start) {
      const oldDate = getDateKey(
        new Date(existingBooking.appointment_start),
        timeZone
      );

      if (oldDate !== appointmentDateKey) {
        await kv.srem(
          `client:${clientId}:confirmations:${oldDate}`,
          bookingUid
        );
      }
    }

    const isCancelled =
      status === "cancelled" ||
      status === "canceled";

    const startChanged =
      existingBooking?.appointment_start &&
      existingBooking.appointment_start !==
        appointmentStart;

    const bookingRecord = {
      ...(existingBooking || {}),

      booking_uid: bookingUid,
      client_id: clientId,

      google_event_id: googleEventId,
      google_event_link: asString(body.html_link),
      source:
        existingBooking?.source ||
        (String(bookingUid).startsWith("gcal:")
          ? "google_calendar"
          : "cal.com"),

      customer_name:
        customerName ||
        existingBooking?.customer_name ||
        "",

      customer_phone:
        customerPhone ||
        existingBooking?.customer_phone ||
        "",

      customer_email:
        attendeeEmail ||
        existingBooking?.customer_email ||
        "",

      appointment_start: appointmentStart,
      appointment_end: appointmentEnd,
      appointment_type:
        title ||
        existingBooking?.appointment_type ||
        "Appointment",

      location,
      calendar_description: description,
      calendar_status: status || "confirmed",

      confirmation_status: isCancelled
        ? "cancelled"
        : startChanged
          ? "pending"
          : existingBooking?.confirmation_status ||
            "pending",

      confirmation_attempted_at: startChanged
        ? null
        : existingBooking?.confirmation_attempted_at ||
          null,

      created_at:
        existingBooking?.created_at ||
        new Date().toISOString(),

      updated_at: new Date().toISOString(),
    };

    await kv.set(
      `booking:${bookingUid}`,
      bookingRecord
    );

    await kv.set(mappingKey, bookingUid);

    if (isCancelled) {
      await kv.srem(dateIndexKey, bookingUid);
    } else {
      await kv.sadd(dateIndexKey, bookingUid);
    }

    return json(res, 200, {
      ok: true,
      booking_uid: bookingUid,
      matched_existing_cal_booking:
        !String(bookingUid).startsWith("gcal:"),
      phone_found: Boolean(
        bookingRecord.customer_phone
      ),
      confirmation_status:
        bookingRecord.confirmation_status,
      appointment_date: appointmentDateKey,
    });
  } catch (error) {
    console.error(
      "GOOGLE CALENDAR EVENT SYNC ERROR",
      error
    );

    return json(res, 500, {
      ok: false,
      error: "Google Calendar event sync failed",
      detail: error.message,
    });
  }
};
