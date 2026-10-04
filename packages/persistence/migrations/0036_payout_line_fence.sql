-- Migration 0036: a payout authorizes only cents its lines can pay (package B10, Codex r1 finding B10G-R2; decision D10-GAP-8).
--
-- CMD052 checked the statement's immutable payable total and never the lines behind it: a statement ISSUED again after a FAILED or
-- RETURNED payout (its lines HELD under OPEN PAYOUT_FAILED holds) or a statement whose line took a dispute hold after the close could
-- be approved for the full old payable, held cents included. The rule, at the database: every line a statement itemizes PAYABLE is
-- PAYABLE and carries no OPEN hold the statement does not itself withhold (a hold item of the statement naming it) when an intent of
-- that statement is born.
--
-- Ordering. A line has a transition subject ("kauro.commission_lines", its id): a change of the line's state and a hold opened on it or
-- resolved take the exclusive half; kauro.payout_lines_unpayable takes the shared half of each payable line in ascending id, held to
-- COMMIT, and reads after it. A hold in flight is waited for and read (the approval is refused); a hold arriving after the shared half
-- waits for the approval and is ordered after the intent it did not change (the dispute path, B12). The hold's lock is taken AFTER its
-- INSERT, so after the foreign-key check's key-share lock on the line (RI triggers sort before it): every writer takes the line's row
-- lock first and its transition subject second, as a line UPDATE does (its row lock precedes BEFORE UPDATE triggers), so the order is
-- one and no cycle forms with CMD051's FOR UPDATE of its lines.
--
-- CMD052 calls the function itself after its cash read (design 10 order: statement, cash, intent, line) and refuses 409 STALE_VERSION
-- LEDGER_CHANGED; the BEFORE INSERT trigger on payout_intents repeats it as the backstop (KC018). No SECURITY DEFINER: the function
-- runs as its caller, under the owner's read policies on statement_items, commission_lines and commission_holds. Idempotent.

CREATE OR REPLACE FUNCTION kauro.take_commission_line_lock() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM pg_advisory_xact_lock(kauro.transition_key('kauro.commission_lines', NEW.line_id::text));
  RETURN NULL;
END
$$;

-- The first line of the statement's PAYABLE items that cannot pay (not PAYABLE, or an OPEN hold the statement does not withhold), or
-- NULL; each payable line's shared half is taken first, in ascending id.
CREATE OR REPLACE FUNCTION kauro.payout_lines_unpayable(p_statement_id uuid) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS
$$
DECLARE
  line uuid;
  blocked uuid;
BEGIN
  FOR line IN
    SELECT DISTINCT i.line_id FROM kauro.statement_items i
     WHERE i.statement_id = p_statement_id AND i.disposition = 'PAYABLE' AND i.line_id IS NOT NULL
     ORDER BY i.line_id
  LOOP
    PERFORM kauro.await_transition('kauro.commission_lines', line::text);
  END LOOP;
  SELECT l.line_id INTO blocked
    FROM kauro.commission_lines l
   WHERE l.line_id IN (SELECT i.line_id FROM kauro.statement_items i WHERE i.statement_id = p_statement_id AND i.disposition = 'PAYABLE' AND i.line_id IS NOT NULL)
     AND (l.state <> 'PAYABLE'
          OR EXISTS (SELECT 1 FROM kauro.commission_holds h
                      WHERE h.line_id = l.line_id AND h.state = 'OPEN'
                        AND NOT EXISTS (SELECT 1 FROM kauro.statement_items w WHERE w.statement_id = p_statement_id AND w.hold_id = h.hold_id)))
   ORDER BY l.line_id
   LIMIT 1;
  RETURN blocked;
END
$$;
GRANT EXECUTE ON FUNCTION kauro.payout_lines_unpayable(uuid) TO kauro_app;

CREATE OR REPLACE FUNCTION kauro.payout_intents_lines_payable() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  blocked uuid := kauro.payout_lines_unpayable(NEW.statement_id);
BEGIN
  IF blocked IS NOT NULL THEN
    RAISE EXCEPTION 'PAYOUT_LINES_NOT_PAYABLE: line % of statement % is not PAYABLE or carries an OPEN hold the statement does not withhold', blocked, NEW.statement_id
      USING ERRCODE = 'KC018';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS commission_lines_line_fence ON kauro.commission_lines;
CREATE TRIGGER commission_lines_line_fence BEFORE UPDATE OF state ON kauro.commission_lines
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.take_transition_lock('kauro.commission_lines', 'line_id');
DROP TRIGGER IF EXISTS commission_holds_line_fence ON kauro.commission_holds;
CREATE TRIGGER commission_holds_line_fence AFTER INSERT OR UPDATE OF state ON kauro.commission_holds
  FOR EACH ROW EXECUTE FUNCTION kauro.take_commission_line_lock();
DROP TRIGGER IF EXISTS payout_intents_lines_payable ON kauro.payout_intents;
CREATE TRIGGER payout_intents_lines_payable BEFORE INSERT ON kauro.payout_intents
  FOR EACH ROW EXECUTE FUNCTION kauro.payout_intents_lines_payable();
