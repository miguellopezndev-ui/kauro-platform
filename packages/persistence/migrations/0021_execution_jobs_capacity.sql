-- 0021 — B08 processing authority, part 1: processing jobs, their fenced attempts, the two capacity ledgers, the consumption of a
-- CommercialAuthorization at admission, the EXECUTION_ADMITTED anchor and PAID_ORDINARY record, the projects' transition lock and
-- the non-blocking shared transition lock, and the control plane's reads and events of execution.
--
-- Authority: 07 "Job and attempt states" (a claim creates a monotonically increasing fence and a lease; only a fenced accepted
-- attempt publishes; one ACTIVE heavy job and a bounded waiting queue; fair agency scheduling), 07 "CommercialAuthorization"
-- (consumed by one logical processing job, with technical retries under that same entitlement; a reversal before execution
-- prevents launch), 07 "Transaction discipline" (unique constraints and row locks close races; application checks cannot be the
-- sole protection), 07 "Database representation", 08 "Database isolation", 09 "Retention schedule" (paid ordinary data: fourteen
-- days hard from the capture), registry contracts Job, Lease, CommercialAuthorization, RetentionRecord; registry machine Job;
-- scenarios S055, S056, R2-046, CMD036, CMD037. Design: docs/design/B08-audit-approval-jobs.md §4, §8, §9 (decisions D8-JOB-1/2,
-- D8-AUTH-1, D8-CAP-1/2, D8-SCHED-1, D8-ATT-1/2, D8-LOCK-1, D8-RET-1, D8-CLOCK-1, D8-ROLE-1/2, D8-SQL-1, D8-XPKG-4..8) and the
-- decisions register rows D8-PEX-1.. of mandate B08-PERSISTENCE-EXECUTION. It extends B06 (0001..0008), B07 (0009..0012), B09
-- (0013..0017) and the merge (0018) and forks nothing: new tables, triggers, policies, grants and keys, and a superset of the one
-- function it replaces (retention_anchors_bound; D8-BASE-2).
--
-- SQLSTATE vocabulary added by B08 (a range of its own, D8-SQL-1; mapped by @kauro/persistence sqlstate.ts):
--   KA080 FENCE     an attempt or a step that is not its lease's current owner at its fence, or an object outside its own prefix
--   KA081 AUTHORITY the entitlement, the cancellation, a deadline or a bound fact no longer admits the edge
--   KA082 CAPACITY_LEDGER a capacity ledger disagrees with the jobs it summarizes, or a slot moved outside its edge
--   KA083 GRANT     (migration 0023, the audit half)
--   KA084 EVIDENCE  a publication without its read-back or verification evidence (migration 0022)

-- --- the non-blocking shared transition lock and the control plane's transition locks (D8-LOCK-1, D8-XPKG-6) -----------------
-- JOB_ADMISSION takes the global ledger first and then every other lock without waiting (D8-LOCK-1): the shared half of a fact's
-- transition lock (B06 D-TX-2) taken only when no transition holds or waits for it; false defers the job to the next round.
CREATE OR REPLACE FUNCTION kauro.try_await_transition(kind text, subject text) RETURNS boolean
  LANGUAGE sql VOLATILE STRICT SET search_path = pg_catalog AS
$$ SELECT pg_try_advisory_xact_lock_shared(kauro.transition_key(kind, subject)) $$;
-- 0001 granted the waiting half to the request handlers and 0013 to the payment service; the control plane reads the facts of
-- execution after their locks too (D8-XPKG-6)
GRANT EXECUTE ON FUNCTION kauro.await_transition(text, text) TO kauro_control;
GRANT EXECUTE ON FUNCTION kauro.try_await_transition(text, text) TO kauro_control;

-- A project's state is a transition subject (D8-LOCK-1, D8-PUB-2): ExecuteProject, admission and publication rely on the project
-- being OPEN, and a deletion request (B16) that takes the project and then its jobs is ordered with a publication in flight — one
-- committed first is what the publication reads (S062 deletion half).
CREATE TRIGGER projects_transition_lock BEFORE UPDATE OF state ON kauro.projects
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.take_transition_lock('kauro.projects', 'project_id');

-- --- binding targets B08 adds to B06's and B09's tables (D8-JOB-2; D8-BASE-2: keys only, nothing changes) ------------------------
-- a job binds exactly its authorization's purchased subject: project, capture, plan, approval, source, target and capability
ALTER TABLE kauro.commercial_authorizations ADD CONSTRAINT commercial_authorizations_execution_subject
  UNIQUE (agency_id, authorization_id, project_id, capture_id, plan_id, plan_hash, approval_id, approval_hash, revision_hash, target_contract_hash, capability_id, capability_version, mode);
-- ... and the core package of the receipt the approval names
ALTER TABLE kauro.validation_receipts ADD CONSTRAINT validation_receipts_core_binding
  UNIQUE (agency_id, plan_id, receipt_hash, plan_hash, revision_hash, target_contract_hash, core_package_hash);

-- --- processing jobs (registry contract and machine Job; an aggregate, kind processing_job) --------------------------------------
CREATE TABLE kauro.processing_jobs (
  job_id                    uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(job_id)),
  agency_id                 uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id                uuid NOT NULL,
  authorization_id          uuid NOT NULL,
  capture_id                uuid NOT NULL,
  plan_id                   uuid NOT NULL,
  plan_hash                 text NOT NULL CHECK (kauro.is_sha256_hex(plan_hash)),
  approval_id               uuid NOT NULL,
  approval_hash             text NOT NULL CHECK (kauro.is_sha256_hex(approval_hash)),
  revision_hash             text NOT NULL CHECK (kauro.is_sha256_hex(revision_hash)),
  target_contract_hash      text NOT NULL CHECK (kauro.is_sha256_hex(target_contract_hash)),
  capability_id             uuid NOT NULL,
  capability_version        text NOT NULL,
  mode                      text NOT NULL CHECK (mode IN ('CLEAN', 'HUBSPOT', 'SALESFORCE')),
  validation_receipt_hash   text NOT NULL CHECK (kauro.is_sha256_hex(validation_receipt_hash)),
  core_package_hash         text NOT NULL CHECK (kauro.is_sha256_hex(core_package_hash)),
  -- Job.inputBindingHash: KAURO_JOB_INPUT_BINDING_V1 over the subject above (D8-JOB-2); the JOB_ATTEMPT lease subject (D8-ATT-1)
  input_binding_hash        text NOT NULL CHECK (kauro.is_sha256_hex(input_binding_hash)),
  version                   bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                     text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED', 'ADMITTED', 'RUNNING', 'VERIFYING', 'READY', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED', 'EXPIRED')),
  -- what the job holds of the ledgers (D8-CAP-1): derived from the state by the database, except the launch (WAITING -> ACTIVE)
  holds                     text NOT NULL DEFAULT 'BACKLOG' CHECK (holds IN ('BACKLOG', 'WAITING', 'ACTIVE', 'NONE')),
  -- registry Job.attempt and Job.fence: bookkeeping of the attempts' triggers, never written by a client statement
  attempt_count             integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  current_attempt_id        uuid,
  fence                     bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
  -- capture completion + 172,800 s (D8-RET-1): the absolute boundary of the logical operation and its lease's deadline
  delivery_deadline_at      timestamptz NOT NULL,
  -- launch + 28,800 s, never past the delivery deadline, set once with the launch (D8-DL-1; decision D8-PEX-2)
  execution_deadline_at     timestamptz,
  queued_at                 timestamptz NOT NULL,
  admitted_at               timestamptz,
  started_at                timestamptz,
  verifying_at              timestamptz,
  ready_at                  timestamptz,
  cancel_requested_at       timestamptz,
  terminal_at               timestamptz,
  terminal_reason           text CHECK (terminal_reason IS NULL OR kauro.is_token(terminal_reason)),
  -- the cancellation, recorded once (CMD037; D8-CANCEL-1): its version, actor and reason (a label kept on the row only)
  cancel_version            bigint NOT NULL DEFAULT 0 CHECK (cancel_version >= 0),
  cancel_actor_kind         text CHECK (cancel_actor_kind IS NULL OR cancel_actor_kind IN ('USER', 'SERVICE')),
  cancel_actor_id           text,
  cancel_reason_code        text CONSTRAINT processing_jobs_cancel_reason_label CHECK (cancel_reason_code IS NULL OR kauro.is_label(cancel_reason_code)),
  -- registry Job.packageId: present only after verified publication (the foreign key is added by 0022)
  published_package_id      uuid,
  created_by_membership_id  uuid NOT NULL,
  created_at                timestamptz NOT NULL,
  updated_at                timestamptz NOT NULL,
  UNIQUE (agency_id, job_id),
  CONSTRAINT processing_jobs_project_scope UNIQUE (agency_id, job_id, project_id),
  CONSTRAINT processing_jobs_authorization_scope UNIQUE (agency_id, job_id, authorization_id),
  -- D8-JOB-1: one ProcessingJob per CommercialAuthorization for good
  CONSTRAINT processing_jobs_one_per_authorization UNIQUE (agency_id, authorization_id),
  -- D8-JOB-2: the job binds exactly its authorization's subject (a mismatched key is 23503) ...
  CONSTRAINT processing_jobs_authorization_subject_fk FOREIGN KEY (agency_id, authorization_id, project_id, capture_id, plan_id, plan_hash, approval_id, approval_hash, revision_hash, target_contract_hash, capability_id, capability_version, mode)
    REFERENCES kauro.commercial_authorizations (agency_id, authorization_id, project_id, capture_id, plan_id, plan_hash, approval_id, approval_hash, revision_hash, target_contract_hash, capability_id, capability_version, mode),
  -- ... and the receipt of exactly its plan's body, source and target with its core package
  CONSTRAINT processing_jobs_receipt_fk FOREIGN KEY (agency_id, plan_id, validation_receipt_hash, plan_hash, revision_hash, target_contract_hash, core_package_hash)
    REFERENCES kauro.validation_receipts (agency_id, plan_id, receipt_hash, plan_hash, revision_hash, target_contract_hash, core_package_hash),
  FOREIGN KEY (agency_id, project_id) REFERENCES kauro.projects (agency_id, project_id),
  FOREIGN KEY (agency_id, created_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id),
  CONSTRAINT processing_jobs_holds_of_state CHECK (
    (state = 'QUEUED' AND holds = 'BACKLOG')
    OR (state = 'ADMITTED' AND holds IN ('WAITING', 'ACTIVE'))
    OR (state IN ('RUNNING', 'VERIFYING') AND holds = 'ACTIVE')
    OR (state = 'CANCEL_REQUESTED' AND holds IN ('BACKLOG', 'WAITING', 'ACTIVE'))
    OR (state IN ('READY', 'FAILED', 'CANCELLED', 'EXPIRED') AND holds = 'NONE')
  ),
  CONSTRAINT processing_jobs_cancellation_recorded CHECK (
    (cancel_version = 0) = (cancel_requested_at IS NULL)
    AND (cancel_requested_at IS NULL) = (cancel_actor_kind IS NULL)
    AND (cancel_actor_kind IS NULL) = (cancel_actor_id IS NULL)
    AND (cancel_actor_id IS NULL) = (cancel_reason_code IS NULL)
    AND (state NOT IN ('CANCEL_REQUESTED', 'CANCELLED') OR cancel_version >= 1)
  ),
  CONSTRAINT processing_jobs_cancel_actor_shape CHECK (
    cancel_actor_kind IS NULL
    OR (cancel_actor_kind = 'USER' AND cancel_actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    OR (cancel_actor_kind = 'SERVICE' AND cancel_actor_id ~ '^[a-z][a-z0-9_-]{1,63}$')
  ),
  CONSTRAINT processing_jobs_ready_names_package CHECK ((state = 'READY') = (published_package_id IS NOT NULL)),
  CONSTRAINT processing_jobs_attempt_bookkeeping CHECK ((attempt_count = 0) = (current_attempt_id IS NULL) AND (attempt_count = 0 OR fence >= 0)),
  CONSTRAINT processing_jobs_execution_within_delivery CHECK (execution_deadline_at IS NULL OR execution_deadline_at <= delivery_deadline_at),
  CONSTRAINT processing_jobs_terminal_explained CHECK (
    (state IN ('READY', 'FAILED', 'CANCELLED', 'EXPIRED')) = (terminal_at IS NOT NULL)
    AND (state NOT IN ('FAILED', 'EXPIRED') OR terminal_reason IS NOT NULL)
  )
);
-- D8-JOB-1: one live job per project
CREATE UNIQUE INDEX processing_jobs_one_live_per_project ON kauro.processing_jobs (agency_id, project_id)
  WHERE state IN ('QUEUED', 'ADMITTED', 'RUNNING', 'VERIFYING', 'CANCEL_REQUESTED');
-- the fair scheduler's queue (D8-SCHED-1) and the ledgers' counts
CREATE INDEX processing_jobs_queue ON kauro.processing_jobs (queued_at, job_id) WHERE state = 'QUEUED';
CREATE INDEX processing_jobs_holds ON kauro.processing_jobs (agency_id, holds) WHERE holds <> 'NONE';
CREATE INDEX processing_jobs_deadlines ON kauro.processing_jobs (delivery_deadline_at) WHERE state IN ('QUEUED', 'ADMITTED', 'RUNNING', 'VERIFYING');

-- trigger names fix the order of the BEFORE triggers (they fire by name): immutable columns, the birth state, the listed edge and
-- the version discipline first, then the workflow guard of this package, which stamps and derives what it owns
CREATE TRIGGER processing_jobs_immutable BEFORE UPDATE ON kauro.processing_jobs
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('job_id,agency_id,project_id,authorization_id,capture_id,plan_id,plan_hash,approval_id,approval_hash,revision_hash,target_contract_hash,capability_id,capability_version,mode,validation_receipt_hash,core_package_hash,input_binding_hash,delivery_deadline_at,queued_at,created_by_membership_id,created_at');
CREATE TRIGGER processing_jobs_learned_once BEFORE UPDATE ON kauro.processing_jobs
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('execution_deadline_at,admitted_at,started_at,verifying_at,ready_at,cancel_requested_at,terminal_at,terminal_reason,cancel_actor_kind,cancel_actor_id,cancel_reason_code,published_package_id');
CREATE TRIGGER processing_jobs_initial_state BEFORE INSERT ON kauro.processing_jobs
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('Job');
CREATE TRIGGER processing_jobs_transition BEFORE UPDATE OF state ON kauro.processing_jobs
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('Job');
-- the bookkeeping of the ledgers and of the attempts changes without a version (like B09's allocation, 0015)
CREATE TRIGGER processing_jobs_version BEFORE UPDATE ON kauro.processing_jobs
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump('holds,attempt_count,current_attempt_id,fence,execution_deadline_at');

-- The registry Job machine (state_transitions.json "Job"), edge for edge (the persistence test compares the seed with the registry)
INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('Job', 'QUEUED');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('Job', 'QUEUED', 'ADMITTED'),
  ('Job', 'ADMITTED', 'RUNNING'),
  ('Job', 'RUNNING', 'VERIFYING'),
  ('Job', 'VERIFYING', 'READY'),
  ('Job', 'QUEUED', 'CANCEL_REQUESTED'),
  ('Job', 'ADMITTED', 'CANCEL_REQUESTED'),
  ('Job', 'RUNNING', 'CANCEL_REQUESTED'),
  ('Job', 'VERIFYING', 'CANCEL_REQUESTED'),
  ('Job', 'CANCEL_REQUESTED', 'CANCELLED'),
  ('Job', 'QUEUED', 'EXPIRED'),
  ('Job', 'ADMITTED', 'EXPIRED'),
  ('Job', 'RUNNING', 'EXPIRED'),
  ('Job', 'VERIFYING', 'EXPIRED'),
  ('Job', 'ADMITTED', 'FAILED'),
  ('Job', 'RUNNING', 'FAILED'),
  ('Job', 'VERIFYING', 'FAILED');

INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES ('processing_job', 'processing_jobs', 'job_id', 'B08');

-- --- processing attempts (platform machine ProcessingAttempt, design §8.2; evidence rows of the job, D8-EVT-1) --------------------
CREATE TABLE kauro.processing_attempts (
  attempt_id            uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(attempt_id)),
  agency_id             uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id            uuid NOT NULL,
  job_id                uuid NOT NULL,
  -- at most three attempts, all inside the job's original deadlines (Q8-3, D8-ATT-1)
  ordinal               integer NOT NULL CHECK (ordinal BETWEEN 1 AND 3),
  state                 text NOT NULL DEFAULT 'CREATED' CHECK (state IN ('CREATED', 'CLAIMED', 'STARTING', 'RUNNING', 'STAGED', 'VERIFYING', 'COMMITTED', 'ABANDONED', 'FAILED')),
  -- the JOB_ATTEMPT lease fence the attempt claimed (D8-ATT-1)
  fence                 bigint CHECK (fence IS NULL OR fence >= 1),
  -- D8-HOST-1, D8-STG-1: the deterministic provider identity and the canonical staging prefix, recorded before any launch
  identity              text NOT NULL,
  staging_prefix        text NOT NULL,
  manifest_object_name  text CHECK (manifest_object_name IS NULL OR kauro.is_object_name(manifest_object_name)),
  launch_state          text NOT NULL DEFAULT 'NOT_LAUNCHED' CHECK (launch_state IN ('NOT_LAUNCHED', 'LAUNCHED', 'UNCERTAIN', 'REFUSED')),
  -- registry Job.providerJobId: what the host reported, learned once; it is the attempt's own deterministic identity
  provider_job_id       text,
  claimed_at            timestamptz,
  launch_intent_at      timestamptz,
  launch_recorded_at    timestamptz,
  started_at            timestamptz,
  staged_at             timestamptz,
  verifying_at          timestamptz,
  ended_at              timestamptz,
  terminal_cause        text CHECK (terminal_cause IS NULL OR kauro.is_token(terminal_cause)),
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  UNIQUE (agency_id, attempt_id),
  CONSTRAINT processing_attempts_job_scope UNIQUE (agency_id, attempt_id, job_id),
  CONSTRAINT processing_attempts_identity_scope UNIQUE (agency_id, attempt_id, identity, staging_prefix),
  CONSTRAINT processing_attempts_ordinal_once UNIQUE (job_id, ordinal),
  FOREIGN KEY (agency_id, job_id, project_id) REFERENCES kauro.processing_jobs (agency_id, job_id, project_id),
  CONSTRAINT processing_attempts_identity CHECK (identity = 'kauro-attempt-' || attempt_id::text),
  CONSTRAINT processing_attempts_staging_prefix CHECK (
    staging_prefix = 'staging/' || agency_id::text || '/' || project_id::text || '/' || job_id::text || '/' || attempt_id::text || '/'
  ),
  CONSTRAINT processing_attempts_provider_identity CHECK (provider_job_id IS NULL OR provider_job_id = identity),
  CONSTRAINT processing_attempts_manifest_in_prefix CHECK (manifest_object_name IS NULL OR starts_with(manifest_object_name, staging_prefix)),
  CONSTRAINT processing_attempts_fenced CHECK ((state = 'CREATED') = (fence IS NULL)),
  CONSTRAINT processing_attempts_launch_recorded CHECK (
    state NOT IN ('STARTING', 'RUNNING', 'STAGED', 'VERIFYING', 'COMMITTED') OR (launch_intent_at IS NOT NULL AND manifest_object_name IS NOT NULL)
  ),
  CONSTRAINT processing_attempts_terminal_explained CHECK (
    (state IN ('COMMITTED', 'ABANDONED', 'FAILED')) = (ended_at IS NOT NULL) AND (state NOT IN ('ABANDONED', 'FAILED') OR terminal_cause IS NOT NULL)
  )
);
-- one live attempt per job; a takeover follows only an ended attempt
CREATE UNIQUE INDEX processing_attempts_one_live_per_job ON kauro.processing_attempts (job_id) WHERE state NOT IN ('COMMITTED', 'ABANDONED', 'FAILED');
CREATE INDEX processing_attempts_by_job ON kauro.processing_attempts (agency_id, job_id, ordinal);
CREATE TRIGGER processing_attempts_immutable BEFORE UPDATE ON kauro.processing_attempts
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('attempt_id,agency_id,project_id,job_id,ordinal,identity,staging_prefix,created_at');
CREATE TRIGGER processing_attempts_learned_once BEFORE UPDATE ON kauro.processing_attempts
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('fence,manifest_object_name,provider_job_id,claimed_at,launch_intent_at,started_at,staged_at,verifying_at,ended_at,terminal_cause');
CREATE TRIGGER processing_attempts_initial_state BEFORE INSERT ON kauro.processing_attempts
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('ProcessingAttempt');
CREATE TRIGGER processing_attempts_transition BEFORE UPDATE OF state ON kauro.processing_attempts
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('ProcessingAttempt');

INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('ProcessingAttempt', 'CREATED');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('ProcessingAttempt', 'CREATED', 'CLAIMED'),
  ('ProcessingAttempt', 'CLAIMED', 'STARTING'),
  ('ProcessingAttempt', 'STARTING', 'RUNNING'),
  ('ProcessingAttempt', 'RUNNING', 'STAGED'),
  ('ProcessingAttempt', 'STAGED', 'VERIFYING'),
  ('ProcessingAttempt', 'VERIFYING', 'COMMITTED'),
  ('ProcessingAttempt', 'CLAIMED', 'ABANDONED'),
  ('ProcessingAttempt', 'STARTING', 'ABANDONED'),
  ('ProcessingAttempt', 'RUNNING', 'ABANDONED'),
  ('ProcessingAttempt', 'STAGED', 'ABANDONED'),
  ('ProcessingAttempt', 'VERIFYING', 'ABANDONED'),
  ('ProcessingAttempt', 'STARTING', 'FAILED'),
  ('ProcessingAttempt', 'RUNNING', 'FAILED'),
  ('ProcessingAttempt', 'STAGED', 'FAILED'),
  ('ProcessingAttempt', 'VERIFYING', 'FAILED');

-- --- the attempt's lease (D8-ATT-1) ---------------------------------------------------------------------------------------------
-- Whether an attempt owns its job's JOB_ATTEMPT lease at its fence, read under the lease's row lock (FOR SHARE) so a takeover in
-- flight is ordered before or after the edge that relies on it, never interleaved. Owner the attempt, fence the attempt's, subject
-- the job's input binding and cost authority the job's authorization: an attempt whose fence is not the lease's current fence is
-- refused KA080 by every caller (S056).
CREATE OR REPLACE FUNCTION kauro.attempt_owns_lease(p_job uuid, p_attempt uuid, p_fence bigint) RETURNS boolean
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  l record;
  j record;
BEGIN
  SELECT x.owner_id, x.fence, x.subject_hash, x.cost_authority_id INTO l
    FROM kauro.leases x WHERE x.resource_kind = 'JOB_ATTEMPT' AND x.resource_id = p_job FOR SHARE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT y.input_binding_hash, y.authorization_id INTO j FROM kauro.processing_jobs y WHERE y.job_id = p_job;
  RETURN coalesce(l.owner_id = p_attempt AND l.fence = p_fence AND l.subject_hash = j.input_binding_hash AND l.cost_authority_id = j.authorization_id, false);
END
$$;

-- --- the capacity ledgers (D8-CAP-1; R2-046) ----------------------------------------------------------------------------------
-- Operational ledgers, not aggregates, kept only by the jobs' trigger: the row lock their UPDATE takes serializes the slots, and the
-- CHECK refuses the combination beyond the policy (capacity.heavyActive = 1, capacity.heavyQueued = 3; per agency three live jobs,
-- Q8-2). The platform's ledger is one row; an agency's row is created empty on its first job.
CREATE TABLE kauro.execution_capacity (
  ledger_id     smallint PRIMARY KEY CHECK (ledger_id = 1),
  active_jobs   integer NOT NULL DEFAULT 0,
  waiting_jobs  integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL,
  CONSTRAINT execution_capacity_active_within_limit CHECK (active_jobs BETWEEN 0 AND 1),
  CONSTRAINT execution_capacity_waiting_within_limit CHECK (waiting_jobs BETWEEN 0 AND 3)
);
INSERT INTO kauro.execution_capacity (ledger_id, active_jobs, waiting_jobs, updated_at) VALUES (1, 0, 0, now());

CREATE TABLE kauro.agency_execution_capacity (
  agency_id         uuid PRIMARY KEY REFERENCES kauro.agencies (agency_id),
  live_jobs         integer NOT NULL DEFAULT 0,
  -- the agency's most recent admission: the fair scheduler's second key (D8-SCHED-1)
  last_admitted_at  timestamptz,
  updated_at        timestamptz NOT NULL,
  CONSTRAINT agency_execution_capacity_live_within_limit CHECK (live_jobs BETWEEN 0 AND 3)
);

-- Applies the delta of every change of what a job holds to its agency's ledger and to the platform's. A negative delta is never an
-- INSERT value (CHECK constraints judge the proposed row of an INSERT ... ON CONFLICT before the conflict is resolved; B07 D-UP-2).
CREATE OR REPLACE FUNCTION kauro.processing_jobs_ledgers() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  old_holds text := CASE WHEN TG_OP = 'UPDATE' THEN OLD.holds ELSE 'NONE' END;
  d_live integer := (CASE WHEN NEW.holds <> 'NONE' THEN 1 ELSE 0 END) - (CASE WHEN old_holds <> 'NONE' THEN 1 ELSE 0 END);
  d_waiting integer := (CASE WHEN NEW.holds = 'WAITING' THEN 1 ELSE 0 END) - (CASE WHEN old_holds = 'WAITING' THEN 1 ELSE 0 END);
  d_active integer := (CASE WHEN NEW.holds = 'ACTIVE' THEN 1 ELSE 0 END) - (CASE WHEN old_holds = 'ACTIVE' THEN 1 ELSE 0 END);
  admitted boolean := old_holds = 'BACKLOG' AND NEW.holds = 'WAITING';
BEGIN
  IF d_live <> 0 OR admitted THEN
    INSERT INTO kauro.agency_execution_capacity (agency_id, live_jobs, updated_at) VALUES (NEW.agency_id, 0, now())
    ON CONFLICT (agency_id) DO NOTHING;
    IF admitted THEN
      -- the admission (the control plane's edge) is the only writer of the agency's last admission
      UPDATE kauro.agency_execution_capacity SET live_jobs = live_jobs + d_live, last_admitted_at = kauro.server_now(), updated_at = now()
       WHERE agency_id = NEW.agency_id;
    ELSE
      UPDATE kauro.agency_execution_capacity SET live_jobs = live_jobs + d_live, updated_at = now() WHERE agency_id = NEW.agency_id;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CAPACITY_LEDGER: the execution ledger of agency % is not visible in this transaction', NEW.agency_id USING ERRCODE = 'KA082';
    END IF;
  END IF;
  IF d_waiting <> 0 OR d_active <> 0 THEN
    UPDATE kauro.execution_capacity SET waiting_jobs = waiting_jobs + d_waiting, active_jobs = active_jobs + d_active, updated_at = now() WHERE ledger_id = 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CAPACITY_LEDGER: the platform execution ledger is not visible in this transaction' USING ERRCODE = 'KA082';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER processing_jobs_ledgers_on_insert AFTER INSERT ON kauro.processing_jobs
  FOR EACH ROW EXECUTE FUNCTION kauro.processing_jobs_ledgers();
CREATE TRIGGER processing_jobs_ledgers_on_update AFTER UPDATE ON kauro.processing_jobs
  FOR EACH ROW WHEN (OLD.holds IS DISTINCT FROM NEW.holds) EXECUTE FUNCTION kauro.processing_jobs_ledgers();

-- The ledgers equal what the jobs hold, at commit, whoever wrote them (a direct write to a ledger row is refused too; KA082). The
-- jobs and the ledger row are read by ONE statement, i.e. in one snapshot under READ COMMITTED (B07-F10): a concurrent admission
-- that commits while this check runs is seen in both or in neither. The platform's ledger counts the jobs of every agency, which
-- the control plane reads (processing_jobs_control_read); the request handlers never move a WAITING or ACTIVE slot.
CREATE OR REPLACE FUNCTION kauro.check_execution_ledgers(p_agency uuid, p_platform boolean) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  r record;
BEGIN
  IF p_agency IS NOT NULL THEN
    SELECT (SELECT count(*) FROM kauro.processing_jobs j WHERE j.agency_id = p_agency AND j.holds <> 'NONE') AS expected,
           coalesce((SELECT l.live_jobs FROM kauro.agency_execution_capacity l WHERE l.agency_id = p_agency), 0) AS ledger
      INTO r;
    IF r.expected <> r.ledger THEN
      RAISE EXCEPTION 'CAPACITY_LEDGER: agency % execution ledger (% live) disagrees with its jobs (% live)', p_agency, r.ledger, r.expected USING ERRCODE = 'KA082';
    END IF;
  END IF;
  IF p_platform THEN
    SELECT (SELECT count(*) FROM kauro.processing_jobs j WHERE j.holds = 'WAITING') AS waiting,
           (SELECT count(*) FROM kauro.processing_jobs j WHERE j.holds = 'ACTIVE') AS active,
           (SELECT c.waiting_jobs FROM kauro.execution_capacity c WHERE c.ledger_id = 1) AS ledger_waiting,
           (SELECT c.active_jobs FROM kauro.execution_capacity c WHERE c.ledger_id = 1) AS ledger_active
      INTO r;
    IF r.waiting <> r.ledger_waiting OR r.active <> r.ledger_active THEN
      RAISE EXCEPTION 'CAPACITY_LEDGER: the platform execution ledger (% waiting, % active) disagrees with the jobs (% waiting, % active)',
        r.ledger_waiting, r.ledger_active, r.waiting, r.active USING ERRCODE = 'KA082';
    END IF;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION kauro.execution_ledgers_consistent() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF TG_TABLE_NAME = 'execution_capacity' THEN
    PERFORM kauro.check_execution_ledgers(NULL, true);
  ELSIF TG_TABLE_NAME = 'agency_execution_capacity' THEN
    PERFORM kauro.check_execution_ledgers(NEW.agency_id, false);
  ELSE
    PERFORM kauro.check_execution_ledgers(NEW.agency_id, TG_OP = 'UPDATE' AND (OLD.holds IN ('WAITING', 'ACTIVE') OR NEW.holds IN ('WAITING', 'ACTIVE')));
  END IF;
  RETURN NULL;
END
$$;
-- The fair scheduler's key is written by the jobs' trigger only (one level deeper than a client statement): an agency cannot move
-- itself ahead in the admission order by editing its own last admission (KA082).
CREATE OR REPLACE FUNCTION kauro.agency_execution_capacity_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.last_admitted_at IS DISTINCT FROM OLD.last_admitted_at AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'CAPACITY_LEDGER: the last admission of agency % is recorded by its admissions only', OLD.agency_id USING ERRCODE = 'KA082';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER agency_execution_capacity_guard BEFORE UPDATE ON kauro.agency_execution_capacity
  FOR EACH ROW EXECUTE FUNCTION kauro.agency_execution_capacity_guard();

CREATE CONSTRAINT TRIGGER processing_jobs_ledgers_queued AFTER INSERT ON kauro.processing_jobs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.execution_ledgers_consistent();
CREATE CONSTRAINT TRIGGER processing_jobs_ledgers_moved AFTER UPDATE ON kauro.processing_jobs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.holds IS DISTINCT FROM NEW.holds) EXECUTE FUNCTION kauro.execution_ledgers_consistent();
CREATE CONSTRAINT TRIGGER execution_capacity_ledgers AFTER UPDATE ON kauro.execution_capacity
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.execution_ledgers_consistent();
CREATE CONSTRAINT TRIGGER agency_execution_capacity_ledgers AFTER INSERT OR UPDATE ON kauro.agency_execution_capacity
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.execution_ledgers_consistent();

-- --- the job's workflow guard (D8-JOB-1/2, D8-AUTH-1, D8-CAP-1, D8-CANCEL-1, D8-DL-1, D8-CLOCK-1) ---------------------------------
-- Stamps every lifecycle instant with the server's transaction time (a writer never supplies one) and derives what the job holds
-- from its state; refuses, at the edge, what the database can decide now. Named to fire after the listed-edge and version triggers.
CREATE OR REPLACE FUNCTION kauro.processing_jobs_workflow() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  clock timestamptz := kauro.server_now();
  a record;
  completed timestamptz;
  approval_receipt text;
  cur record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- the authorization after its shared transition lock (B06 D-TX-2): a revocation in flight is ordered before the job (and read)
    -- or after it (and then routes to EXECUTION_CONTROL, which cancels the job); a job binds only an ACTIVE entitlement (KA081)
    PERFORM kauro.await_transition('kauro.commercial_authorizations', NEW.authorization_id::text);
    SELECT x.state, x.capture_id, x.approval_id INTO a
      FROM kauro.commercial_authorizations x WHERE x.agency_id = NEW.agency_id AND x.authorization_id = NEW.authorization_id;
    IF NOT FOUND OR a.state IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'EXECUTION_AUTHORITY: authorization % is % and binds no new job', NEW.authorization_id, coalesce(a.state, 'not visible') USING ERRCODE = 'KA081';
    END IF;
    -- the receipt the job names is the one the approval names (the key binds the rest)
    SELECT p.validation_receipt_hash INTO approval_receipt FROM kauro.approvals p WHERE p.agency_id = NEW.agency_id AND p.approval_id = NEW.approval_id;
    IF approval_receipt IS DISTINCT FROM NEW.validation_receipt_hash THEN
      RAISE EXCEPTION 'EXECUTION_AUTHORITY: job % names a receipt its approval does not', NEW.job_id USING ERRCODE = 'KA081';
    END IF;
    -- D8-RET-1, D8-XPKG-5: the delivery deadline is the capture's completion + 172,800 s
    SELECT c.provider_completed_at INTO completed FROM kauro.capture_facts c WHERE c.agency_id = NEW.agency_id AND c.capture_id = NEW.capture_id;
    IF completed IS NULL THEN
      RAISE EXCEPTION 'EXECUTION_AUTHORITY: capture % of job % records no completion', NEW.capture_id, NEW.job_id USING ERRCODE = 'KA081';
    END IF;
    NEW.delivery_deadline_at := completed + interval '172800 seconds';
    IF NEW.delivery_deadline_at <= clock THEN
      RAISE EXCEPTION 'EXECUTION_AUTHORITY: the delivery deadline of job % has passed', NEW.job_id USING ERRCODE = 'KA081';
    END IF;
    IF NEW.version <> 1 OR NEW.holds <> 'BACKLOG' OR NEW.attempt_count <> 0 OR NEW.current_attempt_id IS NOT NULL OR NEW.fence <> 0 OR NEW.cancel_version <> 0
       OR NEW.execution_deadline_at IS NOT NULL OR NEW.published_package_id IS NOT NULL OR NEW.terminal_reason IS NOT NULL THEN
      RAISE EXCEPTION 'EXECUTION_AUTHORITY: job % is born QUEUED at version 1 holding its backlog slot only', NEW.job_id USING ERRCODE = 'KA081';
    END IF;
    NEW.queued_at := clock;
    NEW.created_at := clock;
    NEW.updated_at := clock;
    NEW.admitted_at := NULL; NEW.started_at := NULL; NEW.verifying_at := NULL; NEW.ready_at := NULL;
    NEW.cancel_requested_at := NULL; NEW.terminal_at := NULL;
    RETURN NEW;
  END IF;

  NEW.updated_at := clock;
  -- the bookkeeping of attempts is the attempts' triggers' own (they run one trigger level deeper; B09's allocation writer, 0015)
  IF (NEW.attempt_count IS DISTINCT FROM OLD.attempt_count OR NEW.current_attempt_id IS DISTINCT FROM OLD.current_attempt_id OR NEW.fence IS DISTINCT FROM OLD.fence)
     AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: job % records its attempts and fence through its attempts only', OLD.job_id USING ERRCODE = 'KA080';
  END IF;
  -- the cancellation version moves exactly with cancel_command, by one (D8-CANCEL-1)
  IF NEW.state = 'CANCEL_REQUESTED' AND OLD.state IS DISTINCT FROM 'CANCEL_REQUESTED' THEN
    IF NEW.cancel_version <> OLD.cancel_version + 1 OR NEW.cancel_reason_code IS NULL OR NEW.cancel_actor_kind IS NULL THEN
      RAISE EXCEPTION 'EXECUTION_AUTHORITY: cancel_command of job % records its actor, its reason and cancel version %', OLD.job_id, OLD.cancel_version + 1 USING ERRCODE = 'KA081';
    END IF;
    NEW.cancel_requested_at := clock;
  ELSIF NEW.cancel_version IS DISTINCT FROM OLD.cancel_version THEN
    RAISE EXCEPTION 'EXECUTION_AUTHORITY: the cancellation version of job % moves only with cancel_command', OLD.job_id USING ERRCODE = 'KA081';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    -- derived holds: admission takes a waiting slot, a terminal state releases everything, CANCEL_REQUESTED keeps what the job held
    IF NEW.holds IS DISTINCT FROM OLD.holds THEN
      RAISE EXCEPTION 'CAPACITY_LEDGER: job % moves its slots with its state, never beside it', OLD.job_id USING ERRCODE = 'KA082';
    END IF;
    IF OLD.state = 'QUEUED' AND NEW.state = 'ADMITTED' THEN
      NEW.holds := 'WAITING';
      NEW.admitted_at := clock;
    ELSIF NEW.state IN ('READY', 'FAILED', 'CANCELLED', 'EXPIRED') THEN
      NEW.holds := 'NONE';
      NEW.terminal_at := clock;
    END IF;
    IF NEW.state = 'RUNNING' THEN
      NEW.started_at := clock;
      -- provider_start_observed: the current attempt was observed running under its fence (it moved first, D8-ATT-2)
      SELECT t.state INTO cur FROM kauro.processing_attempts t WHERE t.attempt_id = OLD.current_attempt_id;
      IF cur.state IS DISTINCT FROM 'RUNNING' OR NOT kauro.attempt_owns_lease(OLD.job_id, OLD.current_attempt_id, OLD.fence) THEN
        RAISE EXCEPTION 'EXECUTION_FENCE: job % runs only with its current attempt observed running under its fence', OLD.job_id USING ERRCODE = 'KA080';
      END IF;
    ELSIF NEW.state = 'VERIFYING' THEN
      NEW.verifying_at := clock;
      -- complete_staging_submitted: the current attempt submitted its manifest under its fence (D8-STG-3)
      SELECT t.state INTO cur FROM kauro.processing_attempts t WHERE t.attempt_id = OLD.current_attempt_id;
      IF cur.state IS DISTINCT FROM 'STAGED' OR NOT kauro.attempt_owns_lease(OLD.job_id, OLD.current_attempt_id, OLD.fence) THEN
        RAISE EXCEPTION 'EXECUTION_FENCE: job % verifies only the manifest its current attempt submitted under its fence', OLD.job_id USING ERRCODE = 'KA080';
      END IF;
    ELSIF NEW.state = 'READY' THEN
      NEW.ready_at := clock;
    ELSIF NEW.state = 'EXPIRED' THEN
      -- deadline_reached, never early (D8-DL-1): the delivery deadline, or the execution deadline once launched
      IF clock < least(OLD.delivery_deadline_at, coalesce(OLD.execution_deadline_at, OLD.delivery_deadline_at)) THEN
        RAISE EXCEPTION 'EXECUTION_AUTHORITY: job % reaches its deadline no earlier than it', OLD.job_id USING ERRCODE = 'KA081';
      END IF;
    END IF;
  ELSIF NEW.holds IS DISTINCT FROM OLD.holds THEN
    -- the launch intent (D8-CAP-1): the ACTIVE slot is taken by an admitted, uncancelled job only, and starts its execution wall
    IF OLD.cancel_version <> 0 THEN
      RAISE EXCEPTION 'EXECUTION_AUTHORITY: job % was cancelled and launches nothing', OLD.job_id USING ERRCODE = 'KA081';
    END IF;
    IF NOT (OLD.holds = 'WAITING' AND NEW.holds = 'ACTIVE' AND OLD.state = 'ADMITTED') THEN
      RAISE EXCEPTION 'CAPACITY_LEDGER: job % holds % and cannot move to % outside its edges', OLD.job_id, OLD.holds, NEW.holds USING ERRCODE = 'KA082';
    END IF;
    NEW.execution_deadline_at := least(clock + interval '28800 seconds', OLD.delivery_deadline_at);
  END IF;
  IF NEW.execution_deadline_at IS DISTINCT FROM OLD.execution_deadline_at AND NOT (OLD.holds = 'WAITING' AND NEW.holds = 'ACTIVE') THEN
    RAISE EXCEPTION 'EXECUTION_AUTHORITY: job % sets its execution deadline once, with its launch', OLD.job_id USING ERRCODE = 'KA081';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER processing_jobs_workflow BEFORE INSERT OR UPDATE ON kauro.processing_jobs
  FOR EACH ROW EXECUTE FUNCTION kauro.processing_jobs_workflow();

-- --- one event per job version, the event of what the version records (D8-EVT-1) ------------------------------------------------
CREATE CONSTRAINT TRIGGER processing_jobs_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.processing_jobs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('processing_job', 'job_id');

-- The event of an execution aggregate's version is `<kind>.<state>.v1` — the state the version reaches — like B09's
-- require_commerce_event_type for the commerce kinds (EVENT_MISSING, KA003). TG_ARGV: the kind, its id column.
CREATE OR REPLACE FUNCTION kauro.require_state_event_type() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  new_j jsonb := to_jsonb(NEW);
  expected_type text := TG_ARGV[0] || '.' || lower(new_j ->> 'state') || '.v1';
  published_type text;
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) -> 'version') = (new_j -> 'version') THEN
    RETURN NULL;
  END IF;
  SELECT e.event_type INTO published_type FROM kauro.domain_events e
   WHERE e.agency_id = (new_j ->> 'agency_id')::uuid AND e.aggregate_kind = TG_ARGV[0]
     AND e.aggregate_id = (new_j ->> TG_ARGV[1])::uuid AND e.aggregate_version = (new_j ->> 'version')::bigint;
  IF published_type IS DISTINCT FROM expected_type THEN
    RAISE EXCEPTION 'EVENT_MISSING: % % version % records %, but its event is %', TG_ARGV[0], new_j ->> TG_ARGV[1], new_j ->> 'version', new_j ->> 'state', coalesce(published_type, 'missing') USING ERRCODE = 'KA003';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER processing_jobs_event_type_per_version AFTER INSERT OR UPDATE OF version ON kauro.processing_jobs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_state_event_type('processing_job', 'job_id');

-- S055: a job commits only with its processing_job.queued.v1 event and that event's JOB_EXECUTION outbox record — the queue's
-- intent is never lost between the commit and the dispatch (07 "Outbox, inbox and event ordering"; KA003).
CREATE OR REPLACE FUNCTION kauro.processing_jobs_queued_with_outbox() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.domain_events e JOIN kauro.outbox_records o ON o.event_id = e.event_id
     WHERE e.agency_id = NEW.agency_id AND e.aggregate_kind = 'processing_job' AND e.aggregate_id = NEW.job_id AND e.aggregate_version = 1
       AND e.event_type = 'processing_job.queued.v1' AND o.consumer = 'JOB_EXECUTION'
  ) THEN
    RAISE EXCEPTION 'EVENT_MISSING: job % commits only with its processing_job.queued.v1 event and its JOB_EXECUTION outbox record', NEW.job_id USING ERRCODE = 'KA003';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER processing_jobs_queued_with_outbox AFTER INSERT ON kauro.processing_jobs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.processing_jobs_queued_with_outbox();

-- --- the attempts' workflow guard (D8-ATT-1, D8-HOST-1, D8-STG-1, D8-CANCEL-1; S056) ----------------------------------------------
CREATE OR REPLACE FUNCTION kauro.processing_attempts_workflow() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  clock timestamptz := kauro.server_now();
  j record;
BEGIN
  -- the job under its row lock (FOR SHARE): the attempt is ordered with CMD037's cancel_command and the publication (D8-CANCEL-1)
  SELECT x.state, x.cancel_version, x.attempt_count, x.holds INTO j
    FROM kauro.processing_jobs x WHERE x.agency_id = NEW.agency_id AND x.job_id = NEW.job_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTEXT: job % is not visible in this transaction', NEW.job_id USING ERRCODE = 'KA006';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- none after cancel_command, none for a job that is not admitted or running (KA081), and the next ordinal only (a takeover)
    IF j.cancel_version <> 0 OR j.state NOT IN ('ADMITTED', 'RUNNING') THEN
      RAISE EXCEPTION 'EXECUTION_AUTHORITY: job % is % (cancel version %) and takes no new attempt', NEW.job_id, j.state, j.cancel_version USING ERRCODE = 'KA081';
    END IF;
    IF NEW.ordinal <> j.attempt_count + 1 THEN
      RAISE EXCEPTION 'EXECUTION_FENCE: attempt % of job % follows attempt %', NEW.ordinal, NEW.job_id, j.attempt_count USING ERRCODE = 'KA080';
    END IF;
    IF NEW.launch_state <> 'NOT_LAUNCHED' OR NEW.provider_job_id IS NOT NULL OR NEW.manifest_object_name IS NOT NULL OR NEW.terminal_cause IS NOT NULL THEN
      RAISE EXCEPTION 'EXECUTION_FENCE: attempt % is born with nothing launched', NEW.attempt_id USING ERRCODE = 'KA080';
    END IF;
    NEW.created_at := clock;
    NEW.updated_at := clock;
    NEW.claimed_at := NULL; NEW.launch_intent_at := NULL; NEW.launch_recorded_at := NULL; NEW.started_at := NULL;
    NEW.staged_at := NULL; NEW.verifying_at := NULL; NEW.ended_at := NULL;
    RETURN NEW;
  END IF;

  NEW.updated_at := clock;
  IF NEW.fence IS DISTINCT FROM OLD.fence AND NOT (OLD.state = 'CREATED' AND NEW.state = 'CLAIMED') THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: attempt % takes its fence with fence_claimed only', OLD.attempt_id USING ERRCODE = 'KA080';
  END IF;
  IF NEW.manifest_object_name IS DISTINCT FROM OLD.manifest_object_name AND NOT (OLD.state = 'CLAIMED' AND NEW.state = 'STARTING') THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: attempt % records its manifest name with its launch intent only', OLD.attempt_id USING ERRCODE = 'KA080';
  END IF;
  -- what the host answered a launch moves forward only; an UNCERTAIN launch is reconciled by observation (D8-HOST-1)
  IF NEW.launch_state IS DISTINCT FROM OLD.launch_state THEN
    IF NOT ((OLD.launch_state = 'NOT_LAUNCHED' AND NEW.launch_state IN ('LAUNCHED', 'UNCERTAIN', 'REFUSED'))
            OR (OLD.launch_state = 'UNCERTAIN' AND NEW.launch_state IN ('LAUNCHED', 'NOT_LAUNCHED', 'REFUSED'))) THEN
      RAISE EXCEPTION 'UNLISTED_TRANSITION: launch % -> % of attempt % is not a forward move', OLD.launch_state, NEW.launch_state, OLD.attempt_id USING ERRCODE = 'KA008';
    END IF;
    IF NEW.state NOT IN ('STARTING', 'RUNNING', 'ABANDONED', 'FAILED') THEN
      RAISE EXCEPTION 'EXECUTION_FENCE: attempt % records a launch only after its launch intent', OLD.attempt_id USING ERRCODE = 'KA080';
    END IF;
    NEW.launch_recorded_at := clock;
  END IF;
  IF NEW.provider_job_id IS DISTINCT FROM OLD.provider_job_id AND NEW.launch_state = 'NOT_LAUNCHED' THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: attempt % learns its provider job from a launch or an observation', OLD.attempt_id USING ERRCODE = 'KA080';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NEW.state = 'CLAIMED' THEN
      -- fence_claimed: the attempt owns the lease at its fence, subject the input binding, cost the authorization (KA080)
      IF NOT kauro.attempt_owns_lease(OLD.job_id, OLD.attempt_id, NEW.fence) THEN
        RAISE EXCEPTION 'EXECUTION_FENCE: attempt % does not own the lease of job % at fence %', OLD.attempt_id, OLD.job_id, NEW.fence USING ERRCODE = 'KA080';
      END IF;
      IF j.cancel_version <> 0 THEN
        RAISE EXCEPTION 'EXECUTION_AUTHORITY: job % was cancelled and claims nothing', OLD.job_id USING ERRCODE = 'KA081';
      END IF;
      NEW.claimed_at := clock;
    ELSIF NEW.state IN ('STARTING', 'RUNNING', 'STAGED', 'VERIFYING', 'COMMITTED') THEN
      -- every forward edge of an attempt is taken by the lease's current owner at its fence (S056) and never after cancel_command
      IF NOT kauro.attempt_owns_lease(OLD.job_id, OLD.attempt_id, OLD.fence) THEN
        RAISE EXCEPTION 'EXECUTION_FENCE: attempt % at fence % is not the current owner of the lease of job %', OLD.attempt_id, OLD.fence, OLD.job_id USING ERRCODE = 'KA080';
      END IF;
      IF j.cancel_version <> 0 THEN
        RAISE EXCEPTION 'EXECUTION_AUTHORITY: job % was cancelled; attempt % is launched, submitted or published no further', OLD.job_id, OLD.attempt_id USING ERRCODE = 'KA081';
      END IF;
      IF NEW.state = 'STARTING' THEN
        -- launch_intent: the job holds the ACTIVE slot (KA082) and is still admitted or running
        IF j.holds <> 'ACTIVE' OR j.state NOT IN ('ADMITTED', 'RUNNING') THEN
          RAISE EXCEPTION 'CAPACITY_LEDGER: attempt % launches only while its job holds the active slot', OLD.attempt_id USING ERRCODE = 'KA082';
        END IF;
        NEW.launch_intent_at := clock;
      ELSIF NEW.state = 'RUNNING' THEN
        NEW.started_at := clock;
      ELSIF NEW.state = 'STAGED' THEN
        NEW.staged_at := clock;
      ELSIF NEW.state = 'VERIFYING' THEN
        NEW.verifying_at := clock;
      ELSE
        NEW.ended_at := clock;
      END IF;
    ELSE
      -- ABANDONED, FAILED: a lost or failed attempt ends whoever holds the lease
      NEW.ended_at := clock;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER processing_attempts_workflow BEFORE INSERT OR UPDATE ON kauro.processing_attempts
  FOR EACH ROW EXECUTE FUNCTION kauro.processing_attempts_workflow();

-- Registry Job.attempt and Job.fence follow the attempts (a trigger level deeper than the client's statement)
CREATE OR REPLACE FUNCTION kauro.processing_attempts_bookkeeping() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE kauro.processing_jobs SET attempt_count = NEW.ordinal, current_attempt_id = NEW.attempt_id WHERE agency_id = NEW.agency_id AND job_id = NEW.job_id;
  ELSIF NEW.fence IS DISTINCT FROM OLD.fence THEN
    UPDATE kauro.processing_jobs SET fence = NEW.fence WHERE agency_id = NEW.agency_id AND job_id = NEW.job_id AND current_attempt_id = NEW.attempt_id;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER processing_attempts_bookkeeping AFTER INSERT OR UPDATE ON kauro.processing_attempts
  FOR EACH ROW EXECUTE FUNCTION kauro.processing_attempts_bookkeeping();

-- --- consumption at admission, bound at COMMIT (D8-AUTH-1, D8-RET-1, D8-ATT-1; KA081, KA080) -----------------------------------------
-- The authorization names the job it is consumed by (B09 learns it once, job_ref); the two deferred bounds below bind the pair — the
-- job admitted by exactly this authorization, the authorization consumed by exactly this job — at COMMIT (decision D8-PEX-8).

-- QUEUED -> ADMITTED commits only with the authorization ACTIVE -> CONSUMED naming the job at the admission's instant, its source's
-- EXECUTION_ADMITTED anchor (written now or by an earlier admission of the revision), the revision's PAID_ORDINARY record (created now or kept, D8-XPKG-8) and attempt 1 CLAIMED at fence 1
-- as the lease's owner — one unit of work, all or nothing.
CREATE OR REPLACE FUNCTION kauro.processing_jobs_admission_bound() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.commercial_authorizations a
     WHERE a.agency_id = NEW.agency_id AND a.authorization_id = NEW.authorization_id AND a.state = 'CONSUMED' AND a.job_ref = NEW.job_id AND a.consumed_at = NEW.admitted_at
  ) THEN
    RAISE EXCEPTION 'EXECUTION_AUTHORITY: job % is admitted only with its authorization consumed by it in the same transaction', NEW.job_id USING ERRCODE = 'KA081';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM kauro.retention_anchors x JOIN kauro.dataset_revisions d ON d.agency_id = x.agency_id AND d.revision_id = x.revision_id
     WHERE x.agency_id = NEW.agency_id AND x.anchor_kind = 'EXECUTION_ADMITTED' AND d.project_id = NEW.project_id AND d.manifest_hash = NEW.revision_hash
  ) OR NOT EXISTS (
    SELECT 1 FROM kauro.retention_records r JOIN kauro.dataset_revisions d ON d.agency_id = r.agency_id AND d.revision_id = r.revision_id
     WHERE r.agency_id = NEW.agency_id AND r.class = 'PAID_ORDINARY' AND d.project_id = NEW.project_id AND d.manifest_hash = NEW.revision_hash
  ) THEN
    RAISE EXCEPTION 'EXECUTION_AUTHORITY: job % is admitted only with the EXECUTION_ADMITTED anchor and the PAID_ORDINARY record of its source', NEW.job_id USING ERRCODE = 'KA081';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM kauro.processing_attempts t
     WHERE t.agency_id = NEW.agency_id AND t.job_id = NEW.job_id AND t.ordinal = 1 AND t.state = 'CLAIMED' AND t.fence = 1
       AND kauro.attempt_owns_lease(NEW.job_id, t.attempt_id, 1)
  ) THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: job % is admitted only with attempt 1 claimed at fence 1', NEW.job_id USING ERRCODE = 'KA080';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER processing_jobs_admission_bound AFTER UPDATE ON kauro.processing_jobs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.state = 'QUEUED' AND NEW.state = 'ADMITTED') EXECUTE FUNCTION kauro.processing_jobs_admission_bound();

-- ... and ACTIVE -> CONSUMED commits only with its job entering ADMITTED at that instant (the registry's execution_admitted guard).
-- Every runtime role is bound; a superuser session is not (it can disable any trigger anyway), which keeps B09's own stand-in for
-- this edge — its critique suite consumes an entitlement as the superuser oracle, B09-F2 — unchanged (decision D8-PEX-8).
CREATE OR REPLACE FUNCTION kauro.commercial_authorizations_consumption_bound() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND r.rolsuper) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM kauro.processing_jobs j
     WHERE j.agency_id = NEW.agency_id AND j.job_id = NEW.job_ref AND j.authorization_id = NEW.authorization_id
       AND j.state = 'ADMITTED' AND j.admitted_at = NEW.consumed_at AND j.admitted_at = kauro.server_now()
  ) THEN
    RAISE EXCEPTION 'EXECUTION_AUTHORITY: authorization % is consumed only by its job entering ADMITTED in the same transaction', NEW.authorization_id USING ERRCODE = 'KA081';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER commercial_authorizations_consumption_bound AFTER UPDATE ON kauro.commercial_authorizations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state = 'CONSUMED' AND OLD.state IS DISTINCT FROM 'CONSUMED')
  EXECUTE FUNCTION kauro.commercial_authorizations_consumption_bound();

-- --- retention: the EXECUTION_ADMITTED anchor and the PAID_ORDINARY record (D8-RET-1, D8-XPKG-8) -----------------------------------
ALTER TABLE kauro.retention_anchor_kinds NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.retention_anchor_kinds (anchor_kind) VALUES ('EXECUTION_ADMITTED');
ALTER TABLE kauro.retention_anchor_kinds FORCE ROW LEVEL SECURITY;

-- One anchor of each kind per revision (B07's retention_anchors_once_per_revision, unchanged): the first admission of a revision
-- anchors its PAID_ORDINARY record, and a later admission over the same revision (another purchase) keeps both — the record's hard
-- deadline never moves and nothing resets a retention clock (HASHING "Retention formulas"; D8-XPKG-8; decision D8-PEX-3).

-- The superset of B07's binding (0012; D8-BASE-2): every B07 arm unchanged, and an EXECUTION_ADMITTED anchor records an admission
-- — a job of this project and revision entered ADMITTED in this very transaction, at exactly the anchor's instant.
CREATE OR REPLACE FUNCTION kauro.retention_anchors_bound() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  bound boolean;
BEGIN
  CASE NEW.anchor_kind
    WHEN 'UPLOAD_INITIATED' THEN
      bound := EXISTS (SELECT 1 FROM kauro.upload_sessions u WHERE u.agency_id = NEW.agency_id AND u.upload_id = NEW.upload_id AND u.created_at = NEW.occurred_at);
    WHEN 'INPUT_ADMITTED' THEN
      bound := EXISTS (SELECT 1 FROM kauro.upload_sessions u WHERE u.agency_id = NEW.agency_id AND u.upload_id = NEW.upload_id AND u.admitted_at = NEW.occurred_at);
    WHEN 'INTAKE_CANCELLED' THEN
      bound := EXISTS (SELECT 1 FROM kauro.upload_sessions u WHERE u.agency_id = NEW.agency_id AND u.upload_id = NEW.upload_id AND u.state = 'CANCELLED' AND u.cancelled_at = NEW.occurred_at);
    WHEN 'INTAKE_REJECTED' THEN
      bound := EXISTS (SELECT 1 FROM kauro.upload_sessions u WHERE u.agency_id = NEW.agency_id AND u.upload_id = NEW.upload_id AND u.state = 'REJECTED' AND u.rejected_at = NEW.occurred_at);
    WHEN 'INTAKE_EXPIRED' THEN
      bound := EXISTS (SELECT 1 FROM kauro.upload_sessions u WHERE u.agency_id = NEW.agency_id AND u.upload_id = NEW.upload_id AND u.state = 'EXPIRED' AND u.expired_at = NEW.occurred_at);
    WHEN 'REVISION_SEALED' THEN
      bound := EXISTS (SELECT 1 FROM kauro.dataset_revisions r WHERE r.agency_id = NEW.agency_id AND r.revision_id = NEW.revision_id AND r.state = 'SEALED' AND r.sealed_at = NEW.occurred_at);
    WHEN 'EXECUTION_ADMITTED' THEN
      bound := EXISTS (
        SELECT 1 FROM kauro.processing_jobs j JOIN kauro.dataset_revisions r ON r.agency_id = j.agency_id AND r.project_id = j.project_id AND r.manifest_hash = j.revision_hash
         WHERE j.agency_id = NEW.agency_id AND j.project_id = NEW.project_id AND r.revision_id = NEW.revision_id
           AND j.state = 'ADMITTED' AND j.admitted_at = NEW.occurred_at
      );
    ELSE
      bound := true;
  END CASE;
  IF NOT bound THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: the % anchor of % records no transition taken in this transaction', NEW.anchor_kind, coalesce(NEW.upload_id, NEW.revision_id) USING ERRCODE = 'KA072';
  END IF;
  RETURN NULL;
END
$$;

-- --- the control plane's own events of execution (D8-ROLE-2, D8-XPKG-6) ----------------------------------------------------------
-- The event types of edges only the control plane performs: the request handlers are refused every one of them (a restrictive
-- policy beside B06's, like B07's source_control_event_types), and kauro_control appends them — and the two types it shares with
-- the request handlers, a cancellation for a lost authority and a PAID_ORDINARY record's creation — under a policy of its own,
-- because B07's admits only the source kinds. Migration 0022 replaces this list by its superset with the package types (0022 owns
-- their registration).
CREATE OR REPLACE FUNCTION kauro.execution_control_event_types() RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT ARRAY[
     'processing_job.admitted.v1', 'processing_job.running.v1', 'processing_job.verifying.v1', 'processing_job.ready.v1',
     'processing_job.failed.v1', 'processing_job.cancelled.v1', 'processing_job.expired.v1',
     'commercial_authorization.consumed.v1', 'commercial_authorization.delivered.v1'
   ]::text[] $$;

ALTER TABLE kauro.event_types NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.event_types (event_type) VALUES
  ('processing_job.queued.v1'), ('processing_job.admitted.v1'), ('processing_job.running.v1'), ('processing_job.verifying.v1'),
  ('processing_job.ready.v1'), ('processing_job.failed.v1'), ('processing_job.cancel_requested.v1'), ('processing_job.cancelled.v1'),
  ('processing_job.expired.v1');
ALTER TABLE kauro.event_types FORCE ROW LEVEL SECURITY;

CREATE POLICY domain_events_control_execution ON kauro.domain_events FOR INSERT TO kauro_control
  WITH CHECK (
    agency_id = kauro.current_agency_id()
    AND actor_kind = 'SERVICE'
    AND split_part(event_type, '.', 1) = aggregate_kind
    AND (
      event_type = ANY (kauro.execution_control_event_types())
      OR event_type IN ('processing_job.cancel_requested.v1', 'retention_record.created.v1')
    )
  );
CREATE POLICY domain_events_tenant_not_execution_control ON kauro.domain_events AS RESTRICTIVE FOR INSERT TO kauro_app
  WITH CHECK (NOT (event_type = ANY (kauro.execution_control_event_types())));

-- An outbox record of a commerce event the control plane appends (the entitlement's consumption and delivery) goes only to a
-- registered subscriber of its type (B09-N1): the restrictive policy B09 gave its two event-writing groups, now for the third. The
-- deferred commerce event-type check (0013) and this policy read B09's bindings and subscriptions as the control plane.
CREATE POLICY outbox_records_commerce_subscribers_control ON kauro.outbox_records AS RESTRICTIVE FOR INSERT TO kauro_control
  WITH CHECK (
    NOT EXISTS (
      SELECT 1 FROM kauro.domain_events e JOIN kauro.commerce_event_bindings b ON b.event_type = e.event_type
       WHERE e.event_id = outbox_records.event_id
    )
    OR EXISTS (
      SELECT 1 FROM kauro.domain_events e JOIN kauro.commerce_event_subscriptions s ON s.event_type = e.event_type
       WHERE e.event_id = outbox_records.event_id AND s.consumer = outbox_records.consumer
    )
  );
CREATE POLICY commerce_event_bindings_control_read ON kauro.commerce_event_bindings FOR SELECT TO kauro_control USING (true);
CREATE POLICY commerce_event_subscriptions_control_read ON kauro.commerce_event_subscriptions FOR SELECT TO kauro_control USING (true);
GRANT SELECT ON kauro.commerce_event_bindings, kauro.commerce_event_subscriptions TO kauro_control;

-- --- row-level security and grants ------------------------------------------------------------------------------------------------
-- Request handlers (kauro_app): read their tenant's jobs, queue a job as the acting person's own live operator membership (CMD036 is
-- AGENCY_OPERATOR: OWNER, ADMIN, OPERATOR), and write the cancel_command columns only (CMD037) — never an admission, a launch, a
-- consumption or a publication (D8-ROLE-2). The control plane (kauro_control): reads every job (the platform's ledger and the
-- scheduler count them all; ids, hashes, tokens and counts only) and writes the jobs of the agency it is bound to (D-CTRL-1).
ALTER TABLE kauro.processing_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.processing_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY processing_jobs_tenant_read ON kauro.processing_jobs FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY processing_jobs_tenant_queue ON kauro.processing_jobs FOR INSERT TO kauro_app
  WITH CHECK (
    agency_id = kauro.current_agency_id() AND state = 'QUEUED'
    AND EXISTS (
      SELECT 1 FROM kauro.memberships m
       WHERE m.agency_id = processing_jobs.agency_id AND m.membership_id = processing_jobs.created_by_membership_id
         AND m.user_id = kauro.current_user_id() AND m.state = 'ACTIVE' AND m.role IN ('OWNER', 'ADMIN', 'OPERATOR')
    )
  );
CREATE POLICY processing_jobs_tenant_cancel ON kauro.processing_jobs FOR UPDATE TO kauro_app
  USING (agency_id = kauro.current_agency_id())
  WITH CHECK (agency_id = kauro.current_agency_id() AND state = 'CANCEL_REQUESTED' AND cancel_actor_kind = 'USER' AND cancel_actor_id = kauro.current_user_id()::text);
CREATE POLICY processing_jobs_control_read ON kauro.processing_jobs FOR SELECT TO kauro_control USING (true);
CREATE POLICY processing_jobs_control_update ON kauro.processing_jobs FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.processing_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.processing_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY processing_attempts_control_read ON kauro.processing_attempts FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY processing_attempts_control_insert ON kauro.processing_attempts FOR INSERT TO kauro_control
  WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY processing_attempts_control_update ON kauro.processing_attempts FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.execution_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.execution_capacity FORCE ROW LEVEL SECURITY;
CREATE POLICY execution_capacity_control ON kauro.execution_capacity FOR ALL TO kauro_control USING (true) WITH CHECK (true);
-- D8-XPKG-4: DeliveryCapacityPort reads the same ledgers from a request unit and from the payment service's SERVICE unit
CREATE POLICY execution_capacity_read ON kauro.execution_capacity FOR SELECT TO kauro_app, kauro_payment USING (true);

ALTER TABLE kauro.agency_execution_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.agency_execution_capacity FORCE ROW LEVEL SECURITY;
CREATE POLICY agency_execution_capacity_tenant ON kauro.agency_execution_capacity FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY agency_execution_capacity_control_read ON kauro.agency_execution_capacity FOR SELECT TO kauro_control USING (true);
CREATE POLICY agency_execution_capacity_control_write ON kauro.agency_execution_capacity FOR INSERT TO kauro_control
  WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY agency_execution_capacity_control_update ON kauro.agency_execution_capacity FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
-- the payment service reads the ledger of the one agency it adopted (the shape of D-MERGE-3)
CREATE POLICY agency_execution_capacity_payment_read ON kauro.agency_execution_capacity FOR SELECT TO kauro_payment
  USING (agency_id = kauro.current_agency_id());

-- the entitlement's consumption and delivery are the processing package's edges (B09 §15 items 11, 13; D8-ROLE-1)
CREATE POLICY commercial_authorizations_control_read ON kauro.commercial_authorizations FOR SELECT TO kauro_control
  USING (agency_id = kauro.current_agency_id());
CREATE POLICY commercial_authorizations_control_execution ON kauro.commercial_authorizations FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id() AND state IN ('ACTIVE', 'CONSUMED'))
  WITH CHECK (agency_id = kauro.current_agency_id() AND state IN ('CONSUMED', 'DELIVERED'));

-- the column-scoped facts execution relies on, of the agency the control plane is bound to (D8-XPKG-5; the shape of B09's reads for
-- the payment service, 0013): states, hashes and references — and the plan body and the target contract's body, which the attempt
-- executes and the verifier checks (D8-VER-1) — never a client's label, a project's purpose or a person
CREATE POLICY agencies_control_execution_read ON kauro.agencies FOR SELECT TO kauro_control USING (agency_id = kauro.current_agency_id());
CREATE POLICY projects_control_execution_read ON kauro.projects FOR SELECT TO kauro_control USING (agency_id = kauro.current_agency_id());
CREATE POLICY plans_control_execution_read ON kauro.plans FOR SELECT TO kauro_control USING (agency_id = kauro.current_agency_id());
CREATE POLICY approvals_control_execution_read ON kauro.approvals FOR SELECT TO kauro_control USING (agency_id = kauro.current_agency_id());
CREATE POLICY target_contracts_control_execution_read ON kauro.target_contracts FOR SELECT TO kauro_control USING (agency_id = kauro.current_agency_id());
CREATE POLICY validation_receipts_control_execution_read ON kauro.validation_receipts FOR SELECT TO kauro_control USING (agency_id = kauro.current_agency_id());
CREATE POLICY capture_facts_control_execution_read ON kauro.capture_facts FOR SELECT TO kauro_control USING (agency_id = kauro.current_agency_id());

-- retention: the control plane writes the anchor of its admissions and the PAID_ORDINARY record anchored on it (hard deadline the
-- capture's completion + 1,209,600 s, D8-RET-1), and reads the capture's completion column-scoped (D8-XPKG-5)
CREATE POLICY retention_anchors_control_execution ON kauro.retention_anchors FOR INSERT TO kauro_control
  WITH CHECK (agency_id = kauro.current_agency_id() AND anchor_kind = 'EXECUTION_ADMITTED');
CREATE POLICY retention_records_control_paid ON kauro.retention_records FOR INSERT TO kauro_control
  WITH CHECK (
    agency_id = kauro.current_agency_id() AND class = 'PAID_ORDINARY' AND state = 'ACTIVE' AND revision_id IS NOT NULL
    AND soft_deadline IS NULL AND effective_deadline = hard_deadline
    AND EXISTS (
      SELECT 1 FROM kauro.retention_anchors a
       WHERE a.agency_id = retention_records.agency_id AND a.anchor_id = retention_records.anchor_id AND a.anchor_kind = 'EXECUTION_ADMITTED'
         AND a.revision_id = retention_records.revision_id AND a.project_id = retention_records.project_id AND a.occurred_at = kauro.server_now()
    )
    AND EXISTS (
      SELECT 1 FROM kauro.processing_jobs j
        JOIN kauro.dataset_revisions r ON r.agency_id = j.agency_id AND r.project_id = j.project_id AND r.manifest_hash = j.revision_hash
        JOIN kauro.capture_facts c ON c.agency_id = j.agency_id AND c.capture_id = j.capture_id
       WHERE j.agency_id = retention_records.agency_id AND r.revision_id = retention_records.revision_id AND j.state = 'ADMITTED'
         AND j.admitted_at = kauro.server_now() AND retention_records.hard_deadline = c.provider_completed_at + interval '1209600 seconds'
    )
  );

GRANT SELECT ON kauro.processing_jobs TO kauro_app, kauro_control;
GRANT INSERT (
  job_id, agency_id, project_id, authorization_id, capture_id, plan_id, plan_hash, approval_id, approval_hash, revision_hash,
  target_contract_hash, capability_id, capability_version, mode, validation_receipt_hash, core_package_hash, input_binding_hash,
  created_by_membership_id
) ON kauro.processing_jobs TO kauro_app;
GRANT UPDATE (version, state, cancel_version, cancel_actor_kind, cancel_actor_id, cancel_reason_code) ON kauro.processing_jobs TO kauro_app;
GRANT UPDATE (
  version, state, holds, attempt_count, current_attempt_id, fence, terminal_reason, cancel_version, cancel_actor_kind, cancel_actor_id,
  cancel_reason_code, published_package_id
) ON kauro.processing_jobs TO kauro_control;
GRANT SELECT ON kauro.processing_attempts TO kauro_control;
GRANT INSERT (attempt_id, agency_id, project_id, job_id, ordinal, identity, staging_prefix) ON kauro.processing_attempts TO kauro_control;
GRANT UPDATE (state, fence, manifest_object_name, launch_state, provider_job_id, terminal_cause) ON kauro.processing_attempts TO kauro_control;
GRANT SELECT, UPDATE ON kauro.execution_capacity TO kauro_control;
GRANT SELECT (active_jobs, waiting_jobs) ON kauro.execution_capacity TO kauro_app, kauro_payment;
GRANT SELECT ON kauro.agency_execution_capacity TO kauro_app, kauro_control;
GRANT INSERT (agency_id, live_jobs, updated_at), UPDATE (live_jobs, updated_at) ON kauro.agency_execution_capacity TO kauro_app, kauro_control;
GRANT UPDATE (last_admitted_at) ON kauro.agency_execution_capacity TO kauro_control;
GRANT SELECT (agency_id, live_jobs) ON kauro.agency_execution_capacity TO kauro_payment;
GRANT SELECT ON kauro.commercial_authorizations TO kauro_control;
GRANT UPDATE (version, state, job_ref, consumed_at, delivered_at, updated_at) ON kauro.commercial_authorizations TO kauro_control;
GRANT SELECT (agency_id, version, state) ON kauro.agencies TO kauro_control;
GRANT SELECT (project_id, agency_id, client_id, version, state, mode, capability_id, capability_version, current_revision_id) ON kauro.projects TO kauro_control;
GRANT SELECT (
  plan_id, agency_id, project_id, version, state, revision_hash, target_contract_hash, policy_hash, body, body_hash, validation_receipt_hash,
  approval_id, superseded_by_plan_id
) ON kauro.plans TO kauro_control;
GRANT SELECT (
  approval_id, agency_id, plan_id, version, plan_hash, revision_hash, target_contract_hash, validation_receipt_hash, approval_hash, created_at,
  withdrawn_at
) ON kauro.approvals TO kauro_control;
GRANT SELECT (
  contract_id, agency_id, project_id, mode, instance_id, importer_profile_id, importer_version, objects, schema_bundle_digest, body_hash,
  observed_at, confirmed_at, capability_version, superseded_at
) ON kauro.target_contracts TO kauro_control;
GRANT SELECT (
  receipt_id, agency_id, plan_id, receipt_hash, revision_hash, target_contract_hash, plan_hash, core_package_hash, profile_evidence_hash,
  disposition_evidence_hash, artifact_evidence_hash, result
) ON kauro.validation_receipts TO kauro_control;
GRANT SELECT (capture_id, agency_id, order_id, status, provider_completed_at) ON kauro.capture_facts TO kauro_control;
GRANT INSERT ON kauro.retention_records TO kauro_control;
