# Migration Core 3.0.0 — release notes and operator steps

3.0.0 is the release that was prepared as 2.0.3. `2.0.3` was never tagged or published; the history entries that
say "2.0.3" (decisions D64 to D74, `EQUIVALENCE_2.0.3.md`, the closure plan) keep that name because they record
work done under it. The version is 3.0.0 because the configuration schema is 3.0.0 and **a 2.x configuration is
rejected**: that is a breaking change (D67, whitespace is a value; D68, a zone only with its tzdata).

## What an integrator must act on

| what | 2.0.2 | 3.0.0 |
|---|---|---|
| configuration schema | 2.x | `configVersion: "3.0.0"`; a 2.x configuration is refused with its reason |
| `CORE_VERSION`, package, bin | 2.0.2 | `3.0.0`, `kauro-migration-core`, `kauro-core` |
| `VerifyOptions` | `scratch`, `observe` | adds `targetContract?`, `requireTargetContract?`, `joinBound?`, `observeJoin?` |
| isolation detail of a merge | every conflicting value, in full | at most 5 values of at most 80 characters, then a count (B01-R7); the full set stays in the merge's conflicts |
| package verifier cross-checks | one bucket per key held whole | a hot key is walked in pieces of at most 8192 rows (B02-R3) |

The rest of the 2.0.3 changes (destination permission boundary, verification against a trusted target contract, the
reproducible tarball) are in `HANDOFF_TO_INTELLIGENCE.md` and D64 to D74.

## CMD024

CMD024-OK, CMD024-DENY and CMD024-RACE are recorded as PARTIAL under amendment A5
(`authority/r2/amendments/A5_CMD024_SPLIT.md`): this core proves the semantic half through its public API; the
transactional command is B08's and is pending. They are not claimed as executed.

## Operator: check the published bytes (B02-R4, R2-017)

Run this right after publishing the 3.0.0 pre-release. Nothing in the repository publishes anything. The check
downloads the asset from the URL a consumer would use, requires its sha256 to equal the digest you supply, the
digest in the release's `SHA256SUMS`, and the tarball `tools/pack.mjs` reconstructs from the tag's commit, and only
then installs those exact bytes and compares every installed file with its tar entry.

Needs `GITHUB_TOKEN` (or `GH_TOKEN`), a local clone that holds the tag's commit, and this repository's `node_modules`.

```
node tools/published-asset-check.mjs \
  --asset-url https://github.com/miguellopezndev-ui/kauro-migration-core/releases/download/v3.0.0/kauro-migration-core-3.0.0.tgz \
  --sha256 <the digest of kauro-migration-core-3.0.0.tgz from the release dossier> \
  --out qualification/evidence/published-asset.json
```

It writes `qualification/evidence/published-asset.json` (default path) and exits 0 only when the result is `PASS`.
Keep that file: it is the evidence that closes R2-017. The equivalent form without a URL is
`--repo miguellopezndev-ui/kauro-migration-core --tag v3.0.0`, which skips the operator's digest and URL comparison.
