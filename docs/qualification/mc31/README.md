# Migration Core 3.1.0 — adversarial qualification (Order 18A)

**Verdict: PARTIAL — no defect found; the suite, gate steps, reproducibility, golden and the 3.1.0 mutations pass; the 1M+ campaign has one of six founding passes and the limit-scale memory cases are not run.** Order 18A ran, on the 3.1.0 tree Order 13 prepared, the campaigns Order 13 left owed — the 1M+ capacity
campaign, mutation testing, an adversarial identity / duplicate / memory campaign — plus the whole suite, the gate steps and the
cross-OS golden. It found no defect in the engine. 3.1.0 is not published by this order (Order 18B releases it internally).

Subject: `cores/kauro-migration-core` at the O18A branch head (CORE_VERSION 3.1.0, package format 2.1.0, configuration schema
3.0.0, source registry 2026-10-22), campaign `c_d5743d46c84d7343` sealed before any measurement
(`cores/kauro-migration-core/qualification/candidate/campaign.json`). Host: Windows 11 x64 10.0.26300, 12 logical CPUs,
14.9 GB RAM shared with four other builders, Node v24.20.0. Every record named below is under [evidence/](evidence/).

## 1. Criteria and evidence

| Criterion (O18A) | Result | Evidence |
|---|---|---|
| 1885+ tests | **PASS** — 1885 of 1885, 49 files, 0 skipped (165 s) | `npm test` → `evidence/tests.summary.txt` |
| Gate steps | **PASS** — typecheck, contract lint (81 reason codes), spec check, CORE-CONSTITUTION-01, TARGET-CONTRACT-01, FINAL-ADV-01, source-backed 36/36, EVIDENCE-RULES-01 | §2 |
| Acceptances and hashes reproducible | **PASS** — `npm run acceptance` rebuilt the five packages with no byte of difference against the committed ones; determinism replay 48 of 48 fixtures, twice each in separate processes, 0 differing; the tarball packs to the same sha256 twice | §2 |
| Golden cross-platform | **PASS on Windows, Linux half in the platform CI** — two Windows probes in different time zones give one canonical digest; the platform test that asserts it on ubuntu is in Order 18B | §3 |
| 1M+ capacity (repository criteria: CAPACITY-FOUNDING, a million source rows per mode, two reproductions) | **PARTIAL** — CLEAN_ONLY pass 1 at 1,003,000 source rows: PASS inside every budget (peak RSS 1,435,344,896 bytes). The second CLEAN_ONLY pass and both HUBSPOT and SALESFORCE passes were not run: the host's memory-pressure reaper stopped the campaign | §4 |
| Adversarial campaign: identities, duplicates, memory | **PARTIAL** — the cases pass at 1/10 and 1/100 scale; the limit cases (250,000 and 250,001 rows) are not run | §5 |
| Sabotage | **PARTIAL** — 16 of 16 mutations run were killed: the six new 3.1.0 mutations (M130–M135), the four on `resolve-identity.ts` and M01–M06 of the full sweep before the reaper stopped it | §6 |
| CPU / peak RSS | recorded for every capacity pass and adversarial case | §4, §5 |
| Codes and strategies not registered; the five minor findings | consulted; none changes behaviour; listed, not fixed (sprint rule: MINOR) | §7 |

## 2. Suite, gate steps, reproducibility

`npm run build`, then on this tree: `node tools/run-tests.mjs` (SUMMARY files=49 tests=1885 pass=1885 fail=0 skipped=0),
`npm run lint`, `spec:check`, `constitution`, `target-contract`, `adversarial`, `strong` (36/36), `node tools/evidence-selftest.mjs`
(0 failures), `npm run determinism` (48 of 48, 0 differing), `npm run acceptance` followed by `git status acceptance spec` (clean).
`node tools/pack.mjs` twice: `kauro-migration-core-3.1.0.tgz`, 1,052,391 bytes, sha256
`22fe91ae66f30289839188ca16f0b99a5eb850950ad94b559ad42fc28daee5ea` both times.

DRIFT-01 reports one stale fact after the campaign seal (`provenance-vouches-for-the-bytes-that-are-here`: the provenance record
still hashes the previous campaign file); `node tools/provenance.mjs` regenerates it after the measurements, as the release
procedure does.

## 3. Golden across operating systems

DETERMINISM-CROSS-OS-01's subject (`tools/determinism-cross-os.mjs`) was probed twice on Windows, in America/Los_Angeles + en_US and in
Asia/Kolkata + de_DE: the same 22 artifacts and canonical package digest
`d9de42840ebcb10f0d60fda9aa15e417a2e58f40f025b7569d7b13b14cfbf930` (`evidence/cross-os-probe-win32-*.json`). This PC has no WSL or
container runtime, so the Linux half is the platform's verify: `packages/migration-core/test/cross-os-golden.test.ts` (Order 18B)
runs the vendored 3.1.0 tarball on the same subject and asserts that digest on the ubuntu and the windows leg of the final PR.

## 4. Capacity at a million rows

Repository criterion: CAPACITY-FOUNDING, three founding profiles (one per mode) at a million source rows, each migrated twice
(`node tools/capacity.mjs --profile FOUNDING-CLEAN-ONLY-1M,FOUNDING-HUBSPOT-1M,FOUNDING-SALESFORCE-1M --rows 1000000 --founding`), run
in a heavy-test slot. The host's memory-pressure reaper stopped the invocation at about 21:37, during pass 1's attestation. By then CLEAN_ONLY's first pass had
finished, and its child had written its own result (`evidence/capacity-founding-clean-only-pass1.json`). Because the harness writes
`qualification/capacity/*.json` only at the end of an invocation, no committed record was produced. The 2.0.3 records (3.0.0's
campaign) stay in `qualification/capacity/` as they were.

| CLEAN_ONLY, pass 1 of 2 | 3.1.0 (this run) | 3.0.0's record (campaign `c_4632914693dcaebc`) |
|---|---:|---:|
| source rows | 1,003,000 | 1,003,000 |
| records delivered | 950,000 | 950,000 |
| reconciliation equation / checks | holds / 60 | holds |
| peak RSS, bytes | 1,435,344,896 | 1,643,139,072 |
| peak live scratch, bytes | 11,304,609,917 | 10,878,563,080 |
| cumulative scratch writes, bytes | 55,114,357,554 | 47,919,956,831 |
| package bytes | 1,700,374,725 | 1,607,222,375 |
| profile / run / package / verify, ms | 307,979 / 1,116,900 / 221,353 / 825,444 | — / 506,177 / 74,249 / 381,249 |
| CPU user / system, s | 2,002 / 203 | — |

Every figure is inside its budget: memory 1,435,344,896 of 6,012,954,214 bytes (23.9 %) and scratch 11.3 of 48 GiB. The run took
about 2.2 times the wall clock of 3.0.0's record in every phase, including package writing and verification, which 3.1.0 did not
change. The CPU time is 89 % of the wall clock, so this pass was compute-bound on a host that four other builders were loading; it
says nothing about a slowdown of the engine. What D78 does cost is visible in the scratch: the email and full-name signal families
now carry the leads (1,292,567,784 and 1,274,022,144 bytes written, against 591,819,958 and 581,916,710 in 3.0.0's record). That
accounts for about 1.4 GB of the 7.2 GB increase in cumulative writes; the rest is the extra merge passes the external sort makes
over more runs.

**Owed:** CLEAN_ONLY's second pass (the determinism half of `candidate_bytes_deterministic`), and both passes of HUBSPOT and
SALESFORCE. At this host's measured pace that is about four and a half hours in one heavy slot with about 2 GB of memory to spare.
The command is the one above.

## 5. Identity, duplicates and memory

3.1.0's one behavioural change (D78) makes the person signals read Leads, so a lead-heavy export now reaches the duplicate clusters,
and with them the declared group limit `MAX_IDENTITY_GROUP_MEMBERS` = 250,000, which no test had ever fired.
`tools/adversarial-identity-memory.mjs` runs each case in its own process under the qualification heap (8,192 MiB) and records the
outcome, peak RSS and CPU:

| case | input | expected | 1/100 scale | 1/10 scale |
|---|---|---|---|---|
| L1 | N leads sharing one email | one cluster of N, completes | PASS, 2,500 rows, peak RSS 179 MB, 12.6 s | PASS, 25,000 rows, 472 MB, 20.3 s |
| L3 | N leads and N contacts sharing one email | two clusters, one per object, never one | PASS, 5,000 rows, 289 MB | PASS, 50,000 rows, 594 MB, 36.2 s |
| L2, L4, L5 | 250,001 leads sharing one email, one phone or one full name | `IDENTITY_GROUP_TOO_LARGE` | not run: only meaningful at full scale | not run |

`evidence/adversarial-identity-memory-reduced.json`. The resident memory of a duplicate cluster grows with its membership, because
the cluster is held to describe its conflicts: about 13 KB per member between the two scales. Extrapolated to the declared limit,
that is roughly 3.3 GB. This is under the 5.7 GiB memory budget but above what this shared host had free tonight, so the full-scale
cases were not run. **Owed:** `node tools/adversarial-identity-memory.mjs --out <dir>/adversarial-identity-memory.json`, at scale 1, on
a host with about 4 GB free.

The F-27 suite (`test/unit/identity-adversarial.test.ts`) covers the small-scale identity attacks: role mailbox, plus-addressing, a
Cyrillic look-alike, NFC against NFD, records equal but for their ids, a chain of three proofs in either order, consent under
`PREFER_SURVIVOR`, cluster ids stable under unrelated rows and moving with membership. All pass in the 1885.

## 6. Mutation testing

Order 13 changed `src/identity/resolve-identity.ts`, `src/artifacts/import-instructions.ts`, `src/domain/disposition.ts`,
`src/reconcile/truth.ts` and `src/adapters/specs.ts`, and no mutation covered the new code. Order 18A added M130–M135 to
`tools/sabotage.mjs`, each a way the D78 change could quietly regress. It also added `--suite-filter <part>`: under it a mutation
runs only the test files whose path holds `<part>`. A mutation killed that way is killed by the whole suite, while a survivor proves
nothing, so such a run is always PARTIAL.

| run | mutations | result |
|---|---|---|
| `--only M130,M131 --suite-filter identity` | the person signals read Contacts only; a bucket forgets its object | 2 of 2 killed (`evidence/sabotage-d78-identity.json`) |
| `--only M132,M133,M134,M135 --suite-filter import-instructions` | an unsupported file described as a pairing; a line counts leftovers; the HubSpot warning dropped; the Salesforce Id source dropped | 4 of 4 killed (`evidence/sabotage-d78-instructions.json`) |
| `--only M03,M04,M08,M58 --suite-filter unit` | the older mutations of `resolve-identity.ts` | 4 of 4 killed (`evidence/sabotage-identity-unit.json`) |
| full corpus, `--suite-filter unit` (134 mutations, every anchor verified) | M01–M06 | 6 killed, then stopped by the host's memory-pressure reaper (`evidence/sabotage-full-unit-partial.log`) |

**Owed:** `npm run sabotage` (all 134, whole suite). It takes about 3 minutes per mutation on this host, so about 7 hours. A
`--suite-filter unit` sweep (about 1.3 minutes per mutation) followed by the whole suite on its survivors is the shorter route.

## 7. Codes, strategies and the minor findings

Every strategy id the adapters emit (`RELATIONSHIP_HEADER_BY_DECLARED_MATCH_FIELD`, `TRACE_KEY_PAIR`, `TWO_FILE_COMMON_COLUMN`) is in
`spec/vendor/source-registry.json`; every reason code is declared and used (contract lint, 81 codes). Left open, MINOR, none changes
an output: (1) the Salesforce strategy id `RELATIONSHIP_HEADER_BY_DECLARED_MATCH_FIELD` names a route the package does not generate;
(2) `ASSOCIATION_RECORD_NOT_FOUND` is HubSpot's API error type and the registry cites only the UI label; (3) CONTRACT §1 counts the
rows of an excluded duplicate file (`EXCLUDE_ONE`) as rejected although they are well formed; (4) D78 understates that every
package's association keys move with the core version; (5) no test fired `IDENTITY_GROUP_TOO_LARGE` (the refusal needs 250,001 rows), although `resolveIdentity`'s own comment says a limit whose refusal has never fired is unchecked; `tools/adversarial-identity-memory.mjs` now carries the cases (L2, L4, L5), and running them is owed with §5.

## 8. What this does not establish

- Linux: no WSL or container runtime on this PC. The golden's Linux half is the platform verify's ubuntu leg (§3); the core's own
  1885 tests ran on Windows only.
- The founding evidence and the release candidate's own records (`qualification/candidate/manifest.json`, `universe.json`,
  `preflight.json`) were not regenerated for 3.1.0. RELEASE-CANDIDATE-01 and ARCHITECTURE-01 read them, so neither gate is claimed
  for 3.1.0 here. The provenance record was regenerated after the campaign seal (`npm run provenance`; DRIFT-01 and
  `provenance:check` pass).
- Whether a real CRM imports a 3.1.0 package (Order 29).
