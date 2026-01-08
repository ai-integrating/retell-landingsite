// --- 5. MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const body = await readJsonBody(req);
    const headers = { Authorization: `Bearer ${process.env.RETELL_API_KEY}`, "Content-Type": "application/json" };

    // --- 1. EXTRACT METADATA ---
    const biz_name = pick(body, ["business_name", "company"], "our business");
    const agent_name = pick(body, ["agent_name", "name"], "Lexi");
    const client_email = pick(body, ["email", "user_email"], "not-provided@example.com");
    const services = cleanValue(pick(body, ["services"]), "standard industry services");
    const biz_hours = cleanValue(pick(body, ["business_hours"]), "Monday through Friday, 9 AM to 5 PM");

    const raw_emergency = cleanValue(pick(body, ["emergency_phone"]), "Not provided");
    const speech_emergency = raw_emergency !== "Not provided" ? raw_emergency.split('').join('-') : "our main office number";

    // --- 2. WEBSITE SCRAPER LOGIC ---
    // This looks for a website URL in the payload and attempts to scrape context
    const website_url = normalizeWebsite(pick(body, ["website", "url"]));
    let website_content = null;
    
    if (website_url && website_url !== "Not provided") {
        try {
            // Race the scraper against a 6-second timeout to keep the Zap fast
            website_content = await Promise.race([
                getWebsiteContext(website_url),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Scrape Timeout')), 6000))
            ]);
            console.log("Successfully scraped website context.");
        } catch (e) { 
            console.log("Website scraper failed or timed out. Using fallback."); 
        }
    }

    // --- 3. DYNAMIC PROMPT CONSTRUCTION ---
    // Check if Zapier sent a fully built instruction block via Python
    const pythonInstructions = pick(body, ["instructions", "agent_instructions"], null);

    // If Python instructions exist, we use them. Otherwise, we build the Emergency template.
    const FINAL_PROMPT = (pythonInstructions && pythonInstructions !== "Not provided") 
      ? pythonInstructions 
      : `
## IDENTITY
- You are ${agent_name}, the Emergency Dispatcher for ${biz_name}.
- Role: Maintain a calm, authoritative, and urgent demeanor.
- Rule: Do NOT mention you are an AI.

## BUSINESS KNOWLEDGE
- Services: ${services}
- Hours: Dispatch is active 24/7 for emergency safety concerns.
- Website Context: ${website_content ? website_content : "Rely on industry standards for safety and emergency repair."}

## DISPATCH TRIAGE PROTOCOL
1. **Identify the Hazard:** Ask: "What is the nature of the emergency, and is the area currently safe?"
2. **Assign Severity:** CRITICAL (immediate danger) vs. URGENT (damage/failure).

## OPERATIONAL GUIDELINES
- INTAKE: You MUST get the exact street address and a callback number.
- EMERGENCY CONTACT: ${speech_emergency}. 
- SCHEDULING: ${buildSchedulingFromMapped(body)}
- LEAD REVIVAL: ${buildLeadRevivalFromMapped(body)}
`.trim();

    // --- 4. RETELL API DEPLOYMENT ---
    const llmResp = await axios.post("https://api.retellai.com/create-retell-llm", {
      general_prompt: FINAL_PROMPT,
      begin_message: `Emergency Dispatch for ${biz_name}, this is ${agent_name}. What is the nature of your emergency?`,
      model: "gpt-4o-mini",
    }, { headers });

    const agentResp = await axios.post("https://api.retellai.com/create-agent", {
      agent_name: `${biz_name} Agent`,
      voice_id: resolveVoiceId(body),
      response_engine: { type: "retell-llm", llm_id: llmResp.data.llm_id },
      metadata: {
        business_name: String(biz_name),
        agent_type: "dynamic_vending_machine"
      }
    }, { headers });

    return res.status(200).json({ ok: true, agent_id: agentResp.data.agent_id });

  } catch (error) {
    console.error("CRITICAL ERROR:", error?.response?.data || error.message);
    return res.status(500).json({ error: "Server error", details: error.message });
  }
};
