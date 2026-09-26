-- 0011 — payment orders, payment attempts, provider observations, capture facts, commercial authorizations and the re-binding of a
-- paid capture to a replacement quote (package B09).
--
-- Authority: 07 "Aggregate ownership" (PaymentOrder, PaymentAttempt, PaymentTransaction and Refund own provider effects;
-- CommercialAuthorization links valid payment and approved scope to one logical processing entitlement), 07 "Transaction
-- discipline" (the first accepted request records its intent before external dispatch; unique constraints close races in active
-- attempts; application checks improve messages but cannot be the sole protection), 07 "CommercialAuthorization" (issued only
-- once for the purchased subject after the required verified payment fact; revocation records its phase), 08 "Threat model and
-- assets" (a malicious agency member and a forged webhook are threat actors), 14 "Identity matrix" (runtime service identities
-- have only required database roles), 15 "PaymentOrder and intent", "Capture and authority" (verify order identity,
-- payee/merchant, environment, amount, currency, status and finality; a redirect is not capture evidence), "Webhooks and
-- reconciliation" (facts are added monotonically; an old pending event cannot roll back a confirmed terminal capture), "Payment
-- state transitions", 16 "Scope changes and credits" (one included pre-execution source replacement, recorded against the
-- purchased entitlement), 10 "Provider adapter contract", registry contracts PaymentOrder, PaymentAttempt, CaptureFact
-- ("Browser claims cannot produce a capture fact"), CommercialAuthorization; registry machine PaymentAttempt; scenarios S057,
-- S058, S059, R2-140; COMMERCIAL_LEDGER_WORKED_EXAMPLES §18. Design: docs/design/B09-payments-fiscal.md (D-MACH-B2..B4,
-- D-PROTO-B1..B5, D-INIT-B1, D-PAY-B1..B5, D-AUTH-B1..B4, D-TX-B1, D-QUOTE-B6, D-EVT-B2).
--
-- The role boundary (B09-F1, decision D-AUTH-B4): the request handlers (kauro_app) write only the intent of CMD028 and CMD029 —
-- an order born INTENT_CREATED with nothing learned from the provider, an attempt born PREPARED, and the two claim edges
-- (order INTENT_CREATED -> CREATING, CREATED | APPROVED -> CAPTURING; attempt PREPARED -> DISPATCHING). Every provider-observed fact
-- — a provider identity, an attempt's result, a capture fact and its funds and fee, an observation, a case — and every issuance or
-- revocation of a CommercialAuthorization is written by the payment service (kauro_payment) only: CMD029's settle step runs as a
-- SERVICE unit of work (D-PROTO-B5). As B06 keeps step-up proofs to the verifier and receipts to the validator, the role a gate
-- protects against can never mint the fact that satisfies it.

-- --- payment orders (platform machine PaymentOrder, D-MACH-B2) --------------------------------------------------------------------------
-- The internal immutable order of one checkout: the quote's exact accepted amounts (composite key to the quote), the qualified
-- merchant route it charges (composite key to the route: provider, environment, merchant, payee, currency), the CMD028 journal
-- entry that created it (resume after a lost response), and the provider's order identity learned once. allocated_cents is the
-- part of the obligation that completed captures paid; only the capture allocation (kauro.capture_facts_allocate, below) writes
-- it, never above the obligation (KP002), never down (KP005).
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
  provider_order_id         text CHECK (provider_order_id IS NULL OR kauro.is_provider_ref(provider_order_id)),
  -- the provider-hosted approval page (10: the browser is sent to an allowlisted provider host; the adapter checks the host)
  provider_approval_url     text CHECK (provider_approval_url IS NULL OR (length(provider_approval_url) <= 2048 AND provider_approval_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[!-~]*)?$')),
  expected_amount_cents     bigint NOT NULL CHECK (kauro.is_money(expected_amount_cents) AND expected_amount_cents > 0),
  expected_service_cents    bigint NOT NULL CHECK (kauro.is_money(expected_service_cents)),
  expected_tax_cents        bigint NOT NULL CHECK (kauro.is_money(expected_tax_cents)),
  currency                  text NOT NULL CHECK (currency IN ('USD')),
  terms_hash                text NOT NULL CHECK (kauro.is_sha256_hex(terms_hash)),
  idempotency_hash          text NOT NULL CHECK (kauro.is_sha256_hex(idempotency_hash)),
  allocated_cents           bigint NOT NULL DEFAULT 0 CHECK (kauro.is_money(allocated_cents)),
  created_by_membership_id  uuid NOT NULL,
  intent_entry_id           uuid NOT NULL,
  created_at                timestamptz NOT NULL,
  updated_at                timestamptz NOT NULL,
  UNIQUE (agency_id, order_id),
  CONSTRAINT payment_orders_quote_binding UNIQUE (agency_id, order_id, quote_id),
  CONSTRAINT payment_orders_refund_binding UNIQUE (agency_id, order_id, project_id, terms_hash, provider, environment),
  CONSTRAINT payment_orders_provider_binding UNIQUE (agency_id, order_id, provider, environment),
  CONSTRAINT payment_orders_capture_binding UNIQUE (agency_id, order_id, provider, environment, merchant_ref, payee_digest, currency),
  -- the order charges exactly the quote's accepted terms and amounts, for the quote's project and approval
  CONSTRAINT payment_orders_quote_fk FOREIGN KEY (agency_id, quote_id, project_id, approval_id, terms_hash, expected_amount_cents, expected_service_cents, expected_tax_cents, currency)
    REFERENCES kauro.quotes (agency_id, quote_id, project_id, approval_id, terms_hash, total_cents, service_cents, tax_cents, currency),
  -- ... through exactly the configured merchant of the route (15 "Merchant identity and environment are fixed by server configuration")
  CONSTRAINT payment_orders_route_fk FOREIGN KEY (route_id, provider, environment, merchant_ref, payee_digest, currency)
    REFERENCES kauro.payment_routes (route_id, provider, environment, merchant_ref, payee_digest, currency),
  FOREIGN KEY (agency_id, created_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id),
  CONSTRAINT payment_orders_intent_fk FOREIGN KEY (agency_id, intent_entry_id) REFERENCES kauro.command_journal (agency_id, entry_id),
  CONSTRAINT payment_orders_obligation_split CHECK (expected_amount_cents = expected_service_cents + expected_tax_cents),
  CONSTRAINT payment_orders_allocation_cap CHECK (allocated_cents <= expected_amount_cents),
  CONSTRAINT payment_orders_provider_identity_known CHECK (state NOT IN ('CREATED', 'APPROVED', 'CAPTURING', 'CAPTURE_UNCERTAIN', 'CAPTURED', 'EXPIRED') OR provider_order_id IS NOT NULL)
);
-- one open checkout per project (15 "one intended order"; a second concurrent CreatePaymentOrder is PAYMENT_PENDING)
CREATE UNIQUE INDEX payment_orders_one_open_per_project ON kauro.payment_orders (agency_id, project_id)
  WHERE state IN ('INTENT_CREATED', 'CREATING', 'CREATED', 'APPROVED', 'CAPTURING', 'CAPTURE_UNCERTAIN');
-- a provider order identity belongs to one order of one tenant (PaymentOrder: "order identity cannot migrate between tenants")
CREATE UNIQUE INDEX payment_orders_provider_identity ON kauro.payment_orders (provider, environment, provider_order_id) WHERE provider_order_id IS NOT NULL;
CREATE UNIQUE INDEX payment_orders_one_per_intent ON kauro.payment_orders (intent_entry_id);
CREATE INDEX payment_orders_by_quote ON kauro.payment_orders (agency_id, quote_id);
CREATE TRIGGER payment_orders_touch BEFORE UPDATE ON kauro.payment_orders FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
-- the allocation is bookkeeping of the capture facts (they carry their own versions and events), exempt from the version bump
CREATE TRIGGER payment_orders_version BEFORE UPDATE ON kauro.payment_orders FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump('allocated_cents');
CREATE TRIGGER payment_orders_immutable BEFORE UPDATE ON kauro.payment_orders
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('order_id,agency_id,project_id,quote_id,approval_id,provider,environment,route_id,merchant_ref,payee_digest,expected_amount_cents,expected_service_cents,expected_tax_cents,currency,terms_hash,idempotency_hash,created_by_membership_id,intent_entry_id,created_at');
CREATE TRIGGER payment_orders_learned_once BEFORE UPDATE ON kauro.payment_orders
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('provider_order_id,provider_approval_url');

CREATE OR REPLACE FUNCTION kauro.payment_orders_allocation_writer() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.allocated_cents IS DISTINCT FROM OLD.allocated_cents THEN
    -- depth 1 is a statement of a client; the capture allocation's own UPDATE runs one trigger level deeper
    IF pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'OBLIGATION_OVER_ALLOCATED: order % allocation is maintained by its capture facts only', OLD.order_id USING ERRCODE = 'KP002';
    END IF;
    IF NEW.allocated_cents < OLD.allocated_cents THEN
      RAISE EXCEPTION 'FACT_REGRESSION: order % allocation cannot decrease', OLD.order_id USING ERRCODE = 'KP005';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_orders_allocation_writer BEFORE UPDATE OF allocated_cents ON kauro.payment_orders
  FOR EACH ROW EXECUTE FUNCTION kauro.payment_orders_allocation_writer();
CREATE TRIGGER payment_orders_transition BEFORE UPDATE OF state ON kauro.payment_orders
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('PaymentOrder');
CREATE TRIGGER payment_orders_initial_state BEFORE INSERT ON kauro.payment_orders
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('PaymentOrder');
CREATE CONSTRAINT TRIGGER payment_orders_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.payment_orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('payment_order', 'order_id');

INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('PaymentOrder', 'INTENT_CREATED');
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
  ('PaymentOrder', 'CAPTURING', 'APPROVED'),
  ('PaymentOrder', 'CAPTURING', 'CREATED'),
  ('PaymentOrder', 'CAPTURE_UNCERTAIN', 'CAPTURED'),
  ('PaymentOrder', 'CAPTURE_UNCERTAIN', 'APPROVED'),
  ('PaymentOrder', 'CAPTURE_UNCERTAIN', 'CREATED'),
  ('PaymentOrder', 'CREATED', 'CANCELLED'),
  ('PaymentOrder', 'APPROVED', 'CANCELLED'),
  ('PaymentOrder', 'CREATED', 'EXPIRED'),
  ('PaymentOrder', 'APPROVED', 'EXPIRED');

INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES ('payment_order', 'payment_orders', 'order_id', 'B09');

-- --- payment attempts (registry machine PaymentAttempt) ----------------------------------------------------------------------------------
-- One physical provider effect of a logical operation (create the provider order, capture it, refund a capture): the exact
-- normalized request (requestHash), the provider idempotency identity derived from the attempt (never reused by another attempt),
-- and the protocol's durable states (D-PROTO-B1): PREPARED is written and committed before any call is possible; DISPATCHING
-- (dispatch_intent_committed) carries the bounded call's deadline; the result is recorded in its own transaction by the payment
-- service. A later attempt of the same operation exists only after the previous one proved no effect (FAILED_NO_EFFECT or
-- CANCELLED_BEFORE_DISPATCH) and the operation has at most three (D-PROTO-B3). One live and one confirmed attempt per operation
-- (unique indexes). Merchant withdrawals (WITHDRAW) are the settlement integration's (B15): the registry vocabulary is kept, the
-- value is refused here.
CREATE TABLE kauro.payment_attempts (
  attempt_id            uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(attempt_id)),
  agency_id             uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  order_id              uuid NOT NULL,
  refund_id             uuid,
  operation             text NOT NULL CHECK (operation IN ('CREATE_ORDER', 'CAPTURE', 'REFUND', 'WITHDRAW')),
  ordinal               integer NOT NULL CHECK (ordinal BETWEEN 1 AND 3),
  version               bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                 text NOT NULL DEFAULT 'PREPARED' CHECK (state IN ('PREPARED', 'DISPATCHING', 'PROVIDER_PENDING', 'CONFIRMED', 'FAILED_NO_EFFECT', 'UNCERTAIN', 'CANCELLED_BEFORE_DISPATCH')),
  provider              text NOT NULL,
  environment           text NOT NULL,
  request_hash          text NOT NULL CHECK (kauro.is_sha256_hex(request_hash)),
  provider_request_id   text NOT NULL,
  dispatch_deadline_at  timestamptz,
  started_at            timestamptz NOT NULL,
  last_observed_at      timestamptz NOT NULL,
  evidence_hash         text CHECK (evidence_hash IS NULL OR kauro.is_sha256_hex(evidence_hash)),
  outcome_code          text CHECK (outcome_code IS NULL OR kauro.is_token(outcome_code)),
  intent_entry_id       uuid,
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  UNIQUE (agency_id, attempt_id),
  FOREIGN KEY (agency_id, order_id, provider, environment) REFERENCES kauro.payment_orders (agency_id, order_id, provider, environment),
  CONSTRAINT payment_attempts_intent_fk FOREIGN KEY (agency_id, intent_entry_id) REFERENCES kauro.command_journal (agency_id, entry_id),
  CONSTRAINT payment_attempts_operation_subject CHECK ((operation = 'REFUND') = (refund_id IS NOT NULL)),
  CONSTRAINT payment_attempts_no_withdrawal CHECK (operation <> 'WITHDRAW'),
  -- the provider idempotency identity is the attempt's own (providerRequestIdOf): a retry of an attempt repeats its request only
  CONSTRAINT payment_attempts_request_identity CHECK (provider_request_id = 'kauro-' || attempt_id::text),
  CONSTRAINT payment_attempts_dispatch_deadline CHECK ((state IN ('PREPARED', 'CANCELLED_BEFORE_DISPATCH')) = (dispatch_deadline_at IS NULL)),
  CONSTRAINT payment_attempts_evidence CHECK (state NOT IN ('PROVIDER_PENDING', 'CONFIRMED', 'FAILED_NO_EFFECT') OR evidence_hash IS NOT NULL),
  CONSTRAINT payment_attempts_outcome_named CHECK (state NOT IN ('FAILED_NO_EFFECT', 'UNCERTAIN', 'CANCELLED_BEFORE_DISPATCH') OR outcome_code IS NOT NULL),
  CONSTRAINT payment_attempts_observation_order CHECK (last_observed_at >= started_at)
);
CREATE UNIQUE INDEX payment_attempts_ordinal_order ON kauro.payment_attempts (agency_id, order_id, operation, ordinal) WHERE refund_id IS NULL;
CREATE UNIQUE INDEX payment_attempts_ordinal_refund ON kauro.payment_attempts (agency_id, refund_id, ordinal) WHERE refund_id IS NOT NULL;
CREATE UNIQUE INDEX payment_attempts_one_live_order ON kauro.payment_attempts (agency_id, order_id, operation)
  WHERE refund_id IS NULL AND state IN ('PREPARED', 'DISPATCHING', 'PROVIDER_PENDING', 'UNCERTAIN');
CREATE UNIQUE INDEX payment_attempts_one_live_refund ON kauro.payment_attempts (agency_id, refund_id)
  WHERE refund_id IS NOT NULL AND state IN ('PREPARED', 'DISPATCHING', 'PROVIDER_PENDING', 'UNCERTAIN');
CREATE UNIQUE INDEX payment_attempts_one_confirmed_order ON kauro.payment_attempts (agency_id, order_id, operation) WHERE refund_id IS NULL AND state = 'CONFIRMED';
CREATE UNIQUE INDEX payment_attempts_one_confirmed_refund ON kauro.payment_attempts (agency_id, refund_id) WHERE refund_id IS NOT NULL AND state = 'CONFIRMED';
CREATE UNIQUE INDEX payment_attempts_one_per_intent ON kauro.payment_attempts (intent_entry_id) WHERE intent_entry_id IS NOT NULL;
-- the watchdog's queues (D-PROTO-B4): dispatched attempts past their deadline, and intents whose claim never committed
CREATE INDEX payment_attempts_watchdog ON kauro.payment_attempts (dispatch_deadline_at) WHERE state IN ('DISPATCHING', 'PROVIDER_PENDING', 'UNCERTAIN');
CREATE INDEX payment_attempts_unclaimed ON kauro.payment_attempts (started_at) WHERE state = 'PREPARED';
CREATE TRIGGER payment_attempts_touch BEFORE UPDATE ON kauro.payment_attempts FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER payment_attempts_version BEFORE UPDATE ON kauro.payment_attempts FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER payment_attempts_immutable BEFORE UPDATE ON kauro.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('attempt_id,agency_id,order_id,refund_id,operation,ordinal,provider,environment,request_hash,provider_request_id,started_at,intent_entry_id,created_at');
CREATE TRIGGER payment_attempts_learned_once BEFORE UPDATE ON kauro.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('dispatch_deadline_at');

-- a later attempt of an operation follows only a proved no-effect of the previous one (10 "a new deliberate attempt under policy,
-- not a blind exception retry"; registry PaymentAttempt proved_no_effect effect)
CREATE OR REPLACE FUNCTION kauro.payment_attempts_sequence() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  previous_state text;
BEGIN
  IF NEW.ordinal > 1 THEN
    SELECT a.state INTO previous_state FROM kauro.payment_attempts a
     WHERE a.agency_id = NEW.agency_id AND a.order_id = NEW.order_id AND a.operation = NEW.operation
       AND a.refund_id IS NOT DISTINCT FROM NEW.refund_id AND a.ordinal = NEW.ordinal - 1;
    IF previous_state IS NULL OR previous_state NOT IN ('FAILED_NO_EFFECT', 'CANCELLED_BEFORE_DISPATCH') THEN
      RAISE EXCEPTION 'UNLISTED_TRANSITION: attempt % of % follows an attempt that did not prove no effect (%)', NEW.ordinal, NEW.operation, coalesce(previous_state, 'none') USING ERRCODE = 'KA008';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_attempts_sequence BEFORE INSERT ON kauro.payment_attempts FOR EACH ROW EXECUTE FUNCTION kauro.payment_attempts_sequence();
CREATE TRIGGER payment_attempts_transition BEFORE UPDATE OF state ON kauro.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('PaymentAttempt');
CREATE TRIGGER payment_attempts_initial_state BEFORE INSERT ON kauro.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('PaymentAttempt');
CREATE CONSTRAINT TRIGGER payment_attempts_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.payment_attempts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('payment_attempt', 'attempt_id');

INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('PaymentAttempt', 'PREPARED');
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

INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES ('payment_attempt', 'payment_attempts', 'attempt_id', 'B09');

-- --- provider observations (history; D-PAY-B3) -------------------------------------------------------------------------------------------
-- Every authenticated provider observation applied to an order — a dispatch response, a verified webhook event, a provider query —
-- with what it did (ADVANCED, NO_CHANGE, STALE_IGNORED, DUPLICATE, MISMATCH, UNRECOGNIZED). Facts move only forward; an
-- observation behind the current state is kept here as history and changes nothing (15 "an old pending event cannot roll back a
-- confirmed terminal capture"). A webhook event applies once per subject; a stored query artifact applies once per subject.
-- Append-only; written by the payment service only.
CREATE TABLE kauro.provider_observations (
  observation_id     uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(observation_id)),
  agency_id          uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  order_id           uuid NOT NULL,
  source             text NOT NULL CHECK (source IN ('DISPATCH_RESPONSE', 'WEBHOOK', 'PROVIDER_QUERY')),
  inbox_id           uuid REFERENCES kauro.inbox_records (inbox_id),
  attempt_id         uuid,
  artifact_ref       uuid,
  subject_kind       text NOT NULL CHECK (subject_kind IN ('ORDER', 'CAPTURE', 'REFUND')),
  provider_ref       text NOT NULL CHECK (kauro.is_provider_ref(provider_ref)),
  observed_status    text NOT NULL CHECK (observed_status ~ '^[A-Z][A-Z0-9_]{1,63}$'),
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
  CONSTRAINT provider_observations_source CHECK (
    (source = 'WEBHOOK') = (inbox_id IS NOT NULL) AND (source <> 'DISPATCH_RESPONSE' OR attempt_id IS NOT NULL) AND (source <> 'PROVIDER_QUERY' OR artifact_ref IS NOT NULL)
  ),
  -- an unknown provider status is recorded as such and never coerced (15 "Unknown provider statuses become UNRECOGNIZED_PROVIDER_STATE")
  CONSTRAINT provider_observations_unrecognized CHECK ((observed_status = 'UNRECOGNIZED') = (effect = 'UNRECOGNIZED'))
);
CREATE UNIQUE INDEX provider_observations_once_per_event ON kauro.provider_observations (inbox_id, subject_kind, provider_ref) WHERE inbox_id IS NOT NULL;
CREATE UNIQUE INDEX provider_observations_once_per_artifact ON kauro.provider_observations (artifact_ref, subject_kind, provider_ref) WHERE artifact_ref IS NOT NULL;
CREATE INDEX provider_observations_by_subject ON kauro.provider_observations (agency_id, order_id, subject_kind, provider_ref, observed_at);
CREATE TRIGGER provider_observations_append_only BEFORE UPDATE OR DELETE ON kauro.provider_observations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- capture facts (platform machine CaptureFact, D-MACH-B3; observed birth D-INIT-B1) ---------------------------------------------------
-- One real provider capture of an order (its economic identity: provider, environment, provider capture id — unique across the
-- platform, R2-140 "deduplicate repeated events"). The composite key to the order admits only a capture of that order's provider,
-- environment, merchant, payee and currency (S058: a wrong payee, currency or environment never becomes a capture fact of the
-- order; it is a provider event exception). A fact is born in the status of its first authenticated observation and moves only
-- forward. When it completes (or is first seen reversed, D-PAY-B5), its amount is allocated once: the part that pays what is
-- still owed on the order (service and tax) and the excess above the obligation (R2-140); the allocation never changes afterwards.
-- A provider fact learned later — the availability of the funds (HELD, AVAILABLE) or the provider's fee — is a new version of the
-- capture with an event of its own (capture.funds_observed.v1, capture.fee_observed.v1; D-EVT-B2): the ledger consumer posts it
-- once, and capture.completed.v1 is published exactly once per capture (domain_events_capture_completed_once, below).
CREATE TABLE kauro.capture_facts (
  capture_id               uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(capture_id)),
  agency_id                uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  order_id                 uuid NOT NULL,
  version                  bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  status                   text NOT NULL CHECK (status IN ('COMPLETED', 'PENDING', 'DENIED', 'REVERSED')),
  provider                 text NOT NULL,
  environment              text NOT NULL CHECK (environment IN ('SANDBOX', 'LIVE')),
  provider_capture_id      text NOT NULL CHECK (kauro.is_provider_ref(provider_capture_id)),
  merchant_ref             uuid NOT NULL,
  payee_digest             text NOT NULL CHECK (kauro.is_sha256_hex(payee_digest)),
  amount_cents             bigint NOT NULL CHECK (kauro.is_money(amount_cents) AND amount_cents > 0),
  currency                 text NOT NULL CHECK (currency IN ('USD')),
  allocated_service_cents  bigint NOT NULL DEFAULT 0 CHECK (kauro.is_money(allocated_service_cents)),
  allocated_tax_cents      bigint NOT NULL DEFAULT 0 CHECK (kauro.is_money(allocated_tax_cents)),
  excess_cents             bigint NOT NULL DEFAULT 0 CHECK (kauro.is_money(excess_cents)),
  -- provider-reported availability of the captured funds; AVAILABLE only from the provider (CMD034 failure: pending or held is
  -- never coerced to available cash)
  funds_state              text NOT NULL DEFAULT 'UNKNOWN' CHECK (funds_state IN ('UNKNOWN', 'HELD', 'AVAILABLE')),
  provider_fee_cents       bigint CHECK (provider_fee_cents IS NULL OR kauro.is_money(provider_fee_cents)),
  provider_completed_at    timestamptz,
  first_observation_source text NOT NULL CHECK (first_observation_source IN ('DISPATCH_RESPONSE', 'WEBHOOK', 'PROVIDER_QUERY')),
  first_observed_at        timestamptz NOT NULL,
  observed_at              timestamptz NOT NULL,
  evidence_hash            text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  attempt_id               uuid,
  created_at               timestamptz NOT NULL,
  updated_at               timestamptz NOT NULL,
  UNIQUE (agency_id, capture_id),
  CONSTRAINT capture_facts_order_binding UNIQUE (agency_id, capture_id, order_id),
  CONSTRAINT capture_facts_provider_identity UNIQUE (provider, environment, provider_capture_id),
  CONSTRAINT capture_facts_order_fk FOREIGN KEY (agency_id, order_id, provider, environment, merchant_ref, payee_digest, currency)
    REFERENCES kauro.payment_orders (agency_id, order_id, provider, environment, merchant_ref, payee_digest, currency),
  FOREIGN KEY (agency_id, attempt_id) REFERENCES kauro.payment_attempts (agency_id, attempt_id),
  -- a completed (or reversed) capture's amount is exactly its service, tax and excess; pending and denied carry none
  CONSTRAINT capture_facts_allocation CHECK (
    (status IN ('COMPLETED', 'REVERSED') AND allocated_service_cents + allocated_tax_cents + excess_cents = amount_cents)
    OR (status IN ('PENDING', 'DENIED') AND allocated_service_cents = 0 AND allocated_tax_cents = 0 AND excess_cents = 0)
  ),
  -- the completion instant is the tax point and the price-expiry comparison (07 "a capture completed after price expiry is honored")
  CONSTRAINT capture_facts_completion_time CHECK (status <> 'COMPLETED' OR provider_completed_at IS NOT NULL),
  CONSTRAINT capture_facts_observation_order CHECK (observed_at >= first_observed_at)
);
CREATE INDEX capture_facts_by_order ON kauro.capture_facts (agency_id, order_id);
CREATE TRIGGER capture_facts_touch BEFORE UPDATE ON kauro.capture_facts FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
-- only the latest observation time changes without a new version; the funds availability and the fee are provider facts of their
-- own version and event (B09-F8, B09-F15; D-EVT-B2)
CREATE TRIGGER capture_facts_version BEFORE UPDATE ON kauro.capture_facts FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump('observed_at');
CREATE TRIGGER capture_facts_immutable BEFORE UPDATE ON kauro.capture_facts
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('capture_id,agency_id,order_id,provider,environment,provider_capture_id,merchant_ref,payee_digest,amount_cents,currency,first_observation_source,first_observed_at,created_at');
CREATE TRIGGER capture_facts_learned_once BEFORE UPDATE ON kauro.capture_facts
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('provider_fee_cents,provider_completed_at,attempt_id');

-- facts are added monotonically (15 "Webhooks and reconciliation"): the allocation is fixed by the move into COMPLETED or
-- REVERSED and never changes afterwards; the observation time never goes back; known funds availability never becomes unknown
CREATE OR REPLACE FUNCTION kauro.capture_facts_monotonic() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF (NEW.allocated_service_cents, NEW.allocated_tax_cents, NEW.excess_cents) IS DISTINCT FROM (OLD.allocated_service_cents, OLD.allocated_tax_cents, OLD.excess_cents)
     AND NOT (OLD.status = 'PENDING' AND NEW.status IN ('COMPLETED', 'REVERSED')) THEN
    RAISE EXCEPTION 'FACT_REGRESSION: capture % allocation is fixed when it completes', OLD.capture_id USING ERRCODE = 'KP005';
  END IF;
  IF NEW.observed_at < OLD.observed_at THEN
    RAISE EXCEPTION 'FACT_REGRESSION: capture % observation time cannot go back', OLD.capture_id USING ERRCODE = 'KP005';
  END IF;
  IF OLD.funds_state <> 'UNKNOWN' AND NEW.funds_state = 'UNKNOWN' THEN
    RAISE EXCEPTION 'FACT_REGRESSION: capture % funds availability cannot become unknown', OLD.capture_id USING ERRCODE = 'KP005';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER capture_facts_monotonic BEFORE UPDATE ON kauro.capture_facts FOR EACH ROW EXECUTE FUNCTION kauro.capture_facts_monotonic();
CREATE TRIGGER capture_facts_transition BEFORE UPDATE OF status ON kauro.capture_facts
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition_of('CaptureFact', 'status');
CREATE TRIGGER capture_facts_observed_birth BEFORE INSERT ON kauro.capture_facts
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_observed_birth('CaptureFact', 'status');
-- a capture's status is a transition subject (D-TX-2): an authorization issuance and a refund approval rely on it being COMPLETED
-- without changing it, so a reversal issued while either is in flight waits for it and then sees what it committed
CREATE TRIGGER capture_facts_transition_lock BEFORE UPDATE OF status ON kauro.capture_facts
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION kauro.take_transition_lock('kauro.capture_facts', 'capture_id');
CREATE CONSTRAINT TRIGGER capture_facts_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.capture_facts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('capture', 'capture_id');

-- The allocation of a completing capture against its order (D-PAY-B1, R2-140): under the order's row lock, the part applied to the
-- obligation is exactly min(amount, still owed), the rest is excess, and the service and tax paid by every completed capture of
-- the order never exceed the order's service and tax (the domain splits them cumulatively; this is the database's ceiling).
-- Raises OBLIGATION_OVER_ALLOCATED (KP002) otherwise; it is the only writer of payment_orders.allocated_cents.
CREATE OR REPLACE FUNCTION kauro.capture_facts_allocate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  o record;
  applied bigint := NEW.allocated_service_cents + NEW.allocated_tax_cents;
  paid_service bigint;
  paid_tax bigint;
BEGIN
  IF NEW.status NOT IN ('COMPLETED', 'REVERSED') OR (TG_OP = 'UPDATE' AND OLD.status IN ('COMPLETED', 'REVERSED')) THEN
    RETURN NULL;
  END IF;
  SELECT p.expected_amount_cents, p.expected_service_cents, p.expected_tax_cents, p.allocated_cents INTO o
    FROM kauro.payment_orders p WHERE p.agency_id = NEW.agency_id AND p.order_id = NEW.order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTEXT: order % of capture % is not visible', NEW.order_id, NEW.capture_id USING ERRCODE = 'KA006';
  END IF;
  IF applied <> least(NEW.amount_cents, o.expected_amount_cents - o.allocated_cents) THEN
    RAISE EXCEPTION 'OBLIGATION_OVER_ALLOCATED: capture % applies % to order % which still owes %', NEW.capture_id, applied, NEW.order_id, o.expected_amount_cents - o.allocated_cents USING ERRCODE = 'KP002';
  END IF;
  SELECT coalesce(sum(c.allocated_service_cents), 0), coalesce(sum(c.allocated_tax_cents), 0) INTO paid_service, paid_tax
    FROM kauro.capture_facts c WHERE c.agency_id = NEW.agency_id AND c.order_id = NEW.order_id AND c.status IN ('COMPLETED', 'REVERSED');
  IF paid_service > o.expected_service_cents OR paid_tax > o.expected_tax_cents THEN
    RAISE EXCEPTION 'OBLIGATION_OVER_ALLOCATED: the captures of order % pay more service or tax than it owes', NEW.order_id USING ERRCODE = 'KP002';
  END IF;
  IF applied > 0 THEN
    UPDATE kauro.payment_orders SET allocated_cents = allocated_cents + applied WHERE agency_id = NEW.agency_id AND order_id = NEW.order_id;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER capture_facts_allocate AFTER INSERT OR UPDATE OF status ON kauro.capture_facts
  FOR EACH ROW EXECUTE FUNCTION kauro.capture_facts_allocate();

INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('CaptureFact', 'PENDING');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('CaptureFact', 'PENDING', 'COMPLETED'),
  ('CaptureFact', 'PENDING', 'DENIED'),
  ('CaptureFact', 'PENDING', 'REVERSED'),
  ('CaptureFact', 'COMPLETED', 'REVERSED');

INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES ('capture', 'capture_facts', 'capture_id', 'B09');

-- capture.completed.v1 is the one reconciled financial event of a capture (TRANSITIONS "Cross-aggregate finalization": fiscal
-- correction, service refund and commission adjustment are separate idempotent effects from the same reconciled financial
-- event): it is published once per capture, so no later fact of the capture can re-deliver the completion to FINANCE, FISCAL or
-- COMMISSIONS (15 "Repeated delivery cannot duplicate capture, authorization, refund or commission"; B09-F8). An additive
-- partial unique index on B06's event table (D-BIND-B1).
CREATE UNIQUE INDEX domain_events_capture_completed_once ON kauro.domain_events (aggregate_id) WHERE event_type = 'capture.completed.v1';

-- --- approvals: the live approval is a transition subject (D-TX-B1) ----------------------------------------------------------------------
-- A CommercialAuthorization binds "the current non-withdrawn agency approval" (registry CommercialAuthorization.approvalHash). A
-- withdrawal (CMD026) or a revision of an APPROVED plan (CMD023) ends the approval by setting withdrawn_at; this additive trigger
-- gives that write the exclusive half of the approval's transition lock (B06 D-TX-2), so an authorization issued while the
-- withdrawal is in flight is ordered before it, and one issued after it reads it.
CREATE TRIGGER approvals_transition_lock BEFORE UPDATE OF withdrawn_at ON kauro.approvals
  FOR EACH ROW WHEN (OLD.withdrawn_at IS DISTINCT FROM NEW.withdrawn_at) EXECUTE FUNCTION kauro.take_transition_lock('kauro.approvals', 'approval_id');

-- --- commercial authorizations (platform machine CommercialAuthorization, D-MACH-B4) ------------------------------------------------------
-- The one logical processing entitlement of a purchase (07 "CommercialAuthorization": every prerequisite binds the same source
-- and policy). Its subject columns are copies the composite keys make exact — the quote's project, plan, approval, hashes, mode
-- and units; the approval's hash; the project's capability — and it is issued once per quote, one live per capture and one live
-- per project. It names the order that captured the payment and that order's quote (order_quote_id): the same quote for the
-- purchase's own authorization, or — for a paid capture re-bound to a replacement quote under the included source replacement
-- (D-QUOTE-B6) — the replaced quote, with the recorded re-binding (rebinding_id) that allocates the capture to the replacement.
-- kauro.commercial_authorizations_require_capture (KP004) refuses it unless, at issuance and under the transition locks of what it
-- relies on: the capture is COMPLETED and alone pays the whole obligation with no excess; a re-bound authorization's replaced
-- authorization is already revoked; the quote is ACCEPTED_FOR_CHECKOUT; the approval is live; the agency is ACTIVE; the quoted
-- source revision is SEALED; the quoted target contract is confirmed and current; the project's capability is offered (S057, S058,
-- S060). A reversal of its capture cannot commit while it is still live (KP006, below). Only the payment service issues and
-- revokes (B09-F1); consumption and delivery are the processing package's edges (B08, integration obligation).
CREATE TABLE kauro.commercial_authorizations (
  authorization_id           uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(authorization_id)),
  agency_id                  uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id                 uuid NOT NULL,
  quote_id                   uuid NOT NULL,
  order_id                   uuid NOT NULL,
  order_quote_id             uuid NOT NULL,
  capture_id                 uuid NOT NULL,
  rebinding_id               uuid,
  approval_id                uuid NOT NULL,
  approval_hash              text NOT NULL CHECK (kauro.is_sha256_hex(approval_hash)),
  plan_id                    uuid NOT NULL,
  plan_hash                  text NOT NULL CHECK (kauro.is_sha256_hex(plan_hash)),
  revision_hash              text NOT NULL CHECK (kauro.is_sha256_hex(revision_hash)),
  target_contract_hash       text NOT NULL CHECK (kauro.is_sha256_hex(target_contract_hash)),
  capability_id              uuid NOT NULL,
  capability_version         text NOT NULL,
  mode                       text NOT NULL CHECK (mode IN ('CLEAN', 'HUBSPOT', 'SALESFORCE')),
  billable_units             bigint NOT NULL CHECK (billable_units >= 1),
  version                    bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                      text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'CONSUMED', 'DELIVERED', 'REVOKED')),
  honored_after_price_expiry boolean NOT NULL,
  job_ref                    uuid,
  consumed_at                timestamptz,
  delivered_at               timestamptz,
  revoked_at                 timestamptz,
  revocation_phase           text CHECK (revocation_phase IS NULL OR revocation_phase IN ('PRE_EXECUTION', 'DURING_EXECUTION', 'POST_DELIVERY')),
  revocation_code            text CHECK (revocation_code IS NULL OR kauro.is_token(revocation_code)),
  created_at                 timestamptz NOT NULL,
  updated_at                 timestamptz NOT NULL,
  UNIQUE (agency_id, authorization_id),
  -- binding target of purchase_rebindings_authorization_fk: a re-binding replaces exactly this authorization of this capture and quote
  CONSTRAINT commercial_authorizations_rebinding_target UNIQUE (agency_id, authorization_id, capture_id, quote_id),
  CONSTRAINT commercial_authorizations_quote_fk FOREIGN KEY (agency_id, quote_id, project_id, plan_id, approval_id, plan_hash, revision_hash, target_contract_hash, mode, billable_units)
    REFERENCES kauro.quotes (agency_id, quote_id, project_id, plan_id, approval_id, plan_hash, revision_hash, target_contract_hash, mode, billable_units),
  CONSTRAINT commercial_authorizations_approval_fk FOREIGN KEY (agency_id, approval_id, approval_hash) REFERENCES kauro.approvals (agency_id, approval_id, approval_hash),
  CONSTRAINT commercial_authorizations_capability_fk FOREIGN KEY (agency_id, project_id, mode, capability_id, capability_version)
    REFERENCES kauro.projects (agency_id, project_id, mode, capability_id, capability_version),
  -- the order that captured the payment, and the quote that order charged
  CONSTRAINT commercial_authorizations_order_fk FOREIGN KEY (agency_id, order_id, order_quote_id) REFERENCES kauro.payment_orders (agency_id, order_id, quote_id),
  FOREIGN KEY (agency_id, capture_id, order_id) REFERENCES kauro.capture_facts (agency_id, capture_id, order_id),
  -- the purchase's own authorization names the order's quote; a re-bound one names a replacement quote and its re-binding
  CONSTRAINT commercial_authorizations_purchase_binding CHECK ((rebinding_id IS NULL) = (quote_id = order_quote_id)),
  CONSTRAINT commercial_authorizations_consumption CHECK ((job_ref IS NULL) = (consumed_at IS NULL) AND (state NOT IN ('CONSUMED', 'DELIVERED') OR job_ref IS NOT NULL)),
  CONSTRAINT commercial_authorizations_delivery CHECK ((state <> 'DELIVERED' OR delivered_at IS NOT NULL) AND (delivered_at IS NULL OR consumed_at IS NOT NULL)),
  CONSTRAINT commercial_authorizations_revocation CHECK (
    (state = 'REVOKED') = (revoked_at IS NOT NULL) AND (revoked_at IS NULL) = (revocation_phase IS NULL) AND (revoked_at IS NULL) = (revocation_code IS NULL)
  )
);
-- issued only once for the purchased subject (07): one per quote, one original per capture, one per re-binding, one live per
-- capture and one live per project (a re-binding revokes the replaced authorization before it issues the replacement's)
CREATE UNIQUE INDEX commercial_authorizations_one_per_quote ON kauro.commercial_authorizations (agency_id, quote_id);
CREATE UNIQUE INDEX commercial_authorizations_one_original_per_capture ON kauro.commercial_authorizations (agency_id, capture_id) WHERE rebinding_id IS NULL;
CREATE UNIQUE INDEX commercial_authorizations_one_per_rebinding ON kauro.commercial_authorizations (rebinding_id) WHERE rebinding_id IS NOT NULL;
CREATE UNIQUE INDEX commercial_authorizations_one_live_per_capture ON kauro.commercial_authorizations (agency_id, capture_id) WHERE state <> 'REVOKED';
CREATE UNIQUE INDEX commercial_authorizations_one_live_per_project ON kauro.commercial_authorizations (agency_id, project_id) WHERE state <> 'REVOKED';
CREATE TRIGGER commercial_authorizations_touch BEFORE UPDATE ON kauro.commercial_authorizations FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER commercial_authorizations_version BEFORE UPDATE ON kauro.commercial_authorizations FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER commercial_authorizations_immutable BEFORE UPDATE ON kauro.commercial_authorizations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('authorization_id,agency_id,project_id,quote_id,order_id,order_quote_id,capture_id,rebinding_id,approval_id,approval_hash,plan_id,plan_hash,revision_hash,target_contract_hash,capability_id,capability_version,mode,billable_units,honored_after_price_expiry,created_at');
CREATE TRIGGER commercial_authorizations_learned_once BEFORE UPDATE ON kauro.commercial_authorizations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('job_ref,consumed_at,delivered_at,revoked_at,revocation_phase,revocation_code');

CREATE OR REPLACE FUNCTION kauro.commercial_authorizations_require_capture() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  c record;
  o record;
  subject_ok boolean;
  revision uuid;
  contract uuid;
  replaced uuid;
BEGIN
  -- the shared halves of what the issuance relies on without changing it, in the platform's lock order (design §6.2)
  PERFORM kauro.await_transition('kauro.agencies', NEW.agency_id::text);
  PERFORM kauro.await_transition('kauro.capabilities', NEW.mode);
  PERFORM kauro.await_transition('kauro.approvals', NEW.approval_id::text);
  SELECT r.revision_id INTO revision FROM kauro.dataset_revisions r
   WHERE r.agency_id = NEW.agency_id AND r.project_id = NEW.project_id AND r.manifest_hash = NEW.revision_hash;
  IF revision IS NOT NULL THEN
    PERFORM kauro.await_transition('kauro.dataset_revisions', revision::text);
  END IF;
  SELECT t.contract_id INTO contract FROM kauro.target_contracts t
   WHERE t.agency_id = NEW.agency_id AND t.project_id = NEW.project_id AND t.body_hash = NEW.target_contract_hash;
  IF contract IS NOT NULL THEN
    PERFORM kauro.await_transition('kauro.target_contracts', contract::text);
  END IF;
  PERFORM kauro.await_transition('kauro.quotes', NEW.quote_id::text);
  PERFORM kauro.await_transition('kauro.capture_facts', NEW.capture_id::text);

  SELECT f.status, f.amount_cents, f.allocated_service_cents, f.allocated_tax_cents, f.excess_cents INTO c
    FROM kauro.capture_facts f WHERE f.agency_id = NEW.agency_id AND f.capture_id = NEW.capture_id AND f.order_id = NEW.order_id;
  SELECT p.expected_amount_cents, p.expected_service_cents, p.expected_tax_cents INTO o
    FROM kauro.payment_orders p WHERE p.agency_id = NEW.agency_id AND p.order_id = NEW.order_id AND p.quote_id = NEW.order_quote_id;
  IF c.status IS DISTINCT FROM 'COMPLETED' OR o.expected_amount_cents IS NULL
     OR c.amount_cents <> o.expected_amount_cents OR c.allocated_service_cents <> o.expected_service_cents
     OR c.allocated_tax_cents <> o.expected_tax_cents OR c.excess_cents <> 0 THEN
    RAISE EXCEPTION 'AUTHORITY_WITHOUT_CAPTURE: capture % does not alone pay the obligation of order %', NEW.capture_id, NEW.order_id USING ERRCODE = 'KP004';
  END IF;
  IF NEW.rebinding_id IS NOT NULL THEN
    -- a re-bound entitlement: the recorded allocation of this capture to this replacement quote exists, and the authorization it
    -- replaces is already revoked in this transaction (one live entitlement per purchase; D-QUOTE-B6)
    SELECT b.from_authorization_id INTO replaced FROM kauro.purchase_rebindings b
     WHERE b.agency_id = NEW.agency_id AND b.rebinding_id = NEW.rebinding_id AND b.capture_id = NEW.capture_id AND b.to_quote_id = NEW.quote_id;
    IF replaced IS NULL OR NOT EXISTS (
      SELECT 1 FROM kauro.commercial_authorizations a WHERE a.agency_id = NEW.agency_id AND a.authorization_id = replaced AND a.state = 'REVOKED'
    ) THEN
      RAISE EXCEPTION 'AUTHORITY_WITHOUT_CAPTURE: authorization % names no re-binding of capture % to quote %', NEW.authorization_id, NEW.capture_id, NEW.quote_id USING ERRCODE = 'KP004';
    END IF;
  END IF;
  SELECT
    EXISTS (SELECT 1 FROM kauro.quotes q WHERE q.agency_id = NEW.agency_id AND q.quote_id = NEW.quote_id AND q.state = 'ACCEPTED_FOR_CHECKOUT')
    AND EXISTS (SELECT 1 FROM kauro.approvals a WHERE a.agency_id = NEW.agency_id AND a.approval_id = NEW.approval_id AND a.withdrawn_at IS NULL)
    AND EXISTS (SELECT 1 FROM kauro.agencies g WHERE g.agency_id = NEW.agency_id AND g.state = 'ACTIVE')
    AND EXISTS (SELECT 1 FROM kauro.dataset_revisions r WHERE r.agency_id = NEW.agency_id AND r.revision_id = revision AND r.state = 'SEALED')
    AND EXISTS (SELECT 1 FROM kauro.target_contracts t WHERE t.agency_id = NEW.agency_id AND t.contract_id = contract AND t.confirmed_at IS NOT NULL AND t.superseded_at IS NULL)
    AND EXISTS (SELECT 1 FROM kauro.capabilities k WHERE k.capability_id = NEW.capability_id AND k.state IN ('AVAILABLE_LIMITED', 'AVAILABLE'))
  INTO subject_ok;
  IF NOT subject_ok THEN
    RAISE EXCEPTION 'AUTHORITY_WITHOUT_CAPTURE: the purchased subject of quote % no longer binds (quote, approval, agency, source, target or capability)', NEW.quote_id USING ERRCODE = 'KP004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commercial_authorizations_require_capture BEFORE INSERT ON kauro.commercial_authorizations
  FOR EACH ROW EXECUTE FUNCTION kauro.commercial_authorizations_require_capture();

-- a revocation records the phase of the state it leaves (07 "CommercialAuthorization"; commerce/authority revocationPhaseOf)
CREATE OR REPLACE FUNCTION kauro.commercial_authorizations_revocation_phase() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.revocation_phase IS DISTINCT FROM (CASE OLD.state WHEN 'ACTIVE' THEN 'PRE_EXECUTION' WHEN 'CONSUMED' THEN 'DURING_EXECUTION' WHEN 'DELIVERED' THEN 'POST_DELIVERY' END) THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: authorization % revoked from % records phase %', OLD.authorization_id, OLD.state, NEW.revocation_phase USING ERRCODE = 'KA008';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commercial_authorizations_revocation_phase BEFORE UPDATE OF state ON kauro.commercial_authorizations
  FOR EACH ROW WHEN (NEW.state = 'REVOKED' AND OLD.state IS DISTINCT FROM 'REVOKED') EXECUTE FUNCTION kauro.commercial_authorizations_revocation_phase();
CREATE TRIGGER commercial_authorizations_transition BEFORE UPDATE OF state ON kauro.commercial_authorizations
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('CommercialAuthorization');
CREATE TRIGGER commercial_authorizations_initial_state BEFORE INSERT ON kauro.commercial_authorizations
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('CommercialAuthorization');
-- ExecuteProject (CMD036, B08) and publication rely on the authorization's state: a revocation in flight orders itself with them
CREATE TRIGGER commercial_authorizations_transition_lock BEFORE UPDATE OF state ON kauro.commercial_authorizations
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.take_transition_lock('kauro.commercial_authorizations', 'authorization_id');
CREATE CONSTRAINT TRIGGER commercial_authorizations_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.commercial_authorizations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('commercial_authorization', 'authorization_id');

INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('CommercialAuthorization', 'ACTIVE');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('CommercialAuthorization', 'ACTIVE', 'CONSUMED'),
  ('CommercialAuthorization', 'CONSUMED', 'DELIVERED'),
  ('CommercialAuthorization', 'ACTIVE', 'REVOKED'),
  ('CommercialAuthorization', 'CONSUMED', 'REVOKED'),
  ('CommercialAuthorization', 'DELIVERED', 'REVOKED');

INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES ('commercial_authorization', 'commercial_authorizations', 'authorization_id', 'B09');

-- A reversal (chargeback) revokes the entitlement it paid for, in the same transaction (S059; CaptureFact provider_reversed effect
-- "Revoke the authorization with its phase ... never charge again"): checked at COMMIT, so the reconciler can write the capture and
-- the authorization in either order. AUTHORITY_OUTLIVES_REVERSAL (KP006).
CREATE OR REPLACE FUNCTION kauro.capture_reversal_revokes_authority() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF EXISTS (
    SELECT 1 FROM kauro.commercial_authorizations a WHERE a.agency_id = NEW.agency_id AND a.capture_id = NEW.capture_id AND a.state <> 'REVOKED'
  ) THEN
    RAISE EXCEPTION 'AUTHORITY_OUTLIVES_REVERSAL: capture % was reversed while its authorization is still live', NEW.capture_id USING ERRCODE = 'KP006';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER capture_facts_reversal_revokes AFTER UPDATE OF status ON kauro.capture_facts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'REVERSED') EXECUTE FUNCTION kauro.capture_reversal_revokes_authority();

-- --- purchase re-bindings: the one included pre-execution source replacement (D-QUOTE-B6; B09-F2) ---------------------------------------
-- 16 "Scope changes and credits": "The initial default permits one pre-execution source replacement after revalidation, provided
-- no paid execution has started and the new scope stays in the same band"; COMMERCIAL_LEDGER_WORKED_EXAMPLES §18: "Record the
-- replacement against the purchased entitlement; do not charge a new project by default"; §16: the prior approval cannot be
-- rebound to different bytes (a replacement needs its own new revision, approval and quote); policy
-- pricing.customerPreExecutionSourceReplacementsIncluded. A re-binding is the recorded allocation of one paid capture from the
-- quote it paid to a replacement quote of the same project that carries the same commercial terms (quotes_replacement_terms_fk)
-- over a replacement revision whose lineage (B06 dataset_revisions.supersedes_revision_id, recorded by the source lifecycle, B07
-- Q-B07-17) reaches the replaced one. The payment service performs it in one SERVICE unit of work (the processing package's or
-- the recurrence package's replacement flow asks for it through the PurchaseRebinder port): it inserts this row
-- (purchase_rebindings_guard, KP013), revokes the replaced authorization (PRE_EXECUTION, SOURCE_REPLACED), supersedes the replaced
-- quote by the replacement, accepts the replacement and issues its authorization bound to the same capture; the completeness of
-- all four is checked at COMMIT (purchase_rebindings_complete, KP013). Append-only.
CREATE TABLE kauro.purchase_rebindings (
  rebinding_id                uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(rebinding_id)),
  agency_id                   uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id                  uuid NOT NULL,
  order_id                    uuid NOT NULL,
  capture_id                  uuid NOT NULL,
  from_quote_id               uuid NOT NULL,
  from_authorization_id       uuid NOT NULL,
  to_quote_id                 uuid NOT NULL,
  allowance_ordinal           integer NOT NULL CHECK (allowance_ordinal >= 1),
  reason_code                 text NOT NULL CHECK (reason_code IN ('PRE_EXECUTION_SOURCE_REPLACEMENT')),
  -- the source lifecycle's lineage evidence the port returned (the replacement revision and the one it supersedes)
  lineage_evidence_hash       text NOT NULL CHECK (kauro.is_sha256_hex(lineage_evidence_hash)),
  requested_by_membership_id  uuid NOT NULL,
  created_at                  timestamptz NOT NULL,
  UNIQUE (agency_id, rebinding_id),
  -- binding target of commercial_authorizations_rebinding_fk
  CONSTRAINT purchase_rebindings_authorization_binding UNIQUE (agency_id, rebinding_id, capture_id, to_quote_id),
  -- a quote is replaced once and a replacement re-binds once; the ordinal of the capture's allowance is taken once
  CONSTRAINT purchase_rebindings_from_once UNIQUE (agency_id, from_quote_id),
  CONSTRAINT purchase_rebindings_to_once UNIQUE (agency_id, to_quote_id),
  CONSTRAINT purchase_rebindings_allowance_once UNIQUE (agency_id, capture_id, allowance_ordinal),
  FOREIGN KEY (agency_id, capture_id, order_id) REFERENCES kauro.capture_facts (agency_id, capture_id, order_id),
  FOREIGN KEY (agency_id, from_quote_id, project_id) REFERENCES kauro.quotes (agency_id, quote_id, project_id),
  FOREIGN KEY (agency_id, to_quote_id, project_id) REFERENCES kauro.quotes (agency_id, quote_id, project_id),
  CONSTRAINT purchase_rebindings_authorization_fk FOREIGN KEY (agency_id, from_authorization_id, capture_id, from_quote_id)
    REFERENCES kauro.commercial_authorizations (agency_id, authorization_id, capture_id, quote_id),
  FOREIGN KEY (agency_id, requested_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id),
  CONSTRAINT purchase_rebindings_distinct CHECK (from_quote_id <> to_quote_id)
);
CREATE TRIGGER purchase_rebindings_append_only BEFORE UPDATE OR DELETE ON kauro.purchase_rebindings
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- The allowance guard (KP013 REPLACEMENT_REFUSED), under the replaced authorization's exclusive transition lock (so it is ordered
-- with the processing package's consumption of that authorization: "provided no paid execution has started"), the capture's
-- shared transition lock (ordered with a reversal) and its refund commitment lock (ordered with a refund approval): the replaced
-- authorization is ACTIVE; the capture is COMPLETED and alone pays its order; no refund of the capture awaits review or commits
-- (the purchase is intact); the replaced quote is ACCEPTED_FOR_CHECKOUT and the replacement is an ISSUED replacement of it; the
-- capture's re-bindings are within the policy's included replacements and this one takes the next ordinal; the replacement
-- revision is SEALED and its lineage within the project reaches the replaced revision.
CREATE OR REPLACE FUNCTION kauro.purchase_rebindings_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  f record;
  c record;
  o record;
  q_from record;
  q_to record;
  allowance integer;
  used integer;
  from_revision uuid;
  to_revision uuid;
  lineage boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(kauro.transition_key('kauro.commercial_authorizations', NEW.from_authorization_id::text));
  PERFORM kauro.await_transition('kauro.capture_facts', NEW.capture_id::text);
  PERFORM pg_advisory_xact_lock(kauro.transition_key('kauro.capture_refunds', NEW.capture_id::text));
  SELECT a.state INTO f FROM kauro.commercial_authorizations a WHERE a.agency_id = NEW.agency_id AND a.authorization_id = NEW.from_authorization_id;
  IF f.state IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'REPLACEMENT_REFUSED: authorization % is % (a replacement is included only before paid execution starts)', NEW.from_authorization_id, coalesce(f.state, 'not visible') USING ERRCODE = 'KP013';
  END IF;
  SELECT x.status, x.amount_cents, x.allocated_service_cents, x.allocated_tax_cents, x.excess_cents INTO c
    FROM kauro.capture_facts x WHERE x.agency_id = NEW.agency_id AND x.capture_id = NEW.capture_id;
  SELECT p.expected_amount_cents, p.expected_service_cents, p.expected_tax_cents INTO o
    FROM kauro.payment_orders p WHERE p.agency_id = NEW.agency_id AND p.order_id = NEW.order_id;
  IF c.status IS DISTINCT FROM 'COMPLETED' OR c.amount_cents <> o.expected_amount_cents OR c.excess_cents <> 0
     OR c.allocated_service_cents <> o.expected_service_cents OR c.allocated_tax_cents <> o.expected_tax_cents THEN
    RAISE EXCEPTION 'REPLACEMENT_REFUSED: capture % does not alone pay its purchase', NEW.capture_id USING ERRCODE = 'KP013';
  END IF;
  IF EXISTS (
    SELECT 1 FROM kauro.refunds r WHERE r.agency_id = NEW.agency_id AND r.capture_id = NEW.capture_id
       AND r.state IN ('REQUESTED', 'APPROVED', 'SUBMITTING', 'UNCERTAIN', 'COMPLETED')
  ) THEN
    RAISE EXCEPTION 'REPLACEMENT_REFUSED: a refund of capture % awaits review or commits; the purchase is not intact', NEW.capture_id USING ERRCODE = 'KP013';
  END IF;
  SELECT q.state, q.revision_hash, q.price_policy_version INTO q_from FROM kauro.quotes q WHERE q.agency_id = NEW.agency_id AND q.quote_id = NEW.from_quote_id;
  SELECT q.state, q.revision_hash, q.replaces_quote_id INTO q_to FROM kauro.quotes q WHERE q.agency_id = NEW.agency_id AND q.quote_id = NEW.to_quote_id;
  IF q_from.state IS DISTINCT FROM 'ACCEPTED_FOR_CHECKOUT' OR q_to.state IS DISTINCT FROM 'ISSUED' OR q_to.replaces_quote_id IS DISTINCT FROM NEW.from_quote_id THEN
    RAISE EXCEPTION 'REPLACEMENT_REFUSED: quote % is not an issued replacement of the paid quote %', NEW.to_quote_id, NEW.from_quote_id USING ERRCODE = 'KP013';
  END IF;
  SELECT p.pre_execution_replacements_included INTO allowance FROM kauro.price_policies p WHERE p.policy_version = q_from.price_policy_version;
  SELECT count(*) INTO used FROM kauro.purchase_rebindings b WHERE b.agency_id = NEW.agency_id AND b.capture_id = NEW.capture_id;
  IF allowance IS NULL OR used >= allowance OR NEW.allowance_ordinal <> used + 1 THEN
    RAISE EXCEPTION 'REPLACEMENT_REFUSED: capture % has used % of its % included source replacements', NEW.capture_id, used, coalesce(allowance, 0) USING ERRCODE = 'KP013';
  END IF;
  SELECT r.revision_id INTO from_revision FROM kauro.dataset_revisions r
   WHERE r.agency_id = NEW.agency_id AND r.project_id = NEW.project_id AND r.manifest_hash = q_from.revision_hash;
  SELECT r.revision_id INTO to_revision FROM kauro.dataset_revisions r
   WHERE r.agency_id = NEW.agency_id AND r.project_id = NEW.project_id AND r.manifest_hash = q_to.revision_hash AND r.state = 'SEALED';
  WITH RECURSIVE chain (revision_id, supersedes, depth) AS (
    SELECT r.revision_id, r.supersedes_revision_id, 0 FROM kauro.dataset_revisions r WHERE r.agency_id = NEW.agency_id AND r.revision_id = to_revision
    UNION ALL
    SELECT r.revision_id, r.supersedes_revision_id, chain.depth + 1
      FROM kauro.dataset_revisions r JOIN chain ON r.agency_id = NEW.agency_id AND r.revision_id = chain.supersedes
     WHERE chain.depth < 64
  )
  SELECT EXISTS (SELECT 1 FROM chain WHERE chain.revision_id = from_revision AND chain.depth > 0) INTO lineage;
  IF from_revision IS NULL OR to_revision IS NULL OR NOT lineage THEN
    RAISE EXCEPTION 'REPLACEMENT_REFUSED: the replacement source of quote % is not a sealed later revision of the replaced source', NEW.to_quote_id USING ERRCODE = 'KP013';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER purchase_rebindings_guard BEFORE INSERT ON kauro.purchase_rebindings FOR EACH ROW EXECUTE FUNCTION kauro.purchase_rebindings_guard();

-- the re-binding is complete at COMMIT: the replaced authorization REVOKED as SOURCE_REPLACED, the replaced quote SUPERSEDED by the
-- replacement, the replacement ACCEPTED_FOR_CHECKOUT, and the replacement's authorization issued for this re-binding (KP013)
CREATE OR REPLACE FUNCTION kauro.purchase_rebindings_complete() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM kauro.commercial_authorizations a
        WHERE a.agency_id = NEW.agency_id AND a.authorization_id = NEW.from_authorization_id AND a.state = 'REVOKED' AND a.revocation_code = 'SOURCE_REPLACED')
     OR NOT EXISTS (
       SELECT 1 FROM kauro.quotes q
        WHERE q.agency_id = NEW.agency_id AND q.quote_id = NEW.from_quote_id AND q.state = 'SUPERSEDED' AND q.superseded_by_quote_id = NEW.to_quote_id)
     OR NOT EXISTS (
       SELECT 1 FROM kauro.quotes q WHERE q.agency_id = NEW.agency_id AND q.quote_id = NEW.to_quote_id AND q.state = 'ACCEPTED_FOR_CHECKOUT')
     OR NOT EXISTS (
       SELECT 1 FROM kauro.commercial_authorizations a
        WHERE a.agency_id = NEW.agency_id AND a.rebinding_id = NEW.rebinding_id AND a.quote_id = NEW.to_quote_id AND a.capture_id = NEW.capture_id) THEN
    RAISE EXCEPTION 'REPLACEMENT_REFUSED: re-binding % is incomplete (revocation, supersession, acceptance and the replacement authorization commit together)', NEW.rebinding_id USING ERRCODE = 'KP013';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER purchase_rebindings_complete AFTER INSERT ON kauro.purchase_rebindings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.purchase_rebindings_complete();

ALTER TABLE kauro.commercial_authorizations ADD CONSTRAINT commercial_authorizations_rebinding_fk
  FOREIGN KEY (agency_id, rebinding_id, capture_id, quote_id) REFERENCES kauro.purchase_rebindings (agency_id, rebinding_id, capture_id, to_quote_id);

-- --- the scope index is bound to what it indexes (B09-F11; the rest of the binding in 0012) ------------------------------------------------
ALTER TABLE kauro.commerce_scopes ADD CONSTRAINT commerce_scopes_order_fk FOREIGN KEY (agency_id, order_id) REFERENCES kauro.payment_orders (agency_id, order_id);
ALTER TABLE kauro.commerce_scopes ADD CONSTRAINT commerce_scopes_capture_fk FOREIGN KEY (agency_id, capture_id, order_id) REFERENCES kauro.capture_facts (agency_id, capture_id, order_id);

-- --- row-level security (the role boundary of B09-F1, D-AUTH-B4) -------------------------------------------------------------------------
-- The agency's request handlers (TENANT) write the checkout intent (CMD028, CMD029 T1/T2) and read the rest; the payment service
-- (SERVICE, one adopted agency) writes what providers report (CMD028/CMD029 settle, the CMD030 application, CMD034, the watchdog),
-- issues and revokes authorizations, and never creates an order; a corporate owner (OPERATOR) reads the finance scope it adopted.
ALTER TABLE kauro.payment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.payment_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_orders_tenant_read ON kauro.payment_orders FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
-- T1: born INTENT_CREATED, with nothing learned from the provider and nothing allocated, never for a replacement quote (a
-- replacement is paid by its re-binding, never charged again; D-QUOTE-B6)
CREATE POLICY payment_orders_tenant_intent ON kauro.payment_orders FOR INSERT TO kauro_app
  WITH CHECK (
    agency_id = kauro.current_agency_id() AND state = 'INTENT_CREATED' AND allocated_cents = 0 AND provider_order_id IS NULL AND provider_approval_url IS NULL
    AND NOT EXISTS (SELECT 1 FROM kauro.quotes q WHERE q.agency_id = payment_orders.agency_id AND q.quote_id = payment_orders.quote_id AND q.replaces_quote_id IS NOT NULL)
  );
-- T2: the claim edges only (INTENT_CREATED -> CREATING; CREATED | APPROVED -> CAPTURING)
CREATE POLICY payment_orders_tenant_claim ON kauro.payment_orders FOR UPDATE TO kauro_app
  USING (agency_id = kauro.current_agency_id() AND state IN ('INTENT_CREATED', 'CREATED', 'APPROVED'))
  WITH CHECK (agency_id = kauro.current_agency_id() AND state IN ('CREATING', 'CAPTURING'));
CREATE POLICY payment_orders_finance_read ON kauro.payment_orders FOR SELECT TO kauro_app USING (kauro.in_finance_scope(agency_id));
CREATE POLICY payment_orders_payment_read ON kauro.payment_orders FOR SELECT TO kauro_payment USING (agency_id = kauro.current_agency_id());
CREATE POLICY payment_orders_payment_update ON kauro.payment_orders FOR UPDATE TO kauro_payment
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.payment_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_attempts_tenant_read ON kauro.payment_attempts FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
-- T1: a CREATE_ORDER or CAPTURE attempt born PREPARED with no result; REFUND attempts are the payment service's (CMD033)
CREATE POLICY payment_attempts_tenant_intent ON kauro.payment_attempts FOR INSERT TO kauro_app
  WITH CHECK (
    agency_id = kauro.current_agency_id() AND state = 'PREPARED' AND operation IN ('CREATE_ORDER', 'CAPTURE') AND refund_id IS NULL
    AND evidence_hash IS NULL AND outcome_code IS NULL AND dispatch_deadline_at IS NULL
  );
-- T2: the claim PREPARED -> DISPATCHING only; every result (PROVIDER_PENDING, CONFIRMED, FAILED_NO_EFFECT, UNCERTAIN,
-- CANCELLED_BEFORE_DISPATCH) is the payment service's
CREATE POLICY payment_attempts_tenant_claim ON kauro.payment_attempts FOR UPDATE TO kauro_app
  USING (agency_id = kauro.current_agency_id() AND state = 'PREPARED' AND operation IN ('CREATE_ORDER', 'CAPTURE'))
  WITH CHECK (agency_id = kauro.current_agency_id() AND state = 'DISPATCHING');
CREATE POLICY payment_attempts_finance_read ON kauro.payment_attempts FOR SELECT TO kauro_app USING (kauro.in_finance_scope(agency_id));
CREATE POLICY payment_attempts_payment ON kauro.payment_attempts FOR ALL TO kauro_payment
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.provider_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.provider_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_observations_tenant_read ON kauro.provider_observations FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY provider_observations_finance_read ON kauro.provider_observations FOR SELECT TO kauro_app USING (kauro.in_finance_scope(agency_id));
CREATE POLICY provider_observations_payment ON kauro.provider_observations FOR ALL TO kauro_payment
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.capture_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.capture_facts FORCE ROW LEVEL SECURITY;
CREATE POLICY capture_facts_tenant_read ON kauro.capture_facts FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY capture_facts_finance_read ON kauro.capture_facts FOR SELECT TO kauro_app USING (kauro.in_finance_scope(agency_id));
CREATE POLICY capture_facts_payment ON kauro.capture_facts FOR ALL TO kauro_payment
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.commercial_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.commercial_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY commercial_authorizations_tenant_read ON kauro.commercial_authorizations FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY commercial_authorizations_finance_read ON kauro.commercial_authorizations FOR SELECT TO kauro_app USING (kauro.in_finance_scope(agency_id));
CREATE POLICY commercial_authorizations_payment_read ON kauro.commercial_authorizations FOR SELECT TO kauro_payment USING (agency_id = kauro.current_agency_id());
CREATE POLICY commercial_authorizations_payment_issue ON kauro.commercial_authorizations FOR INSERT TO kauro_payment
  WITH CHECK (agency_id = kauro.current_agency_id() AND state = 'ACTIVE');
-- the payment service only revokes; consumption and delivery are the processing package's edges (B08; integration obligation)
CREATE POLICY commercial_authorizations_payment_revoke ON kauro.commercial_authorizations FOR UPDATE TO kauro_payment
  USING (agency_id = kauro.current_agency_id() AND state <> 'REVOKED') WITH CHECK (agency_id = kauro.current_agency_id() AND state = 'REVOKED');

ALTER TABLE kauro.purchase_rebindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.purchase_rebindings FORCE ROW LEVEL SECURITY;
CREATE POLICY purchase_rebindings_tenant_read ON kauro.purchase_rebindings FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY purchase_rebindings_finance_read ON kauro.purchase_rebindings FOR SELECT TO kauro_app USING (kauro.in_finance_scope(agency_id));
CREATE POLICY purchase_rebindings_payment ON kauro.purchase_rebindings FOR ALL TO kauro_payment
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

-- the payment service moves a quote only inside a re-binding: the replaced quote to SUPERSEDED, the replacement to
-- ACCEPTED_FOR_CHECKOUT (D-QUOTE-B6); every other quote edge is the agency's (B10's CMD027, CMD028) or the quote lifecycle's
CREATE POLICY quotes_payment_rebinding ON kauro.quotes FOR UPDATE TO kauro_payment
  USING (agency_id = kauro.current_agency_id() AND EXISTS (
    SELECT 1 FROM kauro.purchase_rebindings b WHERE b.agency_id = quotes.agency_id AND (b.from_quote_id = quotes.quote_id OR b.to_quote_id = quotes.quote_id)))
  WITH CHECK (agency_id = kauro.current_agency_id() AND state IN ('SUPERSEDED', 'ACCEPTED_FOR_CHECKOUT'));

-- --- grants (no DELETE for any runtime role) -------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON kauro.payment_orders, kauro.payment_attempts TO kauro_app;
GRANT UPDATE (version, state, updated_at) ON kauro.payment_orders TO kauro_app;
GRANT UPDATE (version, state, dispatch_deadline_at, updated_at) ON kauro.payment_attempts TO kauro_app;
GRANT SELECT ON kauro.provider_observations, kauro.capture_facts, kauro.commercial_authorizations, kauro.purchase_rebindings TO kauro_app;
GRANT SELECT ON kauro.payment_orders TO kauro_payment;
GRANT UPDATE (version, state, provider_order_id, provider_approval_url, allocated_cents, updated_at) ON kauro.payment_orders TO kauro_payment;
GRANT SELECT, INSERT, UPDATE ON kauro.payment_attempts, kauro.capture_facts TO kauro_payment;
GRANT SELECT, INSERT ON kauro.commercial_authorizations, kauro.provider_observations, kauro.purchase_rebindings TO kauro_payment;
GRANT UPDATE (version, state, revoked_at, revocation_phase, revocation_code, updated_at) ON kauro.commercial_authorizations TO kauro_payment;
GRANT UPDATE (version, state, superseded_by_quote_id, updated_at) ON kauro.quotes TO kauro_payment;
