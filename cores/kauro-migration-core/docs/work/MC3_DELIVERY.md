# MC-3 — delivery

Rewritten during the recovery of 2026-09-11 on the branch that becomes the
candidate. Written **before** the final chain runs, because every document in
this tree is part of the manifest the universe binds to, and nothing can be
edited after the universe without invalidating it. The state that only the
remote can settle — the merged commit, the tag, the release, the verdict — is
therefore not in this file. It is in the handoff record written outside the
tree by `tools/chain.mjs`, and the verdict that decides the four flags is
computed by `tools/freeze-verdict.mjs` against the published release.

The first version of this file was written on 2026-09-10 at 22:10Z with the
front open and a campaign running that was later lost. The recovery audit of
the same day found four defects in what that version described as established;
this version is the account after they were repaired.

---

## 1. The flags

    MIGRATION_CORE_ARCHITECTURE_CLOSED   = computed, not written here
    MIGRATION_CORE_RELEASE_CANDIDATE     = computed, not written here
    MIGRATION_CORE_IMPLEMENTATION_FROZEN = computed, not written here
    MIGRATION_CORE_V1_FROZEN             = computed, not written here

`tools/freeze-verdict.mjs --sha <merged> --tag v2.0.1 --receipt <downloaded>`
derives them from what the tree cannot write: the commit `main` points at, a
clean checkout reproducing its digests, the CI receipt observed from outside
the run, the ruleset in force with every required check and no bypass actor,
the annotated tag, and the published release — `draft:false`,
`immutable:true`, carrying exactly the dossier of this candidate, downloaded
and hashed. A verdict computed in a rehearsal says so in its own report and
is not a freeze.

## 2. State of the candidate at the time of writing

    branch            core/mc3-verdict-fix
    main              759bac3 (2026-09-10 07:42Z), receipt verified then
    core version      2.0.1     package format 2.0.0     (MC3_VERSION_EXCEPTION.md)
    campaign          c_53d6b2453fe15386, sealed 2026-09-11 02:18:41Z over 6740923
    vendor gates      5 of 5 PASS under that seal, 02:19–02:24Z
    capacity          matrix 12/12 and founding 3×2 PASS, 08:43Z (§3)
    tests             1,471 pass, 0 fail (35 files)
    evidence rules    89 rules, each proved to fire
    dossier rules     38 cases
    launcher rules    7 cases
    gate self-test    24 scenarios
    barrier           READY_TO_EXECUTE_FINAL_CHAIN = TRUE at bc5729d, 02:40Z
    tag v2.0.0        permanently reserved by GitHub, unusable
    tag v2.0.1        authorised by the owner; must not exist when the chain reaches it

## 3. The campaign

One campaign, one seal, matrix first because it is the leg that has failed
before and the cheaper one to find out about, founding second. Results are
recorded here from `qualification/capacity/*.json` once the campaign has
written them, before the universe runs.

    matrix P1–P12 at declared scale   : 12 of 12 PASS, 02:18–06:13Z (3h55); peak 2,085 MiB (P8)
    founding CLEAN_ONLY ×2 at 1M      : PASS, 1,003,000 rows, peak 1,621 MiB, run 505s
    founding HUBSPOT ×2 at 1M         : PASS, 1,003,750 rows, peak 1,577 MiB, run 567s
    founding SALESFORCE ×2 at 1M      : PASS, 1,003,000 rows, peak 1,514 MiB, run 506s
    campaign end                      : 08:43:41Z, matrix exit 0, founding exit 0
    every capture                     : 2.0.0, campaign c_53d6b2453fe15386, producer fingerprint identical at start and end

P3 (SHEET_COUNT, 2,000,024 rows) and P8 (VALUE_SIZE, 1.65 GB of source), the
two matrix profiles that failed in MC-2, passed; budgets as declared in bytes,
nothing scaled down.

Observed on the runs that were stopped (deviations D9, D10): P1 at 1,000,000
rows PASS in 9.8 minutes of engine time, peak 1,155 MiB against a budget of
5,734 MiB.

## 4. What the recovery repaired

Four defects the audit reproduced, each with the proof that now fires:

| id | was | is | proof |
| --- | --- | --- | --- |
| MCR-01 | the verdict accepted any assets beside a matching `SHA256SUMS`, and `immutable:false` | a declared dossier inventory (13 assets, roles, origins), a delivery manifest bound to the measured digests, campaign and producer fingerprints, strict sums, exact inventory, `immutable:true` observed, draft separated from frozen | RELEASE-DOSSIER-01, 38 cases |
| MCR-02 | the launcher stopped on grep'd text; a gate printing PASS and exiting 7 let the pipeline continue | exit codes, whole logs, owned files staged, zero dirty asserted; the first draft of the fix had the very bug and its own test caught it | LAUNCHER-STOPS-01, 7 cases |
| MCR-03 | class-granular invalidation; the launcher was EDITORIAL and `bench/` was not even measured | each capture bound to its producer's traced closure at start and end; the launchers measured; the universe bound by its report's digests | EVIDENCE-RULES-01 `closure.*`, `batch.*` (17 rows); gate self-test |
| MCR-04 | `--expect-checks a,b,c` split on commas through names that contain commas | `--expect-check <whole name>`, add-only, empty and trimmed values refused | usage errors exit 64 |

And the design defect the first delivery described and did not fix: a change
to `tools/sabotage.mjs` no longer invalidates capacity evidence that never
read it. The batch table in EVIDENCE-RULES-01 shows, per changed path, which
producers move and which hold — the engine, the lockfile and the campaign
binding move every producer; the sabotage harness, the verdict, the dossier
verifier and the workflow move none.

## 5. The chain

`tools/chain.mjs` is the final chain as a graph: twenty nodes from
`seal-check` to `handoff`, each with its real command, inputs, dependencies,
timeout and oracle; validated for cycles and orphans; walked in topological
order; a failed node blocks exactly its descendants; every independent failure
in one report; a read-only `--check` walk that verifies the same bytes without
re-running a producer; a ledger outside the tree. Remote writes need
`--allow-mutations`.

It was rehearsed end to end under CONTROL_FLOW_TEST_ONLY against a GitHub
served from a file, with the remote nodes being the real code: pull-request
checks, rebase merge, the main run, the downloaded receipt observed by
`receipt-verify`, the dossier built and verified, the TypeScript consumer, the
annotated tag, the draft with its thirteen assets, the publication, the
verdict with every remote condition true, the handoff — and then the read-only
walk agreeing. Six scenarios failed exactly where they should: a gate that
fails, red CI, a refused merge, an existing tag, a mutable release.

The order of the generated records (§10 of `MC3_EXECUTION_STATE.md`) and the
release procedure (§11) are nodes of that graph, not paragraphs to remember.

## 6. The consumer seam

`tools/consumer-check.mjs` installs the tarball into a TypeScript strict
project with no path to this repository and compiles and runs a consumer that
uses the public entry alone: the vocabularies Intelligence Core checks
proposals against (value intents, transformation kinds, safety classes,
semantic types, candidate types, target modes, the support envelope through
the adapters, the package layout); the three modes on small fixtures, HUBSPOT
and SALESFORCE under a target contract the consumer constructed and an
attestation it signed with the exported signing bytes; and the refusals — a
tampered profile, a tampered and a foreign candidate set, a future version, a
profile for another bundle, an expired, a forged and a cross-contract
attestation. Twenty-eight checks. What the seam needed and did not have —
`attestationSigningBytes`, the contract's vocabularies, the identity rule
version, the layout — was exported before the campaign was sealed, because a
change to `src/` afterwards would have cost it.

## 7. What was lost, counted

| campaign | sealed | stopped | why | cost |
| --- | --- | --- | --- | --- |
| c_8d5ba3a565072ace | 09-10 19:28Z | 09-10 ~21:30Z | contamination: a child-only kill left the orchestrator alive; a second matrix shared its directories | evidence discarded |
| c_05aca06eaf0abc14 | 09-11 01:34Z | 01:53Z | `bench/` unmeasured (MCR-03); the fix is in the capacity closure | 17 min |
| c_941e544247629ac7 | 01:56Z | 02:17Z | `attestationSigningBytes` not public; `src/` is in the capacity closure | 20 min |
| c_53d6b2453fe15386 | 02:18Z | — | the campaign | — |

Every stop was decided when the closure was known to be about to change,
rather than after hours had been spent on a closure that would not hold.

## 8. What remains after this file is written

The chain, from `records-pre-universe` to `handoff`; the universe (about an
hour); pull-request CI and main CI (about an hour each); the receipt; the
dossier; the tag; the draft; one publication; the verdict; the handoff
outside the tree. Then, and only then, Intelligence Core.

## 9. Owner actions

None. The `v2.0.0` reservation is resolved by the owner's authorisation to
release as `v2.0.1`, recorded in `MC3_VERSION_EXCEPTION.md`.
