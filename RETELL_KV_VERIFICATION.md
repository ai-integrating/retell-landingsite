# Documentation/source verification and isolated Let’s Go test plan

## Verified from official documentation, not from a live account

Sources retrieved 2026-10-16:
- https://docs.retellai.com/api-references/list-agents
- https://docs.retellai.com/api-references/list-agent-versions
- https://docs.retellai.com/api-references/get-agent
- https://docs.retellai.com/api-references/get-chat-agent
- https://docs.retellai.com/api-references/get-retell-llm

1. **Corrected after live preflight:** `POST /v2/list-agents` returns
   `items`, `has_more`, `pagination_key`. The earlier GET method was incorrect.
   Official SDK listing methods use POST with an empty JSON body for an
   unfiltered scan and pagination in query parameters. There is no legacy GET
   fallback: legacy arrays do not establish completeness.
   Default limit 50, maximum 1000. Items are unique-agent summaries with channel
   and tags, NOT full `response_engine` objects. The previous array assumption
   was incorrect. List every page without filtering to voice only. Inspect every
   stored version from paginated `/list-agent-versions/{agent_id}`. Resolve voice
   and chat details using their respective version-specific endpoints.
2. `GET /get-agent/{agent_id}?version=<numeric version>` retrieves that version.
   Its `response_engine.llm_id` AND `response_engine.version` identify the linked
   LLM revision. Call `GET /get-retell-llm/{llm_id}?version=<linked LLM version>`.
   The agent version number and LLM version number are not interchangeable.
   Confirmation checks both IDs, versions and published flags, plus the exact
   stored prompt hash. Null linked versions or missing metadata are unverified.
3. Official examples include LLM IDs without an `llm_` prefix. The prior prefix
   restriction was removed while retaining safe path-character validation.

Listing has no documented atomic snapshot guarantee. Concurrent creation,
deletion, reassignment or manual edits can invalidate an ownership scan.
The corrected scan is conservative, not proof against concurrent external writers.

## Installed client/source verification (no Redis connection)

The backend initially had no node_modules and its old lockfile omitted declared
KV and other dependencies. Installed the manifest locally, without lifecycle
scripts, and regenerated the lockfile. No dependency was migrated or replaced.

Verified versions: `@vercel/kv` 1.0.1, `@upstash/redis` 1.25.1.
Vercel's installed `dist/index.cjs` extends Upstash Redis. The SDK custom Requester
allows command serialization tests with no URLs, tokens, or real transport.

Mocked installed-client checks confirm:
- `set(key, token, {nx:true, px:60000})` encodes
  `["set", key, token, "nx", "px", 60000]`; the token remains an unquoted string.
- `eval(script, keys, args)` encodes
  `["eval", script, keys.length, ...keys, ...args]`.
- All three implemented Lua scripts use that supported signature.
- Integer Lua results remain numeric; GET automatically deserializes stored JSON.

This verifies SDK encoding/deserialization, NOT actual server execution of Lua,
expiry, concurrency, permissions, or crash recovery. Vercel KV is deprecated by
its publisher; this work keeps the existing client and does not migrate services.

## Remaining controlled test steps — Let’s Go only

Both flags remain false. Do not start any step below without explicit approval.

1. **Read-only preflight:** verify exact mapping
   `agent:agent_67e9dc0ab56576c4b9d3264eaa:client` equals
   `lets-go-6659962517436476386`. Do not repair or rewrite it. Verify the portal's
   trusted client record resolves to the approved agent. The user intentionally
   shares the receptionist and Scheduler agent for this test; preserve both
   mappings. Perform complete paginated agent/version reads and reject shared LLMs.
2. Read and record exact draft agent/LLM IDs and versions, full prompt, hashes,
   managed-section boundaries and Scheduler prefix/suffix for recovery/comparison.
   Keep snapshots private; do not put prompts or credentials in reports.
3. Resolve the concurrent-writer blocker: obtain tested conditional-write
   protection, or an enforceable maintenance window that excludes manual edits,
   provisioning and every other prompt/publish writer. A shared Redis lease alone
   is insufficient. If that exclusion cannot be ensured, STOP.
4. Authorize a separately gated, exact client+agent+LLM allowlisted test harness,
   not global flag activation. The current code has no live bypass; this harness
   still needs implementation/review. Keep both production synchronization flags
   disabled. First use a dedicated development KV namespace and fake Retell transport
   to verify real Lua token checks, expiry and durable journal recovery. Never use
   the mapping keys for these writes. This step is a future authorized write test.
5. After approval, test ONE Let’s Go **draft-only** snapshot with `publish:false`.
   No publish-agent calls. Compare exact prompt prefix/suffix and Scheduler data,
   validate only the dedicated section changed, and confirm the published version
   is unchanged with read-only version-specific agent/LLM requests.
6. Replay the same revision/key; verify no extra PATCH or duplicate section.
   Test a newer approved snapshot with intentional clearing, then a stale revision
   and same-revision conflicting hash. Failures must not change the remote draft.
7. Keep timeout/ambiguous-publication tests mocked. Do not deliberately send
   uncertain live writes or publish a customer agent. If a real request becomes
   uncertain, stop and reconcile; never clear the journal to force a retry.
8. Record exact revision/hash receipts, redacted results and any cleanup agreed
   in advance. Do not restore the whole prompt automatically. Leave publishing,
   activation and rollout to other clients outside this test's authorization.

Still unverified live: list consistency/completeness for this account, real
version/LLM linkage, Lua permissions and atomicity, latency/scan bounds, and
coordination with non-refinement writers. These are release blockers, not passed tests.
