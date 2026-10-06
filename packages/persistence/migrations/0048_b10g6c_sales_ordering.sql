-- Migration 0045: sales and attribution changes ordered with the commands that rest on them (package B10, failure-matrix lane 6c).
--
-- Each part closes one RED cell of docs/design/B10-matrix-status/6c.md with a lock the racing command already takes (design §10, D10-TX-1):
--   * TAIL_PURCHASE_RACE: a termination's tail entry (KC011) reads the agency's purchases under the shared half of the agency's recurrence
--     lock, whose exclusive half the first-purchase designation takes (0028): the two serialize in both orders.
-- Idempotent.

-- --- TAIL_PURCHASE_RACE: KC011 under the agency's recurrence lock ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kauro.termination_tail_entries_enumerated() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  -- the reader's half of the agency's recurrence lock (as CreateQuote, D10-REC-2): a designation in flight commits first and its purchase
  -- is seen below; a designation arriving later waits for this termination's COMMIT
  PERFORM kauro.await_transition('kauro.agency_recurrence', NEW.agency_id::text);
  IF NOT EXISTS (
       SELECT 1 FROM kauro.seller_terminations t JOIN kauro.termination_manifests m ON m.manifest_id = t.manifest_id
        WHERE t.termination_id = NEW.termination_id AND t.seller_id = NEW.seller_id AND NEW.claim_id = ANY (m.claim_ids)
     )
     OR NOT EXISTS (
       SELECT 1 FROM kauro.attribution_claims c
        WHERE c.claim_id = NEW.claim_id AND c.seller_id = NEW.seller_id AND c.agency_id = NEW.agency_id AND c.state = 'ACCEPTED' AND c.expires_at > NEW.effective_at
     )
     OR EXISTS (SELECT 1 FROM kauro.qualifying_purchases q WHERE q.agency_id = NEW.agency_id) THEN
    RAISE EXCEPTION 'TAIL_NOT_ENUMERATED: claim % is no enumerated, accepted and unexpired opportunity of an agency without a purchase', NEW.claim_id USING ERRCODE = 'KC011';
  END IF;
  RETURN NEW;
END
$$;

-- --- SELLER_IDENT_RACE: the identity's transition lock on its assurance facts ------------------------------------------------------------
-- 0002 takes the writer's half of kauro.identities on a state change only; a verified e-mail or an MFA enrolment withdrawn (the identity's
-- own sync, identities_self_sync) is as much a withdrawal of the authority an activation rests on (17 "Activation prerequisites", KC005):
-- the activation's reader half (activationFacts, sellers_activation_guard) and the withdrawal now serialize in both orders.
-- Only a withdrawal (a fact going from set to NULL) takes it: the sync refreshes the facts while its own command holds the identity's
-- reader half (TenancyRepository.syncOwn), so a refresh that took the writer's half would deadlock two concurrent requests of one person
-- (cmd001 RACE, 40P01); a refresh to another set value withdraws nothing an activation rests on.
DROP TRIGGER IF EXISTS identities_assurance_transition_lock ON kauro.identities;
CREATE TRIGGER identities_assurance_transition_lock BEFORE UPDATE OF email_verified_at, mfa_enrolled_at ON kauro.identities
  FOR EACH ROW WHEN ((OLD.email_verified_at IS NOT NULL AND NEW.email_verified_at IS NULL) OR (OLD.mfa_enrolled_at IS NOT NULL AND NEW.mfa_enrolled_at IS NULL))
  EXECUTE FUNCTION kauro.take_transition_lock('kauro.identities', 'user_id');

-- --- AGREEMENT_EXP, CORP_REV: the seller's agreement changes under the seller's transition lock ------------------------------------------
-- 0029 takes the writer's half of kauro.sellers on a state change only. The agreement a seller acts under is read under the seller's reader
-- half by every command resting on it (the seller's authorizer for ClaimProspect, D10-CTX-1) and under the writer's half by ActivateSeller
-- (lockSeller): a new version put in force (sellers.agreement_id) and the owner's withdrawal or re-dating of an agreement
-- (seller_agreements.starts_at/ends_at) take the same writer's half, so a claim or an activation and the agreement change commit one after
-- the other in both orders, never across each other.
DROP TRIGGER IF EXISTS sellers_agreement_transition_lock ON kauro.sellers;
CREATE TRIGGER sellers_agreement_transition_lock BEFORE UPDATE OF agreement_id ON kauro.sellers
  FOR EACH ROW WHEN (OLD.agreement_id IS DISTINCT FROM NEW.agreement_id) EXECUTE FUNCTION kauro.take_transition_lock('kauro.sellers', 'seller_id');
DROP TRIGGER IF EXISTS seller_agreements_transition_lock ON kauro.seller_agreements;
CREATE TRIGGER seller_agreements_transition_lock BEFORE UPDATE OF starts_at, ends_at ON kauro.seller_agreements
  FOR EACH ROW WHEN (OLD.starts_at IS DISTINCT FROM NEW.starts_at OR OLD.ends_at IS DISTINCT FROM NEW.ends_at)
  EXECUTE FUNCTION kauro.take_transition_lock('kauro.sellers', 'seller_id');

-- --- CMD_EXP_ASSURE: the activation's step-up judged again at COMMIT (as 0040 for payouts) --------------------------------------------
-- sellers_activation_guard (0029) judges the owner's proof in a BEFORE trigger only, so a proof fresh at the write could expire before the
-- transaction committed and the seller still commit ACTIVE. A constraint trigger, INITIALLY DEFERRED, judges it again when the transaction
-- commits, against kauro.effect_now() read then: the first activation (CANDIDATE -> ACTIVE) needs its step-up proof unexpired at COMMIT,
-- else STEP_UP_EXPIRED (KC020, ASSURANCE_REQUIRED STEP_UP_STALE) and nothing commits.
CREATE OR REPLACE FUNCTION kauro.seller_activation_step_up_at_commit() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  who uuid;
  proof uuid;
BEGIN
  SELECT s.activated_by_user_id, s.activation_proof_ref INTO who, proof FROM kauro.sellers s WHERE s.seller_id = NEW.seller_id AND s.state = 'ACTIVE';
  -- the seller moved on in the same transaction: its own guards decided it
  IF proof IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM kauro.assurance_proofs a
     WHERE a.user_id = who AND a.proof_id = proof AND a.kind = 'STEP_UP' AND a.expires_at > kauro.effect_now()
  ) THEN
    RAISE EXCEPTION 'STEP_UP_EXPIRED: the step-up activating seller % expired before the COMMIT', NEW.seller_id USING ERRCODE = 'KC020';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS sellers_activation_step_up_at_commit ON kauro.sellers;
CREATE CONSTRAINT TRIGGER sellers_activation_step_up_at_commit AFTER UPDATE OF state ON kauro.sellers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state = 'ACTIVE' AND OLD.state = 'CANDIDATE') EXECUTE FUNCTION kauro.seller_activation_step_up_at_commit();
