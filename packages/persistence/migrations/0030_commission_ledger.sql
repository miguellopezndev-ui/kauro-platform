-- 0030 — the commission ledger (package B10, agency recurrence and commission domain): completions, pools, lines, adjustments, holds,
-- the capture's funds observations and the offsets of a negative position, with the registry machine CommissionLine and the platform
-- machine CommissionHold.
--
-- Authority: 17 "Commission basis", "Accrual, eligibility and payout", "Refunds after payout and negative balances", "Claim validity
-- and conflicts" (splits sum to the exact pool); 15 (captured funds held by the provider are not spendable cash); 07 "Database
-- representation"; registry CommissionLine (machine and fields), CommissionAdjustment; policy commission (base
-- SERVICE_COLLECTED_AFTER_DISCOUNT_NET_OF_REFUND_EXCLUDING_TAX, eligibilityDaysAfterFinalCompletion 30, splitRemainder
-- LARGEST_FRACTION_THEN_BENEFICIARY_ID_ASC, subsequentCutoff VERIFIED_PROVIDER_COMPLETION_BEFORE_EXCLUSIVE_END);
-- COMMERCIAL_LEDGER_WORKED_EXAMPLES 1, 3, 5, 6, 7, 8, 14, 15, 19, 20. Design: docs/design/B10-commercial-domain.md §6, §8.1, §8.2, §9
-- (D10-POOL-1, D10-RATE-1, D10-ADJ-1, D10-ADJ-2, D10-ELIG-1, D10-HOLD-1, D10-NEG-1, D10-NEG-2, D10-CTX-3, D10-EVT-1). The
-- statement-bound edges of a line (PAYABLE through an ISSUED statement item, PAID with a SETTLED intent) are attached by 0031, beside
-- the statement tables they read.
--
-- Writers: the commission service (kauro_commission) — the COMMISSIONS consumer, in the agency of the event it adopted, and its sweeps
-- and service commands — and the corporate owner for the holds of a dispute (B12). Readers: the owner all, a seller its own lines and
-- their adjustments, holds and offsets. No tenant policy (D10-CTX-3); no DELETE grant.
--
-- SQLSTATE vocabulary (class KC, design §12):
--   KC002 COMMISSION_POOL_MISMATCH  KC007 ELIGIBILITY_WITHOUT_FINAL_COMPLETION  KC015 ADJUSTMENT_NOT_CUMULATIVE
--   KC017 OFFSET_NOT_AUTHORIZED     (KC010 PAYOUT_NOT_SETTLED is raised by 0031)

-- --- the machines of 0030: CommissionLine (registry, as vendored) and CommissionHold (design §8.2) ------------------------------------
INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('CommissionLine', 'ACCRUED_PENDING'), ('CommissionHold', 'OPEN');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('CommissionLine', 'ACCRUED_PENDING', 'ELIGIBLE'),
  ('CommissionLine', 'ACCRUED_PENDING', 'HELD'),
  ('CommissionLine', 'HELD', 'ELIGIBLE'),
  ('CommissionLine', 'ELIGIBLE', 'PAYABLE'),
  ('CommissionLine', 'PAYABLE', 'PAID'),
  ('CommissionLine', 'PAYABLE', 'HELD'),
  ('CommissionLine', 'PAID', 'ADJUSTED'),
  ('CommissionLine', 'ACCRUED_PENDING', 'VOID'),
  ('CommissionLine', 'HELD', 'VOID'),
  ('CommissionLine', 'ELIGIBLE', 'VOID'),
  ('CommissionLine', 'ADJUSTED', 'ADJUSTED'),
  ('CommissionHold', 'OPEN', 'RELEASED'),
  ('CommissionHold', 'OPEN', 'UPHELD');

-- binding target of the ledger rows of a purchase: the qualifying purchase (0028) with its capture, confirmation sequence and project
ALTER TABLE kauro.qualifying_purchases ADD CONSTRAINT qualifying_purchases_ledger_binding UNIQUE (agency_id, authorization_id, capture_id, confirmation_seq, project_id);

-- --- completions (D10-ELIG-1, R2-101) ---------------------------------------------------------------------------------------------
-- A STAGE or FINAL completion of a qualifying purchase as PreparationCompletionSource reports it (the delivered authorization of a
-- single-stage purchase, D10-BIND-1; the stages of a staged purchase, B13): its instant, evidence and source, recorded at the server's
-- instant. One FINAL per purchase and one row per stage; a STAGE completion starts no eligibility clock (example 15). Append-only.
CREATE TABLE kauro.purchase_completions (
  completion_id     uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(completion_id)),
  agency_id         uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  authorization_id  uuid NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('STAGE', 'FINAL')),
  stage_ref         text CHECK (stage_ref IS NULL OR kauro.is_label(stage_ref)),
  completed_at      timestamptz NOT NULL,
  evidence_hash     text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  source            text NOT NULL CHECK (source IN ('AUTHORIZATION_DELIVERY', 'STAGED_PREPARATION')),
  recorded_at       timestamptz NOT NULL,
  created_at        timestamptz NOT NULL,
  -- binding target of commission_lines: a line's eligibility names a completion of its own purchase
  UNIQUE (agency_id, completion_id, authorization_id),
  CONSTRAINT purchase_completions_purchase_fk FOREIGN KEY (agency_id, authorization_id) REFERENCES kauro.qualifying_purchases (agency_id, authorization_id),
  CONSTRAINT purchase_completions_stage CHECK ((kind = 'STAGE') = (stage_ref IS NOT NULL)),
  CONSTRAINT purchase_completions_observed CHECK (completed_at <= recorded_at)
);
CREATE UNIQUE INDEX purchase_completions_one_final ON kauro.purchase_completions (agency_id, authorization_id) WHERE kind = 'FINAL';
CREATE UNIQUE INDEX purchase_completions_one_per_stage ON kauro.purchase_completions (agency_id, authorization_id, stage_ref) WHERE kind = 'STAGE';

-- --- pools (D10-POOL-1, D10-RATE-1, R2-097) ---------------------------------------------------------------------------------------
-- One pool per qualifying purchase and source: ACQUISITION — the agency's frozen allocation, at its first rate for the sticky first
-- designation (sequence 1) or at its repeat rate for a later purchase whose verified provider completion precedes the exclusive window
-- end — and each applicable ASSISTANCE agreement, at its own rate, for a purchase whose order was created after the signing. The basis
-- is the capture's allocated service — never tax, excess or the processor fee — less completed service refunds, zero once reversed,
-- and it only falls (D10-ADJ-2). pool = round_half_up_bps(basis, rate) once, and its lines' allocations sum to it (at COMMIT, KC002).
CREATE TABLE kauro.commission_pools (
  pool_id                  uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(pool_id)),
  agency_id                uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  authorization_id         uuid NOT NULL,
  capture_id               uuid NOT NULL,
  confirmation_seq         integer NOT NULL CHECK (confirmation_seq >= 1),
  project_id               uuid NOT NULL,
  source                   text NOT NULL CHECK (source IN ('ACQUISITION', 'ASSISTANCE')),
  allocation_id            uuid,
  assistance_agreement_id  uuid,
  rate_kind                text NOT NULL CHECK (rate_kind IN ('FIRST', 'REPEAT', 'ASSISTANCE')),
  rate_bps                 integer NOT NULL CHECK (rate_bps BETWEEN 1 AND 10000),
  initial_basis_cents      bigint NOT NULL CHECK (kauro.is_money(initial_basis_cents)),
  basis_cents              bigint NOT NULL CHECK (kauro.is_money(basis_cents)),
  pool_cents               bigint NOT NULL CHECK (kauro.is_money(pool_cents)),
  policy_version           text NOT NULL CHECK (kauro.is_label(policy_version)),
  version                  bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at               timestamptz NOT NULL,
  updated_at               timestamptz NOT NULL,
  -- binding target of commission_lines: a line is a line of exactly this pool, purchase and capture
  UNIQUE (agency_id, pool_id, authorization_id, capture_id),
  -- the purchase's references travel with the pool, so a corporate statement names its agency and project without reading the
  -- agency's purchases (D10-CTX-3)
  CONSTRAINT commission_pools_purchase_fk FOREIGN KEY (agency_id, authorization_id, capture_id, confirmation_seq, project_id)
    REFERENCES kauro.qualifying_purchases (agency_id, authorization_id, capture_id, confirmation_seq, project_id),
  CONSTRAINT commission_pools_allocation_fk FOREIGN KEY (allocation_id, agency_id) REFERENCES kauro.attribution_allocations (allocation_id, agency_id),
  CONSTRAINT commission_pools_assistance_fk FOREIGN KEY (agency_id, assistance_agreement_id) REFERENCES kauro.assistance_agreements (agency_id, assistance_agreement_id),
  CONSTRAINT commission_pools_source CHECK (
    (source = 'ACQUISITION' AND allocation_id IS NOT NULL AND assistance_agreement_id IS NULL AND rate_kind IN ('FIRST', 'REPEAT'))
    OR (source = 'ASSISTANCE' AND allocation_id IS NULL AND assistance_agreement_id IS NOT NULL AND rate_kind = 'ASSISTANCE')
  ),
  CONSTRAINT commission_pools_first_is_sequence_one CHECK ((rate_kind = 'FIRST') = (source = 'ACQUISITION' AND confirmation_seq = 1)),
  CONSTRAINT commission_pools_basis_falls CHECK (basis_cents <= initial_basis_cents)
);
-- one pool per purchase and source: one ACQUISITION pool, one per assistance agreement
CREATE UNIQUE INDEX commission_pools_one_per_purchase_source ON kauro.commission_pools
  (agency_id, authorization_id, source, coalesce(assistance_agreement_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE UNIQUE INDEX commission_pools_one_per_assistance ON kauro.commission_pools (assistance_agreement_id) WHERE source = 'ASSISTANCE';

-- --- lines (registry machine CommissionLine; D10-ADJ-1, D10-ELIG-1) ------------------------------------------------------------------
-- One line per pool and beneficiary: its entitlement's share of the pool, allocated by the largest remainder over the shares (ties by
-- beneficiary seller id ascending) — the lines of a pool sum to it at COMMIT (KC002). previous_posted_cents is the first posting;
-- the cumulative entitlement changes only through the line's adjustments (KC015); paid_cents is what settled payouts paid and changes
-- only with one (KA004 otherwise). Born ACCRUED_PENDING (or walked on to HELD in the same transaction: PROVIDER_TIME_UNVERIFIED);
-- ELIGIBLE only 720 hours after the purchase's FINAL completion with the capture's funds AVAILABLE and no hold covering it (KC007);
-- HELD only under an OPEN hold of its whole unpaid amount; VOID at a zero basis and entitlement.
CREATE TABLE kauro.commission_lines (
  line_id                       uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(line_id)),
  agency_id                     uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  pool_id                       uuid NOT NULL,
  entitlement_id                uuid NOT NULL,
  seller_id                     uuid NOT NULL REFERENCES kauro.sellers (seller_id),
  authorization_id              uuid NOT NULL,
  capture_id                    uuid NOT NULL,
  share_bps                     integer NOT NULL CHECK (share_bps BETWEEN 1 AND 10000),
  rate_bps                      integer NOT NULL CHECK (rate_bps BETWEEN 1 AND 10000),
  net_service_basis_cents       bigint NOT NULL CHECK (kauro.is_money(net_service_basis_cents)),
  cumulative_entitlement_cents  bigint NOT NULL CHECK (kauro.is_money(cumulative_entitlement_cents)),
  previous_posted_cents         bigint NOT NULL CHECK (kauro.is_money(previous_posted_cents)),
  paid_cents                    bigint CHECK (paid_cents IS NULL OR kauro.is_money(paid_cents)),
  paid_at                       timestamptz,
  version                       bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                         text NOT NULL DEFAULT 'ACCRUED_PENDING' CHECK (state IN ('ACCRUED_PENDING', 'ELIGIBLE', 'HELD', 'PAYABLE', 'PAID', 'ADJUSTED', 'VOID')),
  eligible_at                   timestamptz,
  final_completion_id           uuid,
  policy_version                text NOT NULL CHECK (kauro.is_label(policy_version)),
  created_at                    timestamptz NOT NULL,
  updated_at                    timestamptz NOT NULL,
  UNIQUE (agency_id, line_id),
  -- binding targets: an adjustment, a hold, an offset and a statement item name a line of their own seller
  UNIQUE (line_id, seller_id),
  UNIQUE (agency_id, line_id, seller_id),
  CONSTRAINT commission_lines_one_per_beneficiary UNIQUE (pool_id, seller_id),
  CONSTRAINT commission_lines_pool_fk FOREIGN KEY (agency_id, pool_id, authorization_id, capture_id) REFERENCES kauro.commission_pools (agency_id, pool_id, authorization_id, capture_id),
  CONSTRAINT commission_lines_entitlement_fk FOREIGN KEY (entitlement_id, seller_id, agency_id, share_bps) REFERENCES kauro.commission_entitlements (entitlement_id, seller_id, agency_id, share_bps),
  CONSTRAINT commission_lines_completion_fk FOREIGN KEY (agency_id, final_completion_id, authorization_id) REFERENCES kauro.purchase_completions (agency_id, completion_id, authorization_id),
  CONSTRAINT commission_lines_eligibility_record CHECK ((eligible_at IS NULL) = (final_completion_id IS NULL) AND (state <> 'ELIGIBLE' OR eligible_at IS NOT NULL)),
  CONSTRAINT commission_lines_paid_record CHECK ((paid_cents IS NULL) = (paid_at IS NULL) AND (state NOT IN ('PAID', 'ADJUSTED') OR paid_at IS NOT NULL)),
  CONSTRAINT commission_lines_void_at_zero CHECK (state <> 'VOID' OR (net_service_basis_cents = 0 AND cumulative_entitlement_cents = 0))
);
CREATE INDEX commission_lines_by_seller ON kauro.commission_lines (seller_id, state);
CREATE INDEX commission_lines_by_capture ON kauro.commission_lines (agency_id, capture_id);

-- --- adjustments (registry CommissionAdjustment; D10-ADJ-1, D10-ADJ-2, R2-080, R2-081) -----------------------------------------------
-- One row per changed line and basis-changing (or reviewed correcting) event: the difference between the line's new cumulative
-- entitlement and its previous one — the latest adjustment's, or the first posting — with explicit direction, never a free-standing
-- negative accrual; UNIQUE (line, source event) so a replay adds nothing. Append-only.
CREATE TABLE kauro.commission_adjustments (
  adjustment_id                     uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(adjustment_id)),
  agency_id                         uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  line_id                           uuid NOT NULL,
  seller_id                         uuid NOT NULL,
  adjustment_seq                    integer NOT NULL CHECK (adjustment_seq >= 1),
  reason                            text NOT NULL CHECK (reason IN ('REFUND', 'REVERSAL', 'SPLIT_CORRECTION', 'AGREED_ERROR_CORRECTION')),
  direction                         text NOT NULL CHECK (direction IN ('INCREASE', 'DECREASE')),
  amount_cents                      bigint NOT NULL CHECK (kauro.is_money(amount_cents) AND amount_cents > 0),
  previous_cumulative_cents         bigint NOT NULL CHECK (kauro.is_money(previous_cumulative_cents)),
  new_cumulative_entitlement_cents  bigint NOT NULL CHECK (kauro.is_money(new_cumulative_entitlement_cents)),
  new_basis_cents                   bigint NOT NULL CHECK (kauro.is_money(new_basis_cents)),
  source_event_id                   uuid NOT NULL,
  agreement_version                 text NOT NULL CHECK (kauro.is_label(agreement_version)),
  created_at                        timestamptz NOT NULL,
  UNIQUE (adjustment_id, seller_id),
  CONSTRAINT commission_adjustments_line_fk FOREIGN KEY (agency_id, line_id, seller_id) REFERENCES kauro.commission_lines (agency_id, line_id, seller_id),
  CONSTRAINT commission_adjustments_one_per_line_event UNIQUE (line_id, source_event_id),
  CONSTRAINT commission_adjustments_sequence UNIQUE (line_id, adjustment_seq)
);

-- --- holds (platform machine CommissionHold; D10-HOLD-1, R2-102) ---------------------------------------------------------------------
-- An amount of a line's unpaid entitlement held with its reason and review date (17 "An unresolved claim dispute holds only the
-- contested compensation allocation"; example 14 funds on provider hold; example 22 a failed transfer): a hold of the whole unpaid
-- amount makes the line HELD, a partial one leaves it on its path and the statement withholds exactly its cents.
CREATE TABLE kauro.commission_holds (
  hold_id       uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(hold_id)),
  agency_id     uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  line_id       uuid NOT NULL,
  seller_id     uuid NOT NULL,
  amount_cents  bigint NOT NULL CHECK (kauro.is_money(amount_cents) AND amount_cents > 0),
  reason        text NOT NULL CHECK (kauro.is_token(reason)),
  review_at     timestamptz NOT NULL,
  version       bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state         text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'RELEASED', 'UPHELD')),
  opened_at     timestamptz NOT NULL,
  released_at   timestamptz,
  upheld_at     timestamptz,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  UNIQUE (hold_id, seller_id),
  CONSTRAINT commission_holds_line_fk FOREIGN KEY (agency_id, line_id, seller_id) REFERENCES kauro.commission_lines (agency_id, line_id, seller_id),
  CONSTRAINT commission_holds_review_after_opening CHECK (review_at > opened_at),
  CONSTRAINT commission_holds_released_record CHECK ((state = 'RELEASED') = (released_at IS NOT NULL)),
  CONSTRAINT commission_holds_upheld_record CHECK ((state = 'UPHELD') = (upheld_at IS NOT NULL))
);
CREATE INDEX commission_holds_open ON kauro.commission_holds (line_id) WHERE state = 'OPEN';

-- --- the capture's funds (D10-ELIG-1; example 14) ------------------------------------------------------------------------------------
-- What capture.funds_observed.v1 told the COMMISSIONS consumer: the capture version that learned its funds HELD or AVAILABLE (B09
-- D-EVT-B2), the event and, for held funds, the provider's review date. The latest capture version is the funds' current state,
-- whatever order the events arrive in. Append-only.
CREATE TABLE kauro.capture_funds_observations (
  observation_id   uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(observation_id)),
  agency_id        uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  capture_id       uuid NOT NULL,
  capture_version  bigint NOT NULL CHECK (capture_version >= 1),
  funds_state      text NOT NULL CHECK (funds_state IN ('HELD', 'AVAILABLE')),
  review_at        timestamptz,
  source_event_id  uuid NOT NULL,
  observed_at      timestamptz NOT NULL,
  created_at       timestamptz NOT NULL,
  CONSTRAINT capture_funds_observations_capture_fk FOREIGN KEY (agency_id, capture_id) REFERENCES kauro.capture_facts (agency_id, capture_id),
  CONSTRAINT capture_funds_observations_one_per_event UNIQUE (source_event_id),
  CONSTRAINT capture_funds_observations_one_per_version UNIQUE (agency_id, capture_id, capture_version)
);

-- --- offsets of a negative position (D10-NEG-1, D10-NEG-2, R2-104) ---------------------------------------------------------------------
-- A seller's negative position on a paid line (its cumulative entitlement fell below what was paid) offset against a later unpaid
-- line of the same seller: only under the signed SIGNED_FUTURE_OFFSET terms of the agreement the negative line was earned under
-- (KC017; 17 "The remaining balance can offset future eligible commissions only under the signed legally valid agreement"), never
-- more than the negative position or the later line's unpaid amount; otherwise the statement carries an owner recovery item. No row
-- here debits anybody. Append-only.
CREATE TABLE kauro.commission_offsets (
  offset_id         uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(offset_id)),
  seller_id         uuid NOT NULL REFERENCES kauro.sellers (seller_id),
  negative_line_id  uuid NOT NULL,
  against_line_id   uuid NOT NULL,
  amount_cents      bigint NOT NULL CHECK (kauro.is_money(amount_cents) AND amount_cents > 0),
  agreement_id      uuid NOT NULL,
  recorded_at       timestamptz NOT NULL,
  created_at        timestamptz NOT NULL,
  UNIQUE (offset_id, seller_id),
  CONSTRAINT commission_offsets_negative_line_fk FOREIGN KEY (negative_line_id, seller_id) REFERENCES kauro.commission_lines (line_id, seller_id),
  CONSTRAINT commission_offsets_against_line_fk FOREIGN KEY (against_line_id, seller_id) REFERENCES kauro.commission_lines (line_id, seller_id),
  CONSTRAINT commission_offsets_agreement_fk FOREIGN KEY (seller_id, agreement_id) REFERENCES kauro.seller_agreements (seller_id, agreement_id),
  CONSTRAINT commission_offsets_two_lines CHECK (negative_line_id <> against_line_id)
);

-- --- bookkeeping, immutability and the listed edges -------------------------------------------------------------------------------
CREATE TRIGGER purchase_completions_append_only BEFORE UPDATE OR DELETE ON kauro.purchase_completions FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER purchase_completions_no_truncate BEFORE TRUNCATE ON kauro.purchase_completions FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER purchase_completions_server_instant BEFORE INSERT ON kauro.purchase_completions FOR EACH ROW EXECUTE FUNCTION kauro.require_server_instant('recorded_at');

CREATE TRIGGER commission_pools_touch BEFORE UPDATE ON kauro.commission_pools FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER commission_pools_version BEFORE UPDATE ON kauro.commission_pools FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER commission_pools_immutable BEFORE UPDATE ON kauro.commission_pools
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('pool_id,agency_id,authorization_id,capture_id,confirmation_seq,project_id,source,allocation_id,assistance_agreement_id,rate_kind,rate_bps,initial_basis_cents,policy_version,created_at');
CREATE TRIGGER commission_pools_no_delete BEFORE DELETE ON kauro.commission_pools FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER commission_pools_no_truncate BEFORE TRUNCATE ON kauro.commission_pools FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

CREATE TRIGGER commission_lines_touch BEFORE UPDATE ON kauro.commission_lines FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER commission_lines_version BEFORE UPDATE ON kauro.commission_lines FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER commission_lines_immutable BEFORE UPDATE ON kauro.commission_lines
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('line_id,agency_id,pool_id,entitlement_id,seller_id,authorization_id,capture_id,share_bps,rate_bps,previous_posted_cents,policy_version,created_at');
CREATE TRIGGER commission_lines_learned_once BEFORE UPDATE ON kauro.commission_lines
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('eligible_at,final_completion_id');
CREATE TRIGGER commission_lines_transition BEFORE UPDATE OF state ON kauro.commission_lines FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('CommissionLine');
CREATE TRIGGER commission_lines_initial_state BEFORE INSERT ON kauro.commission_lines FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('CommissionLine');
CREATE TRIGGER commission_lines_history AFTER INSERT OR UPDATE OF state ON kauro.commission_lines
  FOR EACH ROW EXECUTE FUNCTION kauro.record_corporate_transition('CommissionLine', 'line_id', 'state');
CREATE TRIGGER commission_lines_no_delete BEFORE DELETE ON kauro.commission_lines FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER commission_lines_no_truncate BEFORE TRUNCATE ON kauro.commission_lines FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

CREATE TRIGGER commission_adjustments_append_only BEFORE UPDATE OR DELETE ON kauro.commission_adjustments FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER commission_adjustments_no_truncate BEFORE TRUNCATE ON kauro.commission_adjustments FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER commission_adjustments_server_instant BEFORE INSERT ON kauro.commission_adjustments FOR EACH ROW EXECUTE FUNCTION kauro.require_server_instant('created_at');

CREATE TRIGGER commission_holds_touch BEFORE UPDATE ON kauro.commission_holds FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER commission_holds_version BEFORE UPDATE ON kauro.commission_holds FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER commission_holds_immutable BEFORE UPDATE ON kauro.commission_holds
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('hold_id,agency_id,line_id,seller_id,amount_cents,reason,review_at,opened_at,created_at');
CREATE TRIGGER commission_holds_learned_once BEFORE UPDATE ON kauro.commission_holds FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('released_at,upheld_at');
CREATE TRIGGER commission_holds_transition BEFORE UPDATE OF state ON kauro.commission_holds FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('CommissionHold');
CREATE TRIGGER commission_holds_initial_state BEFORE INSERT ON kauro.commission_holds FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('CommissionHold');
CREATE TRIGGER commission_holds_server_instant BEFORE INSERT ON kauro.commission_holds FOR EACH ROW EXECUTE FUNCTION kauro.require_server_instant('opened_at');
CREATE TRIGGER commission_holds_history AFTER INSERT OR UPDATE OF state ON kauro.commission_holds
  FOR EACH ROW EXECUTE FUNCTION kauro.record_corporate_transition('CommissionHold', 'hold_id', 'state');
CREATE TRIGGER commission_holds_no_delete BEFORE DELETE ON kauro.commission_holds FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER commission_holds_no_truncate BEFORE TRUNCATE ON kauro.commission_holds FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

CREATE TRIGGER capture_funds_observations_append_only BEFORE UPDATE OR DELETE ON kauro.capture_funds_observations FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER capture_funds_observations_no_truncate BEFORE TRUNCATE ON kauro.capture_funds_observations FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

CREATE TRIGGER commission_offsets_append_only BEFORE UPDATE OR DELETE ON kauro.commission_offsets FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER commission_offsets_no_truncate BEFORE TRUNCATE ON kauro.commission_offsets FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER commission_offsets_server_instant BEFORE INSERT ON kauro.commission_offsets FOR EACH ROW EXECUTE FUNCTION kauro.require_server_instant('recorded_at');

-- --- the pool (D10-POOL-1, D10-RATE-1) ---------------------------------------------------------------------------------------------
-- The pool's terms at its birth, read in the agency the commission service adopted (fail closed otherwise): its basis within the
-- capture's allocated service; ACQUISITION at the frozen allocation's first rate for sequence 1 and its repeat rate for a purchase
-- completed at the provider before the exclusive end of the twelve-calendar-month window that starts at the first designation;
-- ASSISTANCE at its agreement's rate for a purchase ordered after the signing (and of the agreement's project, when it names one).
-- Named check violation commission_pools_terms (23514).
CREATE OR REPLACE FUNCTION kauro.commission_pools_terms() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  purchase record;
  terms record;
  window_end timestamptz;
BEGIN
  SELECT q.allocated_service_cents, q.provider_completed_at, q.order_created_at INTO purchase
    FROM kauro.qualifying_purchases q WHERE q.agency_id = NEW.agency_id AND q.authorization_id = NEW.authorization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTEXT: the qualifying purchase of pool % is not visible to its writer', NEW.pool_id USING ERRCODE = 'KA006';
  END IF;
  IF NEW.initial_basis_cents > purchase.allocated_service_cents OR NEW.basis_cents <> NEW.initial_basis_cents THEN
    RAISE EXCEPTION 'POOL_TERMS: the basis of pool % is at most its capture''s allocated service', NEW.pool_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_pools_terms', SCHEMA = 'kauro', TABLE = 'commission_pools';
  END IF;
  IF NEW.source = 'ACQUISITION' THEN
    SELECT a.first_bps, a.repeat_bps, a.frozen_at INTO terms FROM kauro.attribution_allocations a WHERE a.allocation_id = NEW.allocation_id;
    SELECT ((r.first_confirmed_at AT TIME ZONE 'America/Bogota') + interval '12 months') AT TIME ZONE 'America/Bogota' INTO window_end
      FROM kauro.agency_recurrence r WHERE r.agency_id = NEW.agency_id;
    IF terms.frozen_at IS NULL
       OR (NEW.rate_kind = 'FIRST' AND NEW.rate_bps <> terms.first_bps)
       OR (NEW.rate_kind = 'REPEAT' AND (NEW.rate_bps <> terms.repeat_bps OR window_end IS NULL OR purchase.provider_completed_at >= window_end)) THEN
      RAISE EXCEPTION 'POOL_TERMS: acquisition pool % has its frozen allocation''s rate for its sequence, a repeat only inside the window', NEW.pool_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_pools_terms', SCHEMA = 'kauro', TABLE = 'commission_pools';
    END IF;
  ELSE
    SELECT a.rate_bps, a.signed_at, a.project_id INTO terms FROM kauro.assistance_agreements a WHERE a.assistance_agreement_id = NEW.assistance_agreement_id;
    IF NEW.rate_bps IS DISTINCT FROM terms.rate_bps OR purchase.order_created_at <= terms.signed_at
       OR (terms.project_id IS NOT NULL AND terms.project_id <> NEW.project_id) THEN
      RAISE EXCEPTION 'POOL_TERMS: assistance pool % has its agreement''s rate for a purchase ordered after the signing', NEW.pool_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_pools_terms', SCHEMA = 'kauro', TABLE = 'commission_pools';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commission_pools_terms BEFORE INSERT ON kauro.commission_pools FOR EACH ROW EXECUTE FUNCTION kauro.commission_pools_terms();

-- A basis only falls (D10-ADJ-2; ADJUSTMENT_NOT_CUMULATIVE, KC015), for the pool and each of its lines.
CREATE OR REPLACE FUNCTION kauro.commission_basis_falls() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  old_basis bigint := (to_jsonb(OLD) ->> TG_ARGV[0])::bigint;
  new_basis bigint := (to_jsonb(NEW) ->> TG_ARGV[0])::bigint;
BEGIN
  IF new_basis > old_basis THEN
    RAISE EXCEPTION 'ADJUSTMENT_NOT_CUMULATIVE: a commission basis only falls (% % -> %)', TG_TABLE_NAME, old_basis, new_basis USING ERRCODE = 'KC015';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commission_pools_basis_falls BEFORE UPDATE OF basis_cents ON kauro.commission_pools
  FOR EACH ROW EXECUTE FUNCTION kauro.commission_basis_falls('basis_cents');
CREATE TRIGGER commission_lines_basis_falls BEFORE UPDATE OF net_service_basis_cents ON kauro.commission_lines
  FOR EACH ROW EXECUTE FUNCTION kauro.commission_basis_falls('net_service_basis_cents');

-- At COMMIT (COMMISSION_POOL_MISMATCH, KC002): pool = round_half_up_bps(basis, rate), rounded once; the pool has its lines, each at
-- the pool's basis and rate; and the lines' allocations sum to exactly the pool.
CREATE OR REPLACE FUNCTION kauro.check_commission_pool(p_pool uuid) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  pool record;
BEGIN
  SELECT p.pool_id, p.basis_cents, p.rate_bps, p.pool_cents INTO pool FROM kauro.commission_pools p WHERE p.pool_id = p_pool;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTEXT: pool % is not visible to its writer', p_pool USING ERRCODE = 'KA006';
  END IF;
  IF pool.pool_cents <> kauro.round_half_up_bps(pool.basis_cents, pool.rate_bps)
     OR NOT EXISTS (SELECT 1 FROM kauro.commission_lines l WHERE l.pool_id = p_pool)
     OR EXISTS (SELECT 1 FROM kauro.commission_lines l WHERE l.pool_id = p_pool AND (l.net_service_basis_cents <> pool.basis_cents OR l.rate_bps <> pool.rate_bps))
     OR pool.pool_cents <> (SELECT sum(l.cumulative_entitlement_cents) FROM kauro.commission_lines l WHERE l.pool_id = p_pool) THEN
    RAISE EXCEPTION 'COMMISSION_POOL_MISMATCH: pool % must be round(basis x rate) once and the exact sum of its lines at their basis and rate', p_pool USING ERRCODE = 'KC002';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION kauro.commission_pools_balanced() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM kauro.check_commission_pool(NEW.pool_id);
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER commission_pools_balanced AFTER INSERT OR UPDATE ON kauro.commission_pools
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.commission_pools_balanced();
CREATE CONSTRAINT TRIGGER commission_lines_balanced AFTER INSERT OR UPDATE ON kauro.commission_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.commission_pools_balanced();

-- --- the line's birth and edges (D10-ADJ-1, D10-ELIG-1, D10-HOLD-1) ----------------------------------------------------------------
-- A line is born with nothing paid and its first posting as its cumulative entitlement, for an entitlement of its pool's own source
-- (the allocation's, or the assistance agreement's). Named check violation commission_lines_entitlement_of_pool (23514).
CREATE OR REPLACE FUNCTION kauro.commission_lines_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.paid_cents IS NOT NULL OR NEW.previous_posted_cents <> NEW.cumulative_entitlement_cents OR NOT EXISTS (
    SELECT 1 FROM kauro.commission_pools p JOIN kauro.commission_entitlements e ON e.entitlement_id = NEW.entitlement_id
     WHERE p.pool_id = NEW.pool_id
       AND ((p.source = 'ACQUISITION' AND e.kind = 'ACQUISITION' AND e.allocation_id = p.allocation_id)
            OR (p.source = 'ASSISTANCE' AND e.kind = 'ASSISTANCE' AND e.assistance_agreement_id = p.assistance_agreement_id))
  ) THEN
    RAISE EXCEPTION 'LINE_BIRTH: line % is born unpaid at its first posting, for an entitlement of its pool''s source', NEW.line_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_lines_entitlement_of_pool', SCHEMA = 'kauro', TABLE = 'commission_lines';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commission_lines_birth BEFORE INSERT ON kauro.commission_lines FOR EACH ROW EXECUTE FUNCTION kauro.commission_lines_birth();

-- paid_cents changes only with a settled payout (PAYABLE -> PAID, checked by 0031's KC010 guard); IMMUTABLE_COLUMN (KA004) otherwise
CREATE OR REPLACE FUNCTION kauro.commission_lines_paid_only_by_payout() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF (NEW.paid_cents, NEW.paid_at) IS DISTINCT FROM (OLD.paid_cents, OLD.paid_at) AND NOT (OLD.state = 'PAYABLE' AND NEW.state = 'PAID') THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: the paid cents of line % change only with a settled payout', OLD.line_id USING ERRCODE = 'KA004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commission_lines_paid_only_by_payout BEFORE UPDATE ON kauro.commission_lines FOR EACH ROW EXECUTE FUNCTION kauro.commission_lines_paid_only_by_payout();

-- eligibility_conditions_met and hold_resolved_and_eligible (ELIGIBILITY_WITHOUT_FINAL_COMPLETION, KC007): the purchase's FINAL
-- completion — never a STAGE — names the line's eligibility instant, 720 hours after it, reached on the server's clock; the capture's
-- latest funds observation is AVAILABLE; and no OPEN hold covers the line's unpaid amount.
CREATE OR REPLACE FUNCTION kauro.commission_lines_eligibility() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  final record;
  funds text;
BEGIN
  SELECT c.completion_id, c.completed_at INTO final FROM kauro.purchase_completions c
   WHERE c.agency_id = OLD.agency_id AND c.authorization_id = OLD.authorization_id AND c.kind = 'FINAL';
  SELECT o.funds_state INTO funds FROM kauro.capture_funds_observations o
   WHERE o.agency_id = OLD.agency_id AND o.capture_id = OLD.capture_id ORDER BY o.capture_version DESC LIMIT 1;
  IF final.completion_id IS NULL OR NEW.final_completion_id IS DISTINCT FROM final.completion_id
     OR NEW.eligible_at IS DISTINCT FROM final.completed_at + interval '720 hours' OR NEW.eligible_at > kauro.server_now()
     OR funds IS DISTINCT FROM 'AVAILABLE'
     OR EXISTS (
       SELECT 1 FROM kauro.commission_holds h
        WHERE h.line_id = OLD.line_id AND h.state = 'OPEN' AND h.amount_cents >= NEW.cumulative_entitlement_cents - coalesce(NEW.paid_cents, 0)
     ) THEN
    RAISE EXCEPTION 'ELIGIBILITY_WITHOUT_FINAL_COMPLETION: line % is eligible only 720 hours after a FINAL completion with its funds AVAILABLE and no covering hold', OLD.line_id
      USING ERRCODE = 'KC007';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commission_lines_eligibility BEFORE UPDATE OF state ON kauro.commission_lines
  FOR EACH ROW WHEN (NEW.state = 'ELIGIBLE' AND OLD.state IS DISTINCT FROM 'ELIGIBLE') EXECUTE FUNCTION kauro.commission_lines_eligibility();

-- justified_dispute_or_funds_hold and payout_blocked: an OPEN hold of the line's whole unpaid amount, with its reason and review date,
-- exists. Named check violation commission_lines_held_by_hold (23514).
CREATE OR REPLACE FUNCTION kauro.commission_lines_held() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.commission_holds h
     WHERE h.line_id = OLD.line_id AND h.state = 'OPEN' AND h.amount_cents = NEW.cumulative_entitlement_cents - coalesce(NEW.paid_cents, 0)
  ) THEN
    RAISE EXCEPTION 'LINE_HOLD: line % is HELD only under an OPEN hold of its whole unpaid amount', OLD.line_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_lines_held_by_hold', SCHEMA = 'kauro', TABLE = 'commission_lines';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commission_lines_held BEFORE UPDATE OF state ON kauro.commission_lines
  FOR EACH ROW WHEN (NEW.state = 'HELD' AND OLD.state IS DISTINCT FROM 'HELD') EXECUTE FUNCTION kauro.commission_lines_held();

-- At COMMIT (ADJUSTMENT_NOT_CUMULATIVE, KC015): the line's cumulative entitlement is its latest adjustment's, or its first posting;
-- an ADJUSTED line has an adjustment posted after it was paid.
CREATE OR REPLACE FUNCTION kauro.check_commission_line_cumulative(p_line uuid) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  line record;
  latest bigint;
BEGIN
  SELECT l.line_id, l.state, l.cumulative_entitlement_cents, l.previous_posted_cents, l.paid_at INTO line FROM kauro.commission_lines l WHERE l.line_id = p_line;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTEXT: line % is not visible to its writer', p_line USING ERRCODE = 'KA006';
  END IF;
  SELECT a.new_cumulative_entitlement_cents INTO latest FROM kauro.commission_adjustments a WHERE a.line_id = p_line ORDER BY a.adjustment_seq DESC LIMIT 1;
  IF line.cumulative_entitlement_cents <> coalesce(latest, line.previous_posted_cents)
     OR (line.state = 'ADJUSTED' AND NOT EXISTS (SELECT 1 FROM kauro.commission_adjustments a WHERE a.line_id = p_line AND a.created_at >= line.paid_at)) THEN
    RAISE EXCEPTION 'ADJUSTMENT_NOT_CUMULATIVE: line % changes its cumulative entitlement only through its adjustments', p_line USING ERRCODE = 'KC015';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION kauro.commission_lines_cumulative() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM kauro.check_commission_line_cumulative(NEW.line_id);
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER commission_lines_cumulative AFTER INSERT OR UPDATE ON kauro.commission_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.commission_lines_cumulative();
CREATE CONSTRAINT TRIGGER commission_adjustments_cumulative AFTER INSERT ON kauro.commission_adjustments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.commission_lines_cumulative();

-- An adjustment is the next of its line, and the exact signed difference between its new cumulative entitlement and the previous one
-- — the line's latest adjustment's, or its first posting (ADJUSTMENT_NOT_CUMULATIVE, KC015).
CREATE OR REPLACE FUNCTION kauro.commission_adjustments_difference() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  posted bigint;
  latest record;
BEGIN
  SELECT l.previous_posted_cents INTO posted FROM kauro.commission_lines l WHERE l.line_id = NEW.line_id AND l.seller_id = NEW.seller_id;
  SELECT a.adjustment_seq, a.new_cumulative_entitlement_cents INTO latest FROM kauro.commission_adjustments a WHERE a.line_id = NEW.line_id ORDER BY a.adjustment_seq DESC LIMIT 1;
  IF posted IS NULL
     OR NEW.adjustment_seq <> coalesce(latest.adjustment_seq, 0) + 1
     OR NEW.previous_cumulative_cents <> coalesce(latest.new_cumulative_entitlement_cents, posted)
     OR NEW.amount_cents <> abs(NEW.new_cumulative_entitlement_cents - NEW.previous_cumulative_cents)
     OR NEW.direction <> (CASE WHEN NEW.new_cumulative_entitlement_cents > NEW.previous_cumulative_cents THEN 'INCREASE' ELSE 'DECREASE' END) THEN
    RAISE EXCEPTION 'ADJUSTMENT_NOT_CUMULATIVE: adjustment % of line % is not the next cumulative difference', NEW.adjustment_seq, NEW.line_id USING ERRCODE = 'KC015';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commission_adjustments_difference BEFORE INSERT ON kauro.commission_adjustments FOR EACH ROW EXECUTE FUNCTION kauro.commission_adjustments_difference();

-- --- the hold's birth and edges (D10-HOLD-1) ------------------------------------------------------------------------------------------
-- A hold is at most the line's unpaid amount; RELEASED and UPHELD are recorded at the server's instant. Named check violation
-- commission_holds_within_unpaid (23514).
CREATE OR REPLACE FUNCTION kauro.commission_holds_amount() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF TG_OP = 'INSERT' AND NOT EXISTS (
       SELECT 1 FROM kauro.commission_lines l WHERE l.line_id = NEW.line_id AND NEW.amount_cents <= l.cumulative_entitlement_cents - coalesce(l.paid_cents, 0))
     OR (TG_OP = 'UPDATE' AND coalesce(NEW.released_at, NEW.upheld_at) IS DISTINCT FROM kauro.server_now()) THEN
    RAISE EXCEPTION 'HOLD: a hold of line % is at most its unpaid amount and is resolved at the server''s instant', NEW.line_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_holds_within_unpaid', SCHEMA = 'kauro', TABLE = 'commission_holds';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commission_holds_amount BEFORE INSERT ON kauro.commission_holds FOR EACH ROW EXECUTE FUNCTION kauro.commission_holds_amount();
CREATE TRIGGER commission_holds_resolution BEFORE UPDATE OF state ON kauro.commission_holds
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.commission_holds_amount();

-- --- the offset guard (D10-NEG-1, D10-NEG-2, R2-104) -----------------------------------------------------------------------------
-- An offset names the agreement the negative line was earned under, which must carry signed SIGNED_FUTURE_OFFSET terms
-- (OFFSET_NOT_AUTHORIZED, KC017); its amount is within the negative position left after earlier offsets and within the later line's
-- unpaid amount left after earlier offsets against it (named check violation commission_offsets_amount, 23514).
CREATE OR REPLACE FUNCTION kauro.commission_offsets_authorized() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  negative record;
  against record;
  terms record;
BEGIN
  SELECT l.cumulative_entitlement_cents, l.paid_cents, e.agreement_id INTO negative
    FROM kauro.commission_lines l JOIN kauro.commission_entitlements e ON e.entitlement_id = l.entitlement_id WHERE l.line_id = NEW.negative_line_id;
  SELECT g.offset_terms, g.signed_at INTO terms FROM kauro.seller_agreements g WHERE g.seller_id = NEW.seller_id AND g.agreement_id = NEW.agreement_id;
  IF NEW.agreement_id IS DISTINCT FROM negative.agreement_id OR terms.offset_terms IS DISTINCT FROM 'SIGNED_FUTURE_OFFSET' OR terms.signed_at IS NULL THEN
    RAISE EXCEPTION 'OFFSET_NOT_AUTHORIZED: seller % has no signed future-offset terms for line %', NEW.seller_id, NEW.negative_line_id USING ERRCODE = 'KC017';
  END IF;
  SELECT l.state, l.cumulative_entitlement_cents, l.paid_cents INTO against FROM kauro.commission_lines l WHERE l.line_id = NEW.against_line_id;
  IF negative.paid_cents IS NULL
     OR NEW.amount_cents > negative.paid_cents - negative.cumulative_entitlement_cents
          - (SELECT coalesce(sum(o.amount_cents), 0) FROM kauro.commission_offsets o WHERE o.negative_line_id = NEW.negative_line_id)
     OR against.state NOT IN ('ELIGIBLE', 'PAYABLE')
     OR NEW.amount_cents > against.cumulative_entitlement_cents - coalesce(against.paid_cents, 0)
          - (SELECT coalesce(sum(o.amount_cents), 0) FROM kauro.commission_offsets o WHERE o.against_line_id = NEW.against_line_id) THEN
    RAISE EXCEPTION 'OFFSET: offset of line % against line % exceeds the negative position or the later unpaid amount', NEW.negative_line_id, NEW.against_line_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_offsets_amount', SCHEMA = 'kauro', TABLE = 'commission_offsets';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commission_offsets_authorized BEFORE INSERT ON kauro.commission_offsets FOR EACH ROW EXECUTE FUNCTION kauro.commission_offsets_authorized();

-- --- row-level security (FORCE everywhere; corporate policies only, D10-CTX-3; no DELETE grant) ------------------------------------------
ALTER TABLE kauro.purchase_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.purchase_completions FORCE ROW LEVEL SECURITY;
CREATE POLICY purchase_completions_owner_read ON kauro.purchase_completions FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY purchase_completions_commission ON kauro.purchase_completions FOR ALL TO kauro_commission USING (true) WITH CHECK (true);

ALTER TABLE kauro.commission_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.commission_pools FORCE ROW LEVEL SECURITY;
CREATE POLICY commission_pools_owner_read ON kauro.commission_pools FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY commission_pools_commission ON kauro.commission_pools FOR ALL TO kauro_commission USING (true) WITH CHECK (true);

ALTER TABLE kauro.commission_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.commission_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY commission_lines_owner_read ON kauro.commission_lines FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY commission_lines_seller_read ON kauro.commission_lines FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());
CREATE POLICY commission_lines_commission ON kauro.commission_lines FOR ALL TO kauro_commission USING (true) WITH CHECK (true);

ALTER TABLE kauro.commission_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.commission_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY commission_adjustments_owner_read ON kauro.commission_adjustments FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY commission_adjustments_seller_read ON kauro.commission_adjustments FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());
CREATE POLICY commission_adjustments_commission ON kauro.commission_adjustments FOR ALL TO kauro_commission USING (true) WITH CHECK (true);

ALTER TABLE kauro.commission_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.commission_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY commission_holds_owner_read ON kauro.commission_holds FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
-- the owner records and resolves the hold of a seller's dispute (B12; 12 "Seller dispute flow")
CREATE POLICY commission_holds_owner_record ON kauro.commission_holds FOR INSERT TO kauro_app WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY commission_holds_owner_resolve ON kauro.commission_holds FOR UPDATE TO kauro_app USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY commission_holds_seller_read ON kauro.commission_holds FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());
CREATE POLICY commission_holds_commission ON kauro.commission_holds FOR ALL TO kauro_commission USING (true) WITH CHECK (true);

ALTER TABLE kauro.capture_funds_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.capture_funds_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY capture_funds_observations_owner_read ON kauro.capture_funds_observations FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY capture_funds_observations_commission ON kauro.capture_funds_observations FOR ALL TO kauro_commission USING (true) WITH CHECK (true);

ALTER TABLE kauro.commission_offsets ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.commission_offsets FORCE ROW LEVEL SECURITY;
CREATE POLICY commission_offsets_owner_read ON kauro.commission_offsets FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY commission_offsets_seller_read ON kauro.commission_offsets FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());
CREATE POLICY commission_offsets_commission ON kauro.commission_offsets FOR ALL TO kauro_commission USING (true) WITH CHECK (true);

-- --- grants (no DELETE for any runtime role) -----------------------------------------------------------------------------------------
GRANT SELECT ON kauro.purchase_completions, kauro.commission_pools, kauro.commission_lines, kauro.commission_adjustments, kauro.capture_funds_observations, kauro.commission_offsets TO kauro_app;
GRANT SELECT, INSERT ON kauro.commission_holds TO kauro_app;
GRANT UPDATE (version, state, released_at, upheld_at, updated_at) ON kauro.commission_holds TO kauro_app;
GRANT SELECT, INSERT ON kauro.purchase_completions, kauro.commission_adjustments, kauro.capture_funds_observations, kauro.commission_offsets TO kauro_commission;
GRANT SELECT, INSERT ON kauro.commission_pools TO kauro_commission;
GRANT UPDATE (version, basis_cents, pool_cents, updated_at) ON kauro.commission_pools TO kauro_commission;
GRANT SELECT, INSERT ON kauro.commission_lines TO kauro_commission;
GRANT UPDATE (version, state, net_service_basis_cents, cumulative_entitlement_cents, paid_cents, paid_at, eligible_at, final_completion_id, updated_at) ON kauro.commission_lines TO kauro_commission;
GRANT SELECT, INSERT ON kauro.commission_holds TO kauro_commission;
GRANT UPDATE (version, state, released_at, upheld_at, updated_at) ON kauro.commission_holds TO kauro_commission;
