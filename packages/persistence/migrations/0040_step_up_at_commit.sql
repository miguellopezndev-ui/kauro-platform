-- Migration 0040: a payout's step-up is fresh at its COMMIT (package B10, Codex r2 finding B10G-R7; decision D10-GAP-14).
--
-- 0038 compared the proof's expiry with kauro.effect_now() in the BEFORE triggers of the intent's birth and of payout_approved, so a proof
-- fresh at both writes could expire before the transaction committed and the payout still committed AUTHORIZED. Two constraint triggers,
-- INITIALLY DEFERRED, judge the proof again when the transaction commits, against kauro.effect_now() read then (the server's instant of the
-- COMMIT; the TEST CLOCK's transaction offset kept): an AUTHORIZED intent born in the transaction and an APPROVED edge taken in it each
-- need their step-up proof unexpired at COMMIT, else STEP_UP_EXPIRED (KC020, ASSURANCE_REQUIRED STEP_UP_STALE) and nothing commits.
-- Idempotent.

CREATE OR REPLACE FUNCTION kauro.payout_step_up_at_commit() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  who uuid;
  proof uuid;
BEGIN
  IF TG_TABLE_NAME = 'payout_intents' THEN
    SELECT p.authorized_by_user_id, p.authorization_proof_ref INTO who, proof FROM kauro.payout_intents p WHERE p.intent_id = NEW.intent_id AND p.state = 'AUTHORIZED';
  ELSE
    SELECT s.approved_by_user_id, s.approval_proof_ref INTO who, proof FROM kauro.commission_statements s WHERE s.statement_id = NEW.statement_id AND s.state = 'APPROVED';
  END IF;
  -- the row moved on in the same transaction (or is gone): its own guards decided it
  IF proof IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM kauro.assurance_proofs a
     WHERE a.user_id = who AND a.proof_id = proof AND a.kind = 'STEP_UP' AND a.expires_at > kauro.effect_now()
  ) THEN
    RAISE EXCEPTION 'STEP_UP_EXPIRED: the step-up authorizing the payout of % expired before the COMMIT', TG_TABLE_NAME USING ERRCODE = 'KC020';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS payout_intents_step_up_at_commit ON kauro.payout_intents;
CREATE CONSTRAINT TRIGGER payout_intents_step_up_at_commit AFTER INSERT ON kauro.payout_intents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state = 'AUTHORIZED') EXECUTE FUNCTION kauro.payout_step_up_at_commit();

DROP TRIGGER IF EXISTS commission_statements_step_up_at_commit ON kauro.commission_statements;
CREATE CONSTRAINT TRIGGER commission_statements_step_up_at_commit AFTER UPDATE OF state ON kauro.commission_statements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state = 'APPROVED' AND OLD.state IS DISTINCT FROM 'APPROVED') EXECUTE FUNCTION kauro.payout_step_up_at_commit();
