-- 0051 — B18 capability governance: CMD058 ChangeCapability (a PROSPECTIVE version of a capability; it never promotes a state) and
-- CMD059 RestrictCapability (the capability SUSPENDED, evidence kept, no paid project's scope touched).
--
-- registry commands CMD058, CMD059 (gate G-RELEASE, idempotency REQUIRED, stateCheck TRANSACTIONAL_EXPECTED_VERSION_WHEN_SUPPLIED_PLUS_STORED_AUTHORITY);
-- registry machine Capability (listed edges of 0003, never changed here). It extends 0003's capabilities and forks nothing: a revision
-- column (the expectedVersion of both commands: every version or restriction advances it), the append-only table of the versions
-- CMD058 records and the append-only table of the restrictions CMD059 records. The corporate owner acts in an OPERATOR session
-- (no agency bound), so every request policy is kauro.acting_corporate_owner() (0029); no SECURITY DEFINER.
--
-- A project keeps the (capability_id, capability_version) it was created under (0003: immutable columns), so neither command can change
-- the scope of a project that was paid for: a new version is a new row beside the one the project consumed, a restriction closes
-- admission of NEW work and leaves every existing project row as it is (routing it to recovery/refund is the recovery commands' step).

ALTER TABLE kauro.capabilities
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1);

CREATE OR REPLACE FUNCTION kauro.capability_revision_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'a capability revision never goes back' USING ERRCODE = '23514';
  END IF;
  -- the owner's request session moves a capability only to SUSPENDED (CMD059); every other edge is the control plane's, with its gate's
  -- evidence: a marketing edit never promotes IMPLEMENTED_UNACCEPTED to AVAILABLE_LIMITED or AVAILABLE (CMD058 failure)
  IF pg_catalog.pg_has_role(current_user, 'kauro_app', 'USAGE') AND NEW.state IS DISTINCT FROM OLD.state AND NEW.state <> 'SUSPENDED' THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: a request session may only restrict a capability' USING ERRCODE = 'KA008';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER capabilities_revision_guard BEFORE UPDATE ON kauro.capabilities
  FOR EACH ROW EXECUTE FUNCTION kauro.capability_revision_guard();

-- --- versions (CMD058) ---------------------------------------------------------------------------------------------------------------
-- One PROSPECTIVE version per CMD058: the profile hash and the qualification evidence it cites, numbered by the revision it advanced to.
-- Append-only, stamped by the database. A prospective version is not offered: consumers read the capability's own state, which only the
-- listed edges (with their gates) move.
CREATE TABLE kauro.capability_versions (
  capability_id                 uuid NOT NULL REFERENCES kauro.capabilities (capability_id),
  version_no                    integer NOT NULL CHECK (version_no >= 2),
  status                        text NOT NULL CHECK (status = 'PROSPECTIVE'),
  profile_hash                  text NOT NULL CHECK (kauro.is_sha256_hex(profile_hash)),
  qualification_evidence_hashes jsonb NOT NULL CHECK (jsonb_typeof(qualification_evidence_hashes) = 'array' AND jsonb_array_length(qualification_evidence_hashes) > 0),
  recorded_by_user_id           uuid NOT NULL REFERENCES kauro.identities (user_id),
  created_at                    timestamptz NOT NULL,
  PRIMARY KEY (capability_id, version_no)
);
CREATE TRIGGER capability_versions_append_only BEFORE UPDATE OR DELETE ON kauro.capability_versions
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE OR REPLACE FUNCTION kauro.capability_versions_stamp() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  NEW.created_at := kauro.server_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER capability_versions_stamp BEFORE INSERT ON kauro.capability_versions
  FOR EACH ROW EXECUTE FUNCTION kauro.capability_versions_stamp();

-- --- restrictions (CMD059) -----------------------------------------------------------------------------------------------------------
-- The evidence of a restriction: the incident it names, the state the capability left and the revision it reached. Append-only.
CREATE TABLE kauro.capability_restrictions (
  restriction_id       uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(restriction_id)),
  capability_id        uuid NOT NULL REFERENCES kauro.capabilities (capability_id),
  incident_ref         uuid NOT NULL,
  prior_state          text NOT NULL CHECK (prior_state IN ('IMPLEMENTED_UNACCEPTED', 'QUALIFIED_INTERNAL', 'AVAILABLE_LIMITED', 'AVAILABLE')),
  revision_after       integer NOT NULL CHECK (revision_after >= 2),
  recorded_by_user_id  uuid NOT NULL REFERENCES kauro.identities (user_id),
  created_at           timestamptz NOT NULL,
  UNIQUE (capability_id, incident_ref)
);
CREATE TRIGGER capability_restrictions_append_only BEFORE UPDATE OR DELETE ON kauro.capability_restrictions
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE OR REPLACE FUNCTION kauro.capability_restrictions_stamp() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  NEW.created_at := kauro.server_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER capability_restrictions_stamp BEFORE INSERT ON kauro.capability_restrictions
  FOR EACH ROW EXECUTE FUNCTION kauro.capability_restrictions_stamp();

-- --- access ----------------------------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.capability_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.capability_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY capability_versions_owner_read ON kauro.capability_versions FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY capability_versions_owner_record ON kauro.capability_versions FOR INSERT TO kauro_app
  WITH CHECK (kauro.acting_corporate_owner() AND recorded_by_user_id = kauro.current_user_id());
GRANT SELECT ON kauro.capability_versions TO kauro_app;
GRANT INSERT (capability_id, version_no, status, profile_hash, qualification_evidence_hashes, recorded_by_user_id) ON kauro.capability_versions TO kauro_app;

ALTER TABLE kauro.capability_restrictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.capability_restrictions FORCE ROW LEVEL SECURITY;
CREATE POLICY capability_restrictions_owner_read ON kauro.capability_restrictions FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY capability_restrictions_owner_record ON kauro.capability_restrictions FOR INSERT TO kauro_app
  WITH CHECK (kauro.acting_corporate_owner() AND recorded_by_user_id = kauro.current_user_id());
GRANT SELECT ON kauro.capability_restrictions TO kauro_app;
GRANT INSERT (restriction_id, capability_id, incident_ref, prior_state, revision_after, recorded_by_user_id) ON kauro.capability_restrictions TO kauro_app;

-- the owner's request session advances a capability's revision and restricts it; reads stay open to every request session (0003)
CREATE POLICY capabilities_owner_update ON kauro.capabilities FOR UPDATE TO kauro_app
  USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner());
GRANT UPDATE (state, revision, updated_at) ON kauro.capabilities TO kauro_app;
