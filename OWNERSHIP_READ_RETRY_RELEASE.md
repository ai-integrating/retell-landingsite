# Caller and lease budget correction

All ownership-scanning HTTP handlers establish a shared monotonic request
budget at entry. The portal sends X-Request-Deadline-Ms from the same timeout
used for its fetch (initialization 65s, enrollment/update 60s, adoption 90s).
The header can only shorten the server's 60s ceiling; invalid/expired headers
fail closed at the scan. A missing header uses the conservative 60s ceiling.
Two seconds are deducted for transport/response margin and twenty seconds
are reserved for subsequent verification, writes, and journal/response work.
The reserve is a minimum opportunity, not a guarantee of provider completion.
Existing uncertain-outcome journals and read-back recovery remain authoritative.

Each scan uses the earliest of its 120s ceiling, remaining request budget,
and remaining lease budget, less the reserve. Time already spent in reads,
pagination, KV and prior scans counts. The coordinator records lease expiry
from the start of each successful acquisition/renewal (not its response time).
No lease renewal is added to retry handling, and renewal cannot extend the
request deadline or an already-started scan. Context is isolated per async
request, not global state. Incomplete scans never authorize a write.

## Deployed duration evidence (read-only)

Vercel production deployment dpl_5B3ED2nBiNjSKHB6545nTVyujGvF, commit
d7b066f921c1dbce7ba9c0061583ab04e53a3573, is READY. Its deployment functions
configuration specifies 60s for refinement, refinement-maintenance and
provision only. There is NO explicit onboarding-business duration override.
Project resource configuration reports Fluid Compute enabled; the official
duration documentation lists the Pro Fluid default as 300s:
https://vercel.com/docs/functions/configuring-functions/duration
The deployment API does not expose a resolved numeric duration for this
individual function, so 300s is the documented inherited default, not an
independently measured timeout. No deployment settings were changed.

This candidate makes onboarding-business, business-enrollment and
mcduffy-adoption explicitly 60s in vercel.json, matching the conservative
handler budget. Existing refinement overrides remain 60s.

## Release scope

Backend plus portal server transport-header changes; no database migration,
new credentials, gate changes or customer writes. Deploy backend first only
after review and separately approved synthetic testing; portal header changes
are backward-compatible. Roll back code only; preserve all journals and
provisioning evidence. Do not erase an uncertain outcome or blindly retry writes.

# Bounded ownership-read rate-limit recovery

Incremental correction on durable-provenance candidate 22964c6.
Original retry correction plus the caller/lease integration described above.
No schema, environment-variable or gate changes.

## Exact limits
- An outer 120-second maximum per complete verifyOwnership scan, shortened by
  the caller and lease budgets above, covering
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
198 backend checks passed with external network access blocked.
Two portal transport tests passed; portal API TypeScript checking passed.
Integration coverage includes portal remaining time after baseline reads,
handler ceiling, malformed/expired caller deadlines, scans under a real
coordinator lease, interruption and journal recovery, and lease renewal that
cannot extend a caller deadline. External provider operations are mocked.
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
