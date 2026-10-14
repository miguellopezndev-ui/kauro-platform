-- Migration 0063 (provisional number; the coordinator renumbers at merge): prospects are agencies and companies (owner decision D-33,
-- 2026-10-13, which supersedes the agency-only prospecting of A3 3.7 and design decision D10-PROS-1's segment clause).
--
-- 0029 admitted only the AGENCY segment in kauro.prospect_source_evidence (constraint prospect_source_evidence_agency_segment), so a
-- seller could never register, claim or be attributed a company it sourced. The segment now admits AGENCY and COMPANY and nothing else:
-- an end client of an agency customer, a consumer or any other value stays refused by the database itself. Every other control of the
-- table is unchanged: the recorder's own row, the dated observation, the lawful basis, the source URL digest, one row per recorder and
-- hash, append-only grants and its row-level security (0029). Prospects, claims and attribution are segment-independent (one live
-- prospect per organization key, suppression by organization and contact key), so nothing else changes. Existing rows are all AGENCY,
-- so the new constraint validates against them.
ALTER TABLE kauro.prospect_source_evidence DROP CONSTRAINT prospect_source_evidence_agency_segment;
ALTER TABLE kauro.prospect_source_evidence ADD CONSTRAINT prospect_source_evidence_segment CHECK (segment IN ('AGENCY', 'COMPANY'));
