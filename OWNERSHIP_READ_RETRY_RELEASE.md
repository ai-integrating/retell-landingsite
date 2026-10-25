# Bounded ownership-read rate-limit recovery

Incremental correction on durable-provenance candidate 22964c6.
Backend only; no schema, portal, environment-variable or gate changes.

## Exact limits
- One 120-second overall deadline per complete verifyOwnership scan, covering
  list pages and all exact-version reads. Standalone pages() gets one deadline
  across its own pages.
- At most 3 retries after the first attempt per request.
- At most 20 retries across the scan.
- Exponential backoff starting at 500ms, capped at 8 seconds, with equal jitter
  in the range 50–100% of that request's backoff.
- Retry-After supports seconds and HTTP-date values. Wait at least its stated
  duration, even when longer than the exponential cap. If it cannot fit within
  the remaining deadline, fail immediately rather than retry early.
- Per-request transport timeout is bounded by remaining scan time. An independent
  deadline timer aborts an in-flight request, even if its transport hangs.

Retries apply only to HTTP 429 on:
GET list-agent-versions, get-agent, get-chat-agent, and POST v2/list-agents (a
read-only listing API). Other errors propagate without retry.
No creation, PATCH, publication or routing write retry was added.

## Completeness and safety
The same cursor and explicit version are retained on retry. A failed page is
never appended. Existing 100-page, cursor-repeat, agent-duplicate and 5,000-version
limits remain; duplicate version entries now also fail closed.
No cache, ownership shortcut, stale-result authorization, or partial success.
Exhaustion returns OWNERSHIP_RATE_LIMIT_EXHAUSTED or OWNERSHIP_SCAN_DEADLINE.

The scan deadline is not permission to extend a held writer lease. Existing lease
checks and platform function timeouts remain authoritative; expiry still blocks
writes. Review runtime duration limits before deployment.

## Tests
192 backend checks passed with external network access blocked.
New coverage: Retry-After seconds/date, jitter/backoff, recovered listing and
version reads, repeated 429 exhaustion, shared retry budget, overall deadline,
hung-request abort, page cursor preservation, repeated-cursor rejection,
duplicate versions, and no retries for non-429 errors or write endpoints.

Dependencies reused from existing installed modules; not a fresh clean install.
Command: NODE_PATH=/home/runner/workspace/.local/business-precedence-secure/node_modules
node --require ./test/network-block.cjs --test test/*.test.js

## Review / deployment / rollback
No deployment or live test was performed. Initialization and all-customer gates
remain unchanged and disabled. Preserve existing customer pilots/enrollments.
Review the incremental patch, preserve newer main changes, then separately
authorize a synthetic test before deployment. A custom test transport must retain
HTTP status and Retry-After headers on errors so it exercises real retry semantics.
Do not reduce ownership coverage to make the test pass.
Rollback is code-only: disable initialization, retain all proof/journal/enrollment
records, and revert this correction if needed. No data/schema rollback or
customer re-provisioning is required.
