-- Migration 0037: one live payable item per line (package B10, Codex r1 finding B10G-R1; decision D10-GAP-9).
--
-- A correcting statement re-itemized every PAYABLE line of its predecessor as payable, including a line the predecessor itemized only
-- as pending or held that a later period's statement had since made PAYABLE: two live statements then carried the same payable cents
-- and both could be approved. The rule "a line is payable through exactly one live statement item" (D10-STMT-2) becomes a database
-- invariant:
--  * commission_lines.payable_statement_id names the statement through whose PAYABLE item the line is payable (kept once it is PAID,
--    cleared when it leaves PAYABLE otherwise). Entering PAYABLE it names an ISSUED statement of the line's seller with the line's
--    PAYABLE item (the writer names it; left empty, the newest such statement is taken), checked at COMMIT by the existing
--    commission_lines_payable_through_statement (23514), which now checks that very statement.
--  * while the line stays PAYABLE its owner moves only to the statement that corrects the owner (KC019).
--  * a PAYABLE line item is inserted only for a line that is not PAYABLE through another statement: a PAYABLE line's item belongs to its
--    owner's correcting statement and to no other (KC019).
--  * a payout authorizes only lines its statement owns (kauro.payout_lines_unpayable, 0036, now also compares the owner).
-- FORCE RLS hides the rows from the migration role, so nothing is backfilled: no line is PAYABLE before B10 is released. Idempotent.

ALTER TABLE kauro.commission_lines ADD COLUMN IF NOT EXISTS payable_statement_id uuid REFERENCES kauro.commission_statements (statement_id);
GRANT UPDATE (payable_statement_id) ON kauro.commission_lines TO kauro_commission;

CREATE OR REPLACE FUNCTION kauro.commission_lines_payable_owner() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.state = 'PAYABLE' AND OLD.state IS DISTINCT FROM 'PAYABLE' THEN
    -- statement_closed: the writer names the statement; left empty, the newest ISSUED statement with the line's PAYABLE item
    IF NEW.payable_statement_id IS NULL THEN
      SELECT s.statement_id INTO NEW.payable_statement_id
        FROM kauro.statement_items i JOIN kauro.commission_statements s ON s.statement_id = i.statement_id
       WHERE i.line_id = NEW.line_id AND i.item_kind = 'LINE' AND i.disposition = 'PAYABLE' AND s.seller_id = NEW.seller_id AND s.state = 'ISSUED'
       ORDER BY s.issued_at DESC, s.statement_id DESC LIMIT 1;
    END IF;
  ELSIF NEW.state = 'PAYABLE' THEN
    -- a PAYABLE line's owner moves only to the statement correcting it, which itemizes the line PAYABLE
    IF NEW.payable_statement_id IS DISTINCT FROM OLD.payable_statement_id AND NOT EXISTS (
      SELECT 1 FROM kauro.commission_statements s JOIN kauro.statement_items i ON i.statement_id = s.statement_id
       WHERE s.statement_id = NEW.payable_statement_id AND s.corrects_statement_id = OLD.payable_statement_id AND s.state = 'ISSUED'
         AND i.line_id = NEW.line_id AND i.item_kind = 'LINE' AND i.disposition = 'PAYABLE'
    ) THEN
      RAISE EXCEPTION 'PAYABLE_OWNER: line % is payable through statement %; only its correcting statement takes it over', NEW.line_id, OLD.payable_statement_id USING ERRCODE = 'KC019';
    END IF;
  ELSIF NEW.state = 'PAID' THEN
    NEW.payable_statement_id := OLD.payable_statement_id;
  ELSE
    NEW.payable_statement_id := NULL;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS commission_lines_payable_owner ON kauro.commission_lines;
CREATE TRIGGER commission_lines_payable_owner BEFORE UPDATE OF state, payable_statement_id ON kauro.commission_lines
  FOR EACH ROW EXECUTE FUNCTION kauro.commission_lines_payable_owner();

-- statement_closed, at COMMIT (same name as 0031): the owner is an ISSUED (or later) statement of the line's seller with its PAYABLE item.
CREATE OR REPLACE FUNCTION kauro.commission_lines_payable_through_statement() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.commission_lines l JOIN kauro.statement_items i ON i.statement_id = l.payable_statement_id
      JOIN kauro.commission_statements s ON s.statement_id = i.statement_id
     WHERE l.line_id = NEW.line_id AND i.line_id = NEW.line_id AND i.item_kind = 'LINE' AND i.disposition = 'PAYABLE' AND s.seller_id = NEW.seller_id
       AND s.state IN ('ISSUED', 'APPROVED', 'PAID')
  ) THEN
    RAISE EXCEPTION 'LINE_PAYABLE: line % becomes PAYABLE only through an ISSUED statement item naming it', NEW.line_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_lines_payable_through_statement', SCHEMA = 'kauro', TABLE = 'commission_lines';
  END IF;
  RETURN NULL;
END
$$;

-- a PAYABLE line item only for a line not payable through another statement (its owner's correcting statement excepted)
CREATE OR REPLACE FUNCTION kauro.statement_items_one_payable_owner() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF EXISTS (
    SELECT 1 FROM kauro.commission_lines l
     WHERE l.line_id = NEW.line_id AND l.state = 'PAYABLE'
       AND l.payable_statement_id IS DISTINCT FROM NEW.statement_id
       AND l.payable_statement_id IS DISTINCT FROM (SELECT s.corrects_statement_id FROM kauro.commission_statements s WHERE s.statement_id = NEW.statement_id)
  ) THEN
    RAISE EXCEPTION 'PAYABLE_OWNER: line % is payable through another live statement; statement % cannot itemize it payable', NEW.line_id, NEW.statement_id USING ERRCODE = 'KC019';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS statement_items_one_payable_owner ON kauro.statement_items;
CREATE TRIGGER statement_items_one_payable_owner BEFORE INSERT ON kauro.statement_items
  FOR EACH ROW WHEN (NEW.item_kind = 'LINE' AND NEW.disposition = 'PAYABLE') EXECUTE FUNCTION kauro.statement_items_one_payable_owner();

-- 0036's payout fence, now also refusing a line the statement does not own
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
          OR l.payable_statement_id IS DISTINCT FROM p_statement_id
          OR EXISTS (SELECT 1 FROM kauro.commission_holds h
                      WHERE h.line_id = l.line_id AND h.state = 'OPEN'
                        AND NOT EXISTS (SELECT 1 FROM kauro.statement_items w WHERE w.statement_id = p_statement_id AND w.hold_id = h.hold_id)))
   ORDER BY l.line_id
   LIMIT 1;
  RETURN blocked;
END
$$;
