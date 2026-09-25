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
-- Provider ingress (an api webhook route: 10 "POST /payments/webhooks/{provider} ... durable inbox handling") records the
-- authenticated event reference once, as RECEIVED, and learns only whether it was new (15 "Webhooks and reconciliation":
-- "stores a minimized immutable event reference in the inbox and deduplicates by provider, environment and event ID" — an
-- INSERT ... ON CONFLICT DO NOTHING without a conflict target, since naming an arbiter needs a read of the table; the fresh
-- inbox id and the inbox identity are its only unique keys). Reading, processing and settling inbox rows is the consumer's
-- work (07 "consumers deduplicate by their own durable inbox identity and verify state before an effect"), i.e. the control
-- plane. The request handlers therefore can neither read nor rewrite any inbox row: under no tenant context can one agency's
-- handler see which provider events exist or suppress another's before its consumer runs (08 trust boundary "provider
-- webhook to inbox").
CREATE POLICY inbox_records_ingress ON kauro.inbox_records FOR INSERT TO kauro_app
  WITH CHECK (state = 'RECEIVED' AND applied_at IS NULL AND result_event_id IS NULL);
CREATE POLICY inbox_records_control ON kauro.inbox_records FOR ALL TO kauro_control USING (true) WITH CHECK (true);

-- --- grants -----------------------------------------------------------------------------------------------------------------------
GRANT SELECT ON kauro.event_types TO kauro_app, kauro_control;
GRANT SELECT, INSERT ON kauro.domain_events TO kauro_app;
GRANT SELECT ON kauro.domain_events TO kauro_control;
GRANT USAGE ON SEQUENCE kauro.domain_events_sequence_seq TO kauro_app;
GRANT SELECT, INSERT ON kauro.outbox_records TO kauro_app;
GRANT SELECT, INSERT, UPDATE ON kauro.outbox_records TO kauro_control;
GRANT INSERT ON kauro.inbox_records TO kauro_app;
GRANT SELECT, INSERT, UPDATE ON kauro.inbox_records TO kauro_control;
