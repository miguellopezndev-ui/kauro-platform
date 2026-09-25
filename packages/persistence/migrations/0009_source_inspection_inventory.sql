-- 0009 — B07 source lifecycle, part 2: inspection receipts, admitted source files (FileManifest) and the detected table
-- inventory (worksheets, CSV tables, positional columns).
--
-- Authority: 09 "Completion and inspection" (CompleteUpload reads provider metadata, records actual size and schedules server
-- hashing and inspection; a browser-reported digest never substitutes for the server's; results are separate fields —
-- STRUCTURE_VALID, SCAN_COMPLETE_NO_DETECTION, SEMANTIC_NOT_YET_PROFILED — with no single generic safe flag; a selected file
-- cannot become ACCEPTED while another required inspection result is unknown; a corrected file creates a new upload and
-- generation), 09 "Scanner coverage" (a zero exit code alone is not admission evidence; expected parts and bytes are compared
-- to actual scan coverage; a part the engine cannot inspect causes INCOMPLETE_SCAN and blocks admission; stale signatures block
-- new admission), 09 "Accepted immutability and sealing" (promotion binds the exact generation and byte hash and creates a
-- registry entry before a revision can reference it; a copy response without matching bytes is insufficient), 03 "Source
-- identity" (headers have positional ids independent of their labels; duplicate and empty headers are surfaced), 04 "XLSX parser
-- requirements" (hidden worksheets remain in the inventory; formula text is inert; merged cells are represented as observed),
-- registry contracts FileManifest ("Only provider-observed bytes and generations may be admitted"; admitted is a derived server
-- decision a browser cannot set), SourceField, UploadSession (inspectionReceiptHash: full coverage and parser checks).

-- --- inspection receipts (append-only evidence of one completed inspection attempt) --------------------------------------------
CREATE TABLE kauro.inspection_receipts (
  receipt_id                  uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(receipt_id)),
  agency_id                   uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  upload_id                   uuid NOT NULL,
  revision_id                 uuid NOT NULL,
  -- KAURO_INSPECTION_RECEIPT_V1 digest of the receipt payload (D-HASH-3); UploadSession.inspectionReceiptHash
  receipt_hash                text NOT NULL CHECK (kauro.is_sha256_hex(receipt_hash)),
  inspection_fence            integer NOT NULL CHECK (inspection_fence >= 1),
  quarantine_object_id        uuid NOT NULL,
  -- what the provider actually holds (S053: observe actual bytes/generation before admission)
  observed_generation         text NOT NULL CHECK (kauro.is_generation(observed_generation)),
  observed_bytes              bigint NOT NULL CHECK (observed_bytes >= 0),
  -- SHA-256 recomputed by the server over the complete object bytes; absent only when the attempt stopped before reading them
  sha256                      text CHECK (sha256 IS NULL OR kauro.is_sha256_hex(sha256)),
  completion_claim_digest     text NOT NULL CHECK (kauro.is_sha256_hex(completion_claim_digest)),
  claim_consistent            boolean NOT NULL,
  declared_format             text NOT NULL CHECK (declared_format IN ('CSV', 'XLSX')),
  detected_format             text NOT NULL CHECK (detected_format IN ('CSV', 'XLSX', 'UNSUPPORTED', 'NOT_EVALUATED')),
  structure_status            text NOT NULL CHECK (structure_status IN ('STRUCTURE_VALID', 'STRUCTURE_INVALID', 'NOT_EVALUATED')),
  -- FileManifest.scanState: coverage is separate from malware absence
  scan_state                  text NOT NULL CHECK (scan_state IN ('COVERED_CLEAN', 'BLOCKED', 'NOT_SCANNED', 'ERROR')),
  -- 09: SEMANTIC_NOT_YET_PROFILED is its own field; inspection never claims a semantic profile
  semantic_status             text NOT NULL DEFAULT 'SEMANTIC_NOT_YET_PROFILED' CHECK (semantic_status = 'SEMANTIC_NOT_YET_PROFILED'),
  scanner_engine              text CHECK (scanner_engine IS NULL OR kauro.is_label(scanner_engine)),
  scanner_engine_version      text CHECK (scanner_engine_version IS NULL OR kauro.is_label(scanner_engine_version)),
  signature_version           text CHECK (signature_version IS NULL OR kauro.is_label(signature_version)),
  signatures_published_at     timestamptz,
  signature_max_age_seconds   integer CHECK (signature_max_age_seconds IS NULL OR signature_max_age_seconds BETWEEN 1 AND 604800),
  scanner_config_hash         text CHECK (scanner_config_hash IS NULL OR kauro.is_sha256_hex(scanner_config_hash)),
  scanned_at                  timestamptz,
  expected_parts              integer NOT NULL DEFAULT 0 CHECK (expected_parts >= 0),
  expected_bytes              bigint NOT NULL DEFAULT 0 CHECK (expected_bytes >= 0),
  scanned_parts               integer NOT NULL DEFAULT 0 CHECK (scanned_parts >= 0),
  scanned_bytes               bigint NOT NULL DEFAULT 0 CHECK (scanned_bytes >= 0),
  -- per-part coverage: [{partDigest, partKind, expectedBytes, scannedBytes, outcome}] — digests and tokens, never archive names
  coverage                    jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(coverage) = 'array' AND jsonb_array_length(coverage) <= 4096),
  -- stable problem codes: [{code, partDigest?}] (09: the inspection policy identifies the precise rejection)
  problems                    jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(problems) = 'array' AND jsonb_array_length(problems) <= 256),
  parser_profile_hash         text CHECK (parser_profile_hash IS NULL OR kauro.is_sha256_hex(parser_profile_hash)),
  inspector_version           text NOT NULL CHECK (kauro.is_label(inspector_version)),
  outcome                     text NOT NULL CHECK (outcome IN ('ADMITTED', 'REJECTED')),
  -- 09 "Completion and inspection" failure classes, plus the claim/size/promotion refusals of this design
  rejection_class             text CHECK (rejection_class IS NULL OR rejection_class IN (
                                'UNSUPPORTED_FORMAT', 'FORMAT_MISMATCH', 'CORRUPT_STRUCTURE', 'ACTIVE_CONTENT', 'DETECTED_MALWARE',
                                'INCOMPLETE_SCAN', 'STALE_SIGNATURES', 'RESOURCE_LIMIT', 'TRANSIENT_INFRASTRUCTURE', 'CANCELLED_AUTHORITY',
                                'CLAIM_MISMATCH', 'SIZE_EXCEEDS_RESERVATION', 'EMPTY_OBJECT', 'PROMOTION_UNVERIFIED')),
  accepted_object_id          uuid,
  accepted_generation         text CHECK (accepted_generation IS NULL OR kauro.is_generation(accepted_generation)),
  accepted_sha256             text CHECK (accepted_sha256 IS NULL OR kauro.is_sha256_hex(accepted_sha256)),
  started_at                  timestamptz NOT NULL,
  completed_at                timestamptz NOT NULL CHECK (completed_at >= started_at),
  created_at                  timestamptz NOT NULL,
  UNIQUE (agency_id, receipt_hash),
  UNIQUE (agency_id, upload_id, receipt_hash),
  -- binding target of an admitted file: this receipt admitted exactly this accepted generation, digest and length
  UNIQUE (agency_id, receipt_hash, accepted_object_id, accepted_generation, accepted_sha256, observed_bytes),
  -- one receipt per inspection attempt
  UNIQUE (upload_id, inspection_fence),
  FOREIGN KEY (agency_id, revision_id, upload_id) REFERENCES kauro.upload_sessions (agency_id, revision_id, upload_id),
  FOREIGN KEY (agency_id, quarantine_object_id) REFERENCES kauro.stored_objects (agency_id, object_id),
  FOREIGN KEY (agency_id, accepted_object_id, accepted_generation) REFERENCES kauro.stored_objects (agency_id, object_id, generation),
  -- S054 at the database: COVERED_CLEAN is a coverage claim — every expected part and byte was scanned, at least one part was
  -- expected, the scanner configuration is pinned and the signatures were fresh under the recorded policy. A skip that the
  -- engine reported as clean cannot be stored as COVERED_CLEAN.
  CONSTRAINT inspection_receipts_clean_means_covered CHECK (
    scan_state <> 'COVERED_CLEAN' OR (
      expected_parts >= 1 AND scanned_parts = expected_parts AND scanned_bytes = expected_bytes
      AND scanner_engine IS NOT NULL AND scanner_engine_version IS NOT NULL AND signature_version IS NOT NULL
      AND scanner_config_hash IS NOT NULL AND signatures_published_at IS NOT NULL AND scanned_at IS NOT NULL
      AND signature_max_age_seconds IS NOT NULL
      AND scanned_at - signatures_published_at <= make_interval(secs => signature_max_age_seconds)
    )
  ),
  CONSTRAINT inspection_receipts_scan_accounting CHECK (scanned_parts <= expected_parts AND scanned_bytes <= expected_bytes),
  -- admission needs every separate result: observed complete bytes, structure, full scan coverage, a consistent claim, the
  -- declared format detected, and a promoted accepted generation whose re-read digest equals the quarantine digest
  CONSTRAINT inspection_receipts_admission_complete CHECK (
    outcome <> 'ADMITTED' OR (
      rejection_class IS NULL AND sha256 IS NOT NULL AND observed_bytes >= 1 AND claim_consistent
      AND structure_status = 'STRUCTURE_VALID' AND scan_state = 'COVERED_CLEAN' AND detected_format = declared_format
      AND parser_profile_hash IS NOT NULL AND accepted_object_id IS NOT NULL AND accepted_generation IS NOT NULL
      AND accepted_sha256 = sha256
    )
  ),
  CONSTRAINT inspection_receipts_rejection_classified CHECK (
    outcome <> 'REJECTED' OR (rejection_class IS NOT NULL AND accepted_object_id IS NULL AND accepted_generation IS NULL AND accepted_sha256 IS NULL)
  ),
  -- a detection is BLOCKED and only a detection is; an incomplete or stale scan is NOT_SCANNED, never clean with a warning
  CONSTRAINT inspection_receipts_blocked_is_detection CHECK ((scan_state = 'BLOCKED') = (rejection_class IS NOT DISTINCT FROM 'DETECTED_MALWARE')),
  CONSTRAINT inspection_receipts_incomplete_is_not_scanned CHECK (rejection_class NOT IN ('INCOMPLETE_SCAN', 'STALE_SIGNATURES') OR scan_state = 'NOT_SCANNED')
);
CREATE INDEX inspection_receipts_by_upload ON kauro.inspection_receipts (agency_id, upload_id, inspection_fence);
CREATE TRIGGER inspection_receipts_append_only BEFORE UPDATE OR DELETE ON kauro.inspection_receipts
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- A receipt is written only by the current inspection attempt of an upload that is still being verified: a late or stale
-- worker cannot attach evidence to a cancelled, expired or already decided upload (late uploads cannot resurrect cancelled
-- data), and the receipt's observation is the one recorded on the upload.
CREATE OR REPLACE FUNCTION kauro.inspection_receipts_current_attempt() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  u record;
BEGIN
  SELECT state, inspection_fence, observed_generation, observed_bytes, completion_claim_digest, declared_format, quarantine_object_id
    INTO u FROM kauro.upload_sessions WHERE agency_id = NEW.agency_id AND upload_id = NEW.upload_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTEXT: upload % is not visible in this transaction', NEW.upload_id USING ERRCODE = 'KA006';
  END IF;
  IF u.state <> 'VERIFYING' THEN
    RAISE EXCEPTION 'FENCE_DISCIPLINE: upload % is % and accepts no inspection receipt', NEW.upload_id, u.state USING ERRCODE = 'KA010';
  END IF;
  IF u.inspection_fence <> NEW.inspection_fence THEN
    RAISE EXCEPTION 'FENCE_DISCIPLINE: receipt of attempt % for upload % whose current attempt is %', NEW.inspection_fence, NEW.upload_id, u.inspection_fence USING ERRCODE = 'KA010';
  END IF;
  IF u.observed_generation IS DISTINCT FROM NEW.observed_generation OR u.observed_bytes IS DISTINCT FROM NEW.observed_bytes
     OR u.completion_claim_digest IS DISTINCT FROM NEW.completion_claim_digest OR u.declared_format <> NEW.declared_format
     OR u.quarantine_object_id <> NEW.quarantine_object_id THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: receipt for upload % does not describe the recorded observation', NEW.upload_id USING ERRCODE = 'KA011';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER inspection_receipts_current_attempt BEFORE INSERT ON kauro.inspection_receipts
  FOR EACH ROW EXECUTE FUNCTION kauro.inspection_receipts_current_attempt();

-- --- source files (registry contract FileManifest: one admitted, immutable, provider-observed generation) ------------------------
-- A file belongs to its project (reusable by a later revision of the same project while its generation exists, registry edge
-- previously_admitted_inputs_selected); its identity is not the display name. The composite key to the admitting receipt makes
-- "only provider-observed bytes and generations may be admitted" a foreign key rather than an application check.
CREATE TABLE kauro.source_files (
  file_id                  uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(file_id)),
  agency_id                uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id               uuid NOT NULL,
  origin_revision_id       uuid NOT NULL,
  origin_upload_id         uuid NOT NULL UNIQUE,
  accepted_object_id       uuid NOT NULL,
  provider_generation      text NOT NULL CHECK (kauro.is_generation(provider_generation)),
  sha256                   text NOT NULL CHECK (kauro.is_sha256_hex(sha256)),
  bytes                    bigint NOT NULL CHECK (bytes BETWEEN 1 AND 2000000000),
  format                   text NOT NULL CHECK (format IN ('CSV', 'XLSX')),
  scan_state               text NOT NULL CHECK (scan_state IN ('COVERED_CLEAN', 'BLOCKED', 'NOT_SCANNED', 'ERROR')),
  parser_profile_hash      text NOT NULL CHECK (kauro.is_sha256_hex(parser_profile_hash)),
  inspection_receipt_hash  text NOT NULL CHECK (kauro.is_sha256_hex(inspection_receipt_hash)),
  -- FileManifest.admitted: derived by the server; false once admission is revoked (the accepted generation was lost)
  admitted                 boolean NOT NULL,
  state                    text NOT NULL DEFAULT 'ADMITTED' CHECK (state IN ('ADMITTED', 'ADMISSION_REVOKED')),
  admitted_at              timestamptz NOT NULL,
  revoked_at               timestamptz,
  revocation_reason        text CHECK (revocation_reason IS NULL OR kauro.is_token(revocation_reason)),
  created_at               timestamptz NOT NULL,
  updated_at               timestamptz NOT NULL,
  UNIQUE (agency_id, file_id),
  UNIQUE (agency_id, project_id, file_id),
  -- binding target of sealed revision files: the exact generation, digest and length of this file
  UNIQUE (agency_id, project_id, file_id, provider_generation, sha256, bytes),
  UNIQUE (agency_id, file_id, origin_upload_id),
  FOREIGN KEY (agency_id, project_id, origin_revision_id) REFERENCES kauro.dataset_revisions (agency_id, project_id, revision_id),
  FOREIGN KEY (agency_id, origin_revision_id, origin_upload_id) REFERENCES kauro.upload_sessions (agency_id, revision_id, upload_id),
  FOREIGN KEY (agency_id, inspection_receipt_hash, accepted_object_id, provider_generation, sha256, bytes)
    REFERENCES kauro.inspection_receipts (agency_id, receipt_hash, accepted_object_id, accepted_generation, accepted_sha256, observed_bytes),
  CONSTRAINT source_files_admitted_means_covered CHECK (NOT admitted OR scan_state = 'COVERED_CLEAN'),
  CONSTRAINT source_files_admitted_state CHECK (admitted = (state = 'ADMITTED')),
  CONSTRAINT source_files_revoked_binding CHECK ((state = 'ADMISSION_REVOKED') = (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
);
CREATE INDEX source_files_by_project ON kauro.source_files (agency_id, project_id, admitted_at, file_id);
CREATE TRIGGER source_files_touch BEFORE UPDATE ON kauro.source_files FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER source_files_immutable BEFORE UPDATE ON kauro.source_files
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('file_id,agency_id,project_id,origin_revision_id,origin_upload_id,accepted_object_id,provider_generation,sha256,bytes,format,scan_state,parser_profile_hash,inspection_receipt_hash,admitted_at,created_at');
CREATE TRIGGER source_files_transition BEFORE UPDATE OF state ON kauro.source_files
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('SourceFile');

-- a file is admitted only while its upload is being admitted by the current attempt (never for a cancelled or expired upload)
CREATE OR REPLACE FUNCTION kauro.source_files_admitting_upload() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  upload_state text;
BEGIN
  SELECT state INTO upload_state FROM kauro.upload_sessions WHERE agency_id = NEW.agency_id AND upload_id = NEW.origin_upload_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTEXT: upload % is not visible in this transaction', NEW.origin_upload_id USING ERRCODE = 'KA006';
  END IF;
  IF upload_state <> 'VERIFYING' THEN
    RAISE EXCEPTION 'FENCE_DISCIPLINE: upload % is % and cannot admit a file', NEW.origin_upload_id, upload_state USING ERRCODE = 'KA010';
  END IF;
  IF NOT NEW.admitted OR NEW.state <> 'ADMITTED' THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: a source file is born admitted' USING ERRCODE = 'KA011';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER source_files_admitting_upload BEFORE INSERT ON kauro.source_files
  FOR EACH ROW EXECUTE FUNCTION kauro.source_files_admitting_upload();

-- D-FILE-1: SourceFile platform machine (admission is revoked when the accepted generation is lost; never restored)
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES ('SourceFile', 'ADMITTED', 'ADMISSION_REVOKED');

-- the upload names the file it admitted, and that file was admitted from this upload (checked at commit); the upload names the
-- receipt that decided it, and that receipt is a receipt of this upload
ALTER TABLE kauro.upload_sessions ADD CONSTRAINT upload_sessions_file_fk
  FOREIGN KEY (agency_id, file_id, upload_id) REFERENCES kauro.source_files (agency_id, file_id, origin_upload_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE kauro.upload_sessions ADD CONSTRAINT upload_sessions_receipt_fk
  FOREIGN KEY (agency_id, upload_id, inspection_receipt_hash) REFERENCES kauro.inspection_receipts (agency_id, upload_id, receipt_hash) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE kauro.stored_objects ADD CONSTRAINT stored_objects_file_fk
  FOREIGN KEY (agency_id, file_id) REFERENCES kauro.source_files (agency_id, file_id) DEFERRABLE INITIALLY DEFERRED;

-- --- detected table inventory (append-only: the inventory of an immutable generation is immutable) ------------------------------
CREATE TABLE kauro.source_tables (
  table_id             uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(table_id)),
  agency_id            uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  file_id              uuid NOT NULL,
  -- worksheet index in workbook order, 0 for a CSV table
  ordinal              integer NOT NULL CHECK (ordinal BETWEEN 0 AND 4095),
  kind                 text NOT NULL CHECK (kind IN ('CSV_TABLE', 'WORKSHEET')),
  -- untrusted worksheet name kept for display only (NULL when it is not a safe label); identity is (file, ordinal)
  name_display         text CHECK (name_display IS NULL OR kauro.is_label(name_display)),
  name_digest          text NOT NULL CHECK (kauro.is_sha256_hex(name_digest)),
  visibility           text NOT NULL CHECK (visibility IN ('VISIBLE', 'HIDDEN', 'VERY_HIDDEN')),
  column_count         integer NOT NULL CHECK (column_count BETWEEN 0 AND 16384),
  -- a structural estimate from the preflight (dimension element or line census); never the counted population
  row_estimate         bigint CHECK (row_estimate IS NULL OR row_estimate >= 0),
  has_formulas         boolean NOT NULL,
  formula_cache        text NOT NULL CHECK (formula_cache IN ('NOT_APPLICABLE', 'ALL_PRESENT', 'SOME_MISSING', 'ERROR_VALUES', 'EXTERNAL_DEPENDENCY')),
  merged_cell_count    integer NOT NULL DEFAULT 0 CHECK (merged_cell_count >= 0),
  hidden_row_count     integer NOT NULL DEFAULT 0 CHECK (hidden_row_count >= 0),
  hidden_column_count  integer NOT NULL DEFAULT 0 CHECK (hidden_column_count >= 0),
  -- stable issue codes (encoding, delimiter ambiguity, duplicate headers, blank lines, ...)
  issues               jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(issues) = 'array' AND jsonb_array_length(issues) <= 64),
  -- KAURO_SOURCE_TABLE_V1 digest of the detected facts: a selection binds it, so a changed table invalidates the selection
  structure_hash       text NOT NULL CHECK (kauro.is_sha256_hex(structure_hash)),
  created_at           timestamptz NOT NULL,
  UNIQUE (agency_id, table_id),
  UNIQUE (agency_id, file_id, table_id),
  UNIQUE (file_id, ordinal),
  FOREIGN KEY (agency_id, file_id) REFERENCES kauro.source_files (agency_id, file_id),
  CONSTRAINT source_tables_csv_shape CHECK (kind <> 'CSV_TABLE' OR (ordinal = 0 AND visibility = 'VISIBLE' AND NOT has_formulas AND formula_cache = 'NOT_APPLICABLE' AND merged_cell_count = 0)),
  CONSTRAINT source_tables_formula_cache CHECK (has_formulas = (formula_cache <> 'NOT_APPLICABLE'))
);
CREATE TRIGGER source_tables_append_only BEFORE UPDATE OR DELETE ON kauro.source_tables
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

CREATE TABLE kauro.source_table_columns (
  table_id       uuid NOT NULL,
  ordinal        integer NOT NULL CHECK (ordinal BETWEEN 0 AND 16383),
  agency_id      uuid NOT NULL,
  -- untrusted header label for display only (03: labels are untrusted text; positional identity prevents overwrite)
  label_display  text CHECK (label_display IS NULL OR (length(label_display) BETWEEN 1 AND 200 AND label_display !~ '[[:cntrl:]]')),
  label_digest   text NOT NULL CHECK (kauro.is_sha256_hex(label_digest)),
  label_state    text NOT NULL CHECK (label_state IN ('PRESENT', 'EMPTY', 'DUPLICATE_LABEL', 'DISPLAY_TRUNCATED', 'UNDECODABLE', 'NO_HEADER')),
  PRIMARY KEY (table_id, ordinal),
  FOREIGN KEY (agency_id, table_id) REFERENCES kauro.source_tables (agency_id, table_id),
  CONSTRAINT source_table_columns_display_state CHECK ((label_display IS NULL) = (label_state IN ('EMPTY', 'UNDECODABLE', 'NO_HEADER')))
);
CREATE TRIGGER source_table_columns_append_only BEFORE UPDATE OR DELETE ON kauro.source_table_columns
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- row-level security ----------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.inspection_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.inspection_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY inspection_receipts_tenant_read ON kauro.inspection_receipts FOR SELECT TO kauro_app
  USING (agency_id = kauro.current_agency_id());
CREATE POLICY inspection_receipts_control_read ON kauro.inspection_receipts FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY inspection_receipts_control_insert ON kauro.inspection_receipts FOR INSERT TO kauro_control
  WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.source_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.source_files FORCE ROW LEVEL SECURITY;
CREATE POLICY source_files_tenant_read ON kauro.source_files FOR SELECT TO kauro_app
  USING (agency_id = kauro.current_agency_id());
CREATE POLICY source_files_control_read ON kauro.source_files FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY source_files_control_insert ON kauro.source_files FOR INSERT TO kauro_control
  WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY source_files_control_update ON kauro.source_files FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.source_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.source_tables FORCE ROW LEVEL SECURITY;
CREATE POLICY source_tables_tenant_read ON kauro.source_tables FOR SELECT TO kauro_app
  USING (agency_id = kauro.current_agency_id());
CREATE POLICY source_tables_control_read ON kauro.source_tables FOR SELECT TO kauro_control
  USING (agency_id = kauro.current_agency_id());
CREATE POLICY source_tables_control_insert ON kauro.source_tables FOR INSERT TO kauro_control
  WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.source_table_columns ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.source_table_columns FORCE ROW LEVEL SECURITY;
CREATE POLICY source_table_columns_tenant_read ON kauro.source_table_columns FOR SELECT TO kauro_app
  USING (agency_id = kauro.current_agency_id());
CREATE POLICY source_table_columns_control_read ON kauro.source_table_columns FOR SELECT TO kauro_control
  USING (agency_id = kauro.current_agency_id());
CREATE POLICY source_table_columns_control_insert ON kauro.source_table_columns FOR INSERT TO kauro_control
  WITH CHECK (agency_id = kauro.current_agency_id());

-- --- grants: the inspection pipeline (control plane) writes the evidence; request handlers read it -------------------------------
GRANT SELECT ON kauro.inspection_receipts, kauro.source_files, kauro.source_tables, kauro.source_table_columns TO kauro_app;
GRANT SELECT, INSERT ON kauro.inspection_receipts TO kauro_control;
GRANT SELECT, INSERT ON kauro.source_files TO kauro_control;
GRANT UPDATE (state, admitted, revoked_at, revocation_reason, updated_at) ON kauro.source_files TO kauro_control;
-- customer text (worksheet names, header labels) is written by the inspection pipeline but never read back by the control plane
GRANT INSERT ON kauro.source_tables, kauro.source_table_columns TO kauro_control;
GRANT SELECT (
  table_id, agency_id, file_id, ordinal, kind, name_digest, visibility, column_count, row_estimate, has_formulas, formula_cache,
  merged_cell_count, hidden_row_count, hidden_column_count, issues, structure_hash, created_at
) ON kauro.source_tables TO kauro_control;
GRANT SELECT (table_id, ordinal, agency_id, label_digest, label_state) ON kauro.source_table_columns TO kauro_control;
