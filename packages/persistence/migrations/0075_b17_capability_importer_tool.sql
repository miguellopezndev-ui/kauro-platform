-- Migration 0075: B17 lane L4 VENDOR, the importer tool a capability claims (S078; provisional number, the coordinator renumbers on merge).
--
-- R2 S078 "REST was tested but Data Loader compatibility is claimed. Required outcome: Reject tool mismatch; require actual selected
-- importer and export-back evidence". CMD058 compares the tool a vendor qualification actually tested (vendor_qualifications.tool, 0073)
-- with the importer tool the capability claims. The claim is this column: the importer-profile catalogue tool id of the capability (for
-- example SALESFORCE_DATA_LOADER), NULL for a capability that claims no importer tool (a CLEAN mode). It is learned once: it is set while
-- NULL and never changes afterwards; no runtime request session has an UPDATE grant on it (0051 grants state, revision, updated_at only).
-- A capability that needs a qualification and claims no tool has nothing to match: its qualification is a tool mismatch.
ALTER TABLE kauro.capabilities
  ADD COLUMN importer_tool text CHECK (importer_tool IS NULL OR kauro.is_label(importer_tool));

CREATE OR REPLACE FUNCTION kauro.capabilities_importer_tool_once() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.importer_tool IS NOT NULL AND NEW.importer_tool IS DISTINCT FROM OLD.importer_tool THEN
    RAISE EXCEPTION 'the importer tool a capability claims is learned once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER capabilities_importer_tool_once BEFORE UPDATE OF importer_tool ON kauro.capabilities
  FOR EACH ROW EXECUTE FUNCTION kauro.capabilities_importer_tool_once();
REVOKE EXECUTE ON FUNCTION kauro.capabilities_importer_tool_once() FROM PUBLIC;
