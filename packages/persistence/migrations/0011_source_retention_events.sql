-- 0011 — B07 source lifecycle, part 4: retention anchors and retention records, and the registered B07 event types.
--
-- Authority: 09 "Retention schedule" (incomplete upload and quarantine: twenty-four hours from upload initiation; unpaid audit
-- sources: seven days after DRAFT_READY or terminal failure, no later than fourteen days from sealing), reference/
-- HASHING_AND_ACCOUNTING_RULES "Retention formulas" (for each class record anchor evidence, soft/hard deadlines, effective
-- access deadline, actual deletion status and observed provider residuals; price validity, retries, support activity or a
-- display label cannot move a source retention anchor; abandoned unsealed upload data follows its own session/inspection
-- cleanup policy), registry contract RetentionRecord ("The effective deadline is a minimum of named anchors; retries do not
-- extend it"; hardDeadline "Absolute maximum from the owning immutable event"), policy retention.uploadReservationSeconds,
-- retention.unpaidDaysHardFromSeal, retention.extendHardCap = false, 07 "Outbox, inbox and event ordering" (registered
-- versioned event types). B07 prompt: "retention anchors survive failure". B06 foundation: D-INIT-1, D-EVT-1, D-VER-1.

-- --- retention anchors (append-only facts) --------------------------------------------------------------------------------------
-- Registered anchor kinds (a table rather than a CHECK list so later packages add AUDIT_READY, CAPTURE_CONFIRMED, ... without
-- rewriting this migration, D-MIG-1).
CREATE TABLE kauro.retention_anchor_kinds (
  anchor_kind    text PRIMARY KEY CHECK (kauro.is_token(anchor_kind)),
  registered_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO kauro.retention_anchor_kinds (anchor_kind) VALUES
  ('UPLOAD_INITIATED'), ('INPUT_ADMITTED'), ('REVISION_SEALED'), ('INTAKE_CANCELLED'), ('INTAKE_REJECTED'), ('INTAKE_EXPIRED');

-- An anchor is the immutable fact a deadline is computed from, written in the same transaction as the transition it records, so
-- it survives any later failure of the pipeline (a crash after commit cannot lose it; a rollback loses the transition with it).
-- One anchor of each kind per subject: a retry, a second completion report or a replay can never produce a later anchor.
CREATE TABLE kauro.retention_anchors (
  anchor_id      uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(anchor_id)),
  agency_id      uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id     uuid NOT NULL,
  revision_id    uuid NOT NULL,
  upload_id      uuid,
  anchor_kind    text NOT NULL REFERENCES kauro.retention_anchor_kinds (anchor_kind),
  occurred_at    timestamptz NOT NULL,
  -- KAURO_RETENTION_ANCHOR_V1 digest of {kind, ids, occurredAt, sourceEvidenceHash} (RetentionRecord.anchorEvidenceHash)
  evidence_hash  text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  created_at     timestamptz NOT NULL,
  UNIQUE (agency_id, anchor_id),
  UNIQUE (agency_id, anchor_id, evidence_hash),
  FOREIGN KEY (agency_id, project_id, revision_id) REFERENCES kauro.dataset_revisions (agency_id, project_id, revision_id),
  FOREIGN KEY (agency_id, revision_id, upload_id) REFERENCES kauro.upload_sessions (agency_id, revision_id, upload_id),
  -- B07's intake anchors name their upload; its seal anchor names the revision only (kinds later packages register decide theirs)
  CONSTRAINT retention_anchors_subject CHECK (
    anchor_kind NOT IN ('UPLOAD_INITIATED', 'INPUT_ADMITTED', 'REVISION_SEALED', 'INTAKE_CANCELLED', 'INTAKE_REJECTED', 'INTAKE_EXPIRED')
    OR (anchor_kind = 'REVISION_SEALED') = (upload_id IS NULL)
  )
);
CREATE UNIQUE INDEX retention_anchors_once_per_upload ON kauro.retention_anchors (upload_id, anchor_kind) WHERE upload_id IS NOT NULL;
CREATE UNIQUE INDEX retention_anchors_once_per_revision ON kauro.retention_anchors (revision_id, anchor_kind) WHERE upload_id IS NULL;
CREATE TRIGGER retention_anchors_append_only BEFORE UPDATE OR DELETE ON kauro.retention_anchors
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- Every reservation commits with the anchor its application deadline is computed from (D-RET-1): initiation is the creation
-- instant, and the deadline is exactly the policy's uploadReservationSeconds after it — a reservation without its anchor, or an
-- anchor at another instant, cannot commit.
CREATE OR REPLACE FUNCTION kauro.upload_sessions_initiation_anchored() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.retention_anchors a
     WHERE a.agency_id = NEW.agency_id AND a.upload_id = NEW.upload_id AND a.anchor_kind = 'UPLOAD_INITIATED' AND a.occurred_at = NEW.created_at
  ) OR NEW.application_expires_at <> NEW.created_at + interval '86400 seconds' THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: upload % commits with its UPLOAD_INITIATED anchor and a deadline of exactly 86400 s', NEW.upload_id USING ERRCODE = 'KA072';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER upload_sessions_initiation_anchored AFTER INSERT ON kauro.upload_sessions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.upload_sessions_initiation_anchored();

-- --- retention records (registry contract RetentionRecord; platform machine RetentionRecord, D-RET-2) -----------------------------
CREATE TABLE kauro.retention_records (
  retention_id          uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(retention_id)),
  agency_id             uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  client_id             uuid NOT NULL,
  project_id            uuid NOT NULL,
  -- the revision whose data the record governs (a platform column beside the contract's TenantScope)
  revision_id           uuid,
  version               bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  class                 text NOT NULL CHECK (class IN ('UNPAID', 'PAID_ORDINARY', 'PAID_STAGED', 'IMPORT_RECEIPT', 'TARGET_METADATA', 'ORDINARY_LOG', 'SECURITY_LOG', 'LEGAL_FINANCIAL')),
  anchor_id             uuid NOT NULL,
  anchor_evidence_hash  text NOT NULL CHECK (kauro.is_sha256_hex(anchor_evidence_hash)),
  soft_deadline         timestamptz,
  hard_deadline         timestamptz NOT NULL,
  effective_deadline    timestamptz NOT NULL,
  policy_version        text NOT NULL CHECK (kauro.is_label(policy_version)),
  provider_residuals    jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(provider_residuals) = 'array' AND jsonb_array_length(provider_residuals) <= 32),
  state                 text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'EXPIRED', 'DELETING', 'DELETED_WITH_RESIDUALS', 'DELETED')),
  expired_at            timestamptz,
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  UNIQUE (agency_id, retention_id),
  FOREIGN KEY (agency_id, client_id) REFERENCES kauro.end_clients (agency_id, client_id),
  FOREIGN KEY (agency_id, project_id) REFERENCES kauro.projects (agency_id, project_id),
  FOREIGN KEY (agency_id, project_id, revision_id) REFERENCES kauro.dataset_revisions (agency_id, project_id, revision_id),
  FOREIGN KEY (agency_id, anchor_id, anchor_evidence_hash) REFERENCES kauro.retention_anchors (agency_id, anchor_id, evidence_hash),
  -- "The effective deadline is a minimum of named anchors" (RetentionRecord invariant)
  CONSTRAINT retention_records_effective_is_minimum CHECK (
    effective_deadline = CASE WHEN soft_deadline IS NULL THEN hard_deadline ELSE least(soft_deadline, hard_deadline) END
  ),
  CONSTRAINT retention_records_expired_binding CHECK ((state <> 'ACTIVE' OR expired_at IS NULL) AND (state <> 'EXPIRED' OR expired_at IS NOT NULL)),
  -- a record expires no earlier than its effective deadline (a sweeper cannot pre-empt the governed data's lawful availability)
  CONSTRAINT retention_records_expiry_not_early CHECK (expired_at IS NULL OR expired_at >= effective_deadline)
);
-- one record per revision and class (the minimum is taken inside the record, never by adding a later competing record)
CREATE UNIQUE INDEX retention_records_one_per_revision_class ON kauro.retention_records (agency_id, revision_id, class) WHERE revision_id IS NOT NULL;
CREATE INDEX retention_records_due ON kauro.retention_records (effective_deadline) WHERE state = 'ACTIVE';
CREATE TRIGGER retention_records_touch BEFORE UPDATE ON kauro.retention_records FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER retention_records_version BEFORE UPDATE ON kauro.retention_records FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
-- the hard cap never moves (policy retention.extendHardCap = false); neither do the anchor and the class
CREATE TRIGGER retention_records_immutable BEFORE UPDATE ON kauro.retention_records
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('retention_id,agency_id,client_id,project_id,revision_id,class,anchor_id,anchor_evidence_hash,hard_deadline,policy_version,created_at');
CREATE TRIGGER retention_records_transition BEFORE UPDATE OF state ON kauro.retention_records
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('RetentionRecord');
CREATE TRIGGER retention_records_initial_state BEFORE INSERT ON kauro.retention_records
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('RetentionRecord');
CREATE CONSTRAINT TRIGGER retention_records_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.retention_records
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('retention_record', 'retention_id');

-- D-RET-2: RetentionRecord platform machine (the registry contract has states but no machine). B07 creates records and takes
-- ACTIVE -> EXPIRED with the revision's retention_expires; the deletion package (G-DELETE, B16) takes the managed-deletion edges.
INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('RetentionRecord', 'ACTIVE');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('RetentionRecord', 'ACTIVE', 'EXPIRED'),
  ('RetentionRecord', 'ACTIVE', 'DELETING'),
  ('RetentionRecord', 'EXPIRED', 'DELETING'),
  ('RetentionRecord', 'DELETING', 'DELETED'),
  ('RetentionRecord', 'DELETING', 'DELETED_WITH_RESIDUALS');

-- --- registered B07 event types (mirrors @kauro/domain EVENT_TYPES; the persistence test proves the lists equal) ------------------
-- event_types forces row-level security with a read-only policy, so even its owner cannot insert: the seed lifts FORCE for this
-- statement only, inside the migration's own transaction (the table ends exactly as 0005 left it). B06 registered the
-- DatasetRevision lifecycle events with the machine; these are the events of B07's own aggregates and version bumps.
ALTER TABLE kauro.event_types NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.event_types (event_type) VALUES
  ('upload_session.reserved.v1'), ('upload_session.session_issued.v1'), ('upload_session.completion_reported.v1'),
  ('upload_session.completion_observed.v1'), ('upload_session.completion_not_observed.v1'), ('upload_session.admitted.v1'),
  ('upload_session.rejected.v1'), ('upload_session.cancelled.v1'), ('upload_session.expired.v1'),
  ('upload_session.provider_cancellation_recorded.v1'),
  ('dataset_revision.selection_changed.v1'),
  ('project.current_revision_changed.v1'),
  ('retention_record.created.v1'), ('retention_record.expired.v1');
ALTER TABLE kauro.event_types FORCE ROW LEVEL SECURITY;

-- --- row-level security ----------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.retention_anchor_kinds ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.retention_anchor_kinds FORCE ROW LEVEL SECURITY;
CREATE POLICY retention_anchor_kinds_read ON kauro.retention_anchor_kinds FOR SELECT TO kauro_app, kauro_control USING (true);

ALTER TABLE kauro.retention_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.retention_anchors FORCE ROW LEVEL SECURITY;
CREATE POLICY retention_anchors_tenant ON kauro.retention_anchors FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY retention_anchors_control_read ON kauro.retention_anchors FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY retention_anchors_control_insert ON kauro.retention_anchors FOR INSERT TO kauro_control
  WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.retention_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.retention_records FORCE ROW LEVEL SECURITY;
-- request handlers create the record of the seal they commit (CMD017) and read their tenant's records; they never change one
CREATE POLICY retention_records_tenant_read ON kauro.retention_records FOR SELECT TO kauro_app
  USING (agency_id = kauro.current_agency_id());
CREATE POLICY retention_records_tenant_insert ON kauro.retention_records FOR INSERT TO kauro_app
  WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY retention_records_control_read ON kauro.retention_records FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
-- the retention sweeper expires the record of the agency it is bound to (ACTIVE -> EXPIRED); later packages add their edges
CREATE POLICY retention_records_control_expire ON kauro.retention_records FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id() AND state = 'EXPIRED');

-- --- grants ----------------------------------------------------------------------------------------------------------------------
GRANT SELECT ON kauro.retention_anchor_kinds TO kauro_app, kauro_control;
GRANT SELECT, INSERT ON kauro.retention_anchors TO kauro_app, kauro_control;
GRANT SELECT, INSERT ON kauro.retention_records TO kauro_app;
GRANT SELECT ON kauro.retention_records TO kauro_control;
GRANT UPDATE (version, state, expired_at, updated_at) ON kauro.retention_records TO kauro_control;
