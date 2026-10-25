const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { hash, fail, MAX_CHARS } = require("./refinement-section");

// Redis lease operations are token-checked atomically. No GET-then-DEL races.
const RENEW = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("pexpire",KEYS[1],ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;
const GUARDED_SET = `if redis.call("get",KEYS[1]) == ARGV[1] then redis.call("set",KEYS[2],ARGV[2]); return 1 else return 0 end`;
const LEASE_MS = 60000;

// A lease is NOT a Retell-side fence/CAS. A durable unresolved journal blocks
// later writers after lease expiry; an uncertain PATCH is never blindly replayed.
// Manual Retell edits remain uncoordinated: section integration must stay off.
async function withLlm({ kv, llmId, getPrompt, patchPrompt, versionLifecycle = false, bootstrapLifecycle = false, expectedConfigurationHash }, work) {
  require("./mcduffy-write-guard").guardLegacyLlm(llmId, versionLifecycle);
  const root = `refinement:v1:llm:${llmId}`;
  const bootstrap = await kv.get(`${root}:bootstrap`);
  if (bootstrap && bootstrap.status !== "active" && !bootstrapLifecycle) fail(423, "INITIALIZATION_UNRESOLVED");
  const lock = `${root}:lock`, journalKey = `${root}:journal`, stateKey = `${root}:section`;
  const token = randomUUID();
  if (await kv.get(`${root}:maintenance`)) fail(423, "AGENT_MAINTENANCE");
  if (await kv.set(lock, token, { nx: true, px: LEASE_MS }) !== "OK") fail(409, "LLM_BUSY");
  const renew = async () => {
    if (await kv.eval(RENEW, [lock], [token, LEASE_MS]) !== 1) fail(409, "LLM_LEASE_LOST");
  };
  const store = async (key, value) => {
    if (await kv.eval(GUARDED_SET, [lock, key], [token, JSON.stringify(value)]) !== 1) fail(409, "LLM_LEASE_LOST");
  };
  try {
    // Check again under the lease: a bootstrap could start after the early read.
    const lockedBootstrap = await kv.get(`${root}:bootstrap`);
    if (lockedBootstrap && lockedBootstrap.status !== "active" && !bootstrapLifecycle) fail(423, "INITIALIZATION_UNRESOLVED");
    const versioned = await kv.get(`${root}:versions`);
    const enrolled = await kv.get(`${root}:enrolled`);
    if ((versioned || enrolled) && !versionLifecycle) fail(409, "VERSIONED_AGENT_REQUIRES_PORTAL");
    if (await kv.get(`${root}:maintenance`)) fail(423, "AGENT_MAINTENANCE");
    const configuration = await kv.get(`${root}:configuration`);
    if (configuration && configuration.status !== "confirmed" &&
        !(configuration.status === "uncertain" && expectedConfigurationHash &&
          configuration.targetHash === expectedConfigurationHash)) fail(503, "CONFIGURATION_OUTCOME_UNRESOLVED");
    let journal = await kv.get(journalKey);
    let prompt = await getPrompt();
    if (typeof prompt !== "string") fail(502, "INVALID_UPSTREAM_PROMPT");
    // Recovery is based on the complete intended prompt, never just HTTP status
    // or a cached receipt. No prompt content/credentials are persisted in KV.
    if (journal?.status === "uncertain") {
      if (hash(prompt) !== journal.targetHash) fail(503, "UPDATE_OUTCOME_UNRESOLVED");
      if (journal.sectionState) await store(stateKey, journal.sectionState);
      journal = { ...journal, status: "confirmed" };
      await store(journalKey, journal);
    } else if (journal && journal.status !== "confirmed") {
      fail(503, "INVALID_UPDATE_JOURNAL");
    }
    await renew();
    return await work({
      loadVersions: () => kv.get(`${root}:versions`),
      storeEnrollment: async (key, value) => {
        const previous = await kv.get(key);
        const keys = [lock, key, `${root}:enrolled`, `${key}:requests:${value.request_id}`,
          `${key}:history:${hash(JSON.stringify(previous))}`];
        const script = `if redis.call("get",KEYS[1]) ~= ARGV[1] then return 0 end
          local previous = redis.call("get",KEYS[2])
          if previous then
            local generation = cjson.decode(previous).generation
            if type(generation) ~= "number" or generation >= tonumber(ARGV[5]) then return -1 end
          end
          redis.call("set",KEYS[2],ARGV[2]); redis.call("set",KEYS[3],ARGV[3]);
          redis.call("set",KEYS[4],ARGV[2]); redis.call("set",KEYS[5],ARGV[4]); return 1`;
        const result = await kv.eval(script, keys, [token, JSON.stringify(value), JSON.stringify(value.enabled),
          JSON.stringify(previous), value.generation]);
        if (result !== 1) fail(409, result === -1 ? "ENROLLMENT_SUPERSEDED" : "LLM_LEASE_LOST");
      },
      registerVersionedAgent: agentId => store(`agent:${agentId}:versioned-llm`, llmId),
      storeVersions: value => store(`${root}:versions`, value),
      loadBootstrap: () => kv.get(`${root}:bootstrap`),
      storeBootstrap: value => store(`${root}:bootstrap`, value),
      storeBootstrapProof: (key, value) => store(key, value),
      registerInitializingAgent: agentId => store(`agent:${agentId}:initialization-llm`, llmId),
      archiveVersions: async value => {
        const key = `${root}:versions-history:${hash(JSON.stringify(value))}`;
        const prior = await kv.get(key);
        if (prior && !isDeepStrictEqual(prior, value)) fail(409, "JOURNAL_HISTORY_CONFLICT");
        if (!prior) await store(key, value);
      },
      prompt,
      state: await kv.get(stateKey),
      journal,
      assertLease: renew,
      getPublication: () => kv.get(`${root}:publication`),
      storePublication: value => store(`${root}:publication`, value),
      async applyConfiguration({ read, patch, expected }) {
        if ((await kv.get(`${root}:publication`))?.status === "uncertain") fail(503, "PUBLICATION_OUTCOME_UNRESOLVED");
        const current = await read();
        if (isDeepStrictEqual(current, expected)) {
          if (configuration?.status === "uncertain") await store(`${root}:configuration`,
            {status:"confirmed",targetHash:hash(JSON.stringify(expected))});
          return;
        }
        await renew();
        await store(`${root}:configuration`, { status: "uncertain", targetHash: hash(JSON.stringify(expected)) });
        await patch();
        if (!isDeepStrictEqual(await read(), expected)) fail(503, "CONFIGURATION_OUTCOME_UNRESOLVED");
        await store(`${root}:configuration`, { status: "confirmed", targetHash: hash(JSON.stringify(expected)) });
      },
      async apply(nextPrompt, result, sectionState = null) {
        // Retain the exact prior confirmed journal before any later operation.
        // Content-addressed history is immutable and contains no prompt text.
        if (journal?.status === "confirmed") {
          const archiveKey = `${root}:journal-history:${hash(JSON.stringify(journal))}`;
          const archived = await kv.get(archiveKey);
          if (archived && !isDeepStrictEqual(archived, journal)) fail(409, "JOURNAL_HISTORY_CONFLICT");
          if (!archived) await store(archiveKey, journal);
        }
        if ((await kv.get(`${root}:publication`))?.status === "uncertain") fail(503, "PUBLICATION_OUTCOME_UNRESOLVED");
        if (nextPrompt.length > MAX_CHARS) fail(413, "PROMPT_LIMIT_EXCEEDED");
        // Detect changes since planning; still not atomic with the remote PATCH.
        const latest = await getPrompt();
        if (latest !== prompt) fail(409, "PROMPT_CHANGED");
        await renew();
        const pending = { status: "uncertain", baseHash: hash(prompt), targetHash: hash(nextPrompt), receipt: result, sectionState };
        // Persist BEFORE dispatch, no TTL. A crash in this narrow window is
        // conservatively unresolved, not permission for another blind PATCH.
        await store(journalKey, pending);
        await patchPrompt(nextPrompt);
        const verified = await getPrompt();
        if (verified !== nextPrompt) fail(503, "UPDATE_OUTCOME_UNRESOLVED");
        if (sectionState) await store(stateKey, sectionState);
        await store(journalKey, { ...pending, status: "confirmed" });
        return result;
      },
    });
  } finally {
    // Expired owners cannot release a replacement owner's lease.
    await kv.eval(RELEASE, [lock], [token]).catch(() => {});
  }
}
module.exports = { withLlm, RENEW, RELEASE, GUARDED_SET };
