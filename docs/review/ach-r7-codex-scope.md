# Codex design-delta review — ACH route r7 (Payments V1): scope

Kind: design-time delta review of one package design (A7 §5 draft: one design-time review per package). **Effort: high**
(money: refunds, receipts, ledger, authority). One round; re-checks only on the delta and open findings.

## Subject
- Branch `pv1/docs-r7`, base `ach/domain-design` `473718f` (r6, Codex design ACCEPT). Review the diff `473718f..<r7 head>` only.
- Files: `docs/design/ACH-ROUTE.md` (r7), `docs/design/ACH-case-map.md` (new), `docs/design/B09-case-map.md` (appended appendix only).
- Authority given with the bundle (slices, not whole files): owner decision `docs/authority/decisions/2026-10-07-PAYMENTS-V1.md`
  (whole, 76 lines; from branch `docs/payments-v1-decision` 499c505, not yet on this base); R2 15 §Initial payment decision, §Capture and authority, §Payment state transitions, §Price and source expiry
  races, §Refund policy and calculation, §Settlement and withdrawal; `docs/design/FAILURE-MATRIX-TEMPLATE.md` (family rules 1–10).
- Prior findings to re-check: none open on r6 (ACCEPT); the r1–r3 outbound findings stay bound through Appendix A (unchanged).

## In scope (ACH-ROUTE.md r7 line anchors at the r7 head)
| # | Section | What to judge |
|---|---|---|
| 1 | §0 DV1-01..DV1-09 (:21–:133) | Each decision against PV1 and R2 15; precedence PV1 > A8 > r6; nothing Wise- or wire-specific in a contract; nothing PayPal-dependent |
| 2 | §0 DV1-06 | The late-confirmed on-time credit rule vs R2 15 §Price and source expiry races: `bookedAt` from classified evidence only; tolerance bounds; authority only with every subject guard and no other purchase; ROUTE_SWITCH stays return-only; no authority from a draft |
| 3 | §0 DV1-08, §7.21–§7.22 (X1, X2, X3, NR) | NEVER-RESEND on every entry point; one money source per execution id across scopes; never COMPLETED without classified evidence; X3 NOT_EXECUTED evidence standard (SI2 coverage + lag); K-6 (`authorization_lapsed` never lapses SUBMITTING); K-10 (reference fidelity not required for completion) |
| 4 | §0 DV1-03, DV1-07 and §7.24 (P1Δ, I2Δ) | Wire as data; gross matching with observed fee; window guard and `sendBy`; delegation of unchanged cells to the base row ("base" cells) is acceptable under rules 2, 3 and 6 |
| 5 | §7.23 (SI1, SI2) and S3 "actor SI2" | Owner statement import replaces the API scanners without losing coverage, orphan or BALANCED invariants of r6 §6.1 |
| 6 | §7.25 (ST1, ST2) | Settlement keeps captured / held / provider-available / bank-available separate (R2-085); funds fence 0043 race |
| 7 | §7 intro + row tags | V1 (22 rows, 176 cells) vs LATER 2026-11-30 (13 rows, 104 cells); every LATER path is unreachable in V1 and §7.27 (FC-V, FC-G5, FC-API, FC-RAIL) proves it; V1 cells reading payer authorization assert the billing-identity rule |
| 8 | §8 new and updated cases, §9 change list | ACH-20..22, RFG-01..03, ACH-REFUND-LIVE-01; ACH-01/11/15/17/18/19 updates; G-PRODUCTION vs G-BUSINESS |
| 9 | Annotated r6 decisions | D-ACH-01, 02, 04, 06, 08, 10, 17, 19, 20, 21 SUPERSEDED/amend markers are consistent with §0 and leave no contradictory live rule |
| 10 | §6, §6.1 renames | `BankTransferEvidencePort`, `BankAccountRef`, `StoredBankEvidence`, `BankEvidenceReadPortV1`, `UsdBankAccountDetails`, `BankRail`, `ProviderId`, `bankExecutionId`, `classifyStatement`; no semantic change besides `acceptedRails` and `StatementPage` |
| 11 | ACH-case-map.md, B09 appendix | Evidence classes honest (artifact-classifying cases PARTIAL until ACH-LIVE-01); DEFERRED remainders (DV1-09) named; no accepted B09 row, status or title changed |

## Out of scope
- r6 cell texts and titles of the 35 rows (accepted; only the class tag was prepended); Appendix A (unchanged).
- PayPal adapter (PR #19, DEFERRED), legal texts (separate LEGAL-V1 delta, medium effort), S-E screens, implementation.

## Questions Codex must answer (each: ACCEPT / finding with severity and the section)
1. Can any V1 path produce a COMPLETED refund, a second outbound execution, or released reservation without classified evidence or
   owner D-24 A resolution? (§7.21–§7.22, NR)
2. Can DV1-06 mint authority from an untrusted or out-of-tolerance instant, or for a project that already has another purchase?
3. Does any LATER row leave a reachable V1 path with no fail-closed cell?
4. Does any contract name, table, enum or event in r7 couple the domain to Wise, to wire, or to PayPal?
5. Is every new money/authority cell GAP tier 1 with an exact title, and every N/A justified (read-only, no own write)?
6. Are the evidence classes in ACH-case-map.md honest per A6 (no LIVE or EXECUTED_LOCAL claimed for a simulated half)?

## Caveats stated up front (never hidden)
- K-5 / DV1-09: CMD029/030/033/034 live remainders and R2-061's webhook half are DEFERRED with the parked rail (no date).
- K-7: payer authorizations (V1–V3, ACH-18) LATER 2026-11-30; V1 accepts only the billing identity (FC-V).
- K-8: the Wise statement/receipt byte format is unproven until a real artifact; classifiers are adapter-only; ACH-04/05/07/13/15/20/22
  stay PARTIAL until ACH-LIVE-01; a post-freeze classifier fix is an adapter diff with explicit equivalence.
- K-10: the outbound reference field's survival on the rail is unproven; G2 completes on execution id + amount + digest + declaration.
- G5/P4 LATER: an over-return in V1 stays an orphan exception and the period is never BALANCED (FC-G5); no ledger repair before 11-30.
- The timing values (`minimumTransferWindow`, `manualExecutionWindow`, provider-time tolerance) are route data set at configure with
  source; the design fixes only the comparisons.

## Budget
One round, high effort, bundle ≤ the diff + the slices above (no whole repos or docs). Expected verdict format: tools/review JSON.
