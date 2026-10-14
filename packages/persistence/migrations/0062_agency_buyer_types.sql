-- Migration 0062 (provisional number; the coordinator renumbers at merge): the agency's buyer type (package B11 lane A1; SCREENS-PLAN
-- section 3 rows A1; R2 A3 3.7: "the buyer type is answered once during onboarding, before the first quote"; values agency | in-house;
-- it does not change the price).
--
-- 1. kauro.agency_buyer_types: one row per agency, written once by SetBuyerType (CMD101, AGENCY_OWNER) with the owner's affirmation
--    that the agency buys for an economic activity (for_economic_activity, always true). Append-only: no UPDATE or DELETE grant and a
--    trigger that refuses both; the primary key on agency_id is the second line of defence behind the command's agency-row lock.
-- 2. The event agency_buyer_type.recorded.v1 of the aggregate agency_buyer_type (id = agency_id, version 1), required with the row.
-- 3. RLS: the agency's own tenant context reads and inserts its row; the corporate owner (kauro.acting_corporate_owner(), migration
--    0029) reads every row, because CMD047 AcceptAttribution reads the buyer type in the owner's operator context.
CREATE TABLE kauro.agency_buyer_types (
  agency_id                  uuid PRIMARY KEY REFERENCES kauro.agencies (agency_id),
  buyer_type                 text NOT NULL CHECK (buyer_type IN ('agency', 'in-house')),
  for_economic_activity      boolean NOT NULL CONSTRAINT agency_buyer_types_economic_activity CHECK (for_economic_activity),
  recorded_by_user_id        uuid NOT NULL REFERENCES kauro.identities (user_id),
  recorded_by_membership_id  uuid NOT NULL,
  version                    bigint NOT NULL DEFAULT 1 CHECK (version = 1),
  recorded_at                timestamptz NOT NULL,
  FOREIGN KEY (agency_id, recorded_by_membership_id, recorded_by_user_id) REFERENCES kauro.memberships (agency_id, membership_id, user_id)
);
CREATE TRIGGER agency_buyer_types_append_only BEFORE UPDATE OR DELETE ON kauro.agency_buyer_types
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

ALTER TABLE kauro.event_types NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.event_types (event_type) VALUES ('agency_buyer_type.recorded.v1');
ALTER TABLE kauro.event_types FORCE ROW LEVEL SECURITY;

INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES ('agency_buyer_type', 'agency_buyer_types', 'agency_id', 'B11');
CREATE CONSTRAINT TRIGGER agency_buyer_types_event_per_version AFTER INSERT ON kauro.agency_buyer_types
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('agency_buyer_type', 'agency_id');

ALTER TABLE kauro.agency_buyer_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.agency_buyer_types FORCE ROW LEVEL SECURITY;
CREATE POLICY agency_buyer_types_tenant ON kauro.agency_buyer_types FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY agency_buyer_types_owner_read ON kauro.agency_buyer_types FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());

GRANT SELECT, INSERT ON kauro.agency_buyer_types TO kauro_app;
