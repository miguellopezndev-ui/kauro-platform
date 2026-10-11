-- PENDING (not a migration yet): takes the next free number after the planned 0053..0059 of SEC-DEPTH-PROVENANCE.md are placed; renumber at merge.
-- 0053 — B09-TAX-ROUNDING: the tax of a refund follows its service. A refund with no service carries no tax (KP012), so a rounding cent
-- left unreturned by a failed booked refund stays with the remaining balance and is returned by the refund that takes the service it
-- belongs to, never forced onto a service-0 refund that would revoke the entitlement while the quote's release guard still holds it.
-- Replaces the function of 0016 (same trigger); the cumulative rule is unchanged for a refund with service.
CREATE OR REPLACE FUNCTION kauro.refunds_commitment_ceiling() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  c record;
  booked record;
  sale record;
  basis_after bigint;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'COMMITMENT_ISOLATION: refund % is approved under READ COMMITTED only, so that its ceiling reads what committed while it waited', OLD.refund_id USING ERRCODE = 'KP009';
  END IF;
  PERFORM kauro.await_transition('kauro.capture_facts', OLD.capture_id::text);
  PERFORM pg_advisory_xact_lock(kauro.transition_key('kauro.capture_refunds', OLD.capture_id::text));
  SELECT f.status, f.allocated_service_cents, f.allocated_tax_cents, f.excess_cents INTO c
    FROM kauro.capture_facts f WHERE f.agency_id = OLD.agency_id AND f.capture_id = OLD.capture_id;
  IF c.status IS DISTINCT FROM 'COMPLETED' THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_REMAINING: capture % is not refundable (%)', OLD.capture_id, coalesce(c.status, 'not visible') USING ERRCODE = 'KP003';
  END IF;
  SELECT coalesce(sum(r.approved_service_cents), 0) AS service, coalesce(sum(r.approved_tax_cents), 0) AS tax, coalesce(sum(r.approved_excess_cents), 0) AS excess INTO booked
    FROM kauro.refunds r
   WHERE r.agency_id = OLD.agency_id AND r.capture_id = OLD.capture_id AND r.refund_id <> OLD.refund_id
     AND r.state IN ('APPROVED', 'SUBMITTING', 'UNCERTAIN', 'COMPLETED');
  IF booked.service + NEW.approved_service_cents > c.allocated_service_cents
     OR booked.tax + NEW.approved_tax_cents > c.allocated_tax_cents
     OR booked.excess + NEW.approved_excess_cents > c.excess_cents THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_REMAINING: refund % exceeds the remaining components of capture %', OLD.refund_id, OLD.capture_id USING ERRCODE = 'KP003';
  END IF;
  SELECT q.tax_rule, q.tax_rate_bps INTO sale
    FROM kauro.payment_orders o JOIN kauro.quotes q ON q.agency_id = o.agency_id AND q.quote_id = o.quote_id
   WHERE o.agency_id = OLD.agency_id AND o.order_id = OLD.order_id;
  basis_after := c.allocated_service_cents - booked.service - NEW.approved_service_cents;
  IF sale.tax_rule IS NULL OR (NEW.approved_service_cents = 0 AND NEW.approved_tax_cents <> 0) OR (NEW.approved_service_cents > 0 AND NEW.approved_tax_cents IS DISTINCT FROM
     c.allocated_tax_cents - kauro.refund_tax_remaining(c.allocated_service_cents, c.allocated_tax_cents, basis_after, sale.tax_rule, sale.tax_rate_bps) - booked.tax) THEN
    RAISE EXCEPTION 'REFUND_TAX_INCONSISTENT: the tax of refund % is not the tax its service releases under the sale''s reviewed rule', OLD.refund_id USING ERRCODE = 'KP012';
  END IF;
  RETURN NEW;
END
$$;
