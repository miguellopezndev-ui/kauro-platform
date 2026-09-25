-- 0006 — command journal (idempotency), request journal (external dispatch attempts) and leases.
--
-- Authority: 10 "Idempotency contract" (identity = environment, authenticated subject or trusted system actor, agency,
-- operation and key; the stored request digest includes every material command field; reuse with another digest is
-- IDEMPOTENCY_CONFLICT; the first accepted request records its intent before external dispatch; a concurrent duplicate
-- receives the same durable result; records outlive the retry window and are linked to durable business objects),
-- 07 "Transaction discipline" (unique constraints close races in idempotency keys and active attempts),
-- registry contracts RequestJournal (persist response before marking consumed; ambiguity is an explicit state) and Lease
-- (an old live worker cannot publish after another owner advances the fence), 07 "Job and attempt states" (a claim creates a
-- monotonically increasing fence and a lease; a lease renewal cannot change the immutable execution subject).
-- Decisions D-IDEM-1..3 and D-LEASE-1 in the design document.

-- --- command journal -----------------------------------------------------------------------------------------------------------
CREATE TABLE kauro.command_journal (
  entry_id          uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(entry_id)),
  environment       text NOT NULL CHECK (environment IN ('LOCAL', 'SANDBOX', 'LIVE')),
  actor_kind        text NOT NULL CHECK (actor_kind IN ('USER', 'SERVICE')),
  actor_id          text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  -- tenant scope of the operation; NULL only for CreateAgency, whose tenant does not exist yet
  agency_id         uuid REFERENCES kauro.agencies (agency_id),
  operation         text NOT NULL CHECK (operation ~ '^CMD[0-9]{3}$'),
  idempotency_key   text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  request_digest    text NOT NULL CHECK (kauro.is_sha256_hex(request_digest)),
  state             text NOT NULL DEFAULT 'RESERVED' CHECK (state IN ('RESERVED', 'COMMITTED', 'UNCERTAIN', 'FAILED')),
  correlation_id    uuid NOT NULL,
  response_status   integer CHECK (response_status IS NULL OR response_status BETWEEN 200 AND 299),
  response_body     jsonb,
  resource_kind     text CHECK (resource_kind IS NULL OR resource_kind ~ '^[a-z_]{3,64}$'),
  resource_id       uuid,
  reserved_at       timestamptz NOT NULL,
  committed_at      timestamptz,
  updated_at        timestamptz NOT NULL,
  CONSTRAINT command_journal_committed_complete CHECK (
    state <> 'COMMITTED'
    OR (response_status IS NOT NULL AND response_body IS NOT NULL AND resource_kind IS NOT NULL AND resource_id IS NOT NULL AND committed_at IS NOT NULL)
  ),
  CONSTRAINT command_journal_actor_shape CHECK (
    (actor_kind = 'USER' AND actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    OR (actor_kind = 'SERVICE' AND actor_id ~ '^[a-z][a-z0-9_-]{1,63}$')
  )
);
-- the idempotency identity (10): a concurrent duplicate blocks on this index until the first transaction ends
CREATE UNIQUE INDEX command_journal_identity ON kauro.command_journal (
  environment, actor_kind, actor_id, coalesce(agency_id, '00000000-0000-0000-0000-000000000000'::uuid), operation, idempotency_key
);
CREATE INDEX command_journal_by_resource ON kauro.command_journal (resource_kind, resource_id);
CREATE TRIGGER command_journal_touch BEFORE UPDATE ON kauro.command_journal FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER command_journal_immutable BEFORE UPDATE ON kauro.command_journal
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('entry_id,environment,actor_kind,actor_id,agency_id,operation,idempotency_key,request_digest,correlation_id,reserved_at');

-- a committed or failed entry is final; a stored response is never rewritten (10: deleting a response cache cannot make an
-- old effect repeatable)
CREATE OR REPLACE FUNCTION kauro.command_journal_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.state IN ('COMMITTED', 'FAILED') AND (NEW.state <> OLD.state OR NEW.response_body IS DISTINCT FROM OLD.response_body
     OR NEW.response_status IS DISTINCT FROM OLD.response_status OR NEW.resource_id IS DISTINCT FROM OLD.resource_id) THEN
    RAISE EXCEPTION 'JOURNAL: command journal entry % is final', OLD.entry_id USING ERRCODE = 'KA007';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER command_journal_guard BEFORE UPDATE ON kauro.command_journal FOR EACH ROW EXECUTE FUNCTION kauro.command_journal_guard();

-- --- request journal (registry RequestJournal) --------------------------------------------------------------------------------------
CREATE TABLE kauro.request_journal (
  request_id               uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(request_id)),
  task_id                  uuid NOT NULL,
  agency_id                uuid REFERENCES kauro.agencies (agency_id),
  -- S089: a dispatch intent binds a full digest of the exact request; a short or foreign digest is refused structurally
  request_hash             text NOT NULL CHECK (kauro.is_sha256_hex(request_hash)),
  fence                    bigint NOT NULL CHECK (fence >= 1),
  state                    text NOT NULL DEFAULT 'RESERVED' CHECK (state IN ('RESERVED', 'DISPATCHING', 'UNCERTAIN', 'RESPONSE_STORED', 'CONSUMED', 'FAILED', 'CANCELLED')),
  provider_request_id      text CHECK (provider_request_id IS NULL OR length(provider_request_id) BETWEEN 1 AND 512),
  response_artifact_hash   text CHECK (response_artifact_hash IS NULL OR kauro.is_sha256_hex(response_artifact_hash)),
  usage_state              text NOT NULL DEFAULT 'UNKNOWN' CHECK (usage_state IN ('KNOWN', 'UNKNOWN', 'ESTIMATED', 'RECONCILED')),
  -- money in BIGINT minor units (07); S089: no dispatch without a positive reserved ceiling and a resolved grant
  reserved_cents           bigint NOT NULL CHECK (reserved_cents > 0),
  actual_cents             bigint CHECK (actual_cents IS NULL OR actual_cents >= 0),
  cost_grant_id            uuid NOT NULL,
  -- S089 "failed upstream": the dispatch attempts whose consumed responses this request depends on, declared with the
  -- reservation (an empty list when it depends on none). Guard request_journal_upstream_resolved below; immutable.
  upstream_request_ids     uuid[] NOT NULL,
  reserved_at              timestamptz NOT NULL,
  updated_at               timestamptz NOT NULL,
  -- one physical attempt per fence of a logical task (07: unique constraints close races in active attempts)
  UNIQUE (task_id, fence),
  CONSTRAINT request_journal_response_before_consume CHECK (state NOT IN ('RESPONSE_STORED', 'CONSUMED') OR response_artifact_hash IS NOT NULL),
  CONSTRAINT request_journal_reconciled_needs_actual CHECK (usage_state <> 'RECONCILED' OR actual_cents IS NOT NULL),
  CONSTRAINT request_journal_known_needs_actual CHECK (usage_state <> 'KNOWN' OR actual_cents IS NOT NULL),
  -- a bounded one-dimensional list (a NULL element, an unknown id and the request itself are refused by the guard below as
  -- unknown upstreams, before this constraint is evaluated)
  CONSTRAINT request_journal_upstream_shape CHECK (cardinality(upstream_request_ids) <= 64 AND coalesce(array_ndims(upstream_request_ids), 1) = 1)
);
CREATE INDEX request_journal_by_task ON kauro.request_journal (task_id, fence);
CREATE INDEX request_journal_by_agency ON kauro.request_journal (agency_id, reserved_at) WHERE agency_id IS NOT NULL;
CREATE TRIGGER request_journal_touch BEFORE UPDATE ON kauro.request_journal FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER request_journal_immutable BEFORE UPDATE ON kauro.request_journal
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('request_id,task_id,agency_id,request_hash,fence,reserved_cents,cost_grant_id,upstream_request_ids,reserved_at');

-- S089 "A prompt has short SHA, failed upstream or spending without ceiling" → "Reject runnable materialization until actual
-- dependencies and grants are resolved". A reservation (RESERVED, the durable runnable intent) can be materialized only when
-- every upstream it names is an actual dispatch attempt of the same tenant scope whose complete response was stored and
-- consumed: CONSUMED, which is terminal, so a resolved dependency can never turn into a failed one afterwards. An upstream that
-- FAILED or was CANCELLED, one that is UNCERTAIN (an ambiguous dispatch is not a resolved result — 21 "Unknown external effects
-- remain uncertain and reserved"), one still RESERVED, DISPATCHING or RESPONSE_STORED, an unknown id, another tenant's attempt
-- and a repeated id refuse the reservation with UPSTREAM_UNRESOLVED (KA009). The upstream rows are read FOR SHARE: a concurrent
-- transition of an upstream (to FAILED or to CONSUMED) is ordered entirely before or after the reservation, never interleaved.
CREATE OR REPLACE FUNCTION kauro.request_journal_upstream_resolved() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  upstream uuid;
  upstream_state text;
  upstream_agency uuid;
BEGIN
  -- an absent list is refused by the column constraint (NOT NULL), which PostgreSQL checks after BEFORE triggers
  IF NEW.upstream_request_ids IS NULL THEN
    RETURN NEW;
  END IF;
  IF cardinality(NEW.upstream_request_ids) <> (SELECT count(DISTINCT u) FROM unnest(NEW.upstream_request_ids) AS u) THEN
    RAISE EXCEPTION 'UPSTREAM_UNRESOLVED: request % names an upstream twice', NEW.request_id USING ERRCODE = 'KA009';
  END IF;
  FOREACH upstream IN ARRAY NEW.upstream_request_ids LOOP
    SELECT r.state, r.agency_id INTO upstream_state, upstream_agency
      FROM kauro.request_journal r WHERE r.request_id = upstream FOR SHARE;
    IF NOT FOUND OR upstream_agency IS DISTINCT FROM NEW.agency_id THEN
      RAISE EXCEPTION 'UPSTREAM_UNRESOLVED: request % depends on an unknown upstream %', NEW.request_id, upstream USING ERRCODE = 'KA009';
    END IF;
    IF upstream_state <> 'CONSUMED' THEN
      RAISE EXCEPTION 'UPSTREAM_UNRESOLVED: request % depends on upstream % in state %', NEW.request_id, upstream, upstream_state USING ERRCODE = 'KA009';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
CREATE TRIGGER request_journal_upstream_resolved BEFORE INSERT ON kauro.request_journal
  FOR EACH ROW EXECUTE FUNCTION kauro.request_journal_upstream_resolved();

-- terminal states stay terminal; a stored response is never replaced; updatedAt is monotonic (RequestJournal.updatedAt)
CREATE OR REPLACE FUNCTION kauro.request_journal_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.state IN ('CONSUMED', 'FAILED', 'CANCELLED') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'JOURNAL: request % is terminal (%)', OLD.request_id, OLD.state USING ERRCODE = 'KA007';
  END IF;
  IF OLD.response_artifact_hash IS NOT NULL AND NEW.response_artifact_hash IS DISTINCT FROM OLD.response_artifact_hash THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: request % response artifact cannot change', OLD.request_id USING ERRCODE = 'KA004';
  END IF;
  IF NEW.state = 'CONSUMED' AND OLD.state <> 'CONSUMED' AND OLD.state <> 'RESPONSE_STORED' THEN
    RAISE EXCEPTION 'JOURNAL: request % must store its response before being consumed', OLD.request_id USING ERRCODE = 'KA007';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER request_journal_guard BEFORE UPDATE ON kauro.request_journal FOR EACH ROW EXECUTE FUNCTION kauro.request_journal_guard();

-- --- leases (registry Lease + the immutable subject of the leased operation) --------------------------------------------------------
CREATE TABLE kauro.leases (
  resource_kind    text NOT NULL CHECK (resource_kind IN ('OUTBOX_DISPATCH', 'MODEL_TASK', 'JOB_ATTEMPT', 'SWEEP')),
  resource_id      uuid NOT NULL,
  owner_id         uuid NOT NULL,
  fence            bigint NOT NULL CHECK (fence >= 1),
  expires_at       timestamptz NOT NULL,
  heartbeat_at     timestamptz NOT NULL,
  cancel_version   bigint NOT NULL DEFAULT 0 CHECK (cancel_version >= 0),
  -- S090: the absolute deadline (clock), the execution subject, the cost identity and the checkpoint identity of the logical
  -- operation are preserved
  deadline_at      timestamptz NOT NULL,
  subject_hash     text NOT NULL CHECK (kauro.is_sha256_hex(subject_hash)),
  -- the funding authority the leased operation spends against: the CostGrant of a MODEL_TASK, the CommercialAuthorization of
  -- a JOB_ATTEMPT (07 "CommercialAuthorization": consumed by one logical processing job, with technical retries under that
  -- same entitlement; contract Audit: the logical audit retains its original deadlines and grant across retries; 22 "Preserve
  -- original deadlines and cost grants"). OUTBOX_DISPATCH and SWEEP spend nothing and carry none. Fixed by the first claim;
  -- a takeover naming another one is refused (IMMUTABLE_COLUMN).
  cost_authority_id uuid,
  checkpoint_hash  text CHECK (checkpoint_hash IS NULL OR kauro.is_sha256_hex(checkpoint_hash)),
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  PRIMARY KEY (resource_kind, resource_id),
  -- a renewal never extends past the absolute deadline
  CONSTRAINT leases_within_deadline CHECK (expires_at <= deadline_at),
  CONSTRAINT leases_cost_authority_by_kind CHECK ((resource_kind IN ('MODEL_TASK', 'JOB_ATTEMPT')) = (cost_authority_id IS NOT NULL))
);
CREATE INDEX leases_expiry ON kauro.leases (expires_at);
CREATE TRIGGER leases_touch BEFORE UPDATE ON kauro.leases FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER leases_immutable BEFORE UPDATE ON kauro.leases
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('resource_kind,resource_id,deadline_at,subject_hash,cost_authority_id,created_at');

-- fence discipline and checkpoint identity (Lease invariant; S090)
CREATE OR REPLACE FUNCTION kauro.leases_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.cancel_version < OLD.cancel_version THEN
    RAISE EXCEPTION 'LEASE: cancel version of % cannot decrease', OLD.resource_id USING ERRCODE = 'KA005';
  END IF;
  IF NEW.owner_id <> OLD.owner_id THEN
    IF NEW.fence <> OLD.fence + 1 THEN
      RAISE EXCEPTION 'LEASE_FENCED: takeover of % must advance the fence by one (% -> %)', OLD.resource_id, OLD.fence, NEW.fence USING ERRCODE = 'KA005';
    END IF;
    IF OLD.checkpoint_hash IS NOT NULL AND NEW.checkpoint_hash IS NULL THEN
      RAISE EXCEPTION 'RESUME_WITHOUT_CHECKPOINT: % has checkpoint %, a resume must name it', OLD.resource_id, OLD.checkpoint_hash USING ERRCODE = 'KA005';
    END IF;
    IF OLD.checkpoint_hash IS NOT NULL AND NEW.checkpoint_hash <> OLD.checkpoint_hash THEN
      RAISE EXCEPTION 'CHECKPOINT_MISMATCH: % resumes from % but the stored checkpoint is %', OLD.resource_id, NEW.checkpoint_hash, OLD.checkpoint_hash USING ERRCODE = 'KA005';
    END IF;
  ELSIF NEW.fence <> OLD.fence THEN
    RAISE EXCEPTION 'LEASE_FENCED: the holder of % cannot change its own fence', OLD.resource_id USING ERRCODE = 'KA005';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER leases_guard BEFORE UPDATE ON kauro.leases FOR EACH ROW EXECUTE FUNCTION kauro.leases_guard();

-- Atomic claim. Returns the resulting row: the caller compares owner_id with its own id (a different owner means HELD).
-- The first claim fixes deadline, subject and cost identity; a later claim passes them again and the immutability trigger
-- refuses a change (S090 "resets an absolute deadline" -> KA004 DEADLINE_IMMUTABLE; another cost authority -> KA004
-- COST_IMMUTABLE); a resume passes the checkpoint it continues from.
CREATE OR REPLACE FUNCTION kauro.claim_lease(
  p_kind text, p_resource uuid, p_owner uuid, p_ttl_seconds integer, p_deadline timestamptz, p_subject text, p_cost_authority uuid, p_checkpoint text, p_now timestamptz
) RETURNS kauro.leases
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  cur kauro.leases;
BEGIN
  IF p_ttl_seconds <= 0 THEN
    RAISE EXCEPTION 'LEASE: ttl must be positive' USING ERRCODE = 'KA005';
  END IF;
  IF p_now >= p_deadline THEN
    RAISE EXCEPTION 'LEASE: deadline of % has passed', p_resource USING ERRCODE = 'KA005';
  END IF;
  SELECT * INTO cur FROM kauro.leases WHERE resource_kind = p_kind AND resource_id = p_resource FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO kauro.leases (resource_kind, resource_id, owner_id, fence, expires_at, heartbeat_at, cancel_version, deadline_at, subject_hash, cost_authority_id, checkpoint_hash, created_at, updated_at)
    VALUES (p_kind, p_resource, p_owner, 1, LEAST(p_now + make_interval(secs => p_ttl_seconds), p_deadline), p_now, 0, p_deadline, p_subject, p_cost_authority, p_checkpoint, p_now, p_now)
    RETURNING * INTO cur;
    RETURN cur;
  END IF;
  IF cur.owner_id = p_owner THEN
    UPDATE kauro.leases
       SET expires_at = LEAST(p_now + make_interval(secs => p_ttl_seconds), deadline_at), heartbeat_at = p_now,
           deadline_at = p_deadline, subject_hash = p_subject, cost_authority_id = p_cost_authority
     WHERE resource_kind = p_kind AND resource_id = p_resource
     RETURNING * INTO cur;
    RETURN cur;
  END IF;
  IF cur.expires_at > p_now THEN
    RETURN cur; -- HELD by a live owner
  END IF;
  UPDATE kauro.leases
     SET owner_id = p_owner, fence = fence + 1,
         expires_at = LEAST(p_now + make_interval(secs => p_ttl_seconds), deadline_at), heartbeat_at = p_now,
         deadline_at = p_deadline, subject_hash = p_subject, cost_authority_id = p_cost_authority, checkpoint_hash = p_checkpoint
   WHERE resource_kind = p_kind AND resource_id = p_resource
   RETURNING * INTO cur;
  RETURN cur;
END
$$;

-- Heartbeat under the fence the caller holds; NULL when fenced out (the caller must stop publishing).
CREATE OR REPLACE FUNCTION kauro.heartbeat_lease(p_kind text, p_resource uuid, p_owner uuid, p_fence bigint, p_ttl_seconds integer, p_now timestamptz)
  RETURNS kauro.leases
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  cur kauro.leases;
BEGIN
  UPDATE kauro.leases
     SET expires_at = LEAST(p_now + make_interval(secs => p_ttl_seconds), deadline_at), heartbeat_at = p_now
   WHERE resource_kind = p_kind AND resource_id = p_resource AND owner_id = p_owner AND fence = p_fence AND expires_at > p_now
   RETURNING * INTO cur;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN cur;
END
$$;

-- Store a checkpoint identity under the fence the caller holds; NULL when fenced out.
CREATE OR REPLACE FUNCTION kauro.checkpoint_lease(p_kind text, p_resource uuid, p_owner uuid, p_fence bigint, p_checkpoint text, p_now timestamptz)
  RETURNS kauro.leases
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  cur kauro.leases;
BEGIN
  UPDATE kauro.leases
     SET checkpoint_hash = p_checkpoint, heartbeat_at = p_now
   WHERE resource_kind = p_kind AND resource_id = p_resource AND owner_id = p_owner AND fence = p_fence AND expires_at > p_now
   RETURNING * INTO cur;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN cur;
END
$$;

-- Advance the cancellation generation the owner must observe (07 cancellation fence).
CREATE OR REPLACE FUNCTION kauro.cancel_lease(p_kind text, p_resource uuid)
  RETURNS kauro.leases
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  cur kauro.leases;
BEGIN
  UPDATE kauro.leases SET cancel_version = cancel_version + 1
   WHERE resource_kind = p_kind AND resource_id = p_resource
   RETURNING * INTO cur;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN cur;
END
$$;

-- --- row-level security ----------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.command_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.command_journal FORCE ROW LEVEL SECURITY;
-- tenant entries under the tenant context; tenant-less entries (CreateAgency) under the identity that reserved them
CREATE POLICY command_journal_tenant ON kauro.command_journal FOR ALL TO kauro_app
  USING (
    (agency_id IS NOT NULL AND agency_id = kauro.current_agency_id())
    OR (agency_id IS NULL AND actor_kind = 'USER' AND actor_id = kauro.current_user_id()::text)
  )
  WITH CHECK (
    (agency_id IS NOT NULL AND agency_id = kauro.current_agency_id())
    OR (agency_id IS NULL AND actor_kind = 'USER' AND actor_id = kauro.current_user_id()::text)
  );
-- The control plane may observe the journal across tenants (a sweeper of RESERVED/UNCERTAIN entries), but only its safe
-- technical metadata (08 "Role and capability model": the Technical Operator inspects safe technical metadata, customer-record
-- access needs a case-specific grant): the column grant below leaves out the journaled response snapshot (it carries every
-- DTO a command answered — client labels, project purposes, agency names), the client-chosen idempotency key, the request
-- digest (a digest of a short label is guessable) and the acting person.
CREATE POLICY command_journal_control ON kauro.command_journal FOR SELECT TO kauro_control USING (true);

ALTER TABLE kauro.request_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.request_journal FORCE ROW LEVEL SECURITY;
CREATE POLICY request_journal_control ON kauro.request_journal FOR ALL TO kauro_control USING (true) WITH CHECK (true);
CREATE POLICY request_journal_tenant_read ON kauro.request_journal FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.leases FORCE ROW LEVEL SECURITY;
CREATE POLICY leases_control ON kauro.leases FOR ALL TO kauro_control USING (true) WITH CHECK (true);

-- --- grants ------------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON kauro.command_journal TO kauro_app;
GRANT SELECT (entry_id, environment, actor_kind, agency_id, operation, state, correlation_id, response_status, resource_kind, resource_id, reserved_at, committed_at, updated_at)
  ON kauro.command_journal TO kauro_control;
GRANT SELECT ON kauro.request_journal TO kauro_app;
GRANT SELECT, INSERT, UPDATE ON kauro.request_journal TO kauro_control;
GRANT SELECT, INSERT, UPDATE, DELETE ON kauro.leases TO kauro_control;
