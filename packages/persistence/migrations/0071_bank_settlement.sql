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

-- === two-step settlement (docs/design/PV1-SETTLE-two-step.md D-SET-10, §3.1) ==============================================================
-- CMD215 RECORDS the owner's intent (an OPERATOR unit of kauro_app: the request pool writes no money state, D-ACH-16, R2 08:31); the
-- payment service's PAYMENT_SERVICE consumer APPLIES it on delivery of settlement_request.recorded.v1 (a SERVICE unit of kauro_payment):
-- the settlement, its event, its posting set and the intent's outcome, or a refusal with its review case (R2 15:153, 15:57). An intent
-- freezes the facts its artifacts state, is consumed once (APPLIED or REFUSED) and is never deleted; the apply re-reads the artifacts.
CREATE TABLE kauro.settlement_requests (
  request_id             uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(request_id)),
  agency_id              uuid CHECK (agency_id IS NULL),
  version                bigint NOT NULL DEFAULT 1 CHECK (version IN (1, 2)),
  environment            text NOT NULL CHECK (environment IN ('SANDBOX', 'LIVE')),
  account_ref            text NOT NULL CHECK (kauro.is_provider_ref(account_ref)),
  withdrawal_id          text NOT NULL CHECK (kauro.is_provider_ref(withdrawal_id)),
  artifact_ref           text NOT NULL CHECK (kauro.is_provider_ref(artifact_ref)),
  evidence_hash          text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  currency               text NOT NULL CHECK (currency = 'USD'),
  gross_cents            bigint NOT NULL CHECK (kauro.is_money(gross_cents)),
  fee_cents              bigint NOT NULL CHECK (kauro.is_money(fee_cents)),
  held_cents             bigint NOT NULL CHECK (kauro.is_money(held_cents)),
  withdrawn_cents        bigint NOT NULL CHECK (kauro.is_money(withdrawn_cents) AND withdrawn_cents > 0),
  period_start           timestamptz NOT NULL,
  period_end             timestamptz NOT NULL,
  observed_at            timestamptz NOT NULL,
  normalizer_version     text NOT NULL CHECK (char_length(normalizer_version) BETWEEN 1 AND 64),
  receipt_artifact_ref   text CHECK (receipt_artifact_ref IS NULL OR kauro.is_provider_ref(receipt_artifact_ref)),
  receipt_evidence_hash  text CHECK (receipt_evidence_hash IS NULL OR kauro.is_sha256_hex(receipt_evidence_hash)),
  receiving_account_ref  text CHECK (receiving_account_ref IS NULL OR kauro.is_provider_ref(receiving_account_ref)),
  bank_transaction_id    text CHECK (bank_transaction_id IS NULL OR kauro.is_provider_ref(bank_transaction_id)),
  received_cents         bigint CHECK (received_cents IS NULL OR kauro.is_money(received_cents)),
  bank_available_cents   bigint CHECK (bank_available_cents IS NULL OR kauro.is_money(bank_available_cents)),
  booked_at              timestamptz,
  receipt_observed_at    timestamptz,
  requested_by           uuid NOT NULL,
  requested_at           timestamptz NOT NULL,
  consumed_at            timestamptz,
  outcome                text CHECK (outcome IS NULL OR outcome IN ('APPLIED', 'REFUSED')),
  refusal_reason         text CHECK (refusal_reason IS NULL OR refusal_reason IN ('EVIDENCE_MISMATCH', 'REQUEST_STALE', 'COVERAGE_END_IN_FUTURE', 'CURRENCY_MISMATCH', 'WITHDRAWAL_ALREADY_SETTLED', 'FUNDS_UNAVAILABLE')),
  settlement_id          uuid UNIQUE,
  review_case_id         uuid UNIQUE,
  CONSTRAINT settlement_requests_period CHECK (period_end > period_start),
  -- a receipt is all of its facts or none, within what was withdrawn, and the balance it shows holds the money it shows arrived
  CONSTRAINT settlement_requests_receipt_group CHECK (
    (receipt_artifact_ref IS NULL AND receipt_evidence_hash IS NULL AND receiving_account_ref IS NULL AND bank_transaction_id IS NULL
      AND received_cents IS NULL AND bank_available_cents IS NULL AND booked_at IS NULL AND receipt_observed_at IS NULL)
    OR (receipt_artifact_ref IS NOT NULL AND receipt_evidence_hash IS NOT NULL AND receiving_account_ref IS NOT NULL AND bank_transaction_id IS NOT NULL
      AND received_cents IS NOT NULL AND bank_available_cents IS NOT NULL AND booked_at IS NOT NULL AND receipt_observed_at IS NOT NULL)
  ),
  CONSTRAINT settlement_requests_received_within_withdrawn CHECK (received_cents IS NULL OR received_cents <= withdrawn_cents),
  CONSTRAINT settlement_requests_available_holds_received CHECK (received_cents IS NULL OR bank_available_cents >= received_cents),
  -- the consumed group, one predicate each (rule 12)
  CONSTRAINT settlement_requests_consumed_outcome CHECK ((consumed_at IS NULL) = (outcome IS NULL)),
  CONSTRAINT settlement_requests_applied_settlement CHECK ((outcome IS NOT DISTINCT FROM 'APPLIED') = (settlement_id IS NOT NULL)),
  CONSTRAINT settlement_requests_refused_reason CHECK ((outcome IS NOT DISTINCT FROM 'REFUSED') = (refusal_reason IS NOT NULL)),
  CONSTRAINT settlement_requests_refused_case CHECK ((outcome IS NOT DISTINCT FROM 'REFUSED') = (review_case_id IS NOT NULL)),
  CONSTRAINT settlement_requests_consumed_version CHECK ((version = 2) = (consumed_at IS NOT NULL))
);
-- one live intent per withdrawal of an account (serialized by the account's INBOUND stream) and per receiving bank transaction (across
-- provider accounts: an insert may wait on another account's uncommitted entry and get 23505, which CMD215 answers as 409); a REFUSED
-- intent is not live (the owner may record again)
CREATE UNIQUE INDEX settlement_requests_live_withdrawal ON kauro.settlement_requests (environment, account_ref, withdrawal_id)
  WHERE outcome IS NULL OR outcome = 'APPLIED';
CREATE UNIQUE INDEX settlement_requests_live_bank_transaction ON kauro.settlement_requests (environment, receiving_account_ref, bank_transaction_id)
  WHERE bank_transaction_id IS NOT NULL AND (outcome IS NULL OR outcome = 'APPLIED');
CREATE INDEX settlement_requests_by_account ON kauro.settlement_requests (environment, account_ref, requested_at, request_id);

CREATE OR REPLACE FUNCTION kauro.settlement_requests_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.consumed_at IS NOT NULL OR NEW.outcome IS NOT NULL OR NEW.refusal_reason IS NOT NULL OR NEW.settlement_id IS NOT NULL OR NEW.review_case_id IS NOT NULL THEN
      RAISE EXCEPTION 'CONTEXT: a settlement intent is recorded unconsumed' USING ERRCODE = 'KA006';
    END IF;
    -- recorded by the person of the session, at the database clock (to the millisecond), as version 1
    NEW.requested_by := kauro.current_user_id();
    IF NEW.requested_by IS NULL THEN
      RAISE EXCEPTION 'CONTEXT: a settlement intent is recorded by a person' USING ERRCODE = 'KA006';
    END IF;
    NEW.requested_at := date_trunc('milliseconds', kauro.effect_now());
    NEW.version := 1;
    RETURN NEW;
  END IF;
  -- consumed once: from unconsumed only, at the database clock, as version 2
  IF OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: a settlement intent is consumed once' USING ERRCODE = 'KA004';
  END IF;
  NEW.consumed_at := kauro.effect_now();
  NEW.version := 2;
  RETURN NEW;
END
$$;
CREATE TRIGGER settlement_requests_guard BEFORE INSERT OR UPDATE ON kauro.settlement_requests
  FOR EACH ROW EXECUTE FUNCTION kauro.settlement_requests_guard();
CREATE TRIGGER settlement_requests_immutable BEFORE UPDATE ON kauro.settlement_requests
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('request_id,agency_id,environment,account_ref,withdrawal_id,artifact_ref,evidence_hash,currency,gross_cents,fee_cents,held_cents,withdrawn_cents,period_start,period_end,observed_at,normalizer_version,receipt_artifact_ref,receipt_evidence_hash,receiving_account_ref,bank_transaction_id,received_cents,bank_available_cents,booked_at,receipt_observed_at,requested_by,requested_at');
CREATE TRIGGER settlement_requests_no_delete BEFORE DELETE ON kauro.settlement_requests
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- aggregate kind and events -------------------------------------------------------------------------------------------------------------
INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES ('settlement_request', 'settlement_requests', 'request_id', 'B09');
ALTER TABLE kauro.event_types NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.event_types (event_type) VALUES ('settlement_request.recorded.v1'), ('settlement_request.applied.v1'), ('settlement_request.refused.v1');
ALTER TABLE kauro.event_types FORCE ROW LEVEL SECURITY;
-- D-EVT-1: version 1 (recorded) and version 2 (applied or refused) each carry their event (every UPDATE is the one consumption: the guard
-- sets version 2 itself, so the trigger fires on any UPDATE, not on UPDATE OF version, which a BEFORE trigger's change does not fire)
CREATE CONSTRAINT TRIGGER settlement_requests_event_per_version AFTER INSERT OR UPDATE ON kauro.settlement_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('settlement_request', 'request_id');

-- --- access ------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.settlement_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.settlement_requests FORCE ROW LEVEL SECURITY;
-- the corporate owner, acting as itself, records an intent and reads the intents (the replay, the live-intent check, the outcome reads)
CREATE POLICY settlement_requests_owner_read ON kauro.settlement_requests FOR SELECT TO kauro_app
  USING (kauro.acting_corporate_owner() AND agency_id IS NULL);
CREATE POLICY settlement_requests_owner_record ON kauro.settlement_requests FOR INSERT TO kauro_app
  WITH CHECK (kauro.acting_corporate_owner() AND agency_id IS NULL);
GRANT SELECT ON kauro.settlement_requests TO kauro_app;
GRANT INSERT (request_id, environment, account_ref, withdrawal_id, artifact_ref, evidence_hash, currency, gross_cents, fee_cents, held_cents, withdrawn_cents,
  period_start, period_end, observed_at, normalizer_version, receipt_artifact_ref, receipt_evidence_hash, receiving_account_ref, bank_transaction_id,
  received_cents, bank_available_cents, booked_at, receipt_observed_at) ON kauro.settlement_requests TO kauro_app;
-- the payment service reads every intent and consumes an unconsumed one (its outcome only)
CREATE POLICY settlement_requests_service_read ON kauro.settlement_requests FOR SELECT TO kauro_payment USING (true);
CREATE POLICY settlement_requests_service_consume ON kauro.settlement_requests FOR UPDATE TO kauro_payment
  USING (consumed_at IS NULL) WITH CHECK (consumed_at IS NOT NULL);
GRANT SELECT ON kauro.settlement_requests TO kauro_payment;
GRANT UPDATE (consumed_at, outcome, refusal_reason, settlement_id, review_case_id) ON kauro.settlement_requests TO kauro_payment;

-- the owner's intent event and its outbox records: it reads them and writes recorded.v1 only (F9: the service never writes the owner's
-- record, the owner never an outcome); no UPDATE or DELETE of its outbox records (the owner cannot mark its intent's delivery)
CREATE POLICY domain_events_owner_settlement_request_read ON kauro.domain_events FOR SELECT TO kauro_app
  USING (agency_id IS NULL AND aggregate_kind = 'settlement_request' AND kauro.acting_corporate_owner());
CREATE POLICY domain_events_owner_settlement_request_record ON kauro.domain_events FOR INSERT TO kauro_app
  WITH CHECK (agency_id IS NULL AND aggregate_kind = 'settlement_request' AND event_type = 'settlement_request.recorded.v1' AND kauro.acting_corporate_owner());
CREATE POLICY outbox_records_owner_settlement_request_read ON kauro.outbox_records FOR SELECT TO kauro_app
  USING (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id IS NULL AND e.aggregate_kind = 'settlement_request') AND kauro.acting_corporate_owner());
CREATE POLICY outbox_records_owner_settlement_request_record ON kauro.outbox_records FOR INSERT TO kauro_app
  WITH CHECK (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id IS NULL AND e.aggregate_kind = 'settlement_request'
    AND e.event_type = 'settlement_request.recorded.v1') AND kauro.acting_corporate_owner());
-- the payment service reads the intents' events and writes the outcome events (applied.v1, refused.v1) and their outbox records only
CREATE POLICY domain_events_payment_settlement_request_read ON kauro.domain_events FOR SELECT TO kauro_payment
  USING (agency_id IS NULL AND aggregate_kind = 'settlement_request');
CREATE POLICY domain_events_payment_settlement_request_outcome ON kauro.domain_events FOR INSERT TO kauro_payment
  WITH CHECK (agency_id IS NULL AND aggregate_kind = 'settlement_request' AND event_type IN ('settlement_request.applied.v1', 'settlement_request.refused.v1'));
CREATE POLICY outbox_records_payment_settlement_request_read ON kauro.outbox_records FOR SELECT TO kauro_payment
  USING (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id IS NULL AND e.aggregate_kind = 'settlement_request'
    AND e.event_type IN ('settlement_request.applied.v1', 'settlement_request.refused.v1')));
CREATE POLICY outbox_records_payment_settlement_request_outcome ON kauro.outbox_records FOR INSERT TO kauro_payment
  WITH CHECK (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id IS NULL AND e.aggregate_kind = 'settlement_request'
    AND e.event_type IN ('settlement_request.applied.v1', 'settlement_request.refused.v1')));

-- --- the refusal's review case (R2 15:153 a case with amount and age; 15:57 never silently abandoned) ----------------------------------
ALTER TABLE kauro.bank_review_cases DROP CONSTRAINT bank_review_cases_kind_check;
ALTER TABLE kauro.bank_review_cases ADD CONSTRAINT bank_review_cases_kind_check CHECK (kind IN ('UNCERTAIN_EFFECT', 'DESTINATION_UNPROVEN', 'REFUND_TERMINAL_CONTRADICTED',
  'UNDECLARED_OUTBOUND', 'POTENTIAL_MATCH_UNRESOLVED', 'RETURN_BOUNCED', 'DOUBLE_RETURN_RISK', 'MATCH_REVIEW', 'PROVIDER_TIME_UNVERIFIED', 'RECORD_REQUIRED', 'SETTLEMENT_REFUSED'));
ALTER TABLE kauro.bank_review_cases DROP CONSTRAINT bank_review_cases_source_kind_check;
ALTER TABLE kauro.bank_review_cases ADD CONSTRAINT bank_review_cases_source_kind_check CHECK (source_kind IN ('CAPTURE', 'BANK_CREDIT', 'SETTLEMENT_REQUEST'));
ALTER TABLE kauro.bank_vocabulary NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.bank_vocabulary (vocabulary, code) VALUES
  ('BANK_CASE_KIND', 'SETTLEMENT_REFUSED'),
  ('BANK_CASE_SOURCE_KIND', 'CAPTURE'), ('BANK_CASE_SOURCE_KIND', 'BANK_CREDIT'), ('BANK_CASE_SOURCE_KIND', 'SETTLEMENT_REQUEST');
ALTER TABLE kauro.bank_vocabulary FORCE ROW LEVEL SECURITY;

-- --- a bank-route settlement is born of its intent ---------------------------------------------------------------------------------------
ALTER TABLE kauro.settlements ADD COLUMN request_id uuid UNIQUE REFERENCES kauro.settlement_requests (request_id);
ALTER TABLE kauro.settlements DROP CONSTRAINT settlements_bank_route_identity;
ALTER TABLE kauro.settlements ADD CONSTRAINT settlements_bank_route_identity CHECK (
  (withdrawal_id IS NULL AND environment IS NULL AND account_ref IS NULL AND artifact_ref IS NULL AND recorded_by IS NULL AND bank_transaction_id IS NULL AND received_cents IS NULL AND request_id IS NULL)
  OR (withdrawal_id IS NOT NULL AND environment IS NOT NULL AND account_ref IS NOT NULL AND artifact_ref IS NOT NULL AND recorded_by IS NOT NULL AND withdrawn_cents > 0 AND request_id IS NOT NULL)
);
-- birth binding: every column a bank-route settlement copies equals its unconsumed intent's (the route's ids: the bank route of the
-- intent's account, bank-settlements.ts); the observation instant is the receipt's when there is one, else the settlement record's
CREATE OR REPLACE FUNCTION kauro.settlements_request_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  r kauro.settlement_requests%ROWTYPE;
  b record;
BEGIN
  SELECT * INTO r FROM kauro.settlement_requests WHERE request_id = NEW.request_id;
  IF NOT FOUND OR r.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'CONTEXT: a settlement is born of an unconsumed intent (%)', NEW.request_id USING ERRCODE = 'KA006';
  END IF;
  SELECT br.route_id, br.payment_route_id INTO b FROM kauro.bank_routes br WHERE br.environment = r.environment AND br.account_ref = r.account_ref;
  IF NOT FOUND OR NEW.route_id IS DISTINCT FROM b.payment_route_id OR NEW.provider_balance_ref IS DISTINCT FROM b.route_id THEN
    RAISE EXCEPTION 'CONTEXT: a settlement belongs to the route of its intent''s account' USING ERRCODE = 'KA006';
  END IF;
  IF NEW.agency_id IS NOT NULL OR NEW.fx_rate IS NOT NULL
     OR NEW.environment IS DISTINCT FROM r.environment OR NEW.account_ref IS DISTINCT FROM r.account_ref OR NEW.withdrawal_id IS DISTINCT FROM r.withdrawal_id
     OR NEW.artifact_ref IS DISTINCT FROM r.artifact_ref OR NEW.evidence_hash IS DISTINCT FROM r.evidence_hash OR NEW.currency IS DISTINCT FROM r.currency
     OR NEW.gross_cents IS DISTINCT FROM r.gross_cents OR NEW.fee_cents IS DISTINCT FROM r.fee_cents OR NEW.held_cents IS DISTINCT FROM r.held_cents
     OR NEW.withdrawn_cents IS DISTINCT FROM r.withdrawn_cents OR NEW.period_start IS DISTINCT FROM r.period_start OR NEW.period_end IS DISTINCT FROM r.period_end
     OR NEW.normalizer_version IS DISTINCT FROM r.normalizer_version OR NEW.recorded_by IS DISTINCT FROM r.requested_by THEN
    RAISE EXCEPTION 'CONTEXT: a settlement copies its intent''s facts' USING ERRCODE = 'KA006';
  END IF;
  IF r.receipt_artifact_ref IS NULL THEN
    IF NEW.receipt_artifact_ref IS NOT NULL OR NEW.bank_evidence_hash IS NOT NULL OR NEW.receiving_account_ref IS NOT NULL OR NEW.bank_transaction_id IS NOT NULL
       OR NEW.received_cents IS NOT NULL OR NEW.bank_available_cents <> 0 OR NEW.observed_at IS DISTINCT FROM r.observed_at THEN
      RAISE EXCEPTION 'CONTEXT: a settlement without its intent''s receipt shows no bank money' USING ERRCODE = 'KA006';
    END IF;
  ELSE
    IF NEW.receipt_artifact_ref IS DISTINCT FROM r.receipt_artifact_ref OR NEW.bank_evidence_hash IS DISTINCT FROM r.receipt_evidence_hash
       OR NEW.receiving_account_ref IS DISTINCT FROM r.receiving_account_ref OR NEW.bank_transaction_id IS DISTINCT FROM r.bank_transaction_id
       OR NEW.received_cents IS DISTINCT FROM r.received_cents OR NEW.bank_available_cents IS DISTINCT FROM r.bank_available_cents
       OR NEW.observed_at IS DISTINCT FROM r.receipt_observed_at THEN
      RAISE EXCEPTION 'CONTEXT: a settlement copies its intent''s receipt' USING ERRCODE = 'KA006';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER settlements_request_birth BEFORE INSERT ON kauro.settlements
  FOR EACH ROW WHEN (NEW.withdrawal_id IS NOT NULL AND NEW.request_id IS NOT NULL) EXECUTE FUNCTION kauro.settlements_request_birth();
-- deferred both ways (rule 19): a settlement's intent is APPLIED with it; an APPLIED intent's settlement exists and names it; a REFUSED
-- intent's case is its own open SETTLEMENT_REFUSED case
CREATE OR REPLACE FUNCTION kauro.settlements_request_applied() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM kauro.settlement_requests r WHERE r.request_id = NEW.request_id AND r.outcome = 'APPLIED' AND r.settlement_id = NEW.settlement_id) THEN
    RAISE EXCEPTION 'CONTEXT: settlement % is not its intent''s applied settlement', NEW.settlement_id USING ERRCODE = 'KA006';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER settlements_request_applied AFTER INSERT ON kauro.settlements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.request_id IS NOT NULL) EXECUTE FUNCTION kauro.settlements_request_applied();
CREATE OR REPLACE FUNCTION kauro.settlement_requests_outcome_bound() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.outcome = 'APPLIED' AND NOT EXISTS (SELECT 1 FROM kauro.settlements s WHERE s.settlement_id = NEW.settlement_id AND s.request_id = NEW.request_id) THEN
    RAISE EXCEPTION 'CONTEXT: applied intent % has no settlement of its own', NEW.request_id USING ERRCODE = 'KA006';
  END IF;
  IF NEW.outcome = 'REFUSED' AND NOT EXISTS (
    SELECT 1 FROM kauro.bank_review_cases c
     WHERE c.case_id = NEW.review_case_id AND c.kind = 'SETTLEMENT_REFUSED' AND c.source_kind = 'SETTLEMENT_REQUEST' AND c.source_id = NEW.request_id
       AND c.environment = NEW.environment AND c.account_ref = NEW.account_ref AND c.detail_code = NEW.refusal_reason AND c.state = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'CONTEXT: refused intent % has no open review case of its own', NEW.request_id USING ERRCODE = 'KA006';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER settlement_requests_outcome_bound AFTER UPDATE ON kauro.settlement_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.settlement_requests_outcome_bound();

-- --- the apply's time judgment (µs-exact, no rounding: F8) ------------------------------------------------------------------------------
-- REQUEST_STALE past p_stale_after since the record; else COVERAGE_END_IN_FUTURE if any instant the evidence states lies after p_at (one
-- branch each, rule 12); else NULL. The caller passes the effect instant it read after its last lock wait.
CREATE OR REPLACE FUNCTION kauro.settlement_request_refusal(p_request uuid, p_at timestamptz, p_stale_after interval) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$
DECLARE
  r kauro.settlement_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM kauro.settlement_requests WHERE request_id = p_request;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTEXT: no settlement intent %', p_request USING ERRCODE = 'KA006';
  END IF;
  IF p_at > r.requested_at + p_stale_after THEN
    RETURN 'REQUEST_STALE';
  END IF;
  IF r.period_end > p_at THEN
    RETURN 'COVERAGE_END_IN_FUTURE';
  END IF;
  IF r.observed_at > p_at THEN
    RETURN 'COVERAGE_END_IN_FUTURE';
  END IF;
  IF r.booked_at IS NOT NULL AND r.booked_at > p_at THEN
    RETURN 'COVERAGE_END_IN_FUTURE';
  END IF;
  IF r.receipt_observed_at IS NOT NULL AND r.receipt_observed_at > p_at THEN
    RETURN 'COVERAGE_END_IN_FUTURE';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION kauro.settlement_request_refusal(uuid, timestamptz, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kauro.settlement_request_refusal(uuid, timestamptz, interval) TO kauro_payment;

-- --- SEC-DEPTH R17: no trigger function of this migration is executable by PUBLIC
REVOKE EXECUTE ON FUNCTION kauro.settlement_requests_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kauro.settlements_request_birth() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kauro.settlements_request_applied() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kauro.settlement_requests_outcome_bound() FROM PUBLIC;
