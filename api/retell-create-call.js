// --- 5. MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const body = await readJsonBody(req);
    const headers = {
      Authorization: `Bearer ${process.env.RETELL_API_KEY}`,
      "Content-Type": "application/json",
    };

    // 1. EXTRACT METADATA
    const biz_name = pick(body, ["business_name", "company"], "McDuffy and Son Asphalt");
    const agent_name = pick(body, ["agent_name", "name"], "Lexi");
    const client_email = pick(body, ["email", "user_email"], "not-provided@example.com");
    const services = cleanValue(pick(body, ["services"]), "standard industry services");
    const biz_hours = cleanValue(pick(body, ["business_hours"]), "Monday through Friday, 8 AM to 5 PM");
    const resolved_role = String(pick(body, ["agent_role", "role"], "receptionist")).toLowerCase().trim();

    // 2. RUN WEBSITE SCRAPER (THE NEW INSERT)
    const website_url = normalizeWebsite(pick(body, ["website", "url"]));
    let website_content = null;
    
    if (website_url && website_url !== "Not provided") {
      try {
        // Race the scraper against a 6-second timeout to prevent Zapier timeouts
        website_content = await Promise.race([
          getWebsiteContext(website_url),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 6000)),
        ]);
        console.log("Scrape successful for:", website_url);
      } catch (e) {
        console.log("Website scraper timed out or failed.");
      }
    }

    // 3. PRIORITY LOGIC GATE (The Python Handshake)
    const pythonInstructions = pick(body, ["instructions", "agent_instructions"], null);
    
    // Start with the Python-built brain
    let FINAL_PROMPT = pythonInstructions && pythonInstructions !== "Not provided"
        ? String(pythonInstructions)
        : `## IDENTITY\n- You are ${agent_name}, the ${resolved_role} for ${biz_name}.`;

    // ADD the scraped website context as supplemental knowledge
    if (website_content) {
      FINAL_PROMPT += `\n\n## SUPPLEMENTAL WEBSITE CONTEXT\n${website_content}`;
    }

    // 4. DEPLOY TO RETELL AI
    const voice_id = resolveVoiceId(body) || process.env.DEFAULT_VOICE_ID;
    
    const llmResp = await axios.post(
      "https://api.retellai.com/create-retell-llm",
      {
        general_prompt: FINAL_PROMPT,
        // Prioritize custom greeting from Python
        begin_message: pick(body, ["begin_message", "welcome_message"], `Hello, thank you for calling ${biz_name}.`),
        model: "gpt-4o-mini",
      },
      { headers }
    );

    const agentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        agent_name: `${biz_name} - ${resolved_role.toUpperCase()}`,
        voice_id: voice_id,
        response_engine: { type: "retell-llm", llm_id: llmResp.data.llm_id },
        metadata: {
          business_name: String(biz_name),
          notification_email: String(client_email),
          agent_type: resolved_role,
        },
      },
      { headers }
    );

    return res.status(200).json({ ok: true, agent_id: agentResp.data.agent_id });

  } catch (error) {
    const details = error?.response?.data || error.message;
    console.error("CRITICAL ERROR:", details);
    return res.status(500).json({ error: "Server error", details });
  }
};
