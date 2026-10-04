-- Migration 0038: a payout's step-up is fresh at its write, not only at its transaction's start (package B10, Codex r1 finding B10G-R7;
-- decision D10-GAP-11).
--
-- CMD052 judged the owner's step-up once, at the start of its unit, and the database guards of the intent's birth and of the statement's
-- payout_approved edge compared the proof's expiry with kauro.server_now(), the transaction's start (transaction_timestamp()): a proof
-- that expired while the approval waited on the statement's row lock (or the cash, line or grant locks after it) still authorized the
-- payout. kauro.effect_now() is the server's instant of the statement being executed: kauro.server_now() plus the time the transaction
-- has run (clock_timestamp() - transaction_timestamp()), so in a deployment it is clock_timestamp() and on the labelled TEST CLOCK it keeps
-- the transaction's offset (D-CLOCK-1). The two guards compare the expiry with it; the recorded instants (authorized_at, approved_at) stay
-- the transaction's server instant. The application re-judges the freshness after its locks (D10-GAP-11). Idempotent.

CREATE OR REPLACE FUNCTION kauro.effect_now() RETURNS timestamptz
  LANGUAGE sql VOLATILE PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT kauro.server_now() + (clock_timestamp() - transaction_timestamp()) $$;

CREATE OR REPLACE FUNCTION kauro.payout_intents_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.seller_payout_destinations d
     WHERE d.destination_id = NEW.destination_id AND d.seller_id = NEW.seller_id AND d.destination_version = NEW.destination_version
       AND d.destination_digest = NEW.destination_digest AND d.state = 'VERIFIED'
  ) THEN
    RAISE EXCEPTION 'PAYEE_UNVERIFIED: the payee of a payout of statement % is not a VERIFIED destination version of its seller', NEW.statement_id USING ERRCODE = 'KC009';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kauro.commission_statements s WHERE s.statement_id = NEW.statement_id AND s.state IN ('ISSUED', 'APPROVED'))
     OR NEW.authorized_by_user_id IS DISTINCT FROM kauro.current_user_id()
     OR NOT EXISTS (
       SELECT 1 FROM kauro.assurance_proofs p
        WHERE p.user_id = NEW.authorized_by_user_id AND p.proof_id = NEW.authorization_proof_ref AND p.kind = 'STEP_UP'
          AND p.issued_at <= kauro.server_now() AND p.expires_at > kauro.effect_now()
     ) THEN
    RAISE EXCEPTION 'PAYOUT_AUTHORIZATION: a payout of statement % is authorized for an ISSUED statement by the session''s owner with a fresh step-up', NEW.statement_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payout_intents_authorization', SCHEMA = 'kauro', TABLE = 'payout_intents';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION kauro.commission_statements_edge() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  refused boolean := false;
BEGIN
  IF NEW.state = 'PAID' THEN
    IF NEW.paid_at IS DISTINCT FROM kauro.server_now() OR NOT EXISTS (
         SELECT 1 FROM kauro.payout_intents p WHERE p.statement_id = OLD.statement_id AND p.state = 'SETTLED' AND p.evidence_hash = NEW.payout_evidence_hash) THEN
      RAISE EXCEPTION 'PAYOUT_NOT_SETTLED: statement % is paid only with its SETTLED intent''s evidence', OLD.statement_id USING ERRCODE = 'KC010';
    END IF;
  ELSIF NEW.state = 'APPROVED' THEN
    refused := NEW.approved_by_user_id IS DISTINCT FROM kauro.current_user_id() OR NEW.approved_at IS DISTINCT FROM kauro.server_now()
      OR NOT EXISTS (
        SELECT 1 FROM kauro.assurance_proofs p
         WHERE p.user_id = NEW.approved_by_user_id AND p.proof_id = NEW.approval_proof_ref AND p.kind = 'STEP_UP'
           AND p.issued_at <= kauro.server_now() AND p.expires_at > kauro.effect_now());
  ELSIF OLD.state = 'DRAFT' AND NEW.state = 'ISSUED' THEN
    refused := NEW.issued_at IS DISTINCT FROM kauro.server_now();
  ELSIF OLD.state = 'APPROVED' AND NEW.state = 'ISSUED' THEN
    refused := NOT EXISTS (SELECT 1 FROM kauro.payout_intents p WHERE p.statement_id = OLD.statement_id AND p.state IN ('FAILED', 'RETURNED'))
      OR EXISTS (SELECT 1 FROM kauro.payout_intents p WHERE p.statement_id = OLD.statement_id AND p.state IN ('AUTHORIZED', 'SUBMITTED', 'UNCERTAIN', 'SETTLED'));
  ELSIF NEW.state = 'CORRECTED' THEN
    refused := NEW.corrected_at IS DISTINCT FROM kauro.server_now();
  END IF;
  IF refused THEN
    RAISE EXCEPTION 'STATEMENT_EDGE: statement % %->% does not meet its guard', OLD.statement_id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_statements_edge', SCHEMA = 'kauro', TABLE = 'commission_statements';
  END IF;
  RETURN NEW;
END
$$;
