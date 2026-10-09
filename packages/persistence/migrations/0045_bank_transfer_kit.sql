-- 0045 — Payments V1 bank-transfer route, lane KIT (tables and vocabulary only; PROVISIONAL number, renumbered at merge).
--
-- Authority: owner decision 2026-10-07 PAYMENTS-V1 (rail-agnostic, refunds mandatory, NEVER-RESEND, D-24 A) and docs/design/ACH-ROUTE.md
-- r12: DV1-01 (no table, column, enum value or event type names a provider), DV1-02 (manual mode), DV1-08 (execution attempts),
-- DV1-10 (destination proof), DV1-11 (keyed fingerprint, durable execution offers), §7.23 (statement imports), §7.28 (lock order).
--
-- This migration declares STRUCTURE only. It contains no guard trigger, no state-machine seed in kauro.state_machines (that list is pinned
-- by existing persistence tests; the bank machines are mirrored in kauro.bank_machine_edges) and no change to any existing table: each
-- lane (L-ROUTE, L-INBOUND, L-REFUND, L-SETTLE) adds the guards, foreign keys to its own tables and the grants of the actors it writes
-- for, in its own migration. What it fixes for them:
--   * a closed vocabulary table (kauro.bank_vocabulary) mirroring the TypeScript lists, and the edges of the bank machines;
--   * outbound_execution_attempts with the NEVER-RESEND fence (one open attempt per source) and the execution-identity uniqueness L4;
--   * execution_offers and execution_offer_outcomes, append-only by privilege (no UPDATE or DELETE is granted to anyone);
--   * refund_destinations: the approved destination as a KEYED fingerprint with its key id, key version and normalizer version, the masked
--     last digits and the holder name for display, and a reference to the encrypted evidence artifact — never the numbers themselves;
--   * statement_imports, statement_coverage, statement_lines, execution_correlations, bank_source_freezes and bank_review_cases.
-- Route-scope tables carry no tenant column and no tenant policy: only the payment service (kauro_payment) reads and writes them here.
--
-- Lock order (failure-matrix template rule 13; ACH-ROUTE §7.28), declared here for the rows these tables hold:
--   L1 account outbound stream  (transaction advisory lock on (environment, account_ref, OUTBOUND)) -- always first
--   Lc credit identity          (after L1 for SI2; first for C6, P1, G6, attribution)
--   L2 source booking           (row lock FOR NO KEY UPDATE on the source, in source-id order)
--   L3 refund / attempt rows    (FOR NO KEY UPDATE)  <- outbound_execution_attempts is locked here
--   L4 execution identity       (unique index outbound_execution_attempts_identity, across both source scopes)
-- X2 and authorization_lapsed take L3 only. No actor takes L1 while holding L2..L4, a credit lock or a B09 subject lock.

-- --- closed vocabulary and machine edges ------------------------------------------------------------------------------------------------
CREATE TABLE kauro.bank_vocabulary (
  vocabulary text NOT NULL CHECK (vocabulary ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  code       text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  PRIMARY KEY (vocabulary, code)
);
INSERT INTO kauro.bank_vocabulary (vocabulary, code) VALUES
  ('BANK_RAIL', 'ACH'), ('BANK_RAIL', 'DOMESTIC_WIRE'),
  ('BANK_ORDER_STATE', 'AWAITING_TRANSFER'), ('BANK_ORDER_STATE', 'PARTIALLY_RECEIVED'), ('BANK_ORDER_STATE', 'RECEIVED_REVIEW'),
  ('BANK_CREDIT_STATE', 'DRAFT_MANUAL'), ('BANK_CREDIT_STATE', 'OBSERVED'), ('BANK_CREDIT_STATE', 'MATCH_REVIEW'), ('BANK_CREDIT_STATE', 'MATCHED'), ('BANK_CREDIT_STATE', 'APPLIED'), ('BANK_CREDIT_STATE', 'RETURN_REVIEW'),
  ('BANK_CREDIT_SOURCE', 'OWNER_MANUAL'), ('BANK_CREDIT_SOURCE', 'PROVIDER_QUERY'),
  ('BANK_CREDIT_STATUS', 'PENDING'), ('BANK_CREDIT_STATUS', 'COMPLETED'), ('BANK_CREDIT_STATUS', 'DENIED'), ('BANK_CREDIT_STATUS', 'REVERSED'), ('BANK_CREDIT_STATUS', 'UNRECOGNIZED'),
  ('EXECUTION_ATTEMPT_KIND', 'RETURN'), ('EXECUTION_ATTEMPT_KIND', 'RESEND'),
  ('EXECUTION_ATTEMPT_STATE', 'DECLARED'), ('EXECUTION_ATTEMPT_STATE', 'UNCERTAIN'), ('EXECUTION_ATTEMPT_STATE', 'RECORDED'), ('EXECUTION_ATTEMPT_STATE', 'NOT_EXECUTED'),
  ('EXECUTION_SOURCE_KIND', 'CAPTURE'), ('EXECUTION_SOURCE_KIND', 'BANK_CREDIT'),
  ('DESTINATION_PROOF', 'DP_FULL'), ('DESTINATION_PROOF', 'DP_RECIPIENT'),
  ('EXECUTION_OFFER_COMMAND', 'RECORD_RETURN'), ('EXECUTION_OFFER_COMMAND', 'RECORD_RESEND'), ('EXECUTION_OFFER_COMMAND', 'RESOLVE_EXECUTED'),
  ('EXECUTION_GATE_OUTCOME', 'CLASSIFIED'), ('EXECUTION_GATE_OUTCOME', 'UNKNOWN_EVIDENCE'), ('EXECUTION_GATE_OUTCOME', 'MALFORMED_EVIDENCE'), ('EXECUTION_GATE_OUTCOME', 'HASH_MISMATCH'), ('EXECUTION_GATE_OUTCOME', 'UNAUTHENTICATED_EVIDENCE'), ('EXECUTION_GATE_OUTCOME', 'EVIDENCE_UNAVAILABLE'),
  ('DEBIT_CORRELATION', 'CORR_REF'), ('DEBIT_CORRELATION', 'CORR_RECIPIENT'), ('DEBIT_CORRELATION', 'CORR_OFFERED'), ('DEBIT_CORRELATION', 'CORR_DF'),
  ('BANK_CASE_KIND', 'UNCERTAIN_EFFECT'), ('BANK_CASE_KIND', 'DESTINATION_UNPROVEN'), ('BANK_CASE_KIND', 'REFUND_TERMINAL_CONTRADICTED'), ('BANK_CASE_KIND', 'UNDECLARED_OUTBOUND'),
  ('BANK_CASE_KIND', 'POTENTIAL_MATCH_UNRESOLVED'), ('BANK_CASE_KIND', 'RETURN_BOUNCED'), ('BANK_CASE_KIND', 'DOUBLE_RETURN_RISK'), ('BANK_CASE_KIND', 'MATCH_REVIEW'),
  ('BANK_CASE_KIND', 'PROVIDER_TIME_UNVERIFIED'), ('BANK_CASE_KIND', 'RECORD_REQUIRED'),
  ('STATEMENT_LINE_KIND', 'CREDIT'), ('STATEMENT_LINE_KIND', 'DEBIT'),
  ('COVERAGE_STREAM', 'INBOUND'), ('COVERAGE_STREAM', 'OUTBOUND');

-- L1 (and the INBOUND stream's twin): the key of the transaction advisory lock of an account stream, ONE definition for every writer and
-- every test (ACH-ROUTE §7.28): `SELECT pg_advisory_xact_lock(kauro.bank_stream_lock_key(environment, account_ref, 'OUTBOUND'))`. The
-- alphabet of the three parts excludes the separator, so the key text is injective over the triple.
CREATE FUNCTION kauro.bank_stream_lock_key(p_environment text, p_account_ref text, p_stream text) RETURNS bigint
  LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$
BEGIN
  IF p_environment NOT IN ('SANDBOX', 'LIVE') OR p_stream NOT IN ('INBOUND', 'OUTBOUND') OR NOT kauro.is_provider_ref(p_account_ref) THEN
    RAISE EXCEPTION 'BANK_STREAM: no lock key for (%, %, %)', p_environment, p_account_ref, p_stream USING ERRCODE = '22023';
  END IF;
  RETURN hashtextextended('kauro.bank-stream|' || p_environment || '|' || p_account_ref || '|' || p_stream, 0);
END
$$;
GRANT EXECUTE ON FUNCTION kauro.bank_stream_lock_key(text, text, text) TO kauro_app, kauro_payment, kauro_control;

-- the edges of the machines that are not seeded in kauro.state_machines (BANK_STATE_MACHINES, plus the PaymentOrder extension of
-- BANK_ORDER_EXTENSION as machine 'PaymentOrderBank'); a lane's guard trigger reads this table, and the persistence test proves it equal
CREATE TABLE kauro.bank_machine_edges (
  machine    text NOT NULL CHECK (machine ~ '^[A-Za-z][A-Za-z0-9]{2,63}$'),
  from_state text NOT NULL CHECK (from_state ~ '^[A-Z][A-Z_]{1,63}$'),
  to_state   text NOT NULL CHECK (to_state ~ '^[A-Z][A-Z_]{1,63}$'),
  PRIMARY KEY (machine, from_state, to_state)
);
INSERT INTO kauro.bank_machine_edges (machine, from_state, to_state) VALUES
  ('OutboundExecutionAttempt', 'DECLARED', 'UNCERTAIN'),
  ('OutboundExecutionAttempt', 'DECLARED', 'RECORDED'),
  ('OutboundExecutionAttempt', 'DECLARED', 'NOT_EXECUTED'),
  ('OutboundExecutionAttempt', 'UNCERTAIN', 'RECORDED'),
  ('OutboundExecutionAttempt', 'UNCERTAIN', 'NOT_EXECUTED'),
  ('BankCredit', 'DRAFT_MANUAL', 'OBSERVED'),
  ('BankCredit', 'OBSERVED', 'MATCH_REVIEW'),
  ('BankCredit', 'OBSERVED', 'MATCHED'),
  ('BankCredit', 'MATCH_REVIEW', 'MATCHED'),
  ('BankCredit', 'MATCHED', 'MATCH_REVIEW'),
  ('BankCredit', 'MATCHED', 'APPLIED'),
  ('BankCredit', 'MATCH_REVIEW', 'RETURN_REVIEW'),
  ('PaymentOrderBank', 'INTENT_CREATED', 'AWAITING_TRANSFER'),
  ('PaymentOrderBank', 'AWAITING_TRANSFER', 'PARTIALLY_RECEIVED'),
  ('PaymentOrderBank', 'AWAITING_TRANSFER', 'CAPTURED'),
  ('PaymentOrderBank', 'AWAITING_TRANSFER', 'RECEIVED_REVIEW'),
  ('PaymentOrderBank', 'AWAITING_TRANSFER', 'EXPIRED'),
  ('PaymentOrderBank', 'PARTIALLY_RECEIVED', 'PARTIALLY_RECEIVED'),
  ('PaymentOrderBank', 'PARTIALLY_RECEIVED', 'RECEIVED_REVIEW'),
  ('PaymentOrderBank', 'PARTIALLY_RECEIVED', 'EXPIRED'),
  ('PaymentOrderBank', 'EXPIRED', 'CAPTURED');

-- --- outbound execution attempts (DV1-08) -----------------------------------------------------------------------------------------------
-- One V1 outbound movement of route money: kind RETURN (a refund or treasury refund) or RESEND (re-send of a bounced return). Frozen at
-- declaration: kind, source, refund or parent bounce, amount, currency, declared_at (the database clock), the destination fingerprint with
-- its key id, key version and normalizer version, and the reference `kauro-refund-<refundId>-<n>`. The source is a closed union: CAPTURE
-- (agency scope, an existing refunds row) or BANK_CREDIT (route scope; the treasury refund and the credit are tables of lane L-REFUND and
-- L-INBOUND, whose migrations add those foreign keys).
CREATE TABLE kauro.outbound_execution_attempts (
  attempt_id           uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(attempt_id)),
  environment          text NOT NULL CHECK (environment IN ('SANDBOX', 'LIVE')),
  account_ref          text NOT NULL CHECK (kauro.is_provider_ref(account_ref)),
  kind                 text NOT NULL CHECK (kind IN ('RETURN', 'RESEND')),
  state                text NOT NULL DEFAULT 'DECLARED' CHECK (state IN ('DECLARED', 'UNCERTAIN', 'RECORDED', 'NOT_EXECUTED')),
  version              bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  source_kind          text NOT NULL CHECK (source_kind IN ('CAPTURE', 'BANK_CREDIT')),
  agency_id            uuid,
  capture_id           uuid,
  refund_id            uuid,
  bank_credit_id       uuid,
  treasury_refund_id   uuid,
  parent_bounce_id     uuid,
  -- the identity of the source whatever its scope: the NEVER-RESEND fence and the L2 lock key
  source_id            uuid GENERATED ALWAYS AS (CASE WHEN source_kind = 'CAPTURE' THEN capture_id ELSE bank_credit_id END) STORED NOT NULL,
  attempt_number       integer NOT NULL CHECK (attempt_number >= 1),
  reference            text NOT NULL CHECK (reference ~ '^kauro-refund-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9]{1,9}$'),
  amount_cents         bigint NOT NULL CHECK (kauro.is_money(amount_cents) AND amount_cents > 0),
  currency             text NOT NULL CHECK (currency = 'USD'),
  declared_at          timestamptz NOT NULL DEFAULT kauro.server_now(),
  declared_by          uuid NOT NULL,
  -- the keyed destination fingerprint, frozen at declaration; comparable only under the same four values (DV1-11)
  destination_fingerprint text NOT NULL CHECK (kauro.is_sha256_hex(destination_fingerprint)),
  fingerprint_key_id      text NOT NULL CHECK (fingerprint_key_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  fingerprint_key_version integer NOT NULL CHECK (fingerprint_key_version >= 1),
  fingerprint_norm_version text NOT NULL CHECK (fingerprint_norm_version ~ '^[a-z0-9-]{1,64}$'),
  -- DP-RECIPIENT binding: the provider's recipient record and its version, bound at declaration
  recipient_ref        text CHECK (recipient_ref IS NULL OR kauro.is_provider_ref(recipient_ref)),
  recipient_version    text CHECK (recipient_version IS NULL OR kauro.is_provider_ref(recipient_version)),
  -- what the record carries once RECORDED
  bank_execution_id    text CHECK (bank_execution_id IS NULL OR kauro.is_provider_ref(bank_execution_id)),
  destination_proof    text CHECK (destination_proof IN ('DP_FULL', 'DP_RECIPIENT')),
  evidence_hash        text CHECK (evidence_hash IS NULL OR kauro.is_sha256_hex(evidence_hash)),
  recorded_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbound_attempts_source_union CHECK (
    (source_kind = 'CAPTURE' AND agency_id IS NOT NULL AND capture_id IS NOT NULL AND refund_id IS NOT NULL AND bank_credit_id IS NULL AND treasury_refund_id IS NULL)
    OR (source_kind = 'BANK_CREDIT' AND bank_credit_id IS NOT NULL AND treasury_refund_id IS NOT NULL AND agency_id IS NULL AND capture_id IS NULL AND refund_id IS NULL)
  ),
  CONSTRAINT outbound_attempts_kind_parent CHECK ((kind = 'RESEND') = (parent_bounce_id IS NOT NULL)),
  CONSTRAINT outbound_attempts_recipient_version CHECK (recipient_version IS NULL OR recipient_ref IS NOT NULL),
  CONSTRAINT outbound_attempts_recorded_footprint CHECK (
    (state = 'RECORDED' AND bank_execution_id IS NOT NULL AND destination_proof IS NOT NULL AND evidence_hash IS NOT NULL AND recorded_at IS NOT NULL)
    OR (state <> 'RECORDED' AND bank_execution_id IS NULL AND destination_proof IS NULL AND evidence_hash IS NULL AND recorded_at IS NULL)
  ),
  CONSTRAINT outbound_attempts_refund_fk FOREIGN KEY (agency_id, refund_id, capture_id) REFERENCES kauro.refunds (agency_id, refund_id, capture_id),
  UNIQUE (reference),
  UNIQUE (attempt_id, source_kind, source_id)
);
-- the NEVER-RESEND fence: at most one attempt per source is DECLARED or UNCERTAIN (DV1-08); a new one exists only after the previous is
-- RECORDED and then bounced, or NOT_EXECUTED
CREATE UNIQUE INDEX outbound_execution_attempts_one_open ON kauro.outbound_execution_attempts (source_kind, source_id) WHERE state IN ('DECLARED', 'UNCERTAIN');
-- L4: one execution identity per account and environment across both source scopes (an id is used once)
CREATE UNIQUE INDEX outbound_execution_attempts_identity ON kauro.outbound_execution_attempts (environment, account_ref, bank_execution_id) WHERE bank_execution_id IS NOT NULL;
-- attempt numbers are dense per refund source: n = the attempt number of that refund (1 for its RETURN)
CREATE UNIQUE INDEX outbound_execution_attempts_number ON kauro.outbound_execution_attempts (source_kind, source_id, attempt_number);
-- X2: the sweep finds declared attempts past their window
CREATE INDEX outbound_execution_attempts_declared ON kauro.outbound_execution_attempts (declared_at) WHERE state = 'DECLARED';

-- --- the approved destination (DV1-10, DV1-11): keyed fingerprint, never plaintext ---------------------------------------------------------
-- Captured once at approval (F2) from the restricted destination evidence. Only the encrypted artifact reference, the keyed fingerprint and
-- the masked display fields are stored; the full routing and account numbers are never persisted in clear, displayed again or put in an event.
CREATE TABLE kauro.refund_destinations (
  destination_id       uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(destination_id)),
  environment          text NOT NULL CHECK (environment IN ('SANDBOX', 'LIVE')),
  source_kind          text NOT NULL CHECK (source_kind IN ('CAPTURE', 'BANK_CREDIT')),
  agency_id            uuid,
  refund_id            uuid,
  treasury_refund_id   uuid,
  evidence_artifact_ref text NOT NULL CHECK (kauro.is_provider_ref(evidence_artifact_ref)),
  evidence_hash        text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  destination_fingerprint text NOT NULL CHECK (kauro.is_sha256_hex(destination_fingerprint)),
  fingerprint_key_id      text NOT NULL CHECK (fingerprint_key_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  fingerprint_key_version integer NOT NULL CHECK (fingerprint_key_version >= 1),
  fingerprint_norm_version text NOT NULL CHECK (fingerprint_norm_version ~ '^[a-z0-9-]{1,64}$'),
  account_last4        text NOT NULL CHECK (account_last4 ~ '^[0-9]{1,4}$'),
  holder_name          text NOT NULL CHECK (length(holder_name) BETWEEN 1 AND 140),
  captured_by          uuid NOT NULL,
  captured_at          timestamptz NOT NULL DEFAULT kauro.server_now(),
  CONSTRAINT refund_destinations_source_union CHECK (
    (source_kind = 'CAPTURE' AND agency_id IS NOT NULL AND refund_id IS NOT NULL AND treasury_refund_id IS NULL)
    OR (source_kind = 'BANK_CREDIT' AND treasury_refund_id IS NOT NULL AND agency_id IS NULL AND refund_id IS NULL)
  ),
  CONSTRAINT refund_destinations_refund_fk FOREIGN KEY (agency_id, refund_id) REFERENCES kauro.refunds (agency_id, refund_id)
);
CREATE UNIQUE INDEX refund_destinations_one_per_refund ON kauro.refund_destinations (refund_id) WHERE refund_id IS NOT NULL;
CREATE UNIQUE INDEX refund_destinations_one_per_treasury_refund ON kauro.refund_destinations (treasury_refund_id) WHERE treasury_refund_id IS NOT NULL;

-- --- durable execution offers (DV1-11; CORR-OFFERED) --------------------------------------------------------------------------------------
-- Every G2, G4 and X3-EXECUTED request inserts one offer in its own committed transaction BEFORE the evidence is read; the outcome row
-- records what the gate and the predicates decided. Both are append-only: no UPDATE or DELETE is granted to any role, and a lane's
-- trigger refuses them for the owner too. X3 NOT_EXECUTED is refused when any offer row exists for the attempt (lane L-REFUND).
CREATE TABLE kauro.execution_offers (
  offer_id             uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(offer_id)),
  attempt_id           uuid NOT NULL REFERENCES kauro.outbound_execution_attempts (attempt_id),
  command              text NOT NULL CHECK (command IN ('RECORD_RETURN', 'RECORD_RESEND', 'RESOLVE_EXECUTED')),
  idempotency_key      text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  requested_artifact_ref text NOT NULL CHECK (kauro.is_provider_ref(requested_artifact_ref)),
  expected_evidence_hash text NOT NULL CHECK (kauro.is_sha256_hex(expected_evidence_hash)),
  actor_user_id        uuid NOT NULL,
  offered_at           timestamptz NOT NULL DEFAULT kauro.server_now(),
  UNIQUE (attempt_id, command, idempotency_key)
);
CREATE INDEX execution_offers_by_attempt ON kauro.execution_offers (attempt_id);

CREATE TABLE kauro.execution_offer_outcomes (
  outcome_id           uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(outcome_id)),
  offer_id             uuid NOT NULL UNIQUE REFERENCES kauro.execution_offers (offer_id),
  gate_outcome         text NOT NULL CHECK (gate_outcome IN ('CLASSIFIED', 'UNKNOWN_EVIDENCE', 'MALFORMED_EVIDENCE', 'HASH_MISMATCH', 'UNAUTHENTICATED_EVIDENCE', 'EVIDENCE_UNAVAILABLE')),
  bank_execution_id    text CHECK (bank_execution_id IS NULL OR kauro.is_provider_ref(bank_execution_id)),
  outcome_code         text NOT NULL CHECK (kauro.is_token(outcome_code)),
  footprint            text NOT NULL CHECK (footprint IN ('RECORDED', 'REVIEW')),
  review_case_kind     text CHECK (review_case_kind IN ('UNCERTAIN_EFFECT', 'DESTINATION_UNPROVEN', 'REFUND_TERMINAL_CONTRADICTED', 'UNDECLARED_OUTBOUND', 'POTENTIAL_MATCH_UNRESOLVED', 'RETURN_BOUNCED', 'DOUBLE_RETURN_RISK', 'MATCH_REVIEW', 'PROVIDER_TIME_UNVERIFIED', 'RECORD_REQUIRED')),
  decided_at           timestamptz NOT NULL DEFAULT kauro.server_now(),
  CONSTRAINT execution_offer_outcomes_execution_id_classified CHECK (bank_execution_id IS NULL OR gate_outcome = 'CLASSIFIED'),
  CONSTRAINT execution_offer_outcomes_footprint CHECK ((footprint = 'REVIEW') = (review_case_kind IS NOT NULL)),
  CONSTRAINT execution_offer_outcomes_recorded_classified CHECK (footprint <> 'RECORDED' OR (gate_outcome = 'CLASSIFIED' AND bank_execution_id IS NOT NULL))
);

-- --- owner statement import (DV1-02, §7.23 SI2) -------------------------------------------------------------------------------------------
CREATE TABLE kauro.statement_imports (
  import_id            uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(import_id)),
  environment          text NOT NULL CHECK (environment IN ('SANDBOX', 'LIVE')),
  account_ref          text NOT NULL CHECK (kauro.is_provider_ref(account_ref)),
  artifact_ref         text NOT NULL CHECK (kauro.is_provider_ref(artifact_ref)),
  evidence_hash        text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  normalizer_version   text NOT NULL CHECK (normalizer_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  idempotency_key      text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  imported_by          uuid NOT NULL,
  imported_at          timestamptz NOT NULL DEFAULT kauro.server_now(),
  UNIQUE (environment, account_ref, idempotency_key)
);
-- an artifact is one import: the same bytes under another key replay nothing and conflict
CREATE UNIQUE INDEX statement_imports_one_per_artifact ON kauro.statement_imports (environment, account_ref, evidence_hash);

-- coverage is per stream: completing one never covers the other (§6.1); a coverage interval is [from, to] with to not after the import
CREATE TABLE kauro.statement_coverage (
  import_id            uuid NOT NULL REFERENCES kauro.statement_imports (import_id),
  stream               text NOT NULL CHECK (stream IN ('INBOUND', 'OUTBOUND')),
  covered_from         timestamptz NOT NULL,
  covered_to           timestamptz NOT NULL,
  PRIMARY KEY (import_id, stream),
  CHECK (covered_from < covered_to)
);

-- the lines an import carries, by the bank's own line identity; an identical line seen again adds nothing. Only digests, last digits and
-- provider references of the destination are kept (DestinationEvidence.full is never persisted).
CREATE TABLE kauro.statement_lines (
  line_id              uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(line_id)),
  import_id            uuid NOT NULL REFERENCES kauro.statement_imports (import_id),
  environment          text NOT NULL CHECK (environment IN ('SANDBOX', 'LIVE')),
  account_ref          text NOT NULL CHECK (kauro.is_provider_ref(account_ref)),
  line_kind            text NOT NULL CHECK (line_kind IN ('CREDIT', 'DEBIT')),
  bank_line_id         text NOT NULL CHECK (kauro.is_provider_ref(bank_line_id)),
  bank_execution_id    text CHECK (bank_execution_id IS NULL OR kauro.is_provider_ref(bank_execution_id)),
  -- unknown is null, never zero (D-ACH-12)
  amount_cents         bigint CHECK (amount_cents IS NULL OR kauro.is_money(amount_cents)),
  fee_cents            bigint CHECK (fee_cents IS NULL OR kauro.is_money(fee_cents)),
  currency             text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reference            text CHECK (reference IS NULL OR length(reference) BETWEEN 1 AND 256),
  status               text NOT NULL CHECK (status ~ '^[A-Z][A-Z_]{1,31}$'),
  executed_at          timestamptz,
  booked_at            timestamptz,
  observed_at          timestamptz NOT NULL,
  destination_account_digest text CHECK (destination_account_digest IS NULL OR kauro.is_sha256_hex(destination_account_digest)),
  destination_account_last4  text CHECK (destination_account_last4 IS NULL OR destination_account_last4 ~ '^[0-9]{1,4}$'),
  destination_routing_digest text CHECK (destination_routing_digest IS NULL OR kauro.is_sha256_hex(destination_routing_digest)),
  recipient_ref        text CHECK (recipient_ref IS NULL OR kauro.is_provider_ref(recipient_ref)),
  recipient_version    text CHECK (recipient_version IS NULL OR kauro.is_provider_ref(recipient_version)),
  evidence_hash        text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  -- a debit linked to the RECORDED attempt that explains it (SI2 links only by bank execution id)
  linked_attempt_id    uuid REFERENCES kauro.outbound_execution_attempts (attempt_id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT statement_lines_debit_only_execution CHECK (line_kind = 'DEBIT' OR (bank_execution_id IS NULL AND linked_attempt_id IS NULL)),
  CONSTRAINT statement_lines_debit_amount CHECK (line_kind = 'CREDIT' OR amount_cents IS NOT NULL),
  UNIQUE (environment, account_ref, line_kind, bank_line_id)
);
CREATE UNIQUE INDEX statement_lines_one_link_per_attempt ON kauro.statement_lines (linked_attempt_id) WHERE linked_attempt_id IS NOT NULL;
CREATE INDEX statement_lines_by_execution ON kauro.statement_lines (environment, account_ref, bank_execution_id) WHERE bank_execution_id IS NOT NULL;
CREATE INDEX statement_lines_by_import ON kauro.statement_lines (import_id);

-- --- correlation records (DV1-10: correlation overrides every exclusion) -----------------------------------------------------------------
-- A debit is CORRELATED with an attempt by any of CORR-REF, CORR-RECIPIENT, CORR-OFFERED or CORR-DF; a correlated debit blocks
-- NOT_EXECUTED whatever its currency, destination or links. Append-only.
CREATE TABLE kauro.execution_correlations (
  correlation_id       uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(correlation_id)),
  line_id              uuid NOT NULL REFERENCES kauro.statement_lines (line_id),
  attempt_id           uuid NOT NULL REFERENCES kauro.outbound_execution_attempts (attempt_id),
  correlation          text NOT NULL CHECK (correlation IN ('CORR_REF', 'CORR_RECIPIENT', 'CORR_OFFERED', 'CORR_DF')),
  recorded_at          timestamptz NOT NULL DEFAULT kauro.server_now(),
  UNIQUE (line_id, attempt_id, correlation)
);
CREATE INDEX execution_correlations_by_attempt ON kauro.execution_correlations (attempt_id);

-- --- source freezes and route-scope review cases ---------------------------------------------------------------------------------------
-- An unexplained or correlated debit executed before any declaration, or an offer on a NOT_EXECUTED attempt, freezes every open refund of
-- its source: X1/X4 refuse EXECUTION_FROZEN and `authorization_lapsed` skips the refund. Resolution is LATER 2026-11-30 (FC-G5).
CREATE TABLE kauro.bank_source_freezes (
  freeze_id            uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(freeze_id)),
  environment          text NOT NULL CHECK (environment IN ('SANDBOX', 'LIVE')),
  account_ref          text NOT NULL CHECK (kauro.is_provider_ref(account_ref)),
  source_kind          text NOT NULL CHECK (source_kind IN ('CAPTURE', 'BANK_CREDIT')),
  source_id            uuid NOT NULL,
  reason               text NOT NULL CHECK (reason IN ('UNDECLARED_OUTBOUND', 'REFUND_TERMINAL_CONTRADICTED')),
  frozen_at            timestamptz NOT NULL DEFAULT kauro.server_now(),
  UNIQUE (source_kind, source_id, reason)
);

-- A review case of route scope (no agency). The agency-scope reconciliation_cases keep their own kinds; these are the kinds of
-- BANK_CASE_KINDS, opened by the lane that owns the step. One open case per kind and subject.
CREATE TABLE kauro.bank_review_cases (
  case_id              uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(case_id)),
  kind                 text NOT NULL CHECK (kind IN ('UNCERTAIN_EFFECT', 'DESTINATION_UNPROVEN', 'REFUND_TERMINAL_CONTRADICTED', 'UNDECLARED_OUTBOUND', 'POTENTIAL_MATCH_UNRESOLVED', 'RETURN_BOUNCED', 'DOUBLE_RETURN_RISK', 'MATCH_REVIEW', 'PROVIDER_TIME_UNVERIFIED', 'RECORD_REQUIRED')),
  state                text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'RESOLVED')),
  environment          text NOT NULL CHECK (environment IN ('SANDBOX', 'LIVE')),
  account_ref          text NOT NULL CHECK (kauro.is_provider_ref(account_ref)),
  attempt_id           uuid REFERENCES kauro.outbound_execution_attempts (attempt_id),
  line_id              uuid REFERENCES kauro.statement_lines (line_id),
  source_kind          text CHECK (source_kind IN ('CAPTURE', 'BANK_CREDIT')),
  source_id            uuid,
  detail_code          text NOT NULL CHECK (kauro.is_token(detail_code)),
  evidence_hash        text CHECK (evidence_hash IS NULL OR kauro.is_sha256_hex(evidence_hash)),
  opened_at            timestamptz NOT NULL DEFAULT kauro.server_now(),
  resolved_at          timestamptz,
  CONSTRAINT bank_review_cases_source_pair CHECK ((source_kind IS NULL) = (source_id IS NULL)),
  CONSTRAINT bank_review_cases_resolved CHECK ((state = 'RESOLVED') = (resolved_at IS NOT NULL)),
  CONSTRAINT bank_review_cases_has_subject CHECK (attempt_id IS NOT NULL OR line_id IS NOT NULL OR source_id IS NOT NULL)
);
CREATE UNIQUE INDEX bank_review_cases_one_open ON kauro.bank_review_cases (
  kind, environment, account_ref,
  coalesce(attempt_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(line_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(source_id, '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE state = 'OPEN';

-- --- access: the payment service only (lanes widen it for the owner commands they add) ---------------------------------------------------
ALTER TABLE kauro.bank_vocabulary ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.bank_vocabulary FORCE ROW LEVEL SECURITY;
ALTER TABLE kauro.bank_machine_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.bank_machine_edges FORCE ROW LEVEL SECURITY;
CREATE POLICY bank_vocabulary_read ON kauro.bank_vocabulary FOR SELECT TO kauro_app, kauro_payment, kauro_control USING (true);
CREATE POLICY bank_machine_edges_read ON kauro.bank_machine_edges FOR SELECT TO kauro_app, kauro_payment, kauro_control USING (true);
GRANT SELECT ON kauro.bank_vocabulary, kauro.bank_machine_edges TO kauro_app, kauro_payment, kauro_control;

-- append-only tables: INSERT and SELECT only
ALTER TABLE kauro.execution_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.execution_offers FORCE ROW LEVEL SECURITY;
ALTER TABLE kauro.execution_offer_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.execution_offer_outcomes FORCE ROW LEVEL SECURITY;
ALTER TABLE kauro.refund_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.refund_destinations FORCE ROW LEVEL SECURITY;
ALTER TABLE kauro.statement_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.statement_imports FORCE ROW LEVEL SECURITY;
ALTER TABLE kauro.statement_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.statement_coverage FORCE ROW LEVEL SECURITY;
ALTER TABLE kauro.execution_correlations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.execution_correlations FORCE ROW LEVEL SECURITY;
ALTER TABLE kauro.bank_source_freezes ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.bank_source_freezes FORCE ROW LEVEL SECURITY;
CREATE POLICY execution_offers_service ON kauro.execution_offers FOR ALL TO kauro_payment USING (true) WITH CHECK (true);
CREATE POLICY execution_offer_outcomes_service ON kauro.execution_offer_outcomes FOR ALL TO kauro_payment USING (true) WITH CHECK (true);
CREATE POLICY refund_destinations_service ON kauro.refund_destinations FOR ALL TO kauro_payment USING (true) WITH CHECK (true);
CREATE POLICY statement_imports_service ON kauro.statement_imports FOR ALL TO kauro_payment USING (true) WITH CHECK (true);
CREATE POLICY statement_coverage_service ON kauro.statement_coverage FOR ALL TO kauro_payment USING (true) WITH CHECK (true);
CREATE POLICY execution_correlations_service ON kauro.execution_correlations FOR ALL TO kauro_payment USING (true) WITH CHECK (true);
CREATE POLICY bank_source_freezes_service ON kauro.bank_source_freezes FOR ALL TO kauro_payment USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON kauro.execution_offers, kauro.execution_offer_outcomes, kauro.refund_destinations, kauro.statement_imports, kauro.statement_coverage,
  kauro.execution_correlations, kauro.bank_source_freezes TO kauro_payment;

-- mutable tables (state, version, linked attempt, case resolution)
ALTER TABLE kauro.outbound_execution_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.outbound_execution_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE kauro.statement_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.statement_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE kauro.bank_review_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.bank_review_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY outbound_execution_attempts_service ON kauro.outbound_execution_attempts FOR ALL TO kauro_payment USING (true) WITH CHECK (true);
CREATE POLICY statement_lines_service ON kauro.statement_lines FOR ALL TO kauro_payment USING (true) WITH CHECK (true);
CREATE POLICY bank_review_cases_service ON kauro.bank_review_cases FOR ALL TO kauro_payment USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON kauro.outbound_execution_attempts, kauro.statement_lines, kauro.bank_review_cases TO kauro_payment;
