# Clean-install security fix

## Root cause and supported fix

The approved lockfile resolved Express's transitive proxy-addr to 2.0.7.
The configured Replit package firewall rejected that tarball with HTTP 403,
reason "Critical CVE". The upstream advisory is CVE-2026-90711 /
GHSA-jqcg-44mw-7w3h:
https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h

An incorrectly short IPv4-mapped IPv6 trust prefix could trust arbitrary IPv4
clients and accept their spoofed X-Forwarded-For headers. This explains the
package-policy rejection; it is not evidence that this application was exploited.

Update the existing direct dependency Express to 5.3.0, within major version 5.
It requires proxy-addr ^2.0.8; the lock resolves patched 2.0.8. Also refresh
path-to-regexp within router's existing compatible range to 8.4.2, resolving
GHSA-j3q9-mxjg-w52f and GHSA-27v5-c462-wpq7. No overrides, registry bypass,
security-policy exceptions, or auth/trust-proxy setting changes were made.

The lock keeps integrity hashes but omits registry-resolved URLs using npm's
supported --omit-lockfile-registry-resolved option. This avoids embedding a
Replit-only internal registry address in a Vercel release. Installs use their
environment's configured registry. A subsequent ordinary npm ci --ignore-scripts
passed through the unchanged Replit firewall.

## Verification

- Clean npm ci --ignore-scripts succeeds without NODE_PATH or borrowed modules.
- 52 tests pass, including 48 existing refinement/rendering/publication checks
  and four dependency checks (spoofed subnet rejected, valid subnet retained,
  exact patched lock versions, existing Express middleware/route registration).
- Test network guard blocks real external requests; Retell and KV are mocked.
- All business synchronization gates remain false.

## Remaining audit findings

npm audit reports zero critical/high findings and four moderate package findings:
uuid and its Google API ancestors gaxios, googleapis-common, googleapis.
These reflect GHSA-w5hq-g745-h8pq (UUID buffer bounds), not the resolved
proxy-addr rejection. npm suggests a major googleapis upgrade for complete
remediation. This release does not silently upgrade that separate integration
or claim a clean vulnerability audit. Review that upgrade separately with
Google API compatibility tests. Existing SDK deprecation warnings also remain.

## Reproduction

    npm ci --ignore-scripts
    node --require ./test/network-block.cjs --test \
      test/refinement.test.js test/business-render-v2.test.js \
      test/business-publication.test.js test/dependency-security.test.js
    npm audit --json

No production operations or live agent changes are part of these commands.
