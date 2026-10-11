-- 0055 — Payments V1, lane KIT-2 (structure the red-first test seams of L-INBOUND and L-REFUND stand on; PROVISIONAL, lanes extend it).
--
-- Authority: docs/design/ACH-ROUTE.md r12 D-ACH-19 (treasury_refunds in route scope), the L-INBOUND credit table contract (bank_credits)
-- and the manual-rail timing of DV1-08 (X2 window, NX-LAG coverage lag are ROUTE DATA). It declares STRUCTURE only, like 0045: no guard
-- trigger, no foreign key into a lane's own tables, no grant beyond the payment service. The lanes add their guards, their columns and
-- their widened grants in their own migrations (ALTER, never a second CREATE).
--   * kauro.bank_credits: one observed credit of an account (UNIQUE per bank transaction id), with the order/capture it was applied to;
--   * kauro.treasury_refunds: the route-scope refund of an unassigned credit (excess-only: one amount), keyed by the credit;
--   * kauro.bank_route_versions gains the two timings the manual rail reads from the route version in force.

ALTER TABLE kauro.bank_route_versions
  ADD COLUMN manual_execution_window_ms bigint NOT NULL DEFAULT 14400000 CHECK (manual_execution_window_ms > 0),
  ADD COLUMN coverage_lag_ms            bigint NOT NULL DEFAULT 3600000  CHECK (coverage_lag_ms >= 0);

CREATE TABLE kauro.bank_credits (
  bank_credit_id       uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(bank_credit_id)),
  environment          text NOT NULL CHECK (environment IN ('SANDBOX', 'LIVE')),
  account_ref          text NOT NULL CHECK (kauro.is_provider_ref(account_ref)),
  bank_transaction_id  text NOT NULL CHECK (length(bank_transaction_id) BETWEEN 1 AND 128 AND bank_transaction_id ~ '^[A-Za-z0-9._:-]+$'),
  state                text NOT NULL CHECK (state IN ('DRAFT_MANUAL', 'OBSERVED', 'MATCH_REVIEW', 'MATCHED', 'APPLIED', 'RETURN_REVIEW')),
  version              bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  rail                 text NOT NULL CHECK (rail IN ('ACH', 'DOMESTIC_WIRE')),
  currency             text NOT NULL CHECK (currency = 'USD'),
  gross_cents          bigint NOT NULL CHECK (kauro.is_money(gross_cents) AND gross_cents > 0),
  net_cents            bigint CHECK (net_cents IS NULL OR kauro.is_money(net_cents)),
  fee_cents            bigint CHECK (fee_cents IS NULL OR kauro.is_money(fee_cents)),
  reference            text CHECK (reference IS NULL OR reference ~ '^K[0-9A-HJKMNP-TV-Z]{22}$'),
  booked_at            timestamptz,
  evidence_hash        text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  order_id             uuid,
  capture_id           uuid,
  created_at           timestamptz NOT NULL DEFAULT kauro.server_now(),
  updated_at           timestamptz NOT NULL DEFAULT kauro.server_now(),
  UNIQUE (environment, account_ref, bank_transaction_id),
  CONSTRAINT bank_credits_applied_has_capture CHECK ((state = 'APPLIED') = (order_id IS NOT NULL AND capture_id IS NOT NULL))
);
CREATE TRIGGER bank_credits_touch BEFORE UPDATE ON kauro.bank_credits FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();

CREATE TABLE kauro.treasury_refunds (
  treasury_refund_id  uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(treasury_refund_id)),
  route_id            uuid NOT NULL REFERENCES kauro.bank_routes (route_id),
  environment         text NOT NULL CHECK (environment IN ('SANDBOX', 'LIVE')),
  account_ref         text NOT NULL CHECK (kauro.is_provider_ref(account_ref)),
  bank_credit_id      uuid NOT NULL REFERENCES kauro.bank_credits (bank_credit_id),
  state               text NOT NULL DEFAULT 'REQUESTED' CHECK (state IN ('REQUESTED', 'APPROVED', 'SUBMITTING', 'UNCERTAIN', 'COMPLETED', 'FAILED', 'REJECTED')),
  version             bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- excess-only components (D-ACH-13): the whole requested amount is excess, service and tax are zero by construction
  amount_cents        bigint NOT NULL CHECK (kauro.is_money(amount_cents) AND amount_cents > 0),
  created_at          timestamptz NOT NULL DEFAULT kauro.server_now(),
  updated_at          timestamptz NOT NULL DEFAULT kauro.server_now()
);
CREATE TRIGGER treasury_refunds_touch BEFORE UPDATE ON kauro.treasury_refunds FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE INDEX treasury_refunds_by_credit ON kauro.treasury_refunds (bank_credit_id);

ALTER TABLE kauro.bank_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.bank_credits FORCE ROW LEVEL SECURITY;
ALTER TABLE kauro.treasury_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.treasury_refunds FORCE ROW LEVEL SECURITY;
CREATE POLICY bank_credits_service ON kauro.bank_credits FOR ALL TO kauro_payment USING (true) WITH CHECK (true);
CREATE POLICY treasury_refunds_service ON kauro.treasury_refunds FOR ALL TO kauro_payment USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON kauro.bank_credits, kauro.treasury_refunds TO kauro_payment;
