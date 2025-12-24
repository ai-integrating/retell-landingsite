const axios = require("axios");

// --- HELPERS (SAME AS BEFORE) ---
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

const decodeHtml = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");

function pick(obj, keys, fallback = "Not provided") {
  for (const k of keys) {
    let val = obj?.[k];
    if (val !== undefined && val !== null && val !== "") {
      if (typeof val === "object" && val.output) return val.output;
      return val;
    }
  }
  return fallback;
}

// --- SMART FACT EXTRACTION ---
function buildWebsiteFacts(text, businessTypeHint = "") {
  if (!text) return "";
  const raw = String(text);
  const lower = raw.toLowerCase();

  const tradeBoosters = {
    hvac: ["air conditioning", "ac", "heating", "furnace", "boiler", "heat pump", "duct repair"],
    plumbing: ["drain cleaning", "pipe repair", "leak detection", "water heater", "sewer", "toilet repair"],
    paving: ["asphalt paving", "sealcoating", "patchwork", "crack filling", "line painting", "excavation", "curbing", "sidewalks", "hauling", "snow removal"],
    roofing: ["roof repair", "shingle replacement", "flat roof", "leak repair", "siding", "gutters"]
  };

  let booster = [];
  const hint = String(businessTypeHint || "").toLowerCase();
  
  // Try Hint first
  for (const key of Object.keys(tradeBoosters)) { if (hint.includes(key)) booster = tradeBoosters[key]; }

  // ✅ Auto-detect trade from text if hint is missing/weak
  if (!booster.length) {
    if (lower.includes("asphalt") || lower.includes("paving") || lower.includes("sealcoating")) booster = tradeBoosters.paving;
    else if (lower.includes("plumbing") || lower.includes("drain") || lower.includes("pipe")) booster = tradeBoosters.plumbing;
    else if (lower.includes("furnace") || lower.includes("hvac") || lower.includes("heating")) booster = tradeBoosters.hvac;
  }

  const generic = ["repair", "installation", "maintenance", "emergency service"];
  const services = Array.from(new Set([...booster, ...generic])).filter(k => lower.includes(k)).slice(0, 12);

  const lines = [];
  if (services.length) lines.push(`- Services: ${services.join(", ")}.`);
  if (lower.includes("residential") || lower.includes("commercial")) {
    const rc = [lower.includes("residential") ? "Residential" : null, lower.includes("commercial") ? "Commercial" : null].filter(Boolean).join(" + ");
    lines.push(`- Serving: ${rc} customers.`);
  }
  if (lower.includes("free quote") || lower.includes("free estimate")) lines.push(`- Offers: Free quotes/estimates.`);

  return lines.length ? `WEBSITE FACTS:\n${lines.join("\n")}` : "";
}

// --- MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const body = await readJsonBody(req);
    const biz_name = pick(body, ["business_name", "businessName"], "the business");
    const biz_type = pick(body, ["primary_type_of_business", "industry"], "");
    
    // Scraper implementation (Assume getWebsiteContext is defined)
    const website_url = pick(body, ["website"]);
    const website_content = await getWebsiteContext(website_url); 
    const structured_facts = buildWebsiteFacts(website_content, biz_type);

    const FINAL_PROMPT = `
IDENTITY: 
- You are Ava with ${biz_name}.
- If asked "who are you?" or "who am I speaking to?", say: "This is Ava with ${biz_name}."
- Do NOT volunteer that you are an AI. Only acknowledge being an AI if explicitly asked: "Are you an AI?" or "Is this a robot?"
- If pressed for more detail, say: "I’m part of the office team here and help handle incoming calls."

STYLE: Warm, human, concise. Never guess. Confidently admit if you don't know something.

${structured_facts}

SCHEDULING: ${pick(body, ["scheduling_details"])}
RULE: Do NOT confirm a time slot. Collect windows for a callback.
`.trim();

    // Call Retell and return success
    // (Retell axios call here)

    return res.status(200).json({ ok: true, agent_id: agentResp.data.agent_id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
