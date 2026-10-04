-- Migration 0043: a payout is authorized only over lines whose capture's latest funds observation is AVAILABLE (package B10, lane 5 of the
-- failure-matrix GAPs, Codex r1 B10G5-R1; decision D10-GAP-23).
--
-- A line becomes ELIGIBLE only under funds AVAILABLE (KC007), but the provider can hold the proceeds afterwards and the line machine has no
-- edge from ELIGIBLE or PAYABLE back to HELD. The fence is therefore at the close (the statement itemizes such a line AWAITING_FUNDS, never
-- PAYABLE: composeStatement) and here, at the payout: 0037's payout_lines_unpayable also refuses a statement one of whose PAYABLE lines has a
-- capture whose latest observation is not AVAILABLE (none counts as not available). CMD052 answers the existing 409 STALE_VERSION
-- LEDGER_CHANGED and the intent's birth trigger repeats it (KC018). Idempotent (CREATE OR REPLACE); the grant is 0036's.

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
                        AND NOT EXISTS (SELECT 1 FROM kauro.statement_items w WHERE w.statement_id = p_statement_id AND w.hold_id = h.hold_id))
          OR (SELECT o.funds_state FROM kauro.capture_funds_observations o
               WHERE o.agency_id = l.agency_id AND o.capture_id = l.capture_id ORDER BY o.capture_version DESC LIMIT 1) IS DISTINCT FROM 'AVAILABLE')
   ORDER BY l.line_id
   LIMIT 1;
  RETURN blocked;
END
$$;
