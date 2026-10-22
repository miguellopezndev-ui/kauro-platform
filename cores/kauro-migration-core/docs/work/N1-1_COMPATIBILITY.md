# N1-1 — Intelligence Core 0.6.0 against Migration Core 3.1.0

Run on 2026-10-22, in scratch copies outside the repository; nothing under `cores/kauro-intelligence-core/` or `vendor/` was
changed. Intelligence Core was taken from this tree (`git archive HEAD:cores/kauro-intelligence-core`), Node 24.20.0, npm 11.19.0,
Windows 11. Each run is `npm ci` or `npm install`, `npm run build`, then `npm test` (64 test files, 748 tests, 4 skipped by the
suite itself).

The Migration Core 3.1.0 tarball is `node tools/pack.mjs` of this tree: 1,050,648 bytes, sha256
`1691ec6648690c26ba75ceac1ab5d107fb5895f99356be9aaa2bad97d223d1eb`, the same bytes on two packs. It is not a release and is not
vendored anywhere.

| Run | Migration Core installed | Intelligence Core changes | Result |
|---|---|---|---|
| 1. Baseline | the vendored 3.0.0 release | none | 744 pass, 0 fail |
| 2. As 3.1.0 | the 3.1.0 tarball | `SUPPORTED_MIGRATION_CORE.coreVersions` = `['3.1.0']`, the dependency and peer dependency on 3.1.0, its `vendor/MANIFEST.json` on the new bytes | 693 pass, 51 fail |
| 3. Behaviour only | this tree packed with `CORE_VERSION` 3.0.0 and `SOURCE_REGISTRY_VERSION` 2026-09-06 (every N1-1 behaviour, 3.0.0's names) | none | 743 pass, 1 fail |

**Run 3 is the behavioural answer.** With every change of this order in the engine and only the version identities held at 3.0.0,
one test fails: `b04-scorer-validity` S044 v4, which asserts that the installed package is byte for byte the published 3.0.0
release. It is meant to fail on any other bytes. Everything Intelligence Core does through Migration Core (profiles, candidate sets,
`loadConfig`, `runMigration` truth including `duplicateCandidates`, receipts) behaves the same.

**Run 2's 51 failures all come from what Intelligence Core binds to the exact 3.0.0 release**, none from behaviour:

| Failures | Cause | What closes it |
|---|---|---|
| 20 | The sealed validity record names Migration Core 3.0.0 and its tarball's sha256: 19 runs refused `RECORD_FOR_ANOTHER_MIGRATION_CORE` / `..._TARBALL`, and `b04-scorer-validity` S044 v4 asserts the committed record binds 3.0.0 | Reseal the validity record on the released 3.1.0 tarball |
| 3 | The sealed corpus binds each fixture's `candidateSetHash` and truth digest, and a candidate set carries `coreVersion` and `sourceRegistryVersion` (`b04-corpus-families`) | Reseal the corpus on 3.1.0 |
| 28 | Campaign, chaos, preflight, seed and multi-file cases downstream of those two (a stage refused before it ran, a seed whose sealed hashes no longer match), and `b04-engine-mc3` S7v, which pins 3.0.0 and its sha256 in the compatibility matrix | The two reseals and `docs/COMPATIBILITY_MATRIX.md`; all 28 pass in run 3 |

So Intelligence Core needs, for 3.1.0 and in one change: `SUPPORTED_MIGRATION_CORE.coreVersions`, the dependency, peer dependency
and lock, `vendor/` and its manifest on the released tarball, the compatibility matrix, and a reseal of its corpus and validity
records. No source change in its adapters, compiler or effects is indicated by these runs.

The platform pins 3.0.0 in `vendor/MANIFEST.json`, `vendor/SHA256SUMS.mc-3.0.0`, `packages/migration-core/package.json`,
`pnpm-workspace.yaml`, `pnpm-lock.yaml`, `packages/data-plane/src/cores/migration-core-adapter.ts` (`MIGRATION_CORE_VERSION`) and
`packages/reports/src/package.ts` (`SUPPORTED_CORE_VERSION`, and `packages/reports/test/fixtures/mc-3.0.0`). Those move at the N1
closing integration, after Intelligence Core accepts 3.1.0 (`cores/README.md`, "Changing a core").
