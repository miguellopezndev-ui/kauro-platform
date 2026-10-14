-- Migration 0087 (provisional; renumbered at the batch): the owner tools of package B12 (lane L-OWNER; plan docs/design/B12-outreach-plan-cells.md §P).
--
-- 1. command_journal.operation: the explicit list of 0072 plus the two attribution producers (RecordClaimEvidence, PrepareAttributionAllocation),
--    still an explicit list (domain commercial/b12-operations.ts is its one source), never a pattern.
-- 2. security_events.action admitted only the upper-case token pattern of 0007, so the ALLOW fact a B12 route commits with its effect (its
--    action is the journaled operation name, e.g. ChangePayoutDestination) was a check violation and rolled the effect back. The action now
--    also admits exactly the B12 operation names, by the same explicit list.
-- 3. The payout destination (TIER 1 money; 0029 seller_payout_destinations): the owner's verification records its own step-up
--    (verification_proof_ref, a proof of the verifier, learned once), the proof is fresh at the verification's instant, and both the seller's
--    change proof and the owner's verification proof are judged again at COMMIT against kauro.effect_now() (the 0040 shape, STEP_UP_EXPIRED
--    KC020): a proof that expired while the unit waited on the seller's transition lock commits nothing. The column stays nullable so a row a
--    fixture verified before this lane keeps its meaning; the VerifyPayoutDestination route always writes it.
-- The other producer tables (claim_evidence, attribution_allocations, allocation_shares, corporate_roles, service_agreement_versions and
-- the seller records) keep their 0013/0028/0029 policies and grants unchanged: each already admits exactly the writer the owner tools use.
-- No SECURITY DEFINER, no new table. Idempotent.

ALTER TABLE kauro.command_journal DROP CONSTRAINT IF EXISTS command_journal_operation_check;
ALTER TABLE kauro.command_journal ADD CONSTRAINT command_journal_operation_check CHECK (
  operation ~ '^CMD[0-9]{3}$' OR operation = ANY (ARRAY[
    'PutOutreachContent', 'PublishSalesResource', 'RegisterSenderIdentity', 'VerifySenderIdentity', 'RecordSenderRevocation',
    'PrepareOutreachReview', 'RecordOutreachDiagnosis', 'RevokeOutreachAuthorization', 'WithdrawOutreachChannelPolicy',
    'RecordProspectSource', 'RecordProspectContact',
    'RegisterSellerCandidate', 'RecordSellerLegalReview', 'PrepareSellerAgreement', 'RecordAgreementSignature', 'RecordSellerAssessment',
    'RecordConfidentialityAcceptance', 'RecordSellerTaxDocument', 'ChangePayoutDestination', 'VerifyPayoutDestination',
    'PrepareServiceAssignment', 'RecordAssistanceAgreement', 'PrepareTerminationTerms', 'PrepareTerminationManifest',
    'RecordClaimEvidence', 'PrepareAttributionAllocation'
  ]::text[]));

ALTER TABLE kauro.security_events DROP CONSTRAINT IF EXISTS security_events_action_check;
ALTER TABLE kauro.security_events ADD CONSTRAINT security_events_action_check CHECK (
  action ~ '^[A-Z][A-Z0-9_]{2,63}$' OR action = ANY (ARRAY[
    'PutOutreachContent', 'PublishSalesResource', 'RegisterSenderIdentity', 'VerifySenderIdentity', 'RecordSenderRevocation',
    'PrepareOutreachReview', 'RecordOutreachDiagnosis', 'RevokeOutreachAuthorization', 'WithdrawOutreachChannelPolicy',
    'RecordProspectSource', 'RecordProspectContact',
    'RegisterSellerCandidate', 'RecordSellerLegalReview', 'PrepareSellerAgreement', 'RecordAgreementSignature', 'RecordSellerAssessment',
    'RecordConfidentialityAcceptance', 'RecordSellerTaxDocument', 'ChangePayoutDestination', 'VerifyPayoutDestination',
    'PrepareServiceAssignment', 'RecordAssistanceAgreement', 'PrepareTerminationTerms', 'PrepareTerminationManifest',
    'RecordClaimEvidence', 'PrepareAttributionAllocation'
  ]::text[]));

-- --- the owner's verification proof ---------------------------------------------------------------------------------------------------
ALTER TABLE kauro.seller_payout_destinations ADD COLUMN IF NOT EXISTS verification_proof_ref uuid;
ALTER TABLE kauro.seller_payout_destinations DROP CONSTRAINT IF EXISTS seller_payout_destinations_verification_proof_fk;
ALTER TABLE kauro.seller_payout_destinations ADD CONSTRAINT seller_payout_destinations_verification_proof_fk
  FOREIGN KEY (verified_by_user_id, verification_proof_ref) REFERENCES kauro.assurance_proofs (user_id, proof_id);
-- a proof is recorded only with the verification it authorized
ALTER TABLE kauro.seller_payout_destinations DROP CONSTRAINT IF EXISTS seller_payout_destinations_verification_proof_record;
ALTER TABLE kauro.seller_payout_destinations ADD CONSTRAINT seller_payout_destinations_verification_proof_record
  CHECK (verification_proof_ref IS NULL OR verified_at IS NOT NULL);
GRANT UPDATE (verification_proof_ref) ON kauro.seller_payout_destinations TO kauro_app;

DROP TRIGGER IF EXISTS seller_payout_destinations_proof_learned_once ON kauro.seller_payout_destinations;
CREATE TRIGGER seller_payout_destinations_proof_learned_once BEFORE UPDATE ON kauro.seller_payout_destinations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('verification_proof_ref');

-- destination_verified with a recorded proof: the proof is the verifier's own STEP_UP, fresh at the effect instant of the write (named check
-- violation seller_payout_destinations_verification, 23514, like 0029's edge).
CREATE OR REPLACE FUNCTION kauro.seller_payout_destinations_verification_proof() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.verification_proof_ref IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM kauro.assurance_proofs p
     WHERE p.user_id = NEW.verified_by_user_id AND p.proof_id = NEW.verification_proof_ref AND p.kind = 'STEP_UP'
       AND p.issued_at <= kauro.server_now() AND p.expires_at > kauro.effect_now()
  ) THEN
    RAISE EXCEPTION 'DESTINATION_VERIFICATION: the step-up recorded by the verification of destination % of seller % is not the verifier''s fresh proof', OLD.destination_version, OLD.seller_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'seller_payout_destinations_verification', SCHEMA = 'kauro', TABLE = 'seller_payout_destinations';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS seller_payout_destinations_verification_proof ON kauro.seller_payout_destinations;
CREATE TRIGGER seller_payout_destinations_verification_proof BEFORE UPDATE OF state, verification_proof_ref ON kauro.seller_payout_destinations
  FOR EACH ROW WHEN (NEW.verification_proof_ref IS DISTINCT FROM OLD.verification_proof_ref) EXECUTE FUNCTION kauro.seller_payout_destinations_verification_proof();

-- the 0040 shape: the step-up of a change born in this transaction, and of a verification taken in it, is unexpired at COMMIT
CREATE OR REPLACE FUNCTION kauro.seller_payout_destinations_step_up_at_commit() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  who uuid;
  proof uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT d.changed_by_user_id, d.change_proof_ref INTO who, proof FROM kauro.seller_payout_destinations d WHERE d.destination_id = NEW.destination_id;
  ELSE
    SELECT d.verified_by_user_id, d.verification_proof_ref INTO who, proof FROM kauro.seller_payout_destinations d WHERE d.destination_id = NEW.destination_id AND d.state = 'VERIFIED';
  END IF;
  IF proof IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kauro.assurance_proofs a WHERE a.user_id = who AND a.proof_id = proof AND a.kind = 'STEP_UP' AND a.expires_at > kauro.effect_now()) THEN
    RAISE EXCEPTION 'STEP_UP_EXPIRED: the step-up of a payout destination % expired before the COMMIT', lower(TG_OP) USING ERRCODE = 'KC020';
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS seller_payout_destinations_change_step_up_at_commit ON kauro.seller_payout_destinations;
CREATE CONSTRAINT TRIGGER seller_payout_destinations_change_step_up_at_commit AFTER INSERT ON kauro.seller_payout_destinations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.change_proof_ref IS NOT NULL) EXECUTE FUNCTION kauro.seller_payout_destinations_step_up_at_commit();
DROP TRIGGER IF EXISTS seller_payout_destinations_verify_step_up_at_commit ON kauro.seller_payout_destinations;
CREATE CONSTRAINT TRIGGER seller_payout_destinations_verify_step_up_at_commit AFTER UPDATE OF state ON kauro.seller_payout_destinations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state = 'VERIFIED' AND OLD.state IS DISTINCT FROM 'VERIFIED' AND NEW.verification_proof_ref IS NOT NULL)
  EXECUTE FUNCTION kauro.seller_payout_destinations_step_up_at_commit();
