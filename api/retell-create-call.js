const axios = require("axios");

// --- 1. GLOBAL DEDUPLICATION (PREVENTS DOUBLE TEXTS) ---
global.__seenCalls = global.__seenCalls || new Set();

// --- 2. NOTIFICATION ENGINES ---

async function sendTwilioSms({ to, body }) {
  const auth = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString("base64");
  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`,
    new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: body }).toString(),
    { headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" } }
  );
}

async function sendResendEmail({ to, subject, html }) {
  await axios.post("https://api.resend.com/emails", {
    from: "Allie <notifications@aiintegrating.com>",
    to: [to],
    subject: subject,
    html: html
  }, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
}

async function logToNotion({ business, caller, status, summary, recordingUrl }) {
  if (!process.env.NOTION_TOKEN || !process.env.NOTION_DATA_SOURCE_ID) return;
  await axios.post("https://api.notion.com/v1/pages", {
    parent: { type: "data_source_id", data_source_id: process.env.NOTION_DATA_SOURCE_ID },
    properties: {
      "Business": { title: [{ text: { content: business || "Unknown" } }] },
      "Caller": { rich_text: [{ text: { content: caller || "Unknown" } }] },
      "Status": { select: { name: status || "Info" } },
      "Summary": { rich_text: [{ text: { content: (summary || "").slice(0, 1800) } }] },
      "Recording": recordingUrl ? { url: recordingUrl } : { url: null }
    }
  }, {
    headers: { 
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`, 
      "Notion-Version": "2025-09-03", 
      "Content-Type": "application/json" 
    }
  });
}

// --- 3. DECISION LOGIC (GATING) ---

function evaluateNeeds(payload) {
  const analysis = payload.call_analysis || {};
  const durationMs = Number(payload.call_duration_ms || 0);
  
  // Wait for the analysis event and ignore short spam calls
  if (payload.event !== "call_analyzed" || durationMs < 20000) return { sms: false, reason: "Informational" };

  if (analysis.is_urgent) return { sms: true, reason: "🚨 Urgent" };
  if (analysis.callback_requested) return { sms: true, reason: "📞 Callback" };
  
  const leadTerms = ["estimate", "quote", "price", "paving", "sealcoat", "driveway"];
  const isLead = leadTerms.some(t => String(analysis.call_summary).toLowerCase().includes(t));
  if (isLead && String(analysis.call_summary).length > 65) return { sms: true, reason: "💰 Lead" };

  return { sms: false, reason: "Recap" };
}

// --- 4. MAIN HANDLER ---

module.exports = async function handler(req, res) {
  // SECURITY: Ensure only Retell can call this endpoint
  const secret = req.headers["x-webhook-secret"];
  if (process.env.RETELL_WEBHOOK_SECRET && secret !== process.env.RETELL_WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  if (req.method !== "POST") return res.status(405).end();

  try {
    const payload = req.body || {};
    
    // DEDUPLICATION: Don't process the same call twice
    const callId = payload.call_id || payload.id;
    if (callId) {
      if (global.__seenCalls.has(callId)) return res.status(200).json({ ok: true, deduped: true });
      global.__seenCalls.add(callId);
      setTimeout(() => global.__seenCalls.delete(callId), 10 * 60 * 1000); // 10 min window
    }

    const metadata = payload.metadata || {};
    const bizName = metadata.business_name || "Client";
    const decision = evaluateNeeds(payload);

    // 1. Log to Notion (Premium Tier)
    await logToNotion({
      business: bizName,
      caller: payload.from_number || "Unknown",
      status: decision.reason,
      summary: payload.call_analysis?.call_summary,
      recordingUrl: payload.recording_url
    });

    // 2. Email (Standard Tier) - Only on analyzed event
    if (metadata.client_email && payload.event === "call_analyzed") {
      await sendResendEmail({
        to: metadata.client_email,
        subject: `Allie Recap: ${bizName} - ${decision.reason}`,
        html: `<p><strong>Summary:</strong> ${payload.call_analysis?.call_summary}</p><p><a href="${payload.recording_url}">Listen to Recording</a></p>`
      });
    }

    // 3. SMS (Priority Tier)
    if (decision.sms && metadata.notify_phone) {
      await sendTwilioSms({
        to: metadata.notify_phone,
        body: `Allie Recap: ${decision.reason}\n${payload.call_analysis?.call_summary?.slice(0, 140)}`
      });
    }

    return res.status(200).json({ ok: true, decision: decision.reason });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
