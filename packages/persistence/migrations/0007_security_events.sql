-- 0007 — security events (authorization decisions and other durable security facts).
--
-- Authority: 08 "Audit events and retention" (security events record actor, scope, action, outcome, policy version,
-- assurance class, correlation and time; they exclude customer payload and credentials; access grants, ownership changes and
-- deletion decisions are durable facts, not short-lived logs), 08 "Identity is not permission" (the decision includes a safe
-- reason code and policy version).

CREATE TABLE kauro.security_events (
  security_event_id  uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(security_event_id)),
  agency_id          uuid REFERENCES kauro.agencies (agency_id),
  actor_kind         text NOT NULL CHECK (actor_kind IN ('USER', 'SERVICE', 'SYSTEM')),
  actor_id           text,
  -- the command id or a platform action token (CONTEXT_SWITCH, STEP_UP_ISSUED, ...)
  action             text NOT NULL CHECK (action ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  outcome            text NOT NULL CHECK (outcome IN ('ALLOW', 'DENY')),
  reason_code        text CHECK (reason_code IS NULL OR kauro.is_token(reason_code)),
  policy_version     text NOT NULL CHECK (kauro.is_label(policy_version)),
  assurance_class    text NOT NULL CHECK (assurance_class IN ('NONE', 'SESSION', 'STEP_UP')),
  correlation_id     uuid NOT NULL,
  occurred_at        timestamptz NOT NULL,
  CONSTRAINT security_events_actor_shape CHECK (
    (actor_kind = 'USER' AND actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    OR (actor_kind = 'SERVICE' AND actor_id ~ '^[a-z][a-z0-9_-]{1,63}$')
    OR (actor_kind = 'SYSTEM' AND actor_id IS NULL)
  )
);
CREATE INDEX security_events_by_agency ON kauro.security_events (agency_id, occurred_at);
CREATE INDEX security_events_by_actor ON kauro.security_events (actor_id, occurred_at);
CREATE TRIGGER security_events_append_only BEFORE UPDATE OR DELETE ON kauro.security_events
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

ALTER TABLE kauro.security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.security_events FORCE ROW LEVEL SECURITY;
-- a request handler records events for its tenant, or for the identity itself when no tenant is selected (a denied
-- CreateAgency, a denied context switch); it reads only its tenant's events
CREATE POLICY security_events_tenant_write ON kauro.security_events FOR INSERT TO kauro_app
  WITH CHECK (
    (agency_id IS NOT NULL AND agency_id = kauro.current_agency_id())
    OR (agency_id IS NULL AND actor_kind = 'USER' AND actor_id = kauro.current_user_id()::text)
  );
CREATE POLICY security_events_tenant_read ON kauro.security_events FOR SELECT TO kauro_app
  USING (agency_id = kauro.current_agency_id());
CREATE POLICY security_events_control ON kauro.security_events FOR ALL TO kauro_control USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON kauro.security_events TO kauro_app;
GRANT SELECT, INSERT ON kauro.security_events TO kauro_control;
