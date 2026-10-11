# PV1 L-ROUTE r2: red-before evidence (adversary r2, minors ADV-PV1R-12, 13, 4/6, 1 nit)

Base abd5555 (product), tests of the r2 commit. Windows, `tsc` build, `node --test dist/test/ach-route-cells.test.js`.

| Item | Cell | Red state | Failing assertion |
|---|---|---|---|
| ADV-PV1R-12 | `ADV-PV1R-12 DENY ACH-M-I3-REVOCATION (PARTIALLY_RECEIVED)` | instructions.ts as on abd5555 (PARTIALLY_RECEIVED in the open set); whole file 64 tests, 62 pass, 2 fail | `no instructions (and no full amount) for a partially received order` (read answered 200 with the full amount) |
| ADV-PV1R-1 nit | `ADV-PV1R-1 RACE ACH-M-I1-RACE` | pin of the exact answer, first run with a deliberately wrong pin | `the issuance behind it is refused exactly AGENCY_NOT_ACTIVE: close first: closure 200 SUCCESS -, issuance 409 PRECONDITION_FAILED AGENCY_NOT_ACTIVE` (the product answer is `409 PRECONDITION_FAILED AGENCY_NOT_ACTIVE`; the pin now equals it and is green) |
| ADV-PV1R-13 | `ADV-PV1R-10 DENY RLS` | scratch statement inside the run: `GRANT SELECT (created_by) ON kauro.bank_route_versions TO kauro_app` (restored; uncommitted) | `participant: bank_route_versions.created_by::text is denied (got [{"v":"95087560-74b7-5da1-a299-66affa3eecf7"}])` |
| ADV-PV1R-6 expiry | `ADV-PV1R-6 DENY ACH-M-I3-EXPIRY (session)` | instructions.ts with the `stillAuthenticated` check disabled (probe, restored) | `the held read is refused like a read after the expiry` (the revocation cell fails the same way) |
| ADV-PV1R-14 | `ADV-PV1R-7 ... R1-EXPIRY` | robustness only; no red state (setup allowance 20 s, harness-precondition message) | n/a |
