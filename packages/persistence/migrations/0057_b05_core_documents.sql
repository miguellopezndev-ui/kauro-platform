-- 0057 (provisional number; the coordinator renumbers at merge) — B05 L3: the core documents and the plan bindings (D5-14, D5-16).
--
-- core_documents: the Migration Core source profile and target contract a revision's derived data retains, stored verbatim under the hash the
-- core itself names them by (CORE_NATIVE, D5-3); only the core's own loader judges the content at the reader. Append-only: a document is
-- born once and never changes or goes away.
-- core_plan_bindings: planHash -> (the closed MigrationConfig document the plan compiled to, its core-native config hash). Execute and
-- validate translate a plan only through this row, so a draft without its binding does not exist. Append-only.
--
-- Both are written and read by the control plane (kauro_control) under the agency of its work item; nothing here is a tenant surface.

CREATE TABLE kauro.core_documents (
  agency_id   uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  kind        text NOT NULL CHECK (kind IN ('SOURCE_PROFILE', 'TARGET_CONTRACT')),
  doc_hash    text NOT NULL CHECK (kauro.is_sha256_hex(doc_hash)),
  document    jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at  timestamptz NOT NULL DEFAULT kauro.server_now(),
  PRIMARY KEY (agency_id, kind, doc_hash)
);
CREATE TRIGGER core_documents_append_only BEFORE UPDATE OR DELETE ON kauro.core_documents
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

CREATE TABLE kauro.core_plan_bindings (
  plan_hash         text PRIMARY KEY CHECK (kauro.is_sha256_hex(plan_hash)),
  agency_id         uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  config_document   jsonb NOT NULL CHECK (jsonb_typeof(config_document) = 'object'),
  core_config_hash  text NOT NULL CHECK (kauro.is_sha256_hex(core_config_hash)),
  created_at        timestamptz NOT NULL DEFAULT kauro.server_now()
);
CREATE TRIGGER core_plan_bindings_append_only BEFORE UPDATE OR DELETE ON kauro.core_plan_bindings
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

ALTER TABLE kauro.core_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.core_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY core_documents_control_read ON kauro.core_documents FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY core_documents_control_put ON kauro.core_documents FOR INSERT TO kauro_control
  WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.core_plan_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.core_plan_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY core_plan_bindings_control_read ON kauro.core_plan_bindings FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY core_plan_bindings_control_put ON kauro.core_plan_bindings FOR INSERT TO kauro_control
  WITH CHECK (agency_id = kauro.current_agency_id());

GRANT SELECT ON kauro.core_documents, kauro.core_plan_bindings TO kauro_control;
GRANT INSERT (agency_id, kind, doc_hash, document) ON kauro.core_documents TO kauro_control;
GRANT INSERT (plan_hash, agency_id, config_document, core_config_hash) ON kauro.core_plan_bindings TO kauro_control;
