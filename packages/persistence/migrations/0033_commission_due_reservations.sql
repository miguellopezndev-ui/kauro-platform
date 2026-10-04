-- Migration 0033: the QUOTE_EXPIRY sweep's work list (package B10, mandate B10-COMMISSION-SERVICE; decision D10-SVC-1).
--
-- The commission service's QUOTE_EXPIRY sweep expires a founding quote past its price expiry and releases its slot, or holds its
-- reservation in RECONCILIATION_HOLD while a payment is in flight (D10-FOUND-4, R2-127). Each reservation is settled in a SERVICE unit
-- of work that adopts the reservation's agency (D10-CTX-1); 0028 lets kauro_commission read a reservation only in the agency it has
-- adopted, so the sweep could never learn which agencies hold reservations that have ended. This adds exactly one read: the live
-- reservations whose end has passed on the server's clock — the sweep's own work, and only while it is work. A live reservation
-- before its end, a consumed or released one, and the holder of a slot (founding_slots.live_agency_id, D10-FOUND-5) stay unreadable.
-- No function, no SECURITY DEFINER, no write and no new grant: kauro_commission already holds SELECT on the table, and every write
-- stays behind founding_slot_reservations_commission_sweep in the adopted agency.
CREATE POLICY founding_slot_reservations_commission_due ON kauro.founding_slot_reservations FOR SELECT TO kauro_commission
  USING (state IN ('RESERVED', 'RECONCILIATION_HOLD') AND ends_at <= kauro.server_now());
