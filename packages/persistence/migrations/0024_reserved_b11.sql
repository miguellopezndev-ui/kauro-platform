-- 0024 — a reservation of package B11's migration number (docs/design/B10-commercial-domain.md §9, decision D10-BASE-1).
--
-- The runner applies a contiguous sequence from 0001 and refuses a gap ("migration versions must be contiguous from 0001"). On main
-- (f87a4cb, 0001..0020) the numbers 0021..0023 are B08's and 0024..0027 B11's; neither package is on the base of B10, whose own
-- migrations start at 0028. This file holds B11's number so the runner reaches 0028 before B11 lands. It creates nothing. The
-- cross-package integrator deletes it when B11's own 0024 arrives (a missed deletion is loud: "duplicate migration version"). No
-- persistent database applies it: every suite builds a fresh cluster and no environment is deployed, so the checksum ledger never
-- sees the swap.
SELECT 1;
