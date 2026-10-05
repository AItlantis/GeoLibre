# Dependency patches

`node-forge+1.4.0.patch` backports the upstream fix proposed in
[digitalbazaar/forge PR #1152](https://github.com/digitalbazaar/forge/pull/1152)
for GHSA-86w9-cpqp-85rv / CVE-2026-85393. The released 1.4.0 package checks the
outer `DigestInfo` element count but its ASN.1 validator ignores extra children
inside `DigestAlgorithm`; the patch rejects more than the OID and optional NULL.

The patch is applied during clean install by `patch-package`. The dependency
audit gate verifies the installed source contains the patched guard before
classifying the version-based advisory as remediated. This is not an advisory
allowlist: an absent package, different version or missing guard fails the gate.
Remove the patch and gate entry after a published upstream fixed release is
available and installed.

`braces+3.0.3.patch` adds a 100-level nesting limit for GHSA-vfj7-8cjw-p6xm.
The advisory has no published fixed release; deeply nested brace expressions
could exhaust the JavaScript stack. The parser rejects excessive nesting before
building the recursive AST. `audit:ci` verifies both the exact installed
version and the guard, and the frontend test covers both the limit and ordinary
alternatives/ranges. This is a source-verified remediation, not an allowlist.
Replace it with an upstream release when one is published.
