# Migration Core — provenance

What this release is, what established it, and what it does not claim. Generated
by `node tools/provenance.mjs` from the evidence on disk, so it cannot drift
from the repository it describes. Every gate state below is read from the
evidence that gate wrote; none is asserted here.

- Core version `3.1.0`, package `3.1.0`, package format `2.1.0`
- Source registry reviewed `2026-10-22`
- Campaign `c_d5743d46c84d7343`, sealed 2026-10-23T01:35:39Z, over subject `f2b6d153940b8b03`
- `MIGRATION_CORE_IMPLEMENTATION_FROZEN` is decided by `tools/freeze-verdict.mjs`, outside this tree

## Support envelope

Three commercial modes and nothing else: `HUBSPOT`, `SALESFORCE`,
`CLEAN_ONLY`. HubSpot carries Contact, Company and Deal. Salesforce carries
Account, Contact, Lead and Opportunity, with Lead first-class rather than a
renamed Contact. **Activities are out of the envelope and are refused**, before
a file is written, rather than attempted and lost.

## Gates

| Gate | State | Established by |
| --- | --- | --- |
| `CORE-CONSTITUTION-01` | **PASS** | the offline universe ran it (exit 0); CORE-CONSTITUTION-01 = PASS |
| `TARGET-CONTRACT-01` | **PASS** | the offline universe ran it (exit 0); TARGET-CONTRACT-01 = PASS |
| `EVIDENCE-RULES-01` | **PASS** | the offline universe ran it (exit 0); EVIDENCE-RULES-01 = PASS |
| `SABOTAGE` | **PASS** | the offline universe ran the whole corpus (exit 0); outcomes: KILLED 128 |
| `SABOTAGE-LEFT-NO-TRACE` | **PASS** | no tracked change, no untracked file, no mode change, and nothing undeclared under tmp/ |
| `FINAL-ADV-01` | **PASS** | 8 attacks |
| `HSP-TARGET-01 (target contract)` | **PASS** | 47 checks against 51872453 |
| `HSP-TARGET-01 (import)` | **PASS** | 30 expectations against 51872453 |
| `SF-TARGET-01 (target contract)` | **PASS** | 11 checks against 00Dak000018tvSeEAI |
| `SF-TARGET-01 (Data Loader)` | **PASS** | 31 expectations against 00Dak000018tvSeEAI |
| `SF-OCR-01` | **PASS** | 13 expectations, real org, real Data Loader |
| `CAPACITY-FOUNDING` | **PASS** | a million representative source rows in each of CLEAN_ONLY, HUBSPOT, SALESFORCE, inside the founding budgets in bytes |

## Capacity

The resource contract, in bytes: memory budget 6,012,954,214
against a hard ceiling of 8,589,934,592, scratch budget
51,539,607,552, wall clock 28,800,000 ms.

| Mode | Source rows | Peak RSS | Peak scratch | Package | Wall clock | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `CLEAN_ONLY` | 1,003,000 | 1,662,840,832 | 10,825,656,761 | 1,690,530,332 | 1,169,436 ms | PASS |
| `HUBSPOT` | 1,003,750 | 1,489,063,936 | 12,246,063,948 | 1,956,933,603 | 1,271,069 ms | PASS |
| `SALESFORCE` | 1,003,000 | 1,665,265,664 | 10,825,399,434 | 1,799,954,522 | 1,146,939 ms | PASS |

Every figure is an integer count of bytes or milliseconds, read from the
founding evidence. There is no mebibyte in this record and none in the files it
reads: the evidence that shipped with V1 computed a field called `peakMb` as
bytes divided by 1024 twice and compared it against a budget written the other
way.

## Evidence

| Artifact | Required | Present | SHA-256 |
| --- | --- | --- | --- |
| `qualification/evidence/final-adversarial.json` | yes | yes | `c5a16adfdb21b4dc` |
| `qualification/evidence/hs-target-contract.json` | yes | yes | `24d14958a053318e` |
| `qualification/evidence/hs-import.json` | yes | yes | `9b31ec127c057500` |
| `qualification/evidence/sf-target-contract.json` | yes | yes | `aafd3c8e093fd634` |
| `qualification/evidence/sf-dataloader.json` | yes | yes | `5c8deb4cd5296347` |
| `qualification/evidence/sf-ocr.json` | yes | yes | `ecbe76157c425803` |
| `qualification/capacity/clean-only.json` | yes | yes | `c18e8d9ac1022bd9` |
| `qualification/capacity/hubspot.json` | yes | yes | `a8a111c1d59d59be` |
| `qualification/capacity/salesforce.json` | yes | yes | `170550391a599a5a` |
| `qualification/capacity/matrix.json` | yes | yes | `ba6f83475536d255` |
| `qualification/candidate/manifest.json` | yes | yes | `4bbaf235e7143bc8` |
| `qualification/candidate/provenance.json` | yes | yes | `6de2960309ac99ac` |
| `qualification/candidate/preflight.json` | yes | yes | `9c102dcc3aa994a4` |
| `qualification/candidate/universe.json` | yes | yes | `fa61e1fb4f2a19bf` |
| `qualification/candidate/campaign.json` | yes | yes | `611bf180761fa5fd` |
| `qualification/evidence/HUBSPOT_SCOPE_BLOCKER.md` | yes | yes | `2f54cb91630f8c41` |
| `qualification/evidence/SF_DATALOADER_AUTH.md` | yes | yes | `e8eb1c20e9ea6607` |
| `qualification/evidence/TENANT_SAFETY.md` | yes | yes | `4428b9c5b9ca47fe` |
| `docs/work/GATES.md` | yes | yes | `72640fb1294126da` |
| `qualification/evidence/hs-custom-property.json` | no | **no** | `—` |

## What this release does not claim

- A property Kauro creates is qualified nowhere in this release. It was established once, on 2026-09-02, in portal 51050101 — a standard account holding real customer records, which is out of scope from MC-3 on — and that evidence is historical and is not counted here. The developer-test portal the qualification uses carries no crm.schemas.*.write scope; qualification/evidence/HUBSPOT_SCOPE_BLOCKER.md names the one action that would close it.
- That the committed acceptance packages have been imported anywhere. They are reproducibility evidence. What was imported was built from the qualification corpora, into the developer-test portal and the Developer Edition org named in the vendor evidence.
- That either qualification tenant is a production account. Neither is: one is an isolated HubSpot developer test account, the other a disposable Salesforce Developer Edition org, and qualification/evidence/TENANT_SAFETY.md records how each was established before anything was written.
- That an attestation issued from outside this repository has ever been verified here. Every attestation this engine has verified is a genuine Ed25519 signature over a contract naming an instance nobody owns; the seam is real and the external issuer is not yet.
- That the capacity figures hold on a smaller machine. They are one host's measurements — win32 — and every capacity record carries the environment it was taken on.
- That this record establishes which commit it describes. It cannot: a file inside a tree cannot name the tree that contains it. The commit, the git tree and the cross-platform result are the external CI receipt’s, and tools/receipt-verify.mjs is what checks them.
