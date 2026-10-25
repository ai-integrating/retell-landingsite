# Mcduffy legacy-write guard — not deployed

## Finding

Production audited at ea52381d9bd926b30305e78f29eb0bc5a2402d82.
The per-LLM lease serializes participating writers but is not a persistent pause.
Legacy requests are rejected once a version journal/enrollment marker exists.
Before that, including the gap after baseline routing is pinned, a late legacy
refinement or resumed provisioning job can run between adoption requests.
An uncertain configuration blocks some retries, but a confirmed baseline
configuration is not a legacy-write fence.

Agent Creator history is limited to 60 days and no target runs were found in
that window. Enqueue/provision records expire after 30 days; no matching retained
records or locks were found. Neither observation proves the absence of older
held jobs, test jobs or future retries. The operator has committed to no test
submissions, setup replays or manual configuration edits during adoption.

## Small target-only correction

- Shared coordinator rejects the reviewed Mcduffy LLM for legacy callers with
  HTTP 423 / MCDUFFY_LEGACY_WRITES_PAUSED before any KV access or upstream write.
  This is independent of journal state, leases, enrollment or automatic gates.
- Legacy /api/refinement also rejects explicit Mcduffy identity before reading
  Retell. The resolved-LLM guard catches aliases that resolve to the same LLM.
- /api/provision rejects unfinished target jobs from request identifiers or the
  persisted provisioning record, before acquiring its lock; it rechecks after
  the record is reread. Completed cached receipts still return without writes.
  A different test submission ID does not bypass an existing target identity.
- /api/buy-number rejects target number setup before purchasing or rebinding,
  covering later setup-Zap steps outside the provision handler.
- The approved baseline/adoption and version-specific lifecycle continue using
  the existing server-selected versionLifecycle capability. Request JSON cannot
  set that capability for a legacy operation. All reviewed identity, hash,
  ownership, lease, receipt and retained-draft checks stay in place.
- No booking, call creation, logging, calendar, secret, dependency, portal,
  database schema, enrollment, snapshot, routing or feature-flag changes.
  Other-client template references do not count as target identity.

The guard remains in force after adoption; reopening legacy writes requires a
deliberate reviewed code change, not a timer or request flag.

## Verification

Run with the existing approved dependencies:

    NODE_PATH=<dependency-directory>/node_modules node --require ./test/network-block.cjs --test test/*.test.js

Expected: 158 tests, including 13 new guard checks and the existing complete
adoption, publication, routing recovery, retained-draft, enrollment and
subsequent-update tests. External HTTP/TCP/DNS/fetch are blocked.

New checks cover rejection before any KV/Retell I/O regardless of adoption phase,
unchanged unrelated LLM behavior, the trusted version-specific capability,
actual legacy handler/body bypass attempts, identity aliases, resumed and
concurrently reread provisioning records, read-only completed receipts, and
number-setup rejection.

## Deployment and subsequent approval

Backend-only release; no portal republish or migration is needed. Preserve newer
main changes when preparing its PR. Do not deploy as part of this preparation.

After separately approved deployment:
1. Verify the production alias serves the guard commit, and all setup/refinement
   callers use that alias, not an old immutable Vercel deployment URL.
2. Verify the guard before adoption. Use the existing authenticated validation
   procedure; do not replay a real queued provisioning job.
3. Ensure requests started on the previous deployment have finished. A new guard
   cannot retroactively cancel an already-running old request or Retell write.
   Recheck coordination state, logs and exact Retell/phone hashes afterward.
4. Keep the operator-managed pause. This is not a Retell-side fence against direct
   API/manual writes, calendar setup, or unmodified older deployments.
5. Repeat the read-only adoption preflight. Only then request approval for
   baseline -> draft -> publication/routing. Do not enroll Mcduffy automatically.

Keep Let’s Go's pilot, Len's hold and both disabled all-customer gates unchanged.
Rollback before adoption: revert this guard release only after target writers
are otherwise paused; rollback removes the new barrier. Never delete journals,
receipts or retained versions to roll back.
