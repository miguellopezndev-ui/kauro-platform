-- Migration 0070: B16 lane L3, CMD042 RequestDeletion and the DELETION_EXECUTOR (provisional number; the coordinator renumbers on merge).
--
-- 09 "Early deletion" and "Deletion receipts", R2-056/R2-057, S062/S064: a project deletion is requested once, by an owner or admin with a
-- fresh step-up; the request revokes new work at once and the control plane then deletes what the project owns and says, in a receipt,
-- exactly what it did.
--   1. kauro.deletion_requests: the one request per project (UNIQUE (agency_id, project_id)). Its state machine is the contract's
--      DeletionRequest (REQUESTED, AUTHORITY_REVOKED, DELETING, VERIFYING, COMPLETED, RESIDUAL_HOLD, FAILED_RETRYABLE), enforced by its
--      own trigger. The step-up the request names is judged again at COMMIT (the 0040 pattern, KC020).
--   2. kauro.deletion_receipts: append-only, one per executor attempt. A COMPLETE_FOR_MANAGED_SCOPE receipt is refused by the database
--      while a registered object of the project is not DELETED or the body names a residual (KA088), whoever writes it.
--   3. The request session (kauro_app) moves a project's ACTIVE/EXPIRED retention records to DELETING only together with the
--      REQUESTED deletion of this transaction; the control plane closes a DELETING record and the project only with the COMPLETED
--      deletion of its transaction (KA088).
--   4. Prevention (KA087 = PROJECT_DELETION_REQUESTED, KA088 = DELETION_EVIDENCE): once a project is DELETION_REQUESTED or DELETED the database accepts no new upload
--      session, audit, model task, model-request reservation or dispatch, and no payment order for it.
--   5. kauro.object_hold_needed() no longer counts the seal hold of a project whose deletion was requested, so the executor can
--      release it and delete the held generation.
--   6. The four events are known event types.
CREATE TABLE kauro.deletion_requests (
  deletion_id                 uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(deletion_id)),
  agency_id                   uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id                  uuid NOT NULL,
  state                       text NOT NULL DEFAULT 'REQUESTED' CHECK (state IN ('REQUESTED', 'AUTHORITY_REVOKED', 'DELETING', 'VERIFYING', 'COMPLETED', 'RESIDUAL_HOLD', 'FAILED_RETRYABLE')),
  reason_code                 text NOT NULL CHECK (reason_code IN ('RETENTION', 'AGENCY_REQUEST', 'ACCOUNT_CLOSURE', 'INCIDENT', 'END_OF_SERVICE')),
  requested_by_membership_id  uuid NOT NULL,
  requested_by_user_id        uuid NOT NULL REFERENCES kauro.identities (user_id),
  assurance_proof_ref         uuid NOT NULL,
  requested_at                timestamptz NOT NULL DEFAULT kauro.server_now(),
  completed_at                timestamptz,
  CONSTRAINT deletion_requests_one_per_project UNIQUE (agency_id, project_id),
  CONSTRAINT deletion_requests_receipt_key UNIQUE (agency_id, deletion_id, project_id),
  CONSTRAINT deletion_requests_completed_binding CHECK ((state = 'COMPLETED') = (completed_at IS NOT NULL)),
  FOREIGN KEY (agency_id, project_id) REFERENCES kauro.projects (agency_id, project_id),
  FOREIGN KEY (agency_id, requested_by_membership_id, requested_by_user_id) REFERENCES kauro.memberships (agency_id, membership_id, user_id)
);
CREATE TRIGGER deletion_requests_immutable BEFORE UPDATE ON kauro.deletion_requests
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('deletion_id,agency_id,project_id,reason_code,requested_by_membership_id,requested_by_user_id,assurance_proof_ref,requested_at');

-- the machine: REQUESTED -> AUTHORITY_REVOKED -> DELETING -> VERIFYING -> COMPLETED | RESIDUAL_HOLD | FAILED_RETRYABLE;
-- FAILED_RETRYABLE and RESIDUAL_HOLD resume at DELETING; a retry never leaves COMPLETED
CREATE OR REPLACE FUNCTION kauro.deletion_requests_workflow() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT ((OLD.state, NEW.state) IN (
      ('REQUESTED', 'AUTHORITY_REVOKED'), ('AUTHORITY_REVOKED', 'DELETING'), ('DELETING', 'VERIFYING'), ('VERIFYING', 'COMPLETED'),
      ('VERIFYING', 'RESIDUAL_HOLD'), ('VERIFYING', 'FAILED_RETRYABLE'), ('DELETING', 'FAILED_RETRYABLE'), ('FAILED_RETRYABLE', 'DELETING'),
      ('RESIDUAL_HOLD', 'DELETING'), ('VERIFYING', 'DELETING')
    )) THEN
      RAISE EXCEPTION 'UNLISTED_TRANSITION: DeletionRequest % -> % is not a listed edge', OLD.state, NEW.state USING ERRCODE = 'KA008';
    END IF;
    IF NEW.state = 'COMPLETED' THEN
      NEW.completed_at := kauro.server_now();
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION kauro.deletion_requests_workflow() FROM PUBLIC;
CREATE TRIGGER deletion_requests_workflow BEFORE UPDATE ON kauro.deletion_requests
  FOR EACH ROW EXECUTE FUNCTION kauro.deletion_requests_workflow();

-- the request is born REQUESTED for a project that is DELETION_REQUESTED in this very transaction, by its own session's user
CREATE OR REPLACE FUNCTION kauro.deletion_requests_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.state <> 'REQUESTED' OR NEW.completed_at IS NOT NULL OR NEW.requested_at IS DISTINCT FROM kauro.server_now() THEN
    RAISE EXCEPTION 'DELETION_EVIDENCE: deletion % is born REQUESTED at the server''s transaction time', NEW.deletion_id USING ERRCODE = 'KA088';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kauro.projects p WHERE p.agency_id = NEW.agency_id AND p.project_id = NEW.project_id AND p.state = 'DELETION_REQUESTED') THEN
    RAISE EXCEPTION 'DELETION_EVIDENCE: deletion % is requested for a project that is DELETION_REQUESTED', NEW.deletion_id USING ERRCODE = 'KA088';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION kauro.deletion_requests_birth() FROM PUBLIC;
CREATE TRIGGER deletion_requests_birth BEFORE INSERT ON kauro.deletion_requests
  FOR EACH ROW EXECUTE FUNCTION kauro.deletion_requests_birth();

-- the step-up the request names is fresh at the COMMIT (0040): else STEP_UP_EXPIRED (KC020, ASSURANCE_REQUIRED STEP_UP_STALE)
CREATE OR REPLACE FUNCTION kauro.deletion_step_up_at_commit() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.assurance_proofs a
     WHERE a.user_id = NEW.requested_by_user_id AND a.proof_id = NEW.assurance_proof_ref AND a.kind = 'STEP_UP' AND a.expires_at > kauro.effect_now()
  ) THEN
    RAISE EXCEPTION 'STEP_UP_EXPIRED: the step-up requesting the deletion of project % expired before the COMMIT', NEW.project_id USING ERRCODE = 'KC020';
  END IF;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION kauro.deletion_step_up_at_commit() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER deletion_requests_step_up_at_commit AFTER INSERT ON kauro.deletion_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.deletion_step_up_at_commit();

CREATE TABLE kauro.deletion_receipts (
  receipt_id   uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(receipt_id)),
  deletion_id  uuid NOT NULL,
  agency_id    uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id   uuid NOT NULL,
  status       text NOT NULL CHECK (status IN ('PARTIAL', 'COMPLETE_FOR_MANAGED_SCOPE')),
  body         jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  created_at   timestamptz NOT NULL DEFAULT kauro.server_now(),
  FOREIGN KEY (agency_id, deletion_id, project_id) REFERENCES kauro.deletion_requests (agency_id, deletion_id, project_id)
);
CREATE INDEX deletion_receipts_by_deletion ON kauro.deletion_receipts (deletion_id, created_at, receipt_id);
CREATE TRIGGER deletion_receipts_append_only BEFORE UPDATE OR DELETE ON kauro.deletion_receipts
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- KA088: a COMPLETE receipt is true only if every registered object of the project in the managed zones is DELETED and the body
-- names no residual. The lawful residuals (LEGAL_FINANCE, SECURITY) are not managed scope.
CREATE OR REPLACE FUNCTION kauro.deletion_receipts_complete_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.created_at IS DISTINCT FROM kauro.server_now() THEN
    RAISE EXCEPTION 'DELETION_EVIDENCE: receipt % is written at the server''s transaction time', NEW.receipt_id USING ERRCODE = 'KA088';
  END IF;
  IF NEW.status = 'COMPLETE_FOR_MANAGED_SCOPE' THEN
    IF coalesce(jsonb_array_length(NEW.body -> 'residuals'), 1) <> 0 THEN
      RAISE EXCEPTION 'DELETION_EVIDENCE: a complete receipt of deletion % names no residual', NEW.deletion_id USING ERRCODE = 'KA088';
    END IF;
    IF EXISTS (
      SELECT 1 FROM kauro.stored_objects o
       WHERE o.agency_id = NEW.agency_id AND o.project_id = NEW.project_id AND o.zone NOT IN ('LEGAL_FINANCE', 'SECURITY') AND o.state <> 'DELETED'
    ) THEN
      RAISE EXCEPTION 'DELETION_EVIDENCE: a complete receipt of deletion % while a registered object of the project is not DELETED', NEW.deletion_id USING ERRCODE = 'KA088';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION kauro.deletion_receipts_complete_guard() FROM PUBLIC;
CREATE TRIGGER deletion_receipts_complete_guard BEFORE INSERT ON kauro.deletion_receipts
  FOR EACH ROW EXECUTE FUNCTION kauro.deletion_receipts_complete_guard();

ALTER TABLE kauro.deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.deletion_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY deletion_requests_tenant_read ON kauro.deletion_requests FOR SELECT TO kauro_app
  USING (agency_id = kauro.current_agency_id());
CREATE POLICY deletion_requests_tenant_insert ON kauro.deletion_requests FOR INSERT TO kauro_app
  WITH CHECK (agency_id = kauro.current_agency_id() AND requested_by_user_id = kauro.current_user_id() AND state = 'REQUESTED');
CREATE POLICY deletion_requests_control_read ON kauro.deletion_requests FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY deletion_requests_control_update ON kauro.deletion_requests FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
GRANT SELECT, INSERT ON kauro.deletion_requests TO kauro_app;
GRANT SELECT ON kauro.deletion_requests TO kauro_control;
GRANT UPDATE (state, completed_at) ON kauro.deletion_requests TO kauro_control;

ALTER TABLE kauro.deletion_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.deletion_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY deletion_receipts_tenant_read ON kauro.deletion_receipts FOR SELECT TO kauro_app
  USING (agency_id = kauro.current_agency_id());
CREATE POLICY deletion_receipts_control_read ON kauro.deletion_receipts FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY deletion_receipts_control_insert ON kauro.deletion_receipts FOR INSERT TO kauro_control
  WITH CHECK (agency_id = kauro.current_agency_id());
GRANT SELECT ON kauro.deletion_receipts TO kauro_app;
GRANT SELECT, INSERT ON kauro.deletion_receipts TO kauro_control;

-- --- the retention records of a deleting project ------------------------------------------------------------------------------------
-- the request session takes ACTIVE/EXPIRED -> DELETING (the listed edges of 0012) of its own agency's records
CREATE POLICY retention_records_tenant_deleting ON kauro.retention_records FOR UPDATE TO kauro_app
  USING (agency_id = kauro.current_agency_id() AND state IN ('ACTIVE', 'EXPIRED'))
  WITH CHECK (agency_id = kauro.current_agency_id() AND state = 'DELETING');
GRANT UPDATE (state) ON kauro.retention_records TO kauro_app;
-- the control plane closes a DELETING record
CREATE POLICY retention_records_control_deleted ON kauro.retention_records FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id() AND state = 'DELETING')
  WITH CHECK (agency_id = kauro.current_agency_id() AND state IN ('DELETED', 'DELETED_WITH_RESIDUALS'));

-- DELETING needs the REQUESTED deletion of this transaction; DELETED and DELETED_WITH_RESIDUALS need the COMPLETED deletion of this
-- transaction (the receipt-guarded close)
CREATE OR REPLACE FUNCTION kauro.retention_records_deletion_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.state = 'DELETING' THEN
    IF NOT EXISTS (
      SELECT 1 FROM kauro.deletion_requests d
       WHERE d.agency_id = OLD.agency_id AND d.project_id = OLD.project_id AND d.state = 'REQUESTED' AND d.requested_at = kauro.server_now()
    ) THEN
      RAISE EXCEPTION 'DELETION_EVIDENCE: retention record % is DELETING only with the deletion requested in this transaction', OLD.retention_id USING ERRCODE = 'KA088';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM kauro.deletion_requests d
       WHERE d.agency_id = OLD.agency_id AND d.project_id = OLD.project_id AND d.state = 'COMPLETED' AND d.completed_at = kauro.server_now()
    ) THEN
      RAISE EXCEPTION 'DELETION_EVIDENCE: retention record % is closed only with the deletion completed in this transaction', OLD.retention_id USING ERRCODE = 'KA088';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION kauro.retention_records_deletion_guard() FROM PUBLIC;
CREATE TRIGGER retention_records_deletion_guard BEFORE UPDATE OF state ON kauro.retention_records
  FOR EACH ROW WHEN (NEW.state IN ('DELETING', 'DELETED', 'DELETED_WITH_RESIDUALS') AND OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.retention_records_deletion_guard();

-- --- the project: DELETED only with the completed deletion of this transaction -----------------------------------------------------
CREATE POLICY projects_control_deleted ON kauro.projects FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id() AND state = 'DELETION_REQUESTED')
  WITH CHECK (agency_id = kauro.current_agency_id() AND state = 'DELETED');
GRANT UPDATE (state, version) ON kauro.projects TO kauro_control;
CREATE OR REPLACE FUNCTION kauro.projects_deleted_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.deletion_requests d
     WHERE d.agency_id = OLD.agency_id AND d.project_id = OLD.project_id AND d.state = 'COMPLETED' AND d.completed_at = kauro.server_now()
  ) THEN
    RAISE EXCEPTION 'DELETION_EVIDENCE: project % is DELETED only with its deletion completed in this transaction', OLD.project_id USING ERRCODE = 'KA088';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION kauro.projects_deleted_guard() FROM PUBLIC;
CREATE TRIGGER projects_deleted_guard BEFORE UPDATE OF state ON kauro.projects
  FOR EACH ROW WHEN (NEW.state = 'DELETED' AND OLD.state IS DISTINCT FROM 'DELETED') EXECUTE FUNCTION kauro.projects_deleted_guard();

-- --- prevention (KA087 = PROJECT_DELETION_REQUESTED, KA088 = DELETION_EVIDENCE): nothing new enters a project whose deletion was requested -----------------------------
CREATE OR REPLACE FUNCTION kauro.refuse_deleting_project() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  project uuid;
  agency uuid;
BEGIN
  IF TG_TABLE_NAME = 'model_tasks' THEN
    SELECT a.project_id, a.agency_id INTO project, agency FROM kauro.audits a WHERE a.audit_id = NEW.audit_id;
  ELSIF TG_TABLE_NAME = 'request_journal' THEN
    SELECT a.project_id, a.agency_id INTO project, agency
      FROM kauro.model_tasks m JOIN kauro.audits a ON a.agency_id = m.agency_id AND a.audit_id = m.audit_id
     WHERE m.model_task_id = NEW.task_id;
  ELSE
    project := NEW.project_id;
    agency := NEW.agency_id;
  END IF;
  IF project IS NOT NULL AND EXISTS (SELECT 1 FROM kauro.projects p WHERE p.agency_id = agency AND p.project_id = project AND p.state IN ('DELETION_REQUESTED', 'DELETED')) THEN
    RAISE EXCEPTION 'PROJECT_DELETION_REQUESTED: project % was requested for deletion and accepts no new % work', project, TG_TABLE_NAME USING ERRCODE = 'KA087';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION kauro.refuse_deleting_project() FROM PUBLIC;
CREATE TRIGGER upload_sessions_deleting_project BEFORE INSERT ON kauro.upload_sessions
  FOR EACH ROW EXECUTE FUNCTION kauro.refuse_deleting_project();
CREATE TRIGGER audits_deleting_project BEFORE INSERT ON kauro.audits
  FOR EACH ROW EXECUTE FUNCTION kauro.refuse_deleting_project();
CREATE TRIGGER model_tasks_deleting_project BEFORE INSERT ON kauro.model_tasks
  FOR EACH ROW EXECUTE FUNCTION kauro.refuse_deleting_project();
CREATE TRIGGER request_journal_deleting_project BEFORE INSERT ON kauro.request_journal
  FOR EACH ROW EXECUTE FUNCTION kauro.refuse_deleting_project();
CREATE TRIGGER request_journal_deleting_dispatch BEFORE UPDATE OF state ON kauro.request_journal
  FOR EACH ROW WHEN (OLD.state = 'RESERVED' AND NEW.state = 'DISPATCHING') EXECUTE FUNCTION kauro.refuse_deleting_project();
CREATE TRIGGER payment_orders_deleting_project BEFORE INSERT ON kauro.payment_orders
  FOR EACH ROW EXECUTE FUNCTION kauro.refuse_deleting_project();

-- --- the seal hold of a deleting project is not needed (the executor releases it, then deletes the generation) -----------------------
CREATE OR REPLACE FUNCTION kauro.object_hold_needed(object uuid) RETURNS boolean
  LANGUAGE sql STABLE STRICT SET search_path = pg_catalog AS
$$
  SELECT EXISTS (SELECT 1 FROM kauro.object_holds h WHERE h.object_id = object AND h.state = 'INTENDED')
      OR EXISTS (
           SELECT 1 FROM kauro.object_holds h JOIN kauro.source_files f ON f.agency_id = h.agency_id AND f.file_id = h.file_id
            WHERE h.object_id = object AND h.state = 'SEALED' AND f.state = 'ADMITTED'
              AND NOT EXISTS (SELECT 1 FROM kauro.projects p WHERE p.agency_id = h.agency_id AND p.project_id = h.project_id AND p.state IN ('DELETION_REQUESTED', 'DELETED'))
         )
$$;

-- --- the control plane reads what the deletion enumerates --------------------------------------------------------------------------
-- (audits and model tasks have control read policies since 0023; the package versions and the revisions are read as the agency)

ALTER TABLE kauro.event_types NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.event_types (event_type) VALUES
  ('project.deletion_requested.v1'), ('project.deleted.v1'), ('retention_record.deleting.v1'), ('retention_record.deleted.v1');
ALTER TABLE kauro.event_types FORCE ROW LEVEL SECURITY;

-- --- the control plane appends the two closing events -------------------------------------------------------------------------------
-- (the request session's two events, project.deletion_requested.v1 and retention_record.deleting.v1, are the handlers'; the close's are
-- the control plane's and a request handler may not forge them)
CREATE OR REPLACE FUNCTION kauro.deletion_control_event_types() RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT ARRAY['project.deleted.v1', 'retention_record.deleted.v1', 'dataset_revision.deleted.v1']::text[] $$;
REVOKE EXECUTE ON FUNCTION kauro.deletion_control_event_types() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kauro.deletion_control_event_types() TO kauro_app, kauro_control;
CREATE POLICY domain_events_control_deletion ON kauro.domain_events FOR INSERT TO kauro_control
  WITH CHECK (
    agency_id = kauro.current_agency_id()
    AND actor_kind = 'SERVICE'
    AND split_part(event_type, '.', 1) = aggregate_kind
    AND event_type = ANY (kauro.deletion_control_event_types())
  );
CREATE POLICY domain_events_tenant_not_deletion_control ON kauro.domain_events AS RESTRICTIVE FOR INSERT TO kauro_app
  WITH CHECK (NOT (event_type = ANY (kauro.deletion_control_event_types())));

-- --- the revisions: a cancelled or expired revision is DELETED only with the completed deletion of this transaction -------------------------
-- (R2 state_transitions DatasetRevision: managed_cleanup_verified takes CANCELLED and EXPIRED to DELETED; a SEALED or REJECTED revision has
-- no deletion edge and stays as it is, named a residual in the receipt)
CREATE POLICY dataset_revisions_control_deleted ON kauro.dataset_revisions FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id() AND state IN ('CANCELLED', 'EXPIRED'))
  WITH CHECK (agency_id = kauro.current_agency_id() AND state = 'DELETED');
GRANT UPDATE (deleted_at) ON kauro.dataset_revisions TO kauro_control;
CREATE OR REPLACE FUNCTION kauro.dataset_revisions_deleted_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.state NOT IN ('CANCELLED', 'EXPIRED') OR NOT EXISTS (
    SELECT 1 FROM kauro.deletion_requests d
     WHERE d.agency_id = OLD.agency_id AND d.project_id = OLD.project_id AND d.state = 'COMPLETED' AND d.completed_at = kauro.server_now()
  ) THEN
    RAISE EXCEPTION 'DELETION_EVIDENCE: revision % is DELETED only from CANCELLED or EXPIRED with its project deletion completed in this transaction', OLD.revision_id USING ERRCODE = 'KA088';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION kauro.dataset_revisions_deleted_guard() FROM PUBLIC;
CREATE TRIGGER dataset_revisions_deleted_guard BEFORE UPDATE OF state ON kauro.dataset_revisions
  FOR EACH ROW WHEN (NEW.state = 'DELETED' AND OLD.state IS DISTINCT FROM 'DELETED') EXECUTE FUNCTION kauro.dataset_revisions_deleted_guard();
