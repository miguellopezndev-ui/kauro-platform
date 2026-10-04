-- Migration 0041: a statement records the lines it was composed from (package B10, Codex r4 finding B10G-R9; decision D10-GAP-16).
--
-- A correction recomposed its statement over the lines the predecessor's items name (D10-GAP-15). composeStatement also counts in the
-- negative balance a debt line that no item names (SIGNED_FUTURE_OFFSET terms suppress its RECOVERY item, its adjustment was reported by
-- an earlier statement, no OFFSET recorded), so the successor lost that balance. The close now records, per statement, the seller's lines
-- of the ledger it composed the statement from (input_line_ids), and a correcting statement carries its predecessor's set unchanged: the
-- successor is recomposed over the same input set. Immutable like the rest of the statement. A statement issued before this migration
-- has the empty set (the correction then uses the lines its items name). Idempotent.

ALTER TABLE kauro.commission_statements ADD COLUMN IF NOT EXISTS input_line_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[];

DROP TRIGGER IF EXISTS commission_statements_immutable ON kauro.commission_statements;
CREATE TRIGGER commission_statements_immutable BEFORE UPDATE ON kauro.commission_statements
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('statement_id,period_id,seller_id,period_starts_at,period_ends_at,calendar_id,calendar_source,statement_date,pay_date,label,accrued_pending_cents,held_cents,payable_cents,paid_to_date_cents,negative_balance_cents,cutoff_hash,corrects_statement_id,input_line_ids,created_at');
