-- 0009 — support cases (B11 W4: CMD044 CreateSupportCase and its two reads; docs/design/B11-agency-app.md section 5, D-SUP-1..D-SUP-6).
--
-- A support case is the safe metadata of a request for help: a routing category, an impact severity, a state, a minimized
-- summary, scoped evidence references and the named follow-up deadline (registry contract SupportCase, owner manual 18: "Support
-- metadata must not become an unrestricted raw-data channel"). The summary is refused by the application when it looks like a
-- secret or a set of customer records (a bounded detector, D-SUP-2), so what reaches this table is the description of a problem,
-- never the data of a customer.
--
-- Placement: a case belongs to one agency and to one of its projects (a composite foreign key keeps a case from naming another
-- agency's project, 07 "Composite foreign keys"), was opened by one membership of that agency and one identity, and is born OPEN.
-- The state vocabulary is the registry SupportCase.state enum; the registry has no machine for it, so SupportCase is a platform
-- machine (initial OPEN, like Project) whose triage edges belong to the package that triages cases: this edition lists none, so a
-- case's state cannot change yet and every row is OPEN (enforce_listed_transition refuses the unlisted edge).
--
-- This migration is numbered 0009 on the W4 branch; the integration step renumbers it (INT-1) when W2 and W5b bring theirs.

-- --- support cases -------------------------------------------------------------------------------------------------------------
CREATE TABLE kauro.support_cases (
  case_id                   uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(case_id)),
  agency_id                 uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id                uuid NOT NULL,
  category                  text NOT NULL CHECK (category IN ('PRODUCT_DEFECT', 'IMPORT_GUIDANCE', 'BILLING', 'PRIVACY', 'SECURITY', 'GENERAL')),
  severity                  text NOT NULL CHECK (severity IN ('S1', 'S2', 'S3', 'S4')),
  state                     text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'TRIAGED', 'WAITING_KAURO', 'WAITING_AGENCY', 'RESOLVED', 'CLOSED')),
  -- 20..4000 characters (design section 5); text keeps its line breaks and tabs, no other control character (Unicode Cc)
  summary                   text NOT NULL
                            CONSTRAINT support_cases_summary_length CHECK (char_length(summary) BETWEEN 20 AND 4000)
                            CONSTRAINT support_cases_summary_no_control CHECK (summary !~ '[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]'),
  -- scoped safe attachments: the ids of uploads of the case's project; none until the upload package serves them (D-SUP-2)
  evidence_refs             uuid[] NOT NULL DEFAULT '{}'
                            CONSTRAINT support_cases_evidence_bounded CHECK (cardinality(evidence_refs) <= 10 AND array_position(evidence_refs, NULL) IS NULL),
  created_by_user_id        uuid NOT NULL REFERENCES kauro.identities (user_id),
  created_by_membership_id  uuid NOT NULL,
  next_review_at            timestamptz NOT NULL,
  version                   bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at                timestamptz NOT NULL,
  updated_at                timestamptz NOT NULL,
  UNIQUE (agency_id, case_id),
  FOREIGN KEY (agency_id, project_id) REFERENCES kauro.projects (agency_id, project_id),
  FOREIGN KEY (agency_id, created_by_membership_id, created_by_user_id) REFERENCES kauro.memberships (agency_id, membership_id, user_id)
);
-- the keyset list of one project's cases (created_at, case_id ascending), and a case is found by its id inside its agency
CREATE INDEX support_cases_by_project ON kauro.support_cases (agency_id, project_id, created_at, case_id);
CREATE TRIGGER support_cases_touch BEFORE UPDATE ON kauro.support_cases FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER support_cases_version BEFORE UPDATE ON kauro.support_cases FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER support_cases_immutable BEFORE UPDATE ON kauro.support_cases
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('case_id,agency_id,project_id,category,summary,evidence_refs,created_by_user_id,created_by_membership_id,created_at');
CREATE TRIGGER support_cases_transition BEFORE UPDATE OF state ON kauro.support_cases
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('SupportCase');
CREATE TRIGGER support_cases_initial_state BEFORE INSERT ON kauro.support_cases
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('SupportCase');

-- D-SUP-6: SupportCase is a platform machine over the registry state enum, initial OPEN; no edge is listed in this edition.
INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('SupportCase', 'OPEN');

-- --- the event of a new case ----------------------------------------------------------------------------------------------------
-- @kauro/domain EVENT_TYPES; the persistence test proves both lists are identical. event_types is FORCE ROW LEVEL SECURITY with a
-- read-only policy, so even its owner cannot insert (foundation Q-AGGK-2): the vocabulary is extended by lifting FORCE for the one
-- INSERT and restoring it in this migration's own transaction, the way the payments migration extends it.
ALTER TABLE kauro.event_types NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.event_types (event_type) VALUES ('support_case.opened.v1');
ALTER TABLE kauro.event_types FORCE ROW LEVEL SECURITY;

-- the aggregate kind (the shared registry, migration 0008): the event of a case binds to this table and column, and a case cannot
-- commit without its event (D-EVT-1)
INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES ('support_case', 'support_cases', 'case_id', 'B11');
CREATE CONSTRAINT TRIGGER support_cases_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.support_cases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('support_case', 'case_id');

-- --- row-level security ---------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.support_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.support_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY support_cases_tenant ON kauro.support_cases FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

-- --- grants ---------------------------------------------------------------------------------------------------------------------
-- The request handlers open and read cases; nothing in this edition edits or removes one.
GRANT SELECT, INSERT ON kauro.support_cases TO kauro_app;
