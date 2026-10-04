# Package acceptance records

Amendment A4 of the authority (edition KAURO-2026.09-R2, `C:\Projects\Kauro\authority\r2\amendments\A4_OPERATING_MODEL.md`)
defines package acceptance: (a) the case map gives every registry case its evidence class and test; (b) the full verify is
green on the exact commit on Windows, Linux and in CI; (c) an independent reviewer from another model provider (Codex) reviews
that exact commit against the registry cases and answers ACCEPT or ACCEPT_WITH_MINOR, the re-check covering only its findings;
(d) the commit is on `main`. Formal acceptance follows `registry/program.json` dependencies: a package whose conditions hold
but whose dependencies are not yet accepted is **REVIEW_ACCEPTED**.

Raw reviewer answers are in `reviews/` (`<package>-round<n>-<commit>.json`, schema `tools/review/review-schema.json` on the
operator host).

| Package | Cases | Status | Commit on main | Review rounds | CI | Waiting for |
|---|---|---|---|---|---|---|
| B06 Domain, database and authorization | 29: 18 EXECUTED_LOCAL, 11 PARTIAL (later packages named) | REVIEW_ACCEPTED | `4b33e26` | 2: REJECT `a7203f0` (2 blocking, 1 major) → ACCEPT `4b33e26` → re-confirmed on B08 `d9bbfd0` | run 36644790719 success | B05 → B02, B04 |
| B07 Upload, inspection and source lifecycle | 23: 11 EXECUTED_LOCAL, 12 PARTIAL (later packages named) | REVIEW_ACCEPTED | `4b33e26` | 6: REJECT `0f15636` (1 blocking, 2 major, 1 minor) → R1 partial `6b670e3`, `77d5fa6`, `09faf25` → ACCEPT `d23af32` → ACCEPT `4b33e26` → re-confirmed on B08 `d9bbfd0` | run 36644790719 success | B05 → B02, B04 |
| B09 Payments and fiscal workflow | 30: 7 EXECUTED_LOCAL, 23 PARTIAL (later packages named) | REVIEW_ACCEPTED | `4b33e26` | 4: REJECT `0f15636` (3 blocking, 2 major) → ACCEPT `6b670e3`, `d23af32`, `4b33e26` → re-confirmed on B08 `d9bbfd0` | run 36644790719 success | B05 → B02, B04 |
| B08 Audit, approval and processing authority | 15: 7 EXECUTED_LOCAL, 8 PARTIAL (later packages named) | REVIEW_ACCEPTED | `88cf29d` | 3: REJECT `f49ca76` (2 blocking, 2 major) → ACCEPT `d9bbfd0` → ACCEPT `88cf29d` (race tests made deterministic, no behaviour change) | run 36869471897 success | B07 → B06 → B05 → B02, B04 |
