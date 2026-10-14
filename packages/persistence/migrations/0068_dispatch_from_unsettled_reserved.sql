-- Migration 0068: a dispatch leaves RESERVED only while no settlement names it (package B05 L1v; moved out of 0061, which is
-- immutable once merged; provisional number, renumbered at merge).
--
-- Into DISPATCHING only from a RESERVED row no settlement names yet, DISPATCHING -> DISPATCHING included (D5-18 edge guard; a
-- reservation its core RELEASED unsent stays RESERVED, S09, and is never sent).
CREATE OR REPLACE FUNCTION kauro.request_journal_dispatch_from_reserved() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  RAISE EXCEPTION 'JOURNAL: request % enters DISPATCHING from an unsettled RESERVED only (it is %, settlement %)', OLD.request_id, OLD.state, coalesce(OLD.settlement_state, 'none') USING ERRCODE = 'KA007';
END
$$;
REVOKE EXECUTE ON FUNCTION kauro.request_journal_dispatch_from_reserved() FROM PUBLIC;
DROP TRIGGER IF EXISTS request_journal_dispatch_from_reserved ON kauro.request_journal;
CREATE TRIGGER request_journal_dispatch_from_reserved BEFORE UPDATE OF state ON kauro.request_journal
  FOR EACH ROW WHEN (NEW.state = 'DISPATCHING' AND (OLD.state IS DISTINCT FROM 'RESERVED' OR OLD.settlement_state IS NOT NULL)) EXECUTE FUNCTION kauro.request_journal_dispatch_from_reserved();
