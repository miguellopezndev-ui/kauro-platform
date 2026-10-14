-- Migration 0071: B16 lane L4, CMD054 OpenBreakglass, CMD055 RevokeBreakglass and the breakglass preview read (cases CMD054-*, CMD055-*,
-- R2-050, S071; failure matrix GAP-BG-1..8 of mandate B16-REST-PLAN §2).
--
-- 08 "Breakglass": the corporate owner sees no customer row by default; a short-lived audited least-privilege grant over ONE project, opened
-- with a fresh step-up for a concrete support case of that project or an actual incident naming it, lets its holder read the bounded preview
-- of that project's admitted tables and nothing else, for 1800 seconds (policy.json retention.breakglassSeconds). No SECURITY DEFINER: every
-- function below is SECURITY INVOKER and every widening is a policy of the owner's own request session.
--   1. kauro.breakglass_grants: one row per grant. The birth trigger stamps opened_at at the database's instant and expires_at 1800 s after
--      it (a CHECK holds the formula), and refuses (KA089 BREAKGLASS_SCOPE_UNAUTHORIZED) a grant whose authorization does not justify its
--      scope NOW: a support case of the same agency and project not RESOLVED/CLOSED, or an ACTUAL incident not CLOSED whose affected scopes
--      name 'project:<id>'; the agency not CLOSED, the project neither DELETION_REQUESTED nor DELETED. Uniques: one ACTIVE grant per project
--      (BREAKGLASS_GRANT_LIVE), one grant per step-up proof (BREAKGLASS_PROOF_REUSED: no silent reuse), one grant per (project, authorization)
--      (BREAKGLASS_RENEWAL_REFUSED, R2-050: after expiry a NEW justified grant is required; the expired record is kept).
--      The guard (KA008) allows only ACTIVE -> REVOKED (by a corporate owner, at the database's instant) and ACTIVE -> EXPIRED (once
--      expires_at has passed, judged at effect_now()); nothing a grant recorded changes.
--   2. The scope a session names: kauro.breakglass_project_id / kauro.breakglass_grant_id (set_config, transaction-local). Naming a scope
--      grants nothing by itself: under it the corporate owner reads the project's row, its agency's row and the project's support cases
--      (the facts the justification is judged on), and the source rows only through kauro.breakglass_covers(): its OWN grant, named, ACTIVE,
--      not expired at effect_now(), its authorization, project and agency still live (GAP-BG-7).
--   3. kauro.breakglass_accesses: every preview read under a grant, append-only, insertable only while the grant covers the row.
CREATE OR REPLACE FUNCTION kauro.breakglass_scope_project() RETURNS uuid
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$ SELECT NULLIF(current_setting('kauro.breakglass_project_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION kauro.breakglass_scope_grant() RETURNS uuid
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$ SELECT NULLIF(current_setting('kauro.breakglass_grant_id', true), '')::uuid $$;

-- The facts a breakglass scope is judged on, visible to the corporate owner only for the project the session names.
CREATE POLICY projects_breakglass_scope ON kauro.projects FOR SELECT TO kauro_app
  USING (kauro.acting_corporate_owner() AND project_id = kauro.breakglass_scope_project());
CREATE POLICY agencies_breakglass_scope ON kauro.agencies FOR SELECT TO kauro_app
  USING (kauro.acting_corporate_owner() AND EXISTS (
    SELECT 1 FROM kauro.projects p WHERE p.agency_id = agencies.agency_id AND p.project_id = kauro.breakglass_scope_project()
  ));
CREATE POLICY support_cases_breakglass_scope ON kauro.support_cases FOR SELECT TO kauro_app
  USING (kauro.acting_corporate_owner() AND project_id = kauro.breakglass_scope_project());

-- Whether an authorization still justifies a scope: the agency not CLOSED, the project not on its way to deletion, the support case of the
-- same project not RESOLVED/CLOSED or the actual incident not CLOSED naming the project. Read under the caller's own policies (fail closed:
-- with no scope named nothing is visible and the answer is false).
CREATE OR REPLACE FUNCTION kauro.breakglass_scope_live(p_agency uuid, p_project uuid, p_kind text, p_ref uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$
  SELECT p_project = kauro.breakglass_scope_project()
     AND EXISTS (SELECT 1 FROM kauro.agencies a WHERE a.agency_id = p_agency AND a.state IN ('ACTIVE', 'RESTRICTED', 'CLOSING'))
     AND EXISTS (SELECT 1 FROM kauro.projects p WHERE p.agency_id = p_agency AND p.project_id = p_project AND p.state IN ('OPEN', 'CLOSED'))
     AND CASE p_kind
           WHEN 'SUPPORT_CASE' THEN EXISTS (
             SELECT 1 FROM kauro.support_cases s
              WHERE s.case_id = p_ref AND s.agency_id = p_agency AND s.project_id = p_project AND s.state NOT IN ('RESOLVED', 'CLOSED'))
           WHEN 'INCIDENT' THEN EXISTS (
             SELECT 1 FROM kauro.incidents i
              WHERE i.incident_id = p_ref AND i.kind = 'ACTUAL' AND i.state <> 'CLOSED' AND i.affected_scopes ? ('project:' || p_project::text))
           ELSE false
         END
$$;

CREATE TABLE kauro.breakglass_grants (
  grant_id             uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(grant_id)),
  holder_user_id       uuid NOT NULL REFERENCES kauro.identities (user_id),
  agency_id            uuid NOT NULL,
  project_id           uuid NOT NULL,
  purpose              text NOT NULL CONSTRAINT breakglass_grants_purpose_label CHECK (kauro.is_label(purpose)),
  authorization_kind   text NOT NULL CHECK (authorization_kind IN ('SUPPORT_CASE', 'INCIDENT')),
  authorization_ref    uuid NOT NULL,
  assurance_proof_ref  uuid NOT NULL,
  state                text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  revision             integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  opened_at            timestamptz NOT NULL,
  expires_at           timestamptz NOT NULL,
  revoked_at           timestamptz,
  revoked_by_user_id   uuid REFERENCES kauro.identities (user_id),
  revoke_reason        text CONSTRAINT breakglass_grants_revoke_reason_label CHECK (revoke_reason IS NULL OR kauro.is_label(revoke_reason)),
  CONSTRAINT breakglass_grants_project FOREIGN KEY (agency_id, project_id) REFERENCES kauro.projects (agency_id, project_id),
  -- short-lived: exactly policy.json retention.breakglassSeconds after the database's instant of the opening
  CONSTRAINT breakglass_grants_short_lived CHECK (expires_at = opened_at + interval '1800 seconds'),
  CONSTRAINT breakglass_grants_revocation CHECK (
    (state = 'REVOKED') = (revoked_at IS NOT NULL) AND (revoked_at IS NULL) = (revoked_by_user_id IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL)
  ),
  CONSTRAINT breakglass_grants_proof_once UNIQUE (assurance_proof_ref),
  CONSTRAINT breakglass_grants_one_per_authorization UNIQUE (project_id, authorization_ref)
);
CREATE UNIQUE INDEX breakglass_grants_one_live_per_project ON kauro.breakglass_grants (project_id) WHERE state = 'ACTIVE';

CREATE OR REPLACE FUNCTION kauro.breakglass_grants_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.state <> 'ACTIVE' OR NEW.revision <> 1 OR NEW.revoked_at IS NOT NULL OR NEW.revoked_by_user_id IS NOT NULL OR NEW.revoke_reason IS NOT NULL THEN
    RAISE EXCEPTION 'a breakglass grant is born ACTIVE at revision 1' USING ERRCODE = '23514';
  END IF;
  NEW.opened_at := kauro.server_now();
  NEW.expires_at := NEW.opened_at + interval '1800 seconds';
  IF NOT kauro.breakglass_scope_live(NEW.agency_id, NEW.project_id, NEW.authorization_kind, NEW.authorization_ref) THEN
    RAISE EXCEPTION 'BREAKGLASS_SCOPE_UNAUTHORIZED: the authorization does not justify this scope' USING ERRCODE = 'KA089';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER breakglass_grants_birth BEFORE INSERT ON kauro.breakglass_grants
  FOR EACH ROW EXECUTE FUNCTION kauro.breakglass_grants_birth();

CREATE OR REPLACE FUNCTION kauro.breakglass_grants_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.grant_id <> OLD.grant_id OR NEW.holder_user_id <> OLD.holder_user_id OR NEW.agency_id <> OLD.agency_id OR NEW.project_id <> OLD.project_id
     OR NEW.purpose <> OLD.purpose OR NEW.authorization_kind <> OLD.authorization_kind OR NEW.authorization_ref <> OLD.authorization_ref
     OR NEW.assurance_proof_ref <> OLD.assurance_proof_ref OR NEW.opened_at <> OLD.opened_at OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'what a breakglass grant recorded never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'ACTIVE' OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: a breakglass grant leaves ACTIVE once' USING ERRCODE = 'KA008';
  END IF;
  IF NEW.state = 'REVOKED' THEN
    IF NEW.revoked_by_user_id IS DISTINCT FROM kauro.current_user_id() THEN
      RAISE EXCEPTION 'UNLISTED_TRANSITION: a grant is revoked by the session''s own person' USING ERRCODE = 'KA008';
    END IF;
    NEW.revoked_at := kauro.server_now();
  ELSIF NEW.state = 'EXPIRED' THEN
    IF OLD.expires_at > kauro.effect_now() OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'UNLISTED_TRANSITION: a grant expires only once its expiry has passed' USING ERRCODE = 'KA008';
    END IF;
  ELSE
    RAISE EXCEPTION 'UNLISTED_TRANSITION: a breakglass grant goes to REVOKED or EXPIRED' USING ERRCODE = 'KA008';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER breakglass_grants_guard BEFORE UPDATE ON kauro.breakglass_grants
  FOR EACH ROW EXECUTE FUNCTION kauro.breakglass_grants_guard();
CREATE TRIGGER breakglass_grants_no_delete BEFORE DELETE ON kauro.breakglass_grants
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

ALTER TABLE kauro.breakglass_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.breakglass_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY breakglass_grants_owner_read ON kauro.breakglass_grants FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY breakglass_grants_owner_open ON kauro.breakglass_grants FOR INSERT TO kauro_app
  WITH CHECK (kauro.acting_corporate_owner() AND holder_user_id = kauro.current_user_id());
CREATE POLICY breakglass_grants_owner_close ON kauro.breakglass_grants FOR UPDATE TO kauro_app
  USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner());
GRANT SELECT ON kauro.breakglass_grants TO kauro_app;
GRANT INSERT (grant_id, holder_user_id, agency_id, project_id, purpose, authorization_kind, authorization_ref, assurance_proof_ref) ON kauro.breakglass_grants TO kauro_app;
GRANT UPDATE (state, revision, revoked_at, revoked_by_user_id, revoke_reason) ON kauro.breakglass_grants TO kauro_app;

-- The session covers (agency, project) when the corporate owner names its OWN grant over that project, still ACTIVE and not expired at the
-- instant of the read, and the grant's authorization, project and agency are still live. VOLATILE: effect_now() moves within a transaction.
CREATE OR REPLACE FUNCTION kauro.breakglass_covers(p_agency uuid, p_project uuid) RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = pg_catalog AS
$$
  SELECT kauro.acting_corporate_owner() AND p_project = kauro.breakglass_scope_project() AND EXISTS (
    SELECT 1 FROM kauro.breakglass_grants g
     WHERE g.grant_id = kauro.breakglass_scope_grant() AND g.holder_user_id = kauro.current_user_id()
       AND g.agency_id = p_agency AND g.project_id = p_project AND g.state = 'ACTIVE' AND g.expires_at > kauro.effect_now()
       AND kauro.breakglass_scope_live(g.agency_id, g.project_id, g.authorization_kind, g.authorization_ref)
  )
$$;

-- The rows a breakglass preview reads, and only those: the admitted file, its tables and columns, and its accepted object.
CREATE POLICY source_files_breakglass_read ON kauro.source_files FOR SELECT TO kauro_app
  USING (state = 'ADMITTED' AND kauro.breakglass_covers(agency_id, project_id));
CREATE POLICY source_tables_breakglass_read ON kauro.source_tables FOR SELECT TO kauro_app
  USING (kauro.acting_corporate_owner() AND EXISTS (
    SELECT 1 FROM kauro.source_files f WHERE f.file_id = source_tables.file_id AND f.agency_id = source_tables.agency_id
  ));
CREATE POLICY source_table_columns_breakglass_read ON kauro.source_table_columns FOR SELECT TO kauro_app
  USING (kauro.acting_corporate_owner() AND EXISTS (
    SELECT 1 FROM kauro.source_tables t WHERE t.table_id = source_table_columns.table_id AND t.agency_id = source_table_columns.agency_id
  ));
CREATE POLICY stored_objects_breakglass_read ON kauro.stored_objects FOR SELECT TO kauro_app
  USING (kauro.acting_corporate_owner() AND EXISTS (
    SELECT 1 FROM kauro.source_files f WHERE f.accepted_object_id = stored_objects.object_id AND f.agency_id = stored_objects.agency_id
  ));

CREATE TABLE kauro.breakglass_accesses (
  access_id            uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(access_id)),
  grant_id             uuid NOT NULL REFERENCES kauro.breakglass_grants (grant_id),
  agency_id            uuid NOT NULL,
  project_id           uuid NOT NULL,
  file_id              uuid NOT NULL,
  table_id             uuid NOT NULL,
  accessed_by_user_id  uuid NOT NULL REFERENCES kauro.identities (user_id),
  accessed_at          timestamptz NOT NULL
);
CREATE INDEX breakglass_accesses_by_grant ON kauro.breakglass_accesses (grant_id, accessed_at);
CREATE OR REPLACE FUNCTION kauro.breakglass_accesses_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  NEW.accessed_at := kauro.effect_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER breakglass_accesses_birth BEFORE INSERT ON kauro.breakglass_accesses
  FOR EACH ROW EXECUTE FUNCTION kauro.breakglass_accesses_birth();
CREATE TRIGGER breakglass_accesses_append_only BEFORE UPDATE OR DELETE ON kauro.breakglass_accesses
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
ALTER TABLE kauro.breakglass_accesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.breakglass_accesses FORCE ROW LEVEL SECURITY;
CREATE POLICY breakglass_accesses_owner_read ON kauro.breakglass_accesses FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY breakglass_accesses_record ON kauro.breakglass_accesses FOR INSERT TO kauro_app
  WITH CHECK (accessed_by_user_id = kauro.current_user_id() AND grant_id = kauro.breakglass_scope_grant() AND kauro.breakglass_covers(agency_id, project_id));
GRANT SELECT ON kauro.breakglass_accesses TO kauro_app;
GRANT INSERT (access_id, grant_id, agency_id, project_id, file_id, table_id, accessed_by_user_id) ON kauro.breakglass_accesses TO kauro_app;
