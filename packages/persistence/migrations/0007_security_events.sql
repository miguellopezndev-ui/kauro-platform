-- 0007 — security events (authorization decisions and other durable security facts).
--
-- Authority: 08 "Audit events and retention" (security events record actor, scope, action, outcome, policy version,
-- assurance class, correlation and time; they exclude customer payload and credentials; access grants, ownership changes and
-- deletion decisions are durable facts, not short-lived logs), 08 "Identity is not permission" (the decision includes a safe
-- reason code and policy version), 08 "Threat model and assets" (threat actors include an unauthenticated visitor and one
-- agency trying to access another; every trust boundary has an audit event), 08 "Browser, API and cache isolation" (errors do
-- not disclose that an agency exists), 08 "Database isolation" (RLS applies visibility and writes through USING and WITH
-- CHECK). Review record docs/design/B06-review/A-pipeline-authorization.md (R2, R26).
--
-- Every fact belongs to exactly one stream:
--   * an agency's stream (agency_id set): written only by a caller who holds a live membership in that agency, as itself,
--     inside that agency's context — an outsider can never write into an agency's audit record, whatever context it binds;
--   * the caller's own identity stream (agency_id NULL, actor = the caller): a denied CreateAgency, an identity-status
--     denial of a non-member, a non-member's probe. requested_agency_id names the agency the request selected: a name, not a
--     reference (no foreign key), so recording a probe of a nonexistent agency is not an existence check;
--   * anonymous (actor_kind ANONYMOUS, no actor id, no agency): the denial of a request that carried no authenticated
--     subject, written with neither a user nor an agency bound.

CREATE TABLE kauro.security_events (
  security_event_id    uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(security_event_id)),
  agency_id            uuid REFERENCES kauro.agencies (agency_id),
  -- the agency selector of a request whose fact belongs to no agency stream (no FK: a name, never an existence check)
  requested_agency_id  uuid,
  actor_kind           text NOT NULL CHECK (actor_kind IN ('USER', 'SERVICE', 'SYSTEM', 'ANONYMOUS')),
  actor_id             text,
  -- the command id or a platform action token (CONTEXT_SWITCH, STEP_UP_ISSUED, ...)
  action               text NOT NULL CHECK (action ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  outcome              text NOT NULL CHECK (outcome IN ('ALLOW', 'DENY')),
  reason_code          text CHECK (reason_code IS NULL OR kauro.is_token(reason_code)),
  policy_version       text NOT NULL CHECK (kauro.is_label(policy_version)),
  assurance_class      text NOT NULL CHECK (assurance_class IN ('NONE', 'SESSION', 'STEP_UP')),
  correlation_id       uuid NOT NULL,
  occurred_at          timestamptz NOT NULL,
  CONSTRAINT security_events_actor_shape CHECK (
    (actor_kind = 'USER' AND actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    OR (actor_kind = 'SERVICE' AND actor_id ~ '^[a-z][a-z0-9_-]{1,63}$')
    OR (actor_kind IN ('SYSTEM', 'ANONYMOUS') AND actor_id IS NULL)
  ),
  -- a fact is in an agency's stream or names the agency it asked for, never both
  CONSTRAINT security_events_one_scope CHECK (agency_id IS NULL OR requested_agency_id IS NULL),
  -- nobody is allowed anything anonymously, and an anonymous request belongs to no agency's stream
  CONSTRAINT security_events_anonymous_denial CHECK (
    actor_kind <> 'ANONYMOUS' OR (outcome = 'DENY' AND assurance_class = 'NONE' AND agency_id IS NULL)
  )
);
CREATE INDEX security_events_by_agency ON kauro.security_events (agency_id, occurred_at);
CREATE INDEX security_events_by_actor ON kauro.security_events (actor_id, occurred_at);
CREATE INDEX security_events_by_requested_agency ON kauro.security_events (requested_agency_id, occurred_at)
  WHERE requested_agency_id IS NOT NULL;
CREATE TRIGGER security_events_append_only BEFORE UPDATE OR DELETE ON kauro.security_events
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

ALTER TABLE kauro.security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.security_events FORCE ROW LEVEL SECURITY;
-- a request handler appends the three kinds of fact above and nothing else; the membership subquery runs under the
-- memberships policies of the same context, which show the caller its own rows
CREATE POLICY security_events_tenant_write ON kauro.security_events FOR INSERT TO kauro_app
  WITH CHECK (
    (agency_id IS NOT NULL AND agency_id = kauro.current_agency_id()
      AND actor_kind = 'USER' AND actor_id = kauro.current_user_id()::text
      AND EXISTS (
        SELECT 1 FROM kauro.memberships m
        WHERE m.agency_id = security_events.agency_id AND m.user_id = kauro.current_user_id()
          AND m.state IN ('INVITED', 'ACTIVE', 'SUSPENDED')
      ))
    OR (agency_id IS NULL AND actor_kind = 'USER' AND actor_id = kauro.current_user_id()::text)
    OR (agency_id IS NULL AND actor_kind = 'ANONYMOUS' AND kauro.current_user_id() IS NULL AND kauro.current_agency_id() IS NULL)
  );
-- an agency reads its own stream only: never another agency's facts, an identity-owned fact that names it, or an anonymous one
CREATE POLICY security_events_tenant_read ON kauro.security_events FOR SELECT TO kauro_app
  USING (agency_id = kauro.current_agency_id());
CREATE POLICY security_events_control ON kauro.security_events FOR ALL TO kauro_control USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON kauro.security_events TO kauro_app;
GRANT SELECT, INSERT ON kauro.security_events TO kauro_control;
