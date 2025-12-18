import axios from "axios";

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const RETELL_API_KEY = process.env.RETELL_API_KEY;
  const AGENT_ID = process.env.AGENT_ID;

  if (!RETELL_API_KEY || !AGENT_ID) {
    return res.status(500).json({
      error: "Missing RETELL_API_KEY or AGENT_ID in environment variables",
    });
  }

  try {
    // Call Retell API to create a web call
    const response = await axios.post(
      "https://api.retellai.com/v2/create-web-call",
      {
        agent_id: AGENT_ID,
      },
      {
        headers: {
          Authorization: `Bearer ${RETELL_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const { access_token, call_id } = response.data;

    if (!access_token) {
      throw new Error("Retell did not return an access_token");
    }

    // Return ONLY what the frontend needs
    return res.status(200).json({
      access_token,
      call_id,
    });
  } catch (error) {
    console.error("Retell create call error:", error?.response?.data || error);

    return res.status(500).json({
      error: "Failed to create Retell web call",
      details: error?.response?.data || error.message,
    });
  }
}
