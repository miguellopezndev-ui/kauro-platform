-- Migration 0039: one live payable item per line, keyed on the statement's liveness (package B10, Codex r2 finding B10G-R1; decision
-- D10-GAP-12).
--
-- 0037's statement_items_one_payable_owner refused a second PAYABLE line item only while the line was PAYABLE through another statement.
-- A FAILED or RETURNED payout moved the line HELD (clearing its owner) and left the old statement ISSUED with its PAYABLE item, so a later
-- statement could itemize the released line PAYABLE again: two live statements itemized the same payable cents. The invariant is now the
-- statement's: a PAYABLE line item is inserted only when no other live statement (any state but CORRECTED) itemizes the line PAYABLE,
-- the statement the new one corrects excepted (it is CORRECTED in the same COMMIT). CMD053 supersedes a statement whose payout FAILED or
-- was RETURNED with its correcting statement in the same COMMIT (the successor itemizes the held lines as held), so the later statement
-- that makes them payable is their one live payable item. Replaces the function of 0037 under the same trigger. Idempotent.

CREATE OR REPLACE FUNCTION kauro.statement_items_one_payable_owner() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  live uuid;
BEGIN
  SELECT i.statement_id INTO live
    FROM kauro.statement_items i JOIN kauro.commission_statements s ON s.statement_id = i.statement_id
   WHERE i.line_id = NEW.line_id AND i.item_kind = 'LINE' AND i.disposition = 'PAYABLE'
     AND i.statement_id <> NEW.statement_id
     AND s.state <> 'CORRECTED'
     AND i.statement_id IS DISTINCT FROM (SELECT c.corrects_statement_id FROM kauro.commission_statements c WHERE c.statement_id = NEW.statement_id)
   LIMIT 1;
  IF live IS NOT NULL THEN
    RAISE EXCEPTION 'PAYABLE_OWNER: line % is itemized payable by the live statement %; statement % cannot itemize it payable', NEW.line_id, live, NEW.statement_id USING ERRCODE = 'KC019';
  END IF;
  RETURN NEW;
END
$$;
