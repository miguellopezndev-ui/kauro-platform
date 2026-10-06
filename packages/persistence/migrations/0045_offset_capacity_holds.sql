-- Migration 0045: an offset is admitted only where a statement applies it, within the receiving line's unpaid amount LESS its OPEN holds,
-- and every writer of either side of that capacity reads it under one lock (package B10; adversary ADV-3, ADV-9, ADV-10 of the kit's
-- PR1; decisions D10-NEG-2 read with D10-STMT-2 and R2-102, and D10-NEG-3).
--
-- The capacity invariant: the offsets against a receiving line never exceed its unpaid amount less its OPEN holds, on a line a statement
-- will apply them to. composeStatement applies an offset only to an ELIGIBLE line (statements.ts: remaining = unpaid - heldOpen;
-- offset = min(offsetIn, remaining)); a PAYABLE or VOID line is not itemized again, an ACCRUED_PENDING or HELD line is itemized without
-- one. An offset admitted beyond the capacity, or against a line in any other state, was durable, consumed the negative line's position
-- in full (the same trigger subtracts every offset), and was never applied in full by any statement: owner money lost.
--
-- The writers of the two sides are an offset (commission_offsets INSERT) and a hold (commission_holds INSERT). Both take the line's row
-- lock and then its transition subject ("kauro.commission_lines", its id), the order 0036 set for every line writer (D10-GAP-8): the
-- offset guard takes FOR KEY SHARE on its negative and receiving lines (the strength its foreign keys take anyway, so it never blocks a
-- writer those keys did not) and then the subjects of both, in ascending line id; a hold takes its key-share lock through its foreign key
-- and the subject in commission_holds_line_fence (0036, AFTER INSERT). Each then reads the capacity in a statement of its own, after the
-- lock, so it sees what the other committed while it waited (READ COMMITTED: a new snapshot per statement). Two offsets that fit alone,
-- or an offset and a hold, never both commit.
--
-- D10-NEG-3: a hold on an ELIGIBLE line that would leave the offsets against it beyond unpaid less OPEN holds is refused
-- (commission_holds_offset_room, 23514): the offset cents are already the negative position's. A line in any other state is not checked:
-- PAYOUT_FAILED holds the whole unpaid amount of a PAYABLE line whose statement already applied its offsets, FUNDS_HELD an
-- ACCRUED_PENDING line, which carries none.
--
-- RELEASED and UPHELD holds withhold nothing (an UPHELD decision posts an AGREED_ERROR_CORRECTION decrease instead). Every predicate is
-- its own test (the never-paid negative line, the receiving line's state, each capacity), so removing any one is seen. Refusals: KC017
-- (no signed terms, 0030), the named check violations commission_offsets_amount, commission_offsets_applicable and
-- commission_holds_offset_room (23514). Idempotent (CREATE OR REPLACE, DROP TRIGGER IF EXISTS); 0030's offset trigger is kept.

CREATE OR REPLACE FUNCTION kauro.commission_offsets_authorized() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  negative record;
  against record;
  terms record;
  line uuid;
BEGIN
  -- the lines' row locks first, then their transition subjects, ascending (0036 order); every read below is after them
  PERFORM 1 FROM kauro.commission_lines l WHERE l.line_id IN (NEW.negative_line_id, NEW.against_line_id) ORDER BY l.line_id FOR KEY SHARE OF l;
  FOR line IN SELECT DISTINCT x FROM unnest(ARRAY[NEW.negative_line_id, NEW.against_line_id]) AS x ORDER BY x LOOP
    PERFORM pg_advisory_xact_lock(kauro.transition_key('kauro.commission_lines', line::text));
  END LOOP;

  SELECT l.cumulative_entitlement_cents, l.paid_cents, e.agreement_id INTO negative
    FROM kauro.commission_lines l JOIN kauro.commission_entitlements e ON e.entitlement_id = l.entitlement_id WHERE l.line_id = NEW.negative_line_id;
  SELECT g.offset_terms, g.signed_at INTO terms FROM kauro.seller_agreements g WHERE g.seller_id = NEW.seller_id AND g.agreement_id = NEW.agreement_id;
  IF NEW.agreement_id IS DISTINCT FROM negative.agreement_id OR terms.offset_terms IS DISTINCT FROM 'SIGNED_FUTURE_OFFSET' OR terms.signed_at IS NULL THEN
    RAISE EXCEPTION 'OFFSET_NOT_AUTHORIZED: seller % has no signed future-offset terms for line %', NEW.seller_id, NEW.negative_line_id USING ERRCODE = 'KC017';
  END IF;

  -- a line never paid has no negative position
  IF negative.paid_cents IS NULL THEN
    RAISE EXCEPTION 'OFFSET: line % was never paid and has no negative position to offset', NEW.negative_line_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_offsets_amount', SCHEMA = 'kauro', TABLE = 'commission_offsets';
  END IF;
  -- within the negative position left after the line's earlier offsets
  IF NEW.amount_cents > negative.paid_cents - negative.cumulative_entitlement_cents
       - (SELECT coalesce(sum(o.amount_cents), 0) FROM kauro.commission_offsets o WHERE o.negative_line_id = NEW.negative_line_id) THEN
    RAISE EXCEPTION 'OFFSET: offset of line % against line % exceeds the negative position', NEW.negative_line_id, NEW.against_line_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_offsets_amount', SCHEMA = 'kauro', TABLE = 'commission_offsets';
  END IF;

  SELECT l.state, l.cumulative_entitlement_cents, l.paid_cents INTO against FROM kauro.commission_lines l WHERE l.line_id = NEW.against_line_id;
  -- only an ELIGIBLE line is one a statement applies an offset to
  IF against.state IS DISTINCT FROM 'ELIGIBLE' THEN
    RAISE EXCEPTION 'OFFSET: line % is % and no statement applies an offset to it', NEW.against_line_id, coalesce(against.state, '(not visible)')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_offsets_applicable', SCHEMA = 'kauro', TABLE = 'commission_offsets';
  END IF;
  -- within the later line's unpaid amount less its OPEN holds and the offsets already against it
  IF NEW.amount_cents > against.cumulative_entitlement_cents - coalesce(against.paid_cents, 0)
       - (SELECT coalesce(sum(o.amount_cents), 0) FROM kauro.commission_offsets o WHERE o.against_line_id = NEW.against_line_id)
       - (SELECT coalesce(sum(h.amount_cents), 0) FROM kauro.commission_holds h WHERE h.line_id = NEW.against_line_id AND h.state = 'OPEN') THEN
    RAISE EXCEPTION 'OFFSET: offset of line % against line % exceeds the later unpaid amount less its open holds', NEW.negative_line_id, NEW.against_line_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_offsets_amount', SCHEMA = 'kauro', TABLE = 'commission_offsets';
  END IF;
  RETURN NEW;
END
$$;

-- The hold side (D10-NEG-3): after commission_holds_line_fence took the line's subject (AFTER triggers fire in name order:
-- line_fence < offset_room), an OPEN hold on an ELIGIBLE line leaves the offsets against it within its unpaid amount less its OPEN holds,
-- this one included.
CREATE OR REPLACE FUNCTION kauro.commission_holds_offset_room() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  room bigint;
BEGIN
  SELECT l.cumulative_entitlement_cents - coalesce(l.paid_cents, 0)
         - (SELECT coalesce(sum(h.amount_cents), 0) FROM kauro.commission_holds h WHERE h.line_id = l.line_id AND h.state = 'OPEN')
         - (SELECT coalesce(sum(o.amount_cents), 0) FROM kauro.commission_offsets o WHERE o.against_line_id = l.line_id)
    INTO room
    FROM kauro.commission_lines l WHERE l.line_id = NEW.line_id AND l.state = 'ELIGIBLE';
  IF room < 0 THEN
    RAISE EXCEPTION 'HOLD: a hold of % on line % leaves its offsets beyond its unpaid amount less its open holds', NEW.amount_cents, NEW.line_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_holds_offset_room', SCHEMA = 'kauro', TABLE = 'commission_holds';
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS commission_holds_offset_room ON kauro.commission_holds;
CREATE TRIGGER commission_holds_offset_room AFTER INSERT ON kauro.commission_holds
  FOR EACH ROW WHEN (NEW.state = 'OPEN') EXECUTE FUNCTION kauro.commission_holds_offset_room();
