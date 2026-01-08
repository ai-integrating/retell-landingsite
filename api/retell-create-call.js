// --- 5. MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const body = await readJsonBody(req);

    // Helpful debug (see in Vercel logs)
    console.log("Incoming keys:", Object.keys(body || {}));
    console.log("Has instructions:", Boolean(body?.instructions || body?.agent_instructions));

    const headers = {
      Authorization: `Bearer ${process.env.RETELL_API_KEY}`,
      "Content-Type": "application/json",
    };

    // 1) Use Python outputs (your "Handshake")
    const biz_name = pick(body, ["business_name", "biz_name", "company"], "our client");
    const agent_name = pick(body, ["agent_name", "a_name", "name"], "Lexi");
    const resolved_role = String(pick(body, ["agent_role", "a_role", "role"], "receptionist")).toLowerCase().trim();

    const pythonInstructions = pick(body, ["instructions", "agent_instructions"], null);
    const FINAL_PROMPT = (pythonInstructions && pythonInstructions !== "Not provided")
      ? String(pythonInstructions)
      : `## IDENTITY\nYou are ${agent_name}, an assistant for ${biz_name}. Handle calls professionally.`;

    // 2) GUARANTEE voice_id (this prevents the #1 crash)
    const voice_id =
      pick(body, ["voice_id"], null) ||
      resolveVoiceId(body) ||
      process.env.DEFAULT_VOICE_ID;

    if (!voice_id) {
      // Fail fast with a clear error (instead of mysterious 500)
      return res.status(400).json({
        error: "Missing voice_id",
        details: "resolveVoiceId(body) returned empty and DEFAULT_VOICE_ID is not set.",
      });
    }

    // 3) Create LLM
    const llmResp = await axios.post(
      "https://api.retellai.com/create-retell-llm",
      {
        general_prompt: FINAL_PROMPT,
        begin_message: `Hello, thank you for calling ${biz_name}, this is ${agent_name}. How can I help you?`,
        model: "gpt-4o-mini",
      },
      { headers }
    );

    // 4) Create Agent
    const agentResp = await axios.post(
      "https://api.retellai.com/create-agent",
      {
        agent_name: `${biz_name} - ${resolved_role.toUpperCase()}`,
        voice_id,
        response_engine: { type: "retell-llm", llm_id: llmResp.data.llm_id },
        metadata: {
          business_name: String(biz_name),
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
