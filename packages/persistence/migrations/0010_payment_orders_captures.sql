-- 0010 — payment orders, payment attempts, capture facts, provider observations, commercial authorizations (package B09).
--
-- Authority: 15 "PaymentOrder and intent" (a durable local order and provider-dispatch intent with an idempotency identity
-- exist before the external call; a timeout is reconciled by the provider's identity/query path, never by a new order under a
-- new local identity), 15 "Capture and authority" (verify order identity, payee, environment, amount, currency, status and
-- finality before accepting capture evidence; a successful redirect is not capture evidence; CommercialAuthorization is issued
-- only once for the purchased subject after the verified payment fact), 15 "Webhooks and reconciliation" (facts are added
-- monotonically; an old pending event cannot roll back a confirmed terminal capture), 15 "Payment state transitions", 07
-- "Quote and checkout states", 07 "CommercialAuthorization" (reversal before execution prevents launch, during execution blocks
-- publication, after delivery restricts further service), 07 "Transaction discipline" (unique constraints close races in
-- idempotency keys, active attempts and provider transaction ids), 10 "Provider adapter contract", registry contracts
-- PaymentOrder, PaymentAttempt, CaptureFact, CommercialAuthorization, registry machine PaymentAttempt. Decisions D-PAY-B1..B8
-- in docs/design/B09-payments-fiscal.md.

-- --- binding targets B09 adds to its own and to B06 tables ---------------------------------------------------------------------------
-- An order charges exactly its quote (project, approval, total, service and tax split, currency, terms); an authorization
-- names exactly the approval, plan, source, target, mode and scope its quote priced.
ALTER TABLE kauro.quotes ADD CONSTRAINT quotes_binding_order
  UNIQUE (agency_id, quote_id, project_id, approval_id, total_cents, service_cents, tax_cents, currency, terms_hash);
ALTER TABLE kauro.quotes ADD CONSTRAINT quotes_binding_authorization
  UNIQUE (agency_id, quote_id, project_id, approval_id, plan_id, plan_hash, revision_hash, target_contract_hash, mode, billable_units);
ALTER TABLE kauro.approvals ADD CONSTRAINT approvals_binding_hash UNIQUE (agency_id, approval_id, approval_hash);
ALTER TABLE kauro.payment_routes ADD CONSTRAINT payment_routes_binding_order
  UNIQUE (route_id, provider, environment, merchant_ref, payee_digest, currency);

-- --- payment orders (D-PAY-B1, D-PAY-B2) ------------------------------------------------------------------------------------------
CREATE TABLE kauro.payment_orders (
  order_id                  uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(order_id)),
  agency_id                 uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id                uuid NOT NULL,
  quote_id                  uuid NOT NULL,
  approval_id               uuid NOT NULL,
  version                   bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                     text NOT NULL DEFAULT 'INTENT_CREATED' CHECK (state IN ('INTENT_CREATED', 'CREATING', 'CREATED', 'APPROVED', 'CAPTURING', 'CAPTURE_UNCERTAIN', 'CAPTURED', 'FAILED', 'CANCELLED', 'EXPIRED')),
  provider                  text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  environment               text NOT NULL CHECK (environment IN ('SANDBOX', 'LIVE')),
  route_id                  uuid NOT NULL,
  merchant_ref              uuid NOT NULL,
  payee_digest              text NOT NULL CHECK (kauro.is_sha256_hex(payee_digest)),
  provider_order_id         text CHECK (provider_order_id IS NULL OR provider_order_id ~ '^[A-Za-z0-9._:-]{1,256}$'),
  expected_amount_cents     bigint NOT NULL CHECK (kauro.is_money(expected_amount_cents) AND expected_amount_cents > 0),
  expected_service_cents    bigint NOT NULL CHECK (kauro.is_money(expected_service_cents)),
  expected_tax_cents        bigint NOT NULL CHECK (kauro.is_money(expected_tax_cents)),
  currency                  text NOT NULL CHECK (currency IN ('USD')),
  terms_hash                text NOT NULL CHECK (kauro.is_sha256_hex(terms_hash)),
  -- PaymentOrder.idempotencyHash: the intent binding (quote, terms, amount, currency, route); same key other payload conflicts
  idempotency_hash          text NOT NULL CHECK (kauro.is_sha256_hex(idempotency_hash)),
  -- the amount of COMPLETED captures applied to this obligation (kauro.maintain_order_allocation; never above the obligation)
  allocated_cents           bigint NOT NULL DEFAULT 0 CHECK (kauro.is_money(allocated_cents)),
  created_by_membership_id  uuid NOT NULL,
  -- the command whose journal entry recorded the intent (10: records are linked to durable business objects)
  intent_entry_id           uuid NOT NULL UNIQUE REFERENCES kauro.command_journal (entry_id),
  created_at                timestamptz NOT NULL,
  updated_at                timestamptz NOT NULL,
  UNIQUE (agency_id, order_id),
  UNIQUE (agency_id, order_id, quote_id),
  UNIQUE (agency_id, order_id, provider, environment),
  UNIQUE (agency_id, order_id, provider, environment, merchant_ref, payee_digest, currency),
  FOREIGN KEY (agency_id, project_id) REFERENCES kauro.projects (agency_id, project_id),
  FOREIGN KEY (agency_id, quote_id, project_id, approval_id, expected_amount_cents, expected_service_cents, expected_tax_cents, currency, terms_hash)
    REFERENCES kauro.quotes (agency_id, quote_id, project_id, approval_id, total_cents, service_cents, tax_cents, currency, terms_hash),
  FOREIGN KEY (route_id, provider, environment, merchant_ref, payee_digest, currency)
    REFERENCES kauro.payment_routes (route_id, provider, environment, merchant_ref, payee_digest, currency),
  FOREIGN KEY (agency_id, created_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id),
  CONSTRAINT payment_orders_amount_split CHECK (expected_amount_cents = expected_service_cents + expected_tax_cents),
  CONSTRAINT payment_orders_allocation_cap CHECK (allocated_cents <= expected_amount_cents),
  CONSTRAINT payment_orders_provider_identity CHECK (
    state NOT IN ('CREATED', 'APPROVED', 'CAPTURING', 'CAPTURE_UNCERTAIN', 'CAPTURED') OR provider_order_id IS NOT NULL
  )
);
-- a provider order identity belongs to exactly one local order (namespaced by provider and environment)
CREATE UNIQUE INDEX payment_orders_provider_identity ON kauro.payment_orders (provider, environment, provider_order_id) WHERE provider_order_id IS NOT NULL;
-- one checkout in flight per project: a double click, a second tab or a second quote cannot start another purchase while one is
-- open or uncertain (S066; 07 "unique constraints close races in ... active attempts")
CREATE UNIQUE INDEX payment_orders_one_open_per_project ON kauro.payment_orders (agency_id, project_id)
  WHERE state IN ('INTENT_CREATED', 'CREATING', 'CREATED', 'APPROVED', 'CAPTURING', 'CAPTURE_UNCERTAIN');
CREATE INDEX payment_orders_by_quote ON kauro.payment_orders (agency_id, quote_id, created_at, order_id);
CREATE TRIGGER payment_orders_touch BEFORE UPDATE ON kauro.payment_orders FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER payment_orders_version BEFORE UPDATE ON kauro.payment_orders
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump('allocated_cents');
CREATE TRIGGER payment_orders_immutable BEFORE UPDATE ON kauro.payment_orders
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('order_id,agency_id,project_id,quote_id,approval_id,provider,environment,route_id,merchant_ref,payee_digest,expected_amount_cents,expected_service_cents,expected_tax_cents,currency,terms_hash,idempotency_hash,created_by_membership_id,intent_entry_id,created_at');
CREATE TRIGGER payment_orders_transition BEFORE UPDATE OF state ON kauro.payment_orders
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('PaymentOrder');
CREATE CONSTRAINT TRIGGER payment_orders_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.payment_orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('payment_order', 'order_id');

-- the provider order identity is learned once and never re-pointed
CREATE OR REPLACE FUNCTION kauro.payment_orders_identity_once() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.provider_order_id IS NOT NULL AND NEW.provider_order_id IS DISTINCT FROM OLD.provider_order_id THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: payment order % provider identity cannot change once observed', OLD.order_id USING ERRCODE = 'KA004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_orders_identity_once BEFORE UPDATE ON kauro.payment_orders FOR EACH ROW EXECUTE FUNCTION kauro.payment_orders_identity_once();

-- PaymentOrder machine (platform, D-PAY-B2): the registry lists the states (contract enum) but no machine. The order aggregates
-- its attempts: CREATING / CAPTURING while a dispatch is in flight, CAPTURE_UNCERTAIN while a capture effect may exist; a
-- capture proved to have no effect returns the order to the payable state the provider reports; a capture observed without a
-- local dispatch (webhook or query first) is still recorded, because the money is real.
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('PaymentOrder', 'INTENT_CREATED', 'CREATING'),
  ('PaymentOrder', 'INTENT_CREATED', 'CANCELLED'),
  ('PaymentOrder', 'CREATING', 'CREATED'),
  ('PaymentOrder', 'CREATING', 'FAILED'),
  ('PaymentOrder', 'CREATED', 'APPROVED'),
  ('PaymentOrder', 'CREATED', 'CAPTURING'),
  ('PaymentOrder', 'APPROVED', 'CAPTURING'),
  ('PaymentOrder', 'CREATED', 'CAPTURED'),
  ('PaymentOrder', 'APPROVED', 'CAPTURED'),
  ('PaymentOrder', 'CAPTURING', 'CAPTURED'),
  ('PaymentOrder', 'CAPTURING', 'CAPTURE_UNCERTAIN'),
  ('PaymentOrder', 'CAPTURING', 'CREATED'),
  ('PaymentOrder', 'CAPTURING', 'APPROVED'),
  ('PaymentOrder', 'CAPTURE_UNCERTAIN', 'CAPTURED'),
  ('PaymentOrder', 'CAPTURE_UNCERTAIN', 'CREATED'),
  ('PaymentOrder', 'CAPTURE_UNCERTAIN', 'APPROVED'),
  ('PaymentOrder', 'CREATED', 'CANCELLED'),
  ('PaymentOrder', 'APPROVED', 'CANCELLED'),
  ('PaymentOrder', 'CREATED', 'EXPIRED'),
  ('PaymentOrder', 'APPROVED', 'EXPIRED');

-- --- payment attempts (registry PaymentAttempt; D-PAY-B3) ----------------------------------------------------------------------------
-- One physical provider effect: PREPARED (durable intent, no call possible yet), DISPATCHING (the dispatch intent is committed;
-- only now may the call happen), then the authenticated outcome. "Network failure alone cannot establish no external effect."
CREATE TABLE kauro.payment_attempts (
  attempt_id            uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(attempt_id)),
  agency_id             uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  order_id              uuid NOT NULL,
  refund_id             uuid,
  operation             text NOT NULL CHECK (operation IN ('CREATE_ORDER', 'CAPTURE', 'REFUND', 'WITHDRAW')),
  version               bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                 text NOT NULL DEFAULT 'PREPARED' CHECK (state IN ('PREPARED', 'DISPATCHING', 'PROVIDER_PENDING', 'CONFIRMED', 'FAILED_NO_EFFECT', 'UNCERTAIN', 'CANCELLED_BEFORE_DISPATCH')),
  provider              text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  environment           text NOT NULL CHECK (environment IN ('SANDBOX', 'LIVE')),
  -- KAURO_PROVIDER_REQUEST_V1 digest of the exact normalized request (method, endpoint profile, body, relevant headers)
  request_hash          text NOT NULL CHECK (kauro.is_sha256_hex(request_hash)),
  -- the provider idempotency/request identity the adapter sends (deterministic from the attempt; namespaced per environment)
  provider_request_id   text NOT NULL CHECK (provider_request_id ~ '^[A-Za-z0-9._:-]{8,128}$'),
  -- once DISPATCHING: the instant after which an unobserved attempt is reconciled by query (the call's bounded timeout)
  dispatch_deadline_at  timestamptz,
  started_at            timestamptz NOT NULL,
  last_observed_at      timestamptz NOT NULL,
  evidence_hash         text CHECK (evidence_hash IS NULL OR kauro.is_sha256_hex(evidence_hash)),
  outcome_reason        text CHECK (outcome_reason IS NULL OR kauro.is_token(outcome_reason)),
  intent_entry_id       uuid REFERENCES kauro.command_journal (entry_id),
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  UNIQUE (agency_id, attempt_id),
  UNIQUE (provider, environment, provider_request_id),
  FOREIGN KEY (agency_id, order_id, provider, environment) REFERENCES kauro.payment_orders (agency_id, order_id, provider, environment),
  CONSTRAINT payment_attempts_refund_binding CHECK ((operation = 'REFUND') = (refund_id IS NOT NULL)),
  -- withdrawals are merchant-balance operations of the settlement package (B15); no order-bound WITHDRAW attempt in this edition
  CONSTRAINT payment_attempts_no_withdraw_yet CHECK (operation <> 'WITHDRAW'),
  CONSTRAINT payment_attempts_dispatched_has_deadline CHECK (state IN ('PREPARED', 'CANCELLED_BEFORE_DISPATCH') OR dispatch_deadline_at IS NOT NULL),
  CONSTRAINT payment_attempts_prepared_has_no_deadline CHECK (state NOT IN ('PREPARED', 'CANCELLED_BEFORE_DISPATCH') OR dispatch_deadline_at IS NULL),
  -- CONFIRMED needs provider evidence; FAILED_NO_EFFECT needs evidence of no effect, not merely a network exception (15)
  CONSTRAINT payment_attempts_terminal_evidence CHECK (state NOT IN ('CONFIRMED', 'FAILED_NO_EFFECT') OR evidence_hash IS NOT NULL),
  CONSTRAINT payment_attempts_observation_order CHECK (last_observed_at >= started_at)
);
-- one live attempt per order operation and per refund: two executors cannot both hold a dispatchable attempt
CREATE UNIQUE INDEX payment_attempts_one_live_per_order ON kauro.payment_attempts (agency_id, order_id, operation)
  WHERE operation IN ('CREATE_ORDER', 'CAPTURE') AND state IN ('PREPARED', 'DISPATCHING', 'PROVIDER_PENDING', 'UNCERTAIN');
CREATE UNIQUE INDEX payment_attempts_one_live_per_refund ON kauro.payment_attempts (agency_id, refund_id)
  WHERE refund_id IS NOT NULL AND state IN ('PREPARED', 'DISPATCHING', 'PROVIDER_PENDING', 'UNCERTAIN');
-- one confirmed effect: "Publish reconciled financial fact once"; "Submit once per reconciled provider identity" (CMD033)
CREATE UNIQUE INDEX payment_attempts_one_confirmed_per_order ON kauro.payment_attempts (agency_id, order_id, operation)
  WHERE operation IN ('CREATE_ORDER', 'CAPTURE') AND state = 'CONFIRMED';
CREATE UNIQUE INDEX payment_attempts_one_confirmed_per_refund ON kauro.payment_attempts (agency_id, refund_id)
  WHERE refund_id IS NOT NULL AND state = 'CONFIRMED';
CREATE INDEX payment_attempts_by_order ON kauro.payment_attempts (agency_id, order_id, created_at, attempt_id);
CREATE TRIGGER payment_attempts_touch BEFORE UPDATE ON kauro.payment_attempts FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER payment_attempts_version BEFORE UPDATE ON kauro.payment_attempts FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER payment_attempts_immutable BEFORE UPDATE ON kauro.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('attempt_id,agency_id,order_id,refund_id,operation,provider,environment,request_hash,provider_request_id,started_at,intent_entry_id,created_at');
CREATE TRIGGER payment_attempts_transition BEFORE UPDATE OF state ON kauro.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('PaymentAttempt');
CREATE CONSTRAINT TRIGGER payment_attempts_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.payment_attempts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('payment_attempt', 'attempt_id');

-- the dispatch deadline is fixed once; observations never move backwards (15: facts are added monotonically)
CREATE OR REPLACE FUNCTION kauro.payment_attempts_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.dispatch_deadline_at IS NOT NULL AND NEW.dispatch_deadline_at IS DISTINCT FROM OLD.dispatch_deadline_at THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: attempt % dispatch deadline is fixed', OLD.attempt_id USING ERRCODE = 'KA004';
  END IF;
  IF NEW.last_observed_at < OLD.last_observed_at THEN
    RAISE EXCEPTION 'FACT_REGRESSION: attempt % observation time cannot move backwards', OLD.attempt_id USING ERRCODE = 'KA012';
  END IF;
  IF OLD.evidence_hash IS NOT NULL AND OLD.state IN ('CONFIRMED', 'FAILED_NO_EFFECT') AND NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: attempt % final evidence cannot change', OLD.attempt_id USING ERRCODE = 'KA004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_attempts_guard BEFORE UPDATE ON kauro.payment_attempts FOR EACH ROW EXECUTE FUNCTION kauro.payment_attempts_guard();

-- PaymentAttempt: exactly the registry machine (reference/TRANSITIONS_AND_EVENT_EFFECTS "PaymentAttempt")
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('PaymentAttempt', 'PREPARED', 'DISPATCHING'),
  ('PaymentAttempt', 'PREPARED', 'CANCELLED_BEFORE_DISPATCH'),
  ('PaymentAttempt', 'DISPATCHING', 'PROVIDER_PENDING'),
  ('PaymentAttempt', 'DISPATCHING', 'CONFIRMED'),
  ('PaymentAttempt', 'DISPATCHING', 'UNCERTAIN'),
  ('PaymentAttempt', 'DISPATCHING', 'FAILED_NO_EFFECT'),
  ('PaymentAttempt', 'PROVIDER_PENDING', 'CONFIRMED'),
  ('PaymentAttempt', 'PROVIDER_PENDING', 'FAILED_NO_EFFECT'),
  ('PaymentAttempt', 'PROVIDER_PENDING', 'UNCERTAIN'),
  ('PaymentAttempt', 'UNCERTAIN', 'CONFIRMED'),
  ('PaymentAttempt', 'UNCERTAIN', 'FAILED_NO_EFFECT');

-- --- capture facts (registry CaptureFact; D-PAY-B4, D-PAY-B5) ----------------------------------------------------------------------
-- One row per provider capture identity (the economic identity of R2-140; delivery deduplication is the inbox's). A capture of
-- another payee, environment or currency cannot be recorded here at all: the composite key binds all three to the order (S058).
-- The allocation of a completed capture to the order obligation (service, tax) and its excess are fixed at completion under the
-- order row lock; refunds consume those components and can never exceed them.
CREATE TABLE kauro.capture_facts (
  capture_id               uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(capture_id)),
  agency_id                uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  order_id                 uuid NOT NULL,
  version                  bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  status                   text NOT NULL CHECK (status IN ('COMPLETED', 'PENDING', 'DENIED', 'REVERSED')),
  provider                 text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  environment              text NOT NULL CHECK (environment IN ('SANDBOX', 'LIVE')),
  provider_capture_id      text NOT NULL CHECK (provider_capture_id ~ '^[A-Za-z0-9._:-]{1,256}$'),
  merchant_ref             uuid NOT NULL,
  payee_digest             text NOT NULL CHECK (kauro.is_sha256_hex(payee_digest)),
  amount_cents             bigint NOT NULL CHECK (kauro.is_money(amount_cents) AND amount_cents > 0),
  currency                 text NOT NULL CHECK (currency IN ('USD')),
  allocated_service_cents  bigint NOT NULL DEFAULT 0 CHECK (kauro.is_money(allocated_service_cents)),
  allocated_tax_cents      bigint NOT NULL DEFAULT 0 CHECK (kauro.is_money(allocated_tax_cents)),
  excess_cents             bigint NOT NULL DEFAULT 0 CHECK (kauro.is_money(excess_cents)),
  -- committed by refunds that are approved, in flight or completed (kauro.maintain_capture_refunds)
  refunded_service_cents   bigint NOT NULL DEFAULT 0 CHECK (kauro.is_money(refunded_service_cents)),
  refunded_tax_cents       bigint NOT NULL DEFAULT 0 CHECK (kauro.is_money(refunded_tax_cents)),
  refunded_excess_cents    bigint NOT NULL DEFAULT 0 CHECK (kauro.is_money(refunded_excess_cents)),
  -- provider-reported availability of the captured funds; never coerced to AVAILABLE (CMD034 failure clause)
  funds_state              text NOT NULL DEFAULT 'UNKNOWN' CHECK (funds_state IN ('UNKNOWN', 'HELD', 'AVAILABLE')),
  -- the actual fee the provider reported for this capture (replaces any illustrative fee profile; R2-078)
  provider_fee_cents       bigint CHECK (provider_fee_cents IS NULL OR kauro.is_money(provider_fee_cents)),
  -- provider chronology (the commission window compares the verified provider completion instant; 17)
  provider_completed_at    timestamptz,
  first_observed_at        timestamptz NOT NULL,
  observed_at              timestamptz NOT NULL,
  evidence_hash            text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  attempt_id               uuid,
  created_at               timestamptz NOT NULL,
  updated_at               timestamptz NOT NULL,
  UNIQUE (agency_id, capture_id),
  UNIQUE (agency_id, capture_id, order_id),
  UNIQUE (provider, environment, provider_capture_id),
  FOREIGN KEY (agency_id, order_id, provider, environment, merchant_ref, payee_digest, currency)
    REFERENCES kauro.payment_orders (agency_id, order_id, provider, environment, merchant_ref, payee_digest, currency),
  FOREIGN KEY (agency_id, attempt_id) REFERENCES kauro.payment_attempts (agency_id, attempt_id),
  CONSTRAINT capture_facts_allocation CHECK (
       (status IN ('PENDING', 'DENIED') AND allocated_service_cents = 0 AND allocated_tax_cents = 0 AND excess_cents = 0)
    OR (status IN ('COMPLETED', 'REVERSED') AND allocated_service_cents + allocated_tax_cents + excess_cents = amount_cents)
  ),
  CONSTRAINT capture_facts_refund_ceiling CHECK (
    refunded_service_cents <= allocated_service_cents AND refunded_tax_cents <= allocated_tax_cents AND refunded_excess_cents <= excess_cents
  ),
  CONSTRAINT capture_facts_completed_chronology CHECK (status NOT IN ('COMPLETED', 'REVERSED') OR provider_completed_at IS NOT NULL),
  CONSTRAINT capture_facts_observation_order CHECK (observed_at >= first_observed_at)
);
CREATE INDEX capture_facts_by_order ON kauro.capture_facts (agency_id, order_id, first_observed_at, capture_id);
CREATE TRIGGER capture_facts_touch BEFORE UPDATE ON kauro.capture_facts FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
-- a new status is a new version with its event; the refund commitments (maintained by kauro.maintain_capture_refunds) and the
-- observation-only facts (funds availability, the reported fee, the latest reconciliation time) change without a version
CREATE TRIGGER capture_facts_version BEFORE UPDATE ON kauro.capture_facts
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump('refunded_service_cents,refunded_tax_cents,refunded_excess_cents,funds_state,provider_fee_cents,observed_at');
CREATE TRIGGER capture_facts_immutable BEFORE UPDATE ON kauro.capture_facts
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('capture_id,agency_id,order_id,provider,environment,provider_capture_id,merchant_ref,payee_digest,amount_cents,currency,first_observed_at,created_at');
CREATE TRIGGER capture_facts_transition BEFORE UPDATE OF status ON kauro.capture_facts
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition_of('CaptureFact', 'status');
CREATE CONSTRAINT TRIGGER capture_facts_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.capture_facts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('capture', 'capture_id');

-- Monotonic facts (15 "an old pending event cannot roll back a confirmed terminal capture"): the allocation is written only by
-- the completion itself; the fee, the provider completion instant and the attempt link are learned once; the observation time
-- never moves backwards.
CREATE OR REPLACE FUNCTION kauro.capture_facts_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF (NEW.allocated_service_cents, NEW.allocated_tax_cents, NEW.excess_cents) IS DISTINCT FROM (OLD.allocated_service_cents, OLD.allocated_tax_cents, OLD.excess_cents)
     AND NOT (OLD.status = 'PENDING' AND NEW.status IN ('COMPLETED', 'REVERSED')) THEN
    RAISE EXCEPTION 'FACT_REGRESSION: capture % allocation is fixed at completion', OLD.capture_id USING ERRCODE = 'KA012';
  END IF;
  IF OLD.provider_fee_cents IS NOT NULL AND NEW.provider_fee_cents IS DISTINCT FROM OLD.provider_fee_cents THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: capture % provider fee is recorded once (a correction is a ledger reversal)', OLD.capture_id USING ERRCODE = 'KA004';
  END IF;
  IF OLD.provider_completed_at IS NOT NULL AND NEW.provider_completed_at IS DISTINCT FROM OLD.provider_completed_at THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: capture % provider completion instant is recorded once', OLD.capture_id USING ERRCODE = 'KA004';
  END IF;
  IF OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS DISTINCT FROM OLD.attempt_id THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: capture % attempt link is recorded once', OLD.capture_id USING ERRCODE = 'KA004';
  END IF;
  IF NEW.observed_at < OLD.observed_at THEN
    RAISE EXCEPTION 'FACT_REGRESSION: capture % observation time cannot move backwards', OLD.capture_id USING ERRCODE = 'KA012';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER capture_facts_guard BEFORE UPDATE ON kauro.capture_facts FOR EACH ROW EXECUTE FUNCTION kauro.capture_facts_guard();

-- Obligation allocation (R2-140 "keep one service entitlement and cap commission basis to the service obligation"): the
-- allocated amount of every COMPLETED capture is added to its order under the order row lock, which serializes two captures of
-- one order; an allocation above the obligation is refused (the excess must be recorded as excess, never as service).
CREATE OR REPLACE FUNCTION kauro.maintain_order_allocation() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  delta     bigint := 0;
  allocated bigint;
  expected  bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'COMPLETED' THEN delta := delta - (OLD.allocated_service_cents + OLD.allocated_tax_cents); END IF;
  IF NEW.status = 'COMPLETED' THEN delta := delta + (NEW.allocated_service_cents + NEW.allocated_tax_cents); END IF;
  IF delta = 0 THEN RETURN NULL; END IF;
  UPDATE kauro.payment_orders SET allocated_cents = allocated_cents + delta
   WHERE agency_id = NEW.agency_id AND order_id = NEW.order_id
   RETURNING allocated_cents, expected_amount_cents INTO allocated, expected;
  IF allocated IS NULL THEN
    RAISE EXCEPTION 'CONTEXT: payment order % is not visible in this transaction', NEW.order_id USING ERRCODE = 'KA006';
  END IF;
  IF allocated > expected THEN
    RAISE EXCEPTION 'OBLIGATION_OVER_ALLOCATED: order % would allocate % of %', NEW.order_id, allocated, expected USING ERRCODE = 'KA011';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER capture_facts_order_allocation AFTER INSERT OR UPDATE OF status ON kauro.capture_facts
  FOR EACH ROW EXECUTE FUNCTION kauro.maintain_order_allocation();

-- CaptureFact machine (platform, D-PAY-B4): provider states only move forward; DENIED and REVERSED are terminal. A fact is
-- inserted at the first status actually observed (an observation, not a command).
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('CaptureFact', 'PENDING', 'COMPLETED'),
  ('CaptureFact', 'PENDING', 'DENIED'),
  ('CaptureFact', 'PENDING', 'REVERSED'),
  ('CaptureFact', 'COMPLETED', 'REVERSED');

-- --- provider observations (append-only; D-PAY-B6) --------------------------------------------------------------------------------------
-- Every authenticated observation matched to a local order — a dispatch response, a verified webhook, a provider query — with
-- what it did to the facts. An out-of-order or duplicated observation is kept as history (STALE_IGNORED, DUPLICATE) and never
-- rolls a fact back (07 "An old event may add historical evidence without rolling current state backward").
CREATE TABLE kauro.provider_observations (
  observation_id     uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(observation_id)),
  agency_id          uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  order_id           uuid NOT NULL,
  source             text NOT NULL CHECK (source IN ('DISPATCH_RESPONSE', 'WEBHOOK', 'PROVIDER_QUERY')),
  inbox_id           uuid REFERENCES kauro.inbox_records (inbox_id),
  attempt_id         uuid,
  subject_kind       text NOT NULL CHECK (subject_kind IN ('ORDER', 'CAPTURE', 'REFUND')),
  provider_ref       text NOT NULL CHECK (provider_ref ~ '^[A-Za-z0-9._:-]{1,256}$'),
  observed_status    text NOT NULL CHECK (kauro.is_token(observed_status)),
  amount_cents       bigint CHECK (amount_cents IS NULL OR kauro.is_money(amount_cents)),
  currency           text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  payee_digest       text CHECK (payee_digest IS NULL OR kauro.is_sha256_hex(payee_digest)),
  provider_event_at  timestamptz,
  observed_at        timestamptz NOT NULL,
  evidence_hash      text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  effect             text NOT NULL CHECK (effect IN ('ADVANCED', 'NO_CHANGE', 'STALE_IGNORED', 'DUPLICATE', 'MISMATCH', 'UNRECOGNIZED')),
  created_at         timestamptz NOT NULL,
  UNIQUE (agency_id, observation_id),
  FOREIGN KEY (agency_id, order_id) REFERENCES kauro.payment_orders (agency_id, order_id),
  FOREIGN KEY (agency_id, attempt_id) REFERENCES kauro.payment_attempts (agency_id, attempt_id),
  CONSTRAINT provider_observations_webhook_binding CHECK ((source = 'WEBHOOK') = (inbox_id IS NOT NULL))
);
CREATE INDEX provider_observations_by_order ON kauro.provider_observations (agency_id, order_id, observed_at, observation_id);
CREATE TRIGGER provider_observations_append_only BEFORE UPDATE OR DELETE ON kauro.provider_observations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- commercial authorizations (registry CommercialAuthorization; D-PAY-B7) ------------------------------------------------------------
-- One logical processing entitlement per purchased subject, created by the server in the transaction that confirms a completed,
-- matching, fully allocated capture while every prerequisite still binds (quote terms, live approval, sealed source, current
-- target, offered capability). Consumed by one job (B08); revoked by a reversal with the phase it happened in.
CREATE TABLE kauro.commercial_authorizations (
  authorization_id            uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(authorization_id)),
  agency_id                   uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id                  uuid NOT NULL,
  quote_id                    uuid NOT NULL,
  order_id                    uuid NOT NULL,
  capture_id                  uuid NOT NULL,
  approval_id                 uuid NOT NULL,
  approval_hash               text NOT NULL CHECK (kauro.is_sha256_hex(approval_hash)),
  plan_id                     uuid NOT NULL,
  plan_hash                   text NOT NULL CHECK (kauro.is_sha256_hex(plan_hash)),
  revision_hash               text NOT NULL CHECK (kauro.is_sha256_hex(revision_hash)),
  target_contract_hash        text NOT NULL CHECK (kauro.is_sha256_hex(target_contract_hash)),
  capability_id               uuid NOT NULL REFERENCES kauro.capabilities (capability_id),
  capability_version          text NOT NULL CHECK (capability_version ~ '^[A-Z][A-Z0-9_.-]{0,63}$'),
  mode                        text NOT NULL CHECK (mode IN ('CLEAN', 'HUBSPOT', 'SALESFORCE')),
  billable_units              bigint NOT NULL CHECK (billable_units > 0),
  version                     bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                       text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'CONSUMED', 'DELIVERED', 'REVOKED')),
  -- the capture completed after the price expiry and the same still-valid scope was honored (07 "Quote and checkout states")
  honored_after_price_expiry  boolean NOT NULL DEFAULT false,
  -- the one logical processing job (B08 owns that table and adds the key)
  job_ref                     uuid,
  consumed_at                 timestamptz,
  delivered_at                timestamptz,
  revoked_at                  timestamptz,
  revocation_phase            text CHECK (revocation_phase IS NULL OR revocation_phase IN ('PRE_EXECUTION', 'DURING_EXECUTION', 'POST_DELIVERY')),
  revocation_reason           text CHECK (revocation_reason IS NULL OR kauro.is_token(revocation_reason)),
  created_at                  timestamptz NOT NULL,
  updated_at                  timestamptz NOT NULL,
  UNIQUE (agency_id, authorization_id),
  -- "issued only once for the purchased subject": one per quote and one per capture, ever
  UNIQUE (agency_id, quote_id),
  UNIQUE (agency_id, capture_id),
  FOREIGN KEY (agency_id, quote_id, project_id, approval_id, plan_id, plan_hash, revision_hash, target_contract_hash, mode, billable_units)
    REFERENCES kauro.quotes (agency_id, quote_id, project_id, approval_id, plan_id, plan_hash, revision_hash, target_contract_hash, mode, billable_units),
  FOREIGN KEY (agency_id, approval_id, approval_hash) REFERENCES kauro.approvals (agency_id, approval_id, approval_hash),
  FOREIGN KEY (agency_id, order_id, quote_id) REFERENCES kauro.payment_orders (agency_id, order_id, quote_id),
  FOREIGN KEY (agency_id, capture_id, order_id) REFERENCES kauro.capture_facts (agency_id, capture_id, order_id),
  CONSTRAINT commercial_authorizations_consumption CHECK ((state IN ('CONSUMED', 'DELIVERED') OR (state = 'REVOKED' AND revocation_phase <> 'PRE_EXECUTION')) = (job_ref IS NOT NULL AND consumed_at IS NOT NULL)),
  CONSTRAINT commercial_authorizations_delivery CHECK ((state = 'DELIVERED' OR (state = 'REVOKED' AND revocation_phase = 'POST_DELIVERY')) = (delivered_at IS NOT NULL)),
  CONSTRAINT commercial_authorizations_revocation CHECK (
    (state = 'REVOKED') = (revoked_at IS NOT NULL) AND (revoked_at IS NULL) = (revocation_phase IS NULL) AND (revoked_at IS NULL) = (revocation_reason IS NULL)
  )
);
-- one live entitlement per project: a second purchase of new scope starts only after the previous one is consumed or revoked
CREATE UNIQUE INDEX commercial_authorizations_one_live_per_project ON kauro.commercial_authorizations (agency_id, project_id) WHERE state IN ('ACTIVE', 'CONSUMED');
CREATE TRIGGER commercial_authorizations_touch BEFORE UPDATE ON kauro.commercial_authorizations FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER commercial_authorizations_version BEFORE UPDATE ON kauro.commercial_authorizations FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER commercial_authorizations_immutable BEFORE UPDATE ON kauro.commercial_authorizations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('authorization_id,agency_id,project_id,quote_id,order_id,capture_id,approval_id,approval_hash,plan_id,plan_hash,revision_hash,target_contract_hash,capability_id,capability_version,mode,billable_units,honored_after_price_expiry,created_at');
CREATE TRIGGER commercial_authorizations_transition BEFORE UPDATE OF state ON kauro.commercial_authorizations
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('CommercialAuthorization');
CREATE CONSTRAINT TRIGGER commercial_authorizations_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.commercial_authorizations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('commercial_authorization', 'authorization_id');

-- consumption, delivery and revocation facts are recorded once
CREATE OR REPLACE FUNCTION kauro.commercial_authorizations_once() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF (OLD.job_ref IS NOT NULL AND NEW.job_ref IS DISTINCT FROM OLD.job_ref)
     OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at)
     OR (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at)
     OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revocation_phase IS DISTINCT FROM OLD.revocation_phase OR NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason)) THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: commercial authorization % facts are recorded once', OLD.authorization_id USING ERRCODE = 'KA004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commercial_authorizations_once BEFORE UPDATE ON kauro.commercial_authorizations FOR EACH ROW EXECUTE FUNCTION kauro.commercial_authorizations_once();

-- S057 / CMD029-DENY at the database: an authorization exists only for a COMPLETED capture of an order whose obligation that
-- capture fully allocated. A browser return, a pending capture, a denied or reversed one, or a partial payment cannot insert it.
CREATE OR REPLACE FUNCTION kauro.commercial_authorizations_require_capture() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  capture_status text;
  allocated      bigint;
  expected       bigint;
BEGIN
  SELECT c.status, o.allocated_cents, o.expected_amount_cents INTO capture_status, allocated, expected
    FROM kauro.capture_facts c JOIN kauro.payment_orders o ON o.agency_id = c.agency_id AND o.order_id = c.order_id
   WHERE c.agency_id = NEW.agency_id AND c.capture_id = NEW.capture_id AND c.order_id = NEW.order_id;
  IF capture_status IS DISTINCT FROM 'COMPLETED' OR allocated IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'AUTHORITY_WITHOUT_CAPTURE: authorization % needs a completed capture that pays order % in full', NEW.authorization_id, NEW.order_id USING ERRCODE = 'KA013';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commercial_authorizations_require_capture BEFORE INSERT ON kauro.commercial_authorizations
  FOR EACH ROW EXECUTE FUNCTION kauro.commercial_authorizations_require_capture();

-- S059 at the database: a reversal cannot commit while an authorization of that capture is still live (checked at commit, so
-- the reconciler may write the capture and the authorization in either order).
CREATE OR REPLACE FUNCTION kauro.capture_reversal_revokes_authority() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.status = 'REVERSED' AND EXISTS (
    SELECT 1 FROM kauro.commercial_authorizations a
     WHERE a.agency_id = NEW.agency_id AND a.capture_id = NEW.capture_id AND a.state <> 'REVOKED'
  ) THEN
    RAISE EXCEPTION 'AUTHORITY_OUTLIVES_REVERSAL: capture % is reversed but its authorization is not revoked', NEW.capture_id USING ERRCODE = 'KA014';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER capture_facts_reversal_revokes_authority AFTER INSERT OR UPDATE OF status ON kauro.capture_facts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.capture_reversal_revokes_authority();

-- CommercialAuthorization machine (platform, D-PAY-B7): the revocation phase is the state it leaves (07 "CommercialAuthorization").
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('CommercialAuthorization', 'ACTIVE', 'CONSUMED'),
  ('CommercialAuthorization', 'CONSUMED', 'DELIVERED'),
  ('CommercialAuthorization', 'ACTIVE', 'REVOKED'),
  ('CommercialAuthorization', 'CONSUMED', 'REVOKED'),
  ('CommercialAuthorization', 'DELIVERED', 'REVOKED');

-- --- row-level security ------------------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.payment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.payment_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_orders_commerce ON kauro.payment_orders FOR ALL TO kauro_app
  USING (kauro.in_commerce_scope(agency_id)) WITH CHECK (kauro.in_commerce_scope(agency_id));

ALTER TABLE kauro.payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.payment_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_attempts_commerce ON kauro.payment_attempts FOR ALL TO kauro_app
  USING (kauro.in_commerce_scope(agency_id)) WITH CHECK (kauro.in_commerce_scope(agency_id));

ALTER TABLE kauro.capture_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.capture_facts FORCE ROW LEVEL SECURITY;
CREATE POLICY capture_facts_commerce ON kauro.capture_facts FOR ALL TO kauro_app
  USING (kauro.in_commerce_scope(agency_id)) WITH CHECK (kauro.in_commerce_scope(agency_id));

ALTER TABLE kauro.provider_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.provider_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_observations_commerce ON kauro.provider_observations FOR ALL TO kauro_app
  USING (kauro.in_commerce_scope(agency_id)) WITH CHECK (kauro.in_commerce_scope(agency_id));

ALTER TABLE kauro.commercial_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.commercial_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY commercial_authorizations_commerce ON kauro.commercial_authorizations FOR ALL TO kauro_app
  USING (kauro.in_commerce_scope(agency_id)) WITH CHECK (kauro.in_commerce_scope(agency_id));

-- --- grants ----------------------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON kauro.payment_orders, kauro.payment_attempts, kauro.capture_facts, kauro.commercial_authorizations TO kauro_app;
GRANT SELECT, INSERT ON kauro.provider_observations TO kauro_app;
