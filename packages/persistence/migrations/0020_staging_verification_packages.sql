-- 0020 — B08 processing authority, part 2: the staged manifest and its artifacts, the read-backs, the verifications, the package
-- versions and their delivery copies, the attempts' cleanup records, the publication guard, the PACKAGE_AVAILABLE anchor and the
-- PAID_ORDINARY soft deadline, and the delivery notification of B09's entitlement.
--
-- Authority: 07 "Staging and publication transaction" (the worker writes staging only; the control plane verifies read-back and
-- attestation and publishes in one transaction under the current fence and authority; a valid package of a stale or unauthorized
-- attempt is never published), 07 "Package and import states", 04 "verifyPackage" (a package cannot establish its own expected
-- source), 09 "Derived data and worker scratch" (an external janitor cleans exact owned resources), 09 "Storage zones and object
-- registry" (every object is registered with its scope, generation and deletion status), 09 "Retention schedule" (paid ordinary
-- data: seven days from the first package, never past fourteen days from the capture), TRANSITIONS "Cross-aggregate finalization",
-- registry contract PackageManifest; scenarios S056, S061, S062, S075, R2-045. Design: docs/design/B08-audit-approval-jobs.md §5, §8.2,
-- §9 (decisions D8-STG-1..5, D8-VER-1, D8-PUB-1/2, D8-JAN-1, D8-RET-1, D8-EVT-1, D8-XPKG-7) and the decisions register rows D8-PEX-1..
-- of mandate B08-PERSISTENCE-EXECUTION. Every write here is the control plane's, bound to the agency (D8-ROLE-1, D8-ROLE-2); the
-- request handlers read the packages and the verifications' results of their tenant, never an object name or a provider identity.

-- --- event types, the aggregate kind and the machine ------------------------------------------------------------------------------
ALTER TABLE kauro.event_types NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.event_types (event_type) VALUES
  ('package_version.staged.v1'), ('package_version.verified_private.v1'), ('package_version.available.v1'), ('package_version.retired.v1'),
  ('package_version.revoked.v1'), ('package_version.deleted.v1'),
  -- the soft-deadline version of a PAID_ORDINARY record the publication writes (D8-RET-1)
  ('retention_record.soft_deadline_set.v1');
ALTER TABLE kauro.event_types FORCE ROW LEVEL SECURITY;

-- The superset of 0019's list (D8-BASE-2): the package types and the retention soft deadline are the control plane's too.
CREATE OR REPLACE FUNCTION kauro.execution_control_event_types() RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT ARRAY[
     'processing_job.admitted.v1', 'processing_job.running.v1', 'processing_job.verifying.v1', 'processing_job.ready.v1',
     'processing_job.failed.v1', 'processing_job.cancelled.v1', 'processing_job.expired.v1',
     'commercial_authorization.consumed.v1', 'commercial_authorization.delivered.v1',
     'package_version.staged.v1', 'package_version.verified_private.v1', 'package_version.available.v1', 'package_version.retired.v1',
     'package_version.revoked.v1', 'package_version.deleted.v1',
     'retention_record.soft_deadline_set.v1'
   ]::text[] $$;

INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('PackageVersion', 'STAGED');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('PackageVersion', 'STAGED', 'VERIFIED_PRIVATE'),
  ('PackageVersion', 'VERIFIED_PRIVATE', 'AVAILABLE'),
  ('PackageVersion', 'STAGED', 'REVOKED'),
  ('PackageVersion', 'VERIFIED_PRIVATE', 'REVOKED'),
  ('PackageVersion', 'AVAILABLE', 'RETIRED'),
  ('PackageVersion', 'AVAILABLE', 'REVOKED'),
  ('PackageVersion', 'AVAILABLE', 'DELETED'),
  ('PackageVersion', 'RETIRED', 'DELETED'),
  ('PackageVersion', 'REVOKED', 'DELETED');

-- --- the staged manifest (D8-STG-3) -------------------------------------------------------------------------------------------------
-- The manifest the control plane read itself from the attempt's own prefix at its generation (never the worker's word): the
-- KAURO_STAGED_MANIFEST_V1 digest of its bytes, the attempt, the fence and the input binding it names, and its artifact count.
-- Append-only; one per attempt.
CREATE TABLE kauro.staged_manifests (
  attempt_id             uuid PRIMARY KEY,
  agency_id              uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id             uuid NOT NULL,
  job_id                 uuid NOT NULL,
  fence                  bigint NOT NULL CHECK (fence >= 1),
  input_binding_hash     text NOT NULL CHECK (kauro.is_sha256_hex(input_binding_hash)),
  object_name            text NOT NULL CHECK (kauro.is_object_name(object_name)),
  generation             text NOT NULL CHECK (kauro.is_generation(generation)),
  manifest_hash          text NOT NULL CHECK (kauro.is_sha256_hex(manifest_hash)),
  artifact_count         integer NOT NULL CHECK (artifact_count BETWEEN 1 AND 10000),
  declared_summary_hash  text NOT NULL CHECK (kauro.is_sha256_hex(declared_summary_hash)),
  submitted_at           timestamptz NOT NULL,
  UNIQUE (agency_id, attempt_id),
  CONSTRAINT staged_manifests_package_binding UNIQUE (agency_id, attempt_id, job_id, manifest_hash),
  FOREIGN KEY (agency_id, attempt_id, job_id) REFERENCES kauro.processing_attempts (agency_id, attempt_id, job_id)
);
CREATE TRIGGER staged_manifests_append_only BEFORE UPDATE OR DELETE ON kauro.staged_manifests
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- Staged rows come only from the lease's current attempt while RUNNING, name exactly its manifest object, fence and input binding,
-- and never after cancel_command (KA080, KA081; S056, CMD037).
CREATE OR REPLACE FUNCTION kauro.staged_manifests_current_attempt() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  t record;
  j record;
BEGIN
  SELECT x.state, x.fence, x.project_id, x.manifest_object_name INTO t
    FROM kauro.processing_attempts x WHERE x.agency_id = NEW.agency_id AND x.attempt_id = NEW.attempt_id AND x.job_id = NEW.job_id FOR SHARE;
  SELECT y.input_binding_hash, y.cancel_version INTO j FROM kauro.processing_jobs y WHERE y.agency_id = NEW.agency_id AND y.job_id = NEW.job_id FOR SHARE;
  IF t.state IS DISTINCT FROM 'RUNNING' OR t.fence IS DISTINCT FROM NEW.fence OR NOT kauro.attempt_owns_lease(NEW.job_id, NEW.attempt_id, NEW.fence) THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: attempt % at fence % is not the running owner of the lease of job %', NEW.attempt_id, NEW.fence, NEW.job_id USING ERRCODE = 'KA080';
  END IF;
  IF j.cancel_version <> 0 THEN
    RAISE EXCEPTION 'EXECUTION_AUTHORITY: job % was cancelled and submits no manifest', NEW.job_id USING ERRCODE = 'KA081';
  END IF;
  IF NEW.object_name IS DISTINCT FROM t.manifest_object_name OR NEW.input_binding_hash IS DISTINCT FROM j.input_binding_hash OR NEW.project_id IS DISTINCT FROM t.project_id THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: the manifest of attempt % names another object, binding or project than the attempt''s own', NEW.attempt_id USING ERRCODE = 'KA080';
  END IF;
  NEW.submitted_at := kauro.server_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER staged_manifests_current_attempt BEFORE INSERT ON kauro.staged_manifests
  FOR EACH ROW EXECUTE FUNCTION kauro.staged_manifests_current_attempt();

-- --- the staged artifacts (D8-STG-1, D8-STG-3) ---------------------------------------------------------------------------------------
-- Every artifact the manifest names, registered as a STAGING stored object of the attempt's own prefix at its generation (B07's
-- registry is the deletion inventory, D-OBJ-1). Append-only.
CREATE TABLE kauro.staged_artifacts (
  attempt_id   uuid NOT NULL,
  object_name  text NOT NULL CHECK (kauro.is_object_name(object_name)),
  agency_id    uuid NOT NULL,
  job_id       uuid NOT NULL,
  role         text NOT NULL CHECK (role ~ '^[a-z][a-z0-9-]{0,62}$' AND role <> 'manifest'),
  object_id    uuid NOT NULL,
  generation   text NOT NULL CHECK (kauro.is_generation(generation)),
  sha256       text NOT NULL CHECK (kauro.is_sha256_hex(sha256)),
  byte_length  bigint NOT NULL CHECK (byte_length >= 1),
  PRIMARY KEY (attempt_id, object_name),
  CONSTRAINT staged_artifacts_readback_binding UNIQUE (agency_id, attempt_id, object_name, generation, sha256, byte_length),
  CONSTRAINT staged_artifacts_copy_binding UNIQUE (agency_id, attempt_id, object_name, sha256, byte_length),
  FOREIGN KEY (agency_id, attempt_id) REFERENCES kauro.staged_manifests (agency_id, attempt_id),
  FOREIGN KEY (agency_id, attempt_id, job_id) REFERENCES kauro.processing_attempts (agency_id, attempt_id, job_id),
  FOREIGN KEY (agency_id, object_id, generation) REFERENCES kauro.stored_objects (agency_id, object_id, generation)
);
CREATE TRIGGER staged_artifacts_append_only BEFORE UPDATE OR DELETE ON kauro.staged_artifacts
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- An artifact of the manifest lies under the attempt's own prefix (never its manifest object) and is that very registered STAGING
-- object; it is recorded by the running owner of the lease (KA080).
CREATE OR REPLACE FUNCTION kauro.staged_artifacts_in_prefix() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  t record;
  o record;
BEGIN
  SELECT x.state, x.fence, x.staging_prefix, x.manifest_object_name INTO t
    FROM kauro.processing_attempts x WHERE x.agency_id = NEW.agency_id AND x.attempt_id = NEW.attempt_id AND x.job_id = NEW.job_id;
  IF t.state IS DISTINCT FROM 'RUNNING' OR NOT kauro.attempt_owns_lease(NEW.job_id, NEW.attempt_id, t.fence) THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: attempt % is not the running owner of its lease and stages nothing', NEW.attempt_id USING ERRCODE = 'KA080';
  END IF;
  IF NOT starts_with(NEW.object_name, t.staging_prefix) OR NEW.object_name = t.manifest_object_name THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: artifact % is not an object of the staging prefix of attempt %', NEW.object_name, NEW.attempt_id USING ERRCODE = 'KA080';
  END IF;
  SELECT s.zone, s.object_name INTO o FROM kauro.stored_objects s WHERE s.agency_id = NEW.agency_id AND s.object_id = NEW.object_id AND s.generation = NEW.generation;
  IF o.zone IS DISTINCT FROM 'STAGING' OR o.object_name IS DISTINCT FROM NEW.object_name THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: artifact % names another registered object than its own STAGING generation', NEW.object_name USING ERRCODE = 'KA080';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER staged_artifacts_in_prefix BEFORE INSERT ON kauro.staged_artifacts
  FOR EACH ROW EXECUTE FUNCTION kauro.staged_artifacts_in_prefix();

-- the manifest is complete at COMMIT: exactly its artifact count of artifacts is staged with it
CREATE OR REPLACE FUNCTION kauro.staged_manifests_complete() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF (SELECT count(*) FROM kauro.staged_artifacts a WHERE a.agency_id = NEW.agency_id AND a.attempt_id = NEW.attempt_id) <> NEW.artifact_count THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: the manifest of attempt % names % artifacts, which are not exactly the artifacts staged with it', NEW.attempt_id, NEW.artifact_count USING ERRCODE = 'KA080';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER staged_manifests_complete AFTER INSERT ON kauro.staged_manifests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.staged_manifests_complete();

-- manifest_submitted (RUNNING -> STAGED): the attempt's manifest is recorded (the attempts' workflow of 0019 checked the fence)
CREATE OR REPLACE FUNCTION kauro.processing_attempts_manifest_submitted() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM kauro.staged_manifests m WHERE m.agency_id = OLD.agency_id AND m.attempt_id = OLD.attempt_id AND m.fence = OLD.fence) THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: attempt % is staged only with its submitted manifest', OLD.attempt_id USING ERRCODE = 'KA080';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER processing_attempts_workflow_staged BEFORE UPDATE OF state ON kauro.processing_attempts
  FOR EACH ROW WHEN (OLD.state = 'RUNNING' AND NEW.state = 'STAGED') EXECUTE FUNCTION kauro.processing_attempts_manifest_submitted();

-- --- package versions (platform machine PackageVersion; an aggregate, kind package_version) --------------------------------------------
CREATE TABLE kauro.package_versions (
  package_version_id      uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(package_version_id)),
  agency_id               uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id              uuid NOT NULL,
  job_id                  uuid NOT NULL,
  attempt_id              uuid NOT NULL,
  version                 bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                   text NOT NULL DEFAULT 'STAGED' CHECK (state IN ('STAGED', 'VERIFIED_PRIVATE', 'AVAILABLE', 'RETIRED', 'REVOKED', 'DELETED')),
  manifest_hash           text NOT NULL CHECK (kauro.is_sha256_hex(manifest_hash)),
  artifact_count          integer NOT NULL CHECK (artifact_count >= 1),
  -- D8-PUB-1: the package's own delivery prefix
  delivery_prefix         text NOT NULL,
  verification_id         uuid,
  -- KAURO_DELIVERY_MANIFEST_V1 over the issued PackageManifest (D8-PUB-2)
  delivery_manifest_hash  text CHECK (delivery_manifest_hash IS NULL OR kauro.is_sha256_hex(delivery_manifest_hash)),
  verified_at             timestamptz,
  available_at            timestamptz,
  revoked_at              timestamptz,
  revocation_reason       text CHECK (revocation_reason IS NULL OR kauro.is_token(revocation_reason)),
  retired_at              timestamptz,
  deleted_at              timestamptz,
  created_at              timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL,
  UNIQUE (agency_id, package_version_id),
  CONSTRAINT package_versions_job_binding UNIQUE (agency_id, package_version_id, job_id),
  CONSTRAINT package_versions_attempt_binding UNIQUE (agency_id, package_version_id, attempt_id),
  CONSTRAINT package_versions_one_per_attempt UNIQUE (attempt_id),
  FOREIGN KEY (agency_id, attempt_id, job_id, manifest_hash) REFERENCES kauro.staged_manifests (agency_id, attempt_id, job_id, manifest_hash),
  FOREIGN KEY (agency_id, job_id, project_id) REFERENCES kauro.processing_jobs (agency_id, job_id, project_id),
  CONSTRAINT package_versions_delivery_prefix CHECK (
    delivery_prefix = 'delivery/' || agency_id::text || '/' || project_id::text || '/' || package_version_id::text || '/'
  ),
  CONSTRAINT package_versions_verified_binding CHECK (state NOT IN ('VERIFIED_PRIVATE', 'AVAILABLE', 'RETIRED') OR (verification_id IS NOT NULL AND verified_at IS NOT NULL)),
  CONSTRAINT package_versions_available_binding CHECK (state NOT IN ('AVAILABLE', 'RETIRED') OR (available_at IS NOT NULL AND delivery_manifest_hash IS NOT NULL)),
  CONSTRAINT package_versions_revocation_recorded CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL) AND (state <> 'REVOKED' OR revoked_at IS NOT NULL)),
  CONSTRAINT package_versions_deleted_binding CHECK ((state = 'DELETED') = (deleted_at IS NOT NULL))
);
-- one AVAILABLE package per job
CREATE UNIQUE INDEX package_versions_one_available_per_job ON kauro.package_versions (agency_id, job_id) WHERE state = 'AVAILABLE';
CREATE TRIGGER package_versions_immutable BEFORE UPDATE ON kauro.package_versions
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('package_version_id,agency_id,project_id,job_id,attempt_id,manifest_hash,artifact_count,delivery_prefix,created_at');
CREATE TRIGGER package_versions_learned_once BEFORE UPDATE ON kauro.package_versions
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('verification_id,delivery_manifest_hash,verified_at,available_at,revoked_at,revocation_reason,retired_at,deleted_at');
CREATE TRIGGER package_versions_initial_state BEFORE INSERT ON kauro.package_versions
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('PackageVersion');
CREATE TRIGGER package_versions_transition BEFORE UPDATE OF state ON kauro.package_versions
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('PackageVersion');
CREATE TRIGGER package_versions_version BEFORE UPDATE ON kauro.package_versions
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE CONSTRAINT TRIGGER package_versions_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.package_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('package_version', 'package_version_id');
CREATE CONSTRAINT TRIGGER package_versions_event_type_per_version AFTER INSERT OR UPDATE OF version ON kauro.package_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_state_event_type('package_version', 'package_version_id');

INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES ('package_version', 'package_versions', 'package_version_id', 'B08');

-- the job names its published package (registry Job.packageId), a package of that very job
ALTER TABLE kauro.processing_jobs ADD CONSTRAINT processing_jobs_published_package_fk
  FOREIGN KEY (agency_id, published_package_id, job_id) REFERENCES kauro.package_versions (agency_id, package_version_id, job_id);

-- --- read-backs (D8-VER-1, D8-PUB-1; S061) -----------------------------------------------------------------------------------------------
-- What the storage returned for exactly one staged or delivered artifact at its expected generation. A MISMATCH (a partial blob, an
-- overwritten or foreign generation, another digest) and a MISSING object are evidence, kept; they refuse the verification and the
-- publication (KA084). Append-only.
CREATE TABLE kauro.artifact_readbacks (
  readback_id          uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(readback_id)),
  agency_id            uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  job_id               uuid NOT NULL,
  attempt_id           uuid NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('STAGING', 'DELIVERY')),
  package_version_id   uuid,
  object_name          text NOT NULL CHECK (kauro.is_object_name(object_name)),
  expected_generation  text NOT NULL CHECK (kauro.is_generation(expected_generation)),
  expected_sha256      text NOT NULL CHECK (kauro.is_sha256_hex(expected_sha256)),
  expected_bytes       bigint NOT NULL CHECK (expected_bytes >= 1),
  observed_generation  text CHECK (observed_generation IS NULL OR kauro.is_generation(observed_generation)),
  observed_sha256      text CHECK (observed_sha256 IS NULL OR kauro.is_sha256_hex(observed_sha256)),
  observed_bytes       bigint CHECK (observed_bytes IS NULL OR observed_bytes >= 0),
  result               text NOT NULL CHECK (result IN ('EQUAL', 'MISMATCH', 'MISSING')),
  read_at              timestamptz NOT NULL,
  UNIQUE (agency_id, readback_id),
  FOREIGN KEY (agency_id, attempt_id, job_id) REFERENCES kauro.processing_attempts (agency_id, attempt_id, job_id),
  CONSTRAINT artifact_readbacks_kind_subject CHECK ((kind = 'DELIVERY') = (package_version_id IS NOT NULL)),
  -- the result is what the observation says, never a claim beside it (NULL-safe)
  CONSTRAINT artifact_readbacks_result CHECK (
    (result = 'MISSING') = (observed_generation IS NULL AND observed_sha256 IS NULL AND observed_bytes IS NULL)
    AND (result = 'EQUAL') = (
      observed_generation IS NOT DISTINCT FROM expected_generation AND observed_sha256 IS NOT DISTINCT FROM expected_sha256
      AND observed_bytes IS NOT DISTINCT FROM expected_bytes
    )
  )
);
CREATE INDEX artifact_readbacks_by_attempt ON kauro.artifact_readbacks (agency_id, attempt_id, kind, object_name);
CREATE TRIGGER artifact_readbacks_append_only BEFORE UPDATE OR DELETE ON kauro.artifact_readbacks
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- A read-back names exactly an artifact of the attempt's own staged manifest (or of its package's delivery copies) with the values it
-- was staged or copied at, and is taken by the verifying owner of the lease (KA080).
CREATE OR REPLACE FUNCTION kauro.artifact_readbacks_own_artifact() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  t record;
BEGIN
  SELECT x.state, x.fence INTO t FROM kauro.processing_attempts x WHERE x.agency_id = NEW.agency_id AND x.attempt_id = NEW.attempt_id AND x.job_id = NEW.job_id;
  IF t.state IS DISTINCT FROM 'VERIFYING' OR NOT kauro.attempt_owns_lease(NEW.job_id, NEW.attempt_id, t.fence) THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: attempt % is not the verifying owner of its lease and reads nothing back', NEW.attempt_id USING ERRCODE = 'KA080';
  END IF;
  IF NEW.kind = 'STAGING' AND NOT EXISTS (
    SELECT 1 FROM kauro.staged_artifacts a
     WHERE a.agency_id = NEW.agency_id AND a.attempt_id = NEW.attempt_id AND a.object_name = NEW.object_name
       AND a.generation = NEW.expected_generation AND a.sha256 = NEW.expected_sha256 AND a.byte_length = NEW.expected_bytes
  ) THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: % is not an artifact of the staged manifest of attempt % at those values', NEW.object_name, NEW.attempt_id USING ERRCODE = 'KA080';
  END IF;
  IF NEW.kind = 'DELIVERY' AND NOT EXISTS (
    SELECT 1 FROM kauro.delivery_artifacts d
     WHERE d.agency_id = NEW.agency_id AND d.package_version_id = NEW.package_version_id AND d.attempt_id = NEW.attempt_id AND d.object_name = NEW.object_name
       AND d.generation = NEW.expected_generation AND d.sha256 = NEW.expected_sha256 AND d.byte_length = NEW.expected_bytes
  ) THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: % is not a delivery copy of package % at those values', NEW.object_name, NEW.package_version_id USING ERRCODE = 'KA080';
  END IF;
  NEW.read_at := kauro.server_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER artifact_readbacks_own_artifact BEFORE INSERT ON kauro.artifact_readbacks
  FOR EACH ROW EXECUTE FUNCTION kauro.artifact_readbacks_own_artifact();

-- --- verifications (D8-VER-1; S061) -----------------------------------------------------------------------------------------------------
-- One result of PackageVerifierPort against the authority the platform supplied (its digest), with the problems it found. A VALID
-- verification of an attempt needs every staging read-back equal (KA084), and there is one per attempt. Append-only.
CREATE TABLE kauro.package_verifications (
  verification_id          uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(verification_id)),
  agency_id                uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  job_id                   uuid NOT NULL,
  attempt_id               uuid NOT NULL,
  package_version_id       uuid NOT NULL,
  result                   text NOT NULL CHECK (result IN ('VALID', 'INVALID', 'ERROR')),
  problems                 jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(problems) = 'array' AND jsonb_array_length(problems) <= 64),
  evidence_class           text NOT NULL CHECK (evidence_class IN ('EXECUTED_LOCAL', 'SIMULATED')),
  expected_authority_hash  text NOT NULL CHECK (kauro.is_sha256_hex(expected_authority_hash)),
  core_version             text NOT NULL CHECK (kauro.is_label(core_version)),
  verified_at              timestamptz NOT NULL,
  UNIQUE (agency_id, verification_id),
  CONSTRAINT package_verifications_package_binding UNIQUE (agency_id, verification_id, package_version_id),
  FOREIGN KEY (agency_id, package_version_id, attempt_id) REFERENCES kauro.package_versions (agency_id, package_version_id, attempt_id),
  FOREIGN KEY (agency_id, attempt_id, job_id) REFERENCES kauro.processing_attempts (agency_id, attempt_id, job_id),
  CONSTRAINT package_verifications_valid_clean CHECK (result <> 'VALID' OR jsonb_array_length(problems) = 0),
  CONSTRAINT package_verifications_problem_named CHECK (result = 'VALID' OR jsonb_array_length(problems) >= 1)
);
CREATE UNIQUE INDEX package_verifications_one_valid_per_attempt ON kauro.package_verifications (attempt_id) WHERE result = 'VALID';
CREATE TRIGGER package_verifications_append_only BEFORE UPDATE OR DELETE ON kauro.package_verifications
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

CREATE OR REPLACE FUNCTION kauro.package_verifications_current_attempt() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  t record;
  cancelled bigint;
BEGIN
  SELECT x.state, x.fence INTO t FROM kauro.processing_attempts x WHERE x.agency_id = NEW.agency_id AND x.attempt_id = NEW.attempt_id AND x.job_id = NEW.job_id FOR SHARE;
  IF t.state IS DISTINCT FROM 'VERIFYING' OR NOT kauro.attempt_owns_lease(NEW.job_id, NEW.attempt_id, t.fence) THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: attempt % is not the verifying owner of its lease and verifies nothing', NEW.attempt_id USING ERRCODE = 'KA080';
  END IF;
  SELECT y.cancel_version INTO cancelled FROM kauro.processing_jobs y WHERE y.agency_id = NEW.agency_id AND y.job_id = NEW.job_id FOR SHARE;
  IF cancelled <> 0 THEN
    RAISE EXCEPTION 'EXECUTION_AUTHORITY: job % was cancelled; its package is verified no further', NEW.job_id USING ERRCODE = 'KA081';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.problems) p WHERE jsonb_typeof(p) <> 'string' OR NOT kauro.is_token(p #>> '{}')) THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: verification % names its problems as tokens only', NEW.verification_id USING ERRCODE = 'KA080';
  END IF;
  IF NEW.result = 'VALID' AND NOT kauro.readbacks_complete(NEW.agency_id, NEW.attempt_id, NULL) THEN
    RAISE EXCEPTION 'PUBLICATION_EVIDENCE: attempt % is VALID only with every staged artifact read back equal', NEW.attempt_id USING ERRCODE = 'KA084';
  END IF;
  NEW.verified_at := kauro.server_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER package_verifications_current_attempt BEFORE INSERT ON kauro.package_verifications
  FOR EACH ROW EXECUTE FUNCTION kauro.package_verifications_current_attempt();

ALTER TABLE kauro.package_versions ADD CONSTRAINT package_versions_verification_fk
  FOREIGN KEY (agency_id, verification_id, package_version_id) REFERENCES kauro.package_verifications (agency_id, verification_id, package_version_id);

-- --- delivery copies (D8-PUB-1) -------------------------------------------------------------------------------------------------------
-- Each staged artifact copied under the package's own delivery prefix with a generation-0 precondition, registered DELIVERY, still
-- private until the publication. Append-only; one copy per staged artifact.
CREATE TABLE kauro.delivery_artifacts (
  package_version_id  uuid NOT NULL,
  object_name         text NOT NULL CHECK (kauro.is_object_name(object_name)),
  agency_id           uuid NOT NULL,
  job_id              uuid NOT NULL,
  attempt_id          uuid NOT NULL,
  source_object_name  text NOT NULL,
  role                text NOT NULL CHECK (role ~ '^[a-z][a-z0-9-]{0,62}$'),
  object_id           uuid NOT NULL,
  generation          text NOT NULL CHECK (kauro.is_generation(generation)),
  sha256              text NOT NULL CHECK (kauro.is_sha256_hex(sha256)),
  byte_length         bigint NOT NULL CHECK (byte_length >= 1),
  PRIMARY KEY (package_version_id, object_name),
  CONSTRAINT delivery_artifacts_one_copy_per_source UNIQUE (package_version_id, source_object_name),
  FOREIGN KEY (agency_id, package_version_id, attempt_id) REFERENCES kauro.package_versions (agency_id, package_version_id, attempt_id),
  FOREIGN KEY (agency_id, attempt_id, source_object_name, sha256, byte_length) REFERENCES kauro.staged_artifacts (agency_id, attempt_id, object_name, sha256, byte_length),
  FOREIGN KEY (agency_id, object_id, generation) REFERENCES kauro.stored_objects (agency_id, object_id, generation)
);
CREATE TRIGGER delivery_artifacts_append_only BEFORE UPDATE OR DELETE ON kauro.delivery_artifacts
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

CREATE OR REPLACE FUNCTION kauro.delivery_artifacts_in_prefix() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  p record;
  t record;
  o record;
  staged_role text;
BEGIN
  SELECT x.state, x.delivery_prefix, x.job_id INTO p FROM kauro.package_versions x WHERE x.agency_id = NEW.agency_id AND x.package_version_id = NEW.package_version_id AND x.attempt_id = NEW.attempt_id FOR SHARE;
  SELECT y.state, y.fence INTO t FROM kauro.processing_attempts y WHERE y.agency_id = NEW.agency_id AND y.attempt_id = NEW.attempt_id;
  IF p.state IS DISTINCT FROM 'VERIFIED_PRIVATE' OR p.job_id IS DISTINCT FROM NEW.job_id OR t.state IS DISTINCT FROM 'VERIFYING'
     OR NOT kauro.attempt_owns_lease(NEW.job_id, NEW.attempt_id, t.fence) THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: package % is copied for delivery only while VERIFIED_PRIVATE by the verifying owner of its lease', NEW.package_version_id USING ERRCODE = 'KA080';
  END IF;
  IF NOT starts_with(NEW.object_name, p.delivery_prefix) THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: delivery copy % lies outside the prefix of package %', NEW.object_name, NEW.package_version_id USING ERRCODE = 'KA080';
  END IF;
  SELECT s.zone, s.object_name INTO o FROM kauro.stored_objects s WHERE s.agency_id = NEW.agency_id AND s.object_id = NEW.object_id AND s.generation = NEW.generation;
  IF o.zone IS DISTINCT FROM 'DELIVERY' OR o.object_name IS DISTINCT FROM NEW.object_name THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: delivery copy % names another registered object than its own DELIVERY generation', NEW.object_name USING ERRCODE = 'KA080';
  END IF;
  SELECT a.role INTO staged_role FROM kauro.staged_artifacts a WHERE a.agency_id = NEW.agency_id AND a.attempt_id = NEW.attempt_id AND a.object_name = NEW.source_object_name;
  IF staged_role IS DISTINCT FROM NEW.role THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: delivery copy % keeps the role of its staged artifact', NEW.object_name USING ERRCODE = 'KA080';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER delivery_artifacts_in_prefix BEFORE INSERT ON kauro.delivery_artifacts
  FOR EACH ROW EXECUTE FUNCTION kauro.delivery_artifacts_in_prefix();

-- Whether every staged artifact of an attempt was read back EQUAL and none of its staging read-backs differs or is missing — and,
-- with a package, the same for every delivery copy of every staged artifact (D8-VER-1, D8-PUB-1; the evidence of KA084).
CREATE OR REPLACE FUNCTION kauro.readbacks_complete(p_agency uuid, p_attempt uuid, p_package uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog AS
$$
  SELECT
    EXISTS (SELECT 1 FROM kauro.staged_artifacts a WHERE a.agency_id = p_agency AND a.attempt_id = p_attempt)
    AND NOT EXISTS (
      SELECT 1 FROM kauro.staged_artifacts a
       WHERE a.agency_id = p_agency AND a.attempt_id = p_attempt
         AND NOT EXISTS (SELECT 1 FROM kauro.artifact_readbacks r WHERE r.agency_id = p_agency AND r.attempt_id = p_attempt AND r.kind = 'STAGING' AND r.object_name = a.object_name AND r.result = 'EQUAL')
    )
    AND NOT EXISTS (SELECT 1 FROM kauro.artifact_readbacks r WHERE r.agency_id = p_agency AND r.attempt_id = p_attempt AND r.kind = 'STAGING' AND r.result <> 'EQUAL')
    AND (p_package IS NULL OR (
      NOT EXISTS (
        SELECT 1 FROM kauro.staged_artifacts a
         WHERE a.agency_id = p_agency AND a.attempt_id = p_attempt
           AND NOT EXISTS (
             SELECT 1 FROM kauro.delivery_artifacts d JOIN kauro.artifact_readbacks r
                 ON r.agency_id = d.agency_id AND r.package_version_id = d.package_version_id AND r.kind = 'DELIVERY' AND r.object_name = d.object_name AND r.result = 'EQUAL'
              WHERE d.agency_id = p_agency AND d.package_version_id = p_package AND d.source_object_name = a.object_name
           )
      )
      AND NOT EXISTS (SELECT 1 FROM kauro.artifact_readbacks r WHERE r.agency_id = p_agency AND r.package_version_id = p_package AND r.kind = 'DELIVERY' AND r.result <> 'EQUAL')
    ))
$$;


-- --- the package's workflow guard ----------------------------------------------------------------------------------------------------
-- Stamps its instants; STAGED is born with the attempt's staging under its fence; VERIFIED_PRIVATE only on a VALID verification of
-- this very package with every staging read-back equal (KA084); AVAILABLE is the publication's (the deferred guard below).
CREATE OR REPLACE FUNCTION kauro.package_versions_workflow() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  clock timestamptz := kauro.server_now();
  t record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT x.state, x.fence INTO t FROM kauro.processing_attempts x WHERE x.agency_id = NEW.agency_id AND x.attempt_id = NEW.attempt_id AND x.job_id = NEW.job_id;
    IF t.state IS NULL OR t.state NOT IN ('RUNNING', 'STAGED') OR NOT kauro.attempt_owns_lease(NEW.job_id, NEW.attempt_id, t.fence) THEN
      RAISE EXCEPTION 'EXECUTION_FENCE: package % is born with the staging of the lease''s current owner', NEW.package_version_id USING ERRCODE = 'KA080';
    END IF;
    IF NEW.version <> 1 OR NEW.verification_id IS NOT NULL OR NEW.delivery_manifest_hash IS NOT NULL OR NEW.revocation_reason IS NOT NULL THEN
      RAISE EXCEPTION 'EXECUTION_FENCE: package % is born STAGED at version 1 with nothing verified', NEW.package_version_id USING ERRCODE = 'KA080';
    END IF;
    NEW.created_at := clock;
    NEW.updated_at := clock;
    NEW.verified_at := NULL; NEW.available_at := NULL; NEW.revoked_at := NULL; NEW.retired_at := NULL; NEW.deleted_at := NULL;
    RETURN NEW;
  END IF;
  NEW.updated_at := clock;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NEW.state = 'VERIFIED_PRIVATE' THEN
      IF NOT EXISTS (
        SELECT 1 FROM kauro.package_verifications v
         WHERE v.agency_id = NEW.agency_id AND v.verification_id = NEW.verification_id AND v.package_version_id = NEW.package_version_id AND v.result = 'VALID'
      ) OR NOT kauro.readbacks_complete(NEW.agency_id, NEW.attempt_id, NULL) THEN
        RAISE EXCEPTION 'PUBLICATION_EVIDENCE: package % is VERIFIED_PRIVATE only with a VALID verification of itself and every read-back equal', NEW.package_version_id USING ERRCODE = 'KA084';
      END IF;
      SELECT x.state, x.fence INTO t FROM kauro.processing_attempts x WHERE x.agency_id = NEW.agency_id AND x.attempt_id = NEW.attempt_id;
      IF t.state IS DISTINCT FROM 'VERIFYING' OR NOT kauro.attempt_owns_lease(NEW.job_id, NEW.attempt_id, t.fence) THEN
        RAISE EXCEPTION 'EXECUTION_FENCE: package % is verified by the verifying owner of its lease only', NEW.package_version_id USING ERRCODE = 'KA080';
      END IF;
      NEW.verified_at := clock;
    ELSIF NEW.state = 'AVAILABLE' THEN
      NEW.available_at := clock;
    ELSIF NEW.state = 'REVOKED' THEN
      IF NEW.revocation_reason IS NULL THEN
        RAISE EXCEPTION 'EXECUTION_AUTHORITY: package % is revoked with its reason', NEW.package_version_id USING ERRCODE = 'KA081';
      END IF;
      NEW.revoked_at := clock;
    ELSIF NEW.state = 'RETIRED' THEN
      NEW.retired_at := clock;
    ELSIF NEW.state = 'DELETED' THEN
      NEW.deleted_at := clock;
    END IF;
  END IF;
  IF NEW.verification_id IS DISTINCT FROM OLD.verification_id AND NEW.state IS DISTINCT FROM 'VERIFIED_PRIVATE' THEN
    RAISE EXCEPTION 'PUBLICATION_EVIDENCE: package % names its verification with verification_valid only', OLD.package_version_id USING ERRCODE = 'KA084';
  END IF;
  IF NEW.delivery_manifest_hash IS DISTINCT FROM OLD.delivery_manifest_hash AND NEW.state IS DISTINCT FROM 'AVAILABLE' THEN
    RAISE EXCEPTION 'PUBLICATION_EVIDENCE: package % records its delivery manifest with its publication only', OLD.package_version_id USING ERRCODE = 'KA084';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER package_versions_workflow BEFORE INSERT OR UPDATE ON kauro.package_versions
  FOR EACH ROW EXECUTE FUNCTION kauro.package_versions_workflow();

-- --- the publication guard (D8-PUB-2; KA080, KA081, KA084; S056, S061, S062, R2-045) ---------------------------------------------------------
-- The only edge that makes a package downloadable, checked at COMMIT after the shared transition locks of every fact it relies on (the
-- last atomic check, D8-CANCEL-1): the package's attempt is the lease's current owner at its fence and COMMITTED with it (KA080); the
-- job is READY naming this package, never cancelled; the authorization is DELIVERED by this job now; the approval is live on the
-- APPROVED plan; the source is SEALED; the target is confirmed and current; the capability is offered; the agency ACTIVE and the
-- project OPEN (KA081); every staging and delivery read-back is equal, the verification VALID and the PACKAGE_AVAILABLE anchor written
-- (KA084): the revision's PACKAGE_AVAILABLE anchor, written by its first package. A valid package of a stale attempt, a
-- cancelled job or a revoked authority stays private.
CREATE OR REPLACE FUNCTION kauro.package_versions_publication_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  j record;
  t record;
  ok boolean;
  revision uuid;
  contract uuid;
BEGIN
  SELECT x.* INTO j FROM kauro.processing_jobs x WHERE x.agency_id = NEW.agency_id AND x.job_id = NEW.job_id;
  SELECT y.state, y.fence INTO t FROM kauro.processing_attempts y WHERE y.agency_id = NEW.agency_id AND y.attempt_id = NEW.attempt_id;
  IF t.state IS DISTINCT FROM 'COMMITTED' OR NOT kauro.attempt_owns_lease(NEW.job_id, NEW.attempt_id, t.fence) THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: package % is published only by the lease''s current owner, committed with it', NEW.package_version_id USING ERRCODE = 'KA080';
  END IF;
  -- the shared halves of every fact the publication relies on, in the platform's lock order (D8-LOCK-1)
  PERFORM kauro.await_transition('kauro.projects', j.project_id::text);
  PERFORM kauro.await_transition('kauro.agencies', j.agency_id::text);
  PERFORM kauro.await_transition('kauro.capabilities', j.mode);
  PERFORM kauro.await_transition('kauro.approvals', j.approval_id::text);
  SELECT r.revision_id INTO revision FROM kauro.dataset_revisions r WHERE r.agency_id = j.agency_id AND r.project_id = j.project_id AND r.manifest_hash = j.revision_hash;
  IF revision IS NOT NULL THEN
    PERFORM kauro.await_transition('kauro.dataset_revisions', revision::text);
  END IF;
  SELECT c.contract_id INTO contract FROM kauro.target_contracts c WHERE c.agency_id = j.agency_id AND c.project_id = j.project_id AND c.body_hash = j.target_contract_hash;
  IF contract IS NOT NULL THEN
    PERFORM kauro.await_transition('kauro.target_contracts', contract::text);
  END IF;
  SELECT
    j.state = 'READY' AND j.published_package_id = NEW.package_version_id AND j.cancel_version = 0 AND j.ready_at = kauro.server_now()
    AND EXISTS (SELECT 1 FROM kauro.commercial_authorizations a WHERE a.agency_id = j.agency_id AND a.authorization_id = j.authorization_id
                 AND a.state = 'DELIVERED' AND a.job_ref = j.job_id AND a.delivered_at = kauro.server_now())
    AND EXISTS (SELECT 1 FROM kauro.approvals p WHERE p.agency_id = j.agency_id AND p.approval_id = j.approval_id AND p.withdrawn_at IS NULL)
    AND EXISTS (SELECT 1 FROM kauro.plans p WHERE p.agency_id = j.agency_id AND p.plan_id = j.plan_id AND p.state = 'APPROVED' AND p.approval_id = j.approval_id)
    AND EXISTS (SELECT 1 FROM kauro.dataset_revisions r WHERE r.agency_id = j.agency_id AND r.revision_id = revision AND r.state = 'SEALED')
    AND EXISTS (SELECT 1 FROM kauro.target_contracts c WHERE c.agency_id = j.agency_id AND c.contract_id = contract AND c.confirmed_at IS NOT NULL AND c.superseded_at IS NULL)
    AND EXISTS (SELECT 1 FROM kauro.capabilities k WHERE k.capability_id = j.capability_id AND k.state IN ('AVAILABLE_LIMITED', 'AVAILABLE'))
    AND EXISTS (SELECT 1 FROM kauro.agencies g WHERE g.agency_id = j.agency_id AND g.state = 'ACTIVE')
    AND EXISTS (SELECT 1 FROM kauro.projects p WHERE p.agency_id = j.agency_id AND p.project_id = j.project_id AND p.state = 'OPEN')
  INTO ok;
  IF NOT coalesce(ok, false) THEN
    RAISE EXCEPTION 'EXECUTION_AUTHORITY: package % is published only under the current authority of its job (entitlement, cancellation, approval, source, target, capability, agency, project)', NEW.package_version_id USING ERRCODE = 'KA081';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM kauro.package_verifications v
     WHERE v.agency_id = NEW.agency_id AND v.verification_id = NEW.verification_id AND v.package_version_id = NEW.package_version_id AND v.result = 'VALID'
  ) OR NOT kauro.readbacks_complete(NEW.agency_id, NEW.attempt_id, NEW.package_version_id)
     OR NOT EXISTS (
    SELECT 1 FROM kauro.retention_anchors x JOIN kauro.dataset_revisions d ON d.agency_id = x.agency_id AND d.revision_id = x.revision_id
     WHERE x.agency_id = NEW.agency_id AND x.anchor_kind = 'PACKAGE_AVAILABLE' AND d.project_id = NEW.project_id AND d.revision_id = revision
  ) THEN
    RAISE EXCEPTION 'PUBLICATION_EVIDENCE: package % is published only with its VALID verification, every staging and delivery read-back equal and its PACKAGE_AVAILABLE anchor', NEW.package_version_id USING ERRCODE = 'KA084';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER package_versions_publication_guard AFTER UPDATE ON kauro.package_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state = 'AVAILABLE' AND OLD.state IS DISTINCT FROM 'AVAILABLE')
  EXECUTE FUNCTION kauro.package_versions_publication_guard();

-- atomic_publication_accepted binds the job and its package: a READY job's package is AVAILABLE in the same transaction (KA084) ...
CREATE OR REPLACE FUNCTION kauro.processing_jobs_ready_bound() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.package_versions p
     WHERE p.agency_id = NEW.agency_id AND p.package_version_id = NEW.published_package_id AND p.job_id = NEW.job_id AND p.state = 'AVAILABLE' AND p.available_at = NEW.ready_at
  ) THEN
    RAISE EXCEPTION 'PUBLICATION_EVIDENCE: job % is READY only with its package made AVAILABLE in the same transaction', NEW.job_id USING ERRCODE = 'KA084';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER processing_jobs_ready_bound AFTER UPDATE ON kauro.processing_jobs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state = 'READY' AND OLD.state IS DISTINCT FROM 'READY')
  EXECUTE FUNCTION kauro.processing_jobs_ready_bound();

-- ... and CONSUMED -> DELIVERED commits only with its job entering READY with an AVAILABLE package at that instant (the registry's
-- package_published guard of B09's CommercialAuthorization; KA081). Every runtime role is bound; a superuser session is not (it can
-- disable any trigger anyway), which keeps B09's api scenario S059 — it consumes and delivers an entitlement as the superuser oracle
-- standing in for B08 — unchanged, like the consumption bound of 0019 (decision D8-PEX-8).
CREATE OR REPLACE FUNCTION kauro.commercial_authorizations_delivery_bound() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND r.rolsuper) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM kauro.processing_jobs j JOIN kauro.package_versions p ON p.agency_id = j.agency_id AND p.package_version_id = j.published_package_id
     WHERE j.agency_id = NEW.agency_id AND j.job_id = NEW.job_ref AND j.authorization_id = NEW.authorization_id
       AND j.state = 'READY' AND p.state = 'AVAILABLE' AND j.ready_at = NEW.delivered_at AND NEW.delivered_at = kauro.server_now()
  ) THEN
    RAISE EXCEPTION 'EXECUTION_AUTHORITY: authorization % is delivered only by its job entering READY with an AVAILABLE package in the same transaction', NEW.authorization_id USING ERRCODE = 'KA081';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER commercial_authorizations_delivery_bound AFTER UPDATE ON kauro.commercial_authorizations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state = 'DELIVERED' AND OLD.state IS DISTINCT FROM 'DELIVERED')
  EXECUTE FUNCTION kauro.commercial_authorizations_delivery_bound();

-- --- the attempts' cleanup (D8-JAN-1; S075) --------------------------------------------------------------------------------------------
-- One record per attempt, after it ended: its provider identity and staging prefix (the attempt's own, by key), exactly the objects of
-- that prefix it deleted by generation, and what the host reported the provider job cost and did. Append-only.
CREATE TABLE kauro.attempt_cleanups (
  cleanup_id          uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(cleanup_id)),
  agency_id           uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  job_id              uuid NOT NULL,
  attempt_id          uuid NOT NULL,
  provider_identity   text NOT NULL,
  staging_prefix      text NOT NULL,
  deleted_objects     jsonb NOT NULL CHECK (jsonb_typeof(deleted_objects) = 'array' AND jsonb_array_length(deleted_objects) <= 10000),
  termination_result  text NOT NULL CHECK (termination_result IN ('TERMINATED', 'ALREADY_TERMINAL', 'NOT_FOUND', 'UNCERTAIN')),
  scratch_deleted     boolean NOT NULL,
  machine_type        text CHECK (machine_type IS NULL OR machine_type ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
  vcpus               integer CHECK (vcpus IS NULL OR vcpus >= 0),
  memory_bytes        bigint CHECK (memory_bytes IS NULL OR memory_bytes >= 0),
  disk_bytes          bigint CHECK (disk_bytes IS NULL OR disk_bytes >= 0),
  peak_scratch_bytes  bigint CHECK (peak_scratch_bytes IS NULL OR peak_scratch_bytes >= 0),
  runtime_ms          bigint CHECK (runtime_ms IS NULL OR runtime_ms >= 0),
  cost_micros         bigint CHECK (cost_micros IS NULL OR cost_micros >= 0),
  currency            text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  result              text NOT NULL CHECK (result IN ('CLEANED', 'PARTIAL')),
  evidence_class      text NOT NULL CHECK (evidence_class IN ('EXECUTED_PROVIDER', 'SIMULATED')),
  recorded_at         timestamptz NOT NULL,
  UNIQUE (agency_id, cleanup_id),
  CONSTRAINT attempt_cleanups_one_per_attempt UNIQUE (attempt_id),
  FOREIGN KEY (agency_id, attempt_id, job_id) REFERENCES kauro.processing_attempts (agency_id, attempt_id, job_id),
  CONSTRAINT attempt_cleanups_attempt_identity_fk FOREIGN KEY (agency_id, attempt_id, provider_identity, staging_prefix)
    REFERENCES kauro.processing_attempts (agency_id, attempt_id, identity, staging_prefix),
  CONSTRAINT attempt_cleanups_resources_complete CHECK (
    (machine_type IS NULL) = (vcpus IS NULL) AND (vcpus IS NULL) = (memory_bytes IS NULL) AND (memory_bytes IS NULL) = (disk_bytes IS NULL)
    AND (disk_bytes IS NULL) = (peak_scratch_bytes IS NULL) AND (peak_scratch_bytes IS NULL) = (runtime_ms IS NULL)
    AND (runtime_ms IS NULL) = (cost_micros IS NULL) AND (cost_micros IS NULL) = (currency IS NULL)
  ),
  CONSTRAINT attempt_cleanups_cleaned CHECK (result <> 'CLEANED' OR (scratch_deleted AND termination_result <> 'UNCERTAIN'))
);
CREATE TRIGGER attempt_cleanups_append_only BEFORE UPDATE OR DELETE ON kauro.attempt_cleanups
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- A cleanup names only an ended attempt, and only registered STAGING objects of exactly that attempt's prefix at their generations,
-- each once (KA080: nothing outside the prefix is the attempt's).
CREATE OR REPLACE FUNCTION kauro.attempt_cleanups_own_objects() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  attempt_state text;
  item jsonb;
BEGIN
  SELECT x.state INTO attempt_state FROM kauro.processing_attempts x WHERE x.agency_id = NEW.agency_id AND x.attempt_id = NEW.attempt_id;
  IF attempt_state IS NULL OR attempt_state NOT IN ('COMMITTED', 'ABANDONED', 'FAILED') THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: attempt % is %, and a live attempt is not cleaned', NEW.attempt_id, coalesce(attempt_state, 'not visible') USING ERRCODE = 'KA080';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(NEW.deleted_objects)) <> (SELECT count(DISTINCT e ->> 'objectId') FROM jsonb_array_elements(NEW.deleted_objects) e) THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: cleanup % names an object twice', NEW.cleanup_id USING ERRCODE = 'KA080';
  END IF;
  FOR item IN SELECT e FROM jsonb_array_elements(NEW.deleted_objects) e LOOP
    IF NOT kauro.jsonb_has_exactly_keys(item, ARRAY['objectId', 'objectName', 'generation'])
       OR NOT coalesce(starts_with(item ->> 'objectName', NEW.staging_prefix), false)
       OR NOT EXISTS (
         SELECT 1 FROM kauro.stored_objects s
          WHERE s.agency_id = NEW.agency_id AND s.object_id::text = item ->> 'objectId' AND s.object_name = item ->> 'objectName'
            AND s.generation = item ->> 'generation' AND s.zone = 'STAGING'
       ) THEN
      RAISE EXCEPTION 'EXECUTION_FENCE: cleanup % names an object outside the staging prefix of attempt %', NEW.cleanup_id, NEW.attempt_id USING ERRCODE = 'KA080';
    END IF;
  END LOOP;
  NEW.recorded_at := kauro.server_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER attempt_cleanups_own_objects BEFORE INSERT ON kauro.attempt_cleanups
  FOR EACH ROW EXECUTE FUNCTION kauro.attempt_cleanups_own_objects();

-- --- retention: the PACKAGE_AVAILABLE anchor and the PAID_ORDINARY soft deadline (D8-RET-1) ---------------------------------------------
ALTER TABLE kauro.retention_anchor_kinds NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.retention_anchor_kinds (anchor_kind) VALUES ('PACKAGE_AVAILABLE');
ALTER TABLE kauro.retention_anchor_kinds FORCE ROW LEVEL SECURITY;

-- The superset of 0019's binding (every arm unchanged): a PACKAGE_AVAILABLE anchor records a package of a job of this revision made
-- AVAILABLE in this very transaction, at exactly the anchor's instant (one per revision: the first package, B07's index).
CREATE OR REPLACE FUNCTION kauro.retention_anchors_bound() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  bound boolean;
BEGIN
  CASE NEW.anchor_kind
    WHEN 'UPLOAD_INITIATED' THEN
      bound := EXISTS (SELECT 1 FROM kauro.upload_sessions u WHERE u.agency_id = NEW.agency_id AND u.upload_id = NEW.upload_id AND u.created_at = NEW.occurred_at);
    WHEN 'INPUT_ADMITTED' THEN
      bound := EXISTS (SELECT 1 FROM kauro.upload_sessions u WHERE u.agency_id = NEW.agency_id AND u.upload_id = NEW.upload_id AND u.admitted_at = NEW.occurred_at);
    WHEN 'INTAKE_CANCELLED' THEN
      bound := EXISTS (SELECT 1 FROM kauro.upload_sessions u WHERE u.agency_id = NEW.agency_id AND u.upload_id = NEW.upload_id AND u.state = 'CANCELLED' AND u.cancelled_at = NEW.occurred_at);
    WHEN 'INTAKE_REJECTED' THEN
      bound := EXISTS (SELECT 1 FROM kauro.upload_sessions u WHERE u.agency_id = NEW.agency_id AND u.upload_id = NEW.upload_id AND u.state = 'REJECTED' AND u.rejected_at = NEW.occurred_at);
    WHEN 'INTAKE_EXPIRED' THEN
      bound := EXISTS (SELECT 1 FROM kauro.upload_sessions u WHERE u.agency_id = NEW.agency_id AND u.upload_id = NEW.upload_id AND u.state = 'EXPIRED' AND u.expired_at = NEW.occurred_at);
    WHEN 'REVISION_SEALED' THEN
      bound := EXISTS (SELECT 1 FROM kauro.dataset_revisions r WHERE r.agency_id = NEW.agency_id AND r.revision_id = NEW.revision_id AND r.state = 'SEALED' AND r.sealed_at = NEW.occurred_at);
    WHEN 'EXECUTION_ADMITTED' THEN
      bound := EXISTS (
        SELECT 1 FROM kauro.processing_jobs j JOIN kauro.dataset_revisions r ON r.agency_id = j.agency_id AND r.project_id = j.project_id AND r.manifest_hash = j.revision_hash
         WHERE j.agency_id = NEW.agency_id AND j.project_id = NEW.project_id AND r.revision_id = NEW.revision_id
           AND j.state = 'ADMITTED' AND j.admitted_at = NEW.occurred_at
      );
    WHEN 'PACKAGE_AVAILABLE' THEN
      bound := EXISTS (
        SELECT 1 FROM kauro.processing_jobs j
          JOIN kauro.dataset_revisions r ON r.agency_id = j.agency_id AND r.project_id = j.project_id AND r.manifest_hash = j.revision_hash
          JOIN kauro.package_versions p ON p.agency_id = j.agency_id AND p.package_version_id = j.published_package_id
         WHERE j.agency_id = NEW.agency_id AND j.project_id = NEW.project_id AND r.revision_id = NEW.revision_id
           AND p.state = 'AVAILABLE' AND p.available_at = NEW.occurred_at
      );
    ELSE
      bound := true;
  END CASE;
  IF NOT bound THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: the % anchor of % records no transition taken in this transaction', NEW.anchor_kind, coalesce(NEW.upload_id, NEW.revision_id) USING ERRCODE = 'KA072';
  END IF;
  RETURN NULL;
END
$$;

CREATE POLICY retention_anchors_control_publication ON kauro.retention_anchors FOR INSERT TO kauro_control
  WITH CHECK (agency_id = kauro.current_agency_id() AND anchor_kind = 'PACKAGE_AVAILABLE');

-- The first package of a revision sets its PAID_ORDINARY record's soft deadline, once: the PACKAGE_AVAILABLE anchor of this
-- transaction + 604,800 s, the effective deadline the minimum with the hard cap (retention_records_effective_is_minimum). A later
-- package never moves it (paidDaysFromFirstPackage; HASHING "Retention formulas": nothing resets a clock).
CREATE OR REPLACE FUNCTION kauro.retention_records_soft_deadline() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.soft_deadline IS NOT NULL THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: the soft deadline of retention record % is set once', OLD.retention_id USING ERRCODE = 'KA004';
  END IF;
  IF OLD.class <> 'PAID_ORDINARY' OR NOT EXISTS (
    SELECT 1 FROM kauro.retention_anchors a
     WHERE a.agency_id = OLD.agency_id AND a.revision_id = OLD.revision_id AND a.anchor_kind = 'PACKAGE_AVAILABLE' AND a.occurred_at = kauro.server_now()
       AND NEW.soft_deadline = a.occurred_at + interval '604800 seconds'
  ) THEN
    RAISE EXCEPTION 'PUBLICATION_EVIDENCE: the soft deadline of retention record % is the first package of its revision + 604800 s', OLD.retention_id USING ERRCODE = 'KA084';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER retention_records_soft_deadline BEFORE UPDATE OF soft_deadline ON kauro.retention_records
  FOR EACH ROW WHEN (OLD.soft_deadline IS DISTINCT FROM NEW.soft_deadline) EXECUTE FUNCTION kauro.retention_records_soft_deadline();
CREATE POLICY retention_records_control_soft_deadline ON kauro.retention_records FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id() AND class = 'PAID_ORDINARY' AND state = 'ACTIVE')
  WITH CHECK (agency_id = kauro.current_agency_id() AND class = 'PAID_ORDINARY' AND state = 'ACTIVE');
GRANT UPDATE (soft_deadline, effective_deadline) ON kauro.retention_records TO kauro_control;

-- --- the delivery notification of B09's entitlement (D8-XPKG-7) --------------------------------------------------------------------------
-- 0013: "a later package that subscribes to a commerce event adds its row in its own migration"; mirrored in @kauro/domain
-- COMMERCE_EVENT_SUBSCRIPTIONS (the persistence test proves them equal). The table is FORCE ROW LEVEL SECURITY with read policies
-- only, so the row is added with FORCE lifted inside this migration's own transaction and restored before COMMIT (as 0012 and 0013
-- extend event_types).
ALTER TABLE kauro.commerce_event_subscriptions NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.commerce_event_subscriptions (event_type, consumer) VALUES ('commercial_authorization.delivered.v1', 'NOTIFICATIONS');
ALTER TABLE kauro.commerce_event_subscriptions FORCE ROW LEVEL SECURITY;

-- --- row-level security and grants ------------------------------------------------------------------------------------------------
-- Every write is the control plane's, bound to the agency (D8-ROLE-1); an unbound control unit discovers work through what it reads.
-- The request handlers read their tenant's packages and verification results — never an object name, a prefix or a provider
-- identity (D8-ROLE-2) — and nothing else of execution evidence.
ALTER TABLE kauro.staged_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.staged_manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY staged_manifests_control_read ON kauro.staged_manifests FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY staged_manifests_control_insert ON kauro.staged_manifests FOR INSERT TO kauro_control WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.staged_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.staged_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY staged_artifacts_control_read ON kauro.staged_artifacts FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY staged_artifacts_control_insert ON kauro.staged_artifacts FOR INSERT TO kauro_control WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.artifact_readbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.artifact_readbacks FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_readbacks_control_read ON kauro.artifact_readbacks FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY artifact_readbacks_control_insert ON kauro.artifact_readbacks FOR INSERT TO kauro_control WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.package_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.package_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY package_verifications_tenant_read ON kauro.package_verifications FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY package_verifications_control_read ON kauro.package_verifications FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY package_verifications_control_insert ON kauro.package_verifications FOR INSERT TO kauro_control WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.package_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.package_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY package_versions_tenant_read ON kauro.package_versions FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY package_versions_control_read ON kauro.package_versions FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY package_versions_control_insert ON kauro.package_versions FOR INSERT TO kauro_control WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY package_versions_control_update ON kauro.package_versions FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.delivery_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.delivery_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_artifacts_control_read ON kauro.delivery_artifacts FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY delivery_artifacts_control_insert ON kauro.delivery_artifacts FOR INSERT TO kauro_control WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.attempt_cleanups ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.attempt_cleanups FORCE ROW LEVEL SECURITY;
CREATE POLICY attempt_cleanups_control_read ON kauro.attempt_cleanups FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY attempt_cleanups_control_insert ON kauro.attempt_cleanups FOR INSERT TO kauro_control WITH CHECK (agency_id = kauro.current_agency_id());

GRANT SELECT, INSERT ON kauro.staged_manifests, kauro.staged_artifacts, kauro.artifact_readbacks, kauro.package_verifications, kauro.delivery_artifacts, kauro.attempt_cleanups TO kauro_control;
GRANT SELECT ON kauro.package_versions TO kauro_control;
GRANT INSERT (package_version_id, agency_id, project_id, job_id, attempt_id, manifest_hash, artifact_count, delivery_prefix) ON kauro.package_versions TO kauro_control;
GRANT UPDATE (version, state, verification_id, delivery_manifest_hash, revocation_reason) ON kauro.package_versions TO kauro_control;
GRANT SELECT (
  package_version_id, agency_id, project_id, job_id, version, state, manifest_hash, artifact_count, verification_id, delivery_manifest_hash,
  verified_at, available_at, revoked_at, revocation_reason, retired_at, deleted_at, created_at, updated_at
) ON kauro.package_versions TO kauro_app;
GRANT SELECT (verification_id, agency_id, job_id, package_version_id, result, evidence_class, verified_at) ON kauro.package_verifications TO kauro_app;
