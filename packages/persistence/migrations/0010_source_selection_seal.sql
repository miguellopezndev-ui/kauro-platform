-- 0010 — B07 source lifecycle, part 3: selection manifests, selection evaluations (exact counts of the selected scope), the
-- sealed manifest and its file set, and the lifecycle guard of dataset revisions.
--
-- Authority: 09 "Accepted immutability and sealing" (the agency selects tables and confirms parsing and projection;
-- SealRevision records the accepted object references, worksheet inventory, exclusions, parser settings, projection and counts;
-- only this sealed manifest can be profiled and quoted; adding, removing or replacing a file after sealing creates a new
-- revision), 07 "SourceRevision state machine" (a revision with one rejected selected file cannot seal by ignoring its status;
-- SealRevision locks the revision, verifies all selected generations and inspection receipts, computes counts and manifest
-- hash, emits revision-sealed and commits one version transition; a concurrent late upload completion cannot enter the sealed
-- manifest), 03 "Count the correct population" (physical rows, logical records after an explicit projection, billable units
-- before deduplication, association edges; the projection is sealed before quoting), 03 "Source identity" (the sealed manifest
-- contains accepted tables, projection, parser versions and settings, raw byte hashes, admitted counts, excluded worksheets and
-- reasons), reference/HASHING_AND_ACCOUNTING_RULES (manifestHash under KAURO_SOURCE_REVISION_V1 over ordered accepted file ids,
-- generations, hashes, lengths, table selection, parser profile and projection), registry machine DatasetRevision (guards of
-- upload_reserved, all_uploads_completed, previously_admitted_inputs_selected, all_selected_inputs_admitted,
-- fatal_input_rejection, selection_changes, seal_command, new_revision_explicitly_supersedes, cancel_revision,
-- retention_expires), CMD016 and CMD017.

-- --- selection manifests (immutable agency documents, D-SEL-1, D-SEL-2) ---------------------------------------------------------
-- The closed document a selection names (CMD016 selectionManifestRef): every candidate file and table with an explicit
-- disposition, the parser choices and the object projection. Stored once per (revision, body hash) through the selection
-- manifest intake; a revision binds one of its own manifests with that exact hash. Ids, digests, tokens and positions only.
CREATE TABLE kauro.selection_manifests (
  selection_manifest_id     uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(selection_manifest_id)),
  agency_id                 uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id                uuid NOT NULL,
  revision_id               uuid NOT NULL,
  schema_version            integer NOT NULL CHECK (schema_version = 1),
  body                      jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object' AND pg_column_size(body) <= 524288),
  -- KAURO_SOURCE_SELECTION_V1 digest of the body (D-HASH-2): the selectionHash CMD017 confirms
  body_hash                 text NOT NULL CHECK (kauro.is_sha256_hex(body_hash)),
  created_by_membership_id  uuid NOT NULL,
  created_at                timestamptz NOT NULL,
  UNIQUE (agency_id, selection_manifest_id),
  UNIQUE (agency_id, revision_id, body_hash),
  UNIQUE (agency_id, revision_id, selection_manifest_id, body_hash),
  FOREIGN KEY (agency_id, project_id, revision_id) REFERENCES kauro.dataset_revisions (agency_id, project_id, revision_id),
  FOREIGN KEY (agency_id, created_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id),
  -- NULL-safe throughout: a CHECK passes on NULL, so a body missing a member must compare false, not unknown
  CONSTRAINT selection_manifests_binds_revision CHECK (
    (body ->> 'revisionId') IS NOT DISTINCT FROM revision_id::text AND (body ->> 'schemaVersion') IS NOT DISTINCT FROM schema_version::text
    AND coalesce(kauro.is_sha256_hex(body ->> 'inventoryHash'), false) AND jsonb_typeof(body -> 'files') IS NOT DISTINCT FROM 'array'
  )
);
CREATE TRIGGER selection_manifests_append_only BEFORE UPDATE OR DELETE ON kauro.selection_manifests
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- selection evaluations (append-only: the counting pass over one selection) -------------------------------------------------
-- The control plane opens every included table's accepted generation by exact generation, re-verifies its digest while parsing
-- under the selected parser choices, applies the projection and records the four populations the manifest freezes. A failure of
-- the admission contract in a selected table is recorded here and becomes fatal_input_rejection (07: no silent removal).
CREATE TABLE kauro.selection_evaluations (
  evaluation_id            uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(evaluation_id)),
  agency_id                uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  revision_id              uuid NOT NULL,
  selection_manifest_id    uuid NOT NULL,
  selection_hash           text NOT NULL CHECK (kauro.is_sha256_hex(selection_hash)),
  -- KAURO_SELECTION_EVALUATION_V1 digest of the evaluation payload (D-HASH-3)
  evaluation_hash          text NOT NULL CHECK (kauro.is_sha256_hex(evaluation_hash)),
  result                   text NOT NULL CHECK (result IN ('COMPLETE', 'ADMISSION_FAILED', 'ERROR')),
  physical_source_rows     bigint CHECK (physical_source_rows IS NULL OR physical_source_rows >= 0),
  logical_source_records   bigint CHECK (logical_source_records IS NULL OR logical_source_records >= 0),
  billable_source_units    bigint CHECK (billable_source_units IS NULL OR billable_source_units >= 0),
  association_edges        bigint CHECK (association_edges IS NULL OR association_edges >= 0),
  file_count               integer CHECK (file_count IS NULL OR file_count >= 0),
  total_bytes              bigint CHECK (total_bytes IS NULL OR total_bytes >= 0),
  -- observed while evaluating: [{fileId, generation, sha256, bytes}] — the generations the counts are true for
  files                    jsonb NOT NULL CHECK (jsonb_typeof(files) = 'array' AND jsonb_array_length(files) <= 50),
  -- per table and per projection counts and issue codes (ids, counts and tokens only)
  tables                   jsonb NOT NULL CHECK (jsonb_typeof(tables) = 'array'),
  projections              jsonb NOT NULL CHECK (jsonb_typeof(projections) = 'array'),
  failures                 jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(failures) = 'array' AND jsonb_array_length(failures) <= 256),
  pricing_definition       text NOT NULL CHECK (kauro.is_label(pricing_definition)),
  evaluator_version        text NOT NULL CHECK (kauro.is_label(evaluator_version)),
  started_at               timestamptz NOT NULL,
  completed_at             timestamptz NOT NULL CHECK (completed_at >= started_at),
  created_at               timestamptz NOT NULL,
  UNIQUE (agency_id, evaluation_id),
  UNIQUE (agency_id, revision_id, evaluation_hash),
  -- binding target: a revision's counts are exactly the counts of the evaluation of its current selection
  UNIQUE (agency_id, revision_id, evaluation_id, evaluation_hash, selection_hash, physical_source_rows, logical_source_records, billable_source_units, association_edges),
  FOREIGN KEY (agency_id, revision_id, selection_manifest_id, selection_hash)
    REFERENCES kauro.selection_manifests (agency_id, revision_id, selection_manifest_id, body_hash),
  CONSTRAINT selection_evaluations_complete CHECK (
    result <> 'COMPLETE' OR (
      physical_source_rows IS NOT NULL AND logical_source_records IS NOT NULL AND billable_source_units IS NOT NULL
      AND association_edges IS NOT NULL AND file_count IS NOT NULL AND total_bytes IS NOT NULL
      AND file_count BETWEEN 1 AND 50 AND total_bytes BETWEEN 1 AND 5000000000
      AND association_edges <= 5000000 AND billable_source_units <= logical_source_records
      AND jsonb_array_length(failures) = 0 AND jsonb_array_length(files) = file_count
    )
  ),
  CONSTRAINT selection_evaluations_failed_explained CHECK (result = 'COMPLETE' OR jsonb_array_length(failures) >= 1),
  CONSTRAINT selection_evaluations_counts_only_when_complete CHECK (result = 'COMPLETE' OR physical_source_rows IS NULL)
);
CREATE INDEX selection_evaluations_by_selection ON kauro.selection_evaluations (agency_id, revision_id, selection_hash, created_at);
CREATE TRIGGER selection_evaluations_append_only BEFORE UPDATE OR DELETE ON kauro.selection_evaluations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- the revision binds one of its own manifests with that exact hash, and an evaluation of that same selection with its exact counts
ALTER TABLE kauro.dataset_revisions ADD CONSTRAINT dataset_revisions_selection_fk
  FOREIGN KEY (agency_id, revision_id, selection_manifest_id, selection_hash)
  REFERENCES kauro.selection_manifests (agency_id, revision_id, selection_manifest_id, body_hash);
ALTER TABLE kauro.dataset_revisions ADD CONSTRAINT dataset_revisions_evaluation_fk
  FOREIGN KEY (agency_id, revision_id, evaluation_id, evaluation_hash, selection_hash, physical_source_rows, logical_source_records, billable_source_units, association_edges)
  REFERENCES kauro.selection_evaluations (agency_id, revision_id, evaluation_id, evaluation_hash, selection_hash, physical_source_rows, logical_source_records, billable_source_units, association_edges);

-- --- sealed manifests (the only subject that can be profiled and quoted) ----------------------------------------------------------
CREATE TABLE kauro.sealed_manifests (
  revision_id          uuid PRIMARY KEY,
  agency_id            uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id           uuid NOT NULL,
  manifest_hash        text NOT NULL CHECK (kauro.is_sha256_hex(manifest_hash)),
  projection_hash      text NOT NULL CHECK (kauro.is_sha256_hex(projection_hash)),
  selection_hash       text NOT NULL CHECK (kauro.is_sha256_hex(selection_hash)),
  evaluation_hash      text NOT NULL CHECK (kauro.is_sha256_hex(evaluation_hash)),
  canonical_version    integer NOT NULL CHECK (canonical_version = 1),
  -- the complete canonical manifest document whose KAURO_SOURCE_REVISION_V1 digest is manifest_hash (ids, hashes, counts,
  -- tokens: no customer text)
  manifest             jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object' AND pg_column_size(manifest) <= 1048576),
  sealed_at            timestamptz NOT NULL,
  UNIQUE (agency_id, revision_id),
  UNIQUE (agency_id, manifest_hash),
  FOREIGN KEY (agency_id, project_id, revision_id) REFERENCES kauro.dataset_revisions (agency_id, project_id, revision_id),
  CONSTRAINT sealed_manifests_names_revision CHECK (
    (manifest ->> 'revisionId') IS NOT DISTINCT FROM revision_id::text AND (manifest ->> 'canonicalVersion') IS NOT DISTINCT FROM canonical_version::text
  )
);
CREATE TRIGGER sealed_manifests_append_only BEFORE UPDATE OR DELETE ON kauro.sealed_manifests
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- the sealed file set: every file the sealed manifest names, included or explicitly excluded with its reason; an included file
-- names the exact admitted generation, digest and length of a file of the same project
CREATE TABLE kauro.sealed_revision_files (
  revision_id          uuid NOT NULL,
  file_id              uuid NOT NULL,
  agency_id            uuid NOT NULL,
  project_id           uuid NOT NULL,
  ordinal              integer NOT NULL CHECK (ordinal BETWEEN 0 AND 49),
  disposition          text NOT NULL CHECK (disposition IN ('INCLUDED', 'EXCLUDED')),
  exclusion_reason     text CHECK (exclusion_reason IS NULL OR kauro.is_token(exclusion_reason)),
  provider_generation  text NOT NULL CHECK (kauro.is_generation(provider_generation)),
  sha256               text NOT NULL CHECK (kauro.is_sha256_hex(sha256)),
  bytes                bigint NOT NULL CHECK (bytes BETWEEN 1 AND 2000000000),
  PRIMARY KEY (revision_id, file_id),
  UNIQUE (revision_id, ordinal),
  FOREIGN KEY (agency_id, revision_id) REFERENCES kauro.sealed_manifests (agency_id, revision_id),
  FOREIGN KEY (agency_id, project_id, revision_id) REFERENCES kauro.dataset_revisions (agency_id, project_id, revision_id),
  FOREIGN KEY (agency_id, project_id, file_id, provider_generation, sha256, bytes)
    REFERENCES kauro.source_files (agency_id, project_id, file_id, provider_generation, sha256, bytes),
  CONSTRAINT sealed_revision_files_exclusion_reason CHECK ((disposition = 'EXCLUDED') = (exclusion_reason IS NOT NULL))
);
CREATE INDEX sealed_revision_files_by_file ON kauro.sealed_revision_files (agency_id, file_id);
CREATE TRIGGER sealed_revision_files_append_only BEFORE UPDATE OR DELETE ON kauro.sealed_revision_files
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- An included file is admitted when it is sealed: the file's admission is a transition subject (0009), read after its shared
-- transition lock and held to COMMIT, so a revocation in flight is ordered before the seal (and read) or after it (and refused
-- by the revocation guard, which sees the seal).
CREATE OR REPLACE FUNCTION kauro.sealed_revision_files_admitted() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.disposition = 'INCLUDED' THEN
    PERFORM kauro.await_transition('kauro.source_files', NEW.file_id::text);
    IF NOT EXISTS (
      SELECT 1 FROM kauro.source_files f WHERE f.agency_id = NEW.agency_id AND f.file_id = NEW.file_id AND f.admitted AND f.state = 'ADMITTED'
    ) THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: file % is not admitted and cannot be sealed', NEW.file_id USING ERRCODE = 'KA072';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sealed_revision_files_admitted BEFORE INSERT ON kauro.sealed_revision_files
  FOR EACH ROW EXECUTE FUNCTION kauro.sealed_revision_files_admitted();

-- --- dataset revision lifecycle guard ----------------------------------------------------------------------------------------------
-- Entering a state requires the facts its registry guard names; a sealed subject never changes; a selection changes only while
-- the revision is selectable, against a settled inventory, and always starts uncounted. The listed-edge trigger of B06 decides
-- whether the edge exists; this guard decides whether its facts are present; the role policies of 0008 decide who may take it.
CREATE OR REPLACE FUNCTION kauro.dataset_revisions_lifecycle_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  live_uploads boolean;
BEGIN
  -- the transition lock first, then the facts (decision D-LOCK-1): B06's dataset_revisions_transition_lock takes the same lock,
  -- but fires after this guard (triggers fire by name), so a guard reading first would decide on what it read before waiting for
  -- an approval or a reservation in flight. A selection change is ordered the same way (a selection binds a settled inventory).
  IF NEW.state IS DISTINCT FROM OLD.state OR NEW.selection_hash IS DISTINCT FROM OLD.selection_hash THEN
    PERFORM pg_advisory_xact_lock(kauro.transition_key('kauro.dataset_revisions', OLD.revision_id::text));
  END IF;

  IF OLD.sealed_at IS NOT NULL AND (
       NEW.manifest_hash IS DISTINCT FROM OLD.manifest_hash OR NEW.projection_hash IS DISTINCT FROM OLD.projection_hash
    OR NEW.sealed_at IS DISTINCT FROM OLD.sealed_at OR NEW.selection_manifest_id IS DISTINCT FROM OLD.selection_manifest_id
    OR NEW.selection_hash IS DISTINCT FROM OLD.selection_hash OR NEW.inventory_hash IS DISTINCT FROM OLD.inventory_hash
    OR NEW.evaluation_id IS DISTINCT FROM OLD.evaluation_id OR NEW.evaluation_hash IS DISTINCT FROM OLD.evaluation_hash
    OR NEW.physical_source_rows IS DISTINCT FROM OLD.physical_source_rows OR NEW.logical_source_records IS DISTINCT FROM OLD.logical_source_records
    OR NEW.billable_source_units IS DISTINCT FROM OLD.billable_source_units OR NEW.association_edges IS DISTINCT FROM OLD.association_edges
    OR NEW.sealed_file_count IS DISTINCT FROM OLD.sealed_file_count OR NEW.sealed_bytes IS DISTINCT FROM OLD.sealed_bytes) THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: sealed revision % cannot change its subject', OLD.revision_id USING ERRCODE = 'KA004';
  END IF;

  live_uploads := EXISTS (
    SELECT 1 FROM kauro.upload_sessions u WHERE u.agency_id = OLD.agency_id AND u.revision_id = OLD.revision_id AND u.state IN ('RESERVED', 'UPLOADING', 'VERIFYING')
  );

  -- binding a selection (CMD016): only while selectable, never removed, against a settled inventory (D-SEL-3), naming the
  -- inventory the manifest was made against, and always leaving the revision INSPECTING and uncounted
  IF NEW.selection_hash IS DISTINCT FROM OLD.selection_hash OR NEW.selection_manifest_id IS DISTINCT FROM OLD.selection_manifest_id THEN
    IF OLD.state NOT IN ('DRAFT', 'INSPECTING', 'READY_TO_SEAL') OR NEW.selection_hash IS NULL OR NEW.state <> 'INSPECTING' OR NEW.evaluation_id IS NOT NULL THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: a selection is bound to a selectable revision, which it leaves INSPECTING and uncounted (%)', OLD.revision_id USING ERRCODE = 'KA072';
    END IF;
    IF live_uploads THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: revision % has uploads in flight; a selection is bound against a settled inventory', OLD.revision_id USING ERRCODE = 'KA072';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM kauro.selection_manifests m
       WHERE m.agency_id = NEW.agency_id AND m.selection_manifest_id = NEW.selection_manifest_id AND (m.body ->> 'inventoryHash') = NEW.inventory_hash
    ) THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: revision % must record the inventory its selection manifest names', OLD.revision_id USING ERRCODE = 'KA072';
    END IF;
  END IF;

  -- counts are bound only by all_selected_inputs_admitted (INSPECTING -> READY_TO_SEAL) and cleared only by a new selection
  IF NEW.evaluation_hash IS DISTINCT FROM OLD.evaluation_hash AND NEW.evaluation_hash IS NOT NULL AND NOT (OLD.state = 'INSPECTING' AND NEW.state = 'READY_TO_SEAL') THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: an evaluation is bound only by all_selected_inputs_admitted (%)', OLD.revision_id USING ERRCODE = 'KA072';
  END IF;
  IF NEW.evaluation_hash IS NULL AND OLD.evaluation_hash IS NOT NULL AND NEW.selection_hash IS NOT DISTINCT FROM OLD.selection_hash THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: the counts of revision % are cleared only by a new selection', OLD.revision_id USING ERRCODE = 'KA072';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF OLD.state = 'DRAFT' AND NEW.state = 'UPLOADING' THEN
      -- upload_reserved: the reservation that moves the revision exists in the same transaction
      IF NOT live_uploads THEN
        RAISE EXCEPTION 'LIFECYCLE_BINDING: upload_reserved needs the reservation it records (%)', OLD.revision_id USING ERRCODE = 'KA072';
      END IF;
    ELSIF OLD.state = 'UPLOADING' AND NEW.state = 'INSPECTING' THEN
      -- all_uploads_completed: "Actual provider completion is observed" — no reservation or session is still open, every
      -- reported completion has been observed, and at least one observed input remains to inspect
      IF EXISTS (SELECT 1 FROM kauro.upload_sessions u WHERE u.agency_id = OLD.agency_id AND u.revision_id = OLD.revision_id
                  AND (u.state IN ('RESERVED', 'UPLOADING') OR (u.state = 'VERIFYING' AND u.completion_observed_at IS NULL)))
         OR NOT EXISTS (SELECT 1 FROM kauro.upload_sessions u WHERE u.agency_id = OLD.agency_id AND u.revision_id = OLD.revision_id
                  AND u.state IN ('VERIFYING', 'ADMITTED') AND u.completion_observed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'LIFECYCLE_BINDING: all_uploads_completed needs every completion observed and one input to inspect (%)', OLD.revision_id USING ERRCODE = 'KA072';
      END IF;
    ELSIF OLD.state = 'READY_TO_SEAL' AND NEW.state = 'INSPECTING' THEN
      -- selection_changes: "Invalidate selected-scope readiness and recompute affected facts"
      IF NEW.selection_hash IS NOT DISTINCT FROM OLD.selection_hash THEN
        RAISE EXCEPTION 'LIFECYCLE_BINDING: selection_changes binds a new selection to revision %', OLD.revision_id USING ERRCODE = 'KA072';
      END IF;
    ELSIF OLD.state = 'DRAFT' AND NEW.state = 'INSPECTING' THEN
      -- previously_admitted_inputs_selected: reuse is an explicit selection (the binding branch above checked it)
      IF NEW.selection_hash IS NULL THEN
        RAISE EXCEPTION 'LIFECYCLE_BINDING: previously_admitted_inputs_selected needs a selection on revision %', OLD.revision_id USING ERRCODE = 'KA072';
      END IF;
    ELSIF NEW.state = 'READY_TO_SEAL' THEN
      -- all_selected_inputs_admitted: "Every selected table/file passes and projection/count decisions are complete"
      IF live_uploads THEN
        RAISE EXCEPTION 'LIFECYCLE_BINDING: revision % has uploads in flight and cannot expose a sealable scope', OLD.revision_id USING ERRCODE = 'KA072';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM kauro.selection_evaluations e
         WHERE e.agency_id = NEW.agency_id AND e.evaluation_id = NEW.evaluation_id AND e.result = 'COMPLETE' AND e.selection_hash = NEW.selection_hash
      ) THEN
        RAISE EXCEPTION 'LIFECYCLE_BINDING: all_selected_inputs_admitted needs a complete evaluation of the current selection of %', OLD.revision_id USING ERRCODE = 'KA072';
      END IF;
      -- every included file of the selection is an admitted file of this project, counted at its exact generation
      IF NOT EXISTS (
        SELECT 1 FROM kauro.selection_manifests m, jsonb_array_elements(m.body -> 'files') f
         WHERE m.agency_id = NEW.agency_id AND m.selection_manifest_id = NEW.selection_manifest_id AND f ->> 'disposition' = 'INCLUDE'
      ) OR EXISTS (
        SELECT 1 FROM kauro.selection_manifests m, jsonb_array_elements(m.body -> 'files') f
         WHERE m.agency_id = NEW.agency_id AND m.selection_manifest_id = NEW.selection_manifest_id AND f ->> 'disposition' = 'INCLUDE'
           AND NOT EXISTS (
             SELECT 1 FROM kauro.source_files s, kauro.selection_evaluations e, jsonb_array_elements(e.files) ef
              WHERE s.agency_id = NEW.agency_id AND s.project_id = NEW.project_id AND s.file_id::text = f ->> 'fileId' AND s.state = 'ADMITTED'
                AND e.agency_id = NEW.agency_id AND e.evaluation_id = NEW.evaluation_id
                AND ef ->> 'fileId' = s.file_id::text AND ef ->> 'generation' = s.provider_generation AND ef ->> 'sha256' = s.sha256
                AND (ef ->> 'bytes')::bigint = s.bytes
           )
      ) THEN
        RAISE EXCEPTION 'LIFECYCLE_BINDING: an included file of revision % is not an admitted file counted at its generation', OLD.revision_id USING ERRCODE = 'KA072';
      END IF;
    ELSIF NEW.state = 'REJECTED' THEN
      -- fatal_input_rejection: "A selected input violates the admission contract" — the evaluation of the current selection says so
      IF NOT EXISTS (
        SELECT 1 FROM kauro.selection_evaluations e
         WHERE e.agency_id = NEW.agency_id AND e.revision_id = NEW.revision_id AND e.selection_hash = NEW.selection_hash AND e.result = 'ADMISSION_FAILED'
      ) THEN
        RAISE EXCEPTION 'LIFECYCLE_BINDING: fatal_input_rejection needs the failed evaluation of the current selection of %', OLD.revision_id USING ERRCODE = 'KA072';
      END IF;
    ELSIF NEW.state = 'SEALED' THEN
      -- seal_command: "All exact generations, receipts, parser choices and projection hashes match" what READY_TO_SEAL exposed
      IF NEW.manifest_hash IS NULL OR NEW.projection_hash IS NULL OR NEW.sealed_at IS NULL OR NEW.sealed_file_count IS NULL OR NEW.sealed_bytes IS NULL
         OR NEW.selection_hash IS DISTINCT FROM OLD.selection_hash OR NEW.evaluation_hash IS DISTINCT FROM OLD.evaluation_hash
         OR NEW.physical_source_rows IS DISTINCT FROM OLD.physical_source_rows OR NEW.logical_source_records IS DISTINCT FROM OLD.logical_source_records
         OR NEW.billable_source_units IS DISTINCT FROM OLD.billable_source_units OR NEW.association_edges IS DISTINCT FROM OLD.association_edges
         OR live_uploads THEN
        RAISE EXCEPTION 'LIFECYCLE_BINDING: seal_command must bind the manifest of exactly the scope READY_TO_SEAL exposed (%)', OLD.revision_id USING ERRCODE = 'KA072';
      END IF;
    ELSIF OLD.state = 'SEALED' AND NEW.state = 'EXPIRED' THEN
      -- retention_expires: "Effective deadline derived from immutable anchors is reached" — the revision is governed by at least one
      -- retention record, and none of them is still ACTIVE with an effective deadline after the expiry (the earliest applicable
      -- deadline of each record governs it; a later lawful deadline of another record, such as a paid class, keeps the data)
      IF NEW.expired_at IS NULL
         OR NOT EXISTS (SELECT 1 FROM kauro.retention_records r WHERE r.agency_id = NEW.agency_id AND r.revision_id = NEW.revision_id)
         OR EXISTS (SELECT 1 FROM kauro.retention_records r WHERE r.agency_id = NEW.agency_id AND r.revision_id = NEW.revision_id
                     AND r.state = 'ACTIVE' AND r.effective_deadline > NEW.expired_at) THEN
        RAISE EXCEPTION 'LIFECYCLE_BINDING: retention_expires needs every governing retention deadline of % reached', OLD.revision_id USING ERRCODE = 'KA072';
      END IF;
    ELSIF OLD.state = 'REJECTED' AND NEW.state = 'EXPIRED' THEN
      -- retention_expires of rejected input: "Rejected-input cleanup deadline is reached" — unsealed intake data follows its upload
      -- session policy (D-RET-1), so every intake window of the revision has closed
      IF NEW.expired_at IS NULL OR EXISTS (
        SELECT 1 FROM kauro.upload_sessions u WHERE u.agency_id = NEW.agency_id AND u.revision_id = NEW.revision_id AND u.application_expires_at > NEW.expired_at
      ) THEN
        RAISE EXCEPTION 'LIFECYCLE_BINDING: retention_expires of rejected revision % waits for every intake window to close', OLD.revision_id USING ERRCODE = 'KA072';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER dataset_revisions_lifecycle_guard BEFORE UPDATE ON kauro.dataset_revisions
  FOR EACH ROW EXECUTE FUNCTION kauro.dataset_revisions_lifecycle_guard();

-- At commit, a revision that entered SEALED has its sealed manifest with exactly its hashes, its sealed file set is exactly the
-- selection's dispositions (no file silently dropped or added) and agrees with the counts it froze, and its UNPAID retention
-- record is anchored on the seal with the hard cap of the policy (D-RET-2; "retention anchors survive failure": the seal and its
-- anchor commit together or not at all).
CREATE OR REPLACE FUNCTION kauro.dataset_revisions_sealed_subject() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  included integer;
  included_bytes bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.sealed_manifests m
    WHERE m.agency_id = NEW.agency_id AND m.revision_id = NEW.revision_id AND m.manifest_hash = NEW.manifest_hash
      AND m.projection_hash = NEW.projection_hash AND m.selection_hash = NEW.selection_hash AND m.evaluation_hash = NEW.evaluation_hash
      AND m.sealed_at = NEW.sealed_at
  ) THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: sealed revision % has no matching sealed manifest', NEW.revision_id USING ERRCODE = 'KA072';
  END IF;
  SELECT count(*), coalesce(sum(bytes), 0) INTO included, included_bytes
    FROM kauro.sealed_revision_files WHERE agency_id = NEW.agency_id AND revision_id = NEW.revision_id AND disposition = 'INCLUDED';
  IF included <> NEW.sealed_file_count OR included_bytes <> NEW.sealed_bytes THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: sealed revision % names % included files (% bytes) but froze % (% bytes)', NEW.revision_id, included, included_bytes, NEW.sealed_file_count, NEW.sealed_bytes USING ERRCODE = 'KA072';
  END IF;
  IF EXISTS (
    SELECT f ->> 'fileId', f ->> 'disposition' FROM kauro.selection_manifests m, jsonb_array_elements(m.body -> 'files') f
     WHERE m.agency_id = NEW.agency_id AND m.selection_manifest_id = NEW.selection_manifest_id
    EXCEPT
    SELECT s.file_id::text, CASE s.disposition WHEN 'INCLUDED' THEN 'INCLUDE' ELSE 'EXCLUDE' END FROM kauro.sealed_revision_files s
     WHERE s.agency_id = NEW.agency_id AND s.revision_id = NEW.revision_id
  ) OR EXISTS (
    SELECT s.file_id::text, CASE s.disposition WHEN 'INCLUDED' THEN 'INCLUDE' ELSE 'EXCLUDE' END FROM kauro.sealed_revision_files s
     WHERE s.agency_id = NEW.agency_id AND s.revision_id = NEW.revision_id
    EXCEPT
    SELECT f ->> 'fileId', f ->> 'disposition' FROM kauro.selection_manifests m, jsonb_array_elements(m.body -> 'files') f
     WHERE m.agency_id = NEW.agency_id AND m.selection_manifest_id = NEW.selection_manifest_id
  ) THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: the sealed file set of revision % is not the dispositions of its selection', NEW.revision_id USING ERRCODE = 'KA072';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM kauro.retention_records r JOIN kauro.retention_anchors a ON a.agency_id = r.agency_id AND a.anchor_id = r.anchor_id
     WHERE r.agency_id = NEW.agency_id AND r.revision_id = NEW.revision_id AND r.class = 'UNPAID' AND a.anchor_kind = 'REVISION_SEALED'
       AND a.revision_id = NEW.revision_id AND a.occurred_at = NEW.sealed_at
       -- policy retention.unpaidDaysHardFromSeal = 14; a day is an exact 86400-second duration (HASHING "Retention formulas")
       AND r.hard_deadline = NEW.sealed_at + interval '1209600 seconds'
  ) THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: sealed revision % has no retention record anchored on its seal', NEW.revision_id USING ERRCODE = 'KA072';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER dataset_revisions_sealed_subject AFTER UPDATE OF state ON kauro.dataset_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state = 'SEALED' AND OLD.state <> 'SEALED')
  EXECUTE FUNCTION kauro.dataset_revisions_sealed_subject();

-- At commit, a revision that left the mutable states has no upload in flight: a cancellation, a rejection, a seal, a
-- supersession or an expiry tombstones or settles every reservation of the revision in the same transaction (CMD012 cancels them;
-- a concurrent reservation is ordered by the revision's transition lock, 0008), so no late session can target a closed revision.
CREATE OR REPLACE FUNCTION kauro.dataset_revisions_closed_without_live_uploads() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF EXISTS (
    SELECT 1 FROM kauro.upload_sessions u WHERE u.agency_id = NEW.agency_id AND u.revision_id = NEW.revision_id AND u.state IN ('RESERVED', 'UPLOADING', 'VERIFYING')
  ) THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: revision % is % with uploads still in flight', NEW.revision_id, NEW.state USING ERRCODE = 'KA072';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER dataset_revisions_closed_without_live_uploads AFTER UPDATE OF state ON kauro.dataset_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state IN ('SEALED', 'REJECTED', 'CANCELLED', 'SUPERSEDED', 'EXPIRED', 'DELETED') AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION kauro.dataset_revisions_closed_without_live_uploads();

-- --- row-level security ----------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.selection_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.selection_manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY selection_manifests_tenant_read ON kauro.selection_manifests FOR SELECT TO kauro_app
  USING (agency_id = kauro.current_agency_id());
-- a manifest is stored by a member of the agency, as its own membership (the intake route; D-SEL-2)
CREATE POLICY selection_manifests_tenant_insert ON kauro.selection_manifests FOR INSERT TO kauro_app
  WITH CHECK (
    agency_id = kauro.current_agency_id()
    AND EXISTS (
      SELECT 1 FROM kauro.memberships m
       WHERE m.agency_id = selection_manifests.agency_id AND m.membership_id = selection_manifests.created_by_membership_id
         AND m.user_id = kauro.current_user_id() AND m.state = 'ACTIVE'
    )
  );
CREATE POLICY selection_manifests_control_read ON kauro.selection_manifests FOR SELECT TO kauro_control
  USING (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.selection_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.selection_evaluations FORCE ROW LEVEL SECURITY;
CREATE POLICY selection_evaluations_tenant_read ON kauro.selection_evaluations FOR SELECT TO kauro_app
  USING (agency_id = kauro.current_agency_id());
CREATE POLICY selection_evaluations_control_read ON kauro.selection_evaluations FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY selection_evaluations_control_insert ON kauro.selection_evaluations FOR INSERT TO kauro_control
  WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.sealed_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.sealed_manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY sealed_manifests_tenant ON kauro.sealed_manifests FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY sealed_manifests_control_read ON kauro.sealed_manifests FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());

ALTER TABLE kauro.sealed_revision_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.sealed_revision_files FORCE ROW LEVEL SECURITY;
CREATE POLICY sealed_revision_files_tenant ON kauro.sealed_revision_files FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY sealed_revision_files_control_read ON kauro.sealed_revision_files FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());

-- --- grants ----------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON kauro.selection_manifests, kauro.sealed_manifests, kauro.sealed_revision_files TO kauro_app;
GRANT SELECT ON kauro.selection_evaluations TO kauro_app;
GRANT SELECT ON kauro.selection_manifests, kauro.sealed_manifests, kauro.sealed_revision_files TO kauro_control;
GRANT SELECT, INSERT ON kauro.selection_evaluations TO kauro_control;
