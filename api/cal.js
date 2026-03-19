async function handleAvailability(req, res, body) {
  const resolved = await resolveCalFromAgent(req, body);
  let username = asString(req.headers["x-cal-username"] || body.username || body.args?.username);
  let eventTypeSlug = resolveEventTypeSlug(req, body);

  if (!username && resolved?.username) username = resolved.username;
  if (!eventTypeSlug) eventTypeSlug = pickResolvedSlug(body, resolved);

  const args = body.args || body || {};
  const timeZone = asString(args.timeZone || args.time_zone || body.timeZone) || resolved?.timeZone || "America/New_York";

  if (!username || !eventTypeSlug) {
    return json(res, 400, { 
      error: "Missing Client Config", 
      debug: { username, slug: eventTypeSlug, agentId: resolved?.agentId } 
    });
  }

  const start = asString(body.start_date || body.args?.start_date, ymd(Date.now()));
  const end = asString(body.end_date || body.args?.end_date, ymd(Date.now() + 7 * 24 * 60 * 60 * 1000));
  
  // Use the same stable version we used for the event-type lookup
  const url = `https://api.cal.com/v2/slots?username=${encodeURIComponent(username)}&eventTypeSlug=${encodeURIComponent(eventTypeSlug)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&timeZone=${encodeURIComponent(timeZone)}`;

  try {
    // CHANGE: Using 2024-06-14 for availability as it is the most stable for slots
    const resp = await axios.get(url, { 
      headers: getCalHeaders("2024-06-14") 
    });

    // V2 Slots returns data in resp.data.data.slots or resp.data.data
    const slotsData = resp.data?.data?.slots || resp.data?.data || {};
    const starts = Object.values(slotsData).flat().map((s) => s.start).filter(Boolean);
    
    return json(res, 200, { ok: true, available_slots: starts });
  } catch (err) {
    console.error("AVAILABILITY ERROR:", err?.response?.data || err.message);
    return json(res, 500, { 
      error: "Cal fetch failed", 
      message: extractCalError(err),
      debug: { url, version: "2024-06-14" }
    });
  }
}
