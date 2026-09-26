-- 0010 — B07 source lifecycle, part 2: inspection receipts, admitted source files (FileManifest) and the detected table
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
-- decision a browser cannot set), SourceField, UploadSession (inspectionReceiptHash: full coverage and parser checks); S053,
-- S054. B06 foundation: D-INIT-1 (initial states), D-TX-2 (transition locks), D-EVID-1 (evidence is written by its producer,
-- never by the request handlers whose gate it satisfies).

-- --- scan coverage tied to the object (S054; B07-F4) --------------------------------------------------------------------------
-- Whether a receipt's per-part coverage demonstrates complete coverage of THIS object (09 "Scanner coverage": compare expected parts
-- and bytes to actual coverage; demonstrate coverage for every admitted container and expanded part; splitting into chunks is not
-- equivalent): exactly one CONTAINER part whose expected and scanned bytes are the observed length of the object, every part
-- CLEAN and read completely, part digests distinct, and the counts and byte sums of the receipt equal the parts it lists. A writer
-- choosing "expected 1 byte" for a 100-byte object, or listing parts that do not add up, cannot store COVERED_CLEAN. NULL-safe:
-- a missing member or a non-number compares false, never unknown.
CREATE OR REPLACE FUNCTION kauro.scan_coverage_complete(
  p_coverage jsonb, p_observed_bytes bigint, p_expected_parts integer, p_expected_bytes bigint, p_scanned_parts integer, p_scanned_bytes bigint
) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS
$$
  SELECT coalesce((
    SELECT count(*) >= 1
       AND count(*) = p_expected_parts AND count(*) = p_scanned_parts
       AND count(DISTINCT e ->> 'partDigest') = count(*)
       AND bool_and(jsonb_typeof(e -> 'expectedBytes') = 'number' AND jsonb_typeof(e -> 'scannedBytes') = 'number' AND jsonb_typeof(e -> 'partDigest') = 'string')
       AND bool_and(e ->> 'outcome' = 'CLEAN' AND e ->> 'partKind' IS NOT NULL AND e ->> 'partKind' NOT IN ('UNEXPECTED') AND (e -> 'scannedBytes') = (e -> 'expectedBytes'))
       AND sum(CASE WHEN jsonb_typeof(e -> 'expectedBytes') = 'number' THEN (e ->> 'expectedBytes')::numeric END) = p_expected_bytes
       AND sum(CASE WHEN jsonb_typeof(e -> 'scannedBytes') = 'number' THEN (e ->> 'scannedBytes')::numeric END) = p_scanned_bytes
       AND count(*) FILTER (WHERE e ->> 'partKind' = 'CONTAINER') = 1
       AND bool_or(e ->> 'partKind' = 'CONTAINER'
                   AND CASE WHEN jsonb_typeof(e -> 'expectedBytes') = 'number' THEN (e ->> 'expectedBytes')::numeric = p_observed_bytes ELSE false END
                   AND CASE WHEN jsonb_typeof(e -> 'scannedBytes') = 'number' THEN (e ->> 'scannedBytes')::numeric = p_observed_bytes ELSE false END)
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_coverage) = 'array' THEN p_coverage ELSE '[]'::jsonb END) e
  ), false) AND coalesce(p_expected_bytes >= p_observed_bytes, false)
$$;

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
  -- the signature-freshness policy is pinned here, not chosen per receipt (B07-F4; D-SCAN-2: 86,400 s, open question Q-B07-3): a
  -- receipt recording another maximum age is refused, so a writer cannot widen freshness to admit six-day-old signatures
  signature_max_age_seconds   integer CHECK (signature_max_age_seconds IS NULL OR signature_max_age_seconds = 86400),
  scanner_config_hash         text CHECK (scanner_config_hash IS NULL OR kauro.is_sha256_hex(scanner_config_hash)),
  -- the scanner's own summary, recorded as evidence and never decisive (S054: a zero exit code alone is not admission evidence)
  scanner_exit_code           integer,
  scanner_verdict             text CHECK (scanner_verdict IS NULL OR scanner_verdict IN ('CLEAN', 'INFECTED', 'ERROR')),
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
  -- 09 "Completion and inspection" failure classes, plus the claim/size/promotion refusals of this design (D-INSP-3)
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
  -- S054 at the database: COVERED_CLEAN is a coverage claim about THIS object — every expected part and byte was scanned, the
  -- expected set contains the container at its observed length (B07-F4), the scanner configuration is pinned and the signatures
  -- were fresh under the pinned policy. A skip that the engine reported as clean, or an expected set the writer shrank, cannot be
  -- stored as COVERED_CLEAN.
  CONSTRAINT inspection_receipts_clean_means_covered CHECK (
    scan_state <> 'COVERED_CLEAN' OR (
      expected_parts >= 1 AND scanned_parts = expected_parts AND scanned_bytes = expected_bytes
      AND kauro.scan_coverage_complete(coverage, observed_bytes, expected_parts, expected_bytes, scanned_parts, scanned_bytes)
      AND scanner_engine IS NOT NULL AND scanner_engine_version IS NOT NULL AND signature_version IS NOT NULL
      AND scanner_config_hash IS NOT NULL AND signatures_published_at IS NOT NULL AND scanned_at IS NOT NULL
      AND signature_max_age_seconds IS NOT NULL AND signatures_published_at <= scanned_at
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
      AND accepted_sha256 IS NOT NULL AND accepted_sha256 = sha256
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
-- data), and the receipt's observation is the one recorded on the upload. The upload row is locked: the inspection's decision
-- and a concurrent cancellation are ordered on it (cancellation remains valid while verification races, CMD015). The control-plane
-- unit of work has already taken the revision row (FOR NO KEY UPDATE) before any upload row, the order of the commands (D-LOCK-2,
-- B07-F14), so this upload lock never inverts it.
-- D-INSP-4 (re-check N3; D-CLOCK-1): the receipt's instants are bounded by the server's. The attempt starts at its claim (the
-- instant the database stamped when the fence advanced), the scan follows the provider observation and lies within the attempt,
-- the completion is not ahead of the server clock and the receipt is recorded at the server's transaction time. The pinned
-- signature age (inspection_receipts_clean_means_covered) is therefore measured at an instant inside the attempt, never at one the
-- writer set back to before the upload existed (09 "Scanner coverage": stale signatures beyond the recorded policy block new
-- admission; S054).
CREATE OR REPLACE FUNCTION kauro.inspection_receipts_current_attempt() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  u record;
  clock timestamptz := kauro.server_now();
BEGIN
  SELECT state, inspection_fence, inspection_claimed_at, observed_generation, observed_bytes, completion_observed_at, completion_claim_digest,
         declared_format, quarantine_object_id
    INTO u FROM kauro.upload_sessions WHERE agency_id = NEW.agency_id AND upload_id = NEW.upload_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTEXT: upload % is not visible in this transaction', NEW.upload_id USING ERRCODE = 'KA006';
  END IF;
  IF u.state <> 'VERIFYING' THEN
    RAISE EXCEPTION 'FENCE_DISCIPLINE: upload % is % and accepts no inspection receipt', NEW.upload_id, u.state USING ERRCODE = 'KA071';
  END IF;
  IF u.inspection_fence <> NEW.inspection_fence THEN
    RAISE EXCEPTION 'FENCE_DISCIPLINE: receipt of attempt % for upload % whose current attempt is %', NEW.inspection_fence, NEW.upload_id, u.inspection_fence USING ERRCODE = 'KA071';
  END IF;
  IF u.observed_generation IS DISTINCT FROM NEW.observed_generation OR u.observed_bytes IS DISTINCT FROM NEW.observed_bytes
     OR u.completion_claim_digest IS DISTINCT FROM NEW.completion_claim_digest OR u.declared_format <> NEW.declared_format
     OR u.quarantine_object_id <> NEW.quarantine_object_id THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: receipt for upload % does not describe the recorded observation', NEW.upload_id USING ERRCODE = 'KA072';
  END IF;
  IF NEW.started_at IS DISTINCT FROM u.inspection_claimed_at
     OR NEW.completed_at > clock
     OR NEW.created_at IS DISTINCT FROM clock
     OR (NEW.scanned_at IS NOT NULL AND (
          NEW.scanned_at < NEW.started_at OR NEW.scanned_at > NEW.completed_at
          OR u.completion_observed_at IS NULL OR NEW.scanned_at < u.completion_observed_at)) THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: the receipt of upload % starts at its attempt''s claim, scans after the observation and within the attempt, and is recorded at the server''s transaction time', NEW.upload_id USING ERRCODE = 'KA072';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER inspection_receipts_current_attempt BEFORE INSERT ON kauro.inspection_receipts
  FOR EACH ROW EXECUTE FUNCTION kauro.inspection_receipts_current_attempt();

-- --- source files (registry contract FileManifest: one admitted, immutable, provider-observed generation) ------------------------
-- A file belongs to its project (reusable by a later revision of the same project while its generation exists and its admission
-- stands, registry edge previously_admitted_inputs_selected); its identity is not the display name. The composite key to the
-- admitting receipt makes "only provider-observed bytes and generations may be admitted" a foreign key rather than an
-- application check. Since B07-F9 the file is an aggregate (SourceFile, kind source_file): it carries a version and every version
-- its event (B06 D-VER-1, D-EVT-1), so an admission revoked under a READY_TO_SEAL or sealed revision reaches its consumers
-- (source_file.admission_revoked.v1 → EXECUTION_CONTROL, NOTIFICATIONS).
CREATE TABLE kauro.source_files (
  file_id                  uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(file_id)),
  agency_id                uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id               uuid NOT NULL,
  version                  bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
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
  -- FileManifest.admitted: derived by the server; false once admission is revoked (the accepted generation was lost, the unsealed
  -- intake expired, or every retention record of the sealed revisions that retained the bytes expired, B07-F5)
  admitted                 boolean NOT NULL,
  state                    text NOT NULL DEFAULT 'ADMITTED' CHECK (state IN ('ADMITTED', 'ADMISSION_REVOKED')),
  admitted_at              timestamptz NOT NULL,
  revoked_at               timestamptz,
  revocation_reason        text CHECK (revocation_reason IS NULL OR revocation_reason IN ('INTAKE_EXPIRED', 'RETENTION_EXPIRED', 'GENERATION_MISSING', 'GENERATION_CHANGED')),
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
CREATE TRIGGER source_files_initial_state BEFORE INSERT ON kauro.source_files
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('SourceFile');
CREATE TRIGGER source_files_version BEFORE UPDATE ON kauro.source_files FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE CONSTRAINT TRIGGER source_files_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.source_files
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('source_file', 'file_id');

-- SourceFile is an aggregate kind of the shared registry (0008, D-AGGK-1; B07-F9)
INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES
  ('source_file', 'source_files', 'file_id', 'B07');

-- a file is admitted only while its upload is being admitted by the current attempt (never for a cancelled or expired upload),
-- at the server's transaction time (D-CLOCK-1)
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
    RAISE EXCEPTION 'FENCE_DISCIPLINE: upload % is % and cannot admit a file', NEW.origin_upload_id, upload_state USING ERRCODE = 'KA071';
  END IF;
  IF NOT NEW.admitted THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: a source file is born admitted' USING ERRCODE = 'KA072';
  END IF;
  IF NEW.admitted_at IS DISTINCT FROM kauro.server_now() THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: file % is admitted at the server''s transaction time', NEW.file_id USING ERRCODE = 'KA072';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER source_files_admitting_upload BEFORE INSERT ON kauro.source_files
  FOR EACH ROW EXECUTE FUNCTION kauro.source_files_admitting_upload();

-- A file's admission is a transition subject (B06 D-TX-2): a seal reads it after the shared transition lock (0011,
-- kauro.sealed_revision_files_admitted), and a revocation takes the exclusive lock before it applies and only then, in the next
-- statement, re-checks what its reason must not overturn. A seal in flight therefore commits first and refuses the revocation,
-- or waits for a revocation committed first and reads the file revoked. The reasons (D-FILE-1, B07-F5):
--   INTAKE_EXPIRED    unsealed intake data follows its upload's window (D-RET-1): refused once any seal ever included the file —
--                     sealing moved the bytes under that seal's retention record;
--   RETENTION_EXPIRED the bytes' retention ended: allowed only for a file some seal included and whose including revisions have no
--                     ACTIVE retention record with an effective deadline still ahead (so a SUPERSEDED revision, which never
--                     expires itself, does not keep the bytes admitted and reusable forever);
--   GENERATION_MISSING / GENERATION_CHANGED  the bytes are gone or not the admitted ones: revoked whatever retains them (an incident
--                     for the deletion package, not data).
-- "Included by a seal" means included by a real seal (D-SEAL-1, re-check N1): a file row of a revision that entered SEALED at exactly
-- its sealed manifest's instant (kauro.is_real_seal, 0011) — a row no seal recorded can neither keep bytes admitted past their
-- window nor postpone the end of their retention. 0011 binds every sealed row to its seal at COMMIT; this is the reader's half.
-- The revocation is recorded at the server's transaction time (D-CLOCK-1).
CREATE OR REPLACE FUNCTION kauro.source_files_revocation_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM pg_advisory_xact_lock(kauro.transition_key('kauro.source_files', OLD.file_id::text));
  IF NEW.revoked_at IS DISTINCT FROM kauro.server_now() THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: the admission of file % is revoked at the server''s transaction time', OLD.file_id USING ERRCODE = 'KA072';
  END IF;
  IF NEW.revocation_reason = 'INTAKE_EXPIRED' AND EXISTS (
    SELECT 1 FROM kauro.sealed_revision_files s
     WHERE s.agency_id = OLD.agency_id AND s.file_id = OLD.file_id AND s.disposition = 'INCLUDED' AND kauro.is_real_seal(s.agency_id, s.revision_id)
  ) THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: file % was sealed; its bytes follow the seal''s retention, not the intake window', OLD.file_id USING ERRCODE = 'KA072';
  END IF;
  -- the intake window is its upload's, closed on the server clock only (D-RET-1, D-CLOCK-1): never early
  IF NEW.revocation_reason = 'INTAKE_EXPIRED' AND EXISTS (
    SELECT 1 FROM kauro.upload_sessions u WHERE u.agency_id = OLD.agency_id AND u.upload_id = OLD.origin_upload_id AND u.application_expires_at > kauro.server_now()
  ) THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: the intake window of file % is still open', OLD.file_id USING ERRCODE = 'KA072';
  END IF;
  IF NEW.revocation_reason = 'RETENTION_EXPIRED' AND (
    NOT EXISTS (
      SELECT 1 FROM kauro.sealed_revision_files s
       WHERE s.agency_id = OLD.agency_id AND s.file_id = OLD.file_id AND s.disposition = 'INCLUDED' AND kauro.is_real_seal(s.agency_id, s.revision_id)
    )
    OR EXISTS (
      SELECT 1 FROM kauro.sealed_revision_files s JOIN kauro.retention_records rr ON rr.agency_id = s.agency_id AND rr.revision_id = s.revision_id
       WHERE s.agency_id = OLD.agency_id AND s.file_id = OLD.file_id AND s.disposition = 'INCLUDED' AND kauro.is_real_seal(s.agency_id, s.revision_id)
         AND rr.state = 'ACTIVE' AND rr.effective_deadline > kauro.server_now()
    )
  ) THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: file % is still retained by a sealed revision whose retention has not ended', OLD.file_id USING ERRCODE = 'KA072';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER source_files_revocation_guard BEFORE UPDATE OF state ON kauro.source_files
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.source_files_revocation_guard();

-- D-FILE-1: SourceFile platform machine (admission is revoked when the accepted generation is lost; never restored)
INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('SourceFile', 'ADMITTED');
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
  name_display         text CONSTRAINT source_tables_name_display_label CHECK (name_display IS NULL OR kauro.is_label(name_display)),
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
  -- untrusted header label for display only (03: labels are untrusted text; positional identity prevents overwrite); the label
  -- rule is kauro.is_label, by code point (B06 D-LABEL-1)
  label_display  text CONSTRAINT source_table_columns_label_display_label CHECK (label_display IS NULL OR kauro.is_label(label_display)),
  label_digest   text NOT NULL CHECK (kauro.is_sha256_hex(label_digest)),
  label_state    text NOT NULL CHECK (label_state IN ('PRESENT', 'EMPTY', 'DUPLICATE_LABEL', 'DISPLAY_TRUNCATED', 'UNDECODABLE', 'NO_HEADER')),
  PRIMARY KEY (table_id, ordinal),
  FOREIGN KEY (agency_id, table_id) REFERENCES kauro.source_tables (agency_id, table_id),
  CONSTRAINT source_table_columns_display_state CHECK ((label_display IS NULL) = (label_state IN ('EMPTY', 'UNDECODABLE', 'NO_HEADER')))
);
CREATE TRIGGER source_table_columns_append_only BEFORE UPDATE OR DELETE ON kauro.source_table_columns
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- B07-F11: the inventory of an admitted generation is written only by the attempt that admits it, while the file's upload is still
-- VERIFYING (the file, its tables and its columns commit together with ADMITTED); once the upload left VERIFYING no table or column
-- can be appended, so the inventory a selection was reviewed against — and a sealed generation's — never grows. The upload row is
-- read FOR SHARE: an admission in flight is ordered before or after the append.
CREATE OR REPLACE FUNCTION kauro.source_inventory_frozen() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  upload_state text;
BEGIN
  IF TG_TABLE_NAME = 'source_tables' THEN
    SELECT u.state INTO upload_state FROM kauro.source_files f JOIN kauro.upload_sessions u ON u.agency_id = f.agency_id AND u.upload_id = f.origin_upload_id
     WHERE f.agency_id = NEW.agency_id AND f.file_id = NEW.file_id FOR SHARE OF u;
  ELSE
    SELECT u.state INTO upload_state FROM kauro.source_tables t JOIN kauro.source_files f ON f.agency_id = t.agency_id AND f.file_id = t.file_id
      JOIN kauro.upload_sessions u ON u.agency_id = f.agency_id AND u.upload_id = f.origin_upload_id
     WHERE t.agency_id = NEW.agency_id AND t.table_id = NEW.table_id FOR SHARE OF u;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTEXT: the file of this inventory row is not visible in this transaction' USING ERRCODE = 'KA006';
  END IF;
  IF upload_state <> 'VERIFYING' THEN
    RAISE EXCEPTION 'FENCE_DISCIPLINE: the inventory of an admitted file is frozen (its upload is %)', upload_state USING ERRCODE = 'KA071';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER source_tables_inventory_frozen BEFORE INSERT ON kauro.source_tables
  FOR EACH ROW EXECUTE FUNCTION kauro.source_inventory_frozen();
CREATE TRIGGER source_table_columns_inventory_frozen BEFORE INSERT ON kauro.source_table_columns
  FOR EACH ROW EXECUTE FUNCTION kauro.source_inventory_frozen();

-- --- row-level security ----------------------------------------------------------------------------------------------------------
-- The inspection pipeline (control plane, bound to the agency, D-CTRL-1) writes the evidence; the request handlers only read it
-- (B06 D-EVID-1: evidence is written by its producer, never by the request handlers whose gate it satisfies — CMD014 failure:
-- "Declared size/hash or browser completion alone cannot mark the file ready").
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
GRANT UPDATE (version, state, admitted, revoked_at, revocation_reason, updated_at) ON kauro.source_files TO kauro_control;
-- customer text (worksheet names, header labels) is written by the inspection pipeline but never read back by the control plane
GRANT INSERT ON kauro.source_tables, kauro.source_table_columns TO kauro_control;
GRANT SELECT (
  table_id, agency_id, file_id, ordinal, kind, name_digest, visibility, column_count, row_estimate, has_formulas, formula_cache,
  merged_cell_count, hidden_row_count, hidden_column_count, issues, structure_hash, created_at
) ON kauro.source_tables TO kauro_control;
GRANT SELECT (table_id, ordinal, agency_id, label_digest, label_state) ON kauro.source_table_columns TO kauro_control;
