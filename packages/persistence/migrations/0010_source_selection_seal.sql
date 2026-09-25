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
-- all_selected_inputs_admitted, selection_changes, seal_command, new_revision_explicitly_supersedes), CMD016 and CMD017.

-- --- selection manifests (immutable agency documents, D-SEL-1) -----------------------------------------------------------------
-- The closed document a selection names (CMD016 selectionManifestRef): every candidate file and table with an explicit
-- disposition, the parser choices and the object projection. Stored once per (revision, body hash); a revision binds one of its
-- own manifests with that exact hash.
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
  CONSTRAINT selection_manifests_binds_revision CHECK ((body ->> 'revisionId') = revision_id::text)
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
      AND association_edges IS NOT NULL AND file_count BETWEEN 1 AND 50 AND total_bytes BETWEEN 1 AND 5000000000
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
  FOREIGN KEY (agency_id, project_id, revision_id) REFERENCES kauro.dataset_revisions (agency_id, project_id, revision_id)
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

-- an included file is admitted at the moment it is sealed (a file whose admission was revoked cannot enter a seal)
CREATE OR REPLACE FUNCTION kauro.sealed_revision_files_admitted() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.disposition = 'INCLUDED' AND NOT EXISTS (
    SELECT 1 FROM kauro.source_files f WHERE f.agency_id = NEW.agency_id AND f.file_id = NEW.file_id AND f.admitted AND f.state = 'ADMITTED'
  ) THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: file % is not admitted and cannot be sealed', NEW.file_id USING ERRCODE = 'KA011';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sealed_revision_files_admitted BEFORE INSERT ON kauro.sealed_revision_files
  FOR EACH ROW EXECUTE FUNCTION kauro.sealed_revision_files_admitted();

-- --- dataset revision lifecycle guard ----------------------------------------------------------------------------------------------
-- Entering a state requires the facts its registry guard names; a sealed subject never changes; a selection changes only while
-- the revision is mutable and selectable. (B06 rows written directly by fixtures in a later state are not transitions and are not
-- re-judged: the guard runs on UPDATE, where every lifecycle move happens.)
CREATE OR REPLACE FUNCTION kauro.dataset_revisions_lifecycle_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.sealed_at IS NOT NULL AND (
       NEW.manifest_hash IS DISTINCT FROM OLD.manifest_hash OR NEW.projection_hash IS DISTINCT FROM OLD.projection_hash
    OR NEW.sealed_at IS DISTINCT FROM OLD.sealed_at OR NEW.selection_manifest_id IS DISTINCT FROM OLD.selection_manifest_id
    OR NEW.selection_hash IS DISTINCT FROM OLD.selection_hash OR NEW.evaluation_id IS DISTINCT FROM OLD.evaluation_id
    OR NEW.evaluation_hash IS DISTINCT FROM OLD.evaluation_hash OR NEW.physical_source_rows IS DISTINCT FROM OLD.physical_source_rows
    OR NEW.logical_source_records IS DISTINCT FROM OLD.logical_source_records OR NEW.billable_source_units IS DISTINCT FROM OLD.billable_source_units
    OR NEW.association_edges IS DISTINCT FROM OLD.association_edges OR NEW.sealed_file_count IS DISTINCT FROM OLD.sealed_file_count
    OR NEW.sealed_bytes IS DISTINCT FROM OLD.sealed_bytes) THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: sealed revision % cannot change its subject', OLD.revision_id USING ERRCODE = 'KA004';
  END IF;
  IF NEW.selection_hash IS DISTINCT FROM OLD.selection_hash AND OLD.state NOT IN ('DRAFT', 'INSPECTING', 'READY_TO_SEAL') THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: revision % is % and its selection cannot change', OLD.revision_id, OLD.state USING ERRCODE = 'KA011';
  END IF;
  IF NEW.evaluation_hash IS NOT NULL AND NEW.evaluation_hash IS DISTINCT FROM OLD.evaluation_hash AND NEW.state NOT IN ('READY_TO_SEAL') THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: an evaluation is bound only by all_selected_inputs_admitted' USING ERRCODE = 'KA011';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NEW.state = 'INSPECTING' AND OLD.state = 'READY_TO_SEAL' AND (NEW.evaluation_id IS NOT NULL OR NEW.selection_hash IS NOT DISTINCT FROM OLD.selection_hash) THEN
      -- selection_changes: "Invalidate selected-scope readiness and recompute affected facts"
      RAISE EXCEPTION 'LIFECYCLE_BINDING: selection_changes binds a new selection and clears the evaluation of revision %', OLD.revision_id USING ERRCODE = 'KA011';
    ELSIF NEW.state = 'INSPECTING' AND OLD.state = 'DRAFT' AND NEW.selection_hash IS NULL THEN
      -- previously_admitted_inputs_selected: reuse is an explicit selection
      RAISE EXCEPTION 'LIFECYCLE_BINDING: previously_admitted_inputs_selected needs a selection on revision %', OLD.revision_id USING ERRCODE = 'KA011';
    ELSIF NEW.state = 'READY_TO_SEAL' AND NOT EXISTS (
      SELECT 1 FROM kauro.selection_evaluations e
      WHERE e.agency_id = NEW.agency_id AND e.evaluation_id = NEW.evaluation_id AND e.result = 'COMPLETE' AND e.selection_hash = NEW.selection_hash
    ) THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: all_selected_inputs_admitted needs a complete evaluation of the current selection of %', OLD.revision_id USING ERRCODE = 'KA011';
    ELSIF NEW.state = 'SEALED' AND (
         NEW.manifest_hash IS NULL OR NEW.projection_hash IS NULL OR NEW.sealed_at IS NULL OR NEW.sealed_file_count IS NULL OR NEW.sealed_bytes IS NULL
      OR NEW.selection_hash IS DISTINCT FROM OLD.selection_hash OR NEW.evaluation_hash IS DISTINCT FROM OLD.evaluation_hash
      OR NEW.physical_source_rows IS DISTINCT FROM OLD.physical_source_rows OR NEW.logical_source_records IS DISTINCT FROM OLD.logical_source_records
      OR NEW.billable_source_units IS DISTINCT FROM OLD.billable_source_units OR NEW.association_edges IS DISTINCT FROM OLD.association_edges) THEN
      -- seal_command: "All exact generations, receipts, parser choices and projection hashes match" what READY_TO_SEAL exposed
      RAISE EXCEPTION 'LIFECYCLE_BINDING: seal_command must bind the manifest of exactly the scope READY_TO_SEAL exposed (%)', OLD.revision_id USING ERRCODE = 'KA011';
    ELSIF NEW.state = 'CANCELLED' AND (NEW.cancelled_at IS NULL OR NEW.terminal_reason IS NULL) THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: cancel_revision records when and why (%)', OLD.revision_id USING ERRCODE = 'KA011';
    ELSIF NEW.state = 'REJECTED' AND (NEW.rejected_at IS NULL OR NEW.terminal_reason IS NULL) THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: fatal_input_rejection records when and why (%)', OLD.revision_id USING ERRCODE = 'KA011';
    ELSIF NEW.state = 'EXPIRED' AND NEW.expired_at IS NULL THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: retention_expires records when (%)', OLD.revision_id USING ERRCODE = 'KA011';
    ELSIF NEW.state = 'DELETED' AND NEW.deleted_at IS NULL THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: managed cleanup records when (%)', OLD.revision_id USING ERRCODE = 'KA011';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER dataset_revisions_lifecycle_guard BEFORE UPDATE ON kauro.dataset_revisions
  FOR EACH ROW EXECUTE FUNCTION kauro.dataset_revisions_lifecycle_guard();

-- At commit, a revision that entered SEALED has its sealed manifest with exactly its hashes, and the sealed file set agrees with
-- the counts it froze (no file silently dropped or added).
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
    RAISE EXCEPTION 'LIFECYCLE_BINDING: sealed revision % has no matching sealed manifest', NEW.revision_id USING ERRCODE = 'KA011';
  END IF;
  SELECT count(*), coalesce(sum(bytes), 0) INTO included, included_bytes
    FROM kauro.sealed_revision_files WHERE agency_id = NEW.agency_id AND revision_id = NEW.revision_id AND disposition = 'INCLUDED';
  IF included <> NEW.sealed_file_count OR included_bytes <> NEW.sealed_bytes THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: sealed revision % names % included files (% bytes) but froze % (% bytes)', NEW.revision_id, included, included_bytes, NEW.sealed_file_count, NEW.sealed_bytes USING ERRCODE = 'KA011';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER dataset_revisions_sealed_subject AFTER UPDATE OF state ON kauro.dataset_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state = 'SEALED' AND OLD.state <> 'SEALED')
  EXECUTE FUNCTION kauro.dataset_revisions_sealed_subject();

-- --- row-level security ----------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.selection_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.selection_manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY selection_manifests_tenant ON kauro.selection_manifests FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
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
