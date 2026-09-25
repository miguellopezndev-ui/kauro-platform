-- 0005 — registered event types, domain events, outbox, inbox, and the event-per-version commit rule.
--
-- Authority: 07 "Outbox, inbox and event ordering" (DomainEvent contains event id, aggregate id and version, agency scope,
-- actor class, causation/correlation ids, timestamp and an allowlisted payload — references and safe counts, never CRM rows
-- or secrets; outbox dispatch is at least once; consumers deduplicate by their own durable inbox identity; inbox identity
-- includes provider and environment), 07 "Transaction discipline" (a successful command commits state, domain event and
-- outbox record atomically), registry contracts DomainEvent, OutboxRecord, InboxRecord.

-- Registered versioned event types (contract DomainEvent.eventType: "Registered versioned event type"). The seed mirrors
-- @kauro/domain EVENT_TYPES; the persistence test proves both lists are identical.
CREATE TABLE kauro.event_types (
  event_type     text PRIMARY KEY CHECK (event_type ~ '^[a-z_]+\.[a-z_]+\.v[0-9]+$'),
  registered_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO kauro.event_types (event_type) VALUES
  ('agency.created.v1'), ('agency.activated.v1'), ('agency.restricted.v1'), ('agency.restriction_remedied.v1'),
  ('agency.closing.v1'), ('agency.closed.v1'),
  ('membership.created.v1'), ('membership.invited.v1'), ('membership.accepted.v1'), ('membership.expired.v1'),
  ('membership.suspended.v1'), ('membership.reactivated.v1'), ('membership.revoked.v1'), ('membership.role_changed.v1'),
  ('agency.ownership_transferred.v1'),
  ('end_client.created.v1'), ('end_client.archived.v1'),
  ('project.created.v1'), ('dataset_revision.created.v1'),
  ('dataset_revision.uploading.v1'), ('dataset_revision.inspecting.v1'), ('dataset_revision.ready_to_seal.v1'),
  ('dataset_revision.sealed.v1'), ('dataset_revision.rejected.v1'), ('dataset_revision.cancelled.v1'),
  ('dataset_revision.superseded.v1'), ('dataset_revision.expired.v1'), ('dataset_revision.deleted.v1'),
  ('plan.created.v1'), ('plan.validation_required.v1'), ('plan.validating.v1'), ('plan.validated.v1'), ('plan.superseded.v1'),
  ('plan.approved.v1'), ('plan.withdrawn.v1'),
  ('approval.created.v1'), ('approval.withdrawn.v1');

-- --- domain events (append-only) ------------------------------------------------------------------------------------------------
CREATE TABLE kauro.domain_events (
  event_id           uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(event_id)),
  -- global append order: dispatch order within a consumer, never business order across aggregates
  sequence           bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  aggregate_kind     text NOT NULL CHECK (aggregate_kind IN ('agency', 'membership', 'end_client', 'project', 'dataset_revision', 'plan', 'approval')),
  aggregate_id       uuid NOT NULL,
  aggregate_version  bigint NOT NULL CHECK (aggregate_version >= 1),
  agency_id          uuid REFERENCES kauro.agencies (agency_id),
  event_type         text NOT NULL REFERENCES kauro.event_types (event_type),
  actor_kind         text NOT NULL CHECK (actor_kind IN ('USER', 'SERVICE', 'SYSTEM')),
  actor_id           text,
  causation_id       uuid NOT NULL,
  correlation_id     uuid NOT NULL,
  -- closed payload: allowlisted keys per event type (enforced by the publisher), bounded size (enforced here)
  payload            jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 16384),
  payload_hash       text NOT NULL CHECK (kauro.is_sha256_hex(payload_hash)),
  schema_version     text NOT NULL CHECK (schema_version ~ '^[0-9]+$'),
  created_at         timestamptz NOT NULL,
  -- event sequence numbers establish order within an aggregate (07): one event per committed version. The identity includes
  -- the tenant scope (08 "Database isolation": aggregate uniqueness includes scope), and the aggregate itself is bound to the
  -- event's agency by kauro.domain_events_bind_aggregate below, so no tenant can occupy another tenant's next version.
  CONSTRAINT domain_events_one_per_aggregate_version UNIQUE NULLS NOT DISTINCT (agency_id, aggregate_kind, aggregate_id, aggregate_version),
  CONSTRAINT domain_events_actor_shape CHECK (
    (actor_kind = 'USER' AND actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    OR (actor_kind = 'SERVICE' AND actor_id ~ '^[a-z][a-z0-9_-]{1,63}$')
    OR (actor_kind = 'SYSTEM' AND actor_id IS NULL)
  )
);
CREATE INDEX domain_events_by_agency ON kauro.domain_events (agency_id, sequence);
CREATE INDEX domain_events_by_correlation ON kauro.domain_events (correlation_id);
CREATE TRIGGER domain_events_append_only BEFORE UPDATE OR DELETE ON kauro.domain_events
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- An event records a committed version of an aggregate of its own agency (07 "Outbox, inbox and event ordering": aggregate ID
-- and version, agency scope; 08 "Database isolation": foreign keys bind tenant and parent identity). The aggregate reference
-- is polymorphic, so this trigger is the enforced equivalent of the composite foreign key: the named aggregate row must exist
-- in the event's agency and be visible to the writer (the writer's policies apply), and it must already carry the version the
-- event records (every command writes the row, then its event). An event naming another tenant's aggregate is refused
-- exactly like one naming an id that does not exist (KA006), so the event table can neither occupy another tenant's next
-- version nor tell another tenant's ids from unknown ones.
CREATE OR REPLACE FUNCTION kauro.domain_events_bind_aggregate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  current_version bigint;
BEGIN
  CASE NEW.aggregate_kind
    WHEN 'agency' THEN
      SELECT a.version INTO current_version FROM kauro.agencies a WHERE a.agency_id = NEW.aggregate_id AND a.agency_id = NEW.agency_id;
    WHEN 'membership' THEN
      SELECT m.version INTO current_version FROM kauro.memberships m WHERE m.membership_id = NEW.aggregate_id AND m.agency_id = NEW.agency_id;
    WHEN 'end_client' THEN
      SELECT c.version INTO current_version FROM kauro.end_clients c WHERE c.client_id = NEW.aggregate_id AND c.agency_id = NEW.agency_id;
    WHEN 'project' THEN
      SELECT p.version INTO current_version FROM kauro.projects p WHERE p.project_id = NEW.aggregate_id AND p.agency_id = NEW.agency_id;
    WHEN 'dataset_revision' THEN
      SELECT r.version INTO current_version FROM kauro.dataset_revisions r WHERE r.revision_id = NEW.aggregate_id AND r.agency_id = NEW.agency_id;
    WHEN 'plan' THEN
      SELECT p.version INTO current_version FROM kauro.plans p WHERE p.plan_id = NEW.aggregate_id AND p.agency_id = NEW.agency_id;
    WHEN 'approval' THEN
      SELECT a.version INTO current_version FROM kauro.approvals a WHERE a.approval_id = NEW.aggregate_id AND a.agency_id = NEW.agency_id;
    ELSE
      RAISE EXCEPTION 'CONTEXT: aggregate kind % has no binding', NEW.aggregate_kind USING ERRCODE = 'KA006';
  END CASE;
  IF current_version IS NULL THEN
    RAISE EXCEPTION 'CONTEXT: % % is not an aggregate of agency % visible in this transaction', NEW.aggregate_kind, NEW.aggregate_id, NEW.agency_id USING ERRCODE = 'KA006';
  END IF;
  IF NEW.aggregate_version > current_version THEN
    RAISE EXCEPTION 'VERSION_DISCIPLINE: an event of % % records version % ahead of the aggregate (version %)', NEW.aggregate_kind, NEW.aggregate_id, NEW.aggregate_version, current_version USING ERRCODE = 'KA002';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER domain_events_bind_aggregate BEFORE INSERT ON kauro.domain_events
  FOR EACH ROW EXECUTE FUNCTION kauro.domain_events_bind_aggregate();

-- --- outbox records --------------------------------------------------------------------------------------------------------------
CREATE TABLE kauro.outbox_records (
  outbox_id         uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(outbox_id)),
  event_id          uuid NOT NULL REFERENCES kauro.domain_events (event_id),
  consumer          text NOT NULL CHECK (kauro.is_token(consumer)),
  state             text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'CLAIMED', 'DELIVERED', 'RETRYABLE', 'DEAD_LETTER')),
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at   timestamptz NOT NULL,
  delivered_at      timestamptz,
  last_error_code   text CHECK (last_error_code IS NULL OR kauro.is_token(last_error_code)),
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  UNIQUE (event_id, consumer),
  CONSTRAINT outbox_records_delivered_binding CHECK ((state = 'DELIVERED') = (delivered_at IS NOT NULL))
);
CREATE INDEX outbox_records_dispatch ON kauro.outbox_records (next_attempt_at) WHERE state IN ('PENDING', 'RETRYABLE');
CREATE TRIGGER outbox_records_touch BEFORE UPDATE ON kauro.outbox_records FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER outbox_records_immutable BEFORE UPDATE ON kauro.outbox_records
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('outbox_id,event_id,consumer,created_at');

-- attempts never decrease; a delivered record stays delivered (an old event may add history, never roll state back)
CREATE OR REPLACE FUNCTION kauro.outbox_records_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'VERSION_DISCIPLINE: outbox % attempts cannot decrease', OLD.outbox_id USING ERRCODE = 'KA002';
  END IF;
  IF OLD.state = 'DELIVERED' AND NEW.state <> 'DELIVERED' THEN
    RAISE EXCEPTION 'JOURNAL: outbox % is delivered and cannot be reopened', OLD.outbox_id USING ERRCODE = 'KA007';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER outbox_records_guard BEFORE UPDATE ON kauro.outbox_records FOR EACH ROW EXECUTE FUNCTION kauro.outbox_records_guard();

-- --- inbox records ---------------------------------------------------------------------------------------------------------------
CREATE TABLE kauro.inbox_records (
  inbox_id            uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(inbox_id)),
  provider            text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  environment         text NOT NULL CHECK (environment IN ('LOCAL', 'SANDBOX', 'LIVE')),
  external_event_id   text NOT NULL CHECK (length(external_event_id) BETWEEN 1 AND 512),
  body_hash           text NOT NULL CHECK (kauro.is_sha256_hex(body_hash)),
  state               text NOT NULL DEFAULT 'RECEIVED' CHECK (state IN ('RECEIVED', 'PROCESSING', 'APPLIED', 'IGNORED', 'RETRYABLE', 'REJECTED')),
  received_at         timestamptz NOT NULL,
  applied_at          timestamptz,
  result_event_id     uuid REFERENCES kauro.domain_events (event_id),
  updated_at          timestamptz NOT NULL,
  -- environment and provider identity participate in deduplication (InboxRecord invariant)
  UNIQUE (provider, environment, external_event_id),
  CONSTRAINT inbox_records_applied_binding CHECK ((state = 'APPLIED') = (applied_at IS NOT NULL))
);
CREATE TRIGGER inbox_records_touch BEFORE UPDATE ON kauro.inbox_records FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER inbox_records_immutable BEFORE UPDATE ON kauro.inbox_records
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('inbox_id,provider,environment,external_event_id,body_hash,received_at');

-- A delivery that reuses a recorded event identity with another body is not a duplicate (15 "deduplicates by provider,
-- environment and event ID" deduplicates the SAME event; re-check finding N2): the ingress records it here instead of absorbing
-- it, and the recorded event cannot be settled APPLIED while such a conflict exists — the consumer reconciles it with the
-- provider (07 "Provider webhooks can arrive duplicated, late or out of order"; 10 "Unknown statuses are not coerced to success
-- or failure"). Append-only; one row per distinct conflicting body.
--
-- The conflicting delivery and the consumer's APPLIED settlement are serialized on the record (residual re-check of this
-- guard): each checks the other through a row the other has not committed, so without an order a conflict written while the
-- settlement is in flight, or a settlement written while the conflict is in flight, commits beside it and the record ends
-- APPLIED with a conflict the decision never saw. The order is the transition-lock protocol of D-TX-2 (0001) on the subject
-- ('kauro.inbox_records', inbox_id), which needs no privilege the ingress does not hold: a conflicting delivery takes the
-- shared lock before it is recorded, and the move to APPLIED takes the exclusive lock and only then re-checks the conflicts, in
-- a statement of its own. So a settlement that meets a conflict in flight waits for it and then sees it (KA012); a conflict
-- that meets a settlement in flight waits for the decision and is recorded against the settled record (history for
-- reconciliation, never absorbed); conflicting deliveries never wait for each other. The re-check sees what committed while it
-- waited only under READ COMMITTED (a new snapshot per statement); a REPEATABLE READ or SERIALIZABLE settlement would re-check
-- its older snapshot, so the move to APPLIED is refused under them (0A000) before it waits.
CREATE TABLE kauro.inbox_body_conflicts (
  conflict_id  uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(conflict_id)),
  inbox_id     uuid NOT NULL REFERENCES kauro.inbox_records (inbox_id),
  body_hash    text NOT NULL CHECK (kauro.is_sha256_hex(body_hash)),
  received_at  timestamptz NOT NULL,
  UNIQUE (inbox_id, body_hash)
);
CREATE TRIGGER inbox_body_conflicts_append_only BEFORE UPDATE OR DELETE ON kauro.inbox_body_conflicts
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

CREATE OR REPLACE FUNCTION kauro.inbox_conflict_differs() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  recorded text;
BEGIN
  -- ordered against an APPLIED settlement of the record in flight (the shared half of the record's transition lock)
  PERFORM pg_advisory_xact_lock_shared(kauro.transition_key('kauro.inbox_records', NEW.inbox_id::text));
  SELECT r.body_hash INTO recorded FROM kauro.inbox_records r WHERE r.inbox_id = NEW.inbox_id;
  IF recorded IS NULL THEN
    RAISE EXCEPTION 'CONTEXT: inbox record % is not visible', NEW.inbox_id USING ERRCODE = 'KA006';
  END IF;
  IF recorded = NEW.body_hash THEN
    RAISE EXCEPTION 'INBOX_BODY_CONFLICT: a delivery with the recorded body of % is a duplicate, not a conflict', NEW.inbox_id USING ERRCODE = 'KA012';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER inbox_body_conflicts_differ BEFORE INSERT ON kauro.inbox_body_conflicts
  FOR EACH ROW EXECUTE FUNCTION kauro.inbox_conflict_differs();

CREATE OR REPLACE FUNCTION kauro.inbox_apply_without_conflict() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'INBOX_APPLY_ISOLATION: inbox record % is applied under READ COMMITTED only, so that its conflict re-check reads what committed while it waited', NEW.inbox_id USING ERRCODE = '0A000';
  END IF;
  -- the exclusive half of the record's transition lock: a conflicting delivery in flight commits (or rolls back) first, and the
  -- next statement reads it with a new snapshot
  PERFORM pg_advisory_xact_lock(kauro.transition_key('kauro.inbox_records', NEW.inbox_id::text));
  IF EXISTS (SELECT 1 FROM kauro.inbox_body_conflicts c WHERE c.inbox_id = NEW.inbox_id) THEN
    RAISE EXCEPTION 'INBOX_BODY_CONFLICT: inbox record % has deliveries with another body; reconcile before applying it', NEW.inbox_id USING ERRCODE = 'KA012';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER inbox_records_apply_without_conflict BEFORE UPDATE OF state ON kauro.inbox_records
  FOR EACH ROW WHEN (NEW.state = 'APPLIED' AND OLD.state IS DISTINCT FROM 'APPLIED') EXECUTE FUNCTION kauro.inbox_apply_without_conflict();

-- a settled record stays settled (an old delivery may add history, never roll the consumer's decision back)
CREATE OR REPLACE FUNCTION kauro.inbox_records_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.state IN ('APPLIED', 'IGNORED', 'REJECTED') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'JOURNAL: inbox record % is settled (%)', OLD.inbox_id, OLD.state USING ERRCODE = 'KA007';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER inbox_records_guard BEFORE UPDATE ON kauro.inbox_records FOR EACH ROW EXECUTE FUNCTION kauro.inbox_records_guard();

-- --- event-per-version: a new aggregate version cannot commit without its domain event (deferred to commit) ------------------------
CREATE CONSTRAINT TRIGGER agencies_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.agencies
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('agency', 'agency_id');
CREATE CONSTRAINT TRIGGER memberships_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.memberships
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('membership', 'membership_id');
CREATE CONSTRAINT TRIGGER end_clients_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.end_clients
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('end_client', 'client_id');
CREATE CONSTRAINT TRIGGER projects_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.projects
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('project', 'project_id');
CREATE CONSTRAINT TRIGGER dataset_revisions_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.dataset_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('dataset_revision', 'revision_id');
CREATE CONSTRAINT TRIGGER plans_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.plans
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('plan', 'plan_id');
CREATE CONSTRAINT TRIGGER approvals_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.approvals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('approval', 'approval_id');

-- --- row-level security ---------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.event_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.event_types FORCE ROW LEVEL SECURITY;
CREATE POLICY event_types_read ON kauro.event_types FOR SELECT TO kauro_app, kauro_control USING (true);

ALTER TABLE kauro.domain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.domain_events FORCE ROW LEVEL SECURITY;
CREATE POLICY domain_events_tenant ON kauro.domain_events FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
-- the control plane reads events to dispatch their outbox records (allowlisted references and safe counts only); it writes no
-- aggregate, so it appends no aggregate event — a cross-tenant writer here could occupy any tenant's next version
CREATE POLICY domain_events_control_read ON kauro.domain_events FOR SELECT TO kauro_control USING (true);

ALTER TABLE kauro.outbox_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.outbox_records FORCE ROW LEVEL SECURITY;
-- a request handler may only enqueue records for events of its own tenant
CREATE POLICY outbox_records_tenant ON kauro.outbox_records FOR ALL TO kauro_app
  USING (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id = kauro.current_agency_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id = kauro.current_agency_id()));
CREATE POLICY outbox_records_control ON kauro.outbox_records FOR ALL TO kauro_control USING (true) WITH CHECK (true);

ALTER TABLE kauro.inbox_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.inbox_records FORCE ROW LEVEL SECURITY;
-- Provider ingress (10 "POST /payments/webhooks/{provider} accepts provider events under signature and environment
-- verification. It has a separate ingress/authentication policy from browser APIs"; COMMAND_CATALOGUE CMD030 authorized role
-- AUTHENTICATED_PROVIDER) records the authenticated event reference once, as RECEIVED (15 "Webhooks and reconciliation":
-- "stores a minimized immutable event reference in the inbox and deduplicates by provider, environment and event ID"). It runs
-- as its own runtime group, kauro_ingress: it inserts RECEIVED references, reads only the dedupe identity and the body hash
-- (to tell a duplicate from a conflicting body) and records conflicts, and nothing else. Reading, processing and settling inbox
-- rows is the consumer's work (07 "consumers deduplicate by their own durable inbox identity and verify state before an
-- effect"), i.e. the control plane. The request handlers of agency users (kauro_app) hold no privilege on the inbox at all:
-- under no tenant context can an agency's handler see which provider events exist, pre-insert an event id with a forged body
-- and so suppress the genuine delivery (re-check finding N2), or rewrite one (review R6) — 08 trust boundary "provider webhook
-- to inbox".
CREATE POLICY inbox_records_ingress ON kauro.inbox_records FOR INSERT TO kauro_ingress
  WITH CHECK (state = 'RECEIVED' AND applied_at IS NULL AND result_event_id IS NULL);
CREATE POLICY inbox_records_ingress_dedupe ON kauro.inbox_records FOR SELECT TO kauro_ingress USING (true);
CREATE POLICY inbox_records_control ON kauro.inbox_records FOR ALL TO kauro_control USING (true) WITH CHECK (true);

ALTER TABLE kauro.inbox_body_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.inbox_body_conflicts FORCE ROW LEVEL SECURITY;
CREATE POLICY inbox_body_conflicts_ingress ON kauro.inbox_body_conflicts FOR INSERT TO kauro_ingress WITH CHECK (true);
-- the ingress names the conflict identity as its ON CONFLICT arbiter, which PostgreSQL admits only with SELECT on those columns
CREATE POLICY inbox_body_conflicts_ingress_dedupe ON kauro.inbox_body_conflicts FOR SELECT TO kauro_ingress USING (true);
CREATE POLICY inbox_body_conflicts_control ON kauro.inbox_body_conflicts FOR SELECT TO kauro_control USING (true);

-- --- grants -----------------------------------------------------------------------------------------------------------------------
GRANT SELECT ON kauro.event_types TO kauro_app, kauro_control;
GRANT SELECT, INSERT ON kauro.domain_events TO kauro_app;
GRANT SELECT ON kauro.domain_events TO kauro_control;
GRANT USAGE ON SEQUENCE kauro.domain_events_sequence_seq TO kauro_app;
GRANT SELECT, INSERT ON kauro.outbox_records TO kauro_app;
GRANT SELECT, INSERT, UPDATE ON kauro.outbox_records TO kauro_control;
GRANT INSERT (inbox_id, provider, environment, external_event_id, body_hash, state, received_at, updated_at) ON kauro.inbox_records TO kauro_ingress;
GRANT SELECT (inbox_id, provider, environment, external_event_id, body_hash) ON kauro.inbox_records TO kauro_ingress;
GRANT INSERT ON kauro.inbox_body_conflicts TO kauro_ingress;
GRANT SELECT (inbox_id, body_hash) ON kauro.inbox_body_conflicts TO kauro_ingress;
GRANT SELECT, INSERT, UPDATE ON kauro.inbox_records TO kauro_control;
GRANT SELECT ON kauro.inbox_body_conflicts TO kauro_control;
