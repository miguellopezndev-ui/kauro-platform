-- Migration 0110: Order 21, the UNPAID extension of CP-01.02 (retention policy R2-RETENTION-2), built against the Order 19A re-issue
-- candidate with its activation OFF.
--
-- CP-01.02 (owner, 2026-10-22): the free check may pass 14 days from sealing only when the project's one extension (up to 72 hours) is
-- expressly requested and authorised, never past 17 days from sealing; one extension per project across classes; without it nothing
-- changes. For an UNPAID record the extension sets soft = min(previous soft + requested, seal + 17 days) and moves the record's hard
-- deadline to that value when it passes it; a record with no soft deadline yet (none is written for UNPAID today) takes its end, the
-- hard deadline, as the previous soft. Activation needs Order 19B's adoption of CP-01.02 and the legal procedure for LR-01 (LEGAL_PROCEDURE_C2): until then
-- kauro.retention_r2_2_active() answers false, every new check below refuses an UNPAID extension, and the served behaviour is the one of
-- migration 0069. Activation is one migration that replaces that function (nothing else changes).
--
--   1. kauro.retention_r2_2_active(): the activation switch, false.
--   2. retention_records.extended_hard_deadline: the hard deadline an UNPAID extension moved, set once, by the request session's
--      extension of this transaction only, never past hard_deadline + 259200 s (the policy's hard_deadline of an UNPAID record is the
--      seal + 1209600 s, so the bound is seal + 17 days). hard_deadline itself keeps the seal + 14 days the seal bindings check (0011, 0082),
--      so the bytes are never re-sealed past 14 days; the effective deadline is the minimum over the moved hard deadline.
--   3. retention_extensions.ceiling_rule and previous_hard_deadline: an extension of an UNPAID record records its rule
--      (UNPAID_SEAL_17D) and the record's hard deadline; its hard_deadline column is the ceiling and its previous_soft_deadline the
--      record's soft deadline, or its hard deadline when it has none, so the endpoint CHECK of 0069 (soft = least(previous + requested,
--      hard)) is the CP-01.02 formula unchanged. Existing rows are HARD_CAP rows.
--   4. Row policies and the record's triggers admit the UNPAID path only while the switch is on, only for an ACTIVE UNPAID record of the
--      caller's own agency, only with the extension row of this transaction: the record's soft deadline (when it has one) moves to the
--      extension's end, and its hard deadline moves there only when the end passes it.
CREATE OR REPLACE FUNCTION kauro.retention_r2_2_active() RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog AS
$$ SELECT false $$;
COMMENT ON FUNCTION kauro.retention_r2_2_active() IS 'CP-01.02 (R2-RETENTION-2) activation switch: false until Order 19B adopts CP-01.02 and LEGAL_PROCEDURE_C2 records LR-01';
GRANT EXECUTE ON FUNCTION kauro.retention_r2_2_active() TO kauro_app, kauro_control;

-- --- 2. the moved hard deadline of an UNPAID record ------------------------------------------------------------------------------
ALTER TABLE kauro.retention_records ADD COLUMN extended_hard_deadline timestamptz;
ALTER TABLE kauro.retention_records ADD CONSTRAINT retention_records_extended_hard_bound CHECK (
  extended_hard_deadline IS NULL
  OR (class = 'UNPAID' AND extended_hard_deadline > hard_deadline AND extended_hard_deadline <= hard_deadline + interval '259200 seconds')
);
ALTER TABLE kauro.retention_records DROP CONSTRAINT retention_records_effective_is_minimum;
ALTER TABLE kauro.retention_records ADD CONSTRAINT retention_records_effective_is_minimum CHECK (
  effective_deadline = CASE WHEN soft_deadline IS NULL THEN coalesce(extended_hard_deadline, hard_deadline)
                            ELSE least(soft_deadline, coalesce(extended_hard_deadline, hard_deadline)) END
);

-- --- 3. the extension's rule ----------------------------------------------------------------------------------------------------
ALTER TABLE kauro.retention_extensions ADD COLUMN ceiling_rule text NOT NULL DEFAULT 'HARD_CAP' CHECK (ceiling_rule IN ('HARD_CAP', 'UNPAID_SEAL_17D'));
ALTER TABLE kauro.retention_extensions ADD COLUMN previous_hard_deadline timestamptz;
ALTER TABLE kauro.retention_extensions ADD CONSTRAINT retention_extensions_ceiling_rule CHECK (
  (ceiling_rule = 'HARD_CAP' AND previous_hard_deadline IS NULL)
  OR (ceiling_rule = 'UNPAID_SEAL_17D' AND previous_hard_deadline IS NOT NULL
      AND hard_deadline = previous_hard_deadline + interval '259200 seconds' AND previous_soft_deadline <= previous_hard_deadline)
);

-- --- 4. the request session's UNPAID path, only while CP-01.02 is active --------------------------------------------------------
CREATE POLICY retention_extensions_tenant_insert_unpaid ON kauro.retention_extensions FOR INSERT TO kauro_app
  WITH CHECK (
    kauro.retention_r2_2_active() AND ceiling_rule = 'UNPAID_SEAL_17D'
    AND agency_id = kauro.current_agency_id() AND requested_by_user_id = kauro.current_user_id() AND created_at = kauro.server_now()
    AND EXISTS (
      SELECT 1 FROM kauro.retention_records r
       WHERE r.agency_id = retention_extensions.agency_id AND r.retention_id = retention_extensions.retention_id AND r.project_id = retention_extensions.project_id
         AND r.class = 'UNPAID' AND r.state = 'ACTIVE' AND r.extended_hard_deadline IS NULL
         AND r.hard_deadline = retention_extensions.previous_hard_deadline
         AND coalesce(r.soft_deadline, r.hard_deadline) = retention_extensions.previous_soft_deadline
    )
  );
-- the paid path of 0069 admits only HARD_CAP rows (re-created with that predicate; otherwise unchanged)
DROP POLICY retention_extensions_tenant_insert ON kauro.retention_extensions;
CREATE POLICY retention_extensions_tenant_insert ON kauro.retention_extensions FOR INSERT TO kauro_app
  WITH CHECK (
    ceiling_rule = 'HARD_CAP'
    AND agency_id = kauro.current_agency_id() AND requested_by_user_id = kauro.current_user_id() AND created_at = kauro.server_now()
    AND EXISTS (
      SELECT 1 FROM kauro.retention_records r
       WHERE r.agency_id = retention_extensions.agency_id AND r.retention_id = retention_extensions.retention_id AND r.project_id = retention_extensions.project_id
         AND r.class IN ('PAID_ORDINARY', 'PAID_STAGED') AND r.state = 'ACTIVE'
         AND r.soft_deadline = retention_extensions.previous_soft_deadline AND r.hard_deadline = retention_extensions.hard_deadline
    )
  );
CREATE POLICY retention_records_tenant_extend_unpaid ON kauro.retention_records FOR UPDATE TO kauro_app
  USING (agency_id = kauro.current_agency_id() AND class = 'UNPAID' AND kauro.retention_r2_2_active())
  WITH CHECK (agency_id = kauro.current_agency_id() AND class = 'UNPAID' AND state = 'ACTIVE' AND kauro.retention_r2_2_active());
GRANT UPDATE (extended_hard_deadline) ON kauro.retention_records TO kauro_app;

-- the moved hard deadline: set once, by the request session, only with its own UNPAID extension row of this transaction
CREATE OR REPLACE FUNCTION kauro.retention_records_extended_hard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.extended_hard_deadline IS NOT NULL THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: the extended hard deadline of retention record % is set once', OLD.retention_id USING ERRCODE = 'KA004';
  END IF;
  IF NOT kauro.retention_r2_2_active() OR NOT pg_catalog.pg_has_role(current_user, 'kauro_app', 'USAGE') OR OLD.class <> 'UNPAID' OR NOT EXISTS (
    SELECT 1 FROM kauro.retention_extensions x
     WHERE x.agency_id = OLD.agency_id AND x.retention_id = OLD.retention_id AND x.project_id = OLD.project_id AND x.ceiling_rule = 'UNPAID_SEAL_17D'
       AND x.created_at = kauro.server_now() AND x.requested_by_user_id = kauro.current_user_id()
       AND x.previous_hard_deadline = OLD.hard_deadline AND x.previous_soft_deadline = coalesce(OLD.soft_deadline, OLD.hard_deadline)
       AND x.soft_deadline = NEW.extended_hard_deadline
  ) THEN
    RAISE EXCEPTION 'EXTENSION_EVIDENCE: the hard deadline of UNPAID retention record % moves only with its CP-01.02 extension row of this transaction', OLD.retention_id USING ERRCODE = 'KA085';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION kauro.retention_records_extended_hard() FROM PUBLIC;
CREATE TRIGGER retention_records_extended_hard BEFORE UPDATE OF extended_hard_deadline ON kauro.retention_records
  FOR EACH ROW WHEN (OLD.extended_hard_deadline IS DISTINCT FROM NEW.extended_hard_deadline) EXECUTE FUNCTION kauro.retention_records_extended_hard();

-- the soft deadline of an UNPAID record (when it has one): its second request path (path C), beside the paid path B of 0069; path A (the
-- control plane's first package) is unchanged
CREATE OR REPLACE FUNCTION kauro.retention_records_soft_deadline() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF pg_catalog.pg_has_role(current_user, 'kauro_app', 'USAGE') THEN
    IF OLD.class = 'UNPAID' THEN
      -- path C (CP-01.02): only while the switch is on, only with its own UNPAID extension row of this transaction
      IF OLD.soft_deadline IS NULL OR NOT kauro.retention_r2_2_active() OR NOT EXISTS (
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
