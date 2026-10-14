-- Migration 0066: the audit's and the grant's authority deadlines judged at COMMIT (package B05 L3t, D5-20; r5 D17, r7 ADV-11;
-- provisional number, renumbered at merge).
--
-- 0023's BEFORE triggers compare their deadlines and expiries with kauro.server_now(), the transaction's start: a statement whose lock
-- wait (or whose transaction) crosses the instant still passes, and the effect commits after its authority ended (06 "Cancellation and
-- deadlines": "The finalizer repeats the check atomically with its state change"; template rules 15 and 16). As 0040 did for B10, one
-- DEFERRABLE INITIALLY DEFERRED constraint trigger per gated event re-judges the same columns against kauro.effect_now() read when the
-- transaction commits (the server's instant of the COMMIT; the TEST CLOCK's transaction offset kept, 0038). The BEFORE checks stay as
-- the early refusals. Each function reads its rows without a lock and writes nothing (CK2: only the liability gate's two deferred
-- functions lock); a row that moved to an end state in the same transaction was decided by its own guards. The sites (0023 line):
--   cost_grants  :145 birth, :169 PREPARED -> AUTHORIZED, :178 EXHAUSTED -> AUTHORIZED, :218 the pool's hold of an AUDIT grant
--                -> cost_grants_authority_at_commit (KA083 NO_FUNDED_GRANT)
--   audits       :435 birth on an unexpired grant (KA083), :491 every orchestration edge and :635 DRAFT_READY before the absolute
--                deadline (KA081) -> audits_authority_at_commit
--   audit_steps  :584 a claim, :598 a result before the absolute deadline -> audit_steps_authority_at_commit (KA081)
--   model_tasks  :693 a task planned before the interpretation deadline -> model_tasks_authority_at_commit (KA081)
-- :183 and :486 (an EXPIRED edge never early) are monotone: an early instant only refuses; they stay BEFORE checks. Idempotent.

CREATE OR REPLACE FUNCTION kauro.cost_grants_authority_at_commit() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  g record;
  judged timestamptz;
BEGIN
  SELECT c.grant_kind, c.state, c.expires_at, p.expires_at AS pool_expires_at INTO g
    FROM kauro.cost_grants c LEFT JOIN kauro.cost_grants p ON p.grant_id = c.pool_grant_id WHERE c.grant_id = NEW.grant_id;
  IF NOT FOUND OR g.state NOT IN ('PREPARED', 'AUTHORIZED', 'EXHAUSTED') THEN
    RETURN NULL;
  END IF;
  -- an authorization judged by an EXHAUSTED grant that is no longer AUTHORIZED at COMMIT granted nothing
  IF TG_OP = 'UPDATE' AND g.state <> 'AUTHORIZED' THEN
    RETURN NULL;
  END IF;
  judged := kauro.effect_now();
  IF g.expires_at <= judged THEN
    RAISE EXCEPTION 'NO_FUNDED_GRANT: grant % expired before the COMMIT of its %', NEW.grant_id, CASE TG_OP WHEN 'INSERT' THEN 'birth' ELSE 'authorization' END
      USING ERRCODE = 'KA083';
  END IF;
  IF g.grant_kind = 'AUDIT' AND (g.pool_expires_at IS NULL OR g.pool_expires_at <= judged) THEN
    RAISE EXCEPTION 'NO_FUNDED_GRANT: the pool of grant % expired before the COMMIT of its %', NEW.grant_id, CASE TG_OP WHEN 'INSERT' THEN 'carve' ELSE 'hold' END
      USING ERRCODE = 'KA083';
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS cost_grants_birth_at_commit ON kauro.cost_grants;
CREATE CONSTRAINT TRIGGER cost_grants_birth_at_commit AFTER INSERT ON kauro.cost_grants
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.cost_grants_authority_at_commit();
DROP TRIGGER IF EXISTS cost_grants_authorized_at_commit ON kauro.cost_grants;
CREATE CONSTRAINT TRIGGER cost_grants_authorized_at_commit AFTER UPDATE OF state ON kauro.cost_grants
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state = 'AUTHORIZED' AND OLD.state IN ('PREPARED', 'EXHAUSTED'))
  EXECUTE FUNCTION kauro.cost_grants_authority_at_commit();

CREATE OR REPLACE FUNCTION kauro.audits_authority_at_commit() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  a record;
  grant_expires timestamptz;
  judged timestamptz;
BEGIN
  SELECT x.state, x.absolute_deadline_at, x.grant_id INTO a FROM kauro.audits x WHERE x.agency_id = NEW.agency_id AND x.audit_id = NEW.audit_id;
  IF NOT FOUND OR a.state IN ('CANCELLED', 'EXPIRED') THEN
    RETURN NULL;
  END IF;
  judged := kauro.effect_now();
  IF TG_OP = 'INSERT' THEN
    SELECT c.expires_at INTO grant_expires FROM kauro.cost_grants c WHERE c.grant_id = a.grant_id;
    IF grant_expires IS NULL OR grant_expires <= judged THEN
      RAISE EXCEPTION 'NO_FUNDED_GRANT: the grant of audit % expired before the COMMIT of its birth', NEW.audit_id USING ERRCODE = 'KA083';
    END IF;
    RETURN NULL;
  END IF;
  IF judged >= a.absolute_deadline_at THEN
    RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % reached its absolute deadline before the COMMIT of its % edge', NEW.audit_id, NEW.state USING ERRCODE = 'KA081';
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS audits_birth_at_commit ON kauro.audits;
CREATE CONSTRAINT TRIGGER audits_birth_at_commit AFTER INSERT ON kauro.audits
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.audits_authority_at_commit();
DROP TRIGGER IF EXISTS audits_edge_at_commit ON kauro.audits;
CREATE CONSTRAINT TRIGGER audits_edge_at_commit AFTER UPDATE OF state ON kauro.audits
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state NOT IN ('CANCELLED', 'EXPIRED'))
  EXECUTE FUNCTION kauro.audits_authority_at_commit();

CREATE OR REPLACE FUNCTION kauro.audit_steps_authority_at_commit() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  a record;
BEGIN
  SELECT x.state, x.absolute_deadline_at INTO a FROM kauro.audits x WHERE x.agency_id = NEW.agency_id AND x.audit_id = NEW.audit_id;
  IF NOT FOUND OR a.state IN ('CANCELLED', 'EXPIRED') THEN
    RETURN NULL;
  END IF;
  IF kauro.effect_now() >= a.absolute_deadline_at THEN
    RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % reached its absolute deadline before the COMMIT of its % step''s %', NEW.audit_id, NEW.kind, CASE TG_OP WHEN 'INSERT' THEN 'claim' ELSE 'result' END
      USING ERRCODE = 'KA081';
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS audit_steps_claim_at_commit ON kauro.audit_steps;
CREATE CONSTRAINT TRIGGER audit_steps_claim_at_commit AFTER INSERT ON kauro.audit_steps
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.audit_steps_authority_at_commit();
DROP TRIGGER IF EXISTS audit_steps_result_at_commit ON kauro.audit_steps;
CREATE CONSTRAINT TRIGGER audit_steps_result_at_commit AFTER UPDATE ON kauro.audit_steps
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.outcome IS DISTINCT FROM NEW.outcome OR OLD.evidence_hash IS DISTINCT FROM NEW.evidence_hash OR OLD.evidence_class IS DISTINCT FROM NEW.evidence_class)
  EXECUTE FUNCTION kauro.audit_steps_authority_at_commit();

CREATE OR REPLACE FUNCTION kauro.model_tasks_authority_at_commit() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  -- the task's interpretation deadline is its audit's, stamped at birth and immutable (model_tasks_append_only)
  IF kauro.effect_now() >= NEW.interpretation_deadline_at THEN
    RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % reached its interpretation deadline before the COMMIT of model task %', NEW.audit_id, NEW.model_task_id USING ERRCODE = 'KA081';
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS model_tasks_planned_at_commit ON kauro.model_tasks;
CREATE CONSTRAINT TRIGGER model_tasks_planned_at_commit AFTER INSERT ON kauro.model_tasks
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.model_tasks_authority_at_commit();

-- SEC-DEPTH R17 (0060): a trigger fires without EXECUTE, and a direct call is not a route
REVOKE EXECUTE ON FUNCTION kauro.cost_grants_authority_at_commit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kauro.audits_authority_at_commit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kauro.audit_steps_authority_at_commit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kauro.model_tasks_authority_at_commit() FROM PUBLIC;
