# Durable initialization provenance correction

## Scope
Backend only. No portal changes, SQL migration, new environment variables, deployment,
customer writes, or gate activation. Both initialization gates remain disabled.

The real provider read-back omitted agent metadata. The initializer now ignores
Retell metadata and uses two durable server-owned KV records:

* `onboarding:provisioned:v1:<agent>`: immutable submission, agent, LLM, and original
  bootstrap snapshot captured only for a genuinely new provisioning job.
* `onboarding:identity:v1:<agent>`: the same proof plus exact client ID, bound by
  the existing authenticated client-mapping action and checked atomically against
  the current agent-to-client mapping.

No business-name matching, caller-provided initialization submission override,
automatic backfill, or old-customer eligibility is introduced. Mapping a legacy
agent still works but creates no initialization evidence.

## Lifecycle and recovery
Completion persists the immutable proof without a TTL. Completed-job retries
can finish a missed proof write only if the original new-job bootstrap marker
already exists. They never manufacture that marker.
If retaining evidence fails, a completed provisioning record stays completed;
its retry must not re-enter provisioning/phone creation.

The authenticated mapping step requires its existing submission_id to match
the proof exactly. Missing/mismatched submission or conflicting binding fails.
Callers must supply that field; do not derive it from names.
An interrupted binding can retry the same exact identity.

Initialization requires both records and the current mapping, checks exact
client/agent/LLM identity, and repeats evidence verification under its lease.
Expiration of the old 30-day prov record does not remove completed durable proof.
If that legacy record expires before durable proof was retained, initialization
remains blocked; do not rerun provisioning to manufacture eligibility.

## Verification
181 backend tests passed with network access blocked.
Includes metadata-omitting provider fixture, expiration before preparation,
post-expiration receipt recovery, legacy ineligibility, binding retries,
conflicting client/submission/LLM evidence, evidence drift after lost response,
and the existing publication/routing retry and preservation regressions.

Command:
`NODE_PATH=/home/runner/workspace/.local/business-precedence-secure/node_modules node --require ./test/network-block.cjs --test test/*.test.js`

Existing installed dependencies were reused; this is not a new clean-install
verification. The initial run lacked dependencies, and a subsequent test run
identified an old test loader that allowed only @vercel/kv. That loader now also
loads the real evidence helper. Final run: 181 passed, zero failed.

## Review and rollout
1. Review this incremental patch against ec60c98 and preserve newer main changes.
2. Verify published mapping workflow supplies the exact submission_id.
3. Review and rerun the isolated synthetic integration harness against this
   candidate, seeding proof through retain/bind rather than Retell metadata.
   Keep routing simulated; no portal receipt reconciliation.
4. Only after review, deploy the backend correction with initialization disabled.
   No portal republish or schema change is required for this backend correction.
5. Activation remains a separate decision after the real-provider test passes.

## Rollback
Keep initialization disabled. Preserve all provisioning/evidence/journal records.
Do not delete evidence, rerun setup, re-purchase numbers, or lower enrollment
generations. Existing initialized agents retain their independent writer guards.
Rolling back code does not require data/schema rollback, but the older initializer
will again fail on missing Retell metadata and must not be enabled.
