// ... (Keep all your CORE UTILITIES and URL logic the same until Section 4) ...

// --- 4. MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const body = await readJsonBody(req);
    const headers = { Authorization: `Bearer ${process.env.RETELL_API_KEY}`, "Content-Type": "application/json" };

    const biz_name = pick(body, ["business_name", "company"], "the business");
    const agent_name = pick(body, ["agent_name", "name"], "Lexi"); // Default to Lexi
    const client_email = pick(body, ["email", "user_email"], "Not provided"); // Capture email for Metadata
    const services = cleanValue(pick(body, ["services"]), "General asphalt and paving services");
    const biz_hours = cleanValue(pick(body, ["business_hours"]), "Standard business hours");

    const website_url = normalizeWebsite(pick(body, ["website", "url"]));
    const website_content = await getWebsiteContext(website_url);

    // --- UPDATED PROMPT WITH URGENCY PROTOCOLS ---
    const FINAL_PROMPT = `
## IDENTITY
- You are ${agent_name}, a professional representative for ${biz_name}.
- Role: Be helpful, concise, and focused.
- Rule: Do NOT mention you are an AI.

## BUSINESS KNOWLEDGE
- Services: ${services}
- Hours: ${biz_hours}
- Website Context: ${website_content ? website_content : "Rely on general industry knowledge for " + services + "."}

## URGENCY & SEVERITY PROTOCOL
1. ROUTINE: For quotes/general info, be professional. Tell them an estimator will call back.
2. URGENT: For potholes/trip hazards, be concerned. Mark as a priority for the supervisor.
3. CRITICAL: For sinkholes or safety hazards, tell them: "I am flagging this as a critical emergency. Please secure the area. Our lead will reach out immediately."

## OPERATIONAL GUIDELINES
- SCHEDULING: ${buildSchedulingFromMapped(body)}
- INTAKE: ${buildIntakeFromMapped(body)}
- EMERGENCY: ${buildEmergencyFromMapped(body)}
- LEAD REVIVAL: ${buildLeadRevivalFromMapped(body)}

## CALL RULES
1. If booking: Ask for day and phone number.
2. Be brief: 1-2 sentences max. 
3. No symbols: Say "dollars" instead of "$".
`.trim();

    // 1. Create the LLM
    const llmResp = await axios.post("https://api.retellai.com/create-retell-llm", {
      general_prompt: FINAL_PROMPT,
      begin_message: `Thanks for calling ${biz_name}, this is ${agent_name}. How can I help you?`,
      model: "gpt-4o-mini",
    }, { headers });

    // 2. Create the Agent with METADATA
    // This solves your Zapier identification problem!
    const agentResp = await axios.post("https://api.retellai.com/create-agent", {
      agent_name: `${biz_name} Agent`,
      voice_id: resolveVoiceId(body),
      response_engine: { type: "retell-llm", llm_id: llmResp.data.llm_id },
      // Added Metadata below
      metadata: {
        business_name: biz_name,
        notification_email: client_email,
        vending_machine_id: "automated_deploy_01"
      }
    }, { headers });

    return res.status(200).json({ ok: true, agent_id: agentResp.data.agent_id });
  } catch (error) {
    console.error("Failed:", error?.response?.data || error.message);
    return res.status(500).json({ error: "Server error" });
  }
};
