-- Migration 0057: seller credit is a durable receivable, consumed exactly once (package B10, lane B10-OFFSET, docs/design/B10-OFFSET.md r11:
-- D10-NEG-5, OFF-R1, OFF-R2, OFF-R2-01..03, OFF-R3-01). Provisional number: renumbered at merge when another lane takes it.
--
-- Never edits 0030, 0031 or 0056: it ALTERs and CREATE OR REPLACEs. Idempotent.
--
--   1. The settled-line arithmetic: A_in (now also while the payout is SETTLED and the statement not yet PAID), C_paid, Aout, X.
--   2. seller_credit_entries (append-only: RECOGNIZED +, REVERSED -) and the reconcile function that writes the one difference row.
--   3. Triggers that reconcile under the line's subject: the line's entitlement or state, a hold opened or RELEASED, a statement CORRECTED.
--   4. CREDIT statement items: kind, disposition, the payable-only rule, the insert guard and the deferred bound.
--   5. Payout admission over CREDIT lines (OFF-R2-02).
--   6. commission_offsets_apply_within_allowance (OFF-R2, close and correction only).

-- --- 1. the settled-line arithmetic (pure reads; callers hold the locks) ----------------------------------------------------------------
-- A_in: claims against the line applied by its settled PAYABLE item (cash PAID statement, a SETTLED payout awaiting the statement's PAID
-- edge in the same transaction, or a noncash settlement)
CREATE OR REPLACE FUNCTION kauro.commission_line_applied_in(p_line uuid) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog AS
$$
  SELECT coalesce(sum(i.offset_cents), 0)::bigint
    FROM kauro.statement_items i JOIN kauro.commission_statements s ON s.statement_id = i.statement_id
   WHERE i.line_id = p_line AND i.item_kind = 'LINE' AND i.disposition = 'PAYABLE'
     AND (s.state = 'PAID'
          OR EXISTS (SELECT 1 FROM kauro.commission_noncash_settlements n WHERE n.statement_id = s.statement_id)
          OR EXISTS (SELECT 1 FROM kauro.payout_intents p WHERE p.statement_id = s.statement_id AND p.state = 'SETTLED'))
$$;

-- C_paid: CREDIT cents of the line on PAID statements (cash)
CREATE OR REPLACE FUNCTION kauro.commission_line_credit_paid(p_line uuid) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog AS
$$
  SELECT coalesce(sum(i.payable_cents), 0)::bigint
    FROM kauro.statement_items i JOIN kauro.commission_statements s ON s.statement_id = i.statement_id
   WHERE i.line_id = p_line AND i.item_kind = 'CREDIT' AND s.state = 'PAID'
$$;

-- pos(L) = P + A_in + C_paid - E
CREATE OR REPLACE FUNCTION kauro.commission_line_position(p_line uuid) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog AS
$$
  SELECT (coalesce(l.paid_cents, 0) + kauro.commission_line_applied_in(l.line_id) + kauro.commission_line_credit_paid(l.line_id) - l.cumulative_entitlement_cents)::bigint
    FROM kauro.commission_lines l WHERE l.line_id = p_line
$$;

-- Aout: live claims FROM the line whose receiving line carries a live PAYABLE item (applied or settled), except those against `p_except`
CREATE OR REPLACE FUNCTION kauro.commission_line_applied_out(p_line uuid, p_except uuid[] DEFAULT ARRAY[]::uuid[]) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog AS
$$
  SELECT coalesce(sum(o.amount_cents - coalesce((SELECT sum(r.amount_cents) FROM kauro.commission_offset_releases r WHERE r.offset_id = o.offset_id), 0)), 0)::bigint
    FROM kauro.commission_offsets o
   WHERE o.negative_line_id = p_line
     AND NOT (o.against_line_id = ANY(p_except))
     AND EXISTS (SELECT 1 FROM kauro.statement_items i JOIN kauro.commission_statements s ON s.statement_id = i.statement_id
                  WHERE i.line_id = o.against_line_id AND i.item_kind = 'LINE' AND i.disposition = 'PAYABLE' AND s.state <> 'CORRECTED')
$$;

-- X(L) = E + Aout - P - A_in - H: what a settled line is owed beyond what settled (negative: nothing owed)
CREATE OR REPLACE FUNCTION kauro.commission_line_credit_due(p_line uuid) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog AS
$$
  SELECT (l.cumulative_entitlement_cents + kauro.commission_line_applied_out(l.line_id) - coalesce(l.paid_cents, 0) - kauro.commission_line_applied_in(l.line_id)
          - coalesce((SELECT sum(h.amount_cents) FROM kauro.commission_holds h WHERE h.line_id = l.line_id AND h.state = 'OPEN'), 0))::bigint
    FROM kauro.commission_lines l WHERE l.line_id = p_line
$$;

-- itemized(L): CREDIT cents of the line in statements not CORRECTED (live or PAID)
CREATE OR REPLACE FUNCTION kauro.commission_line_credit_itemized(p_line uuid) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog AS
$$
  SELECT coalesce(sum(i.payable_cents), 0)::bigint
    FROM kauro.statement_items i JOIN kauro.commission_statements s ON s.statement_id = i.statement_id
   WHERE i.line_id = p_line AND i.item_kind = 'CREDIT' AND s.state <> 'CORRECTED'
$$;

-- --- 2. seller_credit_entries and the reconcile function -------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kauro.seller_credit_entries (
  entry_id     uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(entry_id)),
  line_id      uuid NOT NULL,
  seller_id    uuid NOT NULL,
  entry_kind   text NOT NULL CHECK (entry_kind IN ('RECOGNIZED', 'REVERSED')),
  amount_cents bigint NOT NULL CHECK (kauro.is_money(amount_cents) AND amount_cents > 0),
  cause        text NOT NULL CHECK (cause IN ('ENTITLEMENT_CHANGED', 'HOLD_CHANGED', 'LINE_SETTLED', 'CLAIMS_APPLIED', 'APPLICATION_CANCELLED', 'ITEM_CANCELLED')),
  recorded_at  timestamptz NOT NULL,
  created_at   timestamptz NOT NULL,
  CONSTRAINT seller_credit_entries_line_fk FOREIGN KEY (line_id, seller_id) REFERENCES kauro.commission_lines (line_id, seller_id)
);
CREATE INDEX IF NOT EXISTS seller_credit_entries_by_line ON kauro.seller_credit_entries (line_id);

DROP TRIGGER IF EXISTS seller_credit_entries_append_only ON kauro.seller_credit_entries;
CREATE TRIGGER seller_credit_entries_append_only BEFORE UPDATE OR DELETE ON kauro.seller_credit_entries FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
DROP TRIGGER IF EXISTS seller_credit_entries_no_truncate ON kauro.seller_credit_entries;
CREATE TRIGGER seller_credit_entries_no_truncate BEFORE TRUNCATE ON kauro.seller_credit_entries FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
DROP TRIGGER IF EXISTS seller_credit_entries_server_instant ON kauro.seller_credit_entries;
CREATE TRIGGER seller_credit_entries_server_instant BEFORE INSERT ON kauro.seller_credit_entries FOR EACH ROW EXECUTE FUNCTION kauro.require_server_instant('recorded_at');

-- recognized(L) = R - V
CREATE OR REPLACE FUNCTION kauro.commission_line_credit_recognized(p_line uuid) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog AS
$$
  SELECT coalesce(sum(CASE e.entry_kind WHEN 'RECOGNIZED' THEN e.amount_cents ELSE -e.amount_cents END), 0)::bigint
    FROM kauro.seller_credit_entries e WHERE e.line_id = p_line
$$;

-- the target of R - V: a settled line's max(X, itemized); any other line owes nothing
CREATE OR REPLACE FUNCTION kauro.commission_line_credit_target(p_line uuid) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog AS
$$
  SELECT CASE WHEN coalesce(kauro.commission_line_settled(p_line), false)
              THEN greatest(kauro.commission_line_credit_due(p_line), kauro.commission_line_credit_itemized(p_line))
              ELSE 0 END::bigint
$$;

-- BEFORE INSERT: the line's row KEY SHARE (the lock its FK takes later), then its subject, then the read; the row is the difference
CREATE OR REPLACE FUNCTION kauro.seller_credit_entries_reconciled() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  difference bigint;
  expected text;
BEGIN
  PERFORM kauro.commission_lock_line_rows(ARRAY[NEW.line_id], 'KEY SHARE', 'EXCLUSIVE');
  difference := kauro.commission_line_credit_target(NEW.line_id) - kauro.commission_line_credit_recognized(NEW.line_id);
  expected := CASE WHEN difference > 0 THEN 'RECOGNIZED' ELSE 'REVERSED' END;
  IF difference = 0 OR NEW.amount_cents <> abs(difference) OR NEW.entry_kind <> expected THEN
    RAISE EXCEPTION 'SELLER_CREDIT: entry of % cents (%) is not the % difference that reconciles line %', NEW.amount_cents, NEW.entry_kind, difference, NEW.line_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'seller_credit_entries_reconciled', SCHEMA = 'kauro', TABLE = 'seller_credit_entries';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS seller_credit_entries_reconciled ON kauro.seller_credit_entries;
CREATE TRIGGER seller_credit_entries_reconciled BEFORE INSERT ON kauro.seller_credit_entries
  FOR EACH ROW EXECUTE FUNCTION kauro.seller_credit_entries_reconciled();

ALTER TABLE kauro.seller_credit_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.seller_credit_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS seller_credit_entries_owner_read ON kauro.seller_credit_entries;
CREATE POLICY seller_credit_entries_owner_read ON kauro.seller_credit_entries FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
DROP POLICY IF EXISTS seller_credit_entries_seller_read ON kauro.seller_credit_entries;
CREATE POLICY seller_credit_entries_seller_read ON kauro.seller_credit_entries FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());
DROP POLICY IF EXISTS seller_credit_entries_commission ON kauro.seller_credit_entries;
CREATE POLICY seller_credit_entries_commission ON kauro.seller_credit_entries FOR ALL TO kauro_commission USING (true) WITH CHECK (true);
GRANT SELECT ON kauro.seller_credit_entries TO kauro_app;
GRANT SELECT, INSERT ON kauro.seller_credit_entries TO kauro_commission;
-- the owner's hold INSERT and resolution (B12 dispute-hold commands; the kit opens holds as the owner) reconcile in their own COMMIT: only HOLD_CHANGED
GRANT INSERT ON kauro.seller_credit_entries TO kauro_app;
DROP POLICY IF EXISTS seller_credit_entries_owner_hold ON kauro.seller_credit_entries;
CREATE POLICY seller_credit_entries_owner_hold ON kauro.seller_credit_entries FOR INSERT TO kauro_app WITH CHECK (kauro.acting_corporate_owner() AND cause = 'HOLD_CHANGED');

-- Writes the one difference row that brings R - V to max(X, itemized) under the line's subject. A line that is not settled and has no credit
-- or credit item is left alone without a lock. Returns the signed difference written.
CREATE OR REPLACE FUNCTION kauro.seller_credit_reconcile(p_line uuid, p_cause text) RETURNS bigint
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS
$$
DECLARE
  seller uuid;
  difference bigint;
BEGIN
  IF NOT coalesce(kauro.commission_line_settled(p_line), false)
     AND kauro.commission_line_credit_recognized(p_line) = 0 AND kauro.commission_line_credit_itemized(p_line) = 0 THEN
    RETURN 0;
  END IF;
  PERFORM kauro.take_commission_line_subject(p_line, 'EXCLUSIVE');
  SELECT l.seller_id INTO seller FROM kauro.commission_lines l WHERE l.line_id = p_line;
  IF seller IS NULL THEN
    RETURN 0;
  END IF;
  difference := kauro.commission_line_credit_target(p_line) - kauro.commission_line_credit_recognized(p_line);
  IF difference <> 0 THEN
    INSERT INTO kauro.seller_credit_entries (entry_id, line_id, seller_id, entry_kind, amount_cents, cause, recorded_at, created_at)
      VALUES (kauro.new_uuid_v7(), p_line, seller, CASE WHEN difference > 0 THEN 'RECOGNIZED' ELSE 'REVERSED' END, abs(difference), p_cause, kauro.server_now(), now());
  END IF;
  RETURN difference;
END
$$;
REVOKE ALL ON FUNCTION kauro.seller_credit_reconcile(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kauro.seller_credit_reconcile(uuid, text) TO kauro_commission, kauro_app;

-- --- 3. the writers that change X or itemized reconcile in their own COMMIT --------------------------------------------------------------
CREATE OR REPLACE FUNCTION kauro.commission_lines_credit_reconcile() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM kauro.seller_credit_reconcile(NEW.line_id, CASE WHEN NEW.cumulative_entitlement_cents IS DISTINCT FROM OLD.cumulative_entitlement_cents THEN 'ENTITLEMENT_CHANGED' ELSE 'LINE_SETTLED' END);
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS commission_lines_credit_reconcile ON kauro.commission_lines;
CREATE TRIGGER commission_lines_credit_reconcile AFTER UPDATE OF cumulative_entitlement_cents, state ON kauro.commission_lines
  FOR EACH ROW WHEN (NEW.cumulative_entitlement_cents IS DISTINCT FROM OLD.cumulative_entitlement_cents OR NEW.state IS DISTINCT FROM OLD.state)
  EXECUTE FUNCTION kauro.commission_lines_credit_reconcile();

-- a hold OPENED or RELEASED changes H; UPHELD changes it together with the correcting decrease of E (X-B12-1), which reconciles
CREATE OR REPLACE FUNCTION kauro.commission_holds_credit_reconcile() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.state = 'OPEN') OR (TG_OP = 'UPDATE' AND NEW.state = 'RELEASED' AND OLD.state IS DISTINCT FROM 'RELEASED') THEN
    PERFORM kauro.seller_credit_reconcile(NEW.line_id, 'HOLD_CHANGED');
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS commission_holds_credit_reconcile ON kauro.commission_holds;
CREATE TRIGGER commission_holds_credit_reconcile AFTER INSERT OR UPDATE OF state ON kauro.commission_holds
  FOR EACH ROW EXECUTE FUNCTION kauro.commission_holds_credit_reconcile();

-- a statement superseded (CORRECTED) stops itemizing: the credit it carried that is no longer owed is reversed (ITEM_CANCELLED)
CREATE OR REPLACE FUNCTION kauro.commission_statements_credit_cancelled() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  l uuid;
BEGIN
  FOR l IN SELECT DISTINCT i.line_id FROM kauro.statement_items i WHERE i.statement_id = NEW.statement_id AND i.item_kind = 'CREDIT' ORDER BY i.line_id LOOP
    PERFORM kauro.seller_credit_reconcile(l, 'ITEM_CANCELLED');
  END LOOP;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS commission_statements_credit_cancelled ON kauro.commission_statements;
CREATE TRIGGER commission_statements_credit_cancelled AFTER UPDATE OF state ON kauro.commission_statements
  FOR EACH ROW WHEN (NEW.state = 'CORRECTED' AND OLD.state IS DISTINCT FROM 'CORRECTED') EXECUTE FUNCTION kauro.commission_statements_credit_cancelled();

-- --- 4. CREDIT statement items -------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.statement_items DROP CONSTRAINT IF EXISTS statement_items_item_kind_check;
ALTER TABLE kauro.statement_items ADD CONSTRAINT statement_items_item_kind_check CHECK (item_kind IN ('LINE', 'ADJUSTMENT', 'HOLD', 'OFFSET', 'RECOVERY', 'CREDIT'));
ALTER TABLE kauro.statement_items DROP CONSTRAINT IF EXISTS statement_items_disposition_check;
ALTER TABLE kauro.statement_items ADD CONSTRAINT statement_items_disposition_check
  CHECK (disposition IN ('PAYABLE', 'AWAITING_FINAL_COMPLETION', 'AWAITING_FUNDS', 'HELD', 'REPORTED', 'REPAYMENT_REVIEW', 'WRITE_OFF', 'DISPUTE', 'CREDIT'));
ALTER TABLE kauro.statement_items DROP CONSTRAINT IF EXISTS statement_items_kind;
ALTER TABLE kauro.statement_items ADD CONSTRAINT statement_items_kind CHECK (
  (item_kind = 'LINE' AND line_id IS NOT NULL AND disposition IN ('PAYABLE', 'AWAITING_FINAL_COMPLETION', 'AWAITING_FUNDS', 'HELD'))
  OR (item_kind = 'ADJUSTMENT' AND adjustment_id IS NOT NULL AND disposition = 'REPORTED')
  OR (item_kind = 'HOLD' AND hold_id IS NOT NULL AND disposition = 'HELD')
  OR (item_kind = 'OFFSET' AND offset_id IS NOT NULL AND disposition = 'REPORTED')
  OR (item_kind = 'RECOVERY' AND line_id IS NOT NULL AND disposition IN ('REPAYMENT_REVIEW', 'WRITE_OFF', 'DISPUTE'))
  OR (item_kind = 'CREDIT' AND line_id IS NOT NULL AND disposition = 'CREDIT' AND payable_cents > 0)
);
-- payable cents sit on a PAYABLE line item or on a CREDIT item (amends D10-STMT-2)
ALTER TABLE kauro.statement_items DROP CONSTRAINT IF EXISTS statement_items_payable_only_payable_line;
ALTER TABLE kauro.statement_items ADD CONSTRAINT statement_items_payable_only_payable_line
  CHECK (payable_cents = 0 OR (item_kind = 'LINE' AND disposition = 'PAYABLE') OR (item_kind = 'CREDIT' AND disposition = 'CREDIT'));
CREATE UNIQUE INDEX IF NOT EXISTS statement_items_one_credit_item ON kauro.statement_items (statement_id, line_id) WHERE item_kind = 'CREDIT';

-- BEFORE INSERT: the statement row KEY SHARE, then the line's row KEY SHARE (the locks its foreign keys take after the BEFORE triggers), then the line's
-- subject, before any read (OFF-R3-01); the line is settled. The amount bound is deferred: statement_items_credit_within_recognized.
CREATE OR REPLACE FUNCTION kauro.statement_items_credit_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM 1 FROM kauro.commission_statements s WHERE s.statement_id = NEW.statement_id FOR KEY SHARE;
  PERFORM kauro.commission_lock_line_rows(ARRAY[NEW.line_id], 'KEY SHARE', 'EXCLUSIVE');
  IF NOT coalesce(kauro.commission_line_settled(NEW.line_id), false) THEN
    RAISE EXCEPTION 'CREDIT_ITEM: line % is not settled; seller credit is itemized only for a PAID, ADJUSTED or noncash-settled line', NEW.line_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_items_credit_guard', SCHEMA = 'kauro', TABLE = 'statement_items';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS statement_items_credit_guard ON kauro.statement_items;
CREATE TRIGGER statement_items_credit_guard BEFORE INSERT ON kauro.statement_items
  FOR EACH ROW WHEN (NEW.item_kind = 'CREDIT') EXECUTE FUNCTION kauro.statement_items_credit_guard();

-- at COMMIT: what a line's statements not CORRECTED itemize never exceeds what it recognized (OFF-R2-01)
CREATE OR REPLACE FUNCTION kauro.statement_items_credit_within_recognized() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF kauro.commission_line_credit_itemized(NEW.line_id) > kauro.commission_line_credit_recognized(NEW.line_id) THEN
    RAISE EXCEPTION 'CREDIT_ITEM: line % itemizes % cents beyond its % recognized credit', NEW.line_id,
      kauro.commission_line_credit_itemized(NEW.line_id), kauro.commission_line_credit_recognized(NEW.line_id)
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_items_credit_within_recognized', SCHEMA = 'kauro', TABLE = 'statement_items';
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS statement_items_credit_within_recognized ON kauro.statement_items;
CREATE CONSTRAINT TRIGGER statement_items_credit_within_recognized AFTER INSERT ON kauro.statement_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.item_kind = 'CREDIT') EXECUTE FUNCTION kauro.statement_items_credit_within_recognized();

-- --- 5. payout admission over CREDIT lines (OFF-R2-02) -----------------------------------------------------------------------------------
-- A CREDIT line need not be PAYABLE: it blocks on an OPEN hold the statement does not withhold, or on funds that are not AVAILABLE.
CREATE OR REPLACE FUNCTION kauro.payout_lines_blocked(p_statement_id uuid) RETURNS uuid
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS
$$
DECLARE
  blocked uuid;
BEGIN
  SELECT l.line_id INTO blocked
    FROM kauro.commission_lines l
   WHERE l.line_id IN (SELECT i.line_id FROM kauro.statement_items i WHERE i.statement_id = p_statement_id AND i.line_id IS NOT NULL AND (i.disposition = 'PAYABLE' OR i.item_kind = 'CREDIT'))
     AND ((l.line_id IN (SELECT i.line_id FROM kauro.statement_items i WHERE i.statement_id = p_statement_id AND i.disposition = 'PAYABLE' AND i.line_id IS NOT NULL)
           AND (l.state <> 'PAYABLE' OR l.payable_statement_id IS DISTINCT FROM p_statement_id))
          OR EXISTS (SELECT 1 FROM kauro.commission_holds h
                      WHERE h.line_id = l.line_id AND h.state = 'OPEN'
                        AND NOT EXISTS (SELECT 1 FROM kauro.statement_items w WHERE w.statement_id = p_statement_id AND w.hold_id = h.hold_id))
          OR (SELECT o.funds_state FROM kauro.capture_funds_observations o
               WHERE o.agency_id = l.agency_id AND o.capture_id = l.capture_id ORDER BY o.capture_version DESC LIMIT 1) IS DISTINCT FROM 'AVAILABLE')
   ORDER BY l.line_id
   LIMIT 1;
  RETURN blocked;
END
$$;
GRANT EXECUTE ON FUNCTION kauro.payout_lines_blocked(uuid) TO kauro_app, kauro_commission;

CREATE OR REPLACE FUNCTION kauro.payout_lines_unpayable(p_statement_id uuid) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM kauro.commission_lock_line_rows(
    ARRAY(SELECT DISTINCT i.line_id FROM kauro.statement_items i WHERE i.statement_id = p_statement_id AND i.line_id IS NOT NULL AND (i.disposition = 'PAYABLE' OR i.item_kind = 'CREDIT')),
    'KEY SHARE', 'SHARE');
  RETURN kauro.payout_lines_blocked(p_statement_id);
END
$$;
GRANT EXECUTE ON FUNCTION kauro.payout_lines_unpayable(uuid) TO kauro_app, kauro_commission;

-- --- 6. the source position shrink (OFF-R2, close and correction only) ---------------------------------------------------------------
-- Of the claims against `p_receiving` (the lines the transaction applies; the caller holds their subjects) each source N keeps at most
-- allowance(N) = max(0, pos(N) - Aout(N)), Aout excluding the applications this transaction applies or cancels; the excess is released newest
-- first among those claims (POSITION_SHRANK). Returns the cents released.
CREATE OR REPLACE FUNCTION kauro.commission_offsets_apply_within_allowance(p_receiving uuid[], p_cancelling uuid[] DEFAULT ARRAY[]::uuid[]) RETURNS bigint
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS
$$
DECLARE
  n uuid;
  allowance bigint;
  applying bigint;
  remaining bigint;
  released bigint := 0;
  o record;
  take bigint;
BEGIN
  FOR n IN
    SELECT DISTINCT x.negative_line_id FROM kauro.commission_offsets x WHERE x.against_line_id = ANY(p_receiving) ORDER BY 1
  LOOP
    allowance := greatest(0, kauro.commission_line_position(n) - kauro.commission_line_applied_out(n, p_receiving || p_cancelling));
    SELECT coalesce(sum(c.live), 0) INTO applying FROM (
      SELECT x.amount_cents - coalesce((SELECT sum(r.amount_cents) FROM kauro.commission_offset_releases r WHERE r.offset_id = x.offset_id), 0) AS live
        FROM kauro.commission_offsets x WHERE x.negative_line_id = n AND x.against_line_id = ANY(p_receiving)) c;
    remaining := applying - allowance;
    CONTINUE WHEN remaining <= 0;
    FOR o IN
      SELECT x.offset_id, x.seller_id, x.amount_cents - coalesce((SELECT sum(r.amount_cents) FROM kauro.commission_offset_releases r WHERE r.offset_id = x.offset_id), 0) AS live
        FROM kauro.commission_offsets x WHERE x.negative_line_id = n AND x.against_line_id = ANY(p_receiving)
       ORDER BY x.recorded_at DESC, x.offset_id DESC
    LOOP
      EXIT WHEN remaining <= 0;
      CONTINUE WHEN o.live <= 0;
      take := least(o.live, remaining);
      INSERT INTO kauro.commission_offset_releases (release_id, offset_id, seller_id, amount_cents, cause, recorded_at, created_at)
        VALUES (kauro.new_uuid_v7(), o.offset_id, o.seller_id, take, 'POSITION_SHRANK', kauro.server_now(), now());
      remaining := remaining - take;
      released := released + take;
    END LOOP;
  END LOOP;
  RETURN released;
END
$$;
REVOKE ALL ON FUNCTION kauro.commission_offsets_apply_within_allowance(uuid[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kauro.commission_offsets_apply_within_allowance(uuid[], uuid[]) TO kauro_commission;
