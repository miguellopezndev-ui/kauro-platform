-- Migration 0095 — the sources of a B13 report (order 6; docs/design/B13-report-inputs.md).
--
-- A report names its issuer, its terms, its branding, its findings and its material decisions; each must be a record of the platform, read
-- by the control plane in a SYSTEM unit of work bound to the job's agency (D-CTRL-1), and verified against the hash another record holds.
-- What existed: the quote (terms_version, terms_hash = KAURO_QUOTE_TERMS_V1 over its own preimage, which names its issuer), the agency's
-- acceptance of the terms version (CMD002), the fiscal issuer (legal_identity_hash, a hash with no document), the audit's findings, the
-- approval's disclosures hash. What was missing, and is all this migration adds:
--   1. kauro.legal_identity_snapshots: the document a fiscal issuer's legal_identity_hash is the SHA-256 of (KAURO_LEGAL_IDENTITY_V1,
--      @kauro/domain legal-identity.ts). Content-addressed (legal_identity_snapshots_content_addressed: the key IS the document's SHA-256),
--      append-only for every role, recorded and read by the control plane only (the platform's records, like kauro.fiscal_issuers). No row
--      is recorded here: the owner's legal identity is the owner's to provide (docs/owner/LEGAL_IDENTITY_SNAPSHOT.md); until it is, every
--      report is refused ISSUER_UNAVAILABLE. A recorded document is never replaced: a corrected identity is another document, another hash,
--      another fiscal issuer — the quotes already issued keep the identity their terms named.
--   2. kauro.agency_branding_versions: the agency's branding versions (registry CMD008 "Create a new branding version for future reports
--      while preserving already delivered artifact identity"). Numbered 1, 2, ... per agency in order (agency_branding_versions_contiguous),
--      the instant the database's, append-only for every role. The agency's ACTIVE OWNER or ADMIN records one as itself (MANAGE_BRANDING;
--      CMD008's route is not part of this edition); the request handlers and the control plane read their agency's. A display name a report
--      could not print (markup-significant, control, format or separator characters, padding, not NFC) is refused here, not at the report.
--      No logo column: the stored-logo pipeline is CMD008's.
--   2b. kauro.report_branding_bindings: the one branding version of a job's reports, recorded by the control plane the first time it reads
--      the job's report sources and never again (append-only, one row per job). A version's instant is its transaction's (server_now), not
--      its commit's, so "the version recorded at or before the job was queued" would otherwise read differently before and after a branding
--      transaction that began before the queueing commits: the binding fixes the version as committed when the first report was made. Its
--      guard admits only the agency's latest version recorded at or before the job's queued_at that the binding transaction sees, so the
--      control plane cannot bind any other.
--   3. The control plane's read of what the report verifies, column by column, bound to its agency: the quote's terms preimage and state,
--      the agency's terms acceptances, and the approval's disclosures hash. Nothing else is granted; no write is granted on any of them.
-- No existing row, column, constraint or hash changes. Idempotent.

-- --- 1. legal identity snapshots ------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kauro.legal_identity_snapshots (
  legal_identity_hash  text PRIMARY KEY CHECK (kauro.is_sha256_hex(legal_identity_hash)),
  document             bytea NOT NULL CHECK (octet_length(document) BETWEEN 2 AND 8192),
  recorded_at          timestamptz NOT NULL,
  CONSTRAINT legal_identity_snapshots_content_addressed CHECK (pg_catalog.encode(pg_catalog.sha256(document), 'hex') = legal_identity_hash)
);
CREATE OR REPLACE FUNCTION kauro.legal_identity_snapshots_stamp() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  NEW.recorded_at := kauro.server_now();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION kauro.legal_identity_snapshots_stamp() FROM PUBLIC;
DROP TRIGGER IF EXISTS legal_identity_snapshots_stamp ON kauro.legal_identity_snapshots;
CREATE TRIGGER legal_identity_snapshots_stamp BEFORE INSERT ON kauro.legal_identity_snapshots
  FOR EACH ROW EXECUTE FUNCTION kauro.legal_identity_snapshots_stamp();
DROP TRIGGER IF EXISTS legal_identity_snapshots_append_only ON kauro.legal_identity_snapshots;
CREATE TRIGGER legal_identity_snapshots_append_only BEFORE UPDATE OR DELETE ON kauro.legal_identity_snapshots
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
DROP TRIGGER IF EXISTS legal_identity_snapshots_no_truncate ON kauro.legal_identity_snapshots;
CREATE TRIGGER legal_identity_snapshots_no_truncate BEFORE TRUNCATE ON kauro.legal_identity_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
ALTER TABLE kauro.legal_identity_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.legal_identity_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS legal_identity_snapshots_control_read ON kauro.legal_identity_snapshots;
DROP POLICY IF EXISTS legal_identity_snapshots_control_record ON kauro.legal_identity_snapshots;
CREATE POLICY legal_identity_snapshots_control_read ON kauro.legal_identity_snapshots FOR SELECT TO kauro_control USING (true);
CREATE POLICY legal_identity_snapshots_control_record ON kauro.legal_identity_snapshots FOR INSERT TO kauro_control WITH CHECK (true);
GRANT SELECT ON kauro.legal_identity_snapshots TO kauro_control;
GRANT INSERT (legal_identity_hash, document) ON kauro.legal_identity_snapshots TO kauro_control;

-- --- 2. agency branding versions --------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kauro.agency_branding_versions (
  agency_id                  uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  branding_version           integer NOT NULL CHECK (branding_version >= 1),
  display_name               text NOT NULL,
  recorded_by_membership_id  uuid NOT NULL,
  recorded_by_user_id        uuid NOT NULL,
  recorded_at                timestamptz NOT NULL,
  PRIMARY KEY (agency_id, branding_version),
  CONSTRAINT agency_branding_versions_membership_fk FOREIGN KEY (agency_id, recorded_by_membership_id, recorded_by_user_id)
    REFERENCES kauro.memberships (agency_id, membership_id, user_id),
  -- the report model's brand fence (S069), held where the name is recorded: 1..120 characters, no padding, NFC, and none of the controls,
  -- format characters (soft hyphen, zero-width, bidirectional, word joiners, BOM), separators or markup-significant characters
  CONSTRAINT agency_branding_versions_printable CHECK (
    kauro.is_label(display_name) AND length(display_name) <= 120 AND display_name = btrim(display_name) AND display_name IS NFC NORMALIZED
    AND display_name !~ '[<>"''&`]'
    AND display_name !~ '[\u00ad\u0600-\u0605\u061c\u06dd\u070f\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]'
  )
);
CREATE OR REPLACE FUNCTION kauro.agency_branding_versions_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  latest integer;
BEGIN
  SELECT max(b.branding_version) INTO latest FROM kauro.agency_branding_versions b WHERE b.agency_id = NEW.agency_id;
  IF NEW.branding_version <> coalesce(latest, 0) + 1 THEN
    RAISE EXCEPTION 'BRANDING_VERSION_NOT_NEXT: agency % records branding version % after %', NEW.agency_id, NEW.branding_version, coalesce(latest, 0)
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agency_branding_versions_contiguous', SCHEMA = 'kauro', TABLE = 'agency_branding_versions';
  END IF;
  NEW.recorded_at := kauro.server_now();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION kauro.agency_branding_versions_birth() FROM PUBLIC;
DROP TRIGGER IF EXISTS agency_branding_versions_birth ON kauro.agency_branding_versions;
CREATE TRIGGER agency_branding_versions_birth BEFORE INSERT ON kauro.agency_branding_versions
  FOR EACH ROW EXECUTE FUNCTION kauro.agency_branding_versions_birth();
DROP TRIGGER IF EXISTS agency_branding_versions_append_only ON kauro.agency_branding_versions;
CREATE TRIGGER agency_branding_versions_append_only BEFORE UPDATE OR DELETE ON kauro.agency_branding_versions
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
DROP TRIGGER IF EXISTS agency_branding_versions_no_truncate ON kauro.agency_branding_versions;
CREATE TRIGGER agency_branding_versions_no_truncate BEFORE TRUNCATE ON kauro.agency_branding_versions
  FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

-- the recorder is the session's own person, an ACTIVE OWNER or ADMIN of the bound agency (MANAGE_BRANDING, @kauro/domain roles.ts)
CREATE OR REPLACE FUNCTION kauro.acting_branding_manager(p_agency uuid, p_membership uuid, p_user uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS
$$
BEGIN
  IF kauro.current_user_id() IS NULL OR p_user IS DISTINCT FROM kauro.current_user_id() THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM kauro.memberships m
     WHERE m.agency_id = p_agency AND m.membership_id = p_membership
       AND m.user_id = p_user AND m.state = 'ACTIVE' AND m.role IN ('OWNER', 'ADMIN'));
END
$$;
REVOKE ALL ON FUNCTION kauro.acting_branding_manager(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kauro.acting_branding_manager(uuid, uuid, uuid) TO kauro_app;

ALTER TABLE kauro.agency_branding_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.agency_branding_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agency_branding_versions_tenant_read ON kauro.agency_branding_versions;
DROP POLICY IF EXISTS agency_branding_versions_tenant_record ON kauro.agency_branding_versions;
DROP POLICY IF EXISTS agency_branding_versions_control_read ON kauro.agency_branding_versions;
CREATE POLICY agency_branding_versions_tenant_read ON kauro.agency_branding_versions FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY agency_branding_versions_tenant_record ON kauro.agency_branding_versions FOR INSERT TO kauro_app
  WITH CHECK (agency_id = kauro.current_agency_id() AND kauro.acting_branding_manager(agency_id, recorded_by_membership_id, recorded_by_user_id));
CREATE POLICY agency_branding_versions_control_read ON kauro.agency_branding_versions FOR SELECT TO kauro_control USING (agency_id = kauro.current_agency_id());
GRANT SELECT ON kauro.agency_branding_versions TO kauro_app, kauro_control;
GRANT INSERT (agency_id, branding_version, display_name, recorded_by_membership_id, recorded_by_user_id) ON kauro.agency_branding_versions TO kauro_app;

-- --- 2b. the branding version of a job's reports ---------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kauro.report_branding_bindings (
  agency_id         uuid NOT NULL,
  job_id            uuid NOT NULL,
  branding_version  integer NOT NULL,
  bound_at          timestamptz NOT NULL,
  PRIMARY KEY (agency_id, job_id),
  FOREIGN KEY (agency_id, job_id) REFERENCES kauro.processing_jobs (agency_id, job_id),
  FOREIGN KEY (agency_id, branding_version) REFERENCES kauro.agency_branding_versions (agency_id, branding_version)
);
CREATE OR REPLACE FUNCTION kauro.report_branding_bindings_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  queued timestamptz;
  latest integer;
BEGIN
  SELECT j.queued_at INTO queued FROM kauro.processing_jobs j WHERE j.agency_id = NEW.agency_id AND j.job_id = NEW.job_id;
  SELECT max(b.branding_version) INTO latest FROM kauro.agency_branding_versions b WHERE b.agency_id = NEW.agency_id AND b.recorded_at <= queued;
  IF queued IS NULL OR latest IS DISTINCT FROM NEW.branding_version THEN
    RAISE EXCEPTION 'BRANDING_BINDING_NOT_IN_FORCE: job % binds branding version %, the version in force when it was queued is %', NEW.job_id, NEW.branding_version, coalesce(latest::text, 'none')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'report_branding_bindings_in_force', SCHEMA = 'kauro', TABLE = 'report_branding_bindings';
  END IF;
  NEW.bound_at := kauro.server_now();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION kauro.report_branding_bindings_birth() FROM PUBLIC;
DROP TRIGGER IF EXISTS report_branding_bindings_birth ON kauro.report_branding_bindings;
CREATE TRIGGER report_branding_bindings_birth BEFORE INSERT ON kauro.report_branding_bindings
  FOR EACH ROW EXECUTE FUNCTION kauro.report_branding_bindings_birth();
DROP TRIGGER IF EXISTS report_branding_bindings_append_only ON kauro.report_branding_bindings;
CREATE TRIGGER report_branding_bindings_append_only BEFORE UPDATE OR DELETE ON kauro.report_branding_bindings
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
DROP TRIGGER IF EXISTS report_branding_bindings_no_truncate ON kauro.report_branding_bindings;
CREATE TRIGGER report_branding_bindings_no_truncate BEFORE TRUNCATE ON kauro.report_branding_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
ALTER TABLE kauro.report_branding_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.report_branding_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS report_branding_bindings_control_read ON kauro.report_branding_bindings;
DROP POLICY IF EXISTS report_branding_bindings_control_record ON kauro.report_branding_bindings;
CREATE POLICY report_branding_bindings_control_read ON kauro.report_branding_bindings FOR SELECT TO kauro_control USING (agency_id = kauro.current_agency_id());
CREATE POLICY report_branding_bindings_control_record ON kauro.report_branding_bindings FOR INSERT TO kauro_control WITH CHECK (agency_id = kauro.current_agency_id());
GRANT SELECT ON kauro.report_branding_bindings TO kauro_control;
GRANT INSERT (agency_id, job_id, branding_version) ON kauro.report_branding_bindings TO kauro_control;

-- --- 3. the control plane's read of the report's bindings ---------------------------------------------------------------------------------
-- the quote the job's authorization names: the members of its KAURO_QUOTE_TERMS_V1 preimage, its recorded hash and version, and its state
DROP POLICY IF EXISTS quotes_control_report_read ON kauro.quotes;
CREATE POLICY quotes_control_report_read ON kauro.quotes FOR SELECT TO kauro_control USING (agency_id = kauro.current_agency_id());
GRANT SELECT (
  quote_id, agency_id, project_id, plan_id, approval_id, state, revision_hash, plan_hash, target_contract_hash, billable_units, mode,
  price_policy_version, discount_policy_version, base_service_cents, discount_bps, discount_cents, service_cents, fiscal_profile_id, issuer_ref,
  tax_treatment, tax_rule, tax_rate_bps, tax_cents, total_cents, currency, eligibility_snapshot_id, terms_hash, terms_version, issued_at,
  expires_at, source_available_until
) ON kauro.quotes TO kauro_control;
-- the agency's acceptance of a terms version with its exact document (CMD002), never the person who accepted it
DROP POLICY IF EXISTS agency_agreement_acceptances_control_read ON kauro.agency_agreement_acceptances;
CREATE POLICY agency_agreement_acceptances_control_read ON kauro.agency_agreement_acceptances FOR SELECT TO kauro_control USING (agency_id = kauro.current_agency_id());
GRANT SELECT (acceptance_id, agency_id, terms_kind, terms_version, terms_document_hash, accepted_at) ON kauro.agency_agreement_acceptances TO kauro_control;
-- the hash of the disclosure set the approval was granted over (approvals_control_execution_read, 0021, already binds the agency)
GRANT SELECT (disclosures_hash) ON kauro.approvals TO kauro_control;
