-- Migration 0064 (provisional number; the coordinator renumbers at merge): what one platform model task stands for when the
-- Intelligence Core admits its dispatches (package B05 lane IJR; ADR-B05-IJR-1 K-1..K-4; tier 1, money idempotency).
--
-- R2 (contracts ModelTask/RequestJournal; 06 l.102-106, l.168, l.182; 07 l.45): a model task binds ONE outbound content (one minimized
-- request hash); a request row is one PHYSICAL attempt; the fence is the MODEL_TASK lease's ownership generation, not an attempt
-- identity; uniqueness closes races over ACTIVE attempts. The core's map: one IC request key (one prepared envelope) of one IC run is one
-- model task (model_tasks.core_run_id, core_request_key; unique per audit); each IC invocation (one reservation) is one request row
-- (request_journal_core_reservation_once, 0061); IC's next invocation of the same key by the same owner lands at the same fence.
--
-- K-1 0006's UNIQUE (task_id, fence) becomes the partial unique index request_journal_one_attempt_per_fence over rows without a core
--     admission (B06 rows unchanged: one attempt per fence).
-- K-2 request_journal_one_live_core_attempt: at most one RESERVED or DISPATCHING core row per task (06 l.104 one authorized concurrent
--     dispatch). UNCERTAIN, FAILED, CANCELLED, RESPONSE_STORED and CONSUMED rows do not block (IC's recovery rule, 06 l.182).
-- K-3 BEFORE INSERT request_journal_core_attempt (sorts before request_journal_reserves_grant, so it fires first) on a core row: the
--     task's MODEL_TASK lease row FOR UPDATE (re-entrant for the admission, which holds it from claim_lease), then the binding to its
--     model task (run, request key, request hash = minimized request hash; KA004 MODEL_TASK_BINDING) and the ceiling of three core
--     attempts per task (06 l.168: KA083 ATTEMPT_CEILING, constraint model_task_attempt_ceiling). No lease row: KA004.
-- K-4 the send edge (replacing 0061's function; trigger unchanged): for a core row, the task's other sent rows FOR SHARE in ascending
--     (reserved_at, request_id) before the fence checks; a RESPONSE_STORED or CONSUMED one refuses the edge KA007 STORED_RESPONSE_EXISTS
--     (D5-18 table row 1: nothing was sent).
-- Lock order (ADR §4): ADM createModelTask audit FOR SHARE -> claim_lease lease FOR UPDATE -> K-3 lease FOR UPDATE (held) -> audit FOR
-- SHARE -> grant FOR UPDATE. EDG audit FOR SHARE -> lease FOR SHARE -> own row -> K-4 siblings FOR SHARE. No new clock read.

-- --- 1. model_tasks: the core's run and request key ------------------------------------------------------------------------------------
ALTER TABLE kauro.model_tasks
  ADD COLUMN core_run_id uuid,
  ADD COLUMN core_request_key text CHECK (core_request_key IS NULL OR length(core_request_key) BETWEEN 1 AND 512);
ALTER TABLE kauro.model_tasks
  ADD CONSTRAINT model_tasks_core_request_shape CHECK ((core_run_id IS NULL) = (core_request_key IS NULL)),
  ADD CONSTRAINT model_tasks_one_per_core_request UNIQUE (audit_id, core_run_id, core_request_key);
-- the control plane plans the task (0023's column grant, widened by the two columns; runtime-boundary.json)
GRANT INSERT (core_run_id, core_request_key) ON kauro.model_tasks TO kauro_control;

-- --- 2. request_journal: one attempt per fence for B06 rows (K-1), one live core attempt per task (K-2) --------------------------------
ALTER TABLE kauro.request_journal DROP CONSTRAINT request_journal_task_id_fence_key;
CREATE UNIQUE INDEX request_journal_one_attempt_per_fence ON kauro.request_journal (task_id, fence) WHERE core_run_id IS NULL;
CREATE UNIQUE INDEX request_journal_one_live_core_attempt ON kauro.request_journal (task_id)
  WHERE core_run_id IS NOT NULL AND state IN ('RESERVED', 'DISPATCHING');

-- --- 3. a core attempt is its model task's (K-3) ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kauro.request_journal_core_attempt() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  m record;
  attempts integer;
BEGIN
  PERFORM 1 FROM kauro.leases l WHERE l.resource_kind = 'MODEL_TASK' AND l.resource_id = NEW.task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MODEL_TASK_BINDING: core attempt % of task % has no MODEL_TASK lease', NEW.request_id, NEW.task_id USING ERRCODE = 'KA004';
  END IF;
  SELECT m0.core_run_id, m0.core_request_key, m0.minimized_request_hash INTO m FROM kauro.model_tasks m0 WHERE m0.model_task_id = NEW.task_id;
  IF NOT FOUND OR m.core_run_id IS DISTINCT FROM NEW.core_run_id OR m.core_request_key IS DISTINCT FROM NEW.core_request_key
     OR m.minimized_request_hash IS DISTINCT FROM NEW.request_hash THEN
    RAISE EXCEPTION 'MODEL_TASK_BINDING: core attempt % names another run, request key or request hash than model task %', NEW.request_id, NEW.task_id USING ERRCODE = 'KA004';
  END IF;
  -- a later statement than the lease lock: its snapshot sees every attempt committed during the wait
  SELECT count(*) INTO attempts FROM kauro.request_journal r WHERE r.task_id = NEW.task_id AND r.core_run_id IS NOT NULL;
  IF attempts >= 3 THEN
    RAISE EXCEPTION 'ATTEMPT_CEILING: model task % already has % core attempts', NEW.task_id, attempts USING ERRCODE = 'KA083', CONSTRAINT = 'model_task_attempt_ceiling';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER request_journal_core_attempt BEFORE INSERT ON kauro.request_journal
  FOR EACH ROW WHEN (NEW.core_run_id IS NOT NULL) EXECUTE FUNCTION kauro.request_journal_core_attempt();

-- --- 4. the send edge (replaces 0061's function; trigger request_journal_model_task_send unchanged) -----------------------------------
-- As 0061 §5, plus K-4: for a core row, right after the audit share, the task's other sent rows FOR SHARE; a stored response refuses it.
CREATE OR REPLACE FUNCTION kauro.request_journal_model_task_send() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  m record;
  a record;
  g record;
  s record;
  is_task boolean;
  judged timestamptz;
BEGIN
  SELECT m0.agency_id, m0.audit_id, m0.grant_id, m0.interpretation_deadline_at INTO m FROM kauro.model_tasks m0 WHERE m0.model_task_id = OLD.task_id;
  is_task := FOUND;
  IF is_task THEN
    SELECT x.state, x.fence INTO a FROM kauro.audits x WHERE x.agency_id = m.agency_id AND x.audit_id = m.audit_id FOR SHARE;
    IF OLD.core_run_id IS NOT NULL THEN
      -- a row locked here waits for a storeResponse in flight and is re-read as it committed
      FOR s IN
        SELECT r.request_id, r.state FROM kauro.request_journal r
         WHERE r.task_id = OLD.task_id AND r.request_id <> OLD.request_id AND r.state IN ('DISPATCHING', 'UNCERTAIN', 'RESPONSE_STORED', 'CONSUMED')
         ORDER BY r.reserved_at, r.request_id FOR SHARE
      LOOP
        IF s.state IN ('RESPONSE_STORED', 'CONSUMED') THEN
          RAISE EXCEPTION 'STORED_RESPONSE_EXISTS: attempt % of model task % is not sent: attempt % stored its response', OLD.request_id, OLD.task_id, s.request_id USING ERRCODE = 'KA007';
        END IF;
      END LOOP;
    END IF;
    judged := kauro.effect_now();
    IF a.state IS DISTINCT FROM 'INTERPRETING' OR judged >= m.interpretation_deadline_at THEN
      RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % is % and sends nothing for model task %', m.audit_id, coalesce(a.state, 'not visible'), OLD.task_id USING ERRCODE = 'KA081';
    END IF;
    IF OLD.step_fence IS NULL OR OLD.step_fence IS DISTINCT FROM a.fence OR NOT EXISTS (
      SELECT 1 FROM kauro.audit_steps s0
       WHERE s0.agency_id = m.agency_id AND s0.audit_id = m.audit_id AND s0.fence = OLD.step_fence AND s0.kind = 'INTERPRET' AND s0.outcome IS NULL
    ) THEN
      RAISE EXCEPTION 'AUDIT_FENCE: attempt % of model task % was admitted by an INTERPRET step that is no longer current', OLD.request_id, OLD.task_id USING ERRCODE = 'KA080';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM kauro.leases l WHERE l.resource_kind = 'MODEL_TASK' AND l.resource_id = OLD.task_id AND l.fence = OLD.fence AND l.cost_authority_id = m.grant_id
    ) THEN
      RAISE EXCEPTION 'AUDIT_FENCE: attempt % of model task % is not the MODEL_TASK lease''s current fence', OLD.request_id, OLD.task_id USING ERRCODE = 'KA080';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM kauro.leases l WHERE l.resource_kind = 'MODEL_TASK' AND l.resource_id = OLD.task_id AND l.fence = OLD.fence AND l.expires_at > judged
    ) THEN
      RAISE EXCEPTION 'AUDIT_FENCE: the MODEL_TASK lease of attempt % ended before its send', OLD.request_id USING ERRCODE = 'KA080';
    END IF;
  END IF;
  judged := kauro.effect_now();
  SELECT c.grant_kind, c.expires_at, p.expires_at AS pool_expires_at INTO g
    FROM kauro.cost_grants c LEFT JOIN kauro.cost_grants p ON p.grant_id = c.pool_grant_id WHERE c.grant_id = OLD.cost_grant_id;
  IF g.grant_kind = 'AUDIT' THEN
    IF g.expires_at <= judged THEN
      RAISE EXCEPTION 'GRANT_EXPIRED: the grant of request % expired before its send', OLD.request_id USING ERRCODE = 'KA083', CONSTRAINT = 'grant_expired_at_dispatch';
    END IF;
    IF g.pool_expires_at IS NULL OR g.pool_expires_at <= judged THEN
      RAISE EXCEPTION 'POOL_EXPIRED: the pool funding request % expired before its send', OLD.request_id USING ERRCODE = 'KA083', CONSTRAINT = 'pool_expired_at_dispatch';
    END IF;
  ELSIF g.grant_kind = 'PLATFORM_MONTHLY' THEN
    IF g.expires_at <= judged THEN
      RAISE EXCEPTION 'POOL_EXPIRED: the pool funding request % expired before its send', OLD.request_id USING ERRCODE = 'KA083', CONSTRAINT = 'pool_expired_at_dispatch';
    END IF;
  END IF;
  PERFORM kauro.liability_gate_register(kauro.liability_gate_pool_of(OLD.cost_grant_id), 'KEY_SHARE');
  RETURN NEW;
END
$$;

-- SEC-DEPTH R17 (0060): PUBLIC holds EXECUTE on none of this migration's trigger functions
REVOKE EXECUTE ON FUNCTION kauro.request_journal_core_attempt() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kauro.request_journal_model_task_send() FROM PUBLIC;
