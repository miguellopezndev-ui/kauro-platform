-- Migration 0042: the corporate owner reads an agency's first designation (package B10, lane 4 of the failure-matrix GAPs, CONV_RACE;
-- decision D10-GAP-19).
--
-- CMD050 TerminateSeller expires the claims of a terminated seller that its manifest does not list. A claim whose agency's first
-- qualifying purchase was already confirmed before the claim's end has accrued its rights (registry 17: "a termination event alone does not
-- cancel them"); its conversion is the COMMISSIONS consumer's, a moment behind the capture. The termination therefore leaves such a claim
-- ACCEPTED for the conversion, and to know it the owner's session reads the agency's recurrence and its first qualifying purchase, which
-- the policies of 0028 admit only inside the tenant's own agency. Read only, the acting corporate owner only, like the claims and the tail
-- entries it already reads (0029). Idempotent.

DROP POLICY IF EXISTS agency_recurrence_owner_read ON kauro.agency_recurrence;
CREATE POLICY agency_recurrence_owner_read ON kauro.agency_recurrence FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
DROP POLICY IF EXISTS qualifying_purchases_owner_read ON kauro.qualifying_purchases;
CREATE POLICY qualifying_purchases_owner_read ON kauro.qualifying_purchases FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
