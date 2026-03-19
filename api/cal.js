async function handleBook(req, res, body) {
  const resolved = await resolveCalFromAgent(req, body);
  let username = asString(req.headers["x-cal-username"] || body.username || body.args?.username);
  let eventTypeSlug = resolveEventTypeSlug(req, body);

  if (!username && resolved?.username) username = resolved.username;
  if (!eventTypeSlug) eventTypeSlug = pickResolvedSlug(body, resolved);

  const args = body.args || body || {};
  const start = asString(args.start || args.slot || args.selected_start || args.time);
  const name = asString(args.attendee_name || args.name || args.customer_name || args.full_name);
  const email = asString(args.attendee_email || args.email || args.customer_email).toLowerCase();
  const phone = asString(args.phone || args.phoneNumber || args.phone_number);
  const timeZone = asString(args.timeZone || args.time_zone) || resolved?.timeZone || "America/New_York";

  if (!start || !name || !email || !username || !eventTypeSlug) {
    return json(res, 400, { 
      error: "Missing details", 
      debug: { hasStart: !!start, hasName: !!name, hasEmail: !!email, username, eventTypeSlug } 
    });
  }

  // 1. Build the base payload WITHOUT eventTypeId
  const v1Payload = {
    start,
    name,
    email,
    username,
    eventTypeSlug,
    timeZone,
    language: "en",
    metadata: {},
    ...(phone ? { smsReminderNumber: phone } : {})
  };

  // 2. ONLY add the key if we have a real number. 
  // If rawId is null/undefined, the key 'eventTypeId' will NOT exist in the JSON.
  const rawId = args.eventTypeId || args.event_type_id || req.headers["x-cal-event-id"];
  if (rawId && !isNaN(rawId) && rawId !== "null") {
    v1Payload.eventTypeId = Number(rawId);
  }

  try {
    const resp = await axios.post("https://api.cal.com/v1/bookings", v1Payload, {
      params: { apiKey: process.env.CAL_API_KEY }
    });
    return json(res, 200, { ok: true, booking: resp.data });
  } catch (err) {
    const msg = extractCalError(err);
    console.error("CAL V1 BOOK ERROR:", msg);
    // Return the specific Cal error so we can see if it still complains about the ID
    return json(res, 500, { error: "Booking failed", message: msg, debugPayload: v1Payload });
  }
}
