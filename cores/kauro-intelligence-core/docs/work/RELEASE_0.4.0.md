# Release record 0.4.0 (amendment A2 rename)

| case | test file :: exact title | 9533463 (test only) | final |
| --- | --- | --- | --- |
| BRAND-A2 | test/brand.test.ts :: BRAND-A2: no file of the tree carries the retired brand word outside the vendored Migration Core release identity | FAIL | PASS |
| BRAND-A2 | test/brand.test.ts :: BRAND-A2: the package, its description and the prompt role name Kauro Intelligence Core | FAIL | PASS |

- Package `kauro-intelligence-core` 0.4.0; prompt bundle 1.1.1 (role sentence only); no other contract version, shape or behaviour change.
- Migration Core stays 2.0.1 (release 387057468, asset 557300441, sha256 `787f0b80…f000`, bytes re-downloaded and equal on 2026-09-29).
  The renamed Migration Core 2.0.3 has no published release yet, so it is not re-pinned here.
- Admitted exception, checked by BRAND-A2: the vendored release's own npm name, asset file name and declared executable
  (`vendor/MANIFEST.json`, `package.json`, `package-lock.json`, and the import specifiers in `src/` and `test/`). They go away when a
  renamed Migration Core release is vendored.
- The tools read the Migration Core name from `vendor/MANIFEST.json` (CONTRACTS-01, INTELLIGENCE-CONSUMER-01, the rehearsal and CI
  dependency budget).
- Authority citations renamed one to one (A2); the digests are unchanged.
- Superseded work record removed from the tree: `docs/work/R_IC_PRIVACY_20260915_01.md` at d7b3d28, git blob `420b4dd3`, sha256
  `49856823afb4fae665c6d12d8466c843702df51d89f5c8e9d8baa4e9cfac8706`.
