-- 0050 — B17 target contracts: CMD018 CreateTargetContract (an immutable DRAFT target version over an admitted metadata artifact) and
-- CMD019 ConfirmTargetContract (the agency's confirmation of that exact body, never altering it).
--
-- registry commands CMD018, CMD019 (gate G-VENDOR, idempotency REQUIRED, stateCheck TRANSACTIONAL_EXPECTED_VERSION_WHEN_SUPPLIED_PLUS_STORED_AUTHORITY).
-- It extends 0003's target_contracts (identity and bindings) and forks nothing: a version column (the confirmation edge advances it),
-- the confirming membership and its evidence reference, a confirm-once guard, and the append-only table of target artifacts
-- (structured metadata the platform admitted for a project's target instance, and the evidence of a confirmation). Customer target
-- metadata is DATA: never compiled, never executed (S093).

-- --- the target contract's lifecycle columns ------------------------------------------------------------------------------------------
ALTER TABLE kauro.target_contracts
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  ADD COLUMN confirmed_by_membership_id uuid,
  ADD COLUMN confirmation_evidence_ref uuid;

-- A confirmation is recorded once, whole (instant, confirming membership, evidence) and never changes afterwards; a row confirmed by a
-- fixture or an earlier writer before this migration has none of the two references and keeps it (the guard fires on an UPDATE only).
CREATE OR REPLACE FUNCTION kauro.target_contract_confirm_once() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.confirmed_at IS NOT NULL
     AND (NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
          OR NEW.confirmed_by_membership_id IS DISTINCT FROM OLD.confirmed_by_membership_id
          OR NEW.confirmation_evidence_ref IS DISTINCT FROM OLD.confirmation_evidence_ref) THEN
    RAISE EXCEPTION 'a target contract is confirmed once' USING ERRCODE = '23514';
  END IF;
  IF OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL
     AND (NEW.confirmed_by_membership_id IS NULL OR NEW.confirmation_evidence_ref IS NULL) THEN
    RAISE EXCEPTION 'a confirmation names its membership and its evidence' USING ERRCODE = '23514';
  END IF;
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION 'a target contract version never goes back' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER target_contracts_confirm_once BEFORE UPDATE ON kauro.target_contracts
  FOR EACH ROW EXECUTE FUNCTION kauro.target_contract_confirm_once();

-- --- target artifacts ----------------------------------------------------------------------------------------------------------------
-- METADATA: the structured target metadata an agency's observation produced for the project's target instance (bound to the project,
-- the CRM mode and the instance); CONFIRMATION_EVIDENCE: what the confirming actor was shown. Append-only, stamped by the database.
CREATE TABLE kauro.target_artifacts (
  artifact_id               uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(artifact_id)),
  agency_id                 uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id                uuid NOT NULL,
  kind                      text NOT NULL CHECK (kind IN ('METADATA', 'CONFIRMATION_EVIDENCE')),
  mode                      text NOT NULL CHECK (mode IN ('CLEAN', 'HUBSPOT', 'SALESFORCE')),
  instance_id               uuid NOT NULL,
  document                  jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object' AND pg_column_size(document) <= 262144),
  content_hash              text NOT NULL CHECK (kauro.is_sha256_hex(content_hash)),
  created_by_membership_id  uuid NOT NULL,
  created_at                timestamptz NOT NULL,
  UNIQUE (agency_id, artifact_id),
  FOREIGN KEY (agency_id, project_id) REFERENCES kauro.projects (agency_id, project_id),
  FOREIGN KEY (agency_id, created_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id)
);
CREATE TRIGGER target_artifacts_append_only BEFORE UPDATE OR DELETE ON kauro.target_artifacts
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE OR REPLACE FUNCTION kauro.target_artifacts_stamp() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  NEW.created_at := kauro.server_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER target_artifacts_stamp BEFORE INSERT ON kauro.target_artifacts
  FOR EACH ROW EXECUTE FUNCTION kauro.target_artifacts_stamp();

ALTER TABLE kauro.target_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.target_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY target_artifacts_tenant_read ON kauro.target_artifacts FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY target_artifacts_tenant_intake ON kauro.target_artifacts FOR INSERT TO kauro_app
  WITH CHECK (
    agency_id = kauro.current_agency_id()
    AND EXISTS (
      SELECT 1 FROM kauro.memberships m
       WHERE m.agency_id = target_artifacts.agency_id AND m.membership_id = target_artifacts.created_by_membership_id
         AND m.user_id = kauro.current_user_id() AND m.state = 'ACTIVE' AND m.role IN ('OWNER', 'ADMIN', 'OPERATOR', 'APPROVER')
    )
  );
GRANT SELECT ON kauro.target_artifacts TO kauro_app;
GRANT INSERT (artifact_id, agency_id, project_id, kind, mode, instance_id, document, content_hash, created_by_membership_id) ON kauro.target_artifacts TO kauro_app;

-- the confirmation's membership and evidence are of the contract's own agency (a composite key with a null member passes: a contract
-- not yet confirmed names neither)
ALTER TABLE kauro.target_contracts
  ADD CONSTRAINT target_contracts_confirmed_by_fk FOREIGN KEY (agency_id, confirmed_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id),
  ADD CONSTRAINT target_contracts_evidence_fk FOREIGN KEY (agency_id, confirmation_evidence_ref) REFERENCES kauro.target_artifacts (agency_id, artifact_id);
