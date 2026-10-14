-- 0071 — Payments V1, lane PV1-SETTLE (CMD215 RecordSettlementObservation; PROVISIONAL number, renumbered at merge).
--
-- Authority: docs/design/ACH-ROUTE.md r12 §7.25 (ST1, ST2), R2-085 (separate capture / held / withdrawn / bank-available facts; no
-- payout from imaginary liquidity; never grade from a screenshot), B09 D-SETTLE-B1 and D-LEDGER-B5, docs/design/PV1-SETTLE.md
-- D-SET-1..D-SET-8. It builds on 0017's kauro.settlements (STRUCTURE there; ALTER here, never a second CREATE):
--   * a bank-route observation names its route account, the withdrawal (the provider's statement-line id of the debit on the route
--     account) and, when the money arrived, the receiving bank's transaction: one settlement per withdrawal and one per bank
--     transaction (D-SET-4). An observation without a withdrawal is 0017's provider balance observation, unchanged;
--   * received_cents is the money the receipt shows arrived (<= withdrawn); bank_available_cents of a bank-route row is the receiving
--     account's balance the same receipt shows (the cash CMD052 reads, 0043), so 0017's "within withdrawn" rule binds the rows without
--     a withdrawal only;
--   * a settlement is an agency-less aggregate with its event (D-EVT-1, decision #1 of 0046): settlement.recorded.v1;
--   * the provider-available balance of a route is read by one SECURITY DEFINER function (D-SET-5): the payment service cannot read
--     another agency's postings, and the guard needs the route's whole PSP_AVAILABLE.

ALTER TABLE kauro.settlements
  ADD COLUMN agency_id              uuid CHECK (agency_id IS NULL),
  ADD COLUMN version                bigint NOT NULL DEFAULT 1 CHECK (version = 1),
  ADD COLUMN environment            text CHECK (environment IS NULL OR environment IN ('SANDBOX', 'LIVE')),
  ADD COLUMN account_ref            text CHECK (account_ref IS NULL OR kauro.is_provider_ref(account_ref)),
  ADD COLUMN withdrawal_id          text CHECK (withdrawal_id IS NULL OR kauro.is_provider_ref(withdrawal_id)),
  ADD COLUMN artifact_ref           text CHECK (artifact_ref IS NULL OR kauro.is_provider_ref(artifact_ref)),
  ADD COLUMN receiving_account_ref  text CHECK (receiving_account_ref IS NULL OR kauro.is_provider_ref(receiving_account_ref)),
  ADD COLUMN bank_transaction_id    text CHECK (bank_transaction_id IS NULL OR kauro.is_provider_ref(bank_transaction_id)),
  ADD COLUMN receipt_artifact_ref   text CHECK (receipt_artifact_ref IS NULL OR kauro.is_provider_ref(receipt_artifact_ref)),
  ADD COLUMN received_cents         bigint CHECK (received_cents IS NULL OR kauro.is_money(received_cents)),
  ADD COLUMN normalizer_version     text CHECK (normalizer_version IS NULL OR char_length(normalizer_version) BETWEEN 1 AND 64),
  ADD COLUMN recorded_by            uuid,
  -- a bank-route observation names its account, its withdrawal, its artifact and its recorder together
  ADD CONSTRAINT settlements_bank_route_identity CHECK (
    (withdrawal_id IS NULL AND environment IS NULL AND account_ref IS NULL AND artifact_ref IS NULL AND recorded_by IS NULL AND bank_transaction_id IS NULL AND received_cents IS NULL)
    OR (withdrawal_id IS NOT NULL AND environment IS NOT NULL AND account_ref IS NOT NULL AND artifact_ref IS NOT NULL AND recorded_by IS NOT NULL AND withdrawn_cents > 0)
  ),
  -- a receipt is all of its facts or none; bank-available money exists only with it (D-LEDGER-B5)
  ADD CONSTRAINT settlements_bank_receipt CHECK (
    (bank_transaction_id IS NULL AND receiving_account_ref IS NULL AND receipt_artifact_ref IS NULL AND (withdrawal_id IS NULL OR (received_cents IS NULL AND bank_available_cents = 0 AND bank_evidence_hash IS NULL)))
    OR (bank_transaction_id IS NOT NULL AND receiving_account_ref IS NOT NULL AND receipt_artifact_ref IS NOT NULL AND received_cents IS NOT NULL AND bank_evidence_hash IS NOT NULL
        AND received_cents <= withdrawn_cents AND bank_available_cents >= received_cents)
  );
-- 0017's rule (bank cash out of what was withdrawn) binds the provider balance observations; a bank-route row's received money is bound above
ALTER TABLE kauro.settlements DROP CONSTRAINT settlements_bank_within_withdrawn;
ALTER TABLE kauro.settlements ADD CONSTRAINT settlements_bank_within_withdrawn CHECK (withdrawal_id IS NOT NULL OR bank_available_cents <= withdrawn_cents);
-- one observation per balance instant for the provider balance rows; a bank-route row is identified by its withdrawal (D-SET-4)
ALTER TABLE kauro.settlements DROP CONSTRAINT settlements_route_id_provider_balance_ref_observed_at_key;
CREATE UNIQUE INDEX settlements_one_per_balance_instant ON kauro.settlements (route_id, provider_balance_ref, observed_at) WHERE withdrawal_id IS NULL;
CREATE UNIQUE INDEX settlements_one_per_withdrawal ON kauro.settlements (environment, account_ref, withdrawal_id) WHERE withdrawal_id IS NOT NULL;
CREATE UNIQUE INDEX settlements_one_per_bank_transaction ON kauro.settlements (environment, receiving_account_ref, bank_transaction_id) WHERE bank_transaction_id IS NOT NULL;

-- --- aggregate kind and event ------------------------------------------------------------------------------------------------------------
INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES ('settlement', 'settlements', 'settlement_id', 'B09');
ALTER TABLE kauro.event_types NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.event_types (event_type) VALUES ('settlement.recorded.v1');
ALTER TABLE kauro.event_types FORCE ROW LEVEL SECURITY;
-- D-EVT-1: a settlement observation a command records (a bank-route row: CMD215) is never written without its event. 0017's provider
-- balance observation (no withdrawal) has no V1 producer command; its event obligation lands with that producer (D-SET-9).
CREATE CONSTRAINT TRIGGER settlements_event_per_version AFTER INSERT ON kauro.settlements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.withdrawal_id IS NOT NULL) EXECUTE FUNCTION kauro.require_event_for_version('settlement', 'settlement_id');

-- the payment service's agency-less events and outbox records: 0061's two kinds and the settlement (decision #1)
DROP POLICY domain_events_payment_bank ON kauro.domain_events;
CREATE POLICY domain_events_payment_bank ON kauro.domain_events FOR ALL TO kauro_payment
  USING (agency_id IS NULL AND aggregate_kind IN ('bank_credit', 'statement_import', 'settlement'))
  WITH CHECK (agency_id IS NULL AND aggregate_kind IN ('bank_credit', 'statement_import', 'settlement') AND split_part(event_type, '.', 1) = aggregate_kind);
DROP POLICY outbox_records_payment_bank ON kauro.outbox_records;
CREATE POLICY outbox_records_payment_bank ON kauro.outbox_records FOR ALL TO kauro_payment
  USING (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id IS NULL AND e.aggregate_kind IN ('bank_credit', 'statement_import', 'settlement')))
  WITH CHECK (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id IS NULL AND e.aggregate_kind IN ('bank_credit', 'statement_import', 'settlement')));

-- --- the provider-available balance of a route (D-SET-5) ---------------------------------------------------------------------------------
-- Σ(DEBIT − CREDIT) of PSP_AVAILABLE in the currency over every posting set attributable to the payment route: its settlement
-- observations, and the event-sourced sets of its orders (a capture's CAPTURE/FEE/FUNDS/CHARGEBACK, a refund's REFUND, a case's
-- CORRECTION through the case's order or capture). Read-only; the caller holds the payout-cash lock, so no settlement of the route
-- commits between this read and its own write. Inside the function FORCE ROW LEVEL SECURITY applies to its owner: the read policies
-- below are its owner's only (the migration role never logs in at runtime).
CREATE POLICY ledger_entries_route_available_read ON kauro.ledger_entries FOR SELECT TO CURRENT_USER USING (account_code = 'PSP_AVAILABLE');
CREATE POLICY settlements_route_available_read ON kauro.settlements FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY capture_facts_route_available_read ON kauro.capture_facts FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY refunds_route_available_read ON kauro.refunds FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY reconciliation_cases_route_available_read ON kauro.reconciliation_cases FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY payment_orders_route_available_read ON kauro.payment_orders FOR SELECT TO CURRENT_USER USING (true);

CREATE OR REPLACE FUNCTION kauro.route_provider_available_cents(p_route_id uuid, p_currency text) RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
  SELECT coalesce(sum(CASE e.direction WHEN 'DEBIT' THEN e.amount_cents ELSE -e.amount_cents END), 0)::bigint
    FROM kauro.ledger_entries e
    LEFT JOIN kauro.settlements s ON s.settlement_id = e.settlement_id
    LEFT JOIN kauro.capture_facts c ON e.domain_event_id IS NOT NULL AND e.source_kind IN ('CAPTURE', 'FEE', 'FUNDS', 'CHARGEBACK') AND c.capture_id = e.source_ref
    LEFT JOIN kauro.refunds r ON e.domain_event_id IS NOT NULL AND e.source_kind = 'REFUND' AND r.refund_id = e.source_ref
    LEFT JOIN kauro.reconciliation_cases rc ON e.domain_event_id IS NOT NULL AND e.source_kind = 'CORRECTION' AND rc.case_id = e.source_ref
    LEFT JOIN kauro.capture_facts rcc ON rcc.capture_id = rc.capture_id
    LEFT JOIN kauro.payment_orders o ON o.order_id = coalesce(c.order_id, r.order_id, rc.order_id, rcc.order_id)
   WHERE e.account_code = 'PSP_AVAILABLE' AND e.currency = p_currency AND coalesce(s.route_id, o.route_id) = p_route_id
$$;
REVOKE ALL ON FUNCTION kauro.route_provider_available_cents(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kauro.route_provider_available_cents(uuid, text) TO kauro_payment;
