# Backend review candidate

Companion portal review/runbook:
`artifacts/api-server/BUSINESS_PRODUCTION_RELEASE.md` in the portal repository.

This branch contains the actual Vercel function entry points:
- `api/refinement.js`: legacy append plus explicit draft replacement and publication.
- `api/refinement-maintenance.js`: operator-only pause/resume.
- `api/provision.js`: existing tools/configuration writes now use the shared LLM lock.

`SECTION_REPLACEMENT_ENABLED` remains false. No deployment was performed.
`BUSINESS_SECTION_PILOT_ENABLED` also remains false. A later approved pilot can
enable only that switch while leaving the global gate disabled. Both explicit
business operations then enforce the exact approved client/agent pair and pinned
LLM, in addition to existing KV ownership, maintenance and publication guards.
The pilot gate does not grant access to legacy writers or change their permissions.
No package was added or replaced.

Pilot amendment validation: 59 backend mocked checks pass when adding
`test/business-rollout.test.js` to the test command below. No pilot or global
switch was enabled. Portal schema changes must use Replit managed Publish review
after a verified production recovery point; no direct production DDL.

Draft replacement keeps `publish:false`. The separate
`publish_business_section_v1` operation requires the same complete snapshot,
revision/hash/idempotency identity, `publish:true`, and `phone_number` resolved
server-side from the portal's trusted client record. It requires a matching
durable draft record. It refuses manual configuration/prompt changes, old phone
version pins, inbound webhook overrides and ambiguous routing. Published version
and phone routing are verified before returning `activation_verified:true`.

Legacy publication uses the same full-configuration guard and refuses unverified
initial publication. A new agent with no published baseline requires explicit
human review and initial publication outside this automatic path.

## Maintenance

Operator requests use `X-Maintenance-Secret` and the separate server-only
`REFINEMENT_MAINTENANCE_SECRET`. Body fields are exactly:
`action` (`pause`/`resume`), `client_id`, `agent_id`, `maintenance_id`.
Use a random 16–120-character alphanumeric/underscore/hyphen ID and retain it.

Pause must succeed before manual Retell edits. In-flight writes return 409.
The marker does not expire automatically. Resume needs the same ID and refuses
unresolved journals. This is practical coordination, not a Retell-side CAS lock.
Do not bypass it through a second uncoordinated writer.

## Tests

```
node --require ./test/network-block.cjs --test \
  test/refinement.test.js test/maintenance.test.js \
  test/maintenance-auth.test.js test/business-publication.test.js
node --check api/provision.js
```

50 mocked tests passed. No real Retell/KV writes or publication occurred.
Existing package restrictions and secret sanitization remain in place.

## Rollback

Disable the portal first, pause target writers, and reconcile uncertain journals.
Do not restore an uncoordinated legacy writer while a portal writer is enabled.
Retain all KV journal/section/publication/maintenance state. No mapping deletion,
prompt reset, mass publication or credential change belongs in code rollback.
