-- Migration 0093 — SEC hygiene of the migrations merged by batches B..D (order 4: the verification that never ran on them).
--
-- Four invariants of the catalogue census (tests sec-forall-policy, sec-policy-relations, sec-depth-provenance) were broken by migrations
-- written after the lanes that introduced them, because those merges were never verified green:
--   1. OWNER-POLICY-FORALL (0078): 0080 created six policies FOR ALL for kauro_payment, which holds no UPDATE and no DELETE (command_journal: no
--      DELETE) on their tables. Each becomes one policy per command the role holds, with the predicate of the FOR ALL policy, exactly as 0078
--      did: <name>_read FOR SELECT, <name>_record FOR INSERT, <name>_amend FOR UPDATE. Behaviour is unchanged for every granted command.
--   2. RLS-POLICY-NAMES-RELATION (0074): 0080's command_journal_bank_owner named kauro.bank_owner_acts and 0083's
--      stage_receipt_reconciliations_tenant_open named kauro.memberships, so every plan of those tables locked the other relation. The lookups
--      move into STABLE SECURITY INVOKER functions (each reads through the caller's own policies, exactly as the inline subquery did).
--   3. SEC-DEPTH (R17): 0092's two trigger functions are executable by PUBLIC; a trigger function needs no EXECUTE at firing time.
-- Idempotent.

-- --- 1+2. command_journal_bank_owner: per command, the bank_owner_acts lookup in a function -----------------------------------------------
CREATE OR REPLACE FUNCTION kauro.bank_owner_acting(p_actor_id text) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS
$$
BEGIN
  IF p_actor_id IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM kauro.bank_owner_acts a WHERE a.txid = pg_catalog.txid_current() AND a.user_id::text = p_actor_id);
END
$$;
REVOKE ALL ON FUNCTION kauro.bank_owner_acting(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kauro.bank_owner_acting(text) TO kauro_payment;

DROP POLICY IF EXISTS command_journal_bank_owner ON kauro.command_journal;
DROP POLICY IF EXISTS command_journal_bank_owner_read ON kauro.command_journal;
DROP POLICY IF EXISTS command_journal_bank_owner_record ON kauro.command_journal;
DROP POLICY IF EXISTS command_journal_bank_owner_amend ON kauro.command_journal;
CREATE POLICY command_journal_bank_owner_read ON kauro.command_journal FOR SELECT TO kauro_payment
  USING (actor_kind = 'USER' AND agency_id IS NULL AND operation IN ('CMD032', 'CMD220', 'CMD221', 'CMD222', 'CMD223', 'CMD224', 'CMD225', 'CMD226', 'CMD227', 'CMD228', 'CMD229')
         AND kauro.bank_owner_acting(actor_id));
CREATE POLICY command_journal_bank_owner_record ON kauro.command_journal FOR INSERT TO kauro_payment
  WITH CHECK (actor_kind = 'USER' AND agency_id IS NULL AND operation IN ('CMD032', 'CMD220', 'CMD221', 'CMD222', 'CMD223', 'CMD224', 'CMD225', 'CMD226', 'CMD227', 'CMD228', 'CMD229')
         AND kauro.bank_owner_acting(actor_id));
CREATE POLICY command_journal_bank_owner_amend ON kauro.command_journal FOR UPDATE TO kauro_payment
  USING (actor_kind = 'USER' AND agency_id IS NULL AND operation IN ('CMD032', 'CMD220', 'CMD221', 'CMD222', 'CMD223', 'CMD224', 'CMD225', 'CMD226', 'CMD227', 'CMD228', 'CMD229')
         AND kauro.bank_owner_acting(actor_id))
  WITH CHECK (actor_kind = 'USER' AND agency_id IS NULL AND operation IN ('CMD032', 'CMD220', 'CMD221', 'CMD222', 'CMD223', 'CMD224', 'CMD225', 'CMD226', 'CMD227', 'CMD228', 'CMD229')
         AND kauro.bank_owner_acting(actor_id));

-- --- 1. the payment service's treasury refund events and records (SELECT, INSERT) -------------------------------------------------------
DROP POLICY IF EXISTS domain_events_payment_treasury ON kauro.domain_events;
DROP POLICY IF EXISTS domain_events_payment_treasury_read ON kauro.domain_events;
DROP POLICY IF EXISTS domain_events_payment_treasury_record ON kauro.domain_events;
CREATE POLICY domain_events_payment_treasury_read ON kauro.domain_events FOR SELECT TO kauro_payment
  USING (agency_id IS NULL AND aggregate_kind = 'treasury_refund');
CREATE POLICY domain_events_payment_treasury_record ON kauro.domain_events FOR INSERT TO kauro_payment
  WITH CHECK (agency_id IS NULL AND aggregate_kind = 'treasury_refund' AND split_part(event_type, '.', 1) = 'treasury_refund');

DROP POLICY IF EXISTS outbox_records_payment_treasury ON kauro.outbox_records;
DROP POLICY IF EXISTS outbox_records_payment_treasury_read ON kauro.outbox_records;
DROP POLICY IF EXISTS outbox_records_payment_treasury_record ON kauro.outbox_records;
CREATE POLICY outbox_records_payment_treasury_read ON kauro.outbox_records FOR SELECT TO kauro_payment
  USING (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id IS NULL AND e.aggregate_kind = 'treasury_refund'));
CREATE POLICY outbox_records_payment_treasury_record ON kauro.outbox_records FOR INSERT TO kauro_payment
  WITH CHECK (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id IS NULL AND e.aggregate_kind = 'treasury_refund'));

-- --- 1. the payment service's outbound attempt events and records (SELECT, INSERT) ------------------------------------------------------
DROP POLICY IF EXISTS domain_events_payment_outbound ON kauro.domain_events;
DROP POLICY IF EXISTS domain_events_payment_outbound_read ON kauro.domain_events;
DROP POLICY IF EXISTS domain_events_payment_outbound_record ON kauro.domain_events;
CREATE POLICY domain_events_payment_outbound_read ON kauro.domain_events FOR SELECT TO kauro_payment
  USING (aggregate_kind = 'outbound_execution_attempt' AND (agency_id IS NULL OR agency_id = kauro.current_agency_id()));
CREATE POLICY domain_events_payment_outbound_record ON kauro.domain_events FOR INSERT TO kauro_payment
  WITH CHECK (aggregate_kind = 'outbound_execution_attempt' AND (agency_id IS NULL OR agency_id = kauro.current_agency_id()) AND split_part(event_type, '.', 1) = 'outbound');

DROP POLICY IF EXISTS outbox_records_payment_outbound ON kauro.outbox_records;
DROP POLICY IF EXISTS outbox_records_payment_outbound_read ON kauro.outbox_records;
DROP POLICY IF EXISTS outbox_records_payment_outbound_record ON kauro.outbox_records;
CREATE POLICY outbox_records_payment_outbound_read ON kauro.outbox_records FOR SELECT TO kauro_payment
  USING (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.aggregate_kind = 'outbound_execution_attempt' AND (e.agency_id IS NULL OR e.agency_id = kauro.current_agency_id())));
CREATE POLICY outbox_records_payment_outbound_record ON kauro.outbox_records FOR INSERT TO kauro_payment
  WITH CHECK (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.aggregate_kind = 'outbound_execution_attempt' AND (e.agency_id IS NULL OR e.agency_id = kauro.current_agency_id())));

-- --- 1. the return bounces (SELECT, INSERT; append-only by trigger) --------------------------------------------------------------------
DROP POLICY IF EXISTS outbound_return_bounces_service ON kauro.outbound_return_bounces;
DROP POLICY IF EXISTS outbound_return_bounces_service_read ON kauro.outbound_return_bounces;
DROP POLICY IF EXISTS outbound_return_bounces_service_record ON kauro.outbound_return_bounces;
CREATE POLICY outbound_return_bounces_service_read ON kauro.outbound_return_bounces FOR SELECT TO kauro_payment USING (true);
CREATE POLICY outbound_return_bounces_service_record ON kauro.outbound_return_bounces FOR INSERT TO kauro_payment WITH CHECK (true);

-- --- 2. stage_receipt_reconciliations_tenant_open: the membership lookup in a function ---------------------------------------------------
CREATE OR REPLACE FUNCTION kauro.acting_operator_membership(p_agency uuid, p_membership uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS
$$
BEGIN
  IF kauro.current_user_id() IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM kauro.memberships m
     WHERE m.agency_id = p_agency AND m.membership_id = p_membership
       AND m.user_id = kauro.current_user_id() AND m.state = 'ACTIVE' AND m.role IN ('OWNER', 'ADMIN', 'OPERATOR'));
END
$$;
REVOKE ALL ON FUNCTION kauro.acting_operator_membership(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kauro.acting_operator_membership(uuid, uuid) TO kauro_app;

DROP POLICY IF EXISTS stage_receipt_reconciliations_tenant_open ON kauro.stage_receipt_reconciliations;
CREATE POLICY stage_receipt_reconciliations_tenant_open ON kauro.stage_receipt_reconciliations FOR INSERT TO kauro_app
  WITH CHECK (agency_id = kauro.current_agency_id() AND kauro.acting_operator_membership(agency_id, opened_by_membership_id));

-- --- 3. trigger functions are not executable by PUBLIC ---------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION kauro.seller_payout_destinations_verification_proof() FROM PUBLIC;
REVOKE ALL ON FUNCTION kauro.seller_payout_destinations_step_up_at_commit() FROM PUBLIC;

-- --- 4. the owner authority of 0080 reads the corporate grants as the migration owner -----------------------------------------------------
-- kauro.bank_owner_authority (0080, SECURITY DEFINER, owned by kauro_owner) reads kauro.corporate_roles under FORCE ROW LEVEL SECURITY. On its
-- own branch 0080 ran before the hardening of 0077, which re-targeted the only read policy of the grants (0046 corporate_roles_register_bank_read)
-- from kauro_owner to kauro_route_registrar; merged after it, the definer saw no grant and answered CORPORATE_ROLE_MISSING to every owner
-- (all of Payments V1's F1/F2/G1..G4 commands). 0080's own reads of identities and proofs name CURRENT_USER; the grants get the same, read only.
DROP POLICY IF EXISTS corporate_roles_bank_owner_read ON kauro.corporate_roles;
CREATE POLICY corporate_roles_bank_owner_read ON kauro.corporate_roles FOR SELECT TO CURRENT_USER USING (true);

-- --- 5. a follow-up is judged on an outreach business instant too (plan A10, GAP-SE-20) ---------------------------------------------------
-- 0088 admits a first contact only on an outreach business instant and judges a follow-up by its window alone ([first + 5 business days, first +
-- 14 days)); the plan's cell GAP-SE-20 refuses "a Saturday follow-up inside its window too" (D-B12O-6a: never looser than any reading). The same
-- calendar answers at CMD063 (the intent's insert) and at the claim (D2's re-stamp): KC037 outside the covered years, KC032 OUTSIDE_BUSINESS_DAY.
CREATE OR REPLACE FUNCTION kauro.outreach_send_intents_followup_calendar() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  judged timestamptz := kauro.effect_now();
  b boolean := kauro.outreach_business_instant(kauro.effect_now());
BEGIN
  IF b IS NULL THEN
    RAISE EXCEPTION 'OUTREACH_CALENDAR_UNAVAILABLE: no calendar row for %', judged USING ERRCODE = 'KC037';
  END IF;
  IF NOT b THEN
    RAISE EXCEPTION 'OUTREACH_CAP_REACHED: OUTSIDE_BUSINESS_DAY at %', judged USING ERRCODE = 'KC032';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION kauro.outreach_send_intents_followup_calendar() FROM PUBLIC;
DROP TRIGGER IF EXISTS outreach_send_intents_c_followup_calendar ON kauro.outreach_send_intents;
CREATE TRIGGER outreach_send_intents_c_followup_calendar BEFORE INSERT ON kauro.outreach_send_intents
  FOR EACH ROW WHEN (NEW.purpose = 'FOLLOW_UP') EXECUTE FUNCTION kauro.outreach_send_intents_followup_calendar();
DROP TRIGGER IF EXISTS outreach_send_intents_g_followup_calendar ON kauro.outreach_send_intents;
CREATE TRIGGER outreach_send_intents_g_followup_calendar BEFORE UPDATE OF state ON kauro.outreach_send_intents
  FOR EACH ROW WHEN (OLD.state = 'QUEUED' AND NEW.state = 'SUBMITTING' AND NEW.purpose = 'FOLLOW_UP') EXECUTE FUNCTION kauro.outreach_send_intents_followup_calendar();
