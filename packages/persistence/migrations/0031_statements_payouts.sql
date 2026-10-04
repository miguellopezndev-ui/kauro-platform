-- 0031 — banking calendars, commission periods, statements, payout intents and their reconciliation, and the owner's compensation
-- guard reviews (package B10, agency recurrence and commission domain), with the platform machines CommissionPeriod,
-- CommissionStatement and PayoutIntent and the statement-bound edges of a commission line.
--
-- Authority: 17 "Business-day calendar", "Accrual, eligibility and payout", "Currency, fees and tax documentation" (Kauro bears
-- ordinary payout fees), "Performance and compensation evolution" (the 15% planning guard is a business target, not a legal
-- ceiling); 12 "Commission statement", "Finance and cost controls"; 15 "Commission integration" (payout receipts reconcile to bank or
-- provider evidence; submitting a transfer is not proof); registry CommissionStatement, CommissionLine; policy commission
-- (statementBusinessDay 5, payBusinessDay 10, minimumPayoutCents 0, feeBearer, operationalTimezone America/Bogota);
-- COMMERCIAL_LEDGER_WORKED_EXAMPLES 7, 21, 22, 23, 25. Design: docs/design/B10-commercial-domain.md §7, §8.1, §8.2, §9 (D10-CAL-1,
-- D10-STMT-1, D10-STMT-2, D10-GUARD-1, D10-PAY-1, D10-PAY-2, D10-CTX-3, D10-EVT-1).
--
-- Writers: the commission service (kauro_commission: CMD051 as the commission-service identity, CMD053 as the finance-service identity,
-- the PERIODS sweep) and the corporate owner (CMD052). Readers: the owner all, a seller its own statements, items and payout intents.
-- No tenant policy (D10-CTX-3); no DELETE grant.
--
-- SQLSTATE vocabulary (class KC, design §12):
--   KC009 PAYEE_UNVERIFIED  KC010 PAYOUT_NOT_SETTLED

-- --- the machines of 0031 (design §8.2; @kauro/domain COMMERCIAL_PLATFORM_MACHINES) -----------------------------------------------------
INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('CommissionPeriod', 'OPEN'), ('CommissionStatement', 'DRAFT'), ('PayoutIntent', 'AUTHORIZED');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('CommissionPeriod', 'OPEN', 'CLOSED'),
  ('CommissionStatement', 'DRAFT', 'ISSUED'),
  ('CommissionStatement', 'ISSUED', 'APPROVED'),
  ('CommissionStatement', 'APPROVED', 'PAID'),
  ('CommissionStatement', 'APPROVED', 'ISSUED'),
  ('CommissionStatement', 'ISSUED', 'DISPUTED'),
  ('CommissionStatement', 'DISPUTED', 'ISSUED'),
  ('CommissionStatement', 'DISPUTED', 'CORRECTED'),
  ('CommissionStatement', 'ISSUED', 'CORRECTED'),
  ('PayoutIntent', 'AUTHORIZED', 'SUBMITTED'),
  ('PayoutIntent', 'SUBMITTED', 'UNCERTAIN'),
  ('PayoutIntent', 'AUTHORIZED', 'SETTLED'),
  ('PayoutIntent', 'SUBMITTED', 'SETTLED'),
  ('PayoutIntent', 'UNCERTAIN', 'SETTLED'),
  ('PayoutIntent', 'AUTHORIZED', 'FAILED'),
  ('PayoutIntent', 'SUBMITTED', 'FAILED'),
  ('PayoutIntent', 'UNCERTAIN', 'FAILED'),
  ('PayoutIntent', 'AUTHORIZED', 'RETURNED'),
  ('PayoutIntent', 'SUBMITTED', 'RETURNED'),
  ('PayoutIntent', 'UNCERTAIN', 'RETURNED');

-- --- banking calendars (D10-CAL-1, R2-139) ------------------------------------------------------------------------------------------
-- A version of the Colombian banking calendar as BankingCalendarSource served it: its source — a VERIFIED_FEED (B15) or the labelled
-- TEST_FIXTURE, which no composition binds — the nonbanking dates besides weekends and the dates it covers. Append-only.
CREATE TABLE kauro.banking_calendars (
  calendar_id       uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(calendar_id)),
  jurisdiction      text NOT NULL CHECK (jurisdiction = 'CO'),
  calendar_version  text NOT NULL CHECK (kauro.is_label(calendar_version)),
  source            text NOT NULL CHECK (source IN ('VERIFIED_FEED', 'TEST_FIXTURE')),
  nonbanking_dates  date[] NOT NULL CHECK (array_position(nonbanking_dates, NULL) IS NULL AND coalesce(array_ndims(nonbanking_dates), 1) = 1
                                          AND cardinality(nonbanking_dates) <= 366 * 5),
  covers_from       date NOT NULL,
  covers_to         date NOT NULL,
  evidence_hash     text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  recorded_at       timestamptz NOT NULL,
  created_at        timestamptz NOT NULL,
  CONSTRAINT banking_calendars_one_version UNIQUE (jurisdiction, calendar_version),
  -- binding target: a period and a statement name the calendar with its source
  UNIQUE (calendar_id, source),
  CONSTRAINT banking_calendars_coverage CHECK (covers_to >= covers_from)
);

-- The ordinal banking day after a day: the `ordinal`-th date after `after_day` that is no Saturday or Sunday and no listed nonbanking
-- date, counted only across the calendar's coverage (NULL when a day it needs lies outside it). The domain's ordinal function mirrors
-- it (example 21: with 2026-10-12 nonbanking, the 5th and 10th after 2026-09-30 are 2026-10-07 and 2026-10-15).
CREATE OR REPLACE FUNCTION kauro.banking_day_after(after_day date, ordinal integer, nonbanking date[], covers_from date, covers_to date) RETURNS date
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$
  SELECT CASE WHEN after_day + 1 < covers_from THEN NULL ELSE (
    SELECT d.day FROM (SELECT after_day + g AS day FROM generate_series(1, 62) AS g) d
     WHERE extract(isodow FROM d.day) < 6 AND NOT (d.day = ANY (nonbanking)) AND d.day <= covers_to
     ORDER BY d.day OFFSET greatest(ordinal, 1) - 1 LIMIT 1
  ) END
$$;

-- --- periods (platform machine CommissionPeriod; D10-CAL-1, D10-STMT-1) --------------------------------------------------------------
-- One calendar month in America/Bogota, [start, end), opened by the PERIODS sweep; its close is due on the 5th and its pay date the
-- 10th banking day after month-end, both stored with the calendar version they came from (checked against it). CLOSED by CMD051 with
-- the ledger cutoff hash it closed on. The transition subject kauro.commission_periods (period): a writer that must land in one
-- statement or the next takes the shared half (CMD051-RACE).
CREATE TABLE kauro.commission_periods (
  period_id        uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(period_id)),
  period_month     date NOT NULL CHECK (extract(day FROM period_month) = 1),
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  version          bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state            text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'CLOSED')),
  calendar_id      uuid,
  calendar_source  text,
  close_due_on     date,
  pay_due_on       date,
  cutoff_hash      text CHECK (cutoff_hash IS NULL OR kauro.is_sha256_hex(cutoff_hash)),
  closed_at        timestamptz,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  CONSTRAINT commission_periods_one_per_month UNIQUE (period_month),
  -- binding targets: a statement names its period's bounds, calendar and dates
  UNIQUE (period_id, starts_at, ends_at),
  UNIQUE (period_id, calendar_id, calendar_source, close_due_on, pay_due_on),
  CONSTRAINT commission_periods_calendar_fk FOREIGN KEY (calendar_id, calendar_source) REFERENCES kauro.banking_calendars (calendar_id, source),
  CONSTRAINT commission_periods_bogota_month CHECK (
    starts_at = (period_month::timestamp AT TIME ZONE 'America/Bogota') AND ends_at = ((period_month + interval '1 month') AT TIME ZONE 'America/Bogota')
  ),
  CONSTRAINT commission_periods_dates_record CHECK (
    (calendar_id IS NULL) = (calendar_source IS NULL) AND (calendar_id IS NULL) = (close_due_on IS NULL) AND (calendar_id IS NULL) = (pay_due_on IS NULL)
  ),
  CONSTRAINT commission_periods_closed_record CHECK ((state = 'CLOSED') = (closed_at IS NOT NULL) AND (state <> 'CLOSED' OR (calendar_id IS NOT NULL AND cutoff_hash IS NOT NULL)))
);

-- --- statements (platform machine CommissionStatement; D10-STMT-1, D10-STMT-2, R2-102, R2-139) -------------------------------------------
-- One immutable statement per period and seller (a correction is its own statement naming the one it corrects): its dates are its
-- period's with the calendar version and source they came from, labelled SIMULATED when that calendar is the TEST_FIXTURE; its totals
-- are separate (accrued pending, held, payable, paid to date, negative balance) and its payable and held totals are the sums of its
-- items (checked at COMMIT). Born DRAFT and ISSUED in the transaction that writes its items; APPROVED with one live payout intent;
-- PAID only with its SETTLED intent's evidence (KC010).
CREATE TABLE kauro.commission_statements (
  statement_id            uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(statement_id)),
  period_id               uuid NOT NULL,
  seller_id               uuid NOT NULL REFERENCES kauro.sellers (seller_id),
  period_starts_at        timestamptz NOT NULL,
  period_ends_at          timestamptz NOT NULL,
  calendar_id             uuid NOT NULL,
  calendar_source         text NOT NULL,
  statement_date          date NOT NULL,
  pay_date                date NOT NULL,
  label                   text NOT NULL CHECK (label IN ('VERIFIED_CALENDAR', 'SIMULATED')),
  accrued_pending_cents   bigint NOT NULL CHECK (kauro.is_money(accrued_pending_cents)),
  held_cents              bigint NOT NULL CHECK (kauro.is_money(held_cents)),
  payable_cents           bigint NOT NULL CHECK (kauro.is_money(payable_cents)),
  paid_to_date_cents      bigint NOT NULL CHECK (kauro.is_money(paid_to_date_cents)),
  negative_balance_cents  bigint NOT NULL CHECK (kauro.is_money(negative_balance_cents)),
  cutoff_hash             text NOT NULL CHECK (kauro.is_sha256_hex(cutoff_hash)),
  corrects_statement_id   uuid,
  version                 bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                   text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'ISSUED', 'DISPUTED', 'APPROVED', 'PAID', 'CORRECTED')),
  issued_at               timestamptz,
  approved_at             timestamptz,
  approved_by_user_id     uuid,
  approval_proof_ref      uuid,
  paid_at                 timestamptz,
  payout_evidence_hash    text CHECK (payout_evidence_hash IS NULL OR kauro.is_sha256_hex(payout_evidence_hash)),
  corrected_at            timestamptz,
  created_at              timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL,
  -- binding targets: an item names a statement of its seller; an intent the statement's payable exactly
  UNIQUE (statement_id, seller_id),
  CONSTRAINT commission_statements_payable_binding UNIQUE (statement_id, seller_id, payable_cents),
  CONSTRAINT commission_statements_period_fk FOREIGN KEY (period_id, period_starts_at, period_ends_at) REFERENCES kauro.commission_periods (period_id, starts_at, ends_at),
  CONSTRAINT commission_statements_dates_fk FOREIGN KEY (period_id, calendar_id, calendar_source, statement_date, pay_date)
    REFERENCES kauro.commission_periods (period_id, calendar_id, calendar_source, close_due_on, pay_due_on),
  CONSTRAINT commission_statements_corrects_fk FOREIGN KEY (corrects_statement_id, seller_id) REFERENCES kauro.commission_statements (statement_id, seller_id),
  CONSTRAINT commission_statements_approver_proof_fk FOREIGN KEY (approved_by_user_id, approval_proof_ref) REFERENCES kauro.assurance_proofs (user_id, proof_id),
  CONSTRAINT commission_statements_simulated_label CHECK ((label = 'SIMULATED') = (calendar_source = 'TEST_FIXTURE')),
  CONSTRAINT commission_statements_issued_record CHECK ((state = 'DRAFT') = (issued_at IS NULL)),
  CONSTRAINT commission_statements_approval_record CHECK (
    (approved_at IS NULL) = (approved_by_user_id IS NULL) AND (approved_at IS NULL) = (approval_proof_ref IS NULL) AND (state NOT IN ('APPROVED', 'PAID') OR approved_at IS NOT NULL)
  ),
  CONSTRAINT commission_statements_paid_record CHECK ((state = 'PAID') = (paid_at IS NOT NULL) AND (paid_at IS NULL) = (payout_evidence_hash IS NULL)),
  CONSTRAINT commission_statements_corrected_record CHECK ((state = 'CORRECTED') = (corrected_at IS NOT NULL)),
  CONSTRAINT commission_statements_not_self CHECK (corrects_statement_id IS DISTINCT FROM statement_id)
);
CREATE UNIQUE INDEX commission_statements_one_per_period_seller ON kauro.commission_statements (period_id, seller_id) WHERE corrects_statement_id IS NULL;
CREATE UNIQUE INDEX commission_statements_one_correction ON kauro.commission_statements (corrects_statement_id) WHERE corrects_statement_id IS NOT NULL;

-- One item of a statement (12 "Commission statement": agency and project reference, first or repeat, basis, rate, share, cumulative,
-- previously paid, adjustment, hold with reason and review date, payable): a LINE (payable, awaiting its final completion or its
-- funds — a reasoned hold, never payable —, or held), an ADJUSTMENT reported in this statement, a partial HOLD it withholds, an OFFSET
-- it applies, or a RECOVERY item of a negative balance for the owner (REPAYMENT_REVIEW, WRITE_OFF or DISPUTE; D10-NEG-1). Only a
-- PAYABLE line item carries payable cents — net of what it withholds and offsets — and the statement's payable and held totals are
-- the sums of its items' (D10-STMT-2). Written while the statement is DRAFT; append-only.
CREATE TABLE kauro.statement_items (
  item_id                uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(item_id)),
  statement_id           uuid NOT NULL,
  seller_id              uuid NOT NULL,
  item_no                integer NOT NULL CHECK (item_no >= 1),
  item_kind              text NOT NULL CHECK (item_kind IN ('LINE', 'ADJUSTMENT', 'HOLD', 'OFFSET', 'RECOVERY')),
  disposition            text NOT NULL CHECK (disposition IN ('PAYABLE', 'AWAITING_FINAL_COMPLETION', 'AWAITING_FUNDS', 'HELD', 'REPORTED', 'REPAYMENT_REVIEW', 'WRITE_OFF', 'DISPUTE')),
  line_id                uuid,
  adjustment_id          uuid,
  hold_id                uuid,
  offset_id              uuid,
  agency_id              uuid REFERENCES kauro.agencies (agency_id),
  project_id             uuid,
  rate_kind              text CHECK (rate_kind IS NULL OR rate_kind IN ('FIRST', 'REPEAT', 'ASSISTANCE')),
  basis_cents            bigint CHECK (basis_cents IS NULL OR kauro.is_money(basis_cents)),
  rate_bps               integer CHECK (rate_bps IS NULL OR rate_bps BETWEEN 1 AND 10000),
  share_bps              integer CHECK (share_bps IS NULL OR share_bps BETWEEN 1 AND 10000),
  cumulative_cents       bigint CHECK (cumulative_cents IS NULL OR kauro.is_money(cumulative_cents)),
  previously_paid_cents  bigint CHECK (previously_paid_cents IS NULL OR kauro.is_money(previously_paid_cents)),
  adjustment_direction   text CHECK (adjustment_direction IS NULL OR adjustment_direction IN ('INCREASE', 'DECREASE')),
  adjustment_cents       bigint CHECK (adjustment_cents IS NULL OR kauro.is_money(adjustment_cents)),
  held_cents             bigint NOT NULL DEFAULT 0 CHECK (kauro.is_money(held_cents)),
  hold_reason            text CHECK (hold_reason IS NULL OR kauro.is_token(hold_reason)),
  hold_review_at         timestamptz,
  offset_cents           bigint NOT NULL DEFAULT 0 CHECK (kauro.is_money(offset_cents)),
  payable_cents          bigint NOT NULL DEFAULT 0 CHECK (kauro.is_money(payable_cents)),
  created_at             timestamptz NOT NULL,
  CONSTRAINT statement_items_one_per_number UNIQUE (statement_id, item_no),
  CONSTRAINT statement_items_statement_fk FOREIGN KEY (statement_id, seller_id) REFERENCES kauro.commission_statements (statement_id, seller_id),
  CONSTRAINT statement_items_line_fk FOREIGN KEY (line_id, seller_id) REFERENCES kauro.commission_lines (line_id, seller_id),
  CONSTRAINT statement_items_adjustment_fk FOREIGN KEY (adjustment_id, seller_id) REFERENCES kauro.commission_adjustments (adjustment_id, seller_id),
  CONSTRAINT statement_items_hold_fk FOREIGN KEY (hold_id, seller_id) REFERENCES kauro.commission_holds (hold_id, seller_id),
  CONSTRAINT statement_items_offset_fk FOREIGN KEY (offset_id, seller_id) REFERENCES kauro.commission_offsets (offset_id, seller_id),
  CONSTRAINT statement_items_project_fk FOREIGN KEY (agency_id, project_id) REFERENCES kauro.projects (agency_id, project_id),
  CONSTRAINT statement_items_kind CHECK (
    (item_kind = 'LINE' AND line_id IS NOT NULL AND disposition IN ('PAYABLE', 'AWAITING_FINAL_COMPLETION', 'AWAITING_FUNDS', 'HELD'))
    OR (item_kind = 'ADJUSTMENT' AND adjustment_id IS NOT NULL AND disposition = 'REPORTED')
    OR (item_kind = 'HOLD' AND hold_id IS NOT NULL AND disposition = 'HELD')
    OR (item_kind = 'OFFSET' AND offset_id IS NOT NULL AND disposition = 'REPORTED')
    OR (item_kind = 'RECOVERY' AND line_id IS NOT NULL AND disposition IN ('REPAYMENT_REVIEW', 'WRITE_OFF', 'DISPUTE'))
  ),
  CONSTRAINT statement_items_payable_only_payable_line CHECK (payable_cents = 0 OR (item_kind = 'LINE' AND disposition = 'PAYABLE')),
  CONSTRAINT statement_items_hold_reasoned CHECK ((held_cents = 0) OR (hold_reason IS NOT NULL AND hold_review_at IS NOT NULL)),
  CONSTRAINT statement_items_adjustment_signed CHECK ((adjustment_cents IS NULL) = (adjustment_direction IS NULL))
);
CREATE UNIQUE INDEX statement_items_one_line_item ON kauro.statement_items (statement_id, line_id) WHERE item_kind = 'LINE';

-- --- payout intents and their reconciliation (platform machine PayoutIntent; D10-PAY-1, D10-PAY-2, R2-103) -------------------------------
-- The owner's authorization of exactly the statement's payable (minimumPayoutCents 0: any positive amount) to a VERIFIED destination
-- version of the statement's seller, which it keeps whatever changes later (KC009); fee bearer Kauro; the stable reference
-- kauro-payout-<intentId>. One live intent per statement: a FAILED or RETURNED one is kept with its evidence beside the next.
CREATE TABLE kauro.payout_intents (
  intent_id                uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(intent_id)),
  statement_id             uuid NOT NULL,
  seller_id                uuid NOT NULL,
  amount_cents             bigint NOT NULL CHECK (kauro.is_money(amount_cents) AND amount_cents > 0),
  currency                 text NOT NULL CHECK (currency = 'USD'),
  fee_bearer               text NOT NULL CHECK (fee_bearer = 'KAURO'),
  destination_id           uuid NOT NULL,
  destination_version      integer NOT NULL,
  destination_digest       text NOT NULL,
  reference                text NOT NULL,
  version                  bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                    text NOT NULL DEFAULT 'AUTHORIZED' CHECK (state IN ('AUTHORIZED', 'SUBMITTED', 'UNCERTAIN', 'SETTLED', 'FAILED', 'RETURNED')),
  authorized_by_user_id    uuid NOT NULL,
  authorization_proof_ref  uuid NOT NULL,
  authorized_at            timestamptz NOT NULL,
  evidence_hash            text CHECK (evidence_hash IS NULL OR kauro.is_sha256_hex(evidence_hash)),
  submitted_at             timestamptz,
  settled_at               timestamptz,
  failed_at                timestamptz,
  returned_at              timestamptz,
  created_at               timestamptz NOT NULL,
  updated_at               timestamptz NOT NULL,
  UNIQUE (intent_id, seller_id),
  -- binding target of payout_reconciliations: evidence names exactly the intent's reference, destination digest, amount and currency
  CONSTRAINT payout_intents_evidence_binding UNIQUE (intent_id, reference, destination_digest, amount_cents, currency),
  CONSTRAINT payout_intents_amount_is_payable FOREIGN KEY (statement_id, seller_id, amount_cents) REFERENCES kauro.commission_statements (statement_id, seller_id, payable_cents),
  CONSTRAINT payout_intents_destination_fk FOREIGN KEY (seller_id, destination_id, destination_version, destination_digest)
    REFERENCES kauro.seller_payout_destinations (seller_id, destination_id, destination_version, destination_digest),
  CONSTRAINT payout_intents_authorizer_proof_fk FOREIGN KEY (authorized_by_user_id, authorization_proof_ref) REFERENCES kauro.assurance_proofs (user_id, proof_id),
  CONSTRAINT payout_intents_reference CHECK (reference = 'kauro-payout-' || intent_id::text),
  CONSTRAINT payout_intents_evidence CHECK (
    (state NOT IN ('SETTLED', 'FAILED', 'RETURNED') OR evidence_hash IS NOT NULL)
    AND ((state = 'SETTLED') = (settled_at IS NOT NULL)) AND ((state = 'FAILED') = (failed_at IS NOT NULL)) AND ((state = 'RETURNED') = (returned_at IS NOT NULL))
  )
);
CREATE UNIQUE INDEX payout_intents_one_live_per_statement ON kauro.payout_intents (statement_id) WHERE state IN ('AUTHORIZED', 'SUBMITTED', 'UNCERTAIN', 'SETTLED');

-- Authenticated payout evidence as PayoutEvidenceVerifier returned it, matching the intent's reference, destination digest, amount
-- and currency exactly (evidence that does not match changes nothing and is not recorded; PAYOUT_EVIDENCE_MISMATCH). Append-only.
CREATE TABLE kauro.payout_reconciliations (
  reconciliation_id   uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(reconciliation_id)),
  intent_id           uuid NOT NULL,
  evidence_kind       text NOT NULL CHECK (evidence_kind IN ('SUBMITTED', 'SETTLED', 'FAILED', 'RETURNED')),
  evidence_hash       text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  reference           text NOT NULL,
  destination_digest  text NOT NULL,
  amount_cents        bigint NOT NULL,
  currency            text NOT NULL,
  provider_ref        text CHECK (provider_ref IS NULL OR kauro.is_provider_ref(provider_ref)),
  observed_at         timestamptz NOT NULL,
  recorded_at         timestamptz NOT NULL,
  created_at          timestamptz NOT NULL,
  CONSTRAINT payout_reconciliations_evidence_matches_intent FOREIGN KEY (intent_id, reference, destination_digest, amount_cents, currency)
    REFERENCES kauro.payout_intents (intent_id, reference, destination_digest, amount_cents, currency),
  CONSTRAINT payout_reconciliations_one_per_evidence UNIQUE (intent_id, evidence_hash)
);

-- --- compensation guard reviews (D10-GUARD-1, R2-105) --------------------------------------------------------------------------------
-- The owner's review, per period and seller, of total commercial compensation (retainer plus commission accrued) against attributable
-- net service: EXCEEDS_PLANNING_GUARD above 1500 bps by exact integer comparison. A business planning guard, never a legal ceiling:
-- it refuses nothing. Append-only.
CREATE TABLE kauro.compensation_guard_reviews (
  review_id                       uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(review_id)),
  period_id                       uuid NOT NULL REFERENCES kauro.commission_periods (period_id),
  seller_id                       uuid NOT NULL REFERENCES kauro.sellers (seller_id),
  statement_id                    uuid,
  retainer_cents                  bigint NOT NULL CHECK (kauro.is_money(retainer_cents)),
  commission_accrued_cents        bigint NOT NULL CHECK (kauro.is_money(commission_accrued_cents)),
  attributable_net_service_cents  bigint NOT NULL CHECK (kauro.is_money(attributable_net_service_cents)),
  guard_bps                       integer NOT NULL CHECK (guard_bps = 1500),
  outcome                         text NOT NULL CHECK (outcome IN ('WITHIN_PLANNING_GUARD', 'EXCEEDS_PLANNING_GUARD')),
  label                           text NOT NULL CHECK (label = 'BUSINESS_PLANNING_GUARD'),
  created_at                      timestamptz NOT NULL,
  CONSTRAINT compensation_guard_reviews_one_per_period_seller UNIQUE (period_id, seller_id),
  CONSTRAINT compensation_guard_reviews_statement_fk FOREIGN KEY (statement_id, seller_id) REFERENCES kauro.commission_statements (statement_id, seller_id),
  CONSTRAINT compensation_guard_reviews_outcome CHECK (
    (outcome = 'EXCEEDS_PLANNING_GUARD') = ((retainer_cents::numeric + commission_accrued_cents::numeric) * 10000 > guard_bps::numeric * attributable_net_service_cents::numeric)
  )
);

-- --- bookkeeping, immutability and the listed edges -------------------------------------------------------------------------------
CREATE TRIGGER banking_calendars_append_only BEFORE UPDATE OR DELETE ON kauro.banking_calendars FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER banking_calendars_no_truncate BEFORE TRUNCATE ON kauro.banking_calendars FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER banking_calendars_server_instant BEFORE INSERT ON kauro.banking_calendars FOR EACH ROW EXECUTE FUNCTION kauro.require_server_instant('recorded_at');

CREATE TRIGGER commission_periods_touch BEFORE UPDATE ON kauro.commission_periods FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER commission_periods_version BEFORE UPDATE ON kauro.commission_periods FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER commission_periods_immutable BEFORE UPDATE ON kauro.commission_periods
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('period_id,period_month,starts_at,ends_at,created_at');
CREATE TRIGGER commission_periods_learned_once BEFORE UPDATE ON kauro.commission_periods
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('calendar_id,calendar_source,close_due_on,pay_due_on,cutoff_hash,closed_at');
CREATE TRIGGER commission_periods_transition BEFORE UPDATE OF state ON kauro.commission_periods FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('CommissionPeriod');
CREATE TRIGGER commission_periods_initial_state BEFORE INSERT ON kauro.commission_periods FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('CommissionPeriod');
CREATE TRIGGER commission_periods_transition_lock BEFORE UPDATE OF state ON kauro.commission_periods
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.take_transition_lock('kauro.commission_periods', 'period_id');
CREATE TRIGGER commission_periods_history AFTER INSERT OR UPDATE OF state ON kauro.commission_periods
  FOR EACH ROW EXECUTE FUNCTION kauro.record_corporate_transition('CommissionPeriod', 'period_id', 'state');
CREATE TRIGGER commission_periods_no_delete BEFORE DELETE ON kauro.commission_periods FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER commission_periods_no_truncate BEFORE TRUNCATE ON kauro.commission_periods FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

CREATE TRIGGER commission_statements_touch BEFORE UPDATE ON kauro.commission_statements FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER commission_statements_version BEFORE UPDATE ON kauro.commission_statements FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER commission_statements_immutable BEFORE UPDATE ON kauro.commission_statements
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('statement_id,period_id,seller_id,period_starts_at,period_ends_at,calendar_id,calendar_source,statement_date,pay_date,label,accrued_pending_cents,held_cents,payable_cents,paid_to_date_cents,negative_balance_cents,cutoff_hash,corrects_statement_id,created_at');
CREATE TRIGGER commission_statements_learned_once BEFORE UPDATE ON kauro.commission_statements
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('issued_at,paid_at,payout_evidence_hash,corrected_at');
CREATE TRIGGER commission_statements_transition BEFORE UPDATE OF state ON kauro.commission_statements
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('CommissionStatement');
CREATE TRIGGER commission_statements_initial_state BEFORE INSERT ON kauro.commission_statements
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('CommissionStatement');
CREATE TRIGGER commission_statements_history AFTER INSERT OR UPDATE OF state ON kauro.commission_statements
  FOR EACH ROW EXECUTE FUNCTION kauro.record_corporate_transition('CommissionStatement', 'statement_id', 'state');
CREATE TRIGGER commission_statements_no_delete BEFORE DELETE ON kauro.commission_statements FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER commission_statements_no_truncate BEFORE TRUNCATE ON kauro.commission_statements FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

CREATE TRIGGER statement_items_append_only BEFORE UPDATE OR DELETE ON kauro.statement_items FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER statement_items_no_truncate BEFORE TRUNCATE ON kauro.statement_items FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

CREATE TRIGGER payout_intents_touch BEFORE UPDATE ON kauro.payout_intents FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER payout_intents_version BEFORE UPDATE ON kauro.payout_intents FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER payout_intents_immutable BEFORE UPDATE ON kauro.payout_intents
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('intent_id,statement_id,seller_id,amount_cents,currency,fee_bearer,destination_id,destination_version,destination_digest,reference,authorized_by_user_id,authorization_proof_ref,authorized_at,created_at');
CREATE TRIGGER payout_intents_learned_once BEFORE UPDATE ON kauro.payout_intents
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('evidence_hash,submitted_at,settled_at,failed_at,returned_at');
CREATE TRIGGER payout_intents_transition BEFORE UPDATE OF state ON kauro.payout_intents FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('PayoutIntent');
CREATE TRIGGER payout_intents_initial_state BEFORE INSERT ON kauro.payout_intents FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('PayoutIntent');
CREATE TRIGGER payout_intents_server_instant BEFORE INSERT ON kauro.payout_intents FOR EACH ROW EXECUTE FUNCTION kauro.require_server_instant('authorized_at');
CREATE TRIGGER payout_intents_history AFTER INSERT OR UPDATE OF state ON kauro.payout_intents
  FOR EACH ROW EXECUTE FUNCTION kauro.record_corporate_transition('PayoutIntent', 'intent_id', 'state');
CREATE TRIGGER payout_intents_no_delete BEFORE DELETE ON kauro.payout_intents FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER payout_intents_no_truncate BEFORE TRUNCATE ON kauro.payout_intents FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

CREATE TRIGGER payout_reconciliations_append_only BEFORE UPDATE OR DELETE ON kauro.payout_reconciliations FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER payout_reconciliations_no_truncate BEFORE TRUNCATE ON kauro.payout_reconciliations FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER payout_reconciliations_server_instant BEFORE INSERT ON kauro.payout_reconciliations FOR EACH ROW EXECUTE FUNCTION kauro.require_server_instant('recorded_at');

CREATE TRIGGER compensation_guard_reviews_append_only BEFORE UPDATE OR DELETE ON kauro.compensation_guard_reviews FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER compensation_guard_reviews_no_truncate BEFORE TRUNCATE ON kauro.compensation_guard_reviews FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

-- --- the period's dates and close (D10-CAL-1, R2-139) ------------------------------------------------------------------------------
-- The close and pay dates are the 5th and 10th banking days after the period's last day under the calendar version they are stored
-- with; the close is recorded at the server's instant. Named check violation commission_periods_banking_days (23514).
CREATE OR REPLACE FUNCTION kauro.commission_periods_dates() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  calendar record;
  month_end date := (NEW.period_month + interval '1 month' - interval '1 day')::date;
BEGIN
  IF NEW.calendar_id IS NOT NULL THEN
    SELECT c.nonbanking_dates, c.covers_from, c.covers_to INTO calendar FROM kauro.banking_calendars c WHERE c.calendar_id = NEW.calendar_id;
    IF NOT FOUND
       OR NEW.close_due_on IS DISTINCT FROM kauro.banking_day_after(month_end, 5, calendar.nonbanking_dates, calendar.covers_from, calendar.covers_to)
       OR NEW.pay_due_on IS DISTINCT FROM kauro.banking_day_after(month_end, 10, calendar.nonbanking_dates, calendar.covers_from, calendar.covers_to)
       OR NEW.close_due_on IS NULL OR NEW.pay_due_on IS NULL THEN
      RAISE EXCEPTION 'BANKING_DAYS: the close and pay dates of period % are the 5th and 10th banking days after its month under the calendar they name', NEW.period_month
        USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_periods_banking_days', SCHEMA = 'kauro', TABLE = 'commission_periods';
    END IF;
  END IF;
  IF NEW.state = 'CLOSED' AND NEW.closed_at IS DISTINCT FROM kauro.server_now() AND (TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM 'CLOSED') THEN
    RAISE EXCEPTION 'BANKING_DAYS: period % closes at the server''s instant', NEW.period_month
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_periods_banking_days', SCHEMA = 'kauro', TABLE = 'commission_periods';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commission_periods_dates BEFORE INSERT OR UPDATE ON kauro.commission_periods FOR EACH ROW EXECUTE FUNCTION kauro.commission_periods_dates();

-- --- the statement's edges (D10-STMT-1, D10-STMT-2, D10-PAY-1, D10-PAY-2) -------------------------------------------------------------
-- An item is written while its statement is DRAFT (IMMUTABLE_COLUMN, KA004: an issued statement never changes).
CREATE OR REPLACE FUNCTION kauro.statement_items_draft_statement() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM kauro.commission_statements s WHERE s.statement_id = NEW.statement_id AND s.state = 'DRAFT') THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: statement % takes items only while it is a DRAFT', NEW.statement_id USING ERRCODE = 'KA004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER statement_items_draft_statement BEFORE INSERT ON kauro.statement_items FOR EACH ROW EXECUTE FUNCTION kauro.statement_items_draft_statement();

-- At COMMIT: a statement past DRAFT has its payable and held totals equal to the sums of its items (named check violation
-- commission_statements_items_total, 23514).
CREATE OR REPLACE FUNCTION kauro.commission_statements_items_total() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  statement record;
BEGIN
  SELECT s.statement_id, s.state, s.payable_cents, s.held_cents INTO statement FROM kauro.commission_statements s WHERE s.statement_id = NEW.statement_id;
  IF statement.state IS DISTINCT FROM 'DRAFT' AND (
       statement.payable_cents <> (SELECT coalesce(sum(i.payable_cents), 0) FROM kauro.statement_items i WHERE i.statement_id = NEW.statement_id)
       OR statement.held_cents <> (SELECT coalesce(sum(i.held_cents), 0) FROM kauro.statement_items i WHERE i.statement_id = NEW.statement_id)) THEN
    RAISE EXCEPTION 'STATEMENT_TOTALS: the payable and held totals of statement % are the sums of its items', NEW.statement_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_statements_items_total', SCHEMA = 'kauro', TABLE = 'commission_statements';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER commission_statements_items_total AFTER UPDATE OF state ON kauro.commission_statements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.state = 'DRAFT') EXECUTE FUNCTION kauro.commission_statements_items_total();
CREATE CONSTRAINT TRIGGER statement_items_total AFTER INSERT ON kauro.statement_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.commission_statements_items_total();

-- statement_issued at the server's instant; payout_approved by the session's person (the owner, by policy) with its own fresh step-up
-- at the server's instant; payout_settled only with the SETTLED intent's evidence (PAYOUT_NOT_SETTLED, KC010); payout_not_settled only
-- when the statement's intents are all FAILED or RETURNED; correction_issued at the server's instant. Named check violation
-- commission_statements_edge (23514) unless KC010. Each edge is its own statement: the approval reads the approver's step-up, which
-- the commission service (whose edges these others are) has no privilege to read.
CREATE OR REPLACE FUNCTION kauro.commission_statements_edge() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  refused boolean := false;
BEGIN
  IF NEW.state = 'PAID' THEN
    IF NEW.paid_at IS DISTINCT FROM kauro.server_now() OR NOT EXISTS (
         SELECT 1 FROM kauro.payout_intents p WHERE p.statement_id = OLD.statement_id AND p.state = 'SETTLED' AND p.evidence_hash = NEW.payout_evidence_hash) THEN
      RAISE EXCEPTION 'PAYOUT_NOT_SETTLED: statement % is paid only with its SETTLED intent''s evidence', OLD.statement_id USING ERRCODE = 'KC010';
    END IF;
  ELSIF NEW.state = 'APPROVED' THEN
    refused := NEW.approved_by_user_id IS DISTINCT FROM kauro.current_user_id() OR NEW.approved_at IS DISTINCT FROM kauro.server_now()
      OR NOT EXISTS (
        SELECT 1 FROM kauro.assurance_proofs p
         WHERE p.user_id = NEW.approved_by_user_id AND p.proof_id = NEW.approval_proof_ref AND p.kind = 'STEP_UP'
           AND p.issued_at <= kauro.server_now() AND p.expires_at > kauro.server_now());
  ELSIF OLD.state = 'DRAFT' AND NEW.state = 'ISSUED' THEN
    refused := NEW.issued_at IS DISTINCT FROM kauro.server_now();
  ELSIF OLD.state = 'APPROVED' AND NEW.state = 'ISSUED' THEN
    refused := NOT EXISTS (SELECT 1 FROM kauro.payout_intents p WHERE p.statement_id = OLD.statement_id AND p.state IN ('FAILED', 'RETURNED'))
      OR EXISTS (SELECT 1 FROM kauro.payout_intents p WHERE p.statement_id = OLD.statement_id AND p.state IN ('AUTHORIZED', 'SUBMITTED', 'UNCERTAIN', 'SETTLED'));
  ELSIF NEW.state = 'CORRECTED' THEN
    refused := NEW.corrected_at IS DISTINCT FROM kauro.server_now();
  END IF;
  IF refused THEN
    RAISE EXCEPTION 'STATEMENT_EDGE: statement % %->% does not meet its guard', OLD.statement_id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_statements_edge', SCHEMA = 'kauro', TABLE = 'commission_statements';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commission_statements_edge BEFORE UPDATE OF state ON kauro.commission_statements
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.commission_statements_edge();

-- At COMMIT: an APPROVED statement has its live AUTHORIZED intent; a CORRECTED one its correcting statement (named check violation
-- commission_statements_edge, 23514).
CREATE OR REPLACE FUNCTION kauro.commission_statements_settled() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  current_state text;
BEGIN
  SELECT s.state INTO current_state FROM kauro.commission_statements s WHERE s.statement_id = NEW.statement_id;
  IF (current_state = 'APPROVED' AND NOT EXISTS (SELECT 1 FROM kauro.payout_intents p WHERE p.statement_id = NEW.statement_id AND p.state = 'AUTHORIZED'))
     OR (current_state = 'CORRECTED' AND NOT EXISTS (SELECT 1 FROM kauro.commission_statements c WHERE c.corrects_statement_id = NEW.statement_id)) THEN
    RAISE EXCEPTION 'STATEMENT_EDGE: statement % is % without its intent or correction', NEW.statement_id, current_state
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_statements_edge', SCHEMA = 'kauro', TABLE = 'commission_statements';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER commission_statements_settled AFTER UPDATE OF state ON kauro.commission_statements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state IN ('APPROVED', 'CORRECTED')) EXECUTE FUNCTION kauro.commission_statements_settled();

-- --- the intent's birth and edges (D10-PAY-1, D10-PAY-2, R2-103) -------------------------------------------------------------------
-- The payee is a VERIFIED destination version of the statement's seller (PAYEE_UNVERIFIED, KC009); the statement is ISSUED or being
-- approved in this transaction; the authorizer is the session's person (the owner, by policy) with its own fresh step-up.
CREATE OR REPLACE FUNCTION kauro.payout_intents_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.seller_payout_destinations d
     WHERE d.destination_id = NEW.destination_id AND d.seller_id = NEW.seller_id AND d.destination_version = NEW.destination_version
       AND d.destination_digest = NEW.destination_digest AND d.state = 'VERIFIED'
  ) THEN
    RAISE EXCEPTION 'PAYEE_UNVERIFIED: the payee of a payout of statement % is not a VERIFIED destination version of its seller', NEW.statement_id USING ERRCODE = 'KC009';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kauro.commission_statements s WHERE s.statement_id = NEW.statement_id AND s.state IN ('ISSUED', 'APPROVED'))
     OR NEW.authorized_by_user_id IS DISTINCT FROM kauro.current_user_id()
     OR NOT EXISTS (
       SELECT 1 FROM kauro.assurance_proofs p
        WHERE p.user_id = NEW.authorized_by_user_id AND p.proof_id = NEW.authorization_proof_ref AND p.kind = 'STEP_UP'
          AND p.issued_at <= kauro.server_now() AND p.expires_at > kauro.server_now()
     ) THEN
    RAISE EXCEPTION 'PAYOUT_AUTHORIZATION: a payout of statement % is authorized for an ISSUED statement by the session''s owner with a fresh step-up', NEW.statement_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payout_intents_authorization', SCHEMA = 'kauro', TABLE = 'payout_intents';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payout_intents_birth BEFORE INSERT ON kauro.payout_intents FOR EACH ROW EXECUTE FUNCTION kauro.payout_intents_birth();

-- settled_evidence, failed_evidence and returned_evidence: at the server's instant, with the recorded reconciliation of that kind
-- whose evidence the intent keeps (checked at COMMIT; named check violation payout_intents_reconciled, 23514); an intent born in a
-- transaction leaves its statement APPROVED at COMMIT (named check violation payout_intents_authorization, 23514).
CREATE OR REPLACE FUNCTION kauro.payout_intents_reconciled() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  intent record;
BEGIN
  SELECT p.intent_id, p.statement_id, p.state, p.evidence_hash, coalesce(p.settled_at, p.failed_at, p.returned_at) AS at INTO intent
    FROM kauro.payout_intents p WHERE p.intent_id = NEW.intent_id;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM kauro.commission_statements s WHERE s.statement_id = intent.statement_id AND s.state IN ('APPROVED', 'PAID', 'ISSUED') AND
                   (s.state <> 'ISSUED' OR intent.state IN ('FAILED', 'RETURNED'))) THEN
      RAISE EXCEPTION 'PAYOUT_AUTHORIZATION: the statement of intent % is approved with it', NEW.intent_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'payout_intents_authorization', SCHEMA = 'kauro', TABLE = 'payout_intents';
    END IF;
  ELSIF intent.state IN ('SETTLED', 'FAILED', 'RETURNED') AND (
          intent.at IS DISTINCT FROM kauro.server_now() OR NOT EXISTS (
            SELECT 1 FROM kauro.payout_reconciliations r WHERE r.intent_id = NEW.intent_id AND r.evidence_kind = intent.state AND r.evidence_hash = intent.evidence_hash)) THEN
    RAISE EXCEPTION 'PAYOUT_RECONCILIATION: intent % is % only with its recorded matching evidence of that kind, at the server''s instant', NEW.intent_id, intent.state
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payout_intents_reconciled', SCHEMA = 'kauro', TABLE = 'payout_intents';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER payout_intents_approved AFTER INSERT ON kauro.payout_intents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.payout_intents_reconciled();
CREATE CONSTRAINT TRIGGER payout_intents_reconciled AFTER UPDATE OF state ON kauro.payout_intents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state IN ('SETTLED', 'FAILED', 'RETURNED')) EXECUTE FUNCTION kauro.payout_intents_reconciled();

-- --- the statement-bound edges of a line (registry CommissionLine; design §8.1) ------------------------------------------------------
-- statement_closed: an ISSUED (or later) statement of the line's seller has the line's PAYABLE item (checked at COMMIT; named check
-- violation commission_lines_payable_through_statement, 23514).
CREATE OR REPLACE FUNCTION kauro.commission_lines_payable_through_statement() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.statement_items i JOIN kauro.commission_statements s ON s.statement_id = i.statement_id
     WHERE i.line_id = NEW.line_id AND i.item_kind = 'LINE' AND i.disposition = 'PAYABLE' AND s.seller_id = NEW.seller_id
       AND s.state IN ('ISSUED', 'APPROVED', 'PAID')
  ) THEN
    RAISE EXCEPTION 'LINE_PAYABLE: line % becomes PAYABLE only through an ISSUED statement item naming it', NEW.line_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_lines_payable_through_statement', SCHEMA = 'kauro', TABLE = 'commission_lines';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER commission_lines_payable_through_statement AFTER UPDATE OF state ON kauro.commission_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state = 'PAYABLE' AND OLD.state IS DISTINCT FROM 'PAYABLE')
  EXECUTE FUNCTION kauro.commission_lines_payable_through_statement();

-- settled_payout_evidence (PAYOUT_NOT_SETTLED, KC010): the statement whose PAYABLE item names the line has its intent SETTLED with an
-- evidence hash, and the line records that item's payable cents as paid, at the server's instant.
CREATE OR REPLACE FUNCTION kauro.commission_lines_paid() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  item record;
BEGIN
  SELECT i.payable_cents INTO item
    FROM kauro.statement_items i JOIN kauro.commission_statements s ON s.statement_id = i.statement_id
   WHERE i.line_id = OLD.line_id AND i.item_kind = 'LINE' AND i.disposition = 'PAYABLE' AND s.seller_id = OLD.seller_id
     AND EXISTS (SELECT 1 FROM kauro.payout_intents p WHERE p.statement_id = s.statement_id AND p.state = 'SETTLED' AND p.evidence_hash IS NOT NULL)
   ORDER BY s.issued_at DESC LIMIT 1;
  IF NOT FOUND OR NEW.paid_cents IS DISTINCT FROM coalesce(OLD.paid_cents, 0) + item.payable_cents OR NEW.paid_at IS DISTINCT FROM kauro.server_now() THEN
    RAISE EXCEPTION 'PAYOUT_NOT_SETTLED: line % is PAID only with its statement''s SETTLED intent and that item''s payable cents', OLD.line_id USING ERRCODE = 'KC010';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commission_lines_paid BEFORE UPDATE OF state ON kauro.commission_lines
  FOR EACH ROW WHEN (NEW.state = 'PAID' AND OLD.state IS DISTINCT FROM 'PAID') EXECUTE FUNCTION kauro.commission_lines_paid();

-- --- row-level security (FORCE everywhere; corporate policies only, D10-CTX-3; no DELETE grant) ------------------------------------------
ALTER TABLE kauro.banking_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.banking_calendars FORCE ROW LEVEL SECURITY;
CREATE POLICY banking_calendars_owner_read ON kauro.banking_calendars FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY banking_calendars_commission ON kauro.banking_calendars FOR ALL TO kauro_commission USING (true) WITH CHECK (true);

ALTER TABLE kauro.commission_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.commission_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY commission_periods_owner_read ON kauro.commission_periods FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY commission_periods_commission ON kauro.commission_periods FOR ALL TO kauro_commission USING (true) WITH CHECK (true);

ALTER TABLE kauro.commission_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.commission_statements FORCE ROW LEVEL SECURITY;
CREATE POLICY commission_statements_owner_read ON kauro.commission_statements FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY commission_statements_owner_approve ON kauro.commission_statements FOR UPDATE TO kauro_app
  USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY commission_statements_seller_read ON kauro.commission_statements FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());
CREATE POLICY commission_statements_commission ON kauro.commission_statements FOR ALL TO kauro_commission USING (true) WITH CHECK (true);

ALTER TABLE kauro.statement_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.statement_items FORCE ROW LEVEL SECURITY;
CREATE POLICY statement_items_owner_read ON kauro.statement_items FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY statement_items_seller_read ON kauro.statement_items FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());
CREATE POLICY statement_items_commission ON kauro.statement_items FOR ALL TO kauro_commission USING (true) WITH CHECK (true);

ALTER TABLE kauro.payout_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.payout_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY payout_intents_owner_read ON kauro.payout_intents FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY payout_intents_owner_authorize ON kauro.payout_intents FOR INSERT TO kauro_app
  WITH CHECK (kauro.acting_corporate_owner() AND authorized_by_user_id = kauro.current_user_id());
CREATE POLICY payout_intents_seller_read ON kauro.payout_intents FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());
CREATE POLICY payout_intents_commission ON kauro.payout_intents FOR ALL TO kauro_commission USING (true) WITH CHECK (true);

ALTER TABLE kauro.payout_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.payout_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY payout_reconciliations_owner_read ON kauro.payout_reconciliations FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY payout_reconciliations_commission ON kauro.payout_reconciliations FOR ALL TO kauro_commission USING (true) WITH CHECK (true);

ALTER TABLE kauro.compensation_guard_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.compensation_guard_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY compensation_guard_reviews_owner_read ON kauro.compensation_guard_reviews FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY compensation_guard_reviews_commission ON kauro.compensation_guard_reviews FOR ALL TO kauro_commission USING (true) WITH CHECK (true);

-- --- grants (no DELETE for any runtime role) -----------------------------------------------------------------------------------------
GRANT SELECT ON kauro.banking_calendars, kauro.commission_periods, kauro.statement_items, kauro.payout_reconciliations, kauro.compensation_guard_reviews TO kauro_app;
GRANT SELECT ON kauro.commission_statements TO kauro_app;
GRANT UPDATE (version, state, approved_at, approved_by_user_id, approval_proof_ref, updated_at) ON kauro.commission_statements TO kauro_app;
GRANT SELECT, INSERT ON kauro.payout_intents TO kauro_app;
GRANT SELECT, INSERT ON kauro.banking_calendars, kauro.statement_items, kauro.payout_reconciliations, kauro.compensation_guard_reviews TO kauro_commission;
GRANT SELECT, INSERT ON kauro.commission_periods TO kauro_commission;
GRANT UPDATE (version, state, calendar_id, calendar_source, close_due_on, pay_due_on, cutoff_hash, closed_at, updated_at) ON kauro.commission_periods TO kauro_commission;
GRANT SELECT, INSERT ON kauro.commission_statements TO kauro_commission;
GRANT UPDATE (version, state, issued_at, paid_at, payout_evidence_hash, corrected_at, updated_at) ON kauro.commission_statements TO kauro_commission;
GRANT SELECT ON kauro.payout_intents TO kauro_commission;
GRANT UPDATE (version, state, evidence_hash, submitted_at, settled_at, failed_at, returned_at, updated_at) ON kauro.payout_intents TO kauro_commission;
