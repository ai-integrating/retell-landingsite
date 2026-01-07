// --- 5. MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const body = await readJsonBody(req);
    const headers = { Authorization: `Bearer ${process.env.RETELL_API_KEY}`, "Content-Type": "application/json" };

    // Basic Metadata Extraction
    const biz_name = pick(body, ["business_name", "company"], "our business");
    const agent_name = pick(body, ["agent_name", "name"], "Lexi");
    const client_email = pick(body, ["email", "user_email"], "not-provided@example.com");

    // Dynamic Role Resolution
    const resolved_role = String(pick(body, ["agent_role", "role"], "receptionist")).toLowerCase().trim();
    const roleLabelMap = {
      operations: "Operations Manager",
      receptionist: "Receptionist",
      intake: "Intake Specialist",
      scheduler: "Scheduler",
      emergency_dispatch: "Emergency Dispatcher",
      lead_revival: "Lead Revival Specialist",
    };
    const roleLabel = roleLabelMap[resolved_role] || "Operations Manager";

    // --- PROMPT LOGIC GATE ---
    // This checks if Python sent custom instructions. If not, it builds a simple default.
    const pythonInstructions = pick(body, ["instructions", "agent_instructions"], null);
    
    const FINAL_PROMPT = (pythonInstructions && pythonInstructions !== "Not provided") 
      ? pythonInstructions 
      : `
## IDENTITY
- You are ${agent_name}, the ${roleLabel} for ${biz_name}.
- Rule: Do NOT mention you are an AI.

## CORE OBJECTIVE
Handle incoming calls professionally. Take a message, name, and phone number for a callback.
`.trim();

    // Set a dynamic begin message based on business name
    const defaultBeginMessage = `Hello, thank you for calling ${biz_name}, this is ${agent_name}. How can I help you today?`;

    // 1. Create Retell LLM
    const llmResp = await axios.post(
      "https://api.retellai.com/create-retell-llm",
      {
        general_prompt: FINAL_PROMPT,
        begin_message: defaultBeginMessage,
        model: "gpt-4o-mini",
      },
      { headers }
    );

    // 2. Create Retell Agent
    const agentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        agent_name: `${biz_name} - ${roleLabel}`,
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
