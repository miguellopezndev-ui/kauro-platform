-- Migration 0035: a payout destination change takes its seller's transition lock (package B10, gap closure PAY_DEST_RACE; decision D10-GAP-3).
--
-- CMD052 approves a payout only to the seller's current VERIFIED destination, and a change pending verification refuses the new
-- destination and the old one alike (D10-PAY-3). The payee check and the intent insert are two statements of one transaction; a change
-- committed between them was invisible to the check, so an approval could bind the superseded destination after the seller had
-- already changed it. The seller's rows already have a transition subject ("kauro.sellers", 0001, 0029): a reader takes its shared half
-- (kauro.await_transition) and holds it to COMMIT, a writer of the seller's state takes the exclusive half. A destination change or
-- verification is a change of what the seller may be paid to, so it takes the same exclusive half, here on INSERT and on a change of
-- state (take_transition_lock reads OLD and cannot serve an INSERT). CMD052 reads the seller's current destination after the shared
-- half: the change is ordered before the approval (and refuses it) or after it (and the intent keeps the destination it bound).
-- No SECURITY DEFINER, no grant, no new table.
CREATE OR REPLACE FUNCTION kauro.take_seller_destination_lock() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM pg_advisory_xact_lock(kauro.transition_key('kauro.sellers', NEW.seller_id::text));
  RETURN NEW;
END
$$;

CREATE TRIGGER seller_payout_destinations_seller_lock BEFORE INSERT OR UPDATE OF state ON kauro.seller_payout_destinations
  FOR EACH ROW EXECUTE FUNCTION kauro.take_seller_destination_lock();
