-- Migration 0096 — the agency's stored logos and the logo a branding version names (order 7, registry CMD008 UpdateBranding;
-- docs/design/B13-branding.md).
--
-- 0095 recorded branding versions without a logo ("the stored-logo pipeline is CMD008's"). This migration adds exactly that pipeline's
-- storage, in the database the platform already keeps its small content-addressed documents in (legal_identity_snapshots,
-- selection_manifests): the api has no object store, and a logo is the agency's, not a project's (kauro.stored_objects names a project).
--   1. kauro.agency_branding_logos: the PNGs the safe media pipeline wrote (@kauro/domain branding-logo.ts admitLogo: the upload decoded
--      and written again, metadata dropped), one row per agency and content (agency_branding_logos_one_per_content), named by the SHA-256 of
--      its bytes (agency_branding_logos_content_addressed), at most 512 KiB and 1..2048 pixels a side as IHDR states them
--      (agency_branding_logos_png: the PNG signature, IHDR first, its width and height those recorded), the instant the database's,
--      append-only for every role. The agency's ACTIVE OWNER or ADMIN records one as itself (kauro.acting_branding_manager, 0095); the
--      request handlers and the control plane read their agency's only (FORCE ROW LEVEL SECURITY). Nothing is ever fetched from a URL.
--   2. kauro.agency_branding_versions.logo_id: the logo a version names, or null (the versions 0095 admitted, and a version recorded
--      without one). Held to a logo of the same agency by a composite foreign key (agency_branding_versions_logo_fk), so a version can
--      never name another agency's logo, whatever the request said. A version stays immutable (0095's append-only trigger): a new logo is
--      a new version, and the jobs already bound to an earlier version (report_branding_bindings) keep it.
--   3. agency.branding_versioned.v1: CMD008 moves the agency's version by one with each branding version it records, and every agency
--      version carries its event (agencies_event_per_version, 0005).
-- No existing row, constraint or hash changes; no row is backfilled. Idempotent.

-- --- 1. stored logos --------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kauro.agency_branding_logos (
  agency_id                  uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  logo_id                    uuid NOT NULL,
  logo_sha256                text NOT NULL CHECK (kauro.is_sha256_hex(logo_sha256)),
  media_type                 text NOT NULL CHECK (media_type = 'image/png'),
  width                      integer NOT NULL CHECK (width BETWEEN 1 AND 2048),
  height                     integer NOT NULL CHECK (height BETWEEN 1 AND 2048),
  content                    bytea NOT NULL CHECK (octet_length(content) BETWEEN 57 AND 524288),
  recorded_by_membership_id  uuid NOT NULL,
  recorded_by_user_id        uuid NOT NULL,
  recorded_at                timestamptz NOT NULL,
  PRIMARY KEY (agency_id, logo_id),
  CONSTRAINT agency_branding_logos_one_per_content UNIQUE (agency_id, logo_sha256),
  CONSTRAINT agency_branding_logos_membership_fk FOREIGN KEY (agency_id, recorded_by_membership_id, recorded_by_user_id)
    REFERENCES kauro.memberships (agency_id, membership_id, user_id),
  CONSTRAINT agency_branding_logos_content_addressed CHECK (pg_catalog.encode(pg_catalog.sha256(content), 'hex') = logo_sha256),
  -- the PNG signature, then IHDR as the first chunk (length 13), whose width and height are the recorded ones
  CONSTRAINT agency_branding_logos_png CHECK (
    pg_catalog.substr(content, 1, 16) = '\x89504e470d0a1a0a0000000d49484452'::bytea
    AND pg_catalog.get_byte(content, 16)::bigint * 16777216 + pg_catalog.get_byte(content, 17) * 65536 + pg_catalog.get_byte(content, 18) * 256 + pg_catalog.get_byte(content, 19) = width
    AND pg_catalog.get_byte(content, 20)::bigint * 16777216 + pg_catalog.get_byte(content, 21) * 65536 + pg_catalog.get_byte(content, 22) * 256 + pg_catalog.get_byte(content, 23) = height
  )
);
CREATE OR REPLACE FUNCTION kauro.agency_branding_logos_stamp() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  NEW.recorded_at := kauro.server_now();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION kauro.agency_branding_logos_stamp() FROM PUBLIC;
DROP TRIGGER IF EXISTS agency_branding_logos_stamp ON kauro.agency_branding_logos;
CREATE TRIGGER agency_branding_logos_stamp BEFORE INSERT ON kauro.agency_branding_logos
  FOR EACH ROW EXECUTE FUNCTION kauro.agency_branding_logos_stamp();
DROP TRIGGER IF EXISTS agency_branding_logos_append_only ON kauro.agency_branding_logos;
CREATE TRIGGER agency_branding_logos_append_only BEFORE UPDATE OR DELETE ON kauro.agency_branding_logos
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
DROP TRIGGER IF EXISTS agency_branding_logos_no_truncate ON kauro.agency_branding_logos;
CREATE TRIGGER agency_branding_logos_no_truncate BEFORE TRUNCATE ON kauro.agency_branding_logos
  FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

ALTER TABLE kauro.agency_branding_logos ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.agency_branding_logos FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agency_branding_logos_tenant_read ON kauro.agency_branding_logos;
DROP POLICY IF EXISTS agency_branding_logos_tenant_record ON kauro.agency_branding_logos;
DROP POLICY IF EXISTS agency_branding_logos_control_read ON kauro.agency_branding_logos;
CREATE POLICY agency_branding_logos_tenant_read ON kauro.agency_branding_logos FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY agency_branding_logos_tenant_record ON kauro.agency_branding_logos FOR INSERT TO kauro_app
  WITH CHECK (agency_id = kauro.current_agency_id() AND kauro.acting_branding_manager(agency_id, recorded_by_membership_id, recorded_by_user_id));
CREATE POLICY agency_branding_logos_control_read ON kauro.agency_branding_logos FOR SELECT TO kauro_control USING (agency_id = kauro.current_agency_id());
GRANT SELECT ON kauro.agency_branding_logos TO kauro_app, kauro_control;
GRANT INSERT (agency_id, logo_id, logo_sha256, media_type, width, height, content, recorded_by_membership_id, recorded_by_user_id) ON kauro.agency_branding_logos TO kauro_app;

-- --- 2. the logo a branding version names -------------------------------------------------------------------------------------------
ALTER TABLE kauro.agency_branding_versions ADD COLUMN IF NOT EXISTS logo_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'agency_branding_versions_logo_fk' AND conrelid = 'kauro.agency_branding_versions'::regclass) THEN
    ALTER TABLE kauro.agency_branding_versions ADD CONSTRAINT agency_branding_versions_logo_fk FOREIGN KEY (agency_id, logo_id)
      REFERENCES kauro.agency_branding_logos (agency_id, logo_id);
  END IF;
END
$$;
GRANT INSERT (logo_id) ON kauro.agency_branding_versions TO kauro_app;

-- --- 3. the agency event of a new branding version (@kauro/domain EVENT_TYPES) ------------------------------------------------------
-- the vocabulary is extended by lifting FORCE for this migration's own transaction, as 0013, 0028, 0046, 0080 and 0088 do, and restoring it before COMMIT
ALTER TABLE kauro.event_types NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.event_types (event_type) VALUES ('agency.branding_versioned.v1') ON CONFLICT DO NOTHING;
ALTER TABLE kauro.event_types FORCE ROW LEVEL SECURITY;
