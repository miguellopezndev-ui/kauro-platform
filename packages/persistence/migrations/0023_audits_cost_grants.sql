-- 0023 — B08 audit authority: cost grants (the platform's monthly model pool and the free AUDIT grants carved from it), audits and
-- their fenced steps, model tasks and their fenced journal, content-idempotent decision artifacts, plans' validation intents, the
-- reservation every dispatch intent makes on a funded grant, and the control plane's system draft plans and validation edges.
--
-- Authority: 06 "Logical attempt and durable journal", "Concurrency, leases and uncertain dispatch", "Cancellation and deadlines",
-- "Budget algebra", "Migration validation and final states" (a logical audit retains its original deadlines and grant across retries;
-- no new semantic dispatch after the interpretation deadline; no successful finalization after the absolute deadline; unknown usage
-- stays reserved until reconciled), 07 "Audit and plan states", 07 "Database representation", 08 "Database isolation", registry
-- contracts Audit, CostGrant, ModelTask, RequestJournal, ValidationReceipt, DecisionEvidence; registry machines Audit, CostGrant, Plan;
-- scenarios R2-044, S089 (its grant half), CMD020..CMD024. Design: docs/design/B08-audit-approval-jobs.md §3, §6, §8.1, §9, §11
-- (decisions D8-AUD-1..4, D8-GRANT-1/2, D8-PLAN-1/2, D8-ROLE-1/2, D8-CLOCK-1, D8-SQL-1, D8-EVT-1, D8-XPKG-7) and the decisions register
-- rows D8-PAU-1.. of mandate B08-PERSISTENCE-AUDIT. It extends B06 (0001..0008), B07 (0009..0012), B09 (0013..0017), the merge (0018)
-- and B08's execution half (0021, 0022) and forks nothing: new tables, triggers, policies, grants and keys — a foreign key and a
-- reservation trigger on B06's request_journal.cost_grant_id, binding targets on B07's revisions and target contracts, and the control
-- plane's policies on B06's plans (D8-BASE-2).
--
-- SQLSTATE (D8-SQL-1; mapped by @kauro/persistence sqlstate.ts): KA080 a step, journal event or dispatch intent that is not under its
-- audit's current fence; KA081 an edge the audit's state, cancellation or deadlines no longer admit; KA083 GRANT — an audit or a
-- dispatch intent without a funded grant with room under its ceiling, or a grant's money moved outside its edges.

-- --- binding targets B08 adds to B07's tables (D8-BASE-2: keys only, nothing changes) ----------------------------------------------
-- an audit binds exactly a revision of its project with its manifest hash, and a target contract of its project with its body hash
ALTER TABLE kauro.dataset_revisions ADD CONSTRAINT dataset_revisions_audit_subject UNIQUE (agency_id, project_id, revision_id, manifest_hash);
ALTER TABLE kauro.target_contracts ADD CONSTRAINT target_contracts_audit_subject UNIQUE (agency_id, project_id, contract_id, body_hash);

-- --- event types and the two registry machines (D8-EVT-1) --------------------------------------------------------------------------
ALTER TABLE kauro.event_types NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.event_types (event_type) VALUES
  ('audit.queued.v1'), ('audit.profiling.v1'), ('audit.interpreting.v1'), ('audit.validating.v1'), ('audit.draft_ready.v1'),
  ('audit.needs_decision.v1'), ('audit.unsupported.v1'), ('audit.failed.v1'), ('audit.cancelled.v1'), ('audit.expired.v1'),
  ('cost_grant.prepared.v1'), ('cost_grant.authorized.v1'), ('cost_grant.exhausted.v1'), ('cost_grant.expired.v1'), ('cost_grant.closed.v1');
ALTER TABLE kauro.event_types FORCE ROW LEVEL SECURITY;

-- The registry Audit and CostGrant machines (state_transitions.json), edge for edge (the persistence test compares the seeds)
INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('Audit', 'QUEUED'), ('CostGrant', 'PREPARED');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('Audit', 'QUEUED', 'PROFILING'),
  ('Audit', 'PROFILING', 'INTERPRETING'),
  ('Audit', 'INTERPRETING', 'VALIDATING'),
  ('Audit', 'INTERPRETING', 'NEEDS_DECISION'),
  ('Audit', 'INTERPRETING', 'UNSUPPORTED'),
  ('Audit', 'VALIDATING', 'DRAFT_READY'),
  ('Audit', 'VALIDATING', 'NEEDS_DECISION'),
  ('Audit', 'QUEUED', 'CANCELLED'),
  ('Audit', 'PROFILING', 'CANCELLED'),
  ('Audit', 'INTERPRETING', 'CANCELLED'),
  ('Audit', 'VALIDATING', 'CANCELLED'),
  ('Audit', 'QUEUED', 'EXPIRED'),
  ('Audit', 'PROFILING', 'EXPIRED'),
  ('Audit', 'INTERPRETING', 'EXPIRED'),
  ('Audit', 'VALIDATING', 'EXPIRED'),
  ('Audit', 'PROFILING', 'FAILED'),
  ('Audit', 'INTERPRETING', 'FAILED'),
  ('Audit', 'VALIDATING', 'FAILED'),
  ('CostGrant', 'PREPARED', 'AUTHORIZED'),
  ('CostGrant', 'AUTHORIZED', 'EXHAUSTED'),
  ('CostGrant', 'EXHAUSTED', 'AUTHORIZED'),
  ('CostGrant', 'AUTHORIZED', 'EXPIRED'),
  ('CostGrant', 'EXHAUSTED', 'EXPIRED'),
  ('CostGrant', 'AUTHORIZED', 'CLOSED'),
  ('CostGrant', 'EXPIRED', 'CLOSED');

-- --- cost grants (registry contract and machine CostGrant; an aggregate, kind cost_grant) -------------------------------------------
-- The platform's monthly model pool (PLATFORM_MONTHLY: no agency, funded by the owner's operations act under kauro_control, Q8-1) and
-- the free AUDIT grants StartAudit carves from it (one agency, at most intelligence.freeAuditCeilingCents, the pool holding its whole
-- ceiling while it lives; D8-GRANT-1). Money is BIGINT cents; reserved + reconciled spend never passes the ceiling. The pool has no
-- agency, so B06's event binding (0005, 0008), which binds an event to an aggregate of its agency, cannot name it: a pool is versioned
-- and stamped but publishes no event, and the audit grants carry the cost_grant events (decision D8-PAU-1).
CREATE TABLE kauro.cost_grants (
  grant_id                uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(grant_id)),
  agency_id               uuid REFERENCES kauro.agencies (agency_id),
  grant_kind              text NOT NULL CHECK (grant_kind IN ('PLATFORM_MONTHLY', 'AUDIT')),
  pool_grant_id           uuid REFERENCES kauro.cost_grants (grant_id),
  currency                text NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD')),
  ceiling_cents           bigint NOT NULL CHECK (ceiling_cents > 0),
  reserved_cents          bigint NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0),
  reconciled_spend_cents  bigint NOT NULL DEFAULT 0 CHECK (reconciled_spend_cents >= 0),
  price_profile_hash      text NOT NULL CHECK (kauro.is_sha256_hex(price_profile_hash)),
  -- the funding evidence: the owner's authorization of a pool; for an AUDIT grant, the pool itself (CostGrant.authorizationRef)
  authorization_ref       uuid,
  -- no new spend at or after it: the pool's funding statement; an AUDIT grant's is its audit's window, never past its pool's
  expires_at              timestamptz NOT NULL,
  version                 bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                   text NOT NULL DEFAULT 'PREPARED' CHECK (state IN ('PREPARED', 'AUTHORIZED', 'EXHAUSTED', 'EXPIRED', 'CLOSED')),
  authorized_at           timestamptz,
  expired_at              timestamptz,
  closed_at               timestamptz,
  created_at              timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL,
  UNIQUE (agency_id, grant_id),
  -- reserved + reconciled_spend <= ceiling (design §9): BUDGET_EXHAUSTED / GRANT_CEILING
  CONSTRAINT cost_grants_within_ceiling CHECK (reserved_cents + reconciled_spend_cents <= ceiling_cents),
  -- the AUDIT ceiling within policy (intelligence.freeAuditCeilingCents)
  CONSTRAINT cost_grants_audit_ceiling CHECK (grant_kind <> 'AUDIT' OR ceiling_cents <= 150),
  CONSTRAINT cost_grants_scope CHECK ((grant_kind = 'AUDIT') = (agency_id IS NOT NULL) AND (grant_kind = 'AUDIT') = (pool_grant_id IS NOT NULL)),
  -- actual_authorization_and_funding: authorization reference, ceiling, scope and expiry present (design §8.1)
  CONSTRAINT cost_grants_authorized_evidence CHECK (state = 'PREPARED' OR (authorization_ref IS NOT NULL AND authorized_at IS NOT NULL)),
  CONSTRAINT cost_grants_audit_authorized_by_pool CHECK (grant_kind <> 'AUDIT' OR authorization_ref IS NULL OR authorization_ref = pool_grant_id),
  CONSTRAINT cost_grants_terminal_recorded CHECK ((state = 'CLOSED') = (closed_at IS NOT NULL) AND (state <> 'EXPIRED' OR expired_at IS NOT NULL))
);
CREATE INDEX cost_grants_funded_pools ON kauro.cost_grants (expires_at, grant_id) WHERE grant_kind = 'PLATFORM_MONTHLY' AND state = 'AUTHORIZED';
CREATE INDEX cost_grants_of_pool ON kauro.cost_grants (pool_grant_id) WHERE pool_grant_id IS NOT NULL;

-- trigger names fix the order of the BEFORE triggers (they fire by name): immutable columns, the birth state, columns learned once, the
-- listed edge and the version discipline first, then the workflow guard of this package
CREATE TRIGGER cost_grants_immutable BEFORE UPDATE ON kauro.cost_grants
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('grant_id,agency_id,grant_kind,pool_grant_id,currency,ceiling_cents,price_profile_hash,expires_at,created_at');
CREATE TRIGGER cost_grants_initial_state BEFORE INSERT ON kauro.cost_grants
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('CostGrant');
CREATE TRIGGER cost_grants_learned_once BEFORE UPDATE ON kauro.cost_grants
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('authorization_ref,authorized_at,expired_at,closed_at');
CREATE TRIGGER cost_grants_transition BEFORE UPDATE OF state ON kauro.cost_grants
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('CostGrant');
-- the reservations move without a version (a dispatch intent is not a version of its grant; the row lock orders them, D8-GRANT-2)
CREATE TRIGGER cost_grants_version BEFORE UPDATE ON kauro.cost_grants
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump('reserved_cents,reconciled_spend_cents');

-- Whether the session is the control plane's (a member of kauro_control): the grants' reconciliation and the pools are its own.
CREATE OR REPLACE FUNCTION kauro.is_control_session() RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog AS
$$ SELECT pg_has_role(current_user, 'kauro_control', 'MEMBER') $$;

-- The grant's workflow guard (D8-GRANT-1, D8-GRANT-2, D8-DL-1, D8-CLOCK-1): stamps its instants with the server's transaction time,
-- sets an AUDIT grant's expiry (its audit's window, never past its pool's), and refuses what the database can decide at the edge.
CREATE OR REPLACE FUNCTION kauro.cost_grants_workflow() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  clock timestamptz := kauro.server_now();
  pool record;
  control boolean := kauro.is_control_session();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.reserved_cents <> 0 OR NEW.reconciled_spend_cents <> 0 OR NEW.authorization_ref IS NOT NULL THEN
      RAISE EXCEPTION 'GRANT: grant % is born PREPARED at version 1 with nothing reserved, spent or authorized', NEW.grant_id USING ERRCODE = 'KA083';
    END IF;
    IF NEW.grant_kind = 'AUDIT' THEN
      -- carved from a platform pool only; it lives for its audit's window and never outlives the pool
      SELECT p.grant_kind, p.expires_at INTO pool FROM kauro.cost_grants p WHERE p.grant_id = NEW.pool_grant_id;
      IF pool.grant_kind IS DISTINCT FROM 'PLATFORM_MONTHLY' THEN
        RAISE EXCEPTION 'NO_FUNDED_GRANT: an AUDIT grant is carved from a platform pool only' USING ERRCODE = 'KA083';
      END IF;
      NEW.expires_at := least(clock + interval '86400 seconds', pool.expires_at);
    END IF;
    IF NEW.expires_at <= clock THEN
      RAISE EXCEPTION 'NO_FUNDED_GRANT: grant % expires no later than its birth', NEW.grant_id USING ERRCODE = 'KA083';
    END IF;
    NEW.created_at := clock;
    NEW.updated_at := clock;
    NEW.authorized_at := NULL; NEW.expired_at := NULL; NEW.closed_at := NULL;
    RETURN NEW;
  END IF;

  NEW.updated_at := clock;
  -- the money moves with its edges only: a dispatch intent's reservation and a carve's hold (one trigger level deeper than the
  -- statement), or the control plane's reconciliation — never a request handler's own statement
  IF (NEW.reserved_cents IS DISTINCT FROM OLD.reserved_cents OR NEW.reconciled_spend_cents IS DISTINCT FROM OLD.reconciled_spend_cents)
     AND pg_trigger_depth() < 2 AND NOT control THEN
    RAISE EXCEPTION 'GRANT: the reservations of grant % move with its dispatch intents and carves only', OLD.grant_id USING ERRCODE = 'KA083';
  END IF;
  -- a pool is the platform's: besides a carve's hold, only the control plane changes it
  IF OLD.grant_kind = 'PLATFORM_MONTHLY' AND NOT control
     AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.version IS DISTINCT FROM OLD.version OR NEW.authorization_ref IS DISTINCT FROM OLD.authorization_ref) THEN
    RAISE EXCEPTION 'GRANT: the platform pool % is changed by the control plane only', OLD.grant_id USING ERRCODE = 'KA083';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF OLD.state = 'PREPARED' THEN
      -- actual_authorization_and_funding: unexpired; an AUDIT grant is authorized by its pool, which holds its ceiling (below)
      IF OLD.expires_at <= clock THEN
        RAISE EXCEPTION 'NO_FUNDED_GRANT: grant % expired before its authorization', OLD.grant_id USING ERRCODE = 'KA083';
      END IF;
      IF OLD.grant_kind = 'AUDIT' AND NEW.authorization_ref IS DISTINCT FROM OLD.pool_grant_id THEN
        RAISE EXCEPTION 'NO_FUNDED_GRANT: the AUDIT grant % is authorized by its pool', OLD.grant_id USING ERRCODE = 'KA083';
      END IF;
      NEW.authorized_at := clock;
    ELSIF OLD.state = 'EXHAUSTED' AND NEW.state = 'AUTHORIZED' THEN
      -- reconciliation_releases_unused_reserve: an amount is free again and the grant is unexpired
      IF OLD.expires_at <= clock OR NEW.reserved_cents + NEW.reconciled_spend_cents >= NEW.ceiling_cents THEN
        RAISE EXCEPTION 'NO_FUNDED_GRANT: grant % is AUTHORIZED again only unexpired with room under its ceiling', OLD.grant_id USING ERRCODE = 'KA083';
      END IF;
    ELSIF NEW.state = 'EXPIRED' THEN
      -- expiry_reached on the server clock, never early (D8-DL-1)
      IF clock < OLD.expires_at THEN
        RAISE EXCEPTION 'AUDIT_AUTHORITY: grant % expires no earlier than %', OLD.grant_id, OLD.expires_at USING ERRCODE = 'KA081';
      END IF;
      NEW.expired_at := clock;
    ELSIF NEW.state = 'CLOSED' THEN
      -- all effects reconciled: no dispatch in flight or uncertain, no usage unknown or estimated, no live carve, no live audit
      IF EXISTS (
        SELECT 1 FROM kauro.request_journal r
         WHERE r.cost_grant_id = OLD.grant_id
           AND (r.state IN ('RESERVED', 'DISPATCHING', 'UNCERTAIN', 'RESPONSE_STORED') OR r.usage_state IN ('UNKNOWN', 'ESTIMATED'))
      ) OR EXISTS (
        SELECT 1 FROM kauro.cost_grants c WHERE c.pool_grant_id = OLD.grant_id AND c.state <> 'CLOSED'
      ) OR EXISTS (
        SELECT 1 FROM kauro.audits a WHERE a.grant_id = OLD.grant_id AND a.state IN ('QUEUED', 'PROFILING', 'INTERPRETING', 'VALIDATING')
      ) THEN
        RAISE EXCEPTION 'GRANT: grant % closes only when no usage is uncertain and nothing it funds is live', OLD.grant_id USING ERRCODE = 'KA083';
      END IF;
      NEW.closed_at := clock;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER cost_grants_workflow BEFORE INSERT OR UPDATE ON kauro.cost_grants
  FOR EACH ROW EXECUTE FUNCTION kauro.cost_grants_workflow();

-- An AUDIT grant's ceiling is held on its pool while it lives (D8-GRANT-1): the hold is taken when the grant is AUTHORIZED, under the
-- pool's row lock (a second carve waits for it and then meets the pool's ceiling CHECK), and released with the grant's final spend
-- when it closes. A trigger level deeper than the statement, so the request handlers' carve moves the pool's money and nothing else.
CREATE OR REPLACE FUNCTION kauro.cost_grants_pool_hold() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.state = 'AUTHORIZED' AND OLD.state = 'PREPARED' THEN
    UPDATE kauro.cost_grants SET reserved_cents = reserved_cents + NEW.ceiling_cents
     WHERE grant_id = NEW.pool_grant_id AND grant_kind = 'PLATFORM_MONTHLY' AND state = 'AUTHORIZED' AND expires_at > kauro.server_now();
    IF NOT FOUND THEN
      RAISE EXCEPTION 'NO_FUNDED_GRANT: the pool of grant % is not AUTHORIZED and unexpired', NEW.grant_id USING ERRCODE = 'KA083';
    END IF;
  ELSIF NEW.state = 'CLOSED' THEN
    UPDATE kauro.cost_grants SET reserved_cents = reserved_cents - NEW.ceiling_cents, reconciled_spend_cents = reconciled_spend_cents + NEW.reconciled_spend_cents
     WHERE grant_id = NEW.pool_grant_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CONTEXT: the pool of grant % is not visible in this transaction', NEW.grant_id USING ERRCODE = 'KA006';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER cost_grants_pool_hold AFTER UPDATE OF state ON kauro.cost_grants
  FOR EACH ROW WHEN (NEW.grant_kind = 'AUDIT' AND OLD.state IS DISTINCT FROM NEW.state AND ((OLD.state = 'PREPARED' AND NEW.state = 'AUTHORIZED') OR NEW.state = 'CLOSED'))
  EXECUTE FUNCTION kauro.cost_grants_pool_hold();

-- one event per version of an agency's grant, the event of the state it reaches (D8-EVT-1; a pool has none, D8-PAU-1)
CREATE CONSTRAINT TRIGGER cost_grants_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.cost_grants
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.agency_id IS NOT NULL) EXECUTE FUNCTION kauro.require_event_for_version('cost_grant', 'grant_id');
CREATE CONSTRAINT TRIGGER cost_grants_event_type_per_version AFTER INSERT OR UPDATE OF version ON kauro.cost_grants
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.agency_id IS NOT NULL) EXECUTE FUNCTION kauro.require_state_event_type('cost_grant', 'grant_id');

INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES ('cost_grant', 'cost_grants', 'grant_id', 'B08');

-- --- every dispatch intent reserves on a funded grant (D8-GRANT-2; S089's grant half, which B06 left open) ------------------------------
ALTER TABLE kauro.request_journal ADD CONSTRAINT request_journal_cost_grant_fk FOREIGN KEY (cost_grant_id) REFERENCES kauro.cost_grants (grant_id);

-- The grant under its row lock: AUTHORIZED, strictly before its expiry, of the request's scope (an agency's grant funds that agency's
-- requests, a platform pool funds any) and with room for the reservation under its ceiling — else KA083; then the reservation joins
-- the grant's reserved cents, a trigger level deeper. A dispatch of a model task names the task's own grant within its maximum cost,
-- while its audit interprets and before the interpretation deadline, at the MODEL_TASK lease's current fence (D8-AUD-3). A missing
-- grant id or a non-positive reservation is left to the column constraints (NOT NULL, CHECK), which PostgreSQL checks after BEFORE
-- triggers. Named to fire before B06's request_journal_upstream_resolved; the statement is all or nothing either way.
CREATE OR REPLACE FUNCTION kauro.request_journal_reserves_grant() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  clock timestamptz := kauro.server_now();
  g record;
  m record;
  audit_state text;
BEGIN
  IF NEW.cost_grant_id IS NULL OR NEW.reserved_cents IS NULL OR NEW.reserved_cents <= 0 THEN
    RETURN NEW;
  END IF;
  SELECT m0.agency_id, m0.audit_id, m0.grant_id, m0.maximum_cost_cents, m0.interpretation_deadline_at INTO m
    FROM kauro.model_tasks m0 WHERE m0.model_task_id = NEW.task_id;
  IF FOUND THEN
    IF NEW.agency_id IS DISTINCT FROM m.agency_id OR NEW.cost_grant_id IS DISTINCT FROM m.grant_id OR NEW.reserved_cents > m.maximum_cost_cents THEN
      RAISE EXCEPTION 'NO_FUNDED_GRANT: a dispatch of model task % reserves on its audit''s grant within its maximum cost', NEW.task_id USING ERRCODE = 'KA083';
    END IF;
    SELECT a.state INTO audit_state FROM kauro.audits a WHERE a.agency_id = m.agency_id AND a.audit_id = m.audit_id;
    IF audit_state IS DISTINCT FROM 'INTERPRETING' OR clock >= m.interpretation_deadline_at THEN
      RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % is % and sends nothing new for model task %', m.audit_id, coalesce(audit_state, 'not visible'), NEW.task_id USING ERRCODE = 'KA081';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM kauro.leases l
       WHERE l.resource_kind = 'MODEL_TASK' AND l.resource_id = NEW.task_id AND l.fence = NEW.fence AND l.cost_authority_id = m.grant_id
    ) THEN
      RAISE EXCEPTION 'AUDIT_FENCE: a dispatch of model task % is the MODEL_TASK lease''s current fence', NEW.task_id USING ERRCODE = 'KA080';
    END IF;
  END IF;
  SELECT c.agency_id, c.state, c.expires_at, c.ceiling_cents, c.reserved_cents, c.reconciled_spend_cents INTO g
    FROM kauro.cost_grants c WHERE c.grant_id = NEW.cost_grant_id FOR UPDATE;
  IF NOT FOUND OR g.state <> 'AUTHORIZED' OR g.expires_at <= clock OR (g.agency_id IS NOT NULL AND g.agency_id IS DISTINCT FROM NEW.agency_id)
     OR g.reserved_cents + g.reconciled_spend_cents + NEW.reserved_cents > g.ceiling_cents THEN
    RAISE EXCEPTION 'NO_FUNDED_GRANT: request % reserves % cents on no AUTHORIZED, unexpired grant of its scope with room under its ceiling', NEW.request_id, NEW.reserved_cents USING ERRCODE = 'KA083';
  END IF;
  UPDATE kauro.cost_grants SET reserved_cents = reserved_cents + NEW.reserved_cents WHERE grant_id = NEW.cost_grant_id;
  RETURN NEW;
END
$$;
CREATE TRIGGER request_journal_reserves_grant BEFORE INSERT ON kauro.request_journal
  FOR EACH ROW EXECUTE FUNCTION kauro.request_journal_reserves_grant();

-- The check before SEND_STARTED (design §6): a model task's attempt is sent only while its audit interprets, before the
-- interpretation deadline and at the MODEL_TASK lease's current fence — a cancellation or a takeover committed first wins.
CREATE OR REPLACE FUNCTION kauro.request_journal_model_task_send() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  m record;
  audit_state text;
BEGIN
  SELECT m0.agency_id, m0.audit_id, m0.grant_id, m0.interpretation_deadline_at INTO m FROM kauro.model_tasks m0 WHERE m0.model_task_id = OLD.task_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  SELECT a.state INTO audit_state FROM kauro.audits a WHERE a.agency_id = m.agency_id AND a.audit_id = m.audit_id FOR SHARE;
  IF audit_state IS DISTINCT FROM 'INTERPRETING' OR kauro.server_now() >= m.interpretation_deadline_at THEN
    RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % is % and sends nothing for model task %', m.audit_id, coalesce(audit_state, 'not visible'), OLD.task_id USING ERRCODE = 'KA081';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM kauro.leases l WHERE l.resource_kind = 'MODEL_TASK' AND l.resource_id = OLD.task_id AND l.fence = OLD.fence AND l.cost_authority_id = m.grant_id
  ) THEN
    RAISE EXCEPTION 'AUDIT_FENCE: attempt % of model task % is not the MODEL_TASK lease''s current fence', OLD.request_id, OLD.task_id USING ERRCODE = 'KA080';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER request_journal_model_task_send BEFORE UPDATE OF state ON kauro.request_journal
  FOR EACH ROW WHEN (OLD.state = 'RESERVED' AND NEW.state = 'DISPATCHING') EXECUTE FUNCTION kauro.request_journal_model_task_send();

-- --- audits (registry contract and machine Audit; an aggregate, kind audit) --------------------------------------------------------
CREATE TABLE kauro.audits (
  audit_id                    uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(audit_id)),
  agency_id                   uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id                  uuid NOT NULL,
  revision_id                 uuid NOT NULL,
  revision_hash               text NOT NULL CHECK (kauro.is_sha256_hex(revision_hash)),
  target_contract_id          uuid NOT NULL,
  target_contract_hash        text NOT NULL CHECK (kauro.is_sha256_hex(target_contract_hash)),
  audit_policy_version        text NOT NULL CHECK (kauro.is_label(audit_policy_version)),
  requested_by_membership_id  uuid NOT NULL,
  grant_id                    uuid NOT NULL,
  version                     bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                       text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED', 'PROFILING', 'INTERPRETING', 'VALIDATING', 'DRAFT_READY', 'NEEDS_DECISION', 'UNSUPPORTED', 'FAILED', 'CANCELLED', 'EXPIRED')),
  -- the fence of the audit's current step (D8-AUD-2): bookkeeping of the steps' triggers, never written by a client statement
  fence                       bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
  cancel_version              bigint NOT NULL DEFAULT 0 CHECK (cancel_version >= 0),
  cancel_actor_kind           text CHECK (cancel_actor_kind IS NULL OR cancel_actor_kind IN ('USER', 'SERVICE')),
  cancel_actor_id             text,
  -- Audit.startedAt and Audit.absoluteDeadline (+ 86,400 s), Audit.interpretationDeadline (first INTERPRETING + 1,200 s), set once
  started_at                  timestamptz NOT NULL,
  absolute_deadline_at        timestamptz NOT NULL,
  interpretation_deadline_at  timestamptz,
  profile_evidence_hash       text CHECK (profile_evidence_hash IS NULL OR kauro.is_sha256_hex(profile_evidence_hash)),
  candidate_manifest_hash     text CHECK (candidate_manifest_hash IS NULL OR kauro.is_sha256_hex(candidate_manifest_hash)),
  draft_plan_id               uuid,
  -- NEEDS_DECISION's pending decisions or UNSUPPORTED's capabilities (tokens), recorded with the edge
  finding_codes               jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(finding_codes) = 'array' AND jsonb_array_length(finding_codes) <= 64),
  terminal_reason             text CHECK (terminal_reason IS NULL OR kauro.is_token(terminal_reason)),
  profiling_at                timestamptz,
  interpreting_at             timestamptz,
  validating_at               timestamptz,
  terminal_at                 timestamptz,
  created_at                  timestamptz NOT NULL,
  updated_at                  timestamptz NOT NULL,
  UNIQUE (agency_id, audit_id),
  CONSTRAINT audits_grant_binding UNIQUE (agency_id, audit_id, grant_id),
  -- one audit per grant, per (revision, target contract) for good — a retry or a failed audit is not a new free audit (D8-AUD-1)
  CONSTRAINT audits_one_per_grant UNIQUE (grant_id),
  CONSTRAINT audits_one_per_subject UNIQUE (agency_id, revision_id, target_contract_id),
  FOREIGN KEY (agency_id, grant_id) REFERENCES kauro.cost_grants (agency_id, grant_id),
  CONSTRAINT audits_revision_fk FOREIGN KEY (agency_id, project_id, revision_id, revision_hash) REFERENCES kauro.dataset_revisions (agency_id, project_id, revision_id, manifest_hash),
  CONSTRAINT audits_target_fk FOREIGN KEY (agency_id, project_id, target_contract_id, target_contract_hash) REFERENCES kauro.target_contracts (agency_id, project_id, contract_id, body_hash),
  FOREIGN KEY (agency_id, project_id) REFERENCES kauro.projects (agency_id, project_id),
  FOREIGN KEY (agency_id, requested_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id),
  CONSTRAINT audits_draft_plan_fk FOREIGN KEY (agency_id, draft_plan_id, project_id) REFERENCES kauro.plans (agency_id, plan_id, project_id),
  CONSTRAINT audits_absolute_window CHECK (absolute_deadline_at = started_at + interval '86400 seconds'),
  CONSTRAINT audits_interpretation_within_absolute CHECK (interpretation_deadline_at IS NULL OR interpretation_deadline_at <= absolute_deadline_at),
  CONSTRAINT audits_profile_recorded CHECK (
    (profile_evidence_hash IS NULL) = (candidate_manifest_hash IS NULL) AND (candidate_manifest_hash IS NULL) = (interpretation_deadline_at IS NULL)
    AND (state NOT IN ('INTERPRETING', 'VALIDATING', 'DRAFT_READY', 'NEEDS_DECISION', 'UNSUPPORTED') OR candidate_manifest_hash IS NOT NULL)
  ),
  CONSTRAINT audits_draft_ready_names_plan CHECK (state <> 'DRAFT_READY' OR draft_plan_id IS NOT NULL),
  CONSTRAINT audits_cancellation_recorded CHECK (
    (cancel_version = 0) = (cancel_actor_kind IS NULL) AND (cancel_actor_kind IS NULL) = (cancel_actor_id IS NULL)
    AND (state <> 'CANCELLED' OR cancel_version >= 1)
  ),
  CONSTRAINT audits_cancel_actor_shape CHECK (
    cancel_actor_kind IS NULL
    OR (cancel_actor_kind = 'USER' AND cancel_actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    OR (cancel_actor_kind = 'SERVICE' AND cancel_actor_id ~ '^[a-z][a-z0-9_-]{1,63}$')
  ),
  CONSTRAINT audits_terminal_explained CHECK (
    (state IN ('DRAFT_READY', 'NEEDS_DECISION', 'UNSUPPORTED', 'FAILED', 'CANCELLED', 'EXPIRED')) = (terminal_at IS NOT NULL)
    AND (state NOT IN ('FAILED', 'CANCELLED', 'EXPIRED')) = (terminal_reason IS NULL)
    AND (state NOT IN ('NEEDS_DECISION', 'UNSUPPORTED') OR jsonb_array_length(finding_codes) >= 1)
  )
);
-- one live audit per agency (capacity.agencyAudits = 1; D8-AUD-1)
CREATE UNIQUE INDEX audits_one_live_per_agency ON kauro.audits (agency_id) WHERE state IN ('QUEUED', 'PROFILING', 'INTERPRETING', 'VALIDATING');
CREATE INDEX audits_deadlines ON kauro.audits (absolute_deadline_at) WHERE state IN ('QUEUED', 'PROFILING', 'INTERPRETING', 'VALIDATING');

CREATE TRIGGER audits_immutable BEFORE UPDATE ON kauro.audits
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('audit_id,agency_id,project_id,revision_id,revision_hash,target_contract_id,target_contract_hash,audit_policy_version,requested_by_membership_id,grant_id,started_at,absolute_deadline_at,created_at');
CREATE TRIGGER audits_initial_state BEFORE INSERT ON kauro.audits
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('Audit');
CREATE TRIGGER audits_learned_once BEFORE UPDATE ON kauro.audits
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('interpretation_deadline_at,profile_evidence_hash,candidate_manifest_hash,draft_plan_id,cancel_actor_kind,cancel_actor_id,terminal_reason,profiling_at,interpreting_at,validating_at,terminal_at');
CREATE TRIGGER audits_transition BEFORE UPDATE OF state ON kauro.audits
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('Audit');
-- the fence is the steps' bookkeeping and changes without a version (like a job's fence, 0021)
CREATE TRIGGER audits_version BEFORE UPDATE ON kauro.audits
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump('fence');

-- The audit's workflow guard (D8-AUD-1..4, D8-GRANT-1, D8-CANCEL-1, D8-DL-1, D8-CLOCK-1): stamps its instants and deadlines with the
-- server's transaction time and refuses, at the edge, what the database can decide now.
CREATE OR REPLACE FUNCTION kauro.audits_workflow() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  clock timestamptz := kauro.server_now();
  g record;
  s record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- the sealed revision and the confirmed, current target after their shared transition locks (B06 D-TX-2): a supersession or an
    -- expiry in flight is ordered before the audit (and read) or after it (and then cancels it through EXECUTION_CONTROL)
    PERFORM kauro.await_transition('kauro.dataset_revisions', NEW.revision_id::text);
    PERFORM kauro.await_transition('kauro.target_contracts', NEW.target_contract_id::text);
    IF NOT EXISTS (SELECT 1 FROM kauro.dataset_revisions r WHERE r.agency_id = NEW.agency_id AND r.revision_id = NEW.revision_id AND r.state = 'SEALED') THEN
      RAISE EXCEPTION 'AUDIT_AUTHORITY: revision % is not SEALED and is audited by nobody', NEW.revision_id USING ERRCODE = 'KA081';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM kauro.target_contracts t
       WHERE t.agency_id = NEW.agency_id AND t.contract_id = NEW.target_contract_id AND t.confirmed_at IS NOT NULL AND t.superseded_at IS NULL
    ) THEN
      RAISE EXCEPTION 'AUDIT_AUTHORITY: target contract % is not confirmed and current', NEW.target_contract_id USING ERRCODE = 'KA081';
    END IF;
    -- R2-044: the audit is funded by an AUTHORIZED, unexpired AUDIT grant of its agency — whose ceiling its pool holds since its
    -- authorization — with room under its ceiling; sealing funds nothing (D8-GRANT-1)
    SELECT c.grant_kind, c.state, c.expires_at, c.ceiling_cents, c.reserved_cents, c.reconciled_spend_cents INTO g
      FROM kauro.cost_grants c WHERE c.agency_id = NEW.agency_id AND c.grant_id = NEW.grant_id;
    IF NOT FOUND OR g.grant_kind <> 'AUDIT' OR g.state <> 'AUTHORIZED' OR g.expires_at <= clock
       OR g.reserved_cents + g.reconciled_spend_cents >= g.ceiling_cents THEN
      RAISE EXCEPTION 'NO_FUNDED_GRANT: audit % commits only with a reservation on an AUTHORIZED, unexpired grant with room under its ceiling', NEW.audit_id USING ERRCODE = 'KA083';
    END IF;
    IF NEW.version <> 1 OR NEW.fence <> 0 OR NEW.cancel_version <> 0 OR NEW.cancel_actor_kind IS NOT NULL OR NEW.profile_evidence_hash IS NOT NULL
       OR NEW.candidate_manifest_hash IS NOT NULL OR NEW.draft_plan_id IS NOT NULL OR NEW.terminal_reason IS NOT NULL OR jsonb_array_length(NEW.finding_codes) <> 0 THEN
      RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % is born QUEUED at version 1 with nothing claimed or recorded', NEW.audit_id USING ERRCODE = 'KA081';
    END IF;
    NEW.started_at := clock;
    NEW.absolute_deadline_at := clock + interval '86400 seconds';
    NEW.interpretation_deadline_at := NULL;
    NEW.profiling_at := NULL; NEW.interpreting_at := NULL; NEW.validating_at := NULL; NEW.terminal_at := NULL;
    NEW.created_at := clock;
    NEW.updated_at := clock;
    RETURN NEW;
  END IF;

  NEW.updated_at := clock;
  IF NEW.fence IS DISTINCT FROM OLD.fence AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'AUDIT_FENCE: audit % takes its fence through its steps only', OLD.audit_id USING ERRCODE = 'KA080';
  END IF;
  -- the cancellation version moves exactly with cancellation_wins, by one (D8-CANCEL-1)
  IF NEW.state = 'CANCELLED' AND OLD.state IS DISTINCT FROM 'CANCELLED' THEN
    IF NEW.cancel_version <> OLD.cancel_version + 1 OR NEW.cancel_actor_kind IS NULL THEN
      RAISE EXCEPTION 'AUDIT_AUTHORITY: cancellation_wins of audit % records its actor and cancel version %', OLD.audit_id, OLD.cancel_version + 1 USING ERRCODE = 'KA081';
    END IF;
  ELSIF NEW.cancel_version IS DISTINCT FROM OLD.cancel_version THEN
    RAISE EXCEPTION 'AUDIT_AUTHORITY: the cancellation version of audit % moves only with cancellation_wins', OLD.audit_id USING ERRCODE = 'KA081';
  END IF;
  -- what an edge records is recorded with that edge only
  IF (NEW.profile_evidence_hash IS DISTINCT FROM OLD.profile_evidence_hash OR NEW.candidate_manifest_hash IS DISTINCT FROM OLD.candidate_manifest_hash
      OR NEW.interpretation_deadline_at IS DISTINCT FROM OLD.interpretation_deadline_at)
     AND NOT (OLD.state = 'PROFILING' AND NEW.state = 'INTERPRETING') THEN
    RAISE EXCEPTION 'AUDIT_FENCE: audit % records its profile evidence with profile_and_candidates_complete only', OLD.audit_id USING ERRCODE = 'KA080';
  END IF;
  IF NEW.draft_plan_id IS DISTINCT FROM OLD.draft_plan_id AND NOT (OLD.state = 'VALIDATING' AND NEW.state = 'DRAFT_READY') THEN
    RAISE EXCEPTION 'AUDIT_FENCE: audit % names its draft with DRAFT_READY only', OLD.audit_id USING ERRCODE = 'KA080';
  END IF;
  IF NEW.finding_codes IS DISTINCT FROM OLD.finding_codes AND NOT (NEW.state IN ('NEEDS_DECISION', 'UNSUPPORTED') AND OLD.state IS DISTINCT FROM NEW.state) THEN
    RAISE EXCEPTION 'AUDIT_FENCE: audit % records its findings with NEEDS_DECISION or UNSUPPORTED only', OLD.audit_id USING ERRCODE = 'KA080';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.finding_codes) f WHERE jsonb_typeof(f) <> 'string' OR NOT kauro.is_token(f #>> '{}')) THEN
    RAISE EXCEPTION 'AUDIT_FENCE: audit % names its findings as tokens only', OLD.audit_id USING ERRCODE = 'KA080';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NEW.state IN ('DRAFT_READY', 'NEEDS_DECISION', 'UNSUPPORTED', 'FAILED', 'CANCELLED', 'EXPIRED') THEN
      NEW.terminal_at := clock;
    END IF;
    IF NEW.state = 'EXPIRED' THEN
      -- absolute_deadline on the server clock, never early (D8-DL-1)
      IF clock < OLD.absolute_deadline_at THEN
        RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % reaches its absolute deadline no earlier than it', OLD.audit_id USING ERRCODE = 'KA081';
      END IF;
    ELSIF NEW.state <> 'CANCELLED' THEN
      -- every orchestration edge before the absolute deadline (D8-AUD-4), from the step of its kind under the audit's current fence
      IF clock >= OLD.absolute_deadline_at THEN
        RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % is past its absolute deadline; only absolute_deadline remains', OLD.audit_id USING ERRCODE = 'KA081';
      END IF;
      SELECT st.kind, st.outcome INTO s FROM kauro.audit_steps st WHERE st.agency_id = OLD.agency_id AND st.audit_id = OLD.audit_id AND st.fence = OLD.fence;
      IF NOT coalesce(
           (OLD.state = 'QUEUED' AND NEW.state = 'PROFILING' AND s.kind = 'PROFILE' AND s.outcome IS NULL)
        OR (OLD.state = 'PROFILING' AND s.kind = 'PROFILE' AND s.outcome = CASE NEW.state WHEN 'INTERPRETING' THEN 'COMPLETED' ELSE NEW.state END)
        OR (OLD.state = 'INTERPRETING' AND s.kind = 'INTERPRET' AND s.outcome = CASE NEW.state WHEN 'VALIDATING' THEN 'COMPILED' ELSE NEW.state END)
        OR (OLD.state = 'VALIDATING' AND s.kind = 'VALIDATE' AND s.outcome = CASE NEW.state WHEN 'DRAFT_READY' THEN 'VALID' ELSE NEW.state END),
        false
      ) THEN
        RAISE EXCEPTION 'AUDIT_FENCE: audit % moves % -> % only from the step recorded under its current fence %', OLD.audit_id, OLD.state, NEW.state, OLD.fence USING ERRCODE = 'KA080';
      END IF;
      IF NEW.state = 'PROFILING' THEN
        NEW.profiling_at := clock;
      ELSIF NEW.state = 'INTERPRETING' THEN
        IF NEW.profile_evidence_hash IS NULL OR NEW.candidate_manifest_hash IS NULL THEN
          RAISE EXCEPTION 'AUDIT_FENCE: audit % interprets only with its profile evidence and complete candidate manifest', OLD.audit_id USING ERRCODE = 'KA080';
        END IF;
        NEW.interpreting_at := clock;
        NEW.interpretation_deadline_at := least(clock + interval '1200 seconds', OLD.absolute_deadline_at);
      ELSIF NEW.state = 'VALIDATING' THEN
        NEW.validating_at := clock;
      END IF;
    END IF;
    IF (NEW.state IN ('FAILED', 'CANCELLED', 'EXPIRED')) <> (NEW.terminal_reason IS NOT NULL) THEN
      RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % names the reason of a failure, a cancellation or an expiry, and of nothing else', OLD.audit_id USING ERRCODE = 'KA081';
    END IF;
  ELSIF NEW.terminal_reason IS DISTINCT FROM OLD.terminal_reason THEN
    RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % records its terminal reason with its terminal edge', OLD.audit_id USING ERRCODE = 'KA081';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER audits_workflow BEFORE INSERT OR UPDATE ON kauro.audits
  FOR EACH ROW EXECUTE FUNCTION kauro.audits_workflow();

CREATE CONSTRAINT TRIGGER audits_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.audits
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('audit', 'audit_id');
CREATE CONSTRAINT TRIGGER audits_event_type_per_version AFTER INSERT OR UPDATE OF version ON kauro.audits
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_state_event_type('audit', 'audit_id');

INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES ('audit', 'audits', 'audit_id', 'B08');

-- --- the audit's steps (D8-AUD-2; evidence rows of the audit, D8-EVT-1) --------------------------------------------------------------
CREATE TABLE kauro.audit_steps (
  step_id         uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(step_id)),
  agency_id       uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  audit_id        uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('PROFILE', 'INTERPRET', 'VALIDATE')),
  fence           bigint NOT NULL CHECK (fence >= 1),
  outcome         text CHECK (outcome IS NULL OR kauro.is_token(outcome)),
  evidence_hash   text CHECK (evidence_hash IS NULL OR kauro.is_sha256_hex(evidence_hash)),
  evidence_class  text CHECK (evidence_class IS NULL OR evidence_class IN ('EXECUTED_LOCAL', 'SIMULATED')),
  claimed_at      timestamptz NOT NULL,
  recorded_at     timestamptz,
  UNIQUE (agency_id, step_id),
  CONSTRAINT audit_steps_fence_once UNIQUE (audit_id, fence),
  FOREIGN KEY (agency_id, audit_id) REFERENCES kauro.audits (agency_id, audit_id),
  CONSTRAINT audit_steps_outcome_of_kind CHECK (
    outcome IS NULL
    OR (kind = 'PROFILE' AND outcome IN ('COMPLETED', 'FAILED'))
    OR (kind = 'INTERPRET' AND outcome IN ('COMPILED', 'NEEDS_DECISION', 'UNSUPPORTED', 'FAILED'))
    OR (kind = 'VALIDATE' AND outcome IN ('VALID', 'NEEDS_DECISION', 'FAILED'))
  ),
  CONSTRAINT audit_steps_recorded CHECK ((outcome IS NULL) = (recorded_at IS NULL) AND (outcome IS NULL) = (evidence_class IS NULL))
);
CREATE INDEX audit_steps_by_audit ON kauro.audit_steps (agency_id, audit_id, fence);
CREATE TRIGGER audit_steps_immutable BEFORE UPDATE ON kauro.audit_steps
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('step_id,agency_id,audit_id,kind,fence,claimed_at');
CREATE TRIGGER audit_steps_learned_once BEFORE UPDATE ON kauro.audit_steps
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('outcome,evidence_hash,evidence_class,recorded_at');

-- A claim takes the audit's next fence in the phase of its kind, before the absolute deadline; a result is recorded once, only by the
-- step at the audit's current fence, in its phase, before the absolute deadline (KA080 for a stale fence, KA081 for a lost phase). The
-- audit row is read under its row lock, so a claim, a record and a cancellation of one audit are ordered.
CREATE OR REPLACE FUNCTION kauro.audit_steps_workflow() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  clock timestamptz := kauro.server_now();
  a record;
  phase boolean;
BEGIN
  SELECT x.state, x.fence, x.absolute_deadline_at INTO a FROM kauro.audits x WHERE x.agency_id = NEW.agency_id AND x.audit_id = NEW.audit_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTEXT: audit % is not visible in this transaction', NEW.audit_id USING ERRCODE = 'KA006';
  END IF;
  phase := (NEW.kind = 'PROFILE' AND a.state IN ('QUEUED', 'PROFILING')) OR (NEW.kind = 'INTERPRET' AND a.state = 'INTERPRETING') OR (NEW.kind = 'VALIDATE' AND a.state = 'VALIDATING');
  IF TG_OP = 'INSERT' THEN
    IF NEW.fence <> a.fence + 1 THEN
      RAISE EXCEPTION 'AUDIT_FENCE: a step of audit % claims fence %, not %', NEW.audit_id, a.fence + 1, NEW.fence USING ERRCODE = 'KA080';
    END IF;
    IF NOT phase OR clock >= a.absolute_deadline_at THEN
      RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % is % and takes no % step', NEW.audit_id, a.state, NEW.kind USING ERRCODE = 'KA081';
    END IF;
    IF NEW.outcome IS NOT NULL OR NEW.evidence_hash IS NOT NULL OR NEW.evidence_class IS NOT NULL THEN
      RAISE EXCEPTION 'AUDIT_FENCE: a step of audit % is born with nothing recorded', NEW.audit_id USING ERRCODE = 'KA080';
    END IF;
    NEW.claimed_at := clock;
    NEW.recorded_at := NULL;
    RETURN NEW;
  END IF;
  IF NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash OR NEW.evidence_class IS DISTINCT FROM OLD.evidence_class THEN
    IF OLD.fence <> a.fence THEN
      RAISE EXCEPTION 'AUDIT_FENCE: step % at fence % is stale; audit % is at fence %', OLD.step_id, OLD.fence, OLD.audit_id, a.fence USING ERRCODE = 'KA080';
    END IF;
    IF NOT phase OR a.state = 'QUEUED' OR clock >= a.absolute_deadline_at THEN
      RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % is % and records no % result', OLD.audit_id, a.state, OLD.kind USING ERRCODE = 'KA081';
    END IF;
    NEW.recorded_at := clock;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER audit_steps_workflow BEFORE INSERT OR UPDATE ON kauro.audit_steps
  FOR EACH ROW EXECUTE FUNCTION kauro.audit_steps_workflow();

-- the audit's fence follows its claims (a trigger level deeper than the client's statement; D8-AUD-2)
CREATE OR REPLACE FUNCTION kauro.audit_steps_claim_fence() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  UPDATE kauro.audits SET fence = NEW.fence WHERE agency_id = NEW.agency_id AND audit_id = NEW.audit_id;
  RETURN NULL;
END
$$;
CREATE TRIGGER audit_steps_claim_fence AFTER INSERT ON kauro.audit_steps
  FOR EACH ROW EXECUTE FUNCTION kauro.audit_steps_claim_fence();

-- DRAFT_READY commits only under the current fence and before the absolute deadline, with the system draft — created by the audit's
-- requester — VALIDATED under a VALID receipt of exactly the audit's revision and target and of the draft's own body (D8-AUD-4; KA080,
-- KA081). Checked at COMMIT, after the draft's validation settled in the same unit or earlier; a later receipt after CANCELLED or
-- EXPIRED stays evidence, since both are terminal.
CREATE OR REPLACE FUNCTION kauro.audits_draft_ready_bound() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.audit_steps s
     WHERE s.agency_id = NEW.agency_id AND s.audit_id = NEW.audit_id AND s.fence = NEW.fence AND s.kind = 'VALIDATE' AND s.outcome = 'VALID'
  ) THEN
    RAISE EXCEPTION 'AUDIT_FENCE: audit % is DRAFT_READY only from the VALID validation of its current fence', NEW.audit_id USING ERRCODE = 'KA080';
  END IF;
  IF kauro.server_now() >= NEW.absolute_deadline_at OR NOT EXISTS (
    SELECT 1 FROM kauro.plans p
      JOIN kauro.validation_receipts r ON r.agency_id = p.agency_id AND r.plan_id = p.plan_id AND r.receipt_hash = p.validation_receipt_hash
     WHERE p.agency_id = NEW.agency_id AND p.plan_id = NEW.draft_plan_id AND p.project_id = NEW.project_id AND p.state = 'VALIDATED'
       AND p.created_by_membership_id = NEW.requested_by_membership_id
       AND p.revision_hash = NEW.revision_hash AND p.target_contract_hash = NEW.target_contract_hash
       AND r.result = 'VALID' AND r.plan_hash = p.body_hash AND r.revision_hash = NEW.revision_hash AND r.target_contract_hash = NEW.target_contract_hash
  ) THEN
    RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % is DRAFT_READY only before its absolute deadline with its system draft VALIDATED under a VALID receipt of exactly its revision and target', NEW.audit_id USING ERRCODE = 'KA081';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER audits_draft_ready_bound AFTER UPDATE ON kauro.audits
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state = 'DRAFT_READY' AND OLD.state IS DISTINCT FROM 'DRAFT_READY')
  EXECUTE FUNCTION kauro.audits_draft_ready_bound();

-- --- model tasks (registry contract ModelTask; D8-AUD-3) ----------------------------------------------------------------------------
-- A logical model task of an audit, planned by its INTERPRET step: its dispatch attempts are rows of B06's request_journal with this
-- task id, each at a fence of the task's MODEL_TASK lease, each reserving on the audit's grant (request_journal_reserves_grant).
-- The candidate set and policy are part of its idempotency identity. Append-only.
CREATE TABLE kauro.model_tasks (
  model_task_id               uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(model_task_id)),
  agency_id                   uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  audit_id                    uuid NOT NULL,
  grant_id                    uuid NOT NULL,
  step_fence                  bigint NOT NULL CHECK (step_fence >= 1),
  task_key                    text NOT NULL CHECK (kauro.is_sha256_hex(task_key)),
  candidate_manifest_hash     text NOT NULL CHECK (kauro.is_sha256_hex(candidate_manifest_hash)),
  policy_hash                 text NOT NULL CHECK (kauro.is_sha256_hex(policy_hash)),
  minimized_request_hash      text NOT NULL CHECK (kauro.is_sha256_hex(minimized_request_hash)),
  provider_profile_id         uuid NOT NULL,
  maximum_cost_cents          bigint NOT NULL CHECK (maximum_cost_cents > 0),
  interpretation_deadline_at  timestamptz NOT NULL,
  audit_deadline_at           timestamptz NOT NULL,
  created_at                  timestamptz NOT NULL,
  UNIQUE (agency_id, model_task_id),
  CONSTRAINT model_tasks_one_per_key UNIQUE (audit_id, task_key),
  CONSTRAINT model_tasks_audit_grant_fk FOREIGN KEY (agency_id, audit_id, grant_id) REFERENCES kauro.audits (agency_id, audit_id, grant_id)
);
CREATE TRIGGER model_tasks_append_only BEFORE UPDATE OR DELETE ON kauro.model_tasks
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- A task is planned by the INTERPRET step at the audit's current fence, over the audit's own candidate manifest, before the
-- interpretation deadline, within its grant's ceiling; its deadlines are the audit's (KA080, KA081, KA083).
CREATE OR REPLACE FUNCTION kauro.model_tasks_current_step() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  clock timestamptz := kauro.server_now();
  a record;
BEGIN
  SELECT x.state, x.fence, x.candidate_manifest_hash, x.interpretation_deadline_at, x.absolute_deadline_at, g.ceiling_cents INTO a
    FROM kauro.audits x JOIN kauro.cost_grants g ON g.grant_id = x.grant_id
   WHERE x.agency_id = NEW.agency_id AND x.audit_id = NEW.audit_id AND x.grant_id = NEW.grant_id FOR SHARE OF x;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTEXT: audit % is not visible in this transaction', NEW.audit_id USING ERRCODE = 'KA006';
  END IF;
  IF a.state IS DISTINCT FROM 'INTERPRETING' OR clock >= a.interpretation_deadline_at THEN
    RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % is % and plans no new model task', NEW.audit_id, a.state USING ERRCODE = 'KA081';
  END IF;
  IF NEW.step_fence <> a.fence OR NOT EXISTS (
    SELECT 1 FROM kauro.audit_steps s WHERE s.agency_id = NEW.agency_id AND s.audit_id = NEW.audit_id AND s.fence = NEW.step_fence AND s.kind = 'INTERPRET' AND s.outcome IS NULL
  ) OR NEW.candidate_manifest_hash IS DISTINCT FROM a.candidate_manifest_hash THEN
    RAISE EXCEPTION 'AUDIT_FENCE: a model task of audit % is planned by the INTERPRET step of its current fence over its own candidate manifest', NEW.audit_id USING ERRCODE = 'KA080';
  END IF;
  IF NEW.maximum_cost_cents > a.ceiling_cents THEN
    RAISE EXCEPTION 'NO_FUNDED_GRANT: a model task of audit % costs at most its grant''s ceiling', NEW.audit_id USING ERRCODE = 'KA083';
  END IF;
  NEW.interpretation_deadline_at := a.interpretation_deadline_at;
  NEW.audit_deadline_at := a.absolute_deadline_at;
  NEW.created_at := clock;
  RETURN NEW;
END
$$;
CREATE TRIGGER model_tasks_current_step BEFORE INSERT ON kauro.model_tasks
  FOR EACH ROW EXECUTE FUNCTION kauro.model_tasks_current_step();

-- --- the core's journal (ModelTaskJournalPort; D8-AUD-3, D8-PORT-3) ------------------------------------------------------------------
-- The fenced log the Intelligence core dispatches under: opaque events (the core's own LedgerEvent, canonical JSON of references and
-- hashes), appended at exactly the run's length by the INTERPRET step at its audit's current fence. A run belongs to one audit.
-- Append-only (decision D8-PAU-2).
CREATE TABLE kauro.model_task_journal (
  run_id       uuid NOT NULL,
  position     integer NOT NULL CHECK (position >= 0 AND position < 100000),
  agency_id    uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  audit_id     uuid NOT NULL,
  step_fence   bigint NOT NULL CHECK (step_fence >= 1),
  event        jsonb NOT NULL CHECK (jsonb_typeof(event) = 'object' AND pg_column_size(event) <= 65536),
  event_hash   text NOT NULL CHECK (kauro.is_sha256_hex(event_hash)),
  appended_at  timestamptz NOT NULL,
  PRIMARY KEY (run_id, position),
  FOREIGN KEY (agency_id, audit_id) REFERENCES kauro.audits (agency_id, audit_id)
);
CREATE TRIGGER model_task_journal_append_only BEFORE UPDATE OR DELETE ON kauro.model_task_journal
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

CREATE OR REPLACE FUNCTION kauro.model_task_journal_fenced() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  a record;
BEGIN
  SELECT x.state, x.fence INTO a FROM kauro.audits x WHERE x.agency_id = NEW.agency_id AND x.audit_id = NEW.audit_id FOR SHARE;
  IF a.state IS DISTINCT FROM 'INTERPRETING' OR NEW.step_fence IS DISTINCT FROM a.fence OR NOT EXISTS (
    SELECT 1 FROM kauro.audit_steps s WHERE s.agency_id = NEW.agency_id AND s.audit_id = NEW.audit_id AND s.fence = NEW.step_fence AND s.kind = 'INTERPRET'
  ) THEN
    RAISE EXCEPTION 'AUDIT_FENCE: the journal of audit % is appended by the INTERPRET step of its current fence only', NEW.audit_id USING ERRCODE = 'KA080';
  END IF;
  IF EXISTS (SELECT 1 FROM kauro.model_task_journal j WHERE j.run_id = NEW.run_id AND j.audit_id IS DISTINCT FROM NEW.audit_id) THEN
    RAISE EXCEPTION 'AUDIT_FENCE: run % belongs to another audit', NEW.run_id USING ERRCODE = 'KA080';
  END IF;
  IF NEW.position <> (SELECT count(*) FROM kauro.model_task_journal j WHERE j.run_id = NEW.run_id) THEN
    RAISE EXCEPTION 'AUDIT_FENCE: run % is appended at its length only', NEW.run_id USING ERRCODE = 'KA080';
  END IF;
  NEW.appended_at := kauro.server_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER model_task_journal_fenced BEFORE INSERT ON kauro.model_task_journal
  FOR EACH ROW EXECUTE FUNCTION kauro.model_task_journal_fenced();

-- --- decision artifacts (the content-idempotent intake of D8-PLAN-1) ------------------------------------------------------------------
-- An agency's closed decision document for an audit — CMD022's candidate decisions, CMD023's typed patch — stored once per content
-- (KAURO_DECISION_ARTIFACT_V1 over kind and document); B06's ArtifactResolver resolves CMD023's reference here. Append-only.
CREATE TABLE kauro.decision_artifacts (
  artifact_id               uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(artifact_id)),
  agency_id                 uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  audit_id                  uuid NOT NULL,
  kind                      text NOT NULL CHECK (kind IN ('CANDIDATE_DECISIONS', 'DECISION_PATCH')),
  document                  jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object' AND pg_column_size(document) <= 262144),
  content_hash              text NOT NULL CHECK (kauro.is_sha256_hex(content_hash)),
  created_by_membership_id  uuid NOT NULL,
  created_at                timestamptz NOT NULL,
  UNIQUE (agency_id, artifact_id),
  CONSTRAINT decision_artifacts_content_once UNIQUE (agency_id, audit_id, kind, content_hash),
  FOREIGN KEY (agency_id, audit_id) REFERENCES kauro.audits (agency_id, audit_id),
  FOREIGN KEY (agency_id, created_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id)
);
CREATE TRIGGER decision_artifacts_append_only BEFORE UPDATE OR DELETE ON kauro.decision_artifacts
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE OR REPLACE FUNCTION kauro.decision_artifacts_stamp() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  NEW.created_at := kauro.server_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER decision_artifacts_stamp BEFORE INSERT ON kauro.decision_artifacts
  FOR EACH ROW EXECUTE FUNCTION kauro.decision_artifacts_stamp();

-- --- plans' validation intents (D8-PLAN-2) -------------------------------------------------------------------------------------------
-- ValidatePlan's intent (CMD024, the request handlers) or an audit's system draft's (the control plane): the plan's n-th intent, over
-- exactly its body, source and target, settled once with the receipt the validator recorded. Only the plan's latest intent moves it.
CREATE TABLE kauro.plan_validations (
  validation_id               uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(validation_id)),
  agency_id                   uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  plan_id                     uuid NOT NULL,
  plan_hash                   text NOT NULL CHECK (kauro.is_sha256_hex(plan_hash)),
  revision_hash               text NOT NULL CHECK (kauro.is_sha256_hex(revision_hash)),
  target_contract_hash        text NOT NULL CHECK (kauro.is_sha256_hex(target_contract_hash)),
  fence                       bigint NOT NULL CHECK (fence >= 1),
  origin                      text NOT NULL CHECK (origin IN ('COMMAND', 'AUDIT')),
  requested_by_membership_id  uuid,
  audit_id                    uuid,
  requested_at                timestamptz NOT NULL,
  result                      text CHECK (result IS NULL OR result IN ('VALID', 'INVALID', 'CANCELLED', 'ERROR')),
  receipt_hash                text CHECK (receipt_hash IS NULL OR kauro.is_sha256_hex(receipt_hash)),
  settled_at                  timestamptz,
  UNIQUE (agency_id, validation_id),
  CONSTRAINT plan_validations_fence_once UNIQUE (plan_id, fence),
  FOREIGN KEY (agency_id, plan_id, plan_hash, revision_hash, target_contract_hash) REFERENCES kauro.plans (agency_id, plan_id, body_hash, revision_hash, target_contract_hash),
  CONSTRAINT plan_validations_receipt_fk FOREIGN KEY (agency_id, plan_id, receipt_hash, plan_hash, revision_hash, target_contract_hash)
    REFERENCES kauro.validation_receipts (agency_id, plan_id, receipt_hash, plan_hash, revision_hash, target_contract_hash),
  FOREIGN KEY (agency_id, requested_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id),
  FOREIGN KEY (agency_id, audit_id) REFERENCES kauro.audits (agency_id, audit_id),
  CONSTRAINT plan_validations_origin CHECK ((origin = 'COMMAND') = (requested_by_membership_id IS NOT NULL) AND (origin = 'AUDIT') = (audit_id IS NOT NULL)),
  CONSTRAINT plan_validations_settled CHECK (
    (result IS NULL) = (settled_at IS NULL) AND (result NOT IN ('VALID', 'INVALID') OR receipt_hash IS NOT NULL) AND (result IS NOT NULL OR receipt_hash IS NULL)
  )
);
CREATE TRIGGER plan_validations_immutable BEFORE UPDATE ON kauro.plan_validations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('validation_id,agency_id,plan_id,plan_hash,revision_hash,target_contract_hash,fence,origin,requested_by_membership_id,audit_id,requested_at');
CREATE TRIGGER plan_validations_learned_once BEFORE UPDATE ON kauro.plan_validations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('result,receipt_hash,settled_at');

-- An intent is the plan's next fence, recorded while the plan still requires validation (validation_admitted follows it in the same
-- unit), under the plan's row lock; an audit's intent names a live audit of the plan's own subject. Its settlement names a receipt of
-- the same result, once.
CREATE OR REPLACE FUNCTION kauro.plan_validations_workflow() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  clock timestamptz := kauro.server_now();
  p record;
  receipt_result text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT x.state, x.project_id INTO p FROM kauro.plans x WHERE x.agency_id = NEW.agency_id AND x.plan_id = NEW.plan_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CONTEXT: plan % is not visible in this transaction', NEW.plan_id USING ERRCODE = 'KA006';
    END IF;
    IF p.state IS DISTINCT FROM 'VALIDATION_REQUIRED' THEN
      RAISE EXCEPTION 'AUDIT_AUTHORITY: plan % is % and admits no validation intent', NEW.plan_id, p.state USING ERRCODE = 'KA081';
    END IF;
    IF NEW.fence <> 1 + coalesce((SELECT max(v.fence) FROM kauro.plan_validations v WHERE v.agency_id = NEW.agency_id AND v.plan_id = NEW.plan_id), 0) THEN
      RAISE EXCEPTION 'AUDIT_FENCE: a validation intent of plan % takes its next fence', NEW.plan_id USING ERRCODE = 'KA080';
    END IF;
    IF NEW.origin = 'AUDIT' AND NOT EXISTS (
      SELECT 1 FROM kauro.audits a
       WHERE a.agency_id = NEW.agency_id AND a.audit_id = NEW.audit_id AND a.project_id = p.project_id AND a.state IN ('INTERPRETING', 'VALIDATING')
         AND a.revision_hash = NEW.revision_hash AND a.target_contract_hash = NEW.target_contract_hash
    ) THEN
      RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % validates no draft of another subject or after it ended', NEW.audit_id USING ERRCODE = 'KA081';
    END IF;
    IF NEW.result IS NOT NULL OR NEW.receipt_hash IS NOT NULL THEN
      RAISE EXCEPTION 'AUDIT_FENCE: a validation intent of plan % is born unsettled', NEW.plan_id USING ERRCODE = 'KA080';
    END IF;
    NEW.requested_at := clock;
    NEW.settled_at := NULL;
    RETURN NEW;
  END IF;
  IF NEW.result IS DISTINCT FROM OLD.result THEN
    IF NEW.receipt_hash IS NOT NULL THEN
      SELECT r.result INTO receipt_result FROM kauro.validation_receipts r WHERE r.agency_id = OLD.agency_id AND r.plan_id = OLD.plan_id AND r.receipt_hash = NEW.receipt_hash;
      IF receipt_result IS DISTINCT FROM NEW.result THEN
        RAISE EXCEPTION 'AUDIT_FENCE: intent % settles with the result its receipt records', OLD.validation_id USING ERRCODE = 'KA080';
      END IF;
    END IF;
    NEW.settled_at := clock;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER plan_validations_workflow BEFORE INSERT OR UPDATE ON kauro.plan_validations
  FOR EACH ROW EXECUTE FUNCTION kauro.plan_validations_workflow();

-- A plan under validation intents moves only by its latest one (D8-PLAN-2): validation_admitted with the intent recorded in this very
-- unit, valid_receipt with the latest intent settled VALID on the receipt the plan binds, invalid_receipt_result with it settled otherwise
-- (KA080). A plan without any intent (B06's own paths) is untouched.
CREATE OR REPLACE FUNCTION kauro.plans_validation_intent() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  cur record;
BEGIN
  SELECT v.result, v.receipt_hash, v.requested_at INTO cur FROM kauro.plan_validations v
   WHERE v.agency_id = OLD.agency_id AND v.plan_id = OLD.plan_id ORDER BY v.fence DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF (OLD.state = 'VALIDATION_REQUIRED' AND NEW.state = 'VALIDATING' AND (cur.result IS NOT NULL OR cur.requested_at <> kauro.server_now()))
     OR (OLD.state = 'VALIDATING' AND NEW.state = 'VALIDATED' AND (cur.result IS DISTINCT FROM 'VALID' OR cur.receipt_hash IS DISTINCT FROM NEW.validation_receipt_hash))
     OR (OLD.state = 'VALIDATING' AND NEW.state = 'VALIDATION_REQUIRED' AND (cur.result IS NULL OR cur.result = 'VALID')) THEN
    RAISE EXCEPTION 'AUDIT_FENCE: plan % moves % -> % only by its current validation intent', OLD.plan_id, OLD.state, NEW.state USING ERRCODE = 'KA080';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER plans_validation_intent BEFORE UPDATE OF state ON kauro.plans
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state AND OLD.state IN ('VALIDATION_REQUIRED', 'VALIDATING')) EXECUTE FUNCTION kauro.plans_validation_intent();

-- --- the control plane's events of audits (D8-ROLE-2) ----------------------------------------------------------------------------------
-- The event types of edges only the control plane performs: the request handlers are refused every one of them (a restrictive policy
-- beside B06's), and kauro_control appends them — and the types it shares with the request handlers: a cancellation for a lost source,
-- a grant authorized again by reconciliation, and the plan events of its system drafts and validations — under a policy of its own.
CREATE OR REPLACE FUNCTION kauro.audit_control_event_types() RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT ARRAY[
     'audit.profiling.v1', 'audit.interpreting.v1', 'audit.validating.v1', 'audit.draft_ready.v1', 'audit.needs_decision.v1',
     'audit.unsupported.v1', 'audit.failed.v1', 'audit.expired.v1',
     'cost_grant.exhausted.v1', 'cost_grant.expired.v1', 'cost_grant.closed.v1'
   ]::text[] $$;

CREATE POLICY domain_events_control_audit ON kauro.domain_events FOR INSERT TO kauro_control
  WITH CHECK (
    agency_id = kauro.current_agency_id()
    AND actor_kind = 'SERVICE'
    AND split_part(event_type, '.', 1) = aggregate_kind
    AND (
      event_type = ANY (kauro.audit_control_event_types())
      OR event_type IN ('audit.cancelled.v1', 'cost_grant.authorized.v1', 'plan.created.v1', 'plan.validation_required.v1', 'plan.validating.v1', 'plan.validated.v1')
    )
  );
CREATE POLICY domain_events_tenant_not_audit_control ON kauro.domain_events AS RESTRICTIVE FOR INSERT TO kauro_app
  WITH CHECK (NOT (event_type = ANY (kauro.audit_control_event_types())));

-- --- row-level security and grants ------------------------------------------------------------------------------------------------
-- Request handlers (kauro_app): StartAudit's AUDIT grant, its pool reservation (the carve's hold, a trigger level deeper) and its audit;
-- CancelAudit's columns; the decision-artifact intake; ValidatePlan's intents — each as the acting person's own live operator
-- membership (AGENCY_OPERATOR: OWNER, ADMIN, OPERATOR). They read their tenant's audits, grants, artifacts and intents and the funded
-- pools' money, never a step, a model task or the core's journal (D8-ROLE-2). The control plane (kauro_control): funds the pools (Q8-1),
-- reads every grant and audit (the reconciliation and the deadlines sweep all agencies) and writes those of the agency it is bound to:
-- steps, model tasks, the journal, system draft plans and the validation edges of plans, the settlement of intents and the grants'
-- reconciliation (D8-ROLE-1). kauro_validator is unchanged: it records the receipts.
ALTER TABLE kauro.cost_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.cost_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY cost_grants_tenant_read ON kauro.cost_grants FOR SELECT TO kauro_app
  USING (agency_id = kauro.current_agency_id() OR grant_kind = 'PLATFORM_MONTHLY');
CREATE POLICY cost_grants_tenant_carve ON kauro.cost_grants FOR INSERT TO kauro_app
  WITH CHECK (agency_id = kauro.current_agency_id() AND grant_kind = 'AUDIT' AND state = 'PREPARED');
CREATE POLICY cost_grants_tenant_authorize ON kauro.cost_grants FOR UPDATE TO kauro_app
  USING (agency_id = kauro.current_agency_id() AND grant_kind = 'AUDIT' AND state = 'PREPARED')
  WITH CHECK (agency_id = kauro.current_agency_id() AND grant_kind = 'AUDIT' AND state = 'AUTHORIZED');
CREATE POLICY cost_grants_tenant_pool_hold ON kauro.cost_grants FOR UPDATE TO kauro_app
  USING (grant_kind = 'PLATFORM_MONTHLY' AND state = 'AUTHORIZED')
  WITH CHECK (grant_kind = 'PLATFORM_MONTHLY' AND state = 'AUTHORIZED');
CREATE POLICY cost_grants_control_read ON kauro.cost_grants FOR SELECT TO kauro_control USING (true);
CREATE POLICY cost_grants_control_fund ON kauro.cost_grants FOR INSERT TO kauro_control
  WITH CHECK (grant_kind = 'PLATFORM_MONTHLY' AND agency_id IS NULL AND state = 'PREPARED');
CREATE POLICY cost_grants_control_pool ON kauro.cost_grants FOR UPDATE TO kauro_control
  USING (grant_kind = 'PLATFORM_MONTHLY') WITH CHECK (grant_kind = 'PLATFORM_MONTHLY');
CREATE POLICY cost_grants_control_reconcile ON kauro.cost_grants FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.audits FORCE ROW LEVEL SECURITY;
CREATE POLICY audits_tenant_read ON kauro.audits FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY audits_tenant_start ON kauro.audits FOR INSERT TO kauro_app
  WITH CHECK (
    agency_id = kauro.current_agency_id() AND state = 'QUEUED'
    AND EXISTS (
      SELECT 1 FROM kauro.memberships m
       WHERE m.agency_id = audits.agency_id AND m.membership_id = audits.requested_by_membership_id
         AND m.user_id = kauro.current_user_id() AND m.state = 'ACTIVE' AND m.role IN ('OWNER', 'ADMIN', 'OPERATOR')
    )
  );
CREATE POLICY audits_tenant_cancel ON kauro.audits FOR UPDATE TO kauro_app
  USING (agency_id = kauro.current_agency_id())
  WITH CHECK (agency_id = kauro.current_agency_id() AND state = 'CANCELLED' AND cancel_actor_kind = 'USER' AND cancel_actor_id = kauro.current_user_id()::text);
CREATE POLICY audits_control_read ON kauro.audits FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY audits_control_update ON kauro.audits FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.audit_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.audit_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_steps_control_read ON kauro.audit_steps FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY audit_steps_control_claim ON kauro.audit_steps FOR INSERT TO kauro_control WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY audit_steps_control_record ON kauro.audit_steps FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.model_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.model_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY model_tasks_control_read ON kauro.model_tasks FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY model_tasks_control_plan ON kauro.model_tasks FOR INSERT TO kauro_control WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.model_task_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.model_task_journal FORCE ROW LEVEL SECURITY;
CREATE POLICY model_task_journal_control_read ON kauro.model_task_journal FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY model_task_journal_control_append ON kauro.model_task_journal FOR INSERT TO kauro_control WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.decision_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.decision_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY decision_artifacts_tenant_read ON kauro.decision_artifacts FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY decision_artifacts_tenant_intake ON kauro.decision_artifacts FOR INSERT TO kauro_app
  WITH CHECK (
    agency_id = kauro.current_agency_id()
    AND EXISTS (
      SELECT 1 FROM kauro.memberships m
       WHERE m.agency_id = decision_artifacts.agency_id AND m.membership_id = decision_artifacts.created_by_membership_id
         AND m.user_id = kauro.current_user_id() AND m.state = 'ACTIVE' AND m.role IN ('OWNER', 'ADMIN', 'OPERATOR')
    )
  );
CREATE POLICY decision_artifacts_control_read ON kauro.decision_artifacts FOR SELECT TO kauro_control USING (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.plan_validations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.plan_validations FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_validations_tenant_read ON kauro.plan_validations FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY plan_validations_tenant_request ON kauro.plan_validations FOR INSERT TO kauro_app
  WITH CHECK (
    agency_id = kauro.current_agency_id() AND origin = 'COMMAND'
    AND EXISTS (
      SELECT 1 FROM kauro.memberships m
       WHERE m.agency_id = plan_validations.agency_id AND m.membership_id = plan_validations.requested_by_membership_id
         AND m.user_id = kauro.current_user_id() AND m.state = 'ACTIVE' AND m.role IN ('OWNER', 'ADMIN', 'OPERATOR')
    )
  );
CREATE POLICY plan_validations_control_read ON kauro.plan_validations FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY plan_validations_control_draft ON kauro.plan_validations FOR INSERT TO kauro_control
  WITH CHECK (agency_id = kauro.current_agency_id() AND origin = 'AUDIT');
CREATE POLICY plan_validations_control_settle ON kauro.plan_validations FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

-- the control plane's system draft plans and the validation edges of plans (D8-ROLE-1, D8-AUD-4, D8-PLAN-2): a DRAFT of the subject of a
-- live audit of its agency created by the audit's requester, and the edges DRAFT -> VALIDATION_REQUIRED -> VALIDATING -> VALIDATED or
-- back to VALIDATION_REQUIRED — never an approval, a supersession or a withdrawal (B06's)
CREATE POLICY plans_control_system_draft ON kauro.plans FOR INSERT TO kauro_control
  WITH CHECK (
    agency_id = kauro.current_agency_id() AND state = 'DRAFT'
    AND EXISTS (
      SELECT 1 FROM kauro.audits a
       WHERE a.agency_id = plans.agency_id AND a.project_id = plans.project_id AND a.revision_hash = plans.revision_hash
         AND a.target_contract_hash = plans.target_contract_hash AND a.requested_by_membership_id = plans.created_by_membership_id
         AND a.state IN ('INTERPRETING', 'VALIDATING')
    )
  );
CREATE POLICY plans_control_validation ON kauro.plans FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id() AND state IN ('DRAFT', 'VALIDATION_REQUIRED', 'VALIDATING'))
  WITH CHECK (agency_id = kauro.current_agency_id() AND state IN ('VALIDATION_REQUIRED', 'VALIDATING', 'VALIDATED'));

GRANT SELECT ON kauro.cost_grants TO kauro_app, kauro_control;
GRANT INSERT (grant_id, agency_id, grant_kind, pool_grant_id, currency, ceiling_cents, price_profile_hash) ON kauro.cost_grants TO kauro_app;
GRANT UPDATE (version, state, authorization_ref, reserved_cents) ON kauro.cost_grants TO kauro_app;
GRANT INSERT (grant_id, grant_kind, currency, ceiling_cents, price_profile_hash, expires_at) ON kauro.cost_grants TO kauro_control;
GRANT UPDATE (version, state, authorization_ref, reserved_cents, reconciled_spend_cents) ON kauro.cost_grants TO kauro_control;
GRANT SELECT ON kauro.audits TO kauro_app, kauro_control;
GRANT INSERT (audit_id, agency_id, project_id, revision_id, revision_hash, target_contract_id, target_contract_hash, audit_policy_version, requested_by_membership_id, grant_id)
  ON kauro.audits TO kauro_app;
GRANT UPDATE (version, state, cancel_version, cancel_actor_kind, cancel_actor_id, terminal_reason) ON kauro.audits TO kauro_app;
GRANT UPDATE (
  version, state, fence, cancel_version, cancel_actor_kind, cancel_actor_id, terminal_reason, profile_evidence_hash, candidate_manifest_hash, draft_plan_id, finding_codes
) ON kauro.audits TO kauro_control;
GRANT SELECT ON kauro.audit_steps, kauro.model_tasks, kauro.model_task_journal TO kauro_control;
GRANT INSERT (step_id, agency_id, audit_id, kind, fence) ON kauro.audit_steps TO kauro_control;
GRANT UPDATE (outcome, evidence_hash, evidence_class) ON kauro.audit_steps TO kauro_control;
GRANT INSERT (
  model_task_id, agency_id, audit_id, grant_id, step_fence, task_key, candidate_manifest_hash, policy_hash, minimized_request_hash, provider_profile_id, maximum_cost_cents
) ON kauro.model_tasks TO kauro_control;
GRANT INSERT (run_id, position, agency_id, audit_id, step_fence, event, event_hash) ON kauro.model_task_journal TO kauro_control;
GRANT SELECT ON kauro.decision_artifacts TO kauro_app, kauro_control;
GRANT INSERT (artifact_id, agency_id, audit_id, kind, document, content_hash, created_by_membership_id) ON kauro.decision_artifacts TO kauro_app;
GRANT SELECT ON kauro.plan_validations TO kauro_app, kauro_control;
GRANT INSERT (validation_id, agency_id, plan_id, plan_hash, revision_hash, target_contract_hash, fence, origin, requested_by_membership_id) ON kauro.plan_validations TO kauro_app;
GRANT INSERT (validation_id, agency_id, plan_id, plan_hash, revision_hash, target_contract_hash, fence, origin, audit_id) ON kauro.plan_validations TO kauro_control;
GRANT UPDATE (result, receipt_hash) ON kauro.plan_validations TO kauro_control;
GRANT INSERT (plan_id, agency_id, project_id, revision_hash, target_contract_hash, policy_hash, body, body_hash, created_by_membership_id, created_at, updated_at)
  ON kauro.plans TO kauro_control;
GRANT UPDATE (version, state, validation_receipt_hash) ON kauro.plans TO kauro_control;
GRANT SELECT (created_by_membership_id, created_at, updated_at) ON kauro.plans TO kauro_control;
