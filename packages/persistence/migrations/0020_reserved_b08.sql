-- RESERVED for package B08 (audit, approval and jobs): its migration of this number lands with B08 (docs/design/B08-audit-approval-jobs.md
-- D8-BASE-1: B08 owns 0019..0021, B11 0022..0024, B10 0025 onward).
--
-- The runner refuses a gap ("migration versions must be contiguous from 0001"), so the B11 branches, built on the B07+B09 candidate
-- without B08, carry this reservation to apply B11's own 0022..0024 under their real numbers (B11 design section 12, D-INT1-1;
-- the convention of B10's D10-BASE-1). It creates nothing. The integrator that brings B08 and B11 together deletes it when B08's
-- file of this number arrives: the runner's "duplicate migration version" makes a missed deletion loud. No persistent database
-- applies it (every suite builds a fresh cluster and no environment is deployed), so the checksum ledger never records the swap.
SELECT 1;
