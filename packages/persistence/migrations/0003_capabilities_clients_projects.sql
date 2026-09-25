-- 0003 — capabilities, processing authorities, end clients, projects, dataset revisions, target contracts.
--
-- Authority: 07 "Aggregate ownership" (ClientWorkspace owns a scoped end-client label and purpose without a global CRM
-- identity; Project owns purchased business intent and its revision lineage; SourceRevision owns immutable selected inputs;
-- TargetInstance/TargetSchemaVersion own target identity), 07 "Database representation" (composite foreign keys prevent a
-- project in one agency from referencing another agency's revision, quote, package or client), 02 "Intake and project
-- boundaries" (a project belongs to exactly one agency and one end-client workspace), 02 "Capability publication
-- contract", registry contracts EndClient, Capability, DatasetRevision, TargetContract; registry machines DatasetRevision,
-- Capability. Decisions D-AGG-1 (Project shape and states), D-AGG-2 (EndClient version), D-CMD-4 (target ref per mode).

-- --- capabilities (platform-wide, not tenant-owned) ----------------------------------------------------------------------------
CREATE TABLE kauro.capabilities (
  capability_id                  uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(capability_id)),
  version                        text NOT NULL CHECK (kauro.is_label(version)),
  kind                           text NOT NULL CHECK (kind IN ('MODE', 'OBJECT', 'OPERATION', 'TOOL', 'ENVELOPE')),
  mode                           text CHECK (mode IS NULL OR mode IN ('CLEAN', 'HUBSPOT', 'SALESFORCE')),
  state                          text NOT NULL CHECK (state IN ('DESIGN', 'IMPLEMENTED_UNACCEPTED', 'QUALIFIED_INTERNAL', 'AVAILABLE_LIMITED', 'AVAILABLE', 'SUSPENDED')),
  profile_hash                   text NOT NULL CHECK (kauro.is_sha256_hex(profile_hash)),
  qualification_evidence_hashes  jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(qualification_evidence_hashes) = 'array'),
  valid_from                     timestamptz,
  review_trigger                 text NOT NULL CHECK (kauro.is_label(review_trigger)),
  created_at                     timestamptz NOT NULL,
  updated_at                     timestamptz NOT NULL,
  CONSTRAINT capabilities_mode_kind CHECK ((kind = 'MODE') = (mode IS NOT NULL)),
  -- "No state name proves that the corresponding software exists": a qualified or offered capability cites evidence.
  CONSTRAINT capabilities_qualified_cite_evidence CHECK (
    state NOT IN ('QUALIFIED_INTERNAL', 'AVAILABLE_LIMITED', 'AVAILABLE') OR jsonb_array_length(qualification_evidence_hashes) > 0
  )
);
CREATE UNIQUE INDEX capabilities_mode_version ON kauro.capabilities (mode, version) WHERE kind = 'MODE';
-- the admission predicate of CMD011 reads exactly one offered capability per mode
CREATE UNIQUE INDEX capabilities_one_offered_per_mode ON kauro.capabilities (mode)
  WHERE kind = 'MODE' AND state IN ('AVAILABLE_LIMITED', 'AVAILABLE');
CREATE TRIGGER capabilities_touch BEFORE UPDATE ON kauro.capabilities FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER capabilities_immutable BEFORE UPDATE ON kauro.capabilities
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('capability_id,kind,mode,created_at');
CREATE TRIGGER capabilities_transition BEFORE UPDATE OF state ON kauro.capabilities
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('Capability');
-- D-CAP-2: a capability row is born DESIGN (registry Capability initial state) under any revision label; an offered state is
-- reached only through the listed edges, each recording its gate's evidence
CREATE TRIGGER capabilities_initial_state BEFORE INSERT ON kauro.capabilities
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('Capability');
-- CMD011 relies on the offered capability of the requested mode when the project commits (catalogue precondition "the
-- requested mode is offered"): a MODE capability's state is a transition subject keyed by its mode (D-TX-2), so a suspension —
-- or a new version becoming offered — issued while a project creation is in flight waits for it, and creations arriving after
-- it wait behind it (re-check finding N3). A capability of another kind is its own subject.
CREATE OR REPLACE FUNCTION kauro.capabilities_transition_lock() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM pg_advisory_xact_lock(kauro.transition_key('kauro.capabilities', coalesce(OLD.mode, OLD.capability_id::text)));
  RETURN NEW;
END
$$;
CREATE TRIGGER capabilities_transition_lock BEFORE UPDATE OF state ON kauro.capabilities
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.capabilities_transition_lock();

INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('Capability', 'DESIGN');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('Capability', 'DESIGN', 'IMPLEMENTED_UNACCEPTED'),
  ('Capability', 'IMPLEMENTED_UNACCEPTED', 'QUALIFIED_INTERNAL'),
  ('Capability', 'QUALIFIED_INTERNAL', 'AVAILABLE_LIMITED'),
  ('Capability', 'AVAILABLE_LIMITED', 'AVAILABLE'),
  ('Capability', 'IMPLEMENTED_UNACCEPTED', 'SUSPENDED'),
  ('Capability', 'QUALIFIED_INTERNAL', 'SUSPENDED'),
  ('Capability', 'AVAILABLE_LIMITED', 'SUSPENDED'),
  ('Capability', 'AVAILABLE', 'SUSPENDED');

-- --- processing authorities --------------------------------------------------------------------------------------------------
-- The end-client processing authority an agency records when it creates a client workspace (CMD009 precondition "Active
-- agency membership permits client creation and records the end-client processing authority"; contract EndClient
-- processingAuthorityRef "Agency evidence of authority to provide this client's data"; 02 "confirms authority to process the
-- end client's data"; playbook FLOW01 "Add the end-client workspace with its processing authority"). A row is that record:
-- the agency, the membership that recorded it and when, under the evidence reference the agency names. The platform does not
-- mint that reference in this edition (no evidence-artifact store exists yet), so it carries no v7 check (D-ID-1, external
-- references), and its identity is global: a reference another agency recorded cannot be recorded again (the primary key),
-- which is how "a foreign authority reference rejects" holds. The registry has no ProcessingAuthority contract; the legal role
-- chain (19 "The DPA identifies the actual chain of roles") belongs to the evidence, not to this row (decision D-CLIENT-1,
-- open question Q10). A client can only reference an authority record of its own agency (composite FK).
CREATE TABLE kauro.processing_authorities (
  processing_authority_id    uuid PRIMARY KEY,
  agency_id                  uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  recorded_by_membership_id  uuid NOT NULL,
  recorded_at                timestamptz NOT NULL,
  UNIQUE (agency_id, processing_authority_id),
  FOREIGN KEY (agency_id, recorded_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id)
);
CREATE TRIGGER processing_authorities_append_only BEFORE UPDATE OR DELETE ON kauro.processing_authorities
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- end clients --------------------------------------------------------------------------------------------------------------
CREATE TABLE kauro.end_clients (
  client_id                  uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(client_id)),
  agency_id                  uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  version                    bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  display_name               text NOT NULL CONSTRAINT end_clients_display_name_label CHECK (kauro.is_label(display_name)),
  state                      text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'ARCHIVED')),
  processing_authority_ref   uuid NOT NULL,
  created_by_membership_id   uuid NOT NULL,
  archived_at                timestamptz,
  created_at                 timestamptz NOT NULL,
  updated_at                 timestamptz NOT NULL,
  UNIQUE (agency_id, client_id),
  FOREIGN KEY (agency_id, processing_authority_ref) REFERENCES kauro.processing_authorities (agency_id, processing_authority_id),
  FOREIGN KEY (agency_id, created_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id),
  CONSTRAINT end_clients_archived_binding CHECK ((state = 'ARCHIVED') = (archived_at IS NOT NULL))
);
-- deliberately no uniqueness on display_name: duplicate labels are two workspaces with distinct stable identity (CMD009)
CREATE INDEX end_clients_list ON kauro.end_clients (agency_id, created_at, client_id);
CREATE TRIGGER end_clients_touch BEFORE UPDATE ON kauro.end_clients FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER end_clients_version BEFORE UPDATE ON kauro.end_clients FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER end_clients_immutable BEFORE UPDATE ON kauro.end_clients
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('client_id,agency_id,processing_authority_ref,created_by_membership_id,created_at');
CREATE TRIGGER end_clients_transition BEFORE UPDATE OF state ON kauro.end_clients
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('EndClient');
CREATE TRIGGER end_clients_initial_state BEFORE INSERT ON kauro.end_clients
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('EndClient');

-- D-AGG-2: EndClient has no registry machine (platform machine, initial ACTIVE); ARCHIVED is terminal in this edition (an
-- archived workspace is not revived, and none is born archived).
INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('EndClient', 'ACTIVE');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES ('EndClient', 'ACTIVE', 'ARCHIVED');

-- --- projects -------------------------------------------------------------------------------------------------------------------
CREATE TABLE kauro.projects (
  project_id                 uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(project_id)),
  agency_id                  uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  client_id                  uuid NOT NULL,
  version                    bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                      text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'CLOSED', 'DELETION_REQUESTED', 'DELETED')),
  mode                       text NOT NULL CHECK (mode IN ('CLEAN', 'HUBSPOT', 'SALESFORCE')),
  purpose                    text NOT NULL CONSTRAINT projects_purpose_label CHECK (kauro.is_label(purpose)),
  target_instance_ref        uuid,
  capability_id              uuid NOT NULL REFERENCES kauro.capabilities (capability_id),
  capability_version         text NOT NULL,
  current_revision_id        uuid NOT NULL,
  created_by_membership_id   uuid NOT NULL,
  created_at                 timestamptz NOT NULL,
  updated_at                 timestamptz NOT NULL,
  UNIQUE (agency_id, project_id),
  FOREIGN KEY (agency_id, client_id) REFERENCES kauro.end_clients (agency_id, client_id),
  FOREIGN KEY (agency_id, created_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id),
  -- D-CMD-4: a CRM mode declares its target scope; CLEAN needs none (02 "Service modes")
  CONSTRAINT projects_crm_mode_declares_target CHECK (mode = 'CLEAN' OR target_instance_ref IS NOT NULL)
);
CREATE INDEX projects_by_client ON kauro.projects (agency_id, client_id, created_at, project_id);
CREATE TRIGGER projects_touch BEFORE UPDATE ON kauro.projects FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER projects_version BEFORE UPDATE ON kauro.projects FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER projects_immutable BEFORE UPDATE ON kauro.projects
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('project_id,agency_id,client_id,mode,capability_id,capability_version,created_by_membership_id,created_at');
CREATE TRIGGER projects_transition BEFORE UPDATE OF state ON kauro.projects
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('Project');
CREATE TRIGGER projects_initial_state BEFORE INSERT ON kauro.projects
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('Project');

-- D-AGG-1: Project states OPEN, CLOSED, DELETION_REQUESTED, DELETED (closure distinctions live on the delivery aggregates);
-- platform machine, initial OPEN.
INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('Project', 'OPEN');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('Project', 'OPEN', 'CLOSED'),
  ('Project', 'OPEN', 'DELETION_REQUESTED'),
  ('Project', 'CLOSED', 'DELETION_REQUESTED'),
  ('Project', 'DELETION_REQUESTED', 'DELETED');

-- --- dataset revisions (identity and bindings; the upload lifecycle is B07) -------------------------------------------------------
CREATE TABLE kauro.dataset_revisions (
  revision_id             uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(revision_id)),
  agency_id               uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id              uuid NOT NULL,
  version                 bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                   text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'UPLOADING', 'INSPECTING', 'READY_TO_SEAL', 'SEALED', 'REJECTED', 'CANCELLED', 'SUPERSEDED', 'EXPIRED', 'DELETED')),
  manifest_hash           text CHECK (manifest_hash IS NULL OR kauro.is_sha256_hex(manifest_hash)),
  projection_hash         text CHECK (projection_hash IS NULL OR kauro.is_sha256_hex(projection_hash)),
  sealed_at               timestamptz,
  supersedes_revision_id  uuid,
  created_at              timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL,
  UNIQUE (agency_id, revision_id),
  -- binding target of plans_source_fk (0004): a plan's source is a revision of the plan's own project (re-check finding N9;
  -- 07 "Composite foreign keys ... prevent a project in one agency from referencing another agency's revision"; TenantScope
  -- projectId "Project scope when the operation is project-bound"). A DRAFT revision has no manifest yet (NULLs are distinct).
  CONSTRAINT dataset_revisions_project_manifest UNIQUE (agency_id, project_id, manifest_hash),
  FOREIGN KEY (agency_id, project_id) REFERENCES kauro.projects (agency_id, project_id),
  FOREIGN KEY (agency_id, supersedes_revision_id) REFERENCES kauro.dataset_revisions (agency_id, revision_id),
  -- a sealed subject carries its manifest and projection digests and its seal instant (EXPIRED can also follow REJECTED)
  CONSTRAINT dataset_revisions_sealed_bindings CHECK (
    state NOT IN ('SEALED', 'SUPERSEDED') OR (manifest_hash IS NOT NULL AND projection_hash IS NOT NULL AND sealed_at IS NOT NULL)
  )
);
-- the manifest hash identifies one sealed subject per agency (CMD025 binds revisionHash to it)
CREATE UNIQUE INDEX dataset_revisions_manifest ON kauro.dataset_revisions (agency_id, manifest_hash) WHERE manifest_hash IS NOT NULL;
CREATE INDEX dataset_revisions_by_project ON kauro.dataset_revisions (agency_id, project_id, created_at);
CREATE TRIGGER dataset_revisions_touch BEFORE UPDATE ON kauro.dataset_revisions FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER dataset_revisions_version BEFORE UPDATE ON kauro.dataset_revisions FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER dataset_revisions_immutable BEFORE UPDATE ON kauro.dataset_revisions
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('revision_id,agency_id,project_id,supersedes_revision_id,created_at');
CREATE TRIGGER dataset_revisions_transition BEFORE UPDATE OF state ON kauro.dataset_revisions
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('DatasetRevision');
CREATE TRIGGER dataset_revisions_initial_state BEFORE INSERT ON kauro.dataset_revisions
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('DatasetRevision');
-- CMD025 relies on the plan's source still being SEALED when the approval commits: a revision's state is a transition subject
-- (D-TX-2), so an expiry or supersession issued while an approval is in flight waits for it, one committed first is read, and
-- approvals arriving after a queued transition wait behind it (R15; re-check finding N3)
CREATE TRIGGER dataset_revisions_transition_lock BEFORE UPDATE OF state ON kauro.dataset_revisions
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.take_transition_lock('kauro.dataset_revisions', 'revision_id');

INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('DatasetRevision', 'DRAFT');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('DatasetRevision', 'DRAFT', 'UPLOADING'),
  ('DatasetRevision', 'UPLOADING', 'INSPECTING'),
  ('DatasetRevision', 'DRAFT', 'INSPECTING'),
  ('DatasetRevision', 'INSPECTING', 'READY_TO_SEAL'),
  ('DatasetRevision', 'INSPECTING', 'REJECTED'),
  ('DatasetRevision', 'READY_TO_SEAL', 'INSPECTING'),
  ('DatasetRevision', 'READY_TO_SEAL', 'SEALED'),
  ('DatasetRevision', 'SEALED', 'SUPERSEDED'),
  ('DatasetRevision', 'DRAFT', 'CANCELLED'),
  ('DatasetRevision', 'UPLOADING', 'CANCELLED'),
  ('DatasetRevision', 'INSPECTING', 'CANCELLED'),
  ('DatasetRevision', 'READY_TO_SEAL', 'CANCELLED'),
  ('DatasetRevision', 'SEALED', 'EXPIRED'),
  ('DatasetRevision', 'REJECTED', 'EXPIRED'),
  ('DatasetRevision', 'CANCELLED', 'DELETED'),
  ('DatasetRevision', 'EXPIRED', 'DELETED'),
  ('DatasetRevision', 'SUPERSEDED', 'DELETED');

-- A project always has a current revision; the pair is inserted together (project first, revision second, FK checked at
-- commit) so a project without a draft revision cannot exist (CMD011 effect).
ALTER TABLE kauro.projects ADD CONSTRAINT projects_current_revision_fk
  FOREIGN KEY (agency_id, current_revision_id) REFERENCES kauro.dataset_revisions (agency_id, revision_id)
  DEFERRABLE INITIALLY DEFERRED;

-- --- target contracts (identity and bindings; observation and confirmation are B08) --------------------------------------------------
CREATE TABLE kauro.target_contracts (
  contract_id              uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(contract_id)),
  agency_id                uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id               uuid NOT NULL,
  mode                     text NOT NULL CHECK (mode IN ('CLEAN', 'HUBSPOT', 'SALESFORCE')),
  instance_id              uuid NOT NULL,
  importer_profile_id      uuid NOT NULL,
  importer_version         text NOT NULL CHECK (kauro.is_label(importer_version)),
  -- customer target metadata is DATA validated by the application-owned TargetContract schema (S093); never compiled
  objects                  jsonb NOT NULL CHECK (jsonb_typeof(objects) = 'array'),
  schema_bundle_digest     text NOT NULL CHECK (kauro.is_sha256_hex(schema_bundle_digest)),
  body_hash                text NOT NULL CHECK (kauro.is_sha256_hex(body_hash)),
  observed_at              timestamptz NOT NULL,
  confirmed_at             timestamptz,
  authority_evidence_hash  text NOT NULL CHECK (kauro.is_sha256_hex(authority_evidence_hash)),
  capability_version       text NOT NULL CHECK (kauro.is_label(capability_version)),
  superseded_at            timestamptz,
  created_at               timestamptz NOT NULL,
  UNIQUE (agency_id, contract_id),
  -- one observed body per project (its bodyHash preimage carries observedAt, so a re-observation is another body), and the
  -- binding target of plans_target_fk (0004): a plan's target is a contract of the plan's own project (re-check findings N4, N9)
  CONSTRAINT target_contracts_project_body UNIQUE (agency_id, project_id, body_hash),
  FOREIGN KEY (agency_id, project_id) REFERENCES kauro.projects (agency_id, project_id)
);
CREATE TRIGGER target_contracts_immutable BEFORE UPDATE ON kauro.target_contracts
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('contract_id,agency_id,project_id,mode,instance_id,importer_profile_id,importer_version,objects,schema_bundle_digest,body_hash,observed_at,authority_evidence_hash,capability_version,created_at');
-- CMD025 relies on the plan's target contract being confirmed and current: its confirmation and supersession are a transition
-- subject (D-TX-2), under the same discipline as the source revision
CREATE TRIGGER target_contracts_transition_lock BEFORE UPDATE OF confirmed_at, superseded_at ON kauro.target_contracts
  FOR EACH ROW WHEN (OLD.confirmed_at IS DISTINCT FROM NEW.confirmed_at OR OLD.superseded_at IS DISTINCT FROM NEW.superseded_at)
  EXECUTE FUNCTION kauro.take_transition_lock('kauro.target_contracts', 'contract_id');

-- --- row-level security ------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.capabilities FORCE ROW LEVEL SECURITY;
-- The request handlers read capabilities and hold no write or lock privilege on them: CMD011 orders itself with a capability
-- transition through the transition lock of the mode (D-TX-2), not through a row lock (the FOR SHARE of review R25 let later
-- readers overtake a queued suspension, re-check finding N3, and needed an UPDATE privilege on the key column).
CREATE POLICY capabilities_read ON kauro.capabilities FOR SELECT TO kauro_app USING (true);
CREATE POLICY capabilities_control ON kauro.capabilities FOR ALL TO kauro_control USING (true) WITH CHECK (true);

ALTER TABLE kauro.processing_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.processing_authorities FORCE ROW LEVEL SECURITY;
CREATE POLICY processing_authorities_tenant ON kauro.processing_authorities FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.end_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.end_clients FORCE ROW LEVEL SECURITY;
CREATE POLICY end_clients_tenant ON kauro.end_clients FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.projects FORCE ROW LEVEL SECURITY;
CREATE POLICY projects_tenant ON kauro.projects FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.dataset_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.dataset_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY dataset_revisions_tenant ON kauro.dataset_revisions FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.target_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.target_contracts FORCE ROW LEVEL SECURITY;
CREATE POLICY target_contracts_tenant ON kauro.target_contracts FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

-- --- grants ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT ON kauro.capabilities TO kauro_app;
GRANT SELECT, INSERT, UPDATE ON kauro.capabilities TO kauro_control;
GRANT SELECT, INSERT ON kauro.processing_authorities TO kauro_app;
GRANT SELECT, INSERT, UPDATE ON kauro.end_clients, kauro.projects, kauro.dataset_revisions, kauro.target_contracts TO kauro_app;
