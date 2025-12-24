const axios = require("axios");

// --- UTILITIES & FILTERS ---
global.__seenCalls = global.__seenCalls || new Set();
const decodeHtml = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
function pick(obj, keys, fallback = "Not provided") {
  for (const k of keys) {
    let val = obj?.[k];
    if (val !== undefined && val !== null && val !== "") return (typeof val === "object" && val.output) ? val.output : val;
  }
  return fallback;
}

// --- MAIN HANDLER ---
module.exports = async function handler(req, res) {
  // 1. Identify if this is Retell calling the Webhook OR Jotform calling the Provisioner
  const payload = req.body || {};
  
  // ✅ ROUTE A: RETELL WEBHOOK (The code you just pasted)
  if (payload.event === "call_analyzed" || payload.event === "call_ended") {
      try {
        const metadata = payload.metadata || {};
        const callId = payload.call_id || payload.id;
        
        // Dedupe
        if (callId && global.__seenCalls.has(callId)) return res.status(200).json({ ok: true, deduped: true });
        if (callId) { global.__seenCalls.add(callId); setTimeout(() => global.__seenCalls.delete(callId), 10 * 60 * 1000); }

        // Decision Logic (Gating)
        const analysis = payload.call_analysis || {};
        const isUrgent = analysis.is_urgent || false;
        const notifyPhone = metadata.notify_phone;

        if (isUrgent && notifyPhone) {
            const auth = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString("base64");
            await axios.post(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`,
                new URLSearchParams({ To: notifyPhone, From: process.env.TWILIO_FROM, Body: `🚨 Urgent: ${analysis.call_summary}` }).toString(),
                { headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" } }
            );
        }
        return res.status(200).json({ ok: true, type: "webhook_processed" });
      } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ✅ ROUTE B: PROVISIONING (The code that makes the agent)
  if (req.method === "POST" && !payload.event) {
    try {
        const biz_name = pick(payload, ["business_name"], "the business");
        const RETELL_API_KEY = process.env.RETELL_API_KEY;
        const headers = { Authorization: `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" };

        // 1. Create LLM
        const llmResp = await axios.post("https://api.retellai.com/create-retell-llm", {
            general_prompt: `You are Allie with ${biz_name}...`, // (Your full prompt goes here)
            begin_message: `Hi, thanks for calling ${biz_name}.`,
            model: "gpt-4o-mini",
        }, { headers });

        // 2. Create Agent
        const agentResp = await axios.post("https://api.retellai.com/create-agent", {
            agent_name: `${biz_name} Agent`,
            voice_id: process.env.DEFAULT_VOICE_ID,
            response_engine: { type: "retell-llm", llm_id: llmResp.data.llm_id },
            metadata: { 
                notify_phone: pick(payload, ["notify_phone"]),
                business_name: biz_name
            }
        }, { headers });

        return res.status(200).json({ ok: true, agent_id: agentResp.data.agent_id });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: "Method Not Allowed or Missing Event" });
};
