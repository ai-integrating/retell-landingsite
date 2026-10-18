# Recovered controlled draft preparation

Recovered tree: complete patch for 0df6a27 applied to original base 9da8905.
The original local commit object was not in GitHub. POST listing correction and
offline preparation harness were reconstructed from the prior reviewed work.
Both global synchronization flags remain disabled.

Offline proposal: tools/lets-go-prepare.cjs accepts recovery JSON, contract JSON,
and a NEW output directory. No live transport exists in this tool.
Prepared SQL: tools/client-27-mapping.sql; NOT executed. Development only.

Run mocked tests:
node --require ./test/network-block.cjs --test test/refinement.test.js test/lets-go-prepare.test.cjs

Run isolated Redis tests:
node tools/redis-coordination-test.cjs

Redis environment: dedicated local Redis 7.2.10 process, TCP disabled, owner-only
Unix socket in a random temporary directory. Namespace printed before startup:
lets-go-draft-test:<random UUID>:. No production URLs or credentials accepted.
Actual coordinator and Lua scripts are exercised with mocked Retell. This does
not verify Upstash REST permissions/latency or deployed execution behavior.

Before a real draft update:
- Enforce a target-specific maintenance window for manual Retell prompt/tool edits,
  publication, provisioning, legacy refinement and queued automated retries.
- Verify no in-flight target updates; suspend all target-specific workers/writers
  at their source or ingress. Obtain operator confirmation of access exclusion.
  These controls are NOT yet enforced by this repository.
- Preserve ordinary booking, both role mappings, calendar settings and tools.
- Recheck full ownership and all prompt/configuration hashes immediately before
  mutation. Redis locking is not Retell CAS and cannot fence outside writers.
- Review existing durable section/revision journal through an approved read path.
- Obtain explicit approval for the pending development mapping update and for
  the separately gated live draft-only write. Never enable global synchronization.

Historical dependency recovery caveat (resolved in this candidate; see
DEPENDENCY_SECURITY_REVIEW.md): full npm ci was blocked by the package firewall on
proxy-addr 2.0.7. Do not bypass the firewall. Mock tests can use an isolated install
of @vercel/kv 1.0.1 via NODE_PATH; this does not validate the full backend install.
