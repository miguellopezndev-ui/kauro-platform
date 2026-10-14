-- Migration 0074 (provisional number; the coordinator renumbers at merge): B16 lane L5, CMD038 AuthorizeDownload.
--
-- 13 "Delivery", R2-048, S048: a member of the package's agency is granted short-lived read URLs over the delivery copies of an
-- AVAILABLE package. One COMMIT writes the grant (kauro.download_authorizations), its artifact rows, the audit event and the journal
-- entry; the URLs are signed by the provider AFTER COMMIT and never stored.
--   1. kauro.download_authorizations: one row per grant, bound to the requester's membership at its version, with its exact lifetime:
--      expires_at = least(issued_at + 900 s, the governing retention record's effective deadline). sign_state records the signing
--      phase after COMMIT (PENDING -> SIGNED | ISSUE_UNCERTAIN -> SIGNED); nothing else ever changes.
--   2. kauro.download_authorization_artifacts: the exact object generations granted, in the request's order; append-only.
--   3. KA094 (DOWNLOAD_AUTHORIZATION): a request session cannot write a grant the command would refuse: a package not AVAILABLE, a
--      project not OPEN, another person's or a stale membership, a lifetime other than least(900 s, deadline - issued_at), an issue
--      instant outside this transaction, an artifact that is not the package's or whose object is not PRESENT/VERIFIED, or an
--      artifact count that does not match its rows at COMMIT.
--   4. kauro.package_versions takes the exclusive transition lock when its state changes (the projects' trigger of 0021 is the
--      pattern), so a revocation and an issuance holding kauro.await_transition('kauro.package_versions', id) are ordered.
--   5. The request role reads the delivery copies of its own agency (kauro.delivery_artifacts had no request grant).
--   6. The event download_authorization.issued.v1 of the aggregate download_authorization (version 1), required with the row.
CREATE TABLE kauro.download_authorizations (
  authorization_id    uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(authorization_id)),
  agency_id           uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id          uuid NOT NULL,
  package_version_id  uuid NOT NULL,
  membership_id       uuid NOT NULL,
  membership_version  bigint NOT NULL CHECK (membership_version >= 1),
  user_id             uuid NOT NULL REFERENCES kauro.identities (user_id),
  version             bigint NOT NULL DEFAULT 1 CHECK (version = 1),
  issued_at           timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,
  artifact_count      integer NOT NULL CHECK (artifact_count BETWEEN 1 AND 1000),
  sign_state          text NOT NULL DEFAULT 'PENDING' CHECK (sign_state IN ('PENDING', 'SIGNED', 'ISSUE_UNCERTAIN')),
  signed_at           timestamptz,
  CONSTRAINT download_authorizations_lifetime CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '900 seconds'),
  CONSTRAINT download_authorizations_signed CHECK ((sign_state = 'SIGNED') = (signed_at IS NOT NULL)),
  CONSTRAINT download_authorizations_artifact_key UNIQUE (agency_id, authorization_id, package_version_id),
  FOREIGN KEY (agency_id, package_version_id) REFERENCES kauro.package_versions (agency_id, package_version_id),
  FOREIGN KEY (agency_id, membership_id, user_id) REFERENCES kauro.memberships (agency_id, membership_id, user_id)
);
CREATE INDEX download_authorizations_by_package ON kauro.download_authorizations (agency_id, package_version_id);

CREATE TABLE kauro.download_authorization_artifacts (
  authorization_id    uuid NOT NULL,
  ordinal             integer NOT NULL CHECK (ordinal >= 0),
  agency_id           uuid NOT NULL,
  package_version_id  uuid NOT NULL,
  object_name         text NOT NULL,
  object_id           uuid NOT NULL,
  generation          text NOT NULL,
  PRIMARY KEY (authorization_id, ordinal),
  CONSTRAINT download_authorization_artifacts_once UNIQUE (authorization_id, object_id),
  FOREIGN KEY (agency_id, authorization_id, package_version_id) REFERENCES kauro.download_authorizations (agency_id, authorization_id, package_version_id),
  FOREIGN KEY (package_version_id, object_name) REFERENCES kauro.delivery_artifacts (package_version_id, object_name),
  FOREIGN KEY (agency_id, object_id, generation) REFERENCES kauro.stored_objects (agency_id, object_id, generation)
);
CREATE TRIGGER download_authorization_artifacts_append_only BEFORE UPDATE OR DELETE ON kauro.download_authorization_artifacts
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER download_authorizations_no_delete BEFORE DELETE ON kauro.download_authorizations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER download_authorizations_immutable BEFORE UPDATE ON kauro.download_authorizations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('authorization_id,agency_id,project_id,package_version_id,membership_id,membership_version,user_id,version,issued_at,expires_at,artifact_count');

-- 3. the grant guard (KA094 = DOWNLOAD_AUTHORIZATION): the command's preconditions, re-proved by the database for every writer
CREATE OR REPLACE FUNCTION kauro.download_authorizations_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  deadline timestamptz;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.package_versions p
     WHERE p.agency_id = NEW.agency_id AND p.package_version_id = NEW.package_version_id AND p.project_id = NEW.project_id AND p.state = 'AVAILABLE'
  ) OR NOT EXISTS (
    SELECT 1 FROM kauro.projects pr WHERE pr.agency_id = NEW.agency_id AND pr.project_id = NEW.project_id AND pr.state = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'DOWNLOAD_AUTHORIZATION: package % is not AVAILABLE in an OPEN project', NEW.package_version_id USING ERRCODE = 'KA094';
  END IF;
  IF NEW.user_id IS DISTINCT FROM kauro.current_user_id() OR NOT EXISTS (
    SELECT 1 FROM kauro.memberships m
     WHERE m.agency_id = NEW.agency_id AND m.membership_id = NEW.membership_id AND m.user_id = NEW.user_id AND m.state = 'ACTIVE' AND m.version = NEW.membership_version
  ) THEN
    RAISE EXCEPTION 'DOWNLOAD_AUTHORIZATION: the grant names the session user''s ACTIVE membership at its current version' USING ERRCODE = 'KA094';
  END IF;
  SELECT max(r.effective_deadline) INTO deadline
    FROM kauro.package_versions p
    JOIN kauro.processing_jobs j ON j.agency_id = p.agency_id AND j.job_id = p.job_id
    JOIN kauro.dataset_revisions d ON d.agency_id = j.agency_id AND d.project_id = j.project_id AND d.manifest_hash = j.revision_hash
    JOIN kauro.retention_records r ON r.agency_id = d.agency_id AND r.revision_id = d.revision_id
   WHERE p.agency_id = NEW.agency_id AND p.package_version_id = NEW.package_version_id
     AND r.class IN ('PAID_ORDINARY', 'PAID_STAGED') AND r.state = 'ACTIVE';
  IF deadline IS NULL OR NEW.issued_at < kauro.server_now() OR NEW.issued_at > kauro.effect_now() OR deadline <= NEW.issued_at
     OR NEW.expires_at IS DISTINCT FROM least(NEW.issued_at + interval '900 seconds', deadline) THEN
    RAISE EXCEPTION 'DOWNLOAD_AUTHORIZATION: a grant is issued in this transaction and lives least(900 s, the retention deadline - issued_at)' USING ERRCODE = 'KA094';
  END IF;
  NEW.version := 1;
  NEW.sign_state := 'PENDING';
  NEW.signed_at := NULL;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION kauro.download_authorizations_guard() FROM PUBLIC;
CREATE TRIGGER download_authorizations_guard BEFORE INSERT ON kauro.download_authorizations
  FOR EACH ROW EXECUTE FUNCTION kauro.download_authorizations_guard();

-- the signing phase: PENDING -> SIGNED | ISSUE_UNCERTAIN, ISSUE_UNCERTAIN -> SIGNED; signed_at is the transaction time
CREATE OR REPLACE FUNCTION kauro.download_authorizations_signing() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT ((OLD.sign_state = 'PENDING' AND NEW.sign_state IN ('SIGNED', 'ISSUE_UNCERTAIN'))
          OR (OLD.sign_state = 'ISSUE_UNCERTAIN' AND NEW.sign_state = 'SIGNED')) THEN
    RAISE EXCEPTION 'DOWNLOAD_AUTHORIZATION: sign state % cannot become %', OLD.sign_state, NEW.sign_state USING ERRCODE = 'KA094';
  END IF;
  NEW.signed_at := CASE WHEN NEW.sign_state = 'SIGNED' THEN kauro.server_now() END;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION kauro.download_authorizations_signing() FROM PUBLIC;
CREATE TRIGGER download_authorizations_signing BEFORE UPDATE OF sign_state, signed_at ON kauro.download_authorizations
  FOR EACH ROW EXECUTE FUNCTION kauro.download_authorizations_signing();

-- an artifact row belongs to a grant of this transaction and names a live delivery copy of the grant's package
CREATE OR REPLACE FUNCTION kauro.download_authorization_artifacts_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.download_authorizations a
     WHERE a.agency_id = NEW.agency_id AND a.authorization_id = NEW.authorization_id AND a.package_version_id = NEW.package_version_id
       AND a.issued_at >= kauro.server_now() AND a.user_id = kauro.current_user_id() AND NEW.ordinal < a.artifact_count
  ) OR NOT EXISTS (
    SELECT 1 FROM kauro.delivery_artifacts x JOIN kauro.stored_objects o ON o.agency_id = x.agency_id AND o.object_id = x.object_id AND o.generation = x.generation
     WHERE x.agency_id = NEW.agency_id AND x.package_version_id = NEW.package_version_id AND x.object_name = NEW.object_name
       AND x.object_id = NEW.object_id AND x.generation = NEW.generation AND o.state IN ('PRESENT', 'VERIFIED')
  ) THEN
    RAISE EXCEPTION 'DOWNLOAD_AUTHORIZATION: artifact % is not a live delivery copy of the grant''s package', NEW.object_id USING ERRCODE = 'KA094';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION kauro.download_authorization_artifacts_guard() FROM PUBLIC;
CREATE TRIGGER download_authorization_artifacts_guard BEFORE INSERT ON kauro.download_authorization_artifacts
  FOR EACH ROW EXECUTE FUNCTION kauro.download_authorization_artifacts_guard();

-- at COMMIT a grant has exactly its artifact_count rows (no grant without its scope, no scope beyond it)
CREATE OR REPLACE FUNCTION kauro.download_authorizations_complete() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF (SELECT count(*) FROM kauro.download_authorization_artifacts x WHERE x.authorization_id = NEW.authorization_id) <> NEW.artifact_count THEN
    RAISE EXCEPTION 'DOWNLOAD_AUTHORIZATION: grant % has not exactly its % artifact rows', NEW.authorization_id, NEW.artifact_count USING ERRCODE = 'KA094';
  END IF;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION kauro.download_authorizations_complete() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER download_authorizations_complete AFTER INSERT ON kauro.download_authorizations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.download_authorizations_complete();

-- 4. a package's state change takes its exclusive transition lock (the issuance holds the shared one to COMMIT)
CREATE TRIGGER package_versions_transition_lock BEFORE UPDATE OF state ON kauro.package_versions
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.take_transition_lock('kauro.package_versions', 'package_version_id');

-- 6. the event and the aggregate
ALTER TABLE kauro.event_types NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.event_types (event_type) VALUES ('download_authorization.issued.v1');
ALTER TABLE kauro.event_types FORCE ROW LEVEL SECURITY;

INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES ('download_authorization', 'download_authorizations', 'authorization_id', 'B16');
CREATE CONSTRAINT TRIGGER download_authorizations_event_per_version AFTER INSERT ON kauro.download_authorizations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('download_authorization', 'authorization_id');

-- RLS: the agency's own members read its grants; a person writes and signs only their own
ALTER TABLE kauro.download_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.download_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY download_authorizations_tenant_read ON kauro.download_authorizations FOR SELECT TO kauro_app
  USING (agency_id = kauro.current_agency_id());
CREATE POLICY download_authorizations_tenant_insert ON kauro.download_authorizations FOR INSERT TO kauro_app
  WITH CHECK (agency_id = kauro.current_agency_id() AND user_id = kauro.current_user_id());
CREATE POLICY download_authorizations_tenant_sign ON kauro.download_authorizations FOR UPDATE TO kauro_app
  USING (agency_id = kauro.current_agency_id() AND user_id = kauro.current_user_id())
  WITH CHECK (agency_id = kauro.current_agency_id() AND user_id = kauro.current_user_id());
GRANT SELECT, INSERT ON kauro.download_authorizations TO kauro_app;
GRANT UPDATE (sign_state, signed_at) ON kauro.download_authorizations TO kauro_app;

ALTER TABLE kauro.download_authorization_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.download_authorization_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY download_authorization_artifacts_tenant ON kauro.download_authorization_artifacts FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
GRANT SELECT, INSERT ON kauro.download_authorization_artifacts TO kauro_app;

-- 5. the request role reads its own agency's delivery copies
CREATE POLICY delivery_artifacts_tenant_read ON kauro.delivery_artifacts FOR SELECT TO kauro_app
  USING (agency_id = kauro.current_agency_id());
GRANT SELECT ON kauro.delivery_artifacts TO kauro_app;
