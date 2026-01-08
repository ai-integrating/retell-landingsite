// --- 5. MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const body = await readJsonBody(req);
    const headers = { Authorization: `Bearer ${process.env.RETELL_API_KEY}`, "Content-Type": "application/json" };

    // 1. EXTRACT METADATA
    const biz_name = pick(body, ["business_name", "company"], "our client");
    const agent_name = pick(body, ["agent_name", "name"], "Lexi");
    const client_email = pick(body, ["email", "user_email"], "not-provided@example.com");

    const resolved_role = String(pick(body, ["agent_role", "role"], "receptionist")).toLowerCase().trim();

    // 2. WEBSITE SCRAPER (optional context)
    const website_url = normalizeWebsite(pick(body, ["website", "url"]));
    let website_content = null;
    if (website_url && website_url !== "Not provided") {
      try {
        website_content = await Promise.race([
          getWebsiteContext(website_url),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 6000)),
        ]);
      } catch (e) {
        console.log("Website timeout.");
      }
    }

    // 3. PRIORITY LOGIC GATE (prefer agent_instructions)
    const pythonInstructions = pick(body, ["agent_instructions", "instructions"], null);

    const FINAL_PROMPT =
      pythonInstructions && pythonInstructions !== "Not provided"
        ? pythonInstructions
        : `## IDENTITY\nYou are ${agent_name}, an assistant for ${biz_name}. Handle calls professionally.`.trim();

    // Role-aware begin message
    const beginMap = {
      scheduler: `Scheduling for ${biz_name}, this is ${agent_name}. What day and time would you like to book?`,
      intake: `${biz_name}, this is ${agent_name}. What service are you looking for today?`,
      receptionist: `${biz_name}, this is ${agent_name}. How can I help you today?`,
      operations: `${biz_name}, this is ${agent_name}. How can I help you today?`,
      emergency_dispatch: `Emergency Dispatch for ${biz_name}, this is ${agent_name}. What is the nature of your emergency?`,
      lead_revival: `${biz_name}, this is ${agent_name}. I’m following up—are you still looking to move forward?`,
    };

    const begin_message =
      beginMap[resolved_role] ||
      `Hello, thank you for calling ${biz_name}, this is ${agent_name}. How can I help you?`;

    // 4. RETELL LLM DEPLOYMENT
    const llmResp = await axios.post(
      "https://api.retellai.com/create-retell-llm",
      {
        general_prompt: FINAL_PROMPT,
        begin_message,
        model: "gpt-4o-mini",
      },
      { headers }
    );

    // 5. RETELL AGENT DEPLOYMENT
    const agentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        agent_name: `${biz_name} - ${resolved_role.toUpperCase()}`,
        voice_id: resolveVoiceId(body) || process.env.DEFAULT_VOICE_ID,
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
    console.error("CRITICAL ERROR:", error?.response?.data || error.message);
    return res.status(500).json({ error: "Server error", details: error.message });
  }
};
