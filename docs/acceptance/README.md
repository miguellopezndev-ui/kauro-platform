# Package acceptance records

Amendment A4 of the authority (edition KAURO-2026.09-R2, `C:\Projects\Kauro\authority\r2\amendments\A4_OPERATING_MODEL.md`)
defines package acceptance: (a) the case map gives every registry case its evidence class and test; (b) the full verify is
green on the exact commit on Windows, Linux and in CI; (c) an independent reviewer from another model provider (Codex) reviews
that exact commit against the registry cases and answers ACCEPT or ACCEPT_WITH_MINOR, the re-check covering only its findings;
(d) the commit is on `main`. Formal acceptance follows `registry/program.json` dependencies: a package whose conditions hold
but whose dependencies are not yet accepted is **REVIEW_ACCEPTED**.

Raw reviewer answers are in `reviews/` (`<package>-round<n>-<commit>.json`, schema `tools/review/review-schema.json` on the
operator host).

<!-- ledger:table:start -->
| Package | Cases | Status | Accepted subject (commit · review) | Review rounds | Waiting for |
|---|---|---|---|---|---|
| B00 Observed baseline and business readiness | 4: 2 EXECUTED_LOCAL, 2 NOT_EXECUTED | IN_PROGRESS | — | — | — |
| B01 Migration semantics and hostile inputs | 33: 29 EXECUTED_LOCAL, 3 PARTIAL, 1 PLANNED | IN_PROGRESS | — | — | — |
| B02 Migration qualification and distribution | 7: 4 EXECUTED_LOCAL, 1 SIMULATED, 2 PLANNED | IN_PROGRESS | — | — | — |
| B03 Intelligence offline kernel and compiler | 50: 2 EXECUTED_LOCAL, 26 PARTIAL, 22 SIMULATED | IN_PROGRESS | — | — | — |
| B04 Model qualification and Intelligence release | 11: 11 NOT_EXECUTED | NOT_STARTED | — | — | — |
| B05 Monorepo and shared contracts | 3: 3 NOT_EXECUTED | NOT_STARTED | — | — | — |
| B06 Domain, database and authorization | 29: 18 EXECUTED_LOCAL, 11 PARTIAL | REVIEW_ACCEPTED | `d9bbfd0` · B06-round3-d9bbfd0 | 3: REJECT a7203f0 → ACCEPT 4b33e26 → ACCEPT d9bbfd0 | B05 → B02, B04 → B01, B03 → B00 |
| B07 Upload, inspection and source lifecycle | 23: 11 EXECUTED_LOCAL, 12 PARTIAL | REVIEW_ACCEPTED | `d9bbfd0` · B07-round7-d9bbfd0 | 7: REJECT 0f15636 → REJECT 6b670e3 → REJECT 77d5fa6 → REJECT 09faf25 → ACCEPT d23af32 → ACCEPT 4b33e26 → ACCEPT d9bbfd0 | B06 → B05 → B02, B04 → B01, B03 → B00 |
| B08 Audit, approval and processing authority | 15: 7 EXECUTED_LOCAL, 8 PARTIAL | REVIEW_ACCEPTED | `88cf29d` · B08-round3-88cf29d | 3: REJECT f49ca76 → ACCEPT d9bbfd0 → ACCEPT 88cf29d | B07 → B06 → B05 → B02, B04 → B01, B03 → B00 |
| B09 Payments and fiscal workflow | 30: 7 EXECUTED_LOCAL, 23 PARTIAL | REVIEW_ACCEPTED | `d9bbfd0` · B09-round5-d9bbfd0 | 5: REJECT 0f15636 → ACCEPT 6b670e3 → ACCEPT d23af32 → ACCEPT 4b33e26 → ACCEPT d9bbfd0 | B06 → B05 → B02, B04 → B01, B03 → B00 |
| B10 Agency recurrence and commission domain | 64: 53 EXECUTED_LOCAL, 11 PARTIAL | IN_PROGRESS | — | — | — |
| B11 Public and agency application | 13: 2 EXECUTED_LOCAL, 8 PARTIAL, 3 PLANNED | IN_PROGRESS | — | — | — |
| B12 Seller and owner application | 20: 20 NOT_EXECUTED | NOT_STARTED | — | — | — |
| B13 Reports and package experience | 9: 9 NOT_EXECUTED | NOT_STARTED | — | — | — |
| B14 Cloud foundation and actual worker host | 6: 6 NOT_EXECUTED | NOT_STARTED | — | — | — |
| B15 Real external integration | 9: 1 EXECUTED_LOCAL, 8 NOT_EXECUTED | IN_PROGRESS | — | — | — |
| B16 Security and restoration qualification | 61: 30 EXECUTED_LOCAL, 3 PARTIAL, 28 NOT_EXECUTED | IN_PROGRESS | — | — | — |
| B17 Integrated capacity and target qualification | 24: 16 EXECUTED_LOCAL, 8 NOT_EXECUTED | IN_PROGRESS | — | — | — |
| B18 Final candidate and independent release audit | 11: 1 EXECUTED_LOCAL, 10 NOT_EXECUTED | IN_PROGRESS | — | — | — |
| B19 Commercial production activation | 11: 11 NOT_EXECUTED | NOT_STARTED | — | — | — |
| B20 First customers and operating maturity | 4: 4 PLANNED_POST_B19 | NOT_STARTED | — | — | — |
| B21 Continuing operation and growth handoff | 4: 4 PLANNED_POST_B19 | NOT_STARTED | — | — | — |
<!-- ledger:table:end -->
