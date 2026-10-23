-- Migration 0120 — Order 22: seller money, the retainer, claim refusals and reviews (REISSUE-CANDIDATE-01 build profile; CP-01.04,
-- .05, .13, .14 as the owner resolved them on 2026-10-22; candidate CMD068, CMD071, CMD072). Activation OFF: nothing in the served
-- application writes these tables until Order 19B adopts the items (and, for the claim rules, COUNSEL_REVIEW_CP01_14 records the
-- competent review). The served claim lifecycle is unchanged for every claim that names no refusal.
--
--   1. kauro.commission_pool_basis_history: every pool's basis at its birth (the capture's durable confirmation) and each fall the
--      ledger records (refund, reversal), written by triggers on kauro.commission_pools, so a collection counts in the month its capture
--      was confirmed and a refund in the month it happened (CP-01.13) without reading the agency's captures or refunds. Existing pools
--      are backfilled: birth at creation, one fall at their last update when their basis already fell.
--   2. Seller reads the seller-money computation needs: the periods (dates only) and the basis history of the seller's own pools.
--   3. kauro.retainer_accruals: one accrual per seller and month, append-only (an accrued obligation is never removed, CP-01.05), whose
--      amount the database holds to the signed agreement in force at the month's start; nothing is accrued for the USD 0.00 default.
--   4. kauro.claim_refusal_reasons (CLAIM-REFUSAL-1, the seven neutral codes), kauro.owner_rules (versioned), kauro.claim_refusals,
--      kauro.claim_reviews, kauro.claim_review_decisions and kauro.claim_decision_entries. The seller reads the neutral message and
--      the review state only: no seller policy exists on refusals, owner rules or review decisions, so a seller session can never
--      read a reason code, evidence or note (CP-01.04 "the seller sees only the permitted explanation").
--   5. kauro.attribution_claims: a claim may be REJECTED by a refusal (refusal_id) as well as by a frozen allocation, and a refusal
--      withdrawn by a CHANGED review stays REJECTED (gap G-O22-01). The AttributionClaim machine is unchanged.
-- Idempotent.

-- --- 1. the pools' basis history -------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kauro.commission_pool_basis_history (
  pool_id               uuid NOT NULL REFERENCES kauro.commission_pools (pool_id),
  capture_id            uuid NOT NULL,
  source                text NOT NULL CHECK (source IN ('ACQUISITION', 'ASSISTANCE')),
  previous_basis_cents  bigint CHECK (previous_basis_cents IS NULL OR kauro.is_money(previous_basis_cents)),
  new_basis_cents       bigint NOT NULL CHECK (kauro.is_money(new_basis_cents)),
  changed_at            timestamptz NOT NULL,
  -- a basis only falls, so each value names one change of its pool
  PRIMARY KEY (pool_id, new_basis_cents),
  CONSTRAINT commission_pool_basis_history_falls CHECK (previous_basis_cents IS NULL OR new_basis_cents < previous_basis_cents)
);
CREATE UNIQUE INDEX IF NOT EXISTS commission_pool_basis_history_one_birth ON kauro.commission_pool_basis_history (pool_id) WHERE previous_basis_cents IS NULL;

-- When a collection was confirmed: its qualifying purchase's confirmation (the designation's confirmed_at), never the instant the
-- ledger got round to accruing it (review O22 F-1: consumer lag or a late sweep would move a collection to the next month).
CREATE OR REPLACE FUNCTION kauro.commission_pool_born_at(p_agency uuid, p_authorization uuid, p_fallback timestamptz) RETURNS timestamptz
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$
  SELECT coalesce((SELECT q.confirmed_at FROM kauro.qualifying_purchases q WHERE q.agency_id = p_agency AND q.authorization_id = p_authorization), p_fallback)
$$;
-- When a basis fell to p_basis: the completion of the refund that took the capture's service down to it (allocated service less the
-- completed refunds' approved service, in completion order — the same arithmetic refund.completed.v1's serviceBasisAfterCents states),
-- else, at zero, the capture's reversal as observed; the processing instant only when neither is visible.
CREATE OR REPLACE FUNCTION kauro.commission_pool_fell_at(p_agency uuid, p_capture uuid, p_basis bigint, p_fallback timestamptz) RETURNS timestamptz
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$
  SELECT coalesce(
    (SELECT x.completed_at
       FROM (SELECT r.completed_at, r.refund_id,
                    sum(coalesce(r.approved_service_cents, 0)) OVER (ORDER BY r.completed_at, r.refund_id) AS refunded
               FROM kauro.refunds r
              WHERE r.agency_id = p_agency AND r.capture_id = p_capture AND r.state = 'COMPLETED' AND r.completed_at IS NOT NULL) x
       JOIN kauro.capture_facts c ON c.agency_id = p_agency AND c.capture_id = p_capture
      WHERE c.allocated_service_cents - x.refunded <= p_basis
      ORDER BY x.completed_at, x.refund_id LIMIT 1),
    (SELECT c.observed_at FROM kauro.capture_facts c WHERE c.agency_id = p_agency AND c.capture_id = p_capture AND c.status = 'REVERSED' AND p_basis = 0),
    p_fallback)
$$;
REVOKE ALL ON FUNCTION kauro.commission_pool_born_at(uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION kauro.commission_pool_fell_at(uuid, uuid, bigint, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kauro.commission_pool_born_at(uuid, uuid, timestamptz) TO kauro_commission;
GRANT EXECUTE ON FUNCTION kauro.commission_pool_fell_at(uuid, uuid, bigint, timestamptz) TO kauro_commission;

CREATE OR REPLACE FUNCTION kauro.commission_pool_basis_record() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO kauro.commission_pool_basis_history (pool_id, capture_id, source, previous_basis_cents, new_basis_cents, changed_at)
    VALUES (NEW.pool_id, NEW.capture_id, NEW.source, NULL, NEW.basis_cents, kauro.commission_pool_born_at(NEW.agency_id, NEW.authorization_id, NEW.created_at));
  ELSIF NEW.basis_cents < OLD.basis_cents THEN
    INSERT INTO kauro.commission_pool_basis_history (pool_id, capture_id, source, previous_basis_cents, new_basis_cents, changed_at)
    VALUES (NEW.pool_id, NEW.capture_id, NEW.source, OLD.basis_cents, NEW.basis_cents, kauro.commission_pool_fell_at(NEW.agency_id, NEW.capture_id, NEW.basis_cents, NEW.updated_at));
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION kauro.commission_pool_basis_record() FROM PUBLIC;
DROP TRIGGER IF EXISTS commission_pools_basis_history ON kauro.commission_pools;
CREATE TRIGGER commission_pools_basis_history AFTER INSERT OR UPDATE OF basis_cents ON kauro.commission_pools
  FOR EACH ROW EXECUTE FUNCTION kauro.commission_pool_basis_record();

-- Backfill (the migrator reads every row): each existing pool's birth at its confirmation, then one fall per distinct basis its lines'
-- adjustments recorded, at that refund's completion (the adjustment's instant when none is visible), then a last fall to its current
-- basis if no adjustment named it.
DO $$
DECLARE
  p record;
  a record;
  prev bigint;
BEGIN
  FOR p IN SELECT * FROM kauro.commission_pools ORDER BY pool_id LOOP
    INSERT INTO kauro.commission_pool_basis_history (pool_id, capture_id, source, previous_basis_cents, new_basis_cents, changed_at)
    VALUES (p.pool_id, p.capture_id, p.source, NULL, p.initial_basis_cents, kauro.commission_pool_born_at(p.agency_id, p.authorization_id, p.created_at))
    ON CONFLICT DO NOTHING;
    prev := p.initial_basis_cents;
    FOR a IN SELECT x.new_basis_cents, min(x.created_at) AS at FROM kauro.commission_adjustments x JOIN kauro.commission_lines l ON l.line_id = x.line_id
              WHERE l.pool_id = p.pool_id AND x.new_basis_cents < p.initial_basis_cents AND x.new_basis_cents >= p.basis_cents
              GROUP BY x.new_basis_cents ORDER BY x.new_basis_cents DESC LOOP
      INSERT INTO kauro.commission_pool_basis_history (pool_id, capture_id, source, previous_basis_cents, new_basis_cents, changed_at)
      VALUES (p.pool_id, p.capture_id, p.source, prev, a.new_basis_cents, kauro.commission_pool_fell_at(p.agency_id, p.capture_id, a.new_basis_cents, a.at))
      ON CONFLICT DO NOTHING;
      prev := a.new_basis_cents;
    END LOOP;
    IF p.basis_cents < prev THEN
      INSERT INTO kauro.commission_pool_basis_history (pool_id, capture_id, source, previous_basis_cents, new_basis_cents, changed_at)
      VALUES (p.pool_id, p.capture_id, p.source, prev, p.basis_cents, kauro.commission_pool_fell_at(p.agency_id, p.capture_id, p.basis_cents, p.updated_at))
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END
$$;

DROP TRIGGER IF EXISTS commission_pool_basis_history_append_only ON kauro.commission_pool_basis_history;
CREATE TRIGGER commission_pool_basis_history_append_only BEFORE UPDATE OR DELETE ON kauro.commission_pool_basis_history
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
DROP TRIGGER IF EXISTS commission_pool_basis_history_no_truncate ON kauro.commission_pool_basis_history;
CREATE TRIGGER commission_pool_basis_history_no_truncate BEFORE TRUNCATE ON kauro.commission_pool_basis_history
  FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

-- whether the session's seller holds a line of the pool; the lookup sits in a function with an early return, so the policy names no
-- other relation (sec-policy-relations; 0074's pattern) and a session with no seller never touches kauro.commission_lines
CREATE OR REPLACE FUNCTION kauro.seller_holds_pool(p_pool uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$
DECLARE
  s uuid := kauro.current_seller_id();
BEGIN
  IF s IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM kauro.commission_lines l WHERE l.pool_id = p_pool AND l.seller_id = s);
END
$$;
REVOKE ALL ON FUNCTION kauro.seller_holds_pool(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kauro.seller_holds_pool(uuid) TO kauro_app;

ALTER TABLE kauro.commission_pool_basis_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.commission_pool_basis_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS commission_pool_basis_history_owner_read ON kauro.commission_pool_basis_history;
DROP POLICY IF EXISTS commission_pool_basis_history_seller_read ON kauro.commission_pool_basis_history;
DROP POLICY IF EXISTS commission_pool_basis_history_commission_read ON kauro.commission_pool_basis_history;
DROP POLICY IF EXISTS commission_pool_basis_history_commission_record ON kauro.commission_pool_basis_history;
CREATE POLICY commission_pool_basis_history_owner_read ON kauro.commission_pool_basis_history FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
-- the seller reads the basis of the pools it holds a line of (the basis its statements already show), never another pool
CREATE POLICY commission_pool_basis_history_seller_read ON kauro.commission_pool_basis_history FOR SELECT TO kauro_app USING (kauro.seller_holds_pool(pool_id));
CREATE POLICY commission_pool_basis_history_commission_read ON kauro.commission_pool_basis_history FOR SELECT TO kauro_commission USING (true);
CREATE POLICY commission_pool_basis_history_commission_record ON kauro.commission_pool_basis_history FOR INSERT TO kauro_commission WITH CHECK (true);
GRANT SELECT ON kauro.commission_pool_basis_history TO kauro_app;
GRANT SELECT, INSERT ON kauro.commission_pool_basis_history TO kauro_commission;

-- --- 2. the seller's reads of periods ------------------------------------------------------------------------------------------------------------
-- a commission period is two dates and a calendar version; a seller session (its own seller row, any state) reads them to name a period
DROP POLICY IF EXISTS commission_periods_seller_read ON kauro.commission_periods;
CREATE POLICY commission_periods_seller_read ON kauro.commission_periods FOR SELECT TO kauro_app USING (kauro.current_seller_id() IS NOT NULL);

-- a seller reads the latest funds of the captures of its own lines, as its statements already show them (AWAITING_FUNDS): seller money
-- classifies an eligible line as the close does (review O22 F-3); the lookup sits in a function with an early return
CREATE OR REPLACE FUNCTION kauro.seller_holds_capture(p_capture uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$
DECLARE
  s uuid := kauro.current_seller_id();
BEGIN
  IF s IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM kauro.commission_lines l WHERE l.capture_id = p_capture AND l.seller_id = s);
END
$$;
REVOKE ALL ON FUNCTION kauro.seller_holds_capture(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kauro.seller_holds_capture(uuid) TO kauro_app;
DROP POLICY IF EXISTS capture_funds_observations_seller_read ON kauro.capture_funds_observations;
CREATE POLICY capture_funds_observations_seller_read ON kauro.capture_funds_observations FOR SELECT TO kauro_app USING (kauro.seller_holds_capture(capture_id));

-- --- 3. retainer accruals (CP-01.05) -----------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kauro.retainer_accruals (
  accrual_id     uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(accrual_id)),
  seller_id      uuid NOT NULL REFERENCES kauro.sellers (seller_id),
  agreement_id   uuid NOT NULL,
  month_start    timestamptz NOT NULL,
  amount_cents   bigint NOT NULL CHECK (kauro.is_money(amount_cents) AND amount_cents > 0),
  recorded_at    timestamptz NOT NULL,
  CONSTRAINT retainer_accruals_one_per_month UNIQUE (seller_id, month_start),
  -- a month starts at midnight of its first day in the operational time zone (commission.operationalTimezone)
  CONSTRAINT retainer_accruals_month_start CHECK (month_start = (date_trunc('month', month_start AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota')),
  CONSTRAINT retainer_accruals_agreement_fk FOREIGN KEY (seller_id, agreement_id) REFERENCES kauro.seller_agreements (seller_id, agreement_id)
);

-- the amount is the signed agreement in force at the month's start (signed at or before it, its term covering it, the latest start);
-- an unsigned agreement, an agreement signed later or one whose term does not cover the month never governs it
CREATE OR REPLACE FUNCTION kauro.retainer_accruals_governed() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  governing record;
BEGIN
  NEW.recorded_at := kauro.server_now();
  SELECT a.agreement_id, a.retainer_cents_per_month INTO governing FROM kauro.seller_agreements a
   WHERE a.seller_id = NEW.seller_id AND a.signed_at IS NOT NULL AND a.signed_at <= NEW.month_start AND a.starts_at <= NEW.month_start
     AND (a.ends_at IS NULL OR NEW.month_start < a.ends_at)
   ORDER BY a.starts_at DESC, a.agreement_id DESC LIMIT 1;
  IF NOT FOUND OR governing.agreement_id IS DISTINCT FROM NEW.agreement_id OR governing.retainer_cents_per_month IS DISTINCT FROM NEW.amount_cents THEN
    RAISE EXCEPTION 'RETAINER: the accrual of % names the signed agreement in force at its month and that agreement''s amount', NEW.month_start
      USING ERRCODE = 'check_violation', CONSTRAINT = 'retainer_accruals_governed', SCHEMA = 'kauro', TABLE = 'retainer_accruals';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION kauro.retainer_accruals_governed() FROM PUBLIC;
DROP TRIGGER IF EXISTS retainer_accruals_governed ON kauro.retainer_accruals;
CREATE TRIGGER retainer_accruals_governed BEFORE INSERT ON kauro.retainer_accruals FOR EACH ROW EXECUTE FUNCTION kauro.retainer_accruals_governed();
DROP TRIGGER IF EXISTS retainer_accruals_append_only ON kauro.retainer_accruals;
CREATE TRIGGER retainer_accruals_append_only BEFORE UPDATE OR DELETE ON kauro.retainer_accruals FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
DROP TRIGGER IF EXISTS retainer_accruals_no_truncate ON kauro.retainer_accruals;
CREATE TRIGGER retainer_accruals_no_truncate BEFORE TRUNCATE ON kauro.retainer_accruals FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

ALTER TABLE kauro.retainer_accruals ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.retainer_accruals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS retainer_accruals_owner_read ON kauro.retainer_accruals;
DROP POLICY IF EXISTS retainer_accruals_owner_record ON kauro.retainer_accruals;
DROP POLICY IF EXISTS retainer_accruals_seller_read ON kauro.retainer_accruals;
DROP POLICY IF EXISTS retainer_accruals_commission_read ON kauro.retainer_accruals;
DROP POLICY IF EXISTS retainer_accruals_commission_record ON kauro.retainer_accruals;
CREATE POLICY retainer_accruals_owner_read ON kauro.retainer_accruals FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY retainer_accruals_owner_record ON kauro.retainer_accruals FOR INSERT TO kauro_app WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY retainer_accruals_seller_read ON kauro.retainer_accruals FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());
CREATE POLICY retainer_accruals_commission_read ON kauro.retainer_accruals FOR SELECT TO kauro_commission USING (true);
CREATE POLICY retainer_accruals_commission_record ON kauro.retainer_accruals FOR INSERT TO kauro_commission WITH CHECK (true);
GRANT SELECT ON kauro.retainer_accruals TO kauro_app, kauro_commission;
GRANT INSERT (accrual_id, seller_id, agreement_id, month_start, amount_cents) ON kauro.retainer_accruals TO kauro_app, kauro_commission;

-- --- 4. claim refusals and reviews (CP-01.04, CP-01.14) ----------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kauro.claim_refusal_reasons (
  list_version             text NOT NULL CHECK (kauro.is_label(list_version)),
  code                     text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  seller_message           text NOT NULL CHECK (kauro.is_label(seller_message)),
  note_required            boolean NOT NULL,
  evidence_required        boolean NOT NULL,
  rule_reference_required  boolean NOT NULL,
  PRIMARY KEY (list_version, code)
);
INSERT INTO kauro.claim_refusal_reasons (list_version, code, seller_message, note_required, evidence_required, rule_reference_required) VALUES
  ('CLAIM-REFUSAL-1', 'CUSTOMER_OR_DIRECT_CONTACT', 'Not available to claim', false, true, false),
  ('CLAIM-REFUSAL-1', 'OTHER_SELLER_LIVE_CLAIM', 'Not available to claim', false, true, false),
  ('CLAIM-REFUSAL-1', 'OWNER_RULE', 'Not available to claim', false, true, true),
  ('CLAIM-REFUSAL-1', 'INSUFFICIENT_OWN_WORK_EVIDENCE', 'Not enough evidence of your own work', false, true, false),
  ('CLAIM-REFUSAL-1', 'OUTSIDE_SELLER_AGREEMENT', 'Outside your seller agreement', false, true, false),
  ('CLAIM-REFUSAL-1', 'DUPLICATE_OWN_CLAIM', 'Duplicate of a claim you already made', false, true, false),
  ('CLAIM-REFUSAL-1', 'OTHER', 'Not available to claim', true, true, false)
ON CONFLICT DO NOTHING;
DROP TRIGGER IF EXISTS claim_refusal_reasons_append_only ON kauro.claim_refusal_reasons;
CREATE TRIGGER claim_refusal_reasons_append_only BEFORE UPDATE OR DELETE ON kauro.claim_refusal_reasons FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
DROP TRIGGER IF EXISTS claim_refusal_reasons_no_truncate ON kauro.claim_refusal_reasons;
CREATE TRIGGER claim_refusal_reasons_no_truncate BEFORE TRUNCATE ON kauro.claim_refusal_reasons FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
ALTER TABLE kauro.claim_refusal_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.claim_refusal_reasons FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS claim_refusal_reasons_read ON kauro.claim_refusal_reasons;
CREATE POLICY claim_refusal_reasons_read ON kauro.claim_refusal_reasons FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
GRANT SELECT ON kauro.claim_refusal_reasons TO kauro_app;

-- the owner's versioned rules an OWNER_RULE refusal may name; a version's end is set once (its supersession), never moved
CREATE TABLE IF NOT EXISTS kauro.owner_rules (
  rule_id              text NOT NULL CHECK (rule_id ~ '^[A-Z][A-Z0-9_-]{0,62}$'),
  rule_version         integer NOT NULL CHECK (rule_version >= 1),
  in_force_from        timestamptz NOT NULL,
  in_force_until       timestamptz,
  text_hash            text NOT NULL CHECK (kauro.is_sha256_hex(text_hash)),
  recorded_by_user_id  uuid NOT NULL REFERENCES kauro.identities (user_id),
  recorded_at          timestamptz NOT NULL,
  PRIMARY KEY (rule_id, rule_version),
  CONSTRAINT owner_rules_term CHECK (in_force_until IS NULL OR in_force_until > in_force_from)
);
CREATE OR REPLACE FUNCTION kauro.owner_rules_stamp() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  NEW.recorded_at := kauro.server_now();
  -- never retroactive: a rule enters into force no earlier than it is recorded
  IF NEW.in_force_from < NEW.recorded_at THEN
    RAISE EXCEPTION 'OWNER_RULE: rule %@% would be in force before it was recorded', NEW.rule_id, NEW.rule_version
      USING ERRCODE = 'check_violation', CONSTRAINT = 'owner_rules_not_retroactive', SCHEMA = 'kauro', TABLE = 'owner_rules';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION kauro.owner_rules_stamp() FROM PUBLIC;
DROP TRIGGER IF EXISTS owner_rules_stamp ON kauro.owner_rules;
CREATE TRIGGER owner_rules_stamp BEFORE INSERT ON kauro.owner_rules FOR EACH ROW EXECUTE FUNCTION kauro.owner_rules_stamp();
DROP TRIGGER IF EXISTS owner_rules_immutable ON kauro.owner_rules;
CREATE TRIGGER owner_rules_immutable BEFORE UPDATE ON kauro.owner_rules
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('rule_id,rule_version,in_force_from,text_hash,recorded_by_user_id,recorded_at');
DROP TRIGGER IF EXISTS owner_rules_end_once ON kauro.owner_rules;
CREATE TRIGGER owner_rules_end_once BEFORE UPDATE ON kauro.owner_rules FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('in_force_until');
DROP TRIGGER IF EXISTS owner_rules_no_delete ON kauro.owner_rules;
CREATE TRIGGER owner_rules_no_delete BEFORE DELETE ON kauro.owner_rules FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
DROP TRIGGER IF EXISTS owner_rules_no_truncate ON kauro.owner_rules;
CREATE TRIGGER owner_rules_no_truncate BEFORE TRUNCATE ON kauro.owner_rules FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
ALTER TABLE kauro.owner_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.owner_rules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_rules_owner_read ON kauro.owner_rules;
DROP POLICY IF EXISTS owner_rules_owner_record ON kauro.owner_rules;
DROP POLICY IF EXISTS owner_rules_owner_end ON kauro.owner_rules;
CREATE POLICY owner_rules_owner_read ON kauro.owner_rules FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY owner_rules_owner_record ON kauro.owner_rules FOR INSERT TO kauro_app WITH CHECK (kauro.acting_corporate_owner() AND recorded_by_user_id = kauro.current_user_id());
CREATE POLICY owner_rules_owner_end ON kauro.owner_rules FOR UPDATE TO kauro_app USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner());
GRANT SELECT ON kauro.owner_rules TO kauro_app;
GRANT INSERT (rule_id, rule_version, in_force_from, in_force_until, text_hash, recorded_by_user_id) ON kauro.owner_rules TO kauro_app;
GRANT UPDATE (in_force_until) ON kauro.owner_rules TO kauro_app;

-- binding target: a refusal and a review name a claim of their own seller
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'attribution_claims_claim_seller' AND conrelid = 'kauro.attribution_claims'::regclass) THEN
    ALTER TABLE kauro.attribution_claims ADD CONSTRAINT attribution_claims_claim_seller UNIQUE (claim_id, seller_id);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS kauro.claim_refusals (
  refusal_id          uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(refusal_id)),
  claim_id            uuid NOT NULL,
  seller_id           uuid NOT NULL,
  list_version        text NOT NULL,
  reason_code         text NOT NULL,
  evidence_ref        uuid NOT NULL,
  note                text CHECK (note IS NULL OR (char_length(note) BETWEEN 1 AND 4000 AND note ~ '\S')),
  owner_rule_id       text,
  owner_rule_version  integer,
  seller_message      text NOT NULL,
  legal_status        text NOT NULL DEFAULT 'PENDING_COUNSEL' CHECK (legal_status = 'PENDING_COUNSEL'),
  idempotency_key     text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  refused_by_user_id  uuid NOT NULL REFERENCES kauro.identities (user_id),
  refused_at          timestamptz NOT NULL,
  UNIQUE (refusal_id, claim_id),
  CONSTRAINT claim_refusals_one_per_key UNIQUE (refused_by_user_id, idempotency_key),
  CONSTRAINT claim_refusals_claim_fk FOREIGN KEY (claim_id, seller_id) REFERENCES kauro.attribution_claims (claim_id, seller_id),
  CONSTRAINT claim_refusals_reason_fk FOREIGN KEY (list_version, reason_code) REFERENCES kauro.claim_refusal_reasons (list_version, code),
  CONSTRAINT claim_refusals_rule_fk FOREIGN KEY (owner_rule_id, owner_rule_version) REFERENCES kauro.owner_rules (rule_id, rule_version),
  CONSTRAINT claim_refusals_rule_pair CHECK ((owner_rule_id IS NULL) = (owner_rule_version IS NULL))
);
CREATE INDEX IF NOT EXISTS claim_refusals_by_claim ON kauro.claim_refusals (claim_id);

-- the closed list's rules, the seller message derived from the code, the claim refusable, and an owner rule in force when the claimed
-- facts happened (the claim's submission): a later rule or version is retroactive and refused
CREATE OR REPLACE FUNCTION kauro.claim_refusals_rules() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  r record;
  claim record;
BEGIN
  NEW.refused_at := kauro.server_now();
  NEW.legal_status := 'PENDING_COUNSEL';
  SELECT * INTO r FROM kauro.claim_refusal_reasons x WHERE x.list_version = NEW.list_version AND x.code = NEW.reason_code;
  SELECT c.state, c.submitted_at INTO claim FROM kauro.attribution_claims c WHERE c.claim_id = NEW.claim_id;
  IF NOT FOUND OR claim.state NOT IN ('SUBMITTED', 'DISPUTED') THEN
    RAISE EXCEPTION 'CLAIM_NOT_REFUSABLE: claim % is not SUBMITTED or DISPUTED', NEW.claim_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'claim_refusals_refusable', SCHEMA = 'kauro', TABLE = 'claim_refusals';
  END IF;
  IF r.seller_message IS DISTINCT FROM NEW.seller_message OR (r.note_required AND NEW.note IS NULL)
     OR (r.rule_reference_required <> (NEW.owner_rule_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'REFUSAL_RULES: % of % needs its seller message, its note and its rule as the list says', NEW.reason_code, NEW.list_version
      USING ERRCODE = 'check_violation', CONSTRAINT = 'claim_refusals_list_rules', SCHEMA = 'kauro', TABLE = 'claim_refusals';
  END IF;
  IF NEW.owner_rule_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM kauro.owner_rules o WHERE o.rule_id = NEW.owner_rule_id AND o.rule_version = NEW.owner_rule_version
          AND o.in_force_from <= claim.submitted_at AND (o.in_force_until IS NULL OR claim.submitted_at < o.in_force_until)) THEN
    RAISE EXCEPTION 'OWNER_RULE_NOT_IN_FORCE: %@% was not in force when claim % was submitted', NEW.owner_rule_id, NEW.owner_rule_version, NEW.claim_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'claim_refusals_rule_in_force', SCHEMA = 'kauro', TABLE = 'claim_refusals';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION kauro.claim_refusals_rules() FROM PUBLIC;
DROP TRIGGER IF EXISTS claim_refusals_rules ON kauro.claim_refusals;
CREATE TRIGGER claim_refusals_rules BEFORE INSERT ON kauro.claim_refusals FOR EACH ROW EXECUTE FUNCTION kauro.claim_refusals_rules();
DROP TRIGGER IF EXISTS claim_refusals_append_only ON kauro.claim_refusals;
CREATE TRIGGER claim_refusals_append_only BEFORE UPDATE OR DELETE ON kauro.claim_refusals FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
DROP TRIGGER IF EXISTS claim_refusals_no_truncate ON kauro.claim_refusals;
CREATE TRIGGER claim_refusals_no_truncate BEFORE TRUNCATE ON kauro.claim_refusals FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
ALTER TABLE kauro.claim_refusals ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.claim_refusals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS claim_refusals_owner_read ON kauro.claim_refusals;
DROP POLICY IF EXISTS claim_refusals_owner_record ON kauro.claim_refusals;
CREATE POLICY claim_refusals_owner_read ON kauro.claim_refusals FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY claim_refusals_owner_record ON kauro.claim_refusals FOR INSERT TO kauro_app
  WITH CHECK (kauro.acting_corporate_owner() AND refused_by_user_id = kauro.current_user_id());
GRANT SELECT ON kauro.claim_refusals TO kauro_app;
GRANT INSERT (refusal_id, claim_id, seller_id, list_version, reason_code, evidence_ref, note, owner_rule_id, owner_rule_version, seller_message, idempotency_key, refused_by_user_id)
  ON kauro.claim_refusals TO kauro_app;

-- one review per refusal (CMD068 "no review of that decision is open or decided"); a review never changes a claim by itself
CREATE TABLE IF NOT EXISTS kauro.claim_reviews (
  review_id        uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(review_id)),
  claim_id         uuid NOT NULL,
  seller_id        uuid NOT NULL,
  refusal_id       uuid NOT NULL,
  state            text NOT NULL DEFAULT 'REQUESTED' CHECK (state IN ('REQUESTED', 'UPHELD', 'CHANGED')),
  seller_note      text CHECK (seller_note IS NULL OR (char_length(seller_note) BETWEEN 1 AND 2000 AND seller_note ~ '\S')),
  idempotency_key  text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  requested_at     timestamptz NOT NULL,
  decided_at       timestamptz,
  version          bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at       timestamptz NOT NULL,
  CONSTRAINT claim_reviews_one_per_refusal UNIQUE (refusal_id),
  CONSTRAINT claim_reviews_one_per_key UNIQUE (seller_id, idempotency_key),
  CONSTRAINT claim_reviews_claim_fk FOREIGN KEY (claim_id, seller_id) REFERENCES kauro.attribution_claims (claim_id, seller_id),
  CONSTRAINT claim_reviews_refusal_fk FOREIGN KEY (refusal_id, claim_id) REFERENCES kauro.claim_refusals (refusal_id, claim_id),
  CONSTRAINT claim_reviews_decided CHECK ((state = 'REQUESTED') = (decided_at IS NULL))
);
CREATE OR REPLACE FUNCTION kauro.claim_reviews_requestable() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  NEW.requested_at := kauro.server_now();
  NEW.updated_at := NEW.requested_at;
  -- the claim's live decision is this refusal (the seller reads its own claim, never the refusal row)
  IF NOT EXISTS (SELECT 1 FROM kauro.attribution_claims c WHERE c.claim_id = NEW.claim_id AND c.state = 'REJECTED' AND c.refusal_id = NEW.refusal_id) THEN
    RAISE EXCEPTION 'CLAIM_NOT_REVIEWABLE: claim % is not refused by %', NEW.claim_id, NEW.refusal_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'claim_reviews_requestable', SCHEMA = 'kauro', TABLE = 'claim_reviews';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION kauro.claim_reviews_requestable() FROM PUBLIC;
DROP TRIGGER IF EXISTS claim_reviews_requestable ON kauro.claim_reviews;
CREATE TRIGGER claim_reviews_requestable BEFORE INSERT ON kauro.claim_reviews FOR EACH ROW EXECUTE FUNCTION kauro.claim_reviews_requestable();
DROP TRIGGER IF EXISTS claim_reviews_touch ON kauro.claim_reviews;
CREATE TRIGGER claim_reviews_touch BEFORE UPDATE ON kauro.claim_reviews FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
DROP TRIGGER IF EXISTS claim_reviews_version ON kauro.claim_reviews;
CREATE TRIGGER claim_reviews_version BEFORE UPDATE ON kauro.claim_reviews FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
DROP TRIGGER IF EXISTS claim_reviews_immutable ON kauro.claim_reviews;
CREATE TRIGGER claim_reviews_immutable BEFORE UPDATE ON kauro.claim_reviews
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('review_id,claim_id,seller_id,refusal_id,seller_note,idempotency_key,requested_at');
DROP TRIGGER IF EXISTS claim_reviews_decided_once ON kauro.claim_reviews;
CREATE TRIGGER claim_reviews_decided_once BEFORE UPDATE ON kauro.claim_reviews FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('decided_at');
DROP TRIGGER IF EXISTS claim_reviews_no_delete ON kauro.claim_reviews;
CREATE TRIGGER claim_reviews_no_delete BEFORE DELETE ON kauro.claim_reviews FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
DROP TRIGGER IF EXISTS claim_reviews_no_truncate ON kauro.claim_reviews;
CREATE TRIGGER claim_reviews_no_truncate BEFORE TRUNCATE ON kauro.claim_reviews FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
ALTER TABLE kauro.claim_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.claim_reviews FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS claim_reviews_owner_read ON kauro.claim_reviews;
DROP POLICY IF EXISTS claim_reviews_owner_decide ON kauro.claim_reviews;
DROP POLICY IF EXISTS claim_reviews_seller_read ON kauro.claim_reviews;
DROP POLICY IF EXISTS claim_reviews_seller_request ON kauro.claim_reviews;
CREATE POLICY claim_reviews_owner_read ON kauro.claim_reviews FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY claim_reviews_owner_decide ON kauro.claim_reviews FOR UPDATE TO kauro_app
  USING (kauro.acting_corporate_owner() AND state = 'REQUESTED') WITH CHECK (kauro.acting_corporate_owner() AND state IN ('UPHELD', 'CHANGED'));
CREATE POLICY claim_reviews_seller_read ON kauro.claim_reviews FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());
CREATE POLICY claim_reviews_seller_request ON kauro.claim_reviews FOR INSERT TO kauro_app WITH CHECK (seller_id = kauro.acting_seller_id() AND state = 'REQUESTED');
GRANT SELECT ON kauro.claim_reviews TO kauro_app;
GRANT INSERT (review_id, claim_id, seller_id, refusal_id, seller_note, idempotency_key) ON kauro.claim_reviews TO kauro_app;
GRANT UPDATE (state, decided_at, version, updated_at) ON kauro.claim_reviews TO kauro_app;

-- the owner's decision of a review: its code and note, read by the owner only
CREATE TABLE IF NOT EXISTS kauro.claim_review_decisions (
  review_id           uuid PRIMARY KEY REFERENCES kauro.claim_reviews (review_id),
  decision            text NOT NULL CHECK (decision IN ('UPHOLD', 'CHANGE')),
  reason_code         text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  note                text CHECK (note IS NULL OR (char_length(note) BETWEEN 1 AND 4000 AND note ~ '\S')),
  idempotency_key     text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  decided_by_user_id  uuid NOT NULL REFERENCES kauro.identities (user_id),
  decided_at          timestamptz NOT NULL,
  CONSTRAINT claim_review_decisions_one_per_key UNIQUE (decided_by_user_id, idempotency_key)
);
CREATE OR REPLACE FUNCTION kauro.claim_review_decisions_stamp() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  NEW.decided_at := kauro.server_now();
  -- UPHOLD keeps the refusal under a code of the list in force
  IF NEW.decision = 'UPHOLD' AND NOT EXISTS (SELECT 1 FROM kauro.claim_refusal_reasons x WHERE x.list_version = 'CLAIM-REFUSAL-1' AND x.code = NEW.reason_code) THEN
    RAISE EXCEPTION 'REVIEW_DECISION_CODE_UNKNOWN: % is not on the list in force', NEW.reason_code
      USING ERRCODE = 'check_violation', CONSTRAINT = 'claim_review_decisions_listed', SCHEMA = 'kauro', TABLE = 'claim_review_decisions';
  END IF;
  -- and it keeps the refusal's own code: an UPHOLD never re-bases a refusal on OWNER_RULE (no rule named) or OTHER (no note)
  IF NEW.decision = 'UPHOLD' AND NOT EXISTS (
       SELECT 1 FROM kauro.claim_reviews v JOIN kauro.claim_refusals r ON r.refusal_id = v.refusal_id
        WHERE v.review_id = NEW.review_id AND r.reason_code = NEW.reason_code) THEN
    RAISE EXCEPTION 'REVIEW_UPHOLD_CODE: an UPHOLD of review % keeps its refusal''s own code', NEW.review_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'claim_review_decisions_keep_code', SCHEMA = 'kauro', TABLE = 'claim_review_decisions';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION kauro.claim_review_decisions_stamp() FROM PUBLIC;
DROP TRIGGER IF EXISTS claim_review_decisions_stamp ON kauro.claim_review_decisions;
CREATE TRIGGER claim_review_decisions_stamp BEFORE INSERT ON kauro.claim_review_decisions FOR EACH ROW EXECUTE FUNCTION kauro.claim_review_decisions_stamp();
DROP TRIGGER IF EXISTS claim_review_decisions_append_only ON kauro.claim_review_decisions;
CREATE TRIGGER claim_review_decisions_append_only BEFORE UPDATE OR DELETE ON kauro.claim_review_decisions FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
DROP TRIGGER IF EXISTS claim_review_decisions_no_truncate ON kauro.claim_review_decisions;
CREATE TRIGGER claim_review_decisions_no_truncate BEFORE TRUNCATE ON kauro.claim_review_decisions FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
ALTER TABLE kauro.claim_review_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.claim_review_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS claim_review_decisions_owner_read ON kauro.claim_review_decisions;
DROP POLICY IF EXISTS claim_review_decisions_owner_record ON kauro.claim_review_decisions;
CREATE POLICY claim_review_decisions_owner_read ON kauro.claim_review_decisions FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY claim_review_decisions_owner_record ON kauro.claim_review_decisions FOR INSERT TO kauro_app
  WITH CHECK (kauro.acting_corporate_owner() AND decided_by_user_id = kauro.current_user_id());
GRANT SELECT ON kauro.claim_review_decisions TO kauro_app;
GRANT INSERT (review_id, decision, reason_code, note, idempotency_key, decided_by_user_id) ON kauro.claim_review_decisions TO kauro_app;

-- the claim's decision history as the seller may read it: what happened, when, by whom, and the neutral message; never a reason,
-- evidence or note (those stay on the owner-only rows the entry's kind points at)
CREATE TABLE IF NOT EXISTS kauro.claim_decision_entries (
  claim_id        uuid NOT NULL,
  sequence        integer NOT NULL CHECK (sequence >= 1),
  seller_id       uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('SUBMITTED', 'ACCEPTED', 'REFUSED', 'NOT_AVAILABLE', 'REVIEW_REQUESTED', 'REVIEW_UPHELD', 'REVIEW_CHANGED', 'EXPIRED', 'CONVERTED')),
  actor_kind      text NOT NULL CHECK (actor_kind IN ('SELLER', 'KAURO_OWNER', 'SYSTEM')),
  refusal_id      uuid,
  review_id       uuid,
  seller_message  text CHECK (seller_message IS NULL OR kauro.is_label(seller_message)),
  at              timestamptz NOT NULL,
  PRIMARY KEY (claim_id, sequence),
  CONSTRAINT claim_decision_entries_claim_fk FOREIGN KEY (claim_id, seller_id) REFERENCES kauro.attribution_claims (claim_id, seller_id),
  CONSTRAINT claim_decision_entries_refusal_fk FOREIGN KEY (refusal_id, claim_id) REFERENCES kauro.claim_refusals (refusal_id, claim_id),
  CONSTRAINT claim_decision_entries_review_fk FOREIGN KEY (review_id) REFERENCES kauro.claim_reviews (review_id),
  CONSTRAINT claim_decision_entries_refused CHECK ((kind = 'REFUSED') = (refusal_id IS NOT NULL)),
  CONSTRAINT claim_decision_entries_reviewed CHECK ((kind IN ('REVIEW_REQUESTED', 'REVIEW_UPHELD', 'REVIEW_CHANGED')) = (review_id IS NOT NULL)),
  CONSTRAINT claim_decision_entries_actor CHECK ((kind = 'REVIEW_REQUESTED') = (actor_kind = 'SELLER'))
);
CREATE OR REPLACE FUNCTION kauro.claim_decision_entries_stamp() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  NEW.at := kauro.server_now();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION kauro.claim_decision_entries_stamp() FROM PUBLIC;
DROP TRIGGER IF EXISTS claim_decision_entries_stamp ON kauro.claim_decision_entries;
CREATE TRIGGER claim_decision_entries_stamp BEFORE INSERT ON kauro.claim_decision_entries FOR EACH ROW EXECUTE FUNCTION kauro.claim_decision_entries_stamp();
DROP TRIGGER IF EXISTS claim_decision_entries_append_only ON kauro.claim_decision_entries;
CREATE TRIGGER claim_decision_entries_append_only BEFORE UPDATE OR DELETE ON kauro.claim_decision_entries FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
DROP TRIGGER IF EXISTS claim_decision_entries_no_truncate ON kauro.claim_decision_entries;
CREATE TRIGGER claim_decision_entries_no_truncate BEFORE TRUNCATE ON kauro.claim_decision_entries FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
ALTER TABLE kauro.claim_decision_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.claim_decision_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS claim_decision_entries_owner_read ON kauro.claim_decision_entries;
DROP POLICY IF EXISTS claim_decision_entries_owner_record ON kauro.claim_decision_entries;
DROP POLICY IF EXISTS claim_decision_entries_seller_read ON kauro.claim_decision_entries;
DROP POLICY IF EXISTS claim_decision_entries_seller_record ON kauro.claim_decision_entries;
CREATE POLICY claim_decision_entries_owner_read ON kauro.claim_decision_entries FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY claim_decision_entries_owner_record ON kauro.claim_decision_entries FOR INSERT TO kauro_app
  WITH CHECK (kauro.acting_corporate_owner() AND actor_kind = 'KAURO_OWNER');
CREATE POLICY claim_decision_entries_seller_read ON kauro.claim_decision_entries FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());
CREATE POLICY claim_decision_entries_seller_record ON kauro.claim_decision_entries FOR INSERT TO kauro_app
  WITH CHECK (seller_id = kauro.acting_seller_id() AND actor_kind = 'SELLER' AND kind = 'REVIEW_REQUESTED');
GRANT SELECT ON kauro.claim_decision_entries TO kauro_app;
GRANT INSERT (claim_id, sequence, seller_id, kind, actor_kind, refusal_id, review_id, seller_message) ON kauro.claim_decision_entries TO kauro_app;

-- --- 5. a claim rejected by a refusal --------------------------------------------------------------------------------------------------------------
-- The registry's AttributionClaim machine is unchanged: a refusal takes a SUBMITTED or DISPUTED claim to REJECTED along the listed edges,
-- naming its refusal instead of an allocation. A CHANGED review withdraws the refusal (claim_reviews) and puts the claim back in the
-- owner's queue, but the claim stays REJECTED: the candidate's CMD072 "returns the claim to review" needs an edge out of REJECTED that
-- neither the registry in force nor REISSUE-CANDIDATE-01 lists (gap G-O22-01, docs/design/ORDER22-SELLER-MONEY.md), so none is invented.
ALTER TABLE kauro.attribution_claims ADD COLUMN IF NOT EXISTS refusal_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'attribution_claims_refusal_fk' AND conrelid = 'kauro.attribution_claims'::regclass) THEN
    ALTER TABLE kauro.attribution_claims ADD CONSTRAINT attribution_claims_refusal_fk FOREIGN KEY (refusal_id, claim_id) REFERENCES kauro.claim_refusals (refusal_id, claim_id);
  END IF;
END
$$;
ALTER TABLE kauro.attribution_claims DROP CONSTRAINT IF EXISTS attribution_claims_ruling_record;
ALTER TABLE kauro.attribution_claims ADD CONSTRAINT attribution_claims_ruling_record CHECK (
  (allocation_id IS NULL) = (agency_id IS NULL)
  AND (state NOT IN ('ACCEPTED', 'CONVERTED') OR (accepted_at IS NOT NULL AND allocation_id IS NOT NULL))
  AND ((state = 'REJECTED') = (rejected_at IS NOT NULL))
  -- rejected by a frozen allocation (0029) or by a refusal (0120), never both and never by nothing
  AND (rejected_at IS NULL OR ((allocation_id IS NOT NULL) <> (refusal_id IS NOT NULL)))
  AND (refusal_id IS NULL OR state = 'REJECTED')
  AND (accepted_at IS NULL OR rejected_at IS NULL)
);
-- the refusal a claim names is learned once, like its other ruling columns (0029 attribution_claims_learned_once)
DROP TRIGGER IF EXISTS attribution_claims_refusal_once ON kauro.attribution_claims;
CREATE TRIGGER attribution_claims_refusal_once BEFORE UPDATE ON kauro.attribution_claims FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('refusal_id');

-- claim_rejected (0029) with the refusal path: a claim REJECTED by a refusal names a refusal of its own recorded at the rejection instant
CREATE OR REPLACE FUNCTION kauro.attribution_claims_ruled() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  claim record;
  frozen timestamptz;
BEGIN
  SELECT c.state, c.allocation_id, c.accepted_at, c.rejected_at, c.refusal_id INTO claim FROM kauro.attribution_claims c WHERE c.claim_id = NEW.claim_id;
  IF claim.state = 'REJECTED' AND claim.refusal_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM kauro.claim_refusals r WHERE r.refusal_id = claim.refusal_id AND r.claim_id = NEW.claim_id AND r.refused_at = claim.rejected_at) THEN
      RAISE EXCEPTION 'RULING: claim % is rejected by a refusal of its own recorded at the rejection instant', NEW.claim_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'attribution_claims_ruling', SCHEMA = 'kauro', TABLE = 'attribution_claims';
    END IF;
    RETURN NULL;
  END IF;
  SELECT a.frozen_at INTO frozen FROM kauro.attribution_allocations a WHERE a.allocation_id = claim.allocation_id;
  IF claim.state = 'ACCEPTED' AND (frozen IS NULL OR claim.accepted_at IS DISTINCT FROM frozen
       OR NOT EXISTS (SELECT 1 FROM kauro.allocation_shares s WHERE s.allocation_id = claim.allocation_id AND s.claim_id = NEW.claim_id)) THEN
    RAISE EXCEPTION 'SHARES_NOT_WHOLE: claim % is accepted only by the frozen allocation whose shares name it', NEW.claim_id USING ERRCODE = 'KC003';
  END IF;
  IF claim.state = 'REJECTED' AND (frozen IS NULL OR claim.rejected_at IS DISTINCT FROM frozen
       OR EXISTS (SELECT 1 FROM kauro.allocation_shares s WHERE s.allocation_id = claim.allocation_id AND s.claim_id = NEW.claim_id)) THEN
    RAISE EXCEPTION 'RULING: claim % is rejected only by a frozen allocation that rules against it', NEW.claim_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'attribution_claims_ruling', SCHEMA = 'kauro', TABLE = 'attribution_claims';
  END IF;
  RETURN NULL;
END
$$;

-- a refusal is recorded only with its claim's rejection (checked at COMMIT): a refusal row never stands beside a live claim
CREATE OR REPLACE FUNCTION kauro.claim_refusals_rejects() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM kauro.attribution_claims c WHERE c.claim_id = NEW.claim_id AND c.state = 'REJECTED' AND c.refusal_id = NEW.refusal_id) THEN
    RAISE EXCEPTION 'REFUSAL: refusal % rejects its claim in the same transaction', NEW.refusal_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'claim_refusals_rejects', SCHEMA = 'kauro', TABLE = 'claim_refusals';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION kauro.claim_refusals_rejects() FROM PUBLIC;
DROP TRIGGER IF EXISTS claim_refusals_rejects ON kauro.claim_refusals;
CREATE CONSTRAINT TRIGGER claim_refusals_rejects AFTER INSERT ON kauro.claim_refusals DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION kauro.claim_refusals_rejects();

GRANT UPDATE (refusal_id) ON kauro.attribution_claims TO kauro_app;
