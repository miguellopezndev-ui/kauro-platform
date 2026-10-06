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
DROP TRIGGER IF EXISTS identities_assurance_transition_lock ON kauro.identities;
CREATE TRIGGER identities_assurance_transition_lock BEFORE UPDATE OF email_verified_at, mfa_enrolled_at ON kauro.identities
  FOR EACH ROW WHEN (OLD.email_verified_at IS DISTINCT FROM NEW.email_verified_at OR OLD.mfa_enrolled_at IS DISTINCT FROM NEW.mfa_enrolled_at)
  EXECUTE FUNCTION kauro.take_transition_lock('kauro.identities', 'user_id');
