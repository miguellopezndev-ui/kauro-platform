-- Migration 0034: the journal, the inputs check and the statement calendar read of the commission group's own commands (package B10, mandate
-- B10-STATEMENTS-PAYOUTS; decision D10-STMT-4).
--
-- CloseCommissionPeriod (CMD051, the commission service) and ReconcileCommissionPayout (CMD053, the finance service) are commands of the
-- two services of kauro_commission: each is idempotent by its journal entry (10 "trusted system actor, agency, operation, key"), and a
-- statement or a payout is corporate, so the entry names no agency. 0006 lets kauro_app journal a person's commands and 0013 kauro_payment
-- the payment service's in the agency it adopted; kauro_commission had no journal at all. This adds exactly the commission group's own
-- entries: actor SERVICE, one of its two identities, no agency.
--
-- CMD051 closes a period only when no COMMISSIONS outbox record that occurred before the period's end is still undelivered
-- (INPUTS_UNRECONCILED). 0005 lets kauro_control read the outbox and the request handlers their tenant's records; the commission service
-- could not see whether its own consumer's inputs were delivered. This adds one read: the COMMISSIONS records, and of them only the
-- columns the check needs (no payload: an outbox record carries none; the event stays behind domain_events' policies).
--
-- No function, no SECURITY DEFINER (08 "Database isolation"), no DELETE, no write beyond the journal.
CREATE POLICY command_journal_commission ON kauro.command_journal FOR ALL TO kauro_commission
  USING (agency_id IS NULL AND actor_kind = 'SERVICE' AND actor_id IN ('commission-service', 'finance-service'))
  WITH CHECK (agency_id IS NULL AND actor_kind = 'SERVICE' AND actor_id IN ('commission-service', 'finance-service'));
GRANT SELECT, INSERT, UPDATE ON kauro.command_journal TO kauro_commission;

CREATE POLICY outbox_records_commission_inputs ON kauro.outbox_records FOR SELECT TO kauro_commission USING (consumer = 'COMMISSIONS');
GRANT SELECT (outbox_id, consumer, state, created_at) ON kauro.outbox_records TO kauro_commission;

-- GetCommissionStatement answers a seller the calendar version its own statement was dated by (D10-API-1, D10-CAL-1). A banking calendar
-- is no secret, but a seller's session read none: this adds the versions of the statements the session can read (its own, 0031).
CREATE POLICY banking_calendars_statement_read ON kauro.banking_calendars FOR SELECT TO kauro_app
  USING (EXISTS (SELECT 1 FROM kauro.commission_statements s WHERE s.calendar_id = banking_calendars.calendar_id));
