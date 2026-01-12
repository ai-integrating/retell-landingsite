// /api/retell-refine-agent.js
const axios = require("axios");

// --- 1. CORE UTILITIES (match your create-call style) ---
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Refinement-Secret");
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
  });
}

const decodeHtml = (s) =>
  String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

function normalizeCategories(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.map(String).map((x) => x.trim()).filter(Boolean);
  return String(input).split(",").map((x) => x.trim()).filter(Boolean);
}

function nowIso() {
  return new Date().toISOString();
}

// --- 2. SAFE GUARDRAILS (prevent stealth upgrades) ---
const ALLOWED_CATEGORIES = new Set([
  "Pricing or service rates",
  "Services offered",
  "Business hours / holiday schedule",
  "Promotions or discounts",
  "Policies",
  "Other",
]);

const UPGRADE_KEYWORDS = [
  "emergency", "dispatch", "triage", "transfer", "forward", "escalate", "on-call",
  "text", "sms", "notify", "webhook",
  "spanish", "portuguese", "french", "translate", "language",
  "schedule automatically", "book automatically",
];

function findUpgradeHits(text) {
  const hay = String(text || "").toLowerCase();
  return UPGRADE_KEYWORDS.filter((k) => hay.includes(k));
}

// --- 3. RETELL HELPERS ---
const RETELL_BASE = "https://api.retellai.com";
const RETELL_API_KEY = process.env.RETELL_API_KEY;
const REFINEMENT_SECRET = process.env.REFINEMENT_SECRET;

function retellHeaders() {
  return {
    Authorization: `Bearer ${RETELL_API_KEY}`,
    "Content-Type": "application/json",
  };
}

// --- 4. MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).send("ok");
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST." });

  try {
    if (!RETELL_API_KEY) return res.status(500).json({ ok: false, error: "Missing RETELL_API_KEY." });
    if (!REFINEMENT_SECRET) return res.status(500).json({ ok: false, error: "Missing REFINEMENT_SECRET." });

    const secret = req.headers["x-refinement-secret"];
    if (secret !== REFINEMENT_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized (bad secret)." });
    }

    const body = await readJsonBody(req);

    const refinement_request_id = decodeHtml(body.refinement_request_id || body.request_id || "");
    const agent_id = decodeHtml(body.agent_id || "");
    const categories = normalizeCategories(body.categories || body.category);
    const update_text = decodeHtml(body.update_text || "").trim();
    const communication_preference = decodeHtml(body.communication_preference || "").trim();
    const publish = body.publish === true; // optional

    if (!agent_id) return res.status(400).json({ ok: false, error: "Missing agent_id." });
    if (!categories.length) return res.status(400).json({ ok: false, error: "Missing categories." });
    if (!update_text) return res.status(400).json({ ok: false, error: "Missing update_text." });

    // category allowlist
    const badCats = categories.filter((c) => !ALLOWED_CATEGORIES.has(c));
    if (badCats.length) {
      return res.status(400).json({ ok: false, error: "Unknown category.", bad_categories: badCats });
    }

    // upgrade gating (keywords)
    const hits = findUpgradeHits(`${categories.join(" ")}\n${update_text}`);
    if (hits.length) {
      return res.status(402).json({
        ok: false,
        upgrade_required: true,
        matched_keywords: hits,
      });
    }

    // A) get agent -> llm_id
    const agentResp = await axios.get(`${RETELL_BASE}/get-agent/${agent_id}`, {
      headers: retellHeaders(),
    });
    const agent = agentResp.data;

    const responseEngine = agent?.response_engine;
    const llm_id = responseEngine?.type === "retell-llm" ? responseEngine?.llm_id : null;

    if (!llm_id) {
      return res.status(400).json({
        ok: false,
        error: "Agent is not using retell-llm response engine (cannot apply refinement via prompt patch).",
        response_engine: responseEngine || null,
      });
    }

    // B) get llm -> current prompt
    const llmResp = await axios.get(`${RETELL_BASE}/get-retell-llm/${llm_id}`, {
      headers: retellHeaders(),
    });
    const currentPrompt = String(llmResp.data?.general_prompt || "").trim();

    // C) append refinement patch (safe, additive)
    const patch =
      `\n\n---\n` +
      `REFINEMENT PATCH\n` +
      `Timestamp: ${nowIso()}\n` +
      (refinement_request_id ? `Request ID: ${refinement_request_id}\n` : "") +
      `Categories: ${categories.join(", ")}\n` +
      (communication_preference ? `Communication: ${communication_preference}\n` : "") +
      `\n` +
      `${update_text}\n`;

    // Optional: cap prompt growth
    const MAX_CHARS = 24000;
    let nextPrompt = (currentPrompt ? currentPrompt + patch : patch.trim());
    if (nextPrompt.length > MAX_CHARS) {
      nextPrompt = `...TRUNCATED OLDER CONTENT...\n` + nextPrompt.slice(nextPrompt.length - MAX_CHARS);
    }

    // D) update llm
    const upd = await axios.patch(
      `${RETELL_BASE}/update-retell-llm/${llm_id}`,
      { general_prompt: nextPrompt },
      { headers: retellHeaders() }
    );

    // E) publish (optional)
    let pub = null;
    if (publish) {
      const pubResp = await axios.post(
        `${RETELL_BASE}/publish-agent/${agent_id}`,
        {},
        { headers: retellHeaders() }
      );
      pub = pubResp.data;
    }

    return res.status(200).json({
      ok: true,
      agent_id,
      llm_id,
      published: Boolean(pub),
      message: publish ? "Refinement applied + published." : "Refinement applied (draft).",
      retell_update: upd.data,
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    const detail = err?.response?.data || err?.message || "Unknown error";
    return res.status(status).json({ ok: false, error: "Refinement failed.", detail });
  }
};
