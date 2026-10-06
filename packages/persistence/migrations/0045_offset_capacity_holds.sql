-- Migration 0045: an offset is within the receiving line's unpaid amount LESS its OPEN holds (package B10; adversary ADV-3 of the kit's
-- PR1; decision D10-NEG-2 read with D10-STMT-2 and R2-102).
--
-- 0030's commission_offsets_authorized bounded an offset by the receiving line's unpaid amount and the offsets already against it, and by
-- the negative line's position. composeStatement itemizes the receiving line PAYABLE at `unpaid - OPEN holds` and clips the offset it
-- reports to that remainder (statements.ts: remaining = unpaid - heldOpen; offset = min(offsetIn, remaining)), and the oracle's INV-S-01
-- derives a payable item's cents as cumulative - paid - held - offset, never negative. An offset admitted beyond `unpaid - OPEN holds` was
-- therefore durable, consumed the negative line's position in full (the same trigger subtracts every offset), and was never applied in full
-- by any statement: owner money lost. The guard now subtracts the line's OPEN holds as well (RELEASED and UPHELD holds withhold nothing).
-- A hold opened AFTER the offset is still clipped at the close as before (a hold is bounded by the unpaid amount, not by the offsets).
-- The same named check violation commission_offsets_amount (23514); idempotent (CREATE OR REPLACE); the trigger is 0030's.

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
          - (SELECT coalesce(sum(o.amount_cents), 0) FROM kauro.commission_offsets o WHERE o.against_line_id = NEW.against_line_id)
          - (SELECT coalesce(sum(h.amount_cents), 0) FROM kauro.commission_holds h WHERE h.line_id = NEW.against_line_id AND h.state = 'OPEN') THEN
    RAISE EXCEPTION 'OFFSET: offset of line % against line % exceeds the negative position or the later unpaid amount less its open holds', NEW.negative_line_id, NEW.against_line_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_offsets_amount', SCHEMA = 'kauro', TABLE = 'commission_offsets';
  END IF;
  RETURN NEW;
END
$$;
