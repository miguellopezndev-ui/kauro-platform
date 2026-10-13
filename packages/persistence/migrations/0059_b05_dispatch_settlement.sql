-- Migration 0059 (provisional number; the coordinator renumbers at merge): the durable send and the settlement of a model dispatch
-- (package B05 lane L3m; docs/design/B05-cores.md D5-11, D5-18, D5-19, D5-19b; tier 1).
--
-- 1. request_journal learns what the Intelligence Core admitted (core run, reservation, request key, the exact maximum charge in
--    micros, reserved as ceil(max / 10,000) cents), the settlement it was told (AMBIGUOUS | COMMITTED | RELEASED, the charge in micros,
--    whether the usage was known, its hash), the INTERPRET step fence it was admitted under, and the non-acceptance evidence a provider or
--    the transport gave for a request that left DISPATCHING without being accepted (one of three literals, written only on
--    DISPATCHING -> FAILED with usage UNKNOWN, immutable).
-- 2. kauro.dispatch_liabilities: a charge above the admitted maximum is never spent from a grant (cost_grants_within_ceiling holds); the
--    excess in micros is an OPEN liability of the pool, cleared only by an owner/ops act (B12).
-- 3. kauro.pool_liability_gates: one row per PLATFORM_MONTHLY pool (birth trigger; backfilled here). Every reservation and every
--    DISPATCHING edge takes its pool's gate FOR KEY SHARE at COMMIT, a liability FOR UPDATE, in the first statement of one deferred
--    function, and every time judgement of that function follows the gate wait (statement order is the specification). After a
--    liability commits no reservation and no DISPATCHING edge on its pool commits.
-- 4. The reservation trigger (replacing 0023's): audit FOR SHARE -> funding grant FOR UPDATE -> the same-grant upstreams FOR SHARE in
--    ascending (reserved_at, request_id), a cross-grant upstream refused KA009 before any upstream lock; the step fence; an early
--    pool_liability_open refusal; the gate registration (pool by an explicit branch on the grant's kind, mode KEY_SHARE).
-- 5. The send trigger (replacing 0023's): audit INTERPRETING, step fence = audits.fence with an open INTERPRET step, lease fence, then
--    against kauro.effect_now() the interpretation deadline, the lease's expiry, the funding grant's and its pool's expiry (KA083
--    grant_expired_at_dispatch / pool_expired_at_dispatch); the gate registration. markDispatching takes the audit and lease shares in
--    statements before its UPDATE (request-journal.ts).
-- 6. Edges: into DISPATCHING only from RESERVED (KA007); into RESPONSE_STORED only from DISPATCHING or UNCERTAIN (KA007).
-- Constraint names raised here (mapped in sqlstate.ts AUDIT_CONSTRAINT_FAILURES): pool_liability_open, grant_expired_at_dispatch,
-- pool_expired_at_dispatch (KA083 -> BUDGET_EXHAUSTED NO_FUNDED_GRANT), pool_liability_gate_absent (KA006 -> INTEGRITY_FAILURE
-- LIFECYCLE_BINDING_MISSING), pool_liability_gate_scope (KA006 -> INTEGRITY_FAILURE COMMITMENT_ISOLATION).

-- --- 1. request_journal columns -------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.request_journal
  ADD COLUMN core_run_id uuid,
  ADD COLUMN core_reservation_id text CHECK (core_reservation_id IS NULL OR length(core_reservation_id) BETWEEN 1 AND 256),
  ADD COLUMN core_request_key text CHECK (core_request_key IS NULL OR length(core_request_key) BETWEEN 1 AND 512),
  ADD COLUMN max_charge_micros bigint CHECK (max_charge_micros IS NULL OR max_charge_micros > 0),
  ADD COLUMN settlement_state text CHECK (settlement_state IS NULL OR settlement_state IN ('AMBIGUOUS', 'COMMITTED', 'RELEASED')),
  ADD COLUMN charge_micros bigint CHECK (charge_micros IS NULL OR charge_micros >= 0),
  ADD COLUMN usage_known boolean,
  ADD COLUMN settlement_hash text CHECK (settlement_hash IS NULL OR kauro.is_sha256_hex(settlement_hash)),
  ADD COLUMN step_fence bigint CHECK (step_fence IS NULL OR step_fence >= 1),
  ADD COLUMN non_acceptance_evidence text CHECK (non_acceptance_evidence IS NULL OR non_acceptance_evidence IN (
    'PROVIDER_DOCUMENTED_NON_ACCEPTANCE:ThrottlingException', 'PROVIDER_DOCUMENTED_NON_ACCEPTANCE:RESOURCE_EXHAUSTED', 'TRANSPORT_NEVER_SENT'));
ALTER TABLE kauro.request_journal
  -- an admission of the core names its run, reservation, request key and exact maximum together, and reserves ceil(max / 10,000) cents
  ADD CONSTRAINT request_journal_core_admission CHECK (
    (core_run_id IS NULL AND core_reservation_id IS NULL AND core_request_key IS NULL AND max_charge_micros IS NULL)
    OR (core_run_id IS NOT NULL AND core_reservation_id IS NOT NULL AND core_request_key IS NOT NULL AND max_charge_micros IS NOT NULL
        AND reserved_cents = (max_charge_micros + 9999) / 10000)),
  ADD CONSTRAINT request_journal_core_reservation_once UNIQUE (core_run_id, core_reservation_id),
  -- a settlement is a core's, and carries its charge, its usage flag and its hash
  ADD CONSTRAINT request_journal_settlement_shape CHECK (
    settlement_state IS NULL OR (core_run_id IS NOT NULL AND charge_micros IS NOT NULL AND usage_known IS NOT NULL AND settlement_hash IS NOT NULL)),
  ADD CONSTRAINT request_journal_evidence_on_failed CHECK (non_acceptance_evidence IS NULL OR state = 'FAILED');

CREATE TRIGGER request_journal_core_immutable BEFORE UPDATE ON kauro.request_journal
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('core_run_id,core_reservation_id,core_request_key,max_charge_micros,step_fence');

-- A COMMITTED or RELEASED settlement is final: its state, charge, usage flag and hash never change (an AMBIGUOUS one may be settled).
CREATE OR REPLACE FUNCTION kauro.request_journal_settlement_final() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.settlement_state IN ('COMMITTED', 'RELEASED') AND (NEW.settlement_state IS DISTINCT FROM OLD.settlement_state
     OR NEW.charge_micros IS DISTINCT FROM OLD.charge_micros OR NEW.usage_known IS DISTINCT FROM OLD.usage_known
     OR NEW.settlement_hash IS DISTINCT FROM OLD.settlement_hash) THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: request % is settled %', OLD.request_id, OLD.settlement_state USING ERRCODE = 'KA004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER request_journal_settlement_final BEFORE UPDATE ON kauro.request_journal
  FOR EACH ROW EXECUTE FUNCTION kauro.request_journal_settlement_final();

-- The non-acceptance evidence: written once, only on DISPATCHING -> FAILED while the usage is UNKNOWN (D5-18 rows 5-6).
CREATE OR REPLACE FUNCTION kauro.request_journal_non_acceptance_evidence() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.non_acceptance_evidence IS DISTINCT FROM OLD.non_acceptance_evidence THEN
    IF OLD.non_acceptance_evidence IS NOT NULL THEN
      RAISE EXCEPTION 'IMMUTABLE_COLUMN: the non-acceptance evidence of request % is recorded', OLD.request_id USING ERRCODE = 'KA004';
    END IF;
    IF NOT (OLD.state = 'DISPATCHING' AND NEW.state = 'FAILED' AND OLD.usage_state = 'UNKNOWN' AND NEW.usage_state = 'UNKNOWN') THEN
      RAISE EXCEPTION 'JOURNAL: non-acceptance evidence is written on DISPATCHING -> FAILED with usage UNKNOWN only (request %)', OLD.request_id USING ERRCODE = 'KA007';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER request_journal_non_acceptance_evidence BEFORE UPDATE ON kauro.request_journal
  FOR EACH ROW EXECUTE FUNCTION kauro.request_journal_non_acceptance_evidence();

-- Into DISPATCHING only from RESERVED, DISPATCHING -> DISPATCHING included (D5-18 edge guard).
CREATE OR REPLACE FUNCTION kauro.request_journal_dispatch_from_reserved() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  RAISE EXCEPTION 'JOURNAL: request % enters DISPATCHING from RESERVED only (it is %)', OLD.request_id, OLD.state USING ERRCODE = 'KA007';
END
$$;
CREATE TRIGGER request_journal_dispatch_from_reserved BEFORE UPDATE OF state ON kauro.request_journal
  FOR EACH ROW WHEN (NEW.state = 'DISPATCHING' AND OLD.state IS DISTINCT FROM 'RESERVED') EXECUTE FUNCTION kauro.request_journal_dispatch_from_reserved();

-- Into RESPONSE_STORED only from a sent state (a response cannot exist for an unsent request; a terminal OLD is refused by
-- request_journal_guard, which fires first by name).
CREATE OR REPLACE FUNCTION kauro.request_journal_response_from_sent() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  RAISE EXCEPTION 'JOURNAL: request % stores a response from DISPATCHING or UNCERTAIN only (it is %)', OLD.request_id, OLD.state USING ERRCODE = 'KA007';
END
$$;
CREATE TRIGGER request_journal_response_from_sent BEFORE UPDATE OF state ON kauro.request_journal
  FOR EACH ROW WHEN (NEW.state = 'RESPONSE_STORED' AND OLD.state NOT IN ('DISPATCHING', 'UNCERTAIN', 'RESPONSE_STORED'))
  EXECUTE FUNCTION kauro.request_journal_response_from_sent();

-- --- 2. liabilities and 3. the pool's liability gate ----------------------------------------------------------------------------------
CREATE TABLE kauro.pool_liability_gates (
  pool_grant_id uuid PRIMARY KEY REFERENCES kauro.cost_grants (grant_id)
);
CREATE TRIGGER pool_liability_gates_immutable BEFORE UPDATE ON kauro.pool_liability_gates
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('pool_grant_id');

CREATE TABLE kauro.dispatch_liabilities (
  request_id     uuid PRIMARY KEY REFERENCES kauro.request_journal (request_id),
  grant_id       uuid NOT NULL REFERENCES kauro.cost_grants (grant_id),
  -- the funding grant's pool (an AUDIT grant's pool_grant_id; a pool-funded request's pool itself), checked by the insert trigger
  pool_id        uuid NOT NULL,
  excess_micros  bigint NOT NULL CHECK (excess_micros > 0),
  state          text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'CLEARED')),
  opened_at      timestamptz NOT NULL,
  cleared_at     timestamptz,
  CONSTRAINT dispatch_liabilities_cleared_recorded CHECK ((state = 'CLEARED') = (cleared_at IS NOT NULL))
);
CREATE INDEX dispatch_liabilities_open_of_pool ON kauro.dispatch_liabilities (pool_id) WHERE state = 'OPEN';

-- The pool whose gate a request or liability funded by grant `p_grant` takes: an explicit branch on the grant's kind, never a coalesce
-- (template rule 12): AUDIT -> its pool; PLATFORM_MONTHLY -> the pool itself (port contract: no product caller funds from the pool);
-- anything else -> KA006 pool_liability_gate_scope.
CREATE OR REPLACE FUNCTION kauro.liability_gate_pool_of(p_grant uuid) RETURNS uuid
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS
$$
DECLARE
  g record;
BEGIN
  SELECT c.grant_id, c.grant_kind, c.pool_grant_id INTO g FROM kauro.cost_grants c WHERE c.grant_id = p_grant;
  IF FOUND AND g.grant_kind = 'AUDIT' AND g.pool_grant_id IS NOT NULL THEN
    RETURN g.pool_grant_id;
  ELSIF FOUND AND g.grant_kind = 'PLATFORM_MONTHLY' THEN
    RETURN g.grant_id;
  END IF;
  RAISE EXCEPTION 'LIABILITY_GATE_SCOPE: grant % funds no pool''s gate', p_grant USING ERRCODE = 'KA006', CONSTRAINT = 'pool_liability_gate_scope';
END
$$;

-- The gate event's registration, in the event's own statement before any gate lock is requested (r6 ADV-4, r7 ADV-12): a unit takes
-- one gate in one mode. Each setting is read through nullif: unset reads NULL on a new connection and '' on a pooled one after an
-- earlier transaction set it; both mean missing. Both missing -> the unit's first event registers (pool, mode), transaction-local (a
-- rolled-back savepoint restores them); exactly one missing, or another pool, or the other mode -> KA006 pool_liability_gate_scope.
CREATE OR REPLACE FUNCTION kauro.liability_gate_register(p_pool uuid, p_mode text) RETURNS void
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS
$$
DECLARE
  registered_pool text := nullif(current_setting('kauro.liability_gate_pool', true), '');
  registered_mode text := nullif(current_setting('kauro.liability_gate_mode', true), '');
BEGIN
  IF registered_pool IS NULL AND registered_mode IS NULL THEN
    PERFORM set_config('kauro.liability_gate_pool', p_pool::text, true), set_config('kauro.liability_gate_mode', p_mode, true);
    RETURN;
  END IF;
  IF registered_pool IS NULL OR registered_mode IS NULL OR registered_pool <> p_pool::text OR registered_mode <> p_mode THEN
    RAISE EXCEPTION 'LIABILITY_GATE_SCOPE: a unit takes one pool''s liability gate in one mode (registered %/%, asked %/%)',
      coalesce(registered_pool, 'missing'), coalesce(registered_mode, 'missing'), p_pool, p_mode USING ERRCODE = 'KA006', CONSTRAINT = 'pool_liability_gate_scope';
  END IF;
END
$$;

-- A liability is born OPEN at the database clock, on its request's own grant and that grant's pool, and registers the gate in mode
-- UPDATE; it changes only by its clearing edge (an owner/ops act, B12).
CREATE OR REPLACE FUNCTION kauro.dispatch_liabilities_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  funding uuid;
  pool uuid;
BEGIN
  SELECT r.cost_grant_id INTO funding FROM kauro.request_journal r WHERE r.request_id = NEW.request_id;
  pool := kauro.liability_gate_pool_of(NEW.grant_id);
  IF funding IS DISTINCT FROM NEW.grant_id OR NEW.pool_id IS DISTINCT FROM pool THEN
    RAISE EXCEPTION 'LIABILITY_GATE_SCOPE: the liability of request % is its own grant''s and that grant''s pool''s', NEW.request_id USING ERRCODE = 'KA006', CONSTRAINT = 'pool_liability_gate_scope';
  END IF;
  PERFORM kauro.liability_gate_register(pool, 'UPDATE');
  NEW.state := 'OPEN';
  NEW.opened_at := kauro.server_now();
  NEW.cleared_at := NULL;
  RETURN NEW;
END
$$;
CREATE TRIGGER dispatch_liabilities_birth BEFORE INSERT ON kauro.dispatch_liabilities
  FOR EACH ROW EXECUTE FUNCTION kauro.dispatch_liabilities_birth();

CREATE OR REPLACE FUNCTION kauro.dispatch_liabilities_clearing() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.state <> 'OPEN' OR NEW.state <> 'CLEARED' THEN
    RAISE EXCEPTION 'JOURNAL: liability of request % moves OPEN -> CLEARED only', OLD.request_id USING ERRCODE = 'KA007';
  END IF;
  NEW.cleared_at := kauro.server_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER dispatch_liabilities_immutable BEFORE UPDATE ON kauro.dispatch_liabilities
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('request_id,grant_id,pool_id,excess_micros,opened_at');
CREATE TRIGGER dispatch_liabilities_clearing BEFORE UPDATE ON kauro.dispatch_liabilities
  FOR EACH ROW EXECUTE FUNCTION kauro.dispatch_liabilities_clearing();

-- A pool's gate row is born with the pool, in the funding transaction.
CREATE OR REPLACE FUNCTION kauro.pool_liability_gate_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  INSERT INTO kauro.pool_liability_gates (pool_grant_id) VALUES (NEW.grant_id);
  RETURN NULL;
END
$$;
CREATE TRIGGER cost_grants_pool_liability_gate AFTER INSERT ON kauro.cost_grants
  FOR EACH ROW WHEN (NEW.grant_kind = 'PLATFORM_MONTHLY') EXECUTE FUNCTION kauro.pool_liability_gate_birth();

-- --- 4. the reservation (replaces 0023's function; trigger request_journal_reserves_grant unchanged) ----------------------------------
-- LOCK-B05-1, in order: the model task's audit FOR SHARE (already held by the admission's createModelTask), the funding grant FOR UPDATE
-- (the pool itself when it funds directly), then the upstream rows FOR SHARE in ascending (reserved_at, request_id), each funded by the
-- same grant as the new request — else KA009 UPSTREAM_UNRESOLVED before any upstream lock (D5-19b; 0006's upstream trigger then
-- re-locks rows already held). Every judgement reads kauro.effect_now() after those locks; the binding re-judgement is at COMMIT under
-- the pool's liability gate (request_journal_commit_gate). No pool row lock.
CREATE OR REPLACE FUNCTION kauro.request_journal_reserves_grant() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  g record;
  m record;
  a record;
  is_task boolean;
  pool uuid;
  judged timestamptz;
BEGIN
  IF NEW.cost_grant_id IS NULL OR NEW.reserved_cents IS NULL OR NEW.reserved_cents <= 0 THEN
    RETURN NEW;
  END IF;
  IF NEW.settlement_state IS NOT NULL OR NEW.non_acceptance_evidence IS NOT NULL THEN
    RAISE EXCEPTION 'JOURNAL: request % is reserved unsettled and without evidence', NEW.request_id USING ERRCODE = 'KA007';
  END IF;
  SELECT m0.agency_id, m0.audit_id, m0.grant_id, m0.maximum_cost_cents, m0.interpretation_deadline_at INTO m
    FROM kauro.model_tasks m0 WHERE m0.model_task_id = NEW.task_id;
  is_task := FOUND;
  IF is_task THEN
    SELECT x.state, x.fence INTO a FROM kauro.audits x WHERE x.agency_id = m.agency_id AND x.audit_id = m.audit_id FOR SHARE;
  END IF;
  SELECT c.agency_id, c.grant_kind, c.state, c.expires_at, c.ceiling_cents, c.reserved_cents, c.reconciled_spend_cents, c.pool_grant_id INTO g
    FROM kauro.cost_grants c WHERE c.grant_id = NEW.cost_grant_id FOR UPDATE;
  IF cardinality(NEW.upstream_request_ids) > 0 THEN
    IF EXISTS (
      SELECT 1 FROM unnest(NEW.upstream_request_ids) AS u(id) LEFT JOIN kauro.request_journal r ON r.request_id = u.id
       WHERE r.request_id IS NULL OR r.cost_grant_id IS DISTINCT FROM NEW.cost_grant_id
    ) THEN
      RAISE EXCEPTION 'UPSTREAM_UNRESOLVED: request % depends on an upstream that is unknown or funded by another grant', NEW.request_id USING ERRCODE = 'KA009';
    END IF;
    PERFORM 1 FROM kauro.request_journal r WHERE r.request_id = ANY (NEW.upstream_request_ids) ORDER BY r.reserved_at, r.request_id FOR SHARE;
  END IF;
  judged := kauro.effect_now();
  IF is_task THEN
    IF NEW.agency_id IS DISTINCT FROM m.agency_id OR NEW.cost_grant_id IS DISTINCT FROM m.grant_id OR NEW.reserved_cents > m.maximum_cost_cents THEN
      RAISE EXCEPTION 'NO_FUNDED_GRANT: a dispatch of model task % reserves on its audit''s grant within its maximum cost', NEW.task_id USING ERRCODE = 'KA083';
    END IF;
    IF a.state IS DISTINCT FROM 'INTERPRETING' OR judged >= m.interpretation_deadline_at THEN
      RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % is % and sends nothing new for model task %', m.audit_id, coalesce(a.state, 'not visible'), NEW.task_id USING ERRCODE = 'KA081';
    END IF;
    IF NEW.step_fence IS NULL OR NEW.step_fence IS DISTINCT FROM a.fence OR NOT EXISTS (
      SELECT 1 FROM kauro.audit_steps s
       WHERE s.agency_id = m.agency_id AND s.audit_id = m.audit_id AND s.fence = NEW.step_fence AND s.kind = 'INTERPRET' AND s.outcome IS NULL
    ) THEN
      RAISE EXCEPTION 'AUDIT_FENCE: a dispatch of model task % is admitted by the open INTERPRET step of the audit''s current fence', NEW.task_id USING ERRCODE = 'KA080';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM kauro.leases l
       WHERE l.resource_kind = 'MODEL_TASK' AND l.resource_id = NEW.task_id AND l.fence = NEW.fence AND l.cost_authority_id = m.grant_id
    ) THEN
      RAISE EXCEPTION 'AUDIT_FENCE: a dispatch of model task % is the MODEL_TASK lease''s current fence', NEW.task_id USING ERRCODE = 'KA080';
    END IF;
  END IF;
  -- an expiry by its name (D5-19): the funding grant's own (an AUDIT grant's, or the pool's when the pool funds directly), then an AUDIT
  -- grant's pool's (0023:143 caps the grant by its pool; a forged cap still meets this clause)
  IF g.state = 'AUTHORIZED' AND g.expires_at <= judged THEN
    IF g.grant_kind = 'PLATFORM_MONTHLY' THEN
      RAISE EXCEPTION 'POOL_EXPIRED: the pool funding request % expired before its reservation', NEW.request_id USING ERRCODE = 'KA083', CONSTRAINT = 'pool_expired_at_dispatch';
    END IF;
    RAISE EXCEPTION 'GRANT_EXPIRED: the grant of request % expired before its reservation', NEW.request_id USING ERRCODE = 'KA083', CONSTRAINT = 'grant_expired_at_dispatch';
  END IF;
  IF g.grant_kind = 'AUDIT' AND NOT EXISTS (SELECT 1 FROM kauro.cost_grants p WHERE p.grant_id = g.pool_grant_id AND p.expires_at > judged) THEN
    RAISE EXCEPTION 'POOL_EXPIRED: the pool funding request % expired before its reservation', NEW.request_id USING ERRCODE = 'KA083', CONSTRAINT = 'pool_expired_at_dispatch';
  END IF;
  IF g.state IS NULL OR g.state <> 'AUTHORIZED' OR g.expires_at <= judged OR (g.agency_id IS NOT NULL AND g.agency_id IS DISTINCT FROM NEW.agency_id)
     OR g.reserved_cents + g.reconciled_spend_cents + NEW.reserved_cents > g.ceiling_cents THEN
    RAISE EXCEPTION 'NO_FUNDED_GRANT: request % reserves % cents on no AUTHORIZED, unexpired grant of its scope with room under its ceiling', NEW.request_id, NEW.reserved_cents USING ERRCODE = 'KA083';
  END IF;
  pool := kauro.liability_gate_pool_of(NEW.cost_grant_id);
  -- the gate's scope first (a unit that opened a liability on the pool asks the other mode: KA006, not the liability it wrote itself)
  PERFORM kauro.liability_gate_register(pool, 'KEY_SHARE');
  -- an early refusal only: the binding one is at COMMIT under the gate
  IF EXISTS (SELECT 1 FROM kauro.dispatch_liabilities d WHERE d.pool_id = pool AND d.state = 'OPEN') THEN
    RAISE EXCEPTION 'POOL_LIABILITY_OPEN: pool % carries an open liability; request % reserves nothing', pool, NEW.request_id USING ERRCODE = 'KA083', CONSTRAINT = 'pool_liability_open';
  END IF;
  UPDATE kauro.cost_grants SET reserved_cents = reserved_cents + NEW.reserved_cents WHERE grant_id = NEW.cost_grant_id;
  RETURN NEW;
END
$$;

-- --- 5. the send edge (replaces 0023's function; trigger request_journal_model_task_send unchanged) -----------------------------------
-- In the edge's own statement, after markDispatching's audit and lease shares: a model task's audit INTERPRETING, the request's step
-- fence equal to the audit's with its INTERPRET step open, the lease at the request's fence; then against kauro.effect_now() the
-- interpretation deadline, the lease's expiry, the funding grant's and (AUDIT) its pool's expiry; the gate registration. The binding
-- judgements follow the gate at COMMIT.
CREATE OR REPLACE FUNCTION kauro.request_journal_model_task_send() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  m record;
  a record;
  g record;
  is_task boolean;
  judged timestamptz;
BEGIN
  SELECT m0.agency_id, m0.audit_id, m0.grant_id, m0.interpretation_deadline_at INTO m FROM kauro.model_tasks m0 WHERE m0.model_task_id = OLD.task_id;
  is_task := FOUND;
  IF is_task THEN
    SELECT x.state, x.fence INTO a FROM kauro.audits x WHERE x.agency_id = m.agency_id AND x.audit_id = m.audit_id FOR SHARE;
    judged := kauro.effect_now();
    IF a.state IS DISTINCT FROM 'INTERPRETING' OR judged >= m.interpretation_deadline_at THEN
      RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % is % and sends nothing for model task %', m.audit_id, coalesce(a.state, 'not visible'), OLD.task_id USING ERRCODE = 'KA081';
    END IF;
    IF OLD.step_fence IS NULL OR OLD.step_fence IS DISTINCT FROM a.fence OR NOT EXISTS (
      SELECT 1 FROM kauro.audit_steps s
       WHERE s.agency_id = m.agency_id AND s.audit_id = m.audit_id AND s.fence = OLD.step_fence AND s.kind = 'INTERPRET' AND s.outcome IS NULL
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

-- --- the commit-time gates (D5-11 guard; r7 ADV-13: PostgreSQL forbids OLD in the WHEN of an INSERT trigger, so the reservation and the
-- edge are two pg_trigger rows on ONE function) --------------------------------------------------------------------------------------
-- Statement 1 takes the pool's gate FOR KEY SHARE (NOT FOUND -> KA006 pool_liability_gate_absent, never a silent pass, whatever RLS
-- hides); then, each a later statement (a VOLATILE plpgsql function takes a fresh snapshot per statement under READ COMMITTED, so every
-- read after the wait sees what committed during it), one clause per statement against kauro.effect_now(): no OPEN liability of the pool
-- (KA083 pool_liability_open); a model task's interpretation deadline not reached (KA081) and its MODEL_TASK lease's expiry later (KA080);
-- AUDIT: the grant's expiry later (KA083 grant_expired_at_dispatch), then its pool's (KA083 pool_expired_at_dispatch); PLATFORM_MONTHLY
-- (port contract): the pool's clause only.
CREATE OR REPLACE FUNCTION kauro.request_journal_commit_gate() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS
$$
DECLARE
  pool uuid;
  deadline timestamptz;
  kind text;
  grant_expires timestamptz;
  pool_expires timestamptz;
BEGIN
  SELECT gt.pool_grant_id INTO pool
    FROM kauro.cost_grants c
    JOIN kauro.pool_liability_gates gt ON gt.pool_grant_id = (CASE WHEN c.grant_kind = 'AUDIT' THEN c.pool_grant_id WHEN c.grant_kind = 'PLATFORM_MONTHLY' THEN c.grant_id END)
   WHERE c.grant_id = NEW.cost_grant_id
     FOR KEY SHARE OF gt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LIABILITY_GATE_ABSENT: the pool funding request % has no liability gate', NEW.request_id USING ERRCODE = 'KA006', CONSTRAINT = 'pool_liability_gate_absent';
  END IF;
  IF EXISTS (SELECT 1 FROM kauro.dispatch_liabilities d WHERE d.pool_id = pool AND d.state = 'OPEN') THEN
    RAISE EXCEPTION 'POOL_LIABILITY_OPEN: pool % carries an open liability; request % commits no reservation or send', pool, NEW.request_id USING ERRCODE = 'KA083', CONSTRAINT = 'pool_liability_open';
  END IF;
  SELECT m.interpretation_deadline_at INTO deadline FROM kauro.model_tasks m WHERE m.model_task_id = NEW.task_id;
  IF FOUND THEN
    IF kauro.effect_now() >= deadline THEN
      RAISE EXCEPTION 'AUDIT_AUTHORITY: the interpretation deadline of request % passed before its COMMIT', NEW.request_id USING ERRCODE = 'KA081';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM kauro.leases l WHERE l.resource_kind = 'MODEL_TASK' AND l.resource_id = NEW.task_id AND l.fence = NEW.fence AND l.expires_at > kauro.effect_now()
    ) THEN
      RAISE EXCEPTION 'AUDIT_FENCE: the MODEL_TASK lease of request % ended before its COMMIT', NEW.request_id USING ERRCODE = 'KA080';
    END IF;
  END IF;
  SELECT c.grant_kind, c.expires_at, p.expires_at INTO kind, grant_expires, pool_expires
    FROM kauro.cost_grants c LEFT JOIN kauro.cost_grants p ON p.grant_id = c.pool_grant_id WHERE c.grant_id = NEW.cost_grant_id;
  IF kind = 'AUDIT' THEN
    IF grant_expires <= kauro.effect_now() THEN
      RAISE EXCEPTION 'GRANT_EXPIRED: the grant of request % expired before its COMMIT', NEW.request_id USING ERRCODE = 'KA083', CONSTRAINT = 'grant_expired_at_dispatch';
    END IF;
    IF pool_expires <= kauro.effect_now() THEN
      RAISE EXCEPTION 'POOL_EXPIRED: the pool funding request % expired before its COMMIT', NEW.request_id USING ERRCODE = 'KA083', CONSTRAINT = 'pool_expired_at_dispatch';
    END IF;
  ELSIF kind = 'PLATFORM_MONTHLY' THEN
    IF grant_expires <= kauro.effect_now() THEN
      RAISE EXCEPTION 'POOL_EXPIRED: the pool funding request % expired before its COMMIT', NEW.request_id USING ERRCODE = 'KA083', CONSTRAINT = 'pool_expired_at_dispatch';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER request_journal_commit_gate_reserve AFTER INSERT ON kauro.request_journal
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.request_journal_commit_gate();
CREATE CONSTRAINT TRIGGER request_journal_commit_gate_dispatch AFTER UPDATE OF state ON kauro.request_journal
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.state = 'RESERVED' AND NEW.state = 'DISPATCHING')
  EXECUTE FUNCTION kauro.request_journal_commit_gate();

-- A liability takes its pool's gate FOR UPDATE at COMMIT, in its first statement; nothing after it.
CREATE OR REPLACE FUNCTION kauro.dispatch_liabilities_commit_gate() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM 1 FROM kauro.pool_liability_gates gt WHERE gt.pool_grant_id = NEW.pool_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LIABILITY_GATE_ABSENT: the pool of the liability of request % has no liability gate', NEW.request_id USING ERRCODE = 'KA006', CONSTRAINT = 'pool_liability_gate_absent';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER dispatch_liabilities_commit_gate AFTER INSERT ON kauro.dispatch_liabilities
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.dispatch_liabilities_commit_gate();

-- --- row security and grants (the 0006:361/:366 pattern; nothing to kauro_app: no tenant unit takes a gate) ---------------------------
ALTER TABLE kauro.pool_liability_gates ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.pool_liability_gates FORCE ROW LEVEL SECURITY;
CREATE POLICY pool_liability_gates_control ON kauro.pool_liability_gates FOR ALL TO kauro_control USING (true) WITH CHECK (true);
-- a row lock needs the UPDATE privilege; no DELETE except the owner
GRANT SELECT, INSERT, UPDATE (pool_grant_id) ON kauro.pool_liability_gates TO kauro_control;

ALTER TABLE kauro.dispatch_liabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.dispatch_liabilities FORCE ROW LEVEL SECURITY;
CREATE POLICY dispatch_liabilities_control ON kauro.dispatch_liabilities FOR ALL TO kauro_control USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE (state) ON kauro.dispatch_liabilities TO kauro_control;

-- --- backfill (r7 ADV-13): the migration owner is neither superuser nor BYPASSRLS and both tables are FORCE ROW LEVEL SECURITY, so the
-- owner reads cost_grants under NO FORCE: a concurrent pool insert waits on the SHARE lock and then fires the birth trigger --------------
LOCK TABLE kauro.cost_grants IN SHARE MODE;
ALTER TABLE kauro.cost_grants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE kauro.pool_liability_gates NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.pool_liability_gates (pool_grant_id) SELECT grant_id FROM kauro.cost_grants WHERE grant_kind = 'PLATFORM_MONTHLY' ON CONFLICT DO NOTHING;
ALTER TABLE kauro.cost_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE kauro.pool_liability_gates FORCE ROW LEVEL SECURITY;
