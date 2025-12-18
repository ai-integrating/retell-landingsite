export default async function handler(req, res) {
  // --- CORS (important for browser tests + some integrations) ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Preflight request
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Vercel will parse JSON automatically when content-type is application/json
    const body = req.body || {};

    const { full_name, email, phone, lead_source, message } = body;

    // --- Validation (matches what Mumtaz told you) ---
    const missing = [];
    if (!full_name) missing.push("full_name");
    if (!email) missing.push("email");
    if (!phone) missing.push("phone");
    if (!lead_source) missing.push("lead_source");
    if (!message) missing.push("message");

    if (missing.length) {
      return res.status(400).json({
        error: "Missing required fields",
        missing,
        received: body,
      });
    }

    // --- Success response ---
    // (Right now we just accept + confirm. Later we can forward to Sheets/CRM/etc.)
    return res.status(200).json({
      ok: true,
      received: { full_name, email, phone, lead_source, message },
      received_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("zapier-leads error:", err);
    return res.status(500).json({
      error: "Server error",
      details: err?.message || "Unknown error",
    });
  }
}
