-- Migration 0076 (provisional number; the coordinator renumbers at merge) — B10, lane B10-CMD053-SETTLED-AT (template rule 15, the
-- effective instant after the last lock wait, at the database clock): CMD053 stamped settled_at (and failed_at, returned_at) with
-- kauro.server_now(), the transaction's start, although it writes them after waiting for the payout-cash basis lock (lockPayoutCash,
-- D10-GAP-1): a settlement queued behind a concurrent holder recorded an instant earlier than its effect, so the claimed-cash rule
-- "SETTLED until a bank observation strictly newer than its settlement" (commercial-statements.ts payoutCash) could release its cents
-- against an observation taken while the intent was still unsettled. The writer now stamps kauro.effect_now() read by the UPDATE after
-- the lock; 0031's deferred judge payout_intents_reconciled required the stamp to equal kauro.server_now() and now requires it within
-- this transaction: not before its start (kauro.server_now()) and not after the instant of the judgement at COMMIT (kauro.effect_now()).
-- Replaces kauro.payout_intents_reconciled() of 0031 (same signature, same triggers); idempotent.
CREATE OR REPLACE FUNCTION kauro.payout_intents_reconciled() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  intent record;
BEGIN
  SELECT p.intent_id, p.statement_id, p.state, p.evidence_hash, coalesce(p.settled_at, p.failed_at, p.returned_at) AS at INTO intent
    FROM kauro.payout_intents p WHERE p.intent_id = NEW.intent_id;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM kauro.commission_statements s WHERE s.statement_id = intent.statement_id AND s.state IN ('APPROVED', 'PAID', 'ISSUED') AND
                   (s.state <> 'ISSUED' OR intent.state IN ('FAILED', 'RETURNED'))) THEN
      RAISE EXCEPTION 'PAYOUT_AUTHORIZATION: the statement of intent % is approved with it', NEW.intent_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'payout_intents_authorization', SCHEMA = 'kauro', TABLE = 'payout_intents';
    END IF;
  ELSIF intent.state IN ('SETTLED', 'FAILED', 'RETURNED') AND (
          intent.at IS NULL OR intent.at < kauro.server_now() OR intent.at > kauro.effect_now() OR NOT EXISTS (
            SELECT 1 FROM kauro.payout_reconciliations r WHERE r.intent_id = NEW.intent_id AND r.evidence_kind = intent.state AND r.evidence_hash = intent.evidence_hash)) THEN
    RAISE EXCEPTION 'PAYOUT_RECONCILIATION: intent % is % only with its recorded matching evidence of that kind, at an instant of this transaction', NEW.intent_id, intent.state
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payout_intents_reconciled', SCHEMA = 'kauro', TABLE = 'payout_intents';
  END IF;
  RETURN NULL;
END
$$;

-- SEC-DEPTH R17 (0060): PUBLIC holds EXECUTE on none of this migration's trigger functions
REVOKE EXECUTE ON FUNCTION kauro.payout_intents_reconciled() FROM PUBLIC;
