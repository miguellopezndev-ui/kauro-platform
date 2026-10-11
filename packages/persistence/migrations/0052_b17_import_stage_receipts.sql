-- 0052 — B17 import stage receipts: CMD040 SubmitStageReceipt (the agency's uploaded source-to-target identity mapping, validated against
-- the stage's exact membership) and CMD041 ContinueStage (the approver's continuation from the verified identities).
--
-- registry commands CMD040, CMD041 (gate G-VENDOR, idempotency REQUIRED, stateCheck TRANSACTIONAL_EXPECTED_VERSION_WHEN_SUPPLIED_PLUS_STORED_AUTHORITY);
-- registry machine ImportStage and contract StageReceipt. Customer receipts are DATA: stored as admitted artifacts, validated against a
-- closed shape, hashed, never executed.
--
-- The stage rows are the stage compiler's (B08): nothing at runtime inserts one, a fixture or the compiler does. The request handlers
-- only read them and advance them along the listed edges (the guard below refuses any other edge, a changed binding, a second
-- continuation and a version that does not advance by one). A receipt is an append-only revision: a correction is a new row beside the old.

-- --- the receipt of a stage is an admitted artifact -----------------------------------------------------------------------------------
ALTER TABLE kauro.target_artifacts DROP CONSTRAINT target_artifacts_kind_check;
ALTER TABLE kauro.target_artifacts
  ADD CONSTRAINT target_artifacts_kind_check CHECK (kind IN ('METADATA', 'CONFIRMATION_EVIDENCE', 'STAGE_RECEIPT'));

-- --- import stages ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE kauro.import_stages (
  stage_id                    uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(stage_id)),
  agency_id                   uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id                  uuid NOT NULL,
  plan_id                     uuid NOT NULL,
  sequence                    integer NOT NULL CHECK (sequence >= 0),
  object_api_name             text NOT NULL CHECK (length(object_api_name) BETWEEN 1 AND 200),
  operation                   text NOT NULL CHECK (operation IN ('CREATE_ONLY', 'UPDATE_ONLY', 'UPSERT', 'ASSOCIATION_ONLY')),
  state                       text NOT NULL CHECK (state IN ('PREPARED', 'RELEASED', 'AWAITING_AGENCY_IMPORT', 'RECEIPT_UPLOADED', 'RECEIPT_VALIDATING', 'VERIFIED_SUCCESS', 'VERIFIED_PARTIAL', 'NEEDS_CORRECTION', 'CANCELLED', 'EXPIRED')),
  parent_stage_ids            jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(parent_stage_ids) = 'array'),
  package_hash                text NOT NULL CHECK (kauro.is_sha256_hex(package_hash)),
  receipt_required            boolean NOT NULL,
  expires_at                  timestamptz NOT NULL,
  instance_id                 uuid NOT NULL,
  source_ids                  jsonb NOT NULL CHECK (jsonb_typeof(source_ids) = 'array' AND jsonb_array_length(source_ids) <= 5000),
  version                     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  continued_at                timestamptz,
  continued_by_membership_id  uuid,
  continuation_receipt_hash   text CHECK (continuation_receipt_hash IS NULL OR kauro.is_sha256_hex(continuation_receipt_hash)),
  created_at                  timestamptz NOT NULL DEFAULT kauro.server_now(),
  UNIQUE (agency_id, stage_id),
  UNIQUE (agency_id, project_id, stage_id),
  FOREIGN KEY (agency_id, project_id) REFERENCES kauro.projects (agency_id, project_id),
  FOREIGN KEY (agency_id, plan_id) REFERENCES kauro.plans (agency_id, plan_id),
  FOREIGN KEY (agency_id, continued_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id),
  -- a continuation is whole: instant, membership and the receipt it continued
  CONSTRAINT import_stages_continuation_whole CHECK (
    (continued_at IS NULL AND continued_by_membership_id IS NULL AND continuation_receipt_hash IS NULL)
    OR (continued_at IS NOT NULL AND continued_by_membership_id IS NOT NULL AND continuation_receipt_hash IS NOT NULL)
  )
);

-- The listed edges a request session takes (registry ImportStage: receipt_submitted + receipt_validator_claims + receipt_complete /
-- receipt_missing_or_ambiguous / corrected_receipt_admitted collapse into one CMD040 write; approved_partial_scope_accounted is
-- CMD041's). Every other edge belongs to its owner's later migration; here it is refused.
CREATE OR REPLACE FUNCTION kauro.import_stage_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.stage_id IS DISTINCT FROM OLD.stage_id OR NEW.agency_id IS DISTINCT FROM OLD.agency_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.sequence IS DISTINCT FROM OLD.sequence OR NEW.object_api_name IS DISTINCT FROM OLD.object_api_name
     OR NEW.operation IS DISTINCT FROM OLD.operation OR NEW.parent_stage_ids IS DISTINCT FROM OLD.parent_stage_ids
     OR NEW.package_hash IS DISTINCT FROM OLD.package_hash OR NEW.receipt_required IS DISTINCT FROM OLD.receipt_required
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.instance_id IS DISTINCT FROM OLD.instance_id
     OR NEW.source_ids IS DISTINCT FROM OLD.source_ids OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an import stage binding is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'an import stage version advances by one' USING ERRCODE = '23514';
  END IF;
  IF OLD.continued_at IS NOT NULL THEN
    RAISE EXCEPTION 'an import stage is continued once' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state IN ('AWAITING_AGENCY_IMPORT', 'NEEDS_CORRECTION') AND NEW.state IN ('RECEIPT_VALIDATING', 'VERIFIED_SUCCESS', 'NEEDS_CORRECTION'))
    OR (OLD.state = 'RECEIPT_VALIDATING' AND NEW.state = 'VERIFIED_PARTIAL')
  ) THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: % to % is not an import stage edge of a request session', OLD.state, NEW.state USING ERRCODE = 'KA008';
  END IF;
  IF NEW.continued_at IS NOT NULL AND NEW.state NOT IN ('VERIFIED_SUCCESS', 'VERIFIED_PARTIAL') THEN
    RAISE EXCEPTION 'only a verified import stage is continued' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER import_stages_guard BEFORE UPDATE ON kauro.import_stages
  FOR EACH ROW EXECUTE FUNCTION kauro.import_stage_guard();
CREATE TRIGGER import_stages_no_delete BEFORE DELETE ON kauro.import_stages
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- continued_at is the database's instant
CREATE OR REPLACE FUNCTION kauro.import_stage_continued_stamp() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.continued_at IS NOT NULL AND OLD.continued_at IS NULL THEN
    NEW.continued_at := kauro.server_now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER import_stages_continued_stamp BEFORE UPDATE ON kauro.import_stages
  FOR EACH ROW EXECUTE FUNCTION kauro.import_stage_continued_stamp();

ALTER TABLE kauro.import_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.import_stages FORCE ROW LEVEL SECURITY;
CREATE POLICY import_stages_tenant_read ON kauro.import_stages FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY import_stages_tenant_advance ON kauro.import_stages FOR UPDATE TO kauro_app
  USING (agency_id = kauro.current_agency_id())
  WITH CHECK (
    agency_id = kauro.current_agency_id()
    AND (
      continued_by_membership_id IS NULL
      OR EXISTS (
        SELECT 1 FROM kauro.memberships m
         WHERE m.agency_id = import_stages.agency_id AND m.membership_id = import_stages.continued_by_membership_id
           AND m.user_id = kauro.current_user_id() AND m.state = 'ACTIVE' AND m.role IN ('OWNER', 'ADMIN', 'APPROVER')
      )
    )
  );
GRANT SELECT ON kauro.import_stages TO kauro_app;
GRANT UPDATE (state, version, continued_at, continued_by_membership_id, continuation_receipt_hash) ON kauro.import_stages TO kauro_app;

-- --- stage receipts --------------------------------------------------------------------------------------------------------------------
-- One row per validated receipt revision. The mapping is the complete disposition of every member of the stage (MATCHED with its target
-- identity, FAILED, UNRESOLVED); the hashes bind the exact stage package, the destination instance and the uploaded bytes.
CREATE TABLE kauro.stage_receipts (
  receipt_id                  uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(receipt_id)),
  agency_id                   uuid NOT NULL,
  project_id                  uuid NOT NULL,
  stage_id                    uuid NOT NULL,
  revision                    integer NOT NULL CHECK (revision >= 1),
  instance_id                 uuid NOT NULL,
  source_package_hash         text NOT NULL CHECK (kauro.is_sha256_hex(source_package_hash)),
  receipt_upload_ref          uuid NOT NULL,
  receipt_file_hash           text NOT NULL CHECK (kauro.is_sha256_hex(receipt_file_hash)),
  identity_mapping_hash       text NOT NULL CHECK (kauro.is_sha256_hex(identity_mapping_hash)),
  matched_rows                integer NOT NULL CHECK (matched_rows >= 0),
  failed_rows                 integer NOT NULL CHECK (failed_rows >= 0),
  unresolved_rows             integer NOT NULL CHECK (unresolved_rows >= 0),
  result                      text NOT NULL CHECK (result IN ('COMPLETE', 'PARTIAL_ACCOUNTED', 'NEEDS_CORRECTION')),
  mapping                     jsonb NOT NULL CHECK (jsonb_typeof(mapping) = 'array'),
  validated_at                timestamptz NOT NULL DEFAULT kauro.server_now(),
  validator_version           text NOT NULL CHECK (length(validator_version) BETWEEN 1 AND 100),
  submitted_by_membership_id  uuid NOT NULL,
  UNIQUE (agency_id, stage_id, revision),
  UNIQUE (agency_id, stage_id, receipt_file_hash),
  FOREIGN KEY (agency_id, project_id, stage_id) REFERENCES kauro.import_stages (agency_id, project_id, stage_id),
  FOREIGN KEY (agency_id, receipt_upload_ref) REFERENCES kauro.target_artifacts (agency_id, artifact_id),
  FOREIGN KEY (agency_id, submitted_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id),
  -- the counts are the mapping's: nothing is unaccounted
  CONSTRAINT stage_receipts_counts_match CHECK (matched_rows + failed_rows + unresolved_rows = jsonb_array_length(mapping)),
  CONSTRAINT stage_receipts_result_matches CHECK (
    result = CASE WHEN unresolved_rows > 0 THEN 'NEEDS_CORRECTION' WHEN failed_rows > 0 THEN 'PARTIAL_ACCOUNTED' ELSE 'COMPLETE' END
  )
);
CREATE TRIGGER stage_receipts_append_only BEFORE UPDATE OR DELETE ON kauro.stage_receipts
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE OR REPLACE FUNCTION kauro.stage_receipts_stamp() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  NEW.validated_at := kauro.server_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER stage_receipts_stamp BEFORE INSERT ON kauro.stage_receipts
  FOR EACH ROW EXECUTE FUNCTION kauro.stage_receipts_stamp();

ALTER TABLE kauro.stage_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.stage_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY stage_receipts_tenant_read ON kauro.stage_receipts FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY stage_receipts_tenant_submit ON kauro.stage_receipts FOR INSERT TO kauro_app
  WITH CHECK (
    agency_id = kauro.current_agency_id()
    AND EXISTS (
      SELECT 1 FROM kauro.memberships m
       WHERE m.agency_id = stage_receipts.agency_id AND m.membership_id = stage_receipts.submitted_by_membership_id
         AND m.user_id = kauro.current_user_id() AND m.state = 'ACTIVE' AND m.role IN ('OWNER', 'ADMIN', 'OPERATOR')
    )
  );
GRANT SELECT ON kauro.stage_receipts TO kauro_app;
GRANT INSERT (receipt_id, agency_id, project_id, stage_id, revision, instance_id, source_package_hash, receipt_upload_ref, receipt_file_hash, identity_mapping_hash,
              matched_rows, failed_rows, unresolved_rows, result, mapping, validator_version, submitted_by_membership_id) ON kauro.stage_receipts TO kauro_app;
