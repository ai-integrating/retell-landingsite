// /api/refinement — legacy requests remain supported; explicit operations fail closed.
const { createHash, timingSafeEqual } = require("node:crypto");
const { replaceBusiness, OPERATION } = require("../lib/refinement-business");
const { withLlm } = require("../lib/refinement-coordinator");
const { hash, BEGIN, END, fail } = require("../lib/refinement-section");
const { publishLegacy } = require("../lib/refinement-publication");
const { publishBusiness, PUBLISH_OPERATION } = require("../lib/business-publication");
const { legacyPublicationGuard } = require("../lib/legacy-publication-guard");
const { BUSINESS_SECTION_PILOT_ENABLED, PILOT, pilotMatches } = require("../lib/business-rollout");

// RELEASE BLOCKER: no remote CAS / protection from uncoordinated Retell writers.
// Not controlled by request data or environment. Test factory can exercise mocks.
const SECTION_REPLACEMENT_ENABLED = false;

// --- 1. CORE UTILITIES (match your create-call style) ---
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Refinement-Secret"
  );
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
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
  if (Array.isArray(input))
    return input.map(String).map((x) => x.trim()).filter(Boolean);
  return String(input)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function nowIso() {
  return new Date().toISOString();
}

// --- 2. SAFE GUARDRAILS (prevent stealth upgrades) ---
const ALLOWED_CATEGORIES = new Set([
  "pricing",
  "services",
  "business_hours",
  "promotions",
  "policies",
  "other",
  "holiday_hours", // only if you use it
]);

const UPGRADE_KEYWORDS = [
  "emergency",
  "dispatch",
  "triage",
  "transfer",
  "forward",
  "escalate",
  "on-call",
  "text",
  "sms",
  "notify",
  "webhook",
  "spanish",
  "portuguese",
  "french",
  "translate",
  "language",
  "schedule automatically",
  "book automatically",
];

function findUpgradeHits(text) {
  const hay = String(text || "").toLowerCase();
  return UPGRADE_KEYWORDS.filter((k) => hay.includes(k));
}

// --- 3. RETELL HELPERS ---
const RETELL_BASE = "https://api.retellai.com";
function createHandler({ axios, kv, apiKey: RETELL_API_KEY, secret: REFINEMENT_SECRET, enableSection = false, enablePilot = false }) {

function retellHeaders() {
  return {
    Authorization: `Bearer ${RETELL_API_KEY}`,
    "Content-Type": "application/json",
  };
}

// --- 4. MAIN HANDLER ---
return require("../lib/ownership-budget").handler(async function handler(req, res) {
  setCors(res);
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).send("ok");
  if (req.method !== "POST")
    return res.status(405).json({
      ok: false,
      skipped: false,
      agent_id: null,
      llm_id: null,
      published: false,
      message: null,
      refinement_request_id: null,
      error: "Use POST.",
      detail: null,
    });

  // Keep these in outer scope so we can always return them (even on errors)
  let agent_id = null;
  let llm_id = null;
  let refinement_request_id = null;
  let published = false;
  let draft_applied = false;
  let publication_requested = false;

  try {
    if (!RETELL_API_KEY)
      return res.status(500).json({
        ok: false,
        skipped: false,
        agent_id: null,
        llm_id: null,
        published: false,
        message: null,
        refinement_request_id: null,
        error: "Missing RETELL_API_KEY.",
        detail: null,
      });

    if (!REFINEMENT_SECRET)
      return res.status(500).json({
        ok: false,
        skipped: false,
        agent_id: null,
        llm_id: null,
        published: false,
        message: null,
        refinement_request_id: null,
        error: "Missing REFINEMENT_SECRET.",
        detail: null,
      });

    const rawSecret =
      req.headers["x-refinement-secret"] ?? req.headers["X-Refinement-Secret"];
    const secret = (Array.isArray(rawSecret) ? rawSecret[0] : rawSecret || "")
      .toString()
      .trim();

    const digest = value => createHash("sha256").update(value).digest();
    if (!secret || !REFINEMENT_SECRET.trim() ||
        !timingSafeEqual(digest(secret), digest(REFINEMENT_SECRET.trim()))) {
      return res.status(401).json({
        ok: false,
        skipped: false,
        agent_id: null,
        llm_id: null,
        published: false,
        message: null,
        refinement_request_id: null,
        error: "Unauthorized (bad secret).",
        detail: null,
      });
    }

    const body = await readJsonBody(req);
    await require("../lib/billing-cancellation").assertAllowed("agent_routes",body.agent_id||body.agentId,kv);
    if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "INVALID_REQUEST");

    // Dispatch before ANY legacy parsing or append code. Unknown explicit
    // operations cannot silently fall back to legacy, even when null/empty.
    if (Object.hasOwn(body, "operation")) {
      if (![OPERATION, PUBLISH_OPERATION, "replace_business_section_v2", "publish_business_section_v2", "apply_business_revision_v3", "inspect_greeting_v1"].includes(body.operation)) fail(400, "UNKNOWN_OPERATION");
      const pilot = enablePilot && pilotMatches(body);
      const grant = !enableSection && !pilot && ["apply_business_revision_v3","inspect_greeting_v1"].includes(body.operation)
        ? await require("../lib/business-enrollment").grantFor(kv, body) : null;
      if (!enableSection && !enablePilot && !grant) fail(503, "SECTION_REPLACEMENT_DISABLED");
      if (!enableSection && !pilot && !grant) fail(403, "PILOT_SCOPE_DENIED");
      const expectedLlm = grant ? grant.llm_id : enableSection ? undefined : PILOT.llmId;
      if (body.operation === "inspect_greeting_v1") return res.status(200).json(
        await require("../lib/greeting-inspection").inspectGreeting({
          body,kv,axios,base:RETELL_BASE,headers:retellHeaders(),expectedLlm
        }));
      if (body.operation === "apply_business_revision_v3") return res.status(200).json(await require("../lib/versioned-business").versionedBusiness({
        body, kv, axios, base: RETELL_BASE, headers: retellHeaders(), expectedLlm, findUpgradeHits,
        enrollmentBaseline: grant?.baseline_hash,
        authorize: grant ? async () => {
          const current = await require("../lib/business-enrollment").grantFor(kv, body);
          if (!current || current.request_id !== grant.request_id) fail(403, "ENROLLMENT_REVOKED");
        } : undefined,
      }));
      if ([PUBLISH_OPERATION, "publish_business_section_v2"].includes(body.operation)) return res.status(200).json(await publishBusiness({
        expectedLlm,
        body, kv, axios, base: RETELL_BASE, headers: retellHeaders(),
      }));
      return res.status(200).json(await replaceBusiness({
        expectedLlm,
        body, kv, axios, base: RETELL_BASE, headers: retellHeaders(), findUpgradeHits,
      }));
    }

    if (require("../lib/mcduffy-write-guard").protectedSetup(body))
      fail(423, "MCDUFFY_LEGACY_WRITES_PAUSED");

    refinement_request_id = decodeHtml(
      body.refinement_request_id || body.request_id || ""
    );

    agent_id = decodeHtml(body.agent_id || "");
    const categories = normalizeCategories(body.categories || body.category);
    const update_text = decodeHtml(body.update_text || "").trim();
    const communication_preference = decodeHtml(
      body.communication_preference || ""
    ).trim();
    const publish = body.publish === true; // optional
    publication_requested = publish;
    if ([refinement_request_id, update_text, communication_preference].some(value =>
      value.includes(BEGIN) || value.includes(END))) fail(400, "RESERVED_SECTION_MARKER");

    if (!agent_id)
      return res.status(400).json({
        ok: false,
        skipped: false,
        agent_id: null,
        llm_id: null,
        published: false,
        message: null,
        refinement_request_id: refinement_request_id || null,
        error: "Missing agent_id.",
        detail: null,
      });

    if (!categories.length)
      return res.status(400).json({
        ok: false,
        skipped: false,
        agent_id,
        llm_id: null,
        published: false,
        message: null,
        refinement_request_id: refinement_request_id || null,
        error: "Missing categories.",
        detail: null,
      });

    if (!update_text)
      return res.status(400).json({
        ok: false,
        skipped: false,
        agent_id,
        llm_id: null,
        published: false,
        message: null,
        refinement_request_id: refinement_request_id || null,
        error: "Missing update_text.",
        detail: null,
      });

    // category allowlist
    const badCats = categories.filter((c) => !ALLOWED_CATEGORIES.has(c));
    if (badCats.length) {
      return res.status(400).json({
        ok: false,
        skipped: false,
        agent_id,
        llm_id: null,
        published: false,
        message: null,
        refinement_request_id: refinement_request_id || null,
        error: "Unknown category.",
        detail: { bad_categories: badCats },
      });
    }

    // upgrade gating (keywords)
    const hits = findUpgradeHits(`${categories.join(" ")}\n${update_text}`);
    if (hits.length) {
      return res.status(402).json({
        ok: false,
        skipped: false,
        agent_id,
        llm_id: null,
        published: false,
        message: null,
        refinement_request_id: refinement_request_id || null,
        error: "Upgrade required.",
        detail: { upgrade_required: true, matched_keywords: hits },
      });
    }

    // A) get agent -> llm_id
    const agentResp = await axios.get(`${RETELL_BASE}/get-agent/${agent_id}`, {
      headers: retellHeaders(),
      timeout: 10000,
    });
    const agent = agentResp.data;

    const responseEngine = agent?.response_engine;
    llm_id =
      responseEngine?.type === "retell-llm" ? responseEngine?.llm_id : null;

    if (!llm_id) {
      return res.status(400).json({
        ok: false,
        skipped: false,
        agent_id,
        llm_id: null,
        published: false,
        message: null,
        refinement_request_id: refinement_request_id || null,
        error:
          "Agent is not using retell-llm response engine (cannot apply refinement via prompt patch).",
        detail: null,
      });
    }

    // Same per-LLM lease and unresolved-write journal as section replacement.
    return await withLlm({
      kv, llmId: llm_id,
      getPrompt: async () => (await axios.get(`${RETELL_BASE}/get-retell-llm/${llm_id}`,
        { headers: retellHeaders(), timeout: 10000 })).data?.general_prompt,
      patchPrompt: prompt => axios.patch(`${RETELL_BASE}/update-retell-llm/${llm_id}`,
        { general_prompt: prompt }, { headers: retellHeaders(), timeout: 10000 }),
    }, async ({ prompt: currentPrompt, apply, journal, assertLease, getPublication, storePublication }) => {
    const fingerprint = hash(JSON.stringify({ agent_id, refinement_request_id, categories, update_text, communication_preference, publish }));
    const publishDraft = async prompt => publishLegacy({
      axios, base: RETELL_BASE, headers: retellHeaders(), agentId: agent_id, llmId: llm_id,
      fingerprint, prompt, getPublication, storePublication, assertLease,
      verifyConfiguration: await legacyPublicationGuard({
        axios, base: RETELL_BASE, options: { headers: retellHeaders(), timeout: 10000 },
        agentId: agent_id, llmId: llm_id, targetPrompt: prompt,
        baseHash: journal?.receipt?.legacyFingerprint === fingerprint ? journal.baseHash : hash(currentPrompt),
      }),
    });

    // Idempotency guard: prevent duplicate application of same request
    if (
      (refinement_request_id && currentPrompt.includes(`Request ID: ${refinement_request_id}`)) ||
      (journal?.receipt?.legacyFingerprint === fingerprint && journal.targetHash === hash(currentPrompt))
    ) {
      draft_applied = true;
      if (publish) {
        // An old Request ID marker alone cannot prove which draft should be
        // published. Require durable evidence for this exact request.
        if (journal?.receipt?.legacyFingerprint !== fingerprint &&
            (await getPublication())?.fingerprint !== fingerprint) {
          fail(409, "PUBLICATION_DRAFT_UNVERIFIED");
        }
        published = await publishDraft(currentPrompt);
      }
      return res.status(200).json({
        ok: true,
        skipped: true,
        agent_id,
        llm_id,
        published,
        draft_applied,
        publication_status: published ? "confirmed" : "not_requested",
        message: published ? "Draft already applied; publication confirmed." : "Refinement already applied (draft).",
        refinement_request_id,
        error: null,
        detail: null,
      });
    }

    // C) append refinement patch (safe, additive)
    const patch =
      `\n\n---\n` +
      `REFINEMENT PATCH\n` +
      `Timestamp: ${nowIso()}\n` +
      (refinement_request_id ? `Request ID: ${refinement_request_id}\n` : "") +
      `Categories: ${categories.join(", ")}\n` +
      (communication_preference
        ? `Communication: ${communication_preference}\n`
        : "") +
      `\n` +
      `${update_text}\n`;

// Preserve existing instructions. Reject oversized updates.
const MAX_CHARS = 24000;
const nextPrompt = currentPrompt ? currentPrompt + patch : patch.trim();

if (nextPrompt.length > MAX_CHARS) {
  return res.status(413).json({
    ok: false,
    skipped: false,
    agent_id,
    llm_id,
    published: false,
    message: null,
    refinement_request_id: refinement_request_id || null,
    error: "Prompt limit exceeded. Existing instructions were not changed.",
    detail: {
      code: "PROMPT_LIMIT_EXCEEDED",
      max_chars: MAX_CHARS,
      current_chars: currentPrompt.length,
      proposed_chars: nextPrompt.length,
    },
  });
}

    // D) update llm
    await apply(nextPrompt, { legacyFingerprint: fingerprint });
    draft_applied = true;

    // E) publish (optional)
    if (publish) {
      published = await publishDraft(nextPrompt);
    }

    return res.status(200).json({
      ok: true,
      skipped: false,
      agent_id,
      llm_id,
      published,
      draft_applied,
      publication_status: published ? "confirmed" : "not_requested",
      message: publish
        ? "Refinement applied + published."
        : "Refinement applied (draft).",
      refinement_request_id: refinement_request_id || null,
      error: null,
      detail: null,
    });
    });
  } catch (err) {
    const status = err?.status || (err?.response?.status === 429 ? 429 : 502);
    return res.status(status).json({
      ok: false,
      skipped: false,
      agent_id: agent_id || null,
      llm_id: llm_id || null,
      published: published || false,
      draft_applied,
      publication_status: !publication_requested ? "not_requested" : draft_applied ? "not_confirmed" : "not_attempted",
      message: null,
      refinement_request_id: refinement_request_id || null,
      error: draft_applied && publication_requested ? "Draft applied; publication not confirmed." : "Refinement failed.",
      detail: { code: err?.code && err?.status ? err.code : "UPSTREAM_UNAVAILABLE" },
    });
  }
});
}

module.exports = (req, res) => createHandler({
  axios: require("axios"), kv: require("@vercel/kv").kv,
  apiKey: process.env.RETELL_API_KEY, secret: process.env.REFINEMENT_SECRET,
  enableSection: SECTION_REPLACEMENT_ENABLED,
  enablePilot: BUSINESS_SECTION_PILOT_ENABLED,
})(req, res);
module.exports.createHandler = createHandler;
