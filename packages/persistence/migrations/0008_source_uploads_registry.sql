-- 0008 — B07 source lifecycle, part 1: the aggregate-kind registry and its event binding, the dataset revision lifecycle
-- columns and lineage, the object registry (deletion inventory) with the provider retention read-back, upload sessions, the
-- byte/file/concurrency quota ledgers, the encrypted provider-session record, and the control plane's bounded event stream.
--
-- Authority: 09 "Storage zones and object registry" (every object is registered with agency, project, revision or case scope,
-- class, provider location, opaque object name, generation, byte count, content hash when complete, creator, state, retention
-- anchor and deletion status; a filename is display metadata only; object names use opaque identifiers and fixed safe
-- separators; generation preconditions prevent overwrite; the registry is authoritative for intended objects while provider
-- inventory detects objects missing from it), 09 "Initial intake envelope" (fifty files, 2,000,000,000 bytes per file,
-- 5,000,000,000 bytes per revision — conjunctive limits), 09 "Upload reservation" (reserve declared bytes and one upload slot;
-- two concurrent sessions per agency; the reservation expires twenty-four hours from initiation and polling never extends it),
-- 09 "Resumable session security" (the provider session reference is a bearer credential, stored encrypted in the temporary
-- control record, returned only through the authenticated upload flow; the provider cancellation result is recorded; a late
-- completed object remains quarantined and is deleted), 09 "Soft delete, versioning and holds" (the effective soft-delete and
-- versioning setting is verified after provisioning; actual residual expiry is recorded instead of claiming it vanished),
-- 07 "Database representation" (agency_id on every tenant row, composite foreign keys, scoped uniqueness, UUIDv7, timestamptz,
-- versions), 07 "Transaction discipline" (unique constraints and row locks close races; application checks cannot be the sole
-- protection), registry contracts UploadSession, DatasetRevision, TenantScope; R2-051, R2-052. Design:
-- docs/design/B07-upload-source-lifecycle.md (decisions D-*); B06 foundation: D-INIT-1 (initial states), D-TX-2 (transition
-- locks), D-EVT-2 (events bound to their aggregate), D-RLS-1/D-RLS-2 (forced RLS, no DELETE for request handlers).
--
-- SQLSTATE vocabulary added by B07 (a range of its own, decision D-SQL-1, so packages built in parallel cannot collide; mapped
-- by @kauro/persistence sqlstate.ts):
--   KA070 QUOTA_LEDGER (a quota ledger disagrees with the upload sessions it summarizes)
--   KA071 FENCE_DISCIPLINE (a session-issue or inspection fence moved backwards, or a stale attempt wrote)
--   KA072 LIFECYCLE_BINDING (a lifecycle transition lacks the facts its target state requires, or leaves its scope inconsistent)

-- --- field vocabulary ----------------------------------------------------------------------------------------------------------
-- Provider object generation: a positive decimal integer (Cloud Storage int64 generation; the contract fake uses the same form).
CREATE OR REPLACE FUNCTION kauro.is_generation(v text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT v ~ '^[1-9][0-9]{0,19}$' $$;

-- Opaque object names (09: opaque identifiers and fixed safe separators; never an original filename): a zone prefix followed by
-- two to five canonical UUIDs. Fixed-length components mean a prefix listing of one scope can never match another scope
-- (08: a prefix such as job-1 must not include job-10).
CREATE OR REPLACE FUNCTION kauro.is_object_name(v text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT v ~ '^(quarantine|accepted|profile|minimized|staging|delivery|import-receipt|legal-finance|security)(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){2,5}$' $$;

-- --- aggregate kinds (decision D-MIG-1) ------------------------------------------------------------------------------------------
-- B06 constrained domain_events.aggregate_kind with a CHECK list. Every package that adds an aggregate would have to rewrite that
-- list, and two packages rewriting it independently lose each other's kinds. The list becomes a registered table (like
-- event_types): a package inserts its kinds, nobody rewrites anybody else's. The persistence test proves the seed equals the
-- domain AGGREGATE_KINDS and that every registered kind is bound by kauro.domain_events_bind_aggregate below.
CREATE TABLE kauro.aggregate_kinds (
  aggregate_kind  text PRIMARY KEY CHECK (aggregate_kind ~ '^[a-z][a-z_]{2,63}$'),
  registered_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO kauro.aggregate_kinds (aggregate_kind) VALUES
  ('agency'), ('membership'), ('end_client'), ('project'), ('dataset_revision'), ('plan'), ('approval'),
  ('upload_session'), ('retention_record');
ALTER TABLE kauro.domain_events DROP CONSTRAINT domain_events_aggregate_kind_check;
ALTER TABLE kauro.domain_events ADD CONSTRAINT domain_events_aggregate_kind_fkey
  FOREIGN KEY (aggregate_kind) REFERENCES kauro.aggregate_kinds (aggregate_kind);

ALTER TABLE kauro.aggregate_kinds ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.aggregate_kinds FORCE ROW LEVEL SECURITY;
CREATE POLICY aggregate_kinds_read ON kauro.aggregate_kinds FOR SELECT TO kauro_app, kauro_control USING (true);
GRANT SELECT ON kauro.aggregate_kinds TO kauro_app, kauro_control;

-- --- dataset revisions: lifecycle columns and lineage (B06 created identity and bindings; B07 owns the lifecycle) --------------
-- Every added column is nullable: rows written by B06 paths (CreateProject's DRAFT revision) stay valid. The facts a target state
-- requires are enforced when the state is entered (trigger kauro.dataset_revisions_lifecycle_guard, migration 0010).
ALTER TABLE kauro.dataset_revisions
  ADD COLUMN created_by_membership_id   uuid,
  ADD COLUMN selection_manifest_id      uuid,
  ADD COLUMN selection_hash             text CHECK (selection_hash IS NULL OR kauro.is_sha256_hex(selection_hash)),
  -- the inventory the bound selection was made against (KAURO_SOURCE_INVENTORY_V1; decision D-SEL-3)
  ADD COLUMN inventory_hash             text CHECK (inventory_hash IS NULL OR kauro.is_sha256_hex(inventory_hash)),
  ADD COLUMN selected_at                timestamptz,
  ADD COLUMN evaluation_id              uuid,
  ADD COLUMN evaluation_hash            text CHECK (evaluation_hash IS NULL OR kauro.is_sha256_hex(evaluation_hash)),
  -- RowCounts populations frozen by the evaluation (03 "Count the correct population"); equal to the bound evaluation by FK
  ADD COLUMN physical_source_rows       bigint CHECK (physical_source_rows IS NULL OR physical_source_rows >= 0),
  ADD COLUMN logical_source_records     bigint CHECK (logical_source_records IS NULL OR logical_source_records >= 0),
  ADD COLUMN billable_source_units      bigint CHECK (billable_source_units IS NULL OR billable_source_units >= 0),
  ADD COLUMN association_edges          bigint CHECK (association_edges IS NULL OR association_edges BETWEEN 0 AND 5000000),
  ADD COLUMN sealed_file_count          integer CHECK (sealed_file_count IS NULL OR sealed_file_count BETWEEN 1 AND 50),
  ADD COLUMN sealed_bytes               bigint CHECK (sealed_bytes IS NULL OR sealed_bytes BETWEEN 1 AND 5000000000),
  ADD COLUMN superseded_by_revision_id  uuid,
  ADD COLUMN superseded_at              timestamptz,
  ADD COLUMN cancelled_at               timestamptz,
  ADD COLUMN rejected_at                timestamptz,
  ADD COLUMN expired_at                 timestamptz,
  ADD COLUMN deleted_at                 timestamptz,
  ADD COLUMN terminal_reason            text CHECK (terminal_reason IS NULL OR kauro.is_token(terminal_reason));

ALTER TABLE kauro.dataset_revisions
  ADD CONSTRAINT dataset_revisions_selection_complete CHECK (
    (selection_manifest_id IS NULL) = (selection_hash IS NULL) AND (selection_hash IS NULL) = (selected_at IS NULL)
    AND (selection_hash IS NULL) = (inventory_hash IS NULL)
  ),
  ADD CONSTRAINT dataset_revisions_evaluation_complete CHECK ((evaluation_id IS NULL) = (evaluation_hash IS NULL)),
  ADD CONSTRAINT dataset_revisions_counts_complete CHECK (
    (physical_source_rows IS NULL) = (logical_source_records IS NULL)
    AND (logical_source_records IS NULL) = (billable_source_units IS NULL)
    AND (billable_source_units IS NULL) = (association_edges IS NULL)
    AND (physical_source_rows IS NULL) = (evaluation_id IS NULL)
  ),
  ADD CONSTRAINT dataset_revisions_billable_within_logical CHECK (billable_source_units IS NULL OR billable_source_units <= logical_source_records),
  -- READY_TO_SEAL exposes an exact source scope (registry edge all_selected_inputs_admitted): selection, evaluation and counts
  ADD CONSTRAINT dataset_revisions_ready_bindings CHECK (
    state NOT IN ('READY_TO_SEAL', 'SEALED', 'SUPERSEDED') OR (selection_hash IS NOT NULL AND evaluation_hash IS NOT NULL AND physical_source_rows IS NOT NULL)
  ),
  ADD CONSTRAINT dataset_revisions_sealed_counts CHECK (
    state NOT IN ('SEALED', 'SUPERSEDED') OR (sealed_file_count IS NOT NULL AND sealed_bytes IS NOT NULL)
  ),
  ADD CONSTRAINT dataset_revisions_superseded_names_successor CHECK (
    state <> 'SUPERSEDED' OR (superseded_by_revision_id IS NOT NULL AND superseded_at IS NOT NULL)
  ),
  -- a terminal instant is set exactly when its state is entered and stays with the row on the later edges it can take
  ADD CONSTRAINT dataset_revisions_cancelled_binding CHECK (
    (state = 'CANCELLED') = (cancelled_at IS NOT NULL) OR (state = 'DELETED' AND cancelled_at IS NOT NULL)
  ),
  ADD CONSTRAINT dataset_revisions_rejected_binding CHECK (
    (state = 'REJECTED') = (rejected_at IS NOT NULL) OR (state IN ('EXPIRED', 'DELETED') AND rejected_at IS NOT NULL)
  ),
  ADD CONSTRAINT dataset_revisions_expired_binding CHECK (
    (state = 'EXPIRED') = (expired_at IS NOT NULL) OR (state = 'DELETED' AND expired_at IS NOT NULL)
  ),
  ADD CONSTRAINT dataset_revisions_deleted_binding CHECK ((state = 'DELETED') = (deleted_at IS NOT NULL)),
  ADD CONSTRAINT dataset_revisions_closed_reason CHECK (state NOT IN ('CANCELLED', 'REJECTED', 'EXPIRED') OR terminal_reason IS NOT NULL),
  ADD CONSTRAINT dataset_revisions_no_self_lineage CHECK (
    supersedes_revision_id IS DISTINCT FROM revision_id AND superseded_by_revision_id IS DISTINCT FROM revision_id
  ),
  ADD CONSTRAINT dataset_revisions_created_by_fk
    FOREIGN KEY (agency_id, created_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id);

-- binding targets for composite foreign keys that must name a revision of one project (uploads, files, seals, retention), and the
-- lineage pair (a successor names its predecessor; the predecessor names that same successor)
ALTER TABLE kauro.dataset_revisions ADD CONSTRAINT dataset_revisions_project_scope UNIQUE (agency_id, project_id, revision_id);
ALTER TABLE kauro.dataset_revisions ADD CONSTRAINT dataset_revisions_lineage_pair UNIQUE (agency_id, revision_id, supersedes_revision_id);
-- D-REV-1: a predecessor is a revision of the same project (B06 bound it to the agency only)
ALTER TABLE kauro.dataset_revisions ADD CONSTRAINT dataset_revisions_lineage_in_project
  FOREIGN KEY (agency_id, project_id, supersedes_revision_id) REFERENCES kauro.dataset_revisions (agency_id, project_id, revision_id);
-- D-REV-1: the revision that replaced this one names it as its predecessor (checked at commit: the successor is inserted in the
-- transaction that supersedes or cancels the predecessor, CMD012)
ALTER TABLE kauro.dataset_revisions ADD CONSTRAINT dataset_revisions_successor_fk
  FOREIGN KEY (agency_id, superseded_by_revision_id, revision_id) REFERENCES kauro.dataset_revisions (agency_id, revision_id, supersedes_revision_id)
  DEFERRABLE INITIALLY DEFERRED;
-- D-REV-2: a project has at most one mutable revision; two racing CreateRevision calls cannot both leave a mutable successor
CREATE UNIQUE INDEX dataset_revisions_one_mutable_per_project ON kauro.dataset_revisions (agency_id, project_id)
  WHERE state IN ('DRAFT', 'UPLOADING', 'INSPECTING', 'READY_TO_SEAL');
-- D-REV-1: a predecessor is superseded or replaced by exactly one successor
CREATE UNIQUE INDEX dataset_revisions_supersedes_once ON kauro.dataset_revisions (agency_id, supersedes_revision_id)
  WHERE supersedes_revision_id IS NOT NULL;
CREATE INDEX dataset_revisions_by_state ON kauro.dataset_revisions (state, agency_id);

-- D-REV-1: the project's current revision belongs to that project (B06 bound it to the agency only)
ALTER TABLE kauro.projects ADD CONSTRAINT projects_current_revision_in_project_fk
  FOREIGN KEY (agency_id, project_id, current_revision_id) REFERENCES kauro.dataset_revisions (agency_id, project_id, revision_id)
  DEFERRABLE INITIALLY DEFERRED;

-- --- object registry (09 "Storage zones and object registry"; the deletion inventory of B07) --------------------------------------
-- One row per registered object generation or intent (an INTENDED row has no generation yet: the name is reserved before the
-- provider write, so no platform write ever produces an unregistered object). Rows are never deleted: DELETED keeps the
-- generation, the result, the time and any provider residual as the absence evidence a DeletionReceipt enumerates (09 "Deletion
-- receipts and restoration"). A late or orphan object found by a stat or by inventory is registered INTENDED and observed in the
-- same transaction (every row is born in the machine's initial state, B06 D-INIT-1).
CREATE TABLE kauro.stored_objects (
  object_id                uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(object_id)),
  agency_id                uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id               uuid NOT NULL,
  revision_id              uuid,
  upload_id                uuid,
  file_id                  uuid,
  zone                     text NOT NULL CHECK (zone IN ('QUARANTINE', 'ACCEPTED', 'PROFILE', 'MINIMIZED', 'STAGING', 'DELIVERY', 'IMPORT_RECEIPT', 'LEGAL_FINANCE', 'SECURITY')),
  -- raw customer bytes, data derived from them, or residual (late, orphan or lawful-hold) objects (G-UPLOAD evidence rule:
  -- "Enumerate raw/derived/residual classes")
  data_class               text NOT NULL CHECK (data_class IN ('RAW', 'DERIVED', 'RESIDUAL')),
  provider                 text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  -- registry key of the storage location (e.g. QUARANTINE_PRIMARY); never a bucket name or URI (FileManifest.storageRef)
  location_ref             text NOT NULL CHECK (location_ref ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  object_name              text NOT NULL CHECK (kauro.is_object_name(object_name)),
  generation               text CHECK (generation IS NULL OR kauro.is_generation(generation)),
  bytes                    bigint CHECK (bytes IS NULL OR bytes >= 0),
  sha256                   text CHECK (sha256 IS NULL OR kauro.is_sha256_hex(sha256)),
  state                    text NOT NULL DEFAULT 'INTENDED' CHECK (state IN ('INTENDED', 'PRESENT', 'VERIFIED', 'DELETION_REQUESTED', 'DELETED', 'DELETION_FAILED')),
  -- an object observed after its upload lost application acceptance (09: remains quarantined and is deleted)
  late                     boolean NOT NULL DEFAULT false,
  created_by_kind          text NOT NULL CHECK (created_by_kind IN ('MEMBERSHIP', 'SERVICE')),
  created_by_ref           text NOT NULL,
  observed_at              timestamptz,
  verified_at              timestamptz,
  deletion_requested_at    timestamptz,
  deletion_reason          text CHECK (deletion_reason IS NULL OR kauro.is_token(deletion_reason)),
  deleted_at               timestamptz,
  deletion_result          text CHECK (deletion_result IS NULL OR deletion_result IN ('DELETED', 'ALREADY_ABSENT', 'PRECONDITION_FAILED', 'PROVIDER_ERROR')),
  deletion_attempts        integer NOT NULL DEFAULT 0 CHECK (deletion_attempts >= 0),
  -- the provider keeps a deleted generation until this instant (09 "Soft delete, versioning and holds": record the actual expiry
  -- rather than claiming the object vanished; D-OBJ-2); NULL when the location retains no deleted generation
  provider_residual_until  timestamptz,
  -- where that instant comes from: the location's retention read-back applied to this deletion (LOCATION_POLICY), or the expiry
  -- the provider itself reported for a generation it already held soft-deleted, found by inventory (PROVIDER_REPORTED)
  provider_residual_basis  text CHECK (provider_residual_basis IS NULL OR provider_residual_basis IN ('LOCATION_POLICY', 'PROVIDER_REPORTED')),
  created_at               timestamptz NOT NULL,
  updated_at               timestamptz NOT NULL,
  UNIQUE (agency_id, object_id),
  -- binding target: an admitted file names exactly one accepted generation of one registered object
  UNIQUE (agency_id, object_id, generation),
  FOREIGN KEY (agency_id, project_id) REFERENCES kauro.projects (agency_id, project_id),
  FOREIGN KEY (agency_id, project_id, revision_id) REFERENCES kauro.dataset_revisions (agency_id, project_id, revision_id),
  -- the name embeds the zone and the owning agency: a row can never describe another tenant's prefix
  CONSTRAINT stored_objects_name_scope CHECK (
    split_part(object_name, '/', 1) = lower(replace(zone, '_', '-')) AND split_part(object_name, '/', 2) = agency_id::text
  ),
  CONSTRAINT stored_objects_creator_shape CHECK (
    (created_by_kind = 'MEMBERSHIP' AND created_by_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    OR (created_by_kind = 'SERVICE' AND created_by_ref ~ '^[a-z][a-z0-9_-]{1,63}$')
  ),
  CONSTRAINT stored_objects_present_observed CHECK (
    state IN ('INTENDED', 'DELETION_REQUESTED', 'DELETED', 'DELETION_FAILED') OR (generation IS NOT NULL AND bytes IS NOT NULL AND observed_at IS NOT NULL)
  ),
  CONSTRAINT stored_objects_verified_hash CHECK (state <> 'VERIFIED' OR (sha256 IS NOT NULL AND verified_at IS NOT NULL)),
  CONSTRAINT stored_objects_deletion_requested CHECK (state NOT IN ('DELETION_REQUESTED', 'DELETED', 'DELETION_FAILED') OR (deletion_requested_at IS NOT NULL AND deletion_reason IS NOT NULL)),
  CONSTRAINT stored_objects_deleted_binding CHECK ((state = 'DELETED') = (deleted_at IS NOT NULL)),
  -- (a CHECK passes on NULL: a missing result must be refused explicitly)
  CONSTRAINT stored_objects_deleted_result CHECK (state <> 'DELETED' OR (deletion_result IS NOT NULL AND deletion_result IN ('DELETED', 'ALREADY_ABSENT'))),
  CONSTRAINT stored_objects_failed_result CHECK (state <> 'DELETION_FAILED' OR (deletion_result IS NOT NULL AND deletion_result IN ('PRECONDITION_FAILED', 'PROVIDER_ERROR'))),
  CONSTRAINT stored_objects_residual_after_deletion CHECK (provider_residual_until IS NULL OR (state = 'DELETED' AND provider_residual_until > deleted_at)),
  CONSTRAINT stored_objects_residual_basis CHECK ((provider_residual_basis IS NOT NULL) = (state = 'DELETED')),
  CONSTRAINT stored_objects_late_is_residual CHECK (NOT late OR data_class = 'RESIDUAL')
);
-- a provider generation is registered once; one open intent per object name
CREATE UNIQUE INDEX stored_objects_provider_generation ON kauro.stored_objects (provider, location_ref, object_name, generation) WHERE generation IS NOT NULL;
CREATE UNIQUE INDEX stored_objects_one_intent_per_name ON kauro.stored_objects (provider, location_ref, object_name) WHERE generation IS NULL AND state = 'INTENDED';
CREATE INDEX stored_objects_by_revision ON kauro.stored_objects (agency_id, revision_id, zone);
CREATE INDEX stored_objects_by_upload ON kauro.stored_objects (agency_id, upload_id) WHERE upload_id IS NOT NULL;
CREATE INDEX stored_objects_pending_deletion ON kauro.stored_objects (deletion_requested_at) WHERE state IN ('DELETION_REQUESTED', 'DELETION_FAILED');
CREATE INDEX stored_objects_inventory ON kauro.stored_objects (provider, location_ref, object_name);
CREATE TRIGGER stored_objects_touch BEFORE UPDATE ON kauro.stored_objects FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER stored_objects_immutable BEFORE UPDATE ON kauro.stored_objects
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('object_id,agency_id,project_id,revision_id,upload_id,file_id,zone,provider,location_ref,object_name,created_by_kind,created_by_ref,created_at');
CREATE TRIGGER stored_objects_transition BEFORE UPDATE OF state ON kauro.stored_objects
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('StoredObject');
CREATE TRIGGER stored_objects_initial_state BEFORE INSERT ON kauro.stored_objects
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('StoredObject');

-- observed facts are set once: a generation, its byte count and its hash never change (a new generation is a new row);
-- classification only moves toward residual (a late object never becomes raw input again)
CREATE OR REPLACE FUNCTION kauro.stored_objects_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF (OLD.generation IS NOT NULL AND NEW.generation IS DISTINCT FROM OLD.generation)
     OR (OLD.bytes IS NOT NULL AND NEW.bytes IS DISTINCT FROM OLD.bytes)
     OR (OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256) THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: stored object % observed facts are set once', OLD.object_id USING ERRCODE = 'KA004';
  END IF;
  IF OLD.late AND NOT NEW.late THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: stored object % cannot stop being late', OLD.object_id USING ERRCODE = 'KA004';
  END IF;
  IF NEW.data_class IS DISTINCT FROM OLD.data_class AND NEW.data_class <> 'RESIDUAL' THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: stored object % may only be reclassified as RESIDUAL', OLD.object_id USING ERRCODE = 'KA004';
  END IF;
  IF NEW.deletion_attempts < OLD.deletion_attempts THEN
    RAISE EXCEPTION 'FENCE_DISCIPLINE: stored object % deletion attempts cannot decrease', OLD.object_id USING ERRCODE = 'KA071';
  END IF;
  IF OLD.state = 'DELETED' AND (NEW.provider_residual_until IS DISTINCT FROM OLD.provider_residual_until OR NEW.provider_residual_basis IS DISTINCT FROM OLD.provider_residual_basis) THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: stored object % residual expiry is recorded once', OLD.object_id USING ERRCODE = 'KA004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER stored_objects_guard BEFORE UPDATE ON kauro.stored_objects FOR EACH ROW EXECUTE FUNCTION kauro.stored_objects_guard();

-- D-OBJ-2: a deletion records the provider residual (09 "Soft delete, versioning and holds": the effective setting is verified
-- after provisioning, and the actual residual expiry is recorded instead of claiming the object vanished). A location whose
-- setting was never read back cannot record a deletion at all. A deletion the platform performs (LOCATION_POLICY) records exactly
-- the retention of the location's latest read-back at or before the deletion, counted from the deletion (an upper bound when the
-- provider already reported the generation absent); a generation inventory found already soft-deleted (PROVIDER_REPORTED) records
-- the expiry the provider reported for it, which a later policy change does not shorten.
CREATE OR REPLACE FUNCTION kauro.stored_objects_residual_recorded() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  retention_seconds bigint;
BEGIN
  SELECT p.soft_delete_retention_seconds INTO retention_seconds FROM kauro.storage_location_policies p
   WHERE p.provider = NEW.provider AND p.location_ref = NEW.location_ref AND p.observed_at <= NEW.deleted_at
   ORDER BY p.observed_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: no retention read-back of % % precedes the deletion of object %', NEW.provider, NEW.location_ref, NEW.object_id USING ERRCODE = 'KA072';
  END IF;
  IF NEW.provider_residual_basis = 'PROVIDER_REPORTED' THEN
    IF NEW.provider_residual_until IS NULL THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: object % names a provider-reported residual without its expiry', NEW.object_id USING ERRCODE = 'KA072';
    END IF;
  ELSIF NEW.provider_residual_until IS DISTINCT FROM (CASE WHEN retention_seconds = 0 THEN NULL ELSE NEW.deleted_at + make_interval(secs => retention_seconds) END) THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: object % must record the provider residual its location read-back implies', NEW.object_id USING ERRCODE = 'KA072';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER stored_objects_residual_recorded BEFORE UPDATE ON kauro.stored_objects
  FOR EACH ROW WHEN (NEW.state = 'DELETED' AND OLD.state IS DISTINCT FROM 'DELETED') EXECUTE FUNCTION kauro.stored_objects_residual_recorded();

-- D-OBJ-1: StoredObject platform machine (no registry machine exists; the registry is the deletion inventory's lifecycle)
INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('StoredObject', 'INTENDED');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('StoredObject', 'INTENDED', 'PRESENT'),
  ('StoredObject', 'PRESENT', 'VERIFIED'),
  ('StoredObject', 'INTENDED', 'DELETION_REQUESTED'),
  ('StoredObject', 'PRESENT', 'DELETION_REQUESTED'),
  ('StoredObject', 'VERIFIED', 'DELETION_REQUESTED'),
  ('StoredObject', 'DELETION_REQUESTED', 'DELETED'),
  ('StoredObject', 'DELETION_REQUESTED', 'DELETION_FAILED'),
  ('StoredObject', 'DELETION_FAILED', 'DELETION_REQUESTED');

-- --- provider retention read-back (09 "Soft delete, versioning and holds"; decision D-OBJ-2) -----------------------------------
-- What the storage adapter read back from a location: the effective soft-delete retention and object versioning. Written by the
-- control plane (never a request handler), append-only; the deletion pipeline records each deleted generation's residual expiry
-- from the latest observation of its location, so a deletion inventory states the provider residual instead of claiming erasure.
-- No tenant data: a location is a registry key, not a bucket name.
CREATE TABLE kauro.storage_location_policies (
  observation_id                 uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(observation_id)),
  provider                       text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  location_ref                   text NOT NULL CHECK (location_ref ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  soft_delete_retention_seconds  bigint NOT NULL CHECK (soft_delete_retention_seconds BETWEEN 0 AND 7776000),
  object_versioning              boolean NOT NULL,
  -- SHA-256 of the adapter's raw read-back (evidence; the raw document stays with the adapter's evidence store)
  evidence_hash                  text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  evidence_class                 text NOT NULL CHECK (evidence_class IN ('EXECUTED_PROVIDER', 'SIMULATED')),
  observed_at                    timestamptz NOT NULL,
  UNIQUE (provider, location_ref, observed_at)
);
CREATE TRIGGER storage_location_policies_append_only BEFORE UPDATE OR DELETE ON kauro.storage_location_policies
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- quota ledgers (R2-052; 09 "Upload reservation") ---------------------------------------------------------------------------
-- Operational ledgers, not aggregates: maintained only by the upload_sessions trigger below; the row lock their UPDATE takes is
-- the serialization point of concurrent reservations, and the CHECK refuses the combination beyond the envelope (decision D-UP-2).
CREATE TABLE kauro.revision_quota (
  revision_id     uuid PRIMARY KEY,
  agency_id       uuid NOT NULL,
  reserved_bytes  bigint NOT NULL DEFAULT 0,
  file_count      integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL,
  UNIQUE (agency_id, revision_id),
  FOREIGN KEY (agency_id, revision_id) REFERENCES kauro.dataset_revisions (agency_id, revision_id),
  -- policy input.revisionBytes and input.files (09 "Initial intake envelope")
  CONSTRAINT revision_quota_bytes_within_envelope CHECK (reserved_bytes BETWEEN 0 AND 5000000000),
  CONSTRAINT revision_quota_files_within_envelope CHECK (file_count BETWEEN 0 AND 50)
);

CREATE TABLE kauro.upload_capacity (
  agency_id        uuid PRIMARY KEY REFERENCES kauro.agencies (agency_id),
  active_sessions  integer NOT NULL DEFAULT 0,
  -- policy capacity.agencyUploads (09: the initial concurrent limit is two sessions per agency); changed by operations only
  session_limit    integer NOT NULL DEFAULT 2 CHECK (session_limit BETWEEN 1 AND 64),
  updated_at       timestamptz NOT NULL,
  CONSTRAINT upload_capacity_within_limit CHECK (active_sessions BETWEEN 0 AND session_limit)
);

-- --- upload sessions (registry contract UploadSession; platform machine UploadSession, D-UP-1) -------------------------------------
CREATE TABLE kauro.upload_sessions (
  upload_id                    uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(upload_id)),
  agency_id                    uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id                   uuid NOT NULL,
  revision_id                  uuid NOT NULL,
  version                      bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                        text NOT NULL DEFAULT 'RESERVED' CHECK (state IN ('RESERVED', 'UPLOADING', 'VERIFYING', 'ADMITTED', 'CANCELLED', 'EXPIRED', 'REJECTED')),
  -- untrusted display filename (09: display metadata only; never part of a storage path, an event or a log)
  display_name                 text NOT NULL CONSTRAINT upload_sessions_display_name_label CHECK (kauro.is_label(display_name)),
  declared_format              text NOT NULL CHECK (declared_format IN ('CSV', 'XLSX')),
  -- the atomic quota reservation (UploadSession.reservedBytes); per-file envelope input.fileBytes
  reserved_bytes               bigint NOT NULL CHECK (reserved_bytes BETWEEN 1 AND 2000000000),
  quarantine_object_id         uuid NOT NULL,
  requested_by_membership_id   uuid NOT NULL,
  requested_by_user_id         uuid NOT NULL REFERENCES kauro.identities (user_id),
  -- UploadSession.applicationExpiresAt: twenty-four hours from initiation, never extended
  application_expires_at       timestamptz NOT NULL,
  -- fence of provider-session issuance (the two-phase command, D-RUN-2); not a business version
  session_attempt              integer NOT NULL DEFAULT 0 CHECK (session_attempt >= 0),
  session_issued_at            timestamptz,
  -- SHA-256 of the provider session reference: correlation without the bearer value (09: never in DTOs or logs)
  provider_session_digest      text CHECK (provider_session_digest IS NULL OR kauro.is_sha256_hex(provider_session_digest)),
  -- the provider-side usability horizon of the session (09: a resumable session URI can remain usable up to a week)
  provider_session_expires_at  timestamptz,
  provider_cancellation_state  text NOT NULL DEFAULT 'NOT_REQUESTED' CHECK (provider_cancellation_state IN ('NOT_REQUESTED', 'REQUESTED', 'CONFIRMED', 'UNSUPPORTED', 'UNCERTAIN')),
  provider_cancellation_at     timestamptz,
  completion_reported_at       timestamptz,
  -- the browser's completion report is a claim (09: never substitutes for the server's observation)
  completion_claim_digest      text CHECK (completion_claim_digest IS NULL OR kauro.is_sha256_hex(completion_claim_digest)),
  claimed_generation           text CHECK (claimed_generation IS NULL OR kauro.is_generation(claimed_generation)),
  claimed_bytes                bigint CHECK (claimed_bytes IS NULL OR claimed_bytes >= 0),
  claimed_crc32c               text CHECK (claimed_crc32c IS NULL OR claimed_crc32c ~ '^[A-Za-z0-9+/]{6}==$'),
  claimed_md5                  text CHECK (claimed_md5 IS NULL OR claimed_md5 ~ '^[A-Za-z0-9+/]{22}==$'),
  completion_observed_at       timestamptz,
  observed_generation          text CHECK (observed_generation IS NULL OR kauro.is_generation(observed_generation)),
  observed_bytes               bigint CHECK (observed_bytes IS NULL OR observed_bytes >= 0),
  -- fence of the inspection attempt (a stale worker's result is refused, D-INSP-2); not a business version
  inspection_fence             integer NOT NULL DEFAULT 0 CHECK (inspection_fence >= 0),
  inspection_receipt_hash      text CHECK (inspection_receipt_hash IS NULL OR kauro.is_sha256_hex(inspection_receipt_hash)),
  file_id                      uuid,
  terminal_reason              text CHECK (terminal_reason IS NULL OR kauro.is_token(terminal_reason)),
  cancelled_by_membership_id   uuid,
  admitted_at                  timestamptz,
  rejected_at                  timestamptz,
  cancelled_at                 timestamptz,
  expired_at                   timestamptz,
  created_at                   timestamptz NOT NULL,
  updated_at                   timestamptz NOT NULL,
  UNIQUE (agency_id, upload_id),
  UNIQUE (agency_id, revision_id, upload_id),
  -- binding target of the session secret: the secret belongs to the requester of this upload
  UNIQUE (agency_id, upload_id, requested_by_user_id),
  FOREIGN KEY (agency_id, project_id, revision_id) REFERENCES kauro.dataset_revisions (agency_id, project_id, revision_id),
  FOREIGN KEY (agency_id, quarantine_object_id) REFERENCES kauro.stored_objects (agency_id, object_id),
  FOREIGN KEY (agency_id, requested_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id),
  FOREIGN KEY (agency_id, cancelled_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id),
  CONSTRAINT upload_sessions_deadline_policy CHECK (
    application_expires_at > created_at AND application_expires_at <= created_at + interval '86400 seconds'
  ),
  CONSTRAINT upload_sessions_issued_binding CHECK (
    state IN ('RESERVED', 'CANCELLED', 'EXPIRED') OR (session_issued_at IS NOT NULL AND provider_session_digest IS NOT NULL AND provider_session_expires_at IS NOT NULL)
  ),
  CONSTRAINT upload_sessions_issued_complete CHECK (
    (session_issued_at IS NULL) = (provider_session_digest IS NULL) AND (session_issued_at IS NULL) = (provider_session_expires_at IS NULL)
  ),
  CONSTRAINT upload_sessions_completion_binding CHECK (
    state NOT IN ('VERIFYING', 'ADMITTED', 'REJECTED') OR (completion_reported_at IS NOT NULL AND completion_claim_digest IS NOT NULL)
  ),
  CONSTRAINT upload_sessions_observation_complete CHECK (
    (completion_observed_at IS NULL) = (observed_generation IS NULL) AND (completion_observed_at IS NULL) = (observed_bytes IS NULL)
  ),
  CONSTRAINT upload_sessions_admitted_binding CHECK (
    state <> 'ADMITTED' OR (
      admitted_at IS NOT NULL AND file_id IS NOT NULL AND completion_observed_at IS NOT NULL
      AND observed_bytes BETWEEN 1 AND reserved_bytes AND inspection_receipt_hash IS NOT NULL
    )
  ),
  CONSTRAINT upload_sessions_rejected_binding CHECK ((state = 'REJECTED') = (rejected_at IS NOT NULL) AND (state <> 'REJECTED' OR (terminal_reason IS NOT NULL AND inspection_receipt_hash IS NOT NULL))),
  CONSTRAINT upload_sessions_cancelled_binding CHECK ((state = 'CANCELLED') = (cancelled_at IS NOT NULL) AND (state <> 'CANCELLED' OR terminal_reason IS NOT NULL)),
  CONSTRAINT upload_sessions_expired_binding CHECK ((state = 'EXPIRED') = (expired_at IS NOT NULL) AND (state <> 'EXPIRED' OR terminal_reason IS NOT NULL)),
  -- the reservation expires twenty-four hours from initiation (09 "Upload reservation"): never before its deadline
  CONSTRAINT upload_sessions_expiry_not_early CHECK (expired_at IS NULL OR expired_at >= application_expires_at),
  -- an expired admitted upload keeps the file it admitted (its admission is revoked on the file, never erased here)
  CONSTRAINT upload_sessions_file_only_when_admitted CHECK (file_id IS NULL OR state IN ('ADMITTED', 'EXPIRED')),
  -- provider cancellation is requested only once application acceptance is tombstoned or verification took over the session
  CONSTRAINT upload_sessions_cancellation_after_tombstone CHECK (
    provider_cancellation_state = 'NOT_REQUESTED' OR state IN ('CANCELLED', 'EXPIRED', 'REJECTED', 'VERIFYING', 'ADMITTED')
  ),
  CONSTRAINT upload_sessions_cancellation_recorded CHECK ((provider_cancellation_state = 'NOT_REQUESTED') = (provider_cancellation_at IS NULL))
);
CREATE INDEX upload_sessions_by_revision ON kauro.upload_sessions (agency_id, revision_id, created_at, upload_id);
CREATE INDEX upload_sessions_live_by_agency ON kauro.upload_sessions (agency_id) WHERE state IN ('RESERVED', 'UPLOADING', 'VERIFYING');
CREATE INDEX upload_sessions_deadline ON kauro.upload_sessions (application_expires_at) WHERE state IN ('RESERVED', 'UPLOADING', 'VERIFYING', 'ADMITTED');
CREATE INDEX upload_sessions_provider_reconciliation ON kauro.upload_sessions (provider_session_expires_at)
  WHERE provider_cancellation_state IN ('REQUESTED', 'UNCERTAIN');

CREATE TRIGGER upload_sessions_touch BEFORE UPDATE ON kauro.upload_sessions FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER upload_sessions_version BEFORE UPDATE ON kauro.upload_sessions
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump('session_attempt,inspection_fence');
CREATE TRIGGER upload_sessions_immutable BEFORE UPDATE ON kauro.upload_sessions
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('upload_id,agency_id,project_id,revision_id,display_name,declared_format,reserved_bytes,quarantine_object_id,requested_by_membership_id,requested_by_user_id,application_expires_at,created_at');
CREATE TRIGGER upload_sessions_transition BEFORE UPDATE OF state ON kauro.upload_sessions
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('UploadSession');
CREATE TRIGGER upload_sessions_initial_state BEFORE INSERT ON kauro.upload_sessions
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('UploadSession');
CREATE CONSTRAINT TRIGGER upload_sessions_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.upload_sessions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('upload_session', 'upload_id');

-- A reservation enters only a revision that accepts uploads (registry: DRAFT permits adding upload sessions; UPLOADING means
-- sessions are in progress; nothing enters INSPECTING, READY_TO_SEAL or a sealed or terminal revision — "adding a file after
-- sealing creates a new revision"). The reservation reads the revision under the revision's row lock (FOR NO KEY UPDATE, held to
-- COMMIT; decision D-LOCK-1). Every transition of the revision is an UPDATE of that row, which takes the row lock before its
-- triggers take the transition lock (B06 D-TX-2) and read their facts, so a transition in flight makes the reservation wait and
-- read its result, and a reservation in flight makes the transition wait and then see the reservation. (A shared transition lock
-- taken here instead would deadlock against a transition that already holds the row and waits for the exclusive lock.)
CREATE OR REPLACE FUNCTION kauro.upload_sessions_revision_accepts_uploads() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  revision_state text;
BEGIN
  SELECT state INTO revision_state FROM kauro.dataset_revisions
   WHERE agency_id = NEW.agency_id AND project_id = NEW.project_id AND revision_id = NEW.revision_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTEXT: revision % is not visible in this transaction', NEW.revision_id USING ERRCODE = 'KA006';
  END IF;
  IF revision_state NOT IN ('DRAFT', 'UPLOADING') THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: revision % is % and accepts no upload', NEW.revision_id, revision_state USING ERRCODE = 'KA072';
  END IF;
  IF NEW.version <> 1 THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: an upload is born at version 1' USING ERRCODE = 'KA072';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER upload_sessions_revision_accepts_uploads BEFORE INSERT ON kauro.upload_sessions
  FOR EACH ROW EXECUTE FUNCTION kauro.upload_sessions_revision_accepts_uploads();

-- Fences never move backwards; observed facts are set once; the provider cancellation result moves forward only
-- (NOT_REQUESTED -> REQUESTED -> CONFIRMED | UNSUPPORTED | UNCERTAIN; UNCERTAIN is re-checked until it resolves).
CREATE OR REPLACE FUNCTION kauro.upload_sessions_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.session_attempt < OLD.session_attempt OR NEW.inspection_fence < OLD.inspection_fence THEN
    RAISE EXCEPTION 'FENCE_DISCIPLINE: upload % fence moved backwards', OLD.upload_id USING ERRCODE = 'KA071';
  END IF;
  -- a session is issued only by the attempt that holds the issuance fence, while the reservation is RESERVED (D-RUN-2)
  IF NEW.session_attempt > OLD.session_attempt AND OLD.state <> 'RESERVED' THEN
    RAISE EXCEPTION 'FENCE_DISCIPLINE: upload % is % and issues no provider session', OLD.upload_id, OLD.state USING ERRCODE = 'KA071';
  END IF;
  -- an inspection attempt is claimed only while the upload is being verified (D-INSP-2)
  IF NEW.inspection_fence > OLD.inspection_fence AND OLD.state <> 'VERIFYING' THEN
    RAISE EXCEPTION 'FENCE_DISCIPLINE: upload % is % and claims no inspection attempt', OLD.upload_id, OLD.state USING ERRCODE = 'KA071';
  END IF;
  IF (OLD.observed_generation IS NOT NULL AND NEW.observed_generation IS DISTINCT FROM OLD.observed_generation)
     OR (OLD.observed_bytes IS NOT NULL AND NEW.observed_bytes IS DISTINCT FROM OLD.observed_bytes)
     OR (OLD.completion_observed_at IS NOT NULL AND NEW.completion_observed_at IS DISTINCT FROM OLD.completion_observed_at)
     OR (OLD.inspection_receipt_hash IS NOT NULL AND NEW.inspection_receipt_hash IS DISTINCT FROM OLD.inspection_receipt_hash)
     OR (OLD.file_id IS NOT NULL AND NEW.file_id IS DISTINCT FROM OLD.file_id)
     OR (OLD.session_issued_at IS NOT NULL AND NEW.session_issued_at IS DISTINCT FROM OLD.session_issued_at)
     OR (OLD.provider_session_digest IS NOT NULL AND NEW.provider_session_digest IS DISTINCT FROM OLD.provider_session_digest) THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: upload % observed facts are set once', OLD.upload_id USING ERRCODE = 'KA004';
  END IF;
  -- a completion claim is recorded only by the completion report itself (UPLOADING -> VERIFYING), and a claim the provider did
  -- not honour is cleared with the observation that says so (VERIFYING -> UPLOADING, completion_not_observed)
  IF (NEW.completion_claim_digest IS DISTINCT FROM OLD.completion_claim_digest
      OR NEW.claimed_generation IS DISTINCT FROM OLD.claimed_generation
      OR NEW.claimed_bytes IS DISTINCT FROM OLD.claimed_bytes
      OR NEW.claimed_crc32c IS DISTINCT FROM OLD.claimed_crc32c
      OR NEW.claimed_md5 IS DISTINCT FROM OLD.claimed_md5
      OR NEW.completion_reported_at IS DISTINCT FROM OLD.completion_reported_at)
     AND NOT (OLD.state = 'UPLOADING' AND NEW.state = 'VERIFYING')
     AND NOT (OLD.state = 'VERIFYING' AND NEW.state = 'UPLOADING' AND NEW.completion_claim_digest IS NULL AND NEW.completion_reported_at IS NULL) THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: upload % completion claim changes only with a completion report', OLD.upload_id USING ERRCODE = 'KA004';
  END IF;
  IF NEW.provider_cancellation_state IS DISTINCT FROM OLD.provider_cancellation_state AND NOT (
       (OLD.provider_cancellation_state = 'NOT_REQUESTED' AND NEW.provider_cancellation_state = 'REQUESTED')
    OR (OLD.provider_cancellation_state = 'REQUESTED' AND NEW.provider_cancellation_state IN ('CONFIRMED', 'UNSUPPORTED', 'UNCERTAIN'))
    OR (OLD.provider_cancellation_state = 'UNCERTAIN' AND NEW.provider_cancellation_state IN ('CONFIRMED', 'UNSUPPORTED'))
  ) THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: provider cancellation % -> % is not a forward move', OLD.provider_cancellation_state, NEW.provider_cancellation_state USING ERRCODE = 'KA008';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER upload_sessions_guard BEFORE UPDATE ON kauro.upload_sessions FOR EACH ROW EXECUTE FUNCTION kauro.upload_sessions_guard();

-- Bytes an upload holds against its revision's envelope: the reservation while in flight, the observed bytes once admitted,
-- nothing once acceptance is tombstoned (CANCELLED, EXPIRED, REJECTED) — which is why freed quota cannot be consumed twice.
CREATE OR REPLACE FUNCTION kauro.upload_held_bytes(p_state text, p_reserved bigint, p_observed bigint) RETURNS bigint
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT CASE WHEN p_state IN ('RESERVED', 'UPLOADING', 'VERIFYING') THEN p_reserved WHEN p_state = 'ADMITTED' THEN p_observed ELSE 0 END $$;

CREATE OR REPLACE FUNCTION kauro.upload_holds_file(p_state text) RETURNS integer
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT CASE WHEN p_state IN ('RESERVED', 'UPLOADING', 'VERIFYING', 'ADMITTED') THEN 1 ELSE 0 END $$;

CREATE OR REPLACE FUNCTION kauro.upload_holds_slot(p_state text) RETURNS integer
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT CASE WHEN p_state IN ('RESERVED', 'UPLOADING', 'VERIFYING') THEN 1 ELSE 0 END $$;

-- Applies the delta of every upload state change to the revision ledger and the agency capacity row. The ledger row is created
-- empty when missing (a concurrent creator waits on the unique index and then finds it), then the delta is an UPDATE that takes
-- the row lock: two reservations that each fit alone serialize here, and the second re-reads the committed total and fails the
-- CHECK when the combination exceeds the envelope (R2-052). (A negative delta is never an INSERT value: CHECK constraints judge
-- the proposed row of an INSERT ... ON CONFLICT before the conflict is resolved.)
CREATE OR REPLACE FUNCTION kauro.upload_sessions_quota() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  old_bytes bigint := 0;
  old_file  integer := 0;
  old_slot  integer := 0;
  new_bytes bigint := kauro.upload_held_bytes(NEW.state, NEW.reserved_bytes, NEW.observed_bytes);
  new_file  integer := kauro.upload_holds_file(NEW.state);
  new_slot  integer := kauro.upload_holds_slot(NEW.state);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_bytes := kauro.upload_held_bytes(OLD.state, OLD.reserved_bytes, OLD.observed_bytes);
    old_file := kauro.upload_holds_file(OLD.state);
    old_slot := kauro.upload_holds_slot(OLD.state);
  END IF;
  IF new_bytes <> old_bytes OR new_file <> old_file THEN
    INSERT INTO kauro.revision_quota (revision_id, agency_id, reserved_bytes, file_count, updated_at)
    VALUES (NEW.revision_id, NEW.agency_id, 0, 0, now())
    ON CONFLICT (revision_id) DO NOTHING;
    UPDATE kauro.revision_quota
       SET reserved_bytes = reserved_bytes + (new_bytes - old_bytes), file_count = file_count + (new_file - old_file), updated_at = now()
     WHERE revision_id = NEW.revision_id AND agency_id = NEW.agency_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'QUOTA_LEDGER: revision % ledger is not visible in this transaction', NEW.revision_id USING ERRCODE = 'KA070';
    END IF;
  END IF;
  IF new_slot <> old_slot THEN
    INSERT INTO kauro.upload_capacity (agency_id, active_sessions, updated_at)
    VALUES (NEW.agency_id, 0, now())
    ON CONFLICT (agency_id) DO NOTHING;
    UPDATE kauro.upload_capacity
       SET active_sessions = active_sessions + (new_slot - old_slot), updated_at = now()
     WHERE agency_id = NEW.agency_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'QUOTA_LEDGER: agency % capacity ledger is not visible in this transaction', NEW.agency_id USING ERRCODE = 'KA070';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER upload_sessions_quota AFTER INSERT OR UPDATE OF state, observed_bytes ON kauro.upload_sessions
  FOR EACH ROW EXECUTE FUNCTION kauro.upload_sessions_quota();

-- The ledgers equal what the upload sessions hold, at commit, whoever wrote them (a direct write to a ledger row is refused too).
CREATE OR REPLACE FUNCTION kauro.check_upload_ledgers(p_agency uuid, p_revision uuid) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  expected_bytes bigint;
  expected_files integer;
  expected_slots integer;
  ledger_bytes   bigint;
  ledger_files   integer;
  ledger_slots   integer;
BEGIN
  IF p_revision IS NOT NULL THEN
    SELECT coalesce(sum(kauro.upload_held_bytes(u.state, u.reserved_bytes, u.observed_bytes)), 0), coalesce(sum(kauro.upload_holds_file(u.state)), 0)
      INTO expected_bytes, expected_files
      FROM kauro.upload_sessions u WHERE u.agency_id = p_agency AND u.revision_id = p_revision;
    SELECT q.reserved_bytes, q.file_count INTO ledger_bytes, ledger_files FROM kauro.revision_quota q WHERE q.revision_id = p_revision;
    IF coalesce(ledger_bytes, 0) <> expected_bytes OR coalesce(ledger_files, 0) <> expected_files THEN
      RAISE EXCEPTION 'QUOTA_LEDGER: revision % ledger (% bytes, % files) disagrees with its uploads (% bytes, % files)',
        p_revision, coalesce(ledger_bytes, 0), coalesce(ledger_files, 0), expected_bytes, expected_files USING ERRCODE = 'KA070';
    END IF;
  END IF;
  SELECT coalesce(sum(kauro.upload_holds_slot(u.state)), 0) INTO expected_slots FROM kauro.upload_sessions u WHERE u.agency_id = p_agency;
  SELECT c.active_sessions INTO ledger_slots FROM kauro.upload_capacity c WHERE c.agency_id = p_agency;
  IF coalesce(ledger_slots, 0) <> expected_slots THEN
    RAISE EXCEPTION 'QUOTA_LEDGER: agency % capacity ledger (% sessions) disagrees with its uploads (% sessions)', p_agency, coalesce(ledger_slots, 0), expected_slots USING ERRCODE = 'KA070';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION kauro.upload_ledgers_consistent() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF TG_TABLE_NAME = 'upload_capacity' THEN
    PERFORM kauro.check_upload_ledgers(NEW.agency_id, NULL);
  ELSE
    PERFORM kauro.check_upload_ledgers(NEW.agency_id, NEW.revision_id);
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER upload_sessions_ledgers AFTER INSERT OR UPDATE OF state, observed_bytes ON kauro.upload_sessions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.upload_ledgers_consistent();
CREATE CONSTRAINT TRIGGER revision_quota_ledgers AFTER INSERT OR UPDATE ON kauro.revision_quota
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.upload_ledgers_consistent();
CREATE CONSTRAINT TRIGGER upload_capacity_ledgers AFTER INSERT OR UPDATE OF active_sessions ON kauro.upload_capacity
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.upload_ledgers_consistent();

-- D-UP-1: UploadSession platform machine (the registry contract has states but no machine)
INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('UploadSession', 'RESERVED');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('UploadSession', 'RESERVED', 'UPLOADING'),
  ('UploadSession', 'UPLOADING', 'VERIFYING'),
  ('UploadSession', 'VERIFYING', 'UPLOADING'),
  ('UploadSession', 'VERIFYING', 'ADMITTED'),
  ('UploadSession', 'VERIFYING', 'REJECTED'),
  ('UploadSession', 'RESERVED', 'CANCELLED'),
  ('UploadSession', 'UPLOADING', 'CANCELLED'),
  ('UploadSession', 'VERIFYING', 'CANCELLED'),
  ('UploadSession', 'RESERVED', 'EXPIRED'),
  ('UploadSession', 'UPLOADING', 'EXPIRED'),
  ('UploadSession', 'VERIFYING', 'EXPIRED'),
  ('UploadSession', 'ADMITTED', 'EXPIRED');

-- the registered quarantine intent names this upload (checked at commit: the intent row is written first)
ALTER TABLE kauro.stored_objects ADD CONSTRAINT stored_objects_upload_fk
  FOREIGN KEY (agency_id, upload_id) REFERENCES kauro.upload_sessions (agency_id, upload_id) DEFERRABLE INITIALLY DEFERRED;

-- --- provider session secrets (09 "Resumable session security"; D-SESSION-1) ----------------------------------------------------
-- The encrypted bearer reference, apart from the upload row so no projection of upload_sessions can ever carry it. Readable by the
-- requester only while the upload is UPLOADING and its application deadline has not passed (the protected response and its
-- replay), and by the control plane of that agency to cancel the provider session; deleted by the control plane once the provider
-- cancellation resolved or the provider lifetime ended (a temporary control record). Never updated.
CREATE TABLE kauro.upload_session_secrets (
  upload_id             uuid PRIMARY KEY,
  agency_id             uuid NOT NULL,
  requested_by_user_id  uuid NOT NULL,
  session_attempt       integer NOT NULL CHECK (session_attempt >= 1),
  -- vault key identity (name/version) — never key material
  key_ref               text NOT NULL CHECK (key_ref ~ '^[a-z][a-z0-9_.:/-]{2,127}$'),
  nonce                 bytea NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext            bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 17 AND 8192),
  created_at            timestamptz NOT NULL,
  FOREIGN KEY (agency_id, upload_id, requested_by_user_id) REFERENCES kauro.upload_sessions (agency_id, upload_id, requested_by_user_id)
);
CREATE TRIGGER upload_session_secrets_no_update BEFORE UPDATE ON kauro.upload_session_secrets
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- the control plane's own events (decision D-CTRL-2; amends B06 review R3 for the source lifecycle only) ----------------------
-- B06 kept the control plane out of the event table because it wrote no aggregate. The source lifecycle has aggregate edges no
-- request performs — a completion observed, an input admitted or rejected, a selection counted, a deadline reached (09
-- "Completion and inspection"; 07 "The sweeper repairs ... stale inspection and overdue deletion") — and a new aggregate version
-- cannot commit without its event (D-EVT-1). The control plane therefore appends exactly the events of the edges it owns, and
-- nothing else: bound to the agency of the work item (D-CTRL-1), as a service actor, of a B07 aggregate kind, one of the listed
-- event types. kauro.domain_events_bind_aggregate still requires the aggregate to be visible to the writer in that agency at or
-- above the event's version, so no tenant's next version can be occupied, and an unbound control unit of work writes nothing.
CREATE POLICY domain_events_control_source_lifecycle ON kauro.domain_events FOR INSERT TO kauro_control
  WITH CHECK (
    agency_id = kauro.current_agency_id()
    AND actor_kind = 'SERVICE'
    AND aggregate_kind IN ('upload_session', 'dataset_revision', 'retention_record')
    AND event_type IN (
      'upload_session.completion_observed.v1', 'upload_session.completion_not_observed.v1', 'upload_session.admitted.v1',
      'upload_session.rejected.v1', 'upload_session.expired.v1', 'upload_session.provider_cancellation_recorded.v1',
      'dataset_revision.inspecting.v1', 'dataset_revision.ready_to_seal.v1', 'dataset_revision.rejected.v1',
      'dataset_revision.expired.v1', 'retention_record.expired.v1'
    )
  );
GRANT INSERT ON kauro.domain_events TO kauro_control;
GRANT USAGE ON SEQUENCE kauro.domain_events_sequence_seq TO kauro_control;

-- The event binding learns the B07 aggregate kinds (every registered kind has an arm; the persistence test proves it).
CREATE OR REPLACE FUNCTION kauro.domain_events_bind_aggregate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  current_version bigint;
BEGIN
  CASE NEW.aggregate_kind
    WHEN 'agency' THEN
      SELECT a.version INTO current_version FROM kauro.agencies a WHERE a.agency_id = NEW.aggregate_id AND a.agency_id = NEW.agency_id;
    WHEN 'membership' THEN
      SELECT m.version INTO current_version FROM kauro.memberships m WHERE m.membership_id = NEW.aggregate_id AND m.agency_id = NEW.agency_id;
    WHEN 'end_client' THEN
      SELECT c.version INTO current_version FROM kauro.end_clients c WHERE c.client_id = NEW.aggregate_id AND c.agency_id = NEW.agency_id;
    WHEN 'project' THEN
      SELECT p.version INTO current_version FROM kauro.projects p WHERE p.project_id = NEW.aggregate_id AND p.agency_id = NEW.agency_id;
    WHEN 'dataset_revision' THEN
      SELECT r.version INTO current_version FROM kauro.dataset_revisions r WHERE r.revision_id = NEW.aggregate_id AND r.agency_id = NEW.agency_id;
    WHEN 'plan' THEN
      SELECT p.version INTO current_version FROM kauro.plans p WHERE p.plan_id = NEW.aggregate_id AND p.agency_id = NEW.agency_id;
    WHEN 'approval' THEN
      SELECT a.version INTO current_version FROM kauro.approvals a WHERE a.approval_id = NEW.aggregate_id AND a.agency_id = NEW.agency_id;
    WHEN 'upload_session' THEN
      SELECT u.version INTO current_version FROM kauro.upload_sessions u WHERE u.upload_id = NEW.aggregate_id AND u.agency_id = NEW.agency_id;
    WHEN 'retention_record' THEN
      -- retention_records is created by 0011; until then no row can name it (the function body is resolved at execution)
      SELECT r.version INTO current_version FROM kauro.retention_records r WHERE r.retention_id = NEW.aggregate_id AND r.agency_id = NEW.agency_id;
    ELSE
      RAISE EXCEPTION 'CONTEXT: aggregate kind % has no binding', NEW.aggregate_kind USING ERRCODE = 'KA006';
  END CASE;
  IF current_version IS NULL THEN
    RAISE EXCEPTION 'CONTEXT: % % is not an aggregate of agency % visible in this transaction', NEW.aggregate_kind, NEW.aggregate_id, NEW.agency_id USING ERRCODE = 'KA006';
  END IF;
  IF NEW.aggregate_version > current_version THEN
    RAISE EXCEPTION 'VERSION_DISCIPLINE: an event of % % records version % ahead of the aggregate (version %)', NEW.aggregate_kind, NEW.aggregate_id, NEW.aggregate_version, current_version USING ERRCODE = 'KA002';
  END IF;
  RETURN NEW;
END
$$;

-- --- row-level security --------------------------------------------------------------------------------------------------------
-- Request handlers (kauro_app) see their tenant. The control plane (kauro_control) runs SYSTEM units of work: bound to one agency
-- (kauro.agency_id set, D-CTRL-1) it may write that agency's rows; unbound it may only discover work across tenants through the
-- columns granted to it, which never include customer text (display names, sheet names, column labels).
ALTER TABLE kauro.stored_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.stored_objects FORCE ROW LEVEL SECURITY;
CREATE POLICY stored_objects_tenant_read ON kauro.stored_objects FOR SELECT TO kauro_app
  USING (agency_id = kauro.current_agency_id());
-- a request handler registers exactly one kind of object: the quarantine destination of the upload it reserves (CMD013)
CREATE POLICY stored_objects_tenant_intent ON kauro.stored_objects FOR INSERT TO kauro_app
  WITH CHECK (
    agency_id = kauro.current_agency_id() AND zone = 'QUARANTINE' AND data_class = 'RAW' AND state = 'INTENDED'
    AND generation IS NULL AND created_by_kind = 'MEMBERSHIP' AND upload_id IS NOT NULL AND file_id IS NULL
  );
CREATE POLICY stored_objects_control_read ON kauro.stored_objects FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY stored_objects_control_insert ON kauro.stored_objects FOR INSERT TO kauro_control
  WITH CHECK (agency_id = kauro.current_agency_id() AND created_by_kind = 'SERVICE');
CREATE POLICY stored_objects_control_update ON kauro.stored_objects FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.storage_location_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.storage_location_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY storage_location_policies_control ON kauro.storage_location_policies FOR ALL TO kauro_control USING (true) WITH CHECK (true);

ALTER TABLE kauro.revision_quota ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.revision_quota FORCE ROW LEVEL SECURITY;
CREATE POLICY revision_quota_tenant ON kauro.revision_quota FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY revision_quota_control ON kauro.revision_quota FOR ALL TO kauro_control
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.upload_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.upload_capacity FORCE ROW LEVEL SECURITY;
CREATE POLICY upload_capacity_tenant ON kauro.upload_capacity FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY upload_capacity_control ON kauro.upload_capacity FOR ALL TO kauro_control
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.upload_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY upload_sessions_tenant ON kauro.upload_sessions FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
-- D-ROLE-2: request handlers never enter a state whose evidence the control plane produces (an admission, a rejection, an
-- expiry): the database refuses the row, whatever the handler computed
CREATE POLICY upload_sessions_tenant_edges ON kauro.upload_sessions AS RESTRICTIVE FOR UPDATE TO kauro_app
  USING (true) WITH CHECK (state IN ('RESERVED', 'UPLOADING', 'VERIFYING', 'CANCELLED'));
CREATE POLICY upload_sessions_control_read ON kauro.upload_sessions FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY upload_sessions_control_update ON kauro.upload_sessions FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.upload_session_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.upload_session_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY upload_session_secrets_requester_insert ON kauro.upload_session_secrets FOR INSERT TO kauro_app
  WITH CHECK (agency_id = kauro.current_agency_id() AND requested_by_user_id = kauro.current_user_id());
CREATE POLICY upload_session_secrets_requester_read ON kauro.upload_session_secrets FOR SELECT TO kauro_app
  USING (
    agency_id = kauro.current_agency_id() AND requested_by_user_id = kauro.current_user_id()
    AND EXISTS (
      SELECT 1 FROM kauro.upload_sessions u
      WHERE u.agency_id = upload_session_secrets.agency_id AND u.upload_id = upload_session_secrets.upload_id
        AND u.state = 'UPLOADING' AND u.application_expires_at > now()
    )
  );
CREATE POLICY upload_session_secrets_control_read ON kauro.upload_session_secrets FOR SELECT TO kauro_control
  USING (agency_id = kauro.current_agency_id());
CREATE POLICY upload_session_secrets_control_delete ON kauro.upload_session_secrets FOR DELETE TO kauro_control
  USING (agency_id = kauro.current_agency_id());

-- dataset revisions: request handlers take the edges their commands own (CMD012, CMD013, CMD015, CMD016, CMD017); the control
-- plane advances the edges it owns (inspection, evaluation, rejection, retention expiry) in the agency it is bound to (D-ROLE-2)
CREATE POLICY dataset_revisions_tenant_edges ON kauro.dataset_revisions AS RESTRICTIVE FOR UPDATE TO kauro_app
  USING (true) WITH CHECK (state IN ('UPLOADING', 'INSPECTING', 'SEALED', 'SUPERSEDED', 'CANCELLED'));
CREATE POLICY dataset_revisions_control_read ON kauro.dataset_revisions FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY dataset_revisions_control_update ON kauro.dataset_revisions FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id())
  WITH CHECK (agency_id = kauro.current_agency_id() AND state IN ('INSPECTING', 'READY_TO_SEAL', 'REJECTED', 'EXPIRED'));

-- --- grants (still no DELETE for request handlers anywhere) ------------------------------------------------------------------------
GRANT SELECT, INSERT ON kauro.stored_objects TO kauro_app;
GRANT SELECT, INSERT, UPDATE ON kauro.stored_objects TO kauro_control;
GRANT SELECT, INSERT ON kauro.storage_location_policies TO kauro_control;
GRANT SELECT, INSERT, UPDATE ON kauro.revision_quota TO kauro_app, kauro_control;
GRANT SELECT ON kauro.upload_capacity TO kauro_app;
GRANT INSERT (agency_id, active_sessions, updated_at), UPDATE (active_sessions, updated_at) ON kauro.upload_capacity TO kauro_app;
GRANT SELECT, INSERT, UPDATE ON kauro.upload_capacity TO kauro_control;
-- request handlers write the reservation, the session issue, the completion claim and the cancellation; the provider observation,
-- the inspection fence and outcome and the deadline expiry are the control plane's evidence (B06 D-EVID-1): not even a column
-- grant lets a handler record them (D-ROLE-2)
GRANT SELECT ON kauro.upload_sessions TO kauro_app;
GRANT INSERT (
  upload_id, agency_id, project_id, revision_id, version, state, display_name, declared_format, reserved_bytes, quarantine_object_id,
  requested_by_membership_id, requested_by_user_id, application_expires_at, session_attempt, created_at, updated_at
) ON kauro.upload_sessions TO kauro_app;
GRANT UPDATE (
  version, state, session_attempt, session_issued_at, provider_session_digest, provider_session_expires_at, completion_reported_at,
  completion_claim_digest, claimed_generation, claimed_bytes, claimed_crc32c, claimed_md5, cancelled_at, cancelled_by_membership_id,
  terminal_reason, provider_cancellation_state, provider_cancellation_at, updated_at
) ON kauro.upload_sessions TO kauro_app;
-- the control plane never reads the display filename (customer text) and writes only lifecycle columns
GRANT SELECT (
  upload_id, agency_id, project_id, revision_id, version, state, declared_format, reserved_bytes, quarantine_object_id,
  requested_by_membership_id, requested_by_user_id, application_expires_at, session_attempt, session_issued_at,
  provider_session_digest, provider_session_expires_at, provider_cancellation_state, provider_cancellation_at,
  completion_reported_at, completion_claim_digest, claimed_generation, claimed_bytes, claimed_crc32c, claimed_md5,
  completion_observed_at, observed_generation, observed_bytes, inspection_fence, inspection_receipt_hash, file_id,
  terminal_reason, cancelled_by_membership_id, admitted_at, rejected_at, cancelled_at, expired_at, created_at, updated_at
) ON kauro.upload_sessions TO kauro_control;
GRANT UPDATE (
  version, state, provider_cancellation_state, provider_cancellation_at, completion_reported_at, completion_claim_digest,
  claimed_generation, claimed_bytes, claimed_crc32c, claimed_md5, completion_observed_at, observed_generation, observed_bytes,
  inspection_fence, inspection_receipt_hash, file_id, terminal_reason, admitted_at, rejected_at, expired_at, updated_at
) ON kauro.upload_sessions TO kauro_control;
GRANT SELECT, INSERT ON kauro.upload_session_secrets TO kauro_app;
GRANT SELECT, DELETE ON kauro.upload_session_secrets TO kauro_control;
GRANT SELECT ON kauro.dataset_revisions TO kauro_control;
GRANT UPDATE (
  version, state, evaluation_id, evaluation_hash, physical_source_rows, logical_source_records, billable_source_units,
  association_edges, rejected_at, expired_at, terminal_reason, updated_at
) ON kauro.dataset_revisions TO kauro_control;
