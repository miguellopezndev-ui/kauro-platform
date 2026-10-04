-- Migration 0032: the claim conflict review's read (package B10, mandate B10-COMMANDS-PROSPECTS; decision D10-CLAIM-2).
--
-- CMD046 writes a claim DISPUTED, in the transaction that submits it, when another seller's claim on the prospect is live or an accepted
-- claim stands on its organization (17 "Claim validity and conflicts"; D10-CLAIM-1). The review is made in the submitting seller's own
-- session, which 0029 let read only the seller's own claims — so it could never see the claim it must be reviewed against. This adds
-- exactly one read: the claims on a prospect the session can already read. A prospect is readable by the seller that registered or owns
-- it (prospects_seller_read) and by the corporate owner; an agency member's session reads no prospect, so it reads no claim through this
-- policy either. No function, no SECURITY DEFINER (08 "Database isolation"), no write and no new grant: kauro_app already holds SELECT on
-- the table, and every other row stays behind the policies of 0029. Customer history (an agency's order or purchase) is not a seller's
-- to read; it is judged by the owner at CMD047 (CLAIM_AFTER_FIRST_ORDER).
CREATE POLICY attribution_claims_prospect_reader_read ON kauro.attribution_claims FOR SELECT TO kauro_app
  USING (EXISTS (SELECT 1 FROM kauro.prospects p WHERE p.prospect_id = attribution_claims.prospect_id));
