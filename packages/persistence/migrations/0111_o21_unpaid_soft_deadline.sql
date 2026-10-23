-- Migration 0111: Order 21 (remainder of review F-2), the UNPAID soft deadline of CP-01.02 (retention policy R2-RETENTION-2), behind the
-- switch of migration 0110 (kauro.retention_r2_2_active(), false until Order 19B adopts CP-01.02).
--
-- 09 "Retention schedule" (unpaid audit sources: seven days after DRAFT_READY or terminal failure, no later than fourteen days from
-- sealing); policy retention.unpaidDaysFromReady = 7; B07 D-RET-2 (the effective deadline is the hard deadline until the audit package
-- sets the soft deadline, only earlier); domain unpaidSoftDeadline. While the switch is on, the transaction that ends an audit (the state
-- that stamps its terminal_at: DRAFT_READY, NEEDS_DECISION, UNSUPPORTED, FAILED, CANCELLED, EXPIRED) writes its revision's AUDIT_TERMINAL
-- anchor and sets the revision's ACTIVE UNPAID record's soft deadline once: least(anchor + 604800 s, hard deadline), the effective deadline
-- with it. A record whose hard deadline an extension already moved keeps it (a granted end is never taken back). Retries never extend it:
-- the anchor is once per revision (B07's index) and the soft deadline is set once. CMD060's base, coalesce(soft, hard) (0110), then reads
-- a real soft deadline. While the switch is off nothing here admits a write: no anchor, no soft deadline, the served behaviour unchanged.
-- Existing rows are not touched.
--
--   1. The anchor kind AUDIT_TERMINAL (D-ANCH-1), bound at commit to an audit of the revision whose terminal_at is the anchor's instant.
--   2. Its writers: the producers of an audit's end, the control plane (orchestration, expiry) and the request handlers (CMD021 CancelAudit),
--      only while the switch is on; the request handlers may then publish that one execution-control event type for an UNPAID record.
--   3. kauro.retention_records_soft_deadline() gets path D (UNPAID, no soft deadline yet): only with the AUDIT_TERMINAL anchor of this
--      transaction and exactly its formula; paths A, B and C are unchanged. The control plane's row policy for that one update.

-- --- 1. the anchor -------------------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.retention_anchor_kinds NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.retention_anchor_kinds (anchor_kind) VALUES ('AUDIT_TERMINAL');
ALTER TABLE kauro.retention_anchor_kinds FORCE ROW LEVEL SECURITY;

-- The superset of 0022's binding (every arm unchanged): an AUDIT_TERMINAL anchor records an audit of this revision that reached its end
-- in this very transaction, at exactly the anchor's instant.
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
    WHEN 'AUDIT_TERMINAL' THEN
      bound := EXISTS (
        SELECT 1 FROM kauro.audits a
         WHERE a.agency_id = NEW.agency_id AND a.project_id = NEW.project_id AND a.revision_id = NEW.revision_id AND a.terminal_at = NEW.occurred_at
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

-- --- 2. its writers, only while CP-01.02 is active -----------------------------------------------------------------------------
CREATE POLICY retention_anchors_audit_terminal ON kauro.retention_anchors FOR INSERT TO kauro_app, kauro_control
  WITH CHECK (agency_id = kauro.current_agency_id() AND anchor_kind = 'AUDIT_TERMINAL' AND upload_id IS NULL AND kauro.retention_r2_2_active());

-- the request handlers' one event of an execution-control type (0021, 0022): the soft deadline their own CMD021 cancellation set on an
-- UNPAID record (path D below), only while the switch is on; every other execution-control type stays the control plane's
DROP POLICY domain_events_tenant_not_execution_control ON kauro.domain_events;
CREATE POLICY domain_events_tenant_not_execution_control ON kauro.domain_events AS RESTRICTIVE FOR INSERT TO kauro_app
  WITH CHECK (
    NOT (event_type = ANY (kauro.execution_control_event_types()))
    OR (event_type = 'retention_record.soft_deadline_set.v1' AND aggregate_kind = 'retention_record' AND payload ->> 'retentionClass' = 'UNPAID'
        AND kauro.retention_r2_2_active())
  );

-- --- 3. the soft deadline ---------------------------------------------------------------------------------------------------------
-- the control plane's update of an ACTIVE UNPAID record of its agency (path D is the only one its trigger admits for that class)
CREATE POLICY retention_records_control_unpaid_soft ON kauro.retention_records FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id() AND class = 'UNPAID' AND kauro.retention_r2_2_active())
  WITH CHECK (agency_id = kauro.current_agency_id() AND class = 'UNPAID' AND state = 'ACTIVE' AND kauro.retention_r2_2_active());

-- 0110's function with path D first (UNPAID, no soft deadline yet); paths C, B and A unchanged
CREATE OR REPLACE FUNCTION kauro.retention_records_soft_deadline() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.class = 'UNPAID' AND OLD.soft_deadline IS NULL THEN
    -- path D (CP-01.02): set once, by the producer of the audit's end, with the AUDIT_TERMINAL anchor of this transaction
    IF OLD.extended_hard_deadline IS NOT NULL OR NOT kauro.retention_r2_2_active() OR NOT EXISTS (
      SELECT 1 FROM kauro.retention_anchors a
       WHERE a.agency_id = OLD.agency_id AND a.project_id = OLD.project_id AND a.revision_id = OLD.revision_id AND a.anchor_kind = 'AUDIT_TERMINAL'
         AND a.occurred_at = kauro.server_now() AND NEW.soft_deadline = least(a.occurred_at + interval '604800 seconds', OLD.hard_deadline)
    ) THEN
      RAISE EXCEPTION 'PUBLICATION_EVIDENCE: the soft deadline of UNPAID retention record % is its revision''s audit end + 604800 s, never past the hard deadline, written with that end', OLD.retention_id USING ERRCODE = 'KA084';
    END IF;
    RETURN NEW;
  END IF;
  IF pg_catalog.pg_has_role(current_user, 'kauro_app', 'USAGE') THEN
    IF OLD.class = 'UNPAID' THEN
      -- path C (CP-01.02): only while the switch is on, only with its own UNPAID extension row of this transaction
      IF NOT kauro.retention_r2_2_active() OR NOT EXISTS (
        SELECT 1 FROM kauro.retention_extensions x
         WHERE x.agency_id = OLD.agency_id AND x.retention_id = OLD.retention_id AND x.project_id = OLD.project_id AND x.ceiling_rule = 'UNPAID_SEAL_17D'
           AND x.created_at = kauro.server_now() AND x.requested_by_user_id = kauro.current_user_id()
           AND x.previous_soft_deadline = OLD.soft_deadline AND x.soft_deadline = NEW.soft_deadline AND x.previous_hard_deadline = OLD.hard_deadline
      ) THEN
        RAISE EXCEPTION 'EXTENSION_EVIDENCE: the soft deadline of UNPAID retention record % moves only with its CP-01.02 extension row of this transaction', OLD.retention_id USING ERRCODE = 'KA085';
      END IF;
      RETURN NEW;
    END IF;
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
