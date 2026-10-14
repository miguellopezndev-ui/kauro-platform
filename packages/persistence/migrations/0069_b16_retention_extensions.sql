-- Migration 0069: B16 lane L2, CMD060 RequestRetentionExtension.
--
-- 09 "Quotes, reuploads and retention", R2-123/R2-124, plan conflict C1: a project's soft access deadline may be extended ONCE, by at
-- most 259200 seconds, never past the original hard cap; the hard deadline never moves.
--   1. kauro.retention_extensions: the one extension row per project (UNIQUE (agency_id, project_id)), append-only, bound to its
--      retention record by a composite key. The CHECKs derive the endpoint: soft_deadline = least(previous + requested seconds, hard),
--      so no writer can store an endpoint the formula does not give.
--   2. kauro.retention_records_soft_deadline() gets its second named path (rule 12: each path its own predicate and forged control):
--        path A (control plane, KA084/KA004): the first package sets the soft deadline once, from the PACKAGE_AVAILABLE anchor;
--        path B (request session, KA085 = B16_L2_RETENTION_A, PR #97 owns the range): the soft deadline moves only together with the
--        extension row of THIS transaction, written by the same user, from the stored soft deadline to the stored endpoint.
--   3. The request role may UPDATE only (soft_deadline, effective_deadline, version) of an ACTIVE paid record of its own agency.
--   4. The event retention_record.extended.v1 (consumer AUTHORITY_JOURNAL) is a known event type.
CREATE TABLE kauro.retention_extensions (
  extension_id                uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(extension_id)),
  agency_id                   uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id                  uuid NOT NULL,
  retention_id                uuid NOT NULL,
  requested_seconds           integer NOT NULL CHECK (requested_seconds BETWEEN 1 AND 259200),
  granted_seconds             integer NOT NULL CHECK (granted_seconds BETWEEN 1 AND requested_seconds),
  previous_soft_deadline      timestamptz NOT NULL,
  soft_deadline               timestamptz NOT NULL,
  hard_deadline               timestamptz NOT NULL,
  capped_at_hard_deadline     boolean NOT NULL,
  purpose                     text NOT NULL CHECK (kauro.is_label(purpose)),
  terms_version               text NOT NULL CHECK (kauro.is_label(terms_version)),
  requested_by_membership_id  uuid NOT NULL,
  requested_by_user_id        uuid NOT NULL REFERENCES kauro.identities (user_id),
  created_at                  timestamptz NOT NULL,
  CONSTRAINT retention_extensions_one_per_project UNIQUE (agency_id, project_id),
  CONSTRAINT retention_extensions_endpoint CHECK (
    soft_deadline = least(previous_soft_deadline + requested_seconds * interval '1 second', hard_deadline)
    AND soft_deadline > previous_soft_deadline
    AND capped_at_hard_deadline = (previous_soft_deadline + requested_seconds * interval '1 second' > hard_deadline)
    AND granted_seconds = floor(extract(epoch FROM (soft_deadline - previous_soft_deadline)))
  ),
  FOREIGN KEY (agency_id, requested_by_membership_id, requested_by_user_id) REFERENCES kauro.memberships (agency_id, membership_id, user_id)
);
-- the record the extension belongs to, on the same project (a composite key, the pattern of every tenant child)
ALTER TABLE kauro.retention_records ADD CONSTRAINT retention_records_extension_key UNIQUE (agency_id, retention_id, project_id);
ALTER TABLE kauro.retention_extensions
  ADD CONSTRAINT retention_extensions_record_fk FOREIGN KEY (agency_id, retention_id, project_id) REFERENCES kauro.retention_records (agency_id, retention_id, project_id);
CREATE TRIGGER retention_extensions_append_only BEFORE UPDATE OR DELETE ON kauro.retention_extensions
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

ALTER TABLE kauro.retention_extensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.retention_extensions FORCE ROW LEVEL SECURITY;
CREATE POLICY retention_extensions_tenant_read ON kauro.retention_extensions FOR SELECT TO kauro_app
  USING (agency_id = kauro.current_agency_id());
CREATE POLICY retention_extensions_tenant_insert ON kauro.retention_extensions FOR INSERT TO kauro_app
  WITH CHECK (
    agency_id = kauro.current_agency_id() AND requested_by_user_id = kauro.current_user_id() AND created_at = kauro.server_now()
    AND EXISTS (
      SELECT 1 FROM kauro.retention_records r
       WHERE r.agency_id = retention_extensions.agency_id AND r.retention_id = retention_extensions.retention_id AND r.project_id = retention_extensions.project_id
         AND r.class IN ('PAID_ORDINARY', 'PAID_STAGED') AND r.state = 'ACTIVE'
         AND r.soft_deadline = retention_extensions.previous_soft_deadline AND r.hard_deadline = retention_extensions.hard_deadline
    )
  );
-- the control plane reads the extension to write the durable AUTHORITY_JOURNAL tombstone (subject read of the consumer)
CREATE POLICY retention_extensions_control_read ON kauro.retention_extensions FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
GRANT SELECT, INSERT ON kauro.retention_extensions TO kauro_app;
GRANT SELECT ON kauro.retention_extensions TO kauro_control;

-- the request session's update of the record: an ACTIVE paid record of its own agency, the three columns the extension moves
CREATE POLICY retention_records_tenant_extend ON kauro.retention_records FOR UPDATE TO kauro_app
  USING (agency_id = kauro.current_agency_id())
  WITH CHECK (agency_id = kauro.current_agency_id() AND class IN ('PAID_ORDINARY', 'PAID_STAGED') AND state = 'ACTIVE');
GRANT UPDATE (soft_deadline, effective_deadline, version) ON kauro.retention_records TO kauro_app;

CREATE OR REPLACE FUNCTION kauro.retention_records_soft_deadline() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF pg_catalog.pg_has_role(current_user, 'kauro_app', 'USAGE') THEN
    -- path B: a request session moves the soft deadline only with its own extension row of this transaction (CMD060)
    IF OLD.soft_deadline IS NULL OR OLD.class NOT IN ('PAID_ORDINARY', 'PAID_STAGED') OR NOT EXISTS (
      SELECT 1 FROM kauro.retention_extensions x
       WHERE x.agency_id = OLD.agency_id AND x.retention_id = OLD.retention_id AND x.project_id = OLD.project_id
         AND x.created_at = kauro.server_now() AND x.requested_by_user_id = kauro.current_user_id()
         AND x.previous_soft_deadline = OLD.soft_deadline AND x.soft_deadline = NEW.soft_deadline AND x.hard_deadline = OLD.hard_deadline
    ) THEN
      -- KA085 B16_L2_RETENTION_A (PR #97)
      RAISE EXCEPTION 'EXTENSION_EVIDENCE: the soft deadline of retention record % moves only with its extension row of this transaction', OLD.retention_id USING ERRCODE = 'KA085';
    END IF;
    RETURN NEW;
  END IF;
  -- path A: the first package sets it, once (unchanged from migration 0022)
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
REVOKE EXECUTE ON FUNCTION kauro.retention_records_soft_deadline() FROM PUBLIC;

ALTER TABLE kauro.event_types NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.event_types (event_type) VALUES ('retention_record.extended.v1');
ALTER TABLE kauro.event_types FORCE ROW LEVEL SECURITY;
