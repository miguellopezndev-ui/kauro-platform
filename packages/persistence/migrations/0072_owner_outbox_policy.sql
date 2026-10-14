-- Migration 0072 (provisional number; the coordinator renumbers at merge) — Payments V1, lane OWNER-OUTBOX-POLICY: the corporate owner's
-- agency-less outbox records name exactly the commands the owner's code paths use. 0063:188 (outbox_records_owner_bank, the credit and
-- statement-import records) and 0046:256 (outbox_records_owner_route, the route records) were FOR ALL: the owner's writer
-- (event-publisher.ts) INSERTs one PENDING record per subscribed consumer, without RETURNING or an upsert, and the owner's reads SELECT
-- them; the dispatch columns move only under kauro_control (inbox-outbox.ts). Each becomes one SELECT and one INSERT policy with the same
-- predicate; no policy of the owner names UPDATE or DELETE (kauro_app's privileges are SELECT and INSERT since 0005: the policy now
-- agrees with them instead of relying on them). Idempotent.
DROP POLICY IF EXISTS outbox_records_owner_bank ON kauro.outbox_records;
DROP POLICY IF EXISTS outbox_records_owner_bank_read ON kauro.outbox_records;
DROP POLICY IF EXISTS outbox_records_owner_bank_record ON kauro.outbox_records;
CREATE POLICY outbox_records_owner_bank_read ON kauro.outbox_records FOR SELECT TO kauro_app
  USING (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id IS NULL AND e.aggregate_kind IN ('bank_credit', 'statement_import')) AND kauro.acting_corporate_owner());
CREATE POLICY outbox_records_owner_bank_record ON kauro.outbox_records FOR INSERT TO kauro_app
  WITH CHECK (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id IS NULL AND e.aggregate_kind IN ('bank_credit', 'statement_import')) AND kauro.acting_corporate_owner());

DROP POLICY IF EXISTS outbox_records_owner_route ON kauro.outbox_records;
DROP POLICY IF EXISTS outbox_records_owner_route_read ON kauro.outbox_records;
DROP POLICY IF EXISTS outbox_records_owner_route_record ON kauro.outbox_records;
CREATE POLICY outbox_records_owner_route_read ON kauro.outbox_records FOR SELECT TO kauro_app
  USING (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id IS NULL AND e.aggregate_kind = 'bank_route' AND kauro.acting_corporate_owner()));
CREATE POLICY outbox_records_owner_route_record ON kauro.outbox_records FOR INSERT TO kauro_app
  WITH CHECK (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id IS NULL AND e.aggregate_kind = 'bank_route' AND kauro.acting_corporate_owner()));
