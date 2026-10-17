# Business section replacement — local implementation, NOT enabled

> The production review branch now also contains separate guarded publication,
> expanded optional call fields and maintenance controls. See
> `PRODUCTION_BUSINESS_RELEASE.md`. Replacement itself remains draft-only.

The existing `/api/refinement` route remains the only refinement endpoint.
The production handler's `SECTION_REPLACEMENT_ENABLED` is deliberately **false**.
The portal's separate feature flag has not been changed.

## Contract

Authenticate using the existing server-only `X-Refinement-Secret` header and
`REFINEMENT_SECRET`. No secret fragments, prompt bodies, raw upstream responses
or credentials are returned. `Cache-Control: no-store` applies to responses.

Explicit `operation` requests are dispatched before legacy parsing. Unknown
operations fail 400 without writes. The known operation currently returns 503
`SECTION_REPLACEMENT_DISABLED` in the default handler.

When enabled *only in injected mocks*, the exact body is:

```json
{
  "operation": "replace_business_section_v1",
  "client_id": "example-client",
  "agent_id": "agent_example",
  "section_id": "portal.business-information.v1",
  "revision": 1,
  "snapshot_hash": "<SHA256 of canonical snapshot JSON>",
  "idempotency_key": "business:example-client:agent_example:1:<snapshot_hash>",
  "business_information": {
    "clientName": "Example business",
    "businessPhone": null,
    "serviceArea": "Example town",
    "businessDescription": null,
    "pricingPolicies": null
  },
  "publish": false
}
```

All fields are required; unknown fields are rejected. Revision is a positive
safe integer. Snapshot JSON uses the field order shown above, without pretty
printing, for hashing. Values are strings or null (empty strings deliberately
clear information). The first three fields have 2,000-character limits; the
last two have 10,000-character limits. Client and agent identifiers are validated
before being interpolated into keys/paths. `publish:true` is rejected.

The existing authoritative KV key `agent:${agentId}:client` is read and compared
exactly to the external client ID. It is never created, repaired or changed.
The LLM comes from Retell's agent response. Paginated `/v2/list-agents` summaries
are followed through `has_more`/`pagination_key`. Every stored version is listed
through `/list-agent-versions/{agent_id}`, then resolved with version-specific
`/get-agent` (voice) or `/get-chat-agent` (chat) requests. No channel filter is
applied: a chat agent sharing the LLM is also a conflict. Unknown envelopes,
missing/repeated cursors, unknown channels or exhausted safety limits fail closed.
Safety limits are 100 pages per listing and 5,000 inspected versions per request.

Success receipts contain only `ok`, `operation`, `client_id`, `agent_id`, `llm_id`,
`section_id`, `revision`, `snapshot_hash`, `idempotency_key`, `state: "draft"`,
and `published: false`. Retries of the current revision verify the actual section,
not just cached success. Older revisions fail 409 even if previously successful.

## Prompt boundaries and preservation

```
<!-- BEGIN portal.business-information.v1 -->
...
<!-- END portal.business-information.v1 -->
```

The section deterministically contains revision/hash metadata and JSON-quoted
business data. `<` is escaped inside JSON strings to prevent injected markers.
Replacing an existing section preserves its prefix and suffix character-for-
character, including CRLF, whitespace, historical patches and Scheduler content.
The first insertion appends two newlines and the section without trimming the
old prompt. No older content is automatically removed.

One-sided, reversed or duplicate boundaries fail 409. A section without durable
ownership/revision state fails closed; it is not silently adopted. Manual drift
inside a tracked section also fails 409. The full proposed prompt exceeding
24,000 JavaScript characters fails 413 without truncation.

Existing legacy aliases, categories and keyword-based package restrictions are
retained. Those keyword restrictions also apply to section snapshot values.
Legacy requests cannot inject the reserved section markers. Legacy `publish`
behavior is retained, but no publication requests were used in development tests.
Legacy responses no longer include the raw `retell_update` payload.

## Shared coordination and durable recovery

Both legacy append and section replacement use:

- `refinement:v1:llm:${llmId}:lock` — 60-second token-owned lease.
- `refinement:v1:llm:${llmId}:journal` — durable intent/outcome, no TTL.
- `refinement:v1:llm:${llmId}:section` — durable managed-section revision/owner.

Redis Lua atomically checks lease ownership when renewing, releasing and writing
metadata. Expired owners cannot delete another owner's lock or commit metadata.
Before PATCH, the service re-reads the prompt and checks it is unchanged. It
persists uncertain intent **before** dispatch, including base/target prompt
hashes and intended section state, never prompt text. Completion requires a
subsequent read matching the entire intended prompt.

An expired lease does not make an unresolved journal safe to overwrite. Both
writers block until the actual prompt matches the intended target. If it does,
the retry completes the durable metadata and returns a verified receipt without
another PATCH. This handles a timeout after a successful remote write and a KV
completion outage.

If the actual prompt still matches the old base, or neither base nor target,
the result remains **unknown**, not “failed safely.” It could be a late in-flight
PATCH. Return 503 `UPDATE_OUTCOME_UNRESOLVED`; do not issue another blind update.
A crash between recording intent and dispatch may also require manual recovery.
Do not automatically expire/delete journals. Operator recovery requires proving
that no original writer/request remains in flight and reviewing current remote
state; an automated override is intentionally not implemented.

## Unmet release requirements — keep synchronization disabled

### Legacy publication retries

Draft completion and publication are separate durable states. The additional
per-LLM `:publication` record stores request fingerprint, intended prompt hash,
agent version and rejected/uncertain/confirmed status. A successful draft is
never appended again merely because publication failed.
Legacy responses additionally expose `draft_applied` and `publication_status`
(`not_requested`, `not_attempted`, `not_confirmed`, or `confirmed`). A publication
failure after the PATCH explicitly reports that the draft remains applied.
An old Request ID marker without durable evidence for the exact request is not
enough to authorize publication. A retry cannot publish a newer unrelated draft.

Explicit 4xx rejection (except 408) permits publication retry. Timeouts, 408,
5xx, crashes and unverified POST success remain uncertain. Retry reads the
specific recorded agent version and follows its numeric `response_engine.version`
to `/get-retell-llm/{llm_id}?version=...`. Both objects must be published and match
the requested IDs/versions; the exact LLM prompt hash must match the recorded
target. A null linked LLM version fails closed, never falling back to latest.
A POST success alone is not confirmation. Unknown outcomes
block both writers from changing the draft and are never blindly re-published.
This can require investigation if the remote outcome cannot be established.

The version-specific GET semantics and association between the draft prompt and
published agent version still require live API verification before release.
Uncoordinated external edits remain a release blocker, including between draft
verification and publication. Section replacement remains draft-only.

1. **There is no Retell-side CAS/fencing protection.** The lease coordinates only
   these two request paths. Manual Retell edits, provisioning and other prompt
   writers do not honor it. Re-reading before PATCH reduces but does not eliminate
   the race. This implementation does NOT claim exact preservation under those
   concurrent out-of-band changes. Require a verified upstream conditional-write
   capability or an operationally enforced single-writer model before enabling.
2. Paginated listing and version-specific prompt retrieval are implemented from
   official documentation, but still need a controlled account-level test.
   Ownership can also change out of band; this check is not a Retell transaction.
3. Unresolved PATCH outcomes deliberately need investigation when no confirmed
   target can be observed. There is no invented safe timeout after which an
   in-flight remote request is assumed dead.
4. Runtime Vercel KV/Lua compatibility, deployment settings and Retell behavior
   have only been modeled locally. No live integration validation was performed.
5. This operation updates drafts only. Publication and trusted active-version
   verification remain separate, unimplemented integrations.

## Tests and handoff

Run `npm ci --ignore-scripts`, then `npm run test:refinement`. Uses Node's built-in
test runner and the existing declared KV dependency; no new runtime dependency.
The previously incomplete lockfile is now synchronized with the manifest.
Retell and KV are injected in-memory fakes. A preload
blocks real HTTP, HTTPS, TCP, TLS, DNS lookup and fetch. No real credentials are
read by the tests. Each fixture has fresh state.

Changed files:
- `api/refinement.js`
- `lib/refinement-section.js`
- `lib/refinement-business.js`
- `lib/refinement-coordinator.js`
- `lib/refinement-publication.js`
- `lib/retell-ownership.js`
- `test/network-block.cjs`
- `test/refinement.test.js`
- `package.json`
- `package-lock.json`
- `.gitignore`
- `BUSINESS_SECTION_REPLACEMENT.md`

No deployment, agent publication, mapping changes or portal flag changes are
part of this work. No GitHub push is required for the local branch/patch.
