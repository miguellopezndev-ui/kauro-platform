-- 0011 — B07 source lifecycle, part 4: retention anchors and retention records, and the registered B07 event types.
--
-- Authority: 09 "Retention schedule" (incomplete upload and quarantine: twenty-four hours from upload initiation; unpaid audit
-- sources: seven days after DRAFT_READY or terminal failure, no later than fourteen days from sealing), reference/
-- HASHING_AND_ACCOUNTING_RULES "Retention formulas" (for each class record anchor evidence, soft/hard deadlines, effective
-- access deadline, actual deletion status and observed provider residuals; price validity, retries, support activity or a
-- display label cannot move a source retention anchor; abandoned unsealed upload data follows its own session/inspection
-- cleanup policy), registry contract RetentionRecord ("The effective deadline is a minimum of named anchors; retries do not
-- extend it"; hardDeadline "Absolute maximum from the owning immutable event"), policy retention.extendHardCap = false,
-- 07 "Outbox, inbox and event ordering" (registered versioned event types).

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
  FOREIGN KEY (agency_id, revision_id, upload_id) REFERENCES kauro.upload_sessions (agency_id, revision_id, upload_id)
);
CREATE UNIQUE INDEX retention_anchors_once_per_upload ON kauro.retention_anchors (upload_id, anchor_kind) WHERE upload_id IS NOT NULL;
CREATE UNIQUE INDEX retention_anchors_once_per_revision ON kauro.retention_anchors (revision_id, anchor_kind) WHERE upload_id IS NULL;
CREATE TRIGGER retention_anchors_append_only BEFORE UPDATE OR DELETE ON kauro.retention_anchors
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- retention records (registry contract RetentionRecord) ------------------------------------------------------------------------
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
  )
);
-- one record per revision and class (the minimum is taken inside the record, never by adding a later competing record)
CREATE UNIQUE INDEX retention_records_one_per_revision_class ON kauro.retention_records (agency_id, revision_id, class) WHERE revision_id IS NOT NULL;
CREATE INDEX retention_records_due ON kauro.retention_records (effective_deadline) WHERE state = 'ACTIVE';
CREATE TRIGGER retention_records_touch BEFORE UPDATE ON kauro.retention_records FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER retention_records_version BEFORE UPDATE ON kauro.retention_records FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
-- the hard cap never moves (policy retention.extendHardCap = false); neither do the anchor and the class
CREATE TRIGGER retention_records_immutable BEFORE UPDATE ON kauro.retention_records
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('retention_id,agency_id,client_id,project_id,revision_id,class,anchor_id,anchor_evidence_hash,hard_deadline,policy_version,created_at');
-- no RetentionRecord edge is seeded here: the lifecycle (expiry, deletion, residuals) belongs to the deletion package (B16),
-- so until its edges are registered every state change is refused (fail closed)
CREATE TRIGGER retention_records_transition BEFORE UPDATE OF state ON kauro.retention_records
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('RetentionRecord');
CREATE CONSTRAINT TRIGGER retention_records_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.retention_records
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('retention_record', 'retention_id');

-- --- registered B07 event types (mirrors @kauro/domain EVENT_TYPES; the persistence test proves the lists equal) ------------------
-- event_types forces row-level security with a read-only policy, so even its owner cannot insert: the seed lifts FORCE for this
-- statement only, inside the migration's own transaction (the table ends exactly as 0005 left it).
ALTER TABLE kauro.event_types NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.event_types (event_type) VALUES
  ('upload_session.reserved.v1'), ('upload_session.session_issued.v1'), ('upload_session.completion_reported.v1'),
  ('upload_session.completion_observed.v1'), ('upload_session.completion_not_observed.v1'), ('upload_session.admitted.v1'),
  ('upload_session.rejected.v1'), ('upload_session.cancelled.v1'), ('upload_session.expired.v1'),
  ('upload_session.provider_cancellation_recorded.v1'),
  ('dataset_revision.uploading.v1'), ('dataset_revision.inspecting.v1'), ('dataset_revision.selection_changed.v1'),
  ('dataset_revision.ready_to_seal.v1'), ('dataset_revision.rejected.v1'), ('dataset_revision.sealed.v1'),
  ('dataset_revision.superseded.v1'), ('dataset_revision.cancelled.v1'), ('dataset_revision.expired.v1'),
  ('dataset_revision.deleted.v1'),
  ('project.current_revision_changed.v1'),
  ('retention_record.created.v1');
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
CREATE POLICY retention_records_tenant ON kauro.retention_records FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY retention_records_control_read ON kauro.retention_records FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());

-- --- grants ----------------------------------------------------------------------------------------------------------------------
GRANT SELECT ON kauro.retention_anchor_kinds TO kauro_app, kauro_control;
GRANT SELECT, INSERT ON kauro.retention_anchors TO kauro_app, kauro_control;
GRANT SELECT, INSERT ON kauro.retention_records TO kauro_app;
GRANT SELECT ON kauro.retention_records TO kauro_control;
