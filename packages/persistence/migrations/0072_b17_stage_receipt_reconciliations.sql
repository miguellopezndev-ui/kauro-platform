-- Migration 0072: B17 lane L0D KIT-DB, the stage-receipt half of R2-023 and R2-025 (provisional number; the coordinator renumbers on merge).
--
-- docs/design/B15-B17-B18-local-plan.md section 5 M1 (CMD040) and M2 (CMD041), section 2 R2-023 / R2-025:
--   1. kauro.import_stages.parent_edges: the explicit parent identity each child source depends on, one edge
--      {childSourceId, parentStageId, parentSourceId} per dependency. An edge names a source of this stage and a stage of its own
--      parent_stage_ids; the edges are compiled with the stage (B08) and never change (CMD041 admits a child source iff every edge of it
--      is MATCHED in that parent's latest receipt mapping; R2 05 "Dependent stages can proceed only for an approved subset with complete
--      parent identities").
--   2. kauro.stage_receipt_reconciliations: a differing receipt for a finalized stage opens one reconciliation and never overwrites the
--      stage's identity (R2 05:115). Append-only, born OPEN, opened_at is the database's instant. The birth trigger refuses (23514) a
--      reconciliation of a stage that is not VERIFIED_SUCCESS or VERIFIED_PARTIAL (read FOR SHARE, so it is ordered with the stage's
--      writer), an upload that is not a STAGE_RECEIPT artifact of the stage's own agency, project and instance with exactly this
--      content hash, and a content hash that is already a receipt file of the stage (identical content is idempotent, never a
--      reconciliation). One reconciliation per (stage, content hash).

-- --- parent edges ----------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kauro.import_stage_edges_bound(edges jsonb, parent_stage_ids jsonb, source_ids jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$
  SELECT jsonb_typeof(edges) = 'array'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(edges) AS e(edge)
        WHERE jsonb_typeof(e.edge) IS DISTINCT FROM 'object'
           OR (SELECT count(*) FROM jsonb_object_keys(e.edge)) <> 3
           OR jsonb_typeof(e.edge -> 'childSourceId') IS DISTINCT FROM 'string'
           OR jsonb_typeof(e.edge -> 'parentStageId') IS DISTINCT FROM 'string'
           OR jsonb_typeof(e.edge -> 'parentSourceId') IS DISTINCT FROM 'string'
           OR NOT (parent_stage_ids @> jsonb_build_array(e.edge -> 'parentStageId'))
           OR NOT (source_ids @> jsonb_build_array(e.edge -> 'childSourceId'))
     )
$$;

ALTER TABLE kauro.import_stages
  ADD COLUMN parent_edges jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT import_stages_parent_edges_bound CHECK (kauro.import_stage_edges_bound(parent_edges, parent_stage_ids, source_ids));
CREATE TRIGGER import_stages_parent_edges_immutable BEFORE UPDATE ON kauro.import_stages
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('parent_edges');

-- --- reconciliations -------------------------------------------------------------------------------------------------------------------
CREATE TABLE kauro.stage_receipt_reconciliations (
  reconciliation_id         uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(reconciliation_id)),
  agency_id                 uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id                uuid NOT NULL,
  stage_id                  uuid NOT NULL,
  content_hash              text NOT NULL CHECK (kauro.is_sha256_hex(content_hash)),
  receipt_upload_ref        uuid NOT NULL,
  state                     text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN')),
  opened_by_membership_id   uuid NOT NULL,
  opened_at                 timestamptz NOT NULL DEFAULT kauro.server_now(),
  UNIQUE (agency_id, reconciliation_id),
  CONSTRAINT stage_receipt_reconciliations_once UNIQUE (agency_id, stage_id, content_hash),
  FOREIGN KEY (agency_id, project_id, stage_id) REFERENCES kauro.import_stages (agency_id, project_id, stage_id),
  FOREIGN KEY (agency_id, receipt_upload_ref) REFERENCES kauro.target_artifacts (agency_id, artifact_id),
  FOREIGN KEY (agency_id, opened_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id)
);
CREATE TRIGGER stage_receipt_reconciliations_append_only BEFORE UPDATE OR DELETE ON kauro.stage_receipt_reconciliations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER stage_receipt_reconciliations_no_truncate BEFORE TRUNCATE ON kauro.stage_receipt_reconciliations
  FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

CREATE OR REPLACE FUNCTION kauro.stage_receipt_reconciliations_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  s record;
BEGIN
  SELECT x.state, x.instance_id INTO s FROM kauro.import_stages x
   WHERE x.agency_id = NEW.agency_id AND x.project_id = NEW.project_id AND x.stage_id = NEW.stage_id FOR SHARE;
  IF NOT FOUND OR s.state NOT IN ('VERIFIED_SUCCESS', 'VERIFIED_PARTIAL') THEN
    RAISE EXCEPTION 'a receipt reconciliation opens only for a finalized stage (stage % is %)', NEW.stage_id, coalesce(s.state, 'not visible') USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM kauro.target_artifacts a
     WHERE a.agency_id = NEW.agency_id AND a.artifact_id = NEW.receipt_upload_ref AND a.kind = 'STAGE_RECEIPT'
       AND a.project_id = NEW.project_id AND a.instance_id = s.instance_id AND a.content_hash = NEW.content_hash
  ) THEN
    RAISE EXCEPTION 'a receipt reconciliation names a stage-receipt upload of its own stage with exactly its content hash' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM kauro.stage_receipts r WHERE r.agency_id = NEW.agency_id AND r.stage_id = NEW.stage_id AND r.receipt_file_hash = NEW.content_hash
  ) THEN
    RAISE EXCEPTION 'identical receipt content is idempotent: no reconciliation of a receipt the stage already holds' USING ERRCODE = '23514';
  END IF;
  NEW.state := 'OPEN';
  NEW.opened_at := kauro.server_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER stage_receipt_reconciliations_birth BEFORE INSERT ON kauro.stage_receipt_reconciliations
  FOR EACH ROW EXECUTE FUNCTION kauro.stage_receipt_reconciliations_birth();

ALTER TABLE kauro.stage_receipt_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.stage_receipt_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY stage_receipt_reconciliations_tenant_read ON kauro.stage_receipt_reconciliations FOR SELECT TO kauro_app
  USING (agency_id = kauro.current_agency_id());
CREATE POLICY stage_receipt_reconciliations_tenant_open ON kauro.stage_receipt_reconciliations FOR INSERT TO kauro_app
  WITH CHECK (
    agency_id = kauro.current_agency_id()
    AND EXISTS (
      SELECT 1 FROM kauro.memberships m
       WHERE m.agency_id = stage_receipt_reconciliations.agency_id AND m.membership_id = stage_receipt_reconciliations.opened_by_membership_id
         AND m.user_id = kauro.current_user_id() AND m.state = 'ACTIVE' AND m.role IN ('OWNER', 'ADMIN', 'OPERATOR')
    )
  );
GRANT SELECT ON kauro.stage_receipt_reconciliations TO kauro_app;
GRANT INSERT (reconciliation_id, agency_id, project_id, stage_id, content_hash, receipt_upload_ref, opened_by_membership_id)
  ON kauro.stage_receipt_reconciliations TO kauro_app;
