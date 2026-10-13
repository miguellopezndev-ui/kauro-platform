-- 0059 — operations and recovery: the operations service principal (B18-OPS-1), CMD056 RecordIncident and CMD057 AuthorizeRecovery.
--
-- registry commands CMD056 (RecordIncident, role OPERATIONS_SERVICE_OR_OWNER) and CMD057 (AuthorizeRecovery, role KAURO_OWNER), gate
-- G-RECOVERY, idempotency REQUIRED; CMD059 RestrictCapability (role OPERATIONS_SERVICE_OR_OWNER, 0051) now also runs as the service.
--
-- The operations service principal (decision B18-OPS-1). A service account has only its technical role (08): the identity
-- operations-service holds OPERATIONS_SERVICE in the code-owned SERVICE_ROLE_TABLE and runs in the SERVICE units of work of
-- kauro_commission's group, beside the commission and finance services (0028, 0034): those pools are the only verified service pools of the
-- api, and a fourth login group would add a connection site and a deployed role for three statements. What the group may do for it is
-- exactly what this file grants, row by row:
--   * its own journal entries (actor SERVICE operations-service, no agency; 0034's pattern);
--   * read capabilities and move one to SUSPENDED (CMD059): the policy's WITH CHECK admits no other state, and the revision guard below
--     refuses any other edge for the group as it already does for the request sessions;
--   * append a restriction (recorded by the service) and an incident with its responsibilities (CMD056).
-- It reads nothing of an agency and writes no ledger row.
--
-- CMD056 records an incident from evidence of an actual event, or records the false positive as such. An incident is born DETECTED with
-- the checkpoint its severity implies (S1 1 h, S2 4 h, S3 24 h, S4 72 h from the database's instant) and communication REVIEW_REQUIRED for
-- S1 and S2, or born CLOSED as a FALSE_POSITIVE with no severity and no responsibilities: nothing here fabricates a resolved production
-- outage, and no runtime role may update an incident (containment, restoration and communication are separately evidenced by later
-- commands). Instants are the database's (a birth trigger).
--
-- CMD057 authorizes a recovery over a restore candidate the platform PREPARED (the control plane, B16): the candidate moves PREPARED ->
-- AUTHORIZED once, and the recovery row is born only for the candidate's own deletion journal hash (a restore can neither run twice nor
-- resurrect rows the journal deleted). The owner acts in an OPERATOR session: kauro.acting_corporate_owner() (0029); no SECURITY DEFINER.

-- --- the operations service in the commission group ------------------------------------------------------------------------------------
CREATE POLICY command_journal_operations ON kauro.command_journal FOR ALL TO kauro_commission
  USING (agency_id IS NULL AND actor_kind = 'SERVICE' AND actor_id = 'operations-service')
  WITH CHECK (agency_id IS NULL AND actor_kind = 'SERVICE' AND actor_id = 'operations-service');

CREATE POLICY capabilities_operations_read ON kauro.capabilities FOR SELECT TO kauro_commission USING (true);
CREATE POLICY capabilities_operations_restrict ON kauro.capabilities FOR UPDATE TO kauro_commission
  USING (true) WITH CHECK (state = 'SUSPENDED');
GRANT SELECT ON kauro.capabilities TO kauro_commission;
GRANT UPDATE (state, revision, updated_at) ON kauro.capabilities TO kauro_commission;

-- the revision guard (0051): the request sessions and now the commission group's service may only restrict a capability
CREATE OR REPLACE FUNCTION kauro.capability_revision_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'a capability revision never goes back' USING ERRCODE = '23514';
  END IF;
  -- the owner's request session and the operations service move a capability only to SUSPENDED (CMD059); every other edge is the control
  -- plane's, with its gate's evidence: a marketing edit never promotes IMPLEMENTED_UNACCEPTED to AVAILABLE_LIMITED or AVAILABLE (CMD058 failure)
  IF (pg_catalog.pg_has_role(current_user, 'kauro_app', 'USAGE') OR pg_catalog.pg_has_role(current_user, 'kauro_commission', 'USAGE'))
     AND NEW.state IS DISTINCT FROM OLD.state AND NEW.state <> 'SUSPENDED' THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: a request session may only restrict a capability' USING ERRCODE = 'KA008';
  END IF;
  RETURN NEW;
END
$$;

-- --- a restriction may be recorded by the operations service ---------------------------------------------------------------------------
ALTER TABLE kauro.capability_restrictions
  ALTER COLUMN recorded_by_user_id DROP NOT NULL,
  ADD COLUMN recorded_by_service text CHECK (recorded_by_service = 'operations-service'),
  ADD CONSTRAINT capability_restrictions_one_actor CHECK ((recorded_by_user_id IS NULL) <> (recorded_by_service IS NULL));
CREATE POLICY capability_restrictions_operations_read ON kauro.capability_restrictions FOR SELECT TO kauro_commission USING (true);
CREATE POLICY capability_restrictions_operations_record ON kauro.capability_restrictions FOR INSERT TO kauro_commission
  WITH CHECK (recorded_by_service = 'operations-service' AND recorded_by_user_id IS NULL);
GRANT SELECT ON kauro.capability_restrictions TO kauro_commission;
GRANT INSERT (restriction_id, capability_id, incident_ref, prior_state, revision_after, recorded_by_service) ON kauro.capability_restrictions TO kauro_commission;

-- --- incidents (CMD056) ----------------------------------------------------------------------------------------------------------------
CREATE TABLE kauro.incidents (
  incident_id          uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(incident_id)),
  kind                 text NOT NULL CHECK (kind IN ('ACTUAL', 'FALSE_POSITIVE')),
  severity             text CHECK (severity IN ('S1', 'S2', 'S3', 'S4')),
  state                text NOT NULL CHECK (state IN ('DETECTED', 'CONTAINING', 'CONTAINED', 'RECOVERING', 'MONITORING', 'CLOSED')),
  affected_scopes      jsonb NOT NULL CHECK (jsonb_typeof(affected_scopes) = 'array' AND jsonb_array_length(affected_scopes) BETWEEN 1 AND 20),
  summary              text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
  communication_state  text NOT NULL CHECK (communication_state IN ('NOT_REQUIRED', 'REVIEW_REQUIRED', 'AUTHORIZED', 'SENT')),
  started_at           timestamptz NOT NULL,
  review_at            timestamptz NOT NULL,
  recorded_by_user_id  uuid REFERENCES kauro.identities (user_id),
  recorded_by_service  text CHECK (recorded_by_service = 'operations-service'),
  created_at           timestamptz NOT NULL,
  CONSTRAINT incidents_severity_iff_actual CHECK ((kind = 'ACTUAL') = (severity IS NOT NULL)),
  CONSTRAINT incidents_one_actor CHECK ((recorded_by_user_id IS NULL) <> (recorded_by_service IS NULL))
);
-- the birth: the database's instants, the checkpoint of the severity, the communication review of S1 and S2, and the only two birth states
CREATE OR REPLACE FUNCTION kauro.incident_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  NEW.started_at := kauro.server_now();
  NEW.created_at := NEW.started_at;
  IF NEW.kind = 'FALSE_POSITIVE' THEN
    IF NEW.state <> 'CLOSED' THEN
      RAISE EXCEPTION 'a false positive is born CLOSED' USING ERRCODE = '23514';
    END IF;
    NEW.communication_state := 'NOT_REQUIRED';
    NEW.review_at := NEW.started_at;
  ELSE
    IF NEW.state <> 'DETECTED' THEN
      RAISE EXCEPTION 'an actual incident is born DETECTED: containment and restoration are evidenced later' USING ERRCODE = '23514';
    END IF;
    NEW.communication_state := CASE WHEN NEW.severity IN ('S1', 'S2') THEN 'REVIEW_REQUIRED' ELSE 'NOT_REQUIRED' END;
    NEW.review_at := NEW.started_at + pg_catalog.make_interval(hours => CASE NEW.severity WHEN 'S1' THEN 1 WHEN 'S2' THEN 4 WHEN 'S3' THEN 24 ELSE 72 END);
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER incidents_birth BEFORE INSERT ON kauro.incidents
  FOR EACH ROW EXECUTE FUNCTION kauro.incident_birth();

CREATE TABLE kauro.incident_responsibilities (
  incident_id     uuid NOT NULL REFERENCES kauro.incidents (incident_id),
  responsibility  text NOT NULL CHECK (responsibility IN ('CONTAINMENT', 'RECOVERY', 'COMMUNICATION')),
  state           text NOT NULL CHECK (state IN ('OPEN', 'NOT_REQUIRED', 'DONE')),
  due_at          timestamptz NOT NULL,
  PRIMARY KEY (incident_id, responsibility)
);

-- --- restore candidates and recoveries (CMD057) ----------------------------------------------------------------------------------------
-- A candidate is prepared by the control plane (B16: the plan, costs, side effects, deletion tombstones and financial reconciliation are its
-- preparer's evidence, named by plan_hash); the owner authorizes it once.
CREATE TABLE kauro.restore_candidates (
  candidate_id           uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(candidate_id)),
  state                  text NOT NULL DEFAULT 'PREPARED' CHECK (state IN ('PREPARED', 'AUTHORIZED')),
  plan_hash              text NOT NULL CHECK (kauro.is_sha256_hex(plan_hash)),
  deletion_journal_hash  text NOT NULL CHECK (kauro.is_sha256_hex(deletion_journal_hash)),
  revision               integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  prepared_at            timestamptz NOT NULL DEFAULT kauro.server_now(),
  updated_at             timestamptz NOT NULL DEFAULT kauro.server_now()
);
CREATE TRIGGER restore_candidates_touch BEFORE UPDATE ON kauro.restore_candidates
  FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE OR REPLACE FUNCTION kauro.restore_candidate_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.candidate_id <> OLD.candidate_id OR NEW.plan_hash <> OLD.plan_hash OR NEW.deletion_journal_hash <> OLD.deletion_journal_hash OR NEW.prepared_at <> OLD.prepared_at THEN
    RAISE EXCEPTION 'what a restore candidate prepared never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'PREPARED' OR NEW.state <> 'AUTHORIZED' OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: a restore candidate is authorized once, from PREPARED' USING ERRCODE = 'KA008';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER restore_candidates_guard BEFORE UPDATE ON kauro.restore_candidates
  FOR EACH ROW EXECUTE FUNCTION kauro.restore_candidate_guard();

CREATE TABLE kauro.recoveries (
  recovery_id            uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(recovery_id)),
  candidate_id           uuid NOT NULL UNIQUE REFERENCES kauro.restore_candidates (candidate_id),
  deletion_journal_hash  text NOT NULL CHECK (kauro.is_sha256_hex(deletion_journal_hash)),
  authorization_ref      uuid NOT NULL,
  authorized_by_user_id  uuid NOT NULL REFERENCES kauro.identities (user_id),
  authorized_at          timestamptz NOT NULL
);
CREATE TRIGGER recoveries_append_only BEFORE UPDATE OR DELETE ON kauro.recoveries
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
-- born only over the candidate this same transaction authorized, for the candidate's own deletion journal hash; the instant is the database's
CREATE OR REPLACE FUNCTION kauro.recoveries_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  NEW.authorized_at := kauro.server_now();
  IF NOT EXISTS (
    SELECT 1 FROM kauro.restore_candidates c
     WHERE c.candidate_id = NEW.candidate_id AND c.state = 'AUTHORIZED' AND c.deletion_journal_hash = NEW.deletion_journal_hash
  ) THEN
    RAISE EXCEPTION 'a recovery is authorized over its candidate, for the candidate''s own deletion journal hash' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER recoveries_birth BEFORE INSERT ON kauro.recoveries
  FOR EACH ROW EXECUTE FUNCTION kauro.recoveries_birth();

-- --- access ----------------------------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY incidents_owner_read ON kauro.incidents FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY incidents_owner_record ON kauro.incidents FOR INSERT TO kauro_app
  WITH CHECK (kauro.acting_corporate_owner() AND recorded_by_user_id = kauro.current_user_id() AND recorded_by_service IS NULL);
CREATE POLICY incidents_operations_read ON kauro.incidents FOR SELECT TO kauro_commission USING (true);
CREATE POLICY incidents_operations_record ON kauro.incidents FOR INSERT TO kauro_commission
  WITH CHECK (recorded_by_service = 'operations-service' AND recorded_by_user_id IS NULL);
GRANT SELECT ON kauro.incidents TO kauro_app, kauro_commission;
GRANT INSERT (incident_id, kind, severity, state, affected_scopes, summary, recorded_by_user_id) ON kauro.incidents TO kauro_app;
GRANT INSERT (incident_id, kind, severity, state, affected_scopes, summary, recorded_by_service) ON kauro.incidents TO kauro_commission;

ALTER TABLE kauro.incident_responsibilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.incident_responsibilities FORCE ROW LEVEL SECURITY;
CREATE POLICY incident_responsibilities_owner_read ON kauro.incident_responsibilities FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY incident_responsibilities_owner_record ON kauro.incident_responsibilities FOR INSERT TO kauro_app WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY incident_responsibilities_operations_read ON kauro.incident_responsibilities FOR SELECT TO kauro_commission USING (true);
CREATE POLICY incident_responsibilities_operations_record ON kauro.incident_responsibilities FOR INSERT TO kauro_commission WITH CHECK (true);
GRANT SELECT, INSERT ON kauro.incident_responsibilities TO kauro_app, kauro_commission;

ALTER TABLE kauro.restore_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.restore_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_candidates_owner_read ON kauro.restore_candidates FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY restore_candidates_owner_authorize ON kauro.restore_candidates FOR UPDATE TO kauro_app
  USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY restore_candidates_control ON kauro.restore_candidates FOR ALL TO kauro_control USING (true) WITH CHECK (true);
GRANT SELECT ON kauro.restore_candidates TO kauro_app;
GRANT UPDATE (state, revision, updated_at) ON kauro.restore_candidates TO kauro_app;
GRANT SELECT, INSERT ON kauro.restore_candidates TO kauro_control;

ALTER TABLE kauro.recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.recoveries FORCE ROW LEVEL SECURITY;
CREATE POLICY recoveries_owner_read ON kauro.recoveries FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY recoveries_owner_authorize ON kauro.recoveries FOR INSERT TO kauro_app
  WITH CHECK (kauro.acting_corporate_owner() AND authorized_by_user_id = kauro.current_user_id());
CREATE POLICY recoveries_control_read ON kauro.recoveries FOR SELECT TO kauro_control USING (true);
GRANT SELECT ON kauro.recoveries TO kauro_app, kauro_control;
GRANT INSERT (recovery_id, candidate_id, deletion_journal_hash, authorization_ref, authorized_by_user_id) ON kauro.recoveries TO kauro_app;
