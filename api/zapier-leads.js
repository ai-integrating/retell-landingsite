// /api/zapier-leads.js

module.exports = async function handler(req, res) {
  // --- CORS (important for Zapier & browser tests) ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  // Preflight request
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed. Use POST."
    });
  }

  try {
    // Zapier will send JSON in req.body
    const lead = req.body || {};

    // You can customize these fields later
    const response = {
      success: true,
      received_at: new Date().toISOString(),
      lead: {
        name: lead.name || null,
        email: lead.email || null,
        phone: lead.phone || null,
        business_name: lead.business_name || null,
        package_type: lead.package_type || null,
        raw: lead
      }
    };

    return res.status(200).json(response);
  } catch (error) {
    console.error("Zapier Leads Error:", error);
    return res.status(500).json({
      success: false,
      error: "Internal Server Error"
    });
  }
};
