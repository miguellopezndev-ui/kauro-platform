-- 0057 — Payments V1, lane PV1-INBOUND (the inbound credit commands C5, C6, M1, M2, P1, E1, SI2; PROVISIONAL number, renumbered at merge).
--
-- Authority: docs/design/ACH-ROUTE.md r12 §7.5-§7.12 (C5, C4/C6, M1, M2, P1, E1), §7.23 (SI2), §7.24 (P1Δ), §7.28 (lock order), DV1-01
-- (no provider name in a table, column or event type) and the failure-mode matrix rows ACH-04..22. It builds on 0055's kauro.bank_credits
-- and 0045's statement tables (STRUCTURE there; the lanes add their guards, columns and widened grants here, ALTER never a second CREATE):
--   * bank_credits and statement_imports are agency-less aggregates (agency_id always NULL, decision #1 of 0046) with events of their own;
--   * bank_credits gets its guard: the listed edges of kauro.bank_machine_edges ('BankCredit'), a single version bump per change and the
--     columns that never change after the draft;
--   * the owner's commands run on the payment service's pool (kauro_payment): an OPERATOR or TENANT unit of work marked pool = 'PAYMENT'
--     (unit-of-work.ts runtimeRoleOf). kauro_payment therefore reads the caller's own identity, step-up proofs, corporate roles and session
--     row (the same own-row predicates kauro_app holds) and writes the caller's own journal and security events, nothing of another person;
--   * the bank order state change of an instruction (an order_state bump) is an event of its own.

ALTER TABLE kauro.bank_credits
  ADD COLUMN agency_id     uuid CHECK (agency_id IS NULL),
  ADD COLUMN payer_digest  text CHECK (payer_digest IS NULL OR kauro.is_sha256_hex(payer_digest)),
  ADD COLUMN payee_digest  text CHECK (payee_digest IS NULL OR kauro.is_sha256_hex(payee_digest)),
  ADD COLUMN artifact_ref  text CHECK (artifact_ref IS NULL OR kauro.is_provider_ref(artifact_ref)),
  ADD COLUMN created_by    uuid,
  -- the instant the credit became money the platform recognizes (OBSERVED), stamped by the database: P1's provider-time predicate
  -- (DV1-06: bookedAt <= confirmedAt + the route version's tolerance)
  ADD COLUMN confirmed_at  timestamptz;

ALTER TABLE kauro.statement_imports
  ADD COLUMN agency_id uuid CHECK (agency_id IS NULL),
  ADD COLUMN version   bigint NOT NULL DEFAULT 1 CHECK (version = 1);

-- a manual credit may carry any reference text the bank booked (a foreign or truncated one goes to review, never a CHECK failure)
ALTER TABLE kauro.bank_credits DROP CONSTRAINT bank_credits_reference_check;
ALTER TABLE kauro.bank_credits ADD CONSTRAINT bank_credits_reference_check CHECK (reference IS NULL OR char_length(reference) BETWEEN 1 AND 256);

-- the rail a bank booked a credit on, as it stated it (DV1-03): OTHER and UNKNOWN are recorded and go to review, never matched
ALTER TABLE kauro.bank_credits DROP CONSTRAINT bank_credits_rail_check;
ALTER TABLE kauro.bank_credits ADD CONSTRAINT bank_credits_rail_check CHECK (rail IN ('ACH', 'DOMESTIC_WIRE', 'OTHER', 'UNKNOWN'));

-- the order's accepted billing identity (sha256), frozen at issuance beside the reference: M1's payer key
ALTER TABLE kauro.bank_transfer_instructions ADD COLUMN accepted_payer_digest text CHECK (accepted_payer_digest IS NULL OR kauro.is_sha256_hex(accepted_payer_digest));
-- why an EXPIRED bank order expired: its transfer deadline (E1; a later on-time credit may still be honored, DV1-06) or its explicit
-- retirement by the agency's billing member (CMD214; a later credit is return-only). Set once, with the edge to EXPIRED.
ALTER TABLE kauro.bank_transfer_instructions ADD COLUMN expiry_cause text CHECK (expiry_cause IS NULL OR expiry_cause IN ('DEADLINE', 'RETIRED'));
CREATE OR REPLACE FUNCTION kauro.bank_transfer_instructions_expiry_cause() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.expiry_cause IS DISTINCT FROM OLD.expiry_cause AND (OLD.expiry_cause IS NOT NULL OR NEW.order_state <> 'EXPIRED' OR OLD.order_state = 'EXPIRED') THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: bank_transfer_instructions.expiry_cause is set once, with the edge to EXPIRED' USING ERRCODE = 'KA004';
  END IF;
  IF NEW.order_state = 'EXPIRED' AND OLD.order_state <> 'EXPIRED' AND NEW.expiry_cause IS NULL THEN
    RAISE EXCEPTION 'CONTEXT: an expiry names its cause' USING ERRCODE = 'KA006';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bank_transfer_instructions_expiry_cause BEFORE UPDATE ON kauro.bank_transfer_instructions
  FOR EACH ROW EXECUTE FUNCTION kauro.bank_transfer_instructions_expiry_cause();
GRANT UPDATE (expiry_cause) ON kauro.bank_transfer_instructions TO kauro_payment;
DROP TRIGGER bank_transfer_instructions_immutable ON kauro.bank_transfer_instructions;
CREATE TRIGGER bank_transfer_instructions_immutable BEFORE UPDATE ON kauro.bank_transfer_instructions
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('order_id,agency_id,route_id,route_version,environment,account_ref,reference,amount_cents,currency,issued_at,created_at,accepted_payer_digest');

-- --- the credit's guard ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kauro.bank_credits_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'VERSION_DISCIPLINE: bank_credits version % -> % is not a single bump', OLD.version, NEW.version USING ERRCODE = 'KA002';
  END IF;
  IF NEW.state <> OLD.state AND NOT EXISTS (SELECT 1 FROM kauro.bank_machine_edges e WHERE e.machine = 'BankCredit' AND e.from_state = OLD.state AND e.to_state = NEW.state) THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: BankCredit % -> % is not a listed transition', OLD.state, NEW.state USING ERRCODE = 'KA005';
  END IF;
  IF OLD.state = 'DRAFT_MANUAL' AND NEW.state = 'OBSERVED' THEN
    NEW.confirmed_at := kauro.effect_now();
  ELSIF NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: bank_credits.confirmed_at is stamped once, at the confirmation' USING ERRCODE = 'KA004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bank_credits_guard BEFORE UPDATE ON kauro.bank_credits FOR EACH ROW EXECUTE FUNCTION kauro.bank_credits_guard();
-- a credit born OBSERVED (a statement line) is confirmed by its import; a draft is not yet
CREATE OR REPLACE FUNCTION kauro.bank_credits_confirmed_at() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  NEW.confirmed_at := CASE WHEN NEW.state = 'DRAFT_MANUAL' THEN NULL ELSE kauro.effect_now() END;
  RETURN NEW;
END
$$;
CREATE TRIGGER bank_credits_confirmed_at BEFORE INSERT ON kauro.bank_credits FOR EACH ROW EXECUTE FUNCTION kauro.bank_credits_confirmed_at();
CREATE TRIGGER bank_credits_immutable BEFORE UPDATE ON kauro.bank_credits
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('bank_credit_id,environment,account_ref,bank_transaction_id,rail,currency,gross_cents,evidence_hash,created_at,created_by,agency_id');

-- --- aggregate kinds and events --------------------------------------------------------------------------------------------------------
INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES
  ('bank_credit', 'bank_credits', 'bank_credit_id', 'B09'),
  ('statement_import', 'statement_imports', 'import_id', 'B09');
ALTER TABLE kauro.event_types NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.event_types (event_type) VALUES
  ('bank_credit.drafted.v1'), ('bank_credit.received.v1'), ('bank_credit.matched.v1'), ('bank_credit.review_required.v1'), ('bank_credit.applied.v1'),
  ('statement_import.recorded.v1'), ('bank_transfer_instruction.order_state_changed.v1');
ALTER TABLE kauro.event_types FORCE ROW LEVEL SECURITY;
CREATE CONSTRAINT TRIGGER statement_imports_event_per_version AFTER INSERT ON kauro.statement_imports
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('statement_import', 'import_id');

-- agency-less credit and import events and their outbox records: the payment service's, for these two kinds only (decision #1)
CREATE POLICY domain_events_payment_bank ON kauro.domain_events FOR ALL TO kauro_payment
  USING (agency_id IS NULL AND aggregate_kind IN ('bank_credit', 'statement_import'))
  WITH CHECK (agency_id IS NULL AND aggregate_kind IN ('bank_credit', 'statement_import') AND split_part(event_type, '.', 1) = aggregate_kind);
CREATE POLICY outbox_records_payment_bank ON kauro.outbox_records FOR ALL TO kauro_payment
  USING (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id IS NULL AND e.aggregate_kind IN ('bank_credit', 'statement_import')))
  WITH CHECK (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id IS NULL AND e.aggregate_kind IN ('bank_credit', 'statement_import')));

-- the bank order state change of an instruction: the agency's event, published by the payment service in the agency it adopted
CREATE POLICY domain_events_payment_bank_order ON kauro.domain_events FOR ALL TO kauro_payment
  USING (agency_id = kauro.current_agency_id() AND aggregate_kind = 'bank_transfer_instruction')
  WITH CHECK (agency_id = kauro.current_agency_id() AND aggregate_kind = 'bank_transfer_instruction' AND event_type = 'bank_transfer_instruction.order_state_changed.v1');

-- --- the payment service's reads of the route and of an instruction by its reference (M1) ----------------------------------------------
CREATE POLICY bank_routes_payment_read ON kauro.bank_routes FOR SELECT TO kauro_payment USING (true);
CREATE POLICY bank_route_versions_payment_read ON kauro.bank_route_versions FOR SELECT TO kauro_payment USING (true);
GRANT SELECT ON kauro.bank_routes, kauro.bank_route_versions TO kauro_payment;
-- P1's share lock of the route (a disable in flight is ordered before or after the apply; the tenant lock's pattern of 0046): the
-- row lock only, never a write (WITH CHECK (false))
CREATE POLICY bank_routes_payment_lock ON kauro.bank_routes FOR UPDATE TO kauro_payment USING (true) WITH CHECK (false);
GRANT UPDATE (version) ON kauro.bank_routes TO kauro_payment;
-- the lookup by (environment, account, reference) happens before any agency is adopted: the reference names the order, never a guess
CREATE POLICY bank_transfer_instructions_payment_lookup ON kauro.bank_transfer_instructions FOR SELECT TO kauro_payment USING (true);

-- --- the owner's pipeline on the payment service's pool ---------------------------------------------------------------------------------
-- The same own-row predicates kauro_app holds (0002, 0013, 0025/0047): the person's own identity, proofs, corporate roles and session.
CREATE POLICY identities_payment_self_read ON kauro.identities FOR SELECT TO kauro_payment USING (user_id = kauro.current_user_id());
CREATE POLICY assurance_proofs_payment_self_read ON kauro.assurance_proofs FOR SELECT TO kauro_payment USING (user_id = kauro.current_user_id());
CREATE POLICY corporate_roles_payment_self_read ON kauro.corporate_roles FOR SELECT TO kauro_payment USING (user_id = kauro.current_user_id());
CREATE POLICY web_sessions_payment_read ON kauro.web_sessions FOR SELECT TO kauro_payment
  USING (secret_sha256 = kauro.current_session_sha256() AND user_id = kauro.current_user_id());
CREATE POLICY web_sessions_payment_lock ON kauro.web_sessions FOR UPDATE TO kauro_payment
  USING (secret_sha256 = kauro.current_session_sha256() AND user_id = kauro.current_user_id()) WITH CHECK (false);
GRANT SELECT ON kauro.identities, kauro.assurance_proofs, kauro.corporate_roles TO kauro_payment;
GRANT SELECT (secret_sha256, user_id, revoked_at, idle_expires_at, absolute_expires_at) ON kauro.web_sessions TO kauro_payment;
GRANT UPDATE (session_id) ON kauro.web_sessions TO kauro_payment;
-- the owner's own journal entries (identity-scoped, no agency) and security facts
CREATE POLICY command_journal_payment_owner ON kauro.command_journal FOR ALL TO kauro_payment
  USING (agency_id IS NULL AND actor_kind = 'USER' AND actor_id = kauro.current_user_id()::text)
  WITH CHECK (agency_id IS NULL AND actor_kind = 'USER' AND actor_id = kauro.current_user_id()::text);
CREATE POLICY security_events_payment_owner ON kauro.security_events FOR INSERT TO kauro_payment
  WITH CHECK (agency_id IS NULL AND actor_kind = 'USER' AND actor_id = kauro.current_user_id()::text);

-- --- step-up proof revocation -----------------------------------------------------------------------------------------------------------
-- A step-up proof stays append-only evidence, with one exception: its validity can be ENDED early (a revocation of the step-up an owner
-- command is waiting on is seen by that command's judgment at the effect instant). Only expires_at may change, only downwards (never to
-- or before issued_at: the table's CHECK), and a proof is never deleted.
CREATE OR REPLACE FUNCTION kauro.assurance_proofs_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: assurance_proofs is append-only (DELETE refused)' USING ERRCODE = 'KA004';
  END IF;
  IF NEW.expires_at > OLD.expires_at OR (NEW.proof_id, NEW.user_id, NEW.kind, NEW.method, NEW.issued_at, NEW.correlation_id, NEW.created_at) IS DISTINCT FROM (OLD.proof_id, OLD.user_id, OLD.kind, OLD.method, OLD.issued_at, OLD.correlation_id, OLD.created_at) THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: assurance_proofs is append-only (UPDATE refused)' USING ERRCODE = 'KA004';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER assurance_proofs_append_only ON kauro.assurance_proofs;
CREATE TRIGGER assurance_proofs_append_only BEFORE UPDATE OR DELETE ON kauro.assurance_proofs FOR EACH ROW EXECUTE FUNCTION kauro.assurance_proofs_guard();

-- --- the project's checkout slot of an expired bank order (D-ACH-05, D-ACH-10) --------------------------------------------------------
-- The vendored PaymentOrder machine is not extended: a bank order's payment_orders row stays INTENT_CREATED and its bank state is the
-- instruction's order_state. An EXPIRED bank order stops instructions and payment claims, so it releases the project's one open checkout
-- (payment_orders_one_open_per_project): bank_slot_released_at is set once, in the unit that expires the bank order (E1, P1 past the
-- deadline, CMD214), and only while that order's bank state is EXPIRED. It is not a version of the order (no event).
ALTER TABLE kauro.payment_orders ADD COLUMN bank_slot_released_at timestamptz;
CREATE OR REPLACE FUNCTION kauro.payment_orders_bank_slot_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.bank_slot_released_at IS DISTINCT FROM OLD.bank_slot_released_at THEN
    IF OLD.bank_slot_released_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM kauro.bank_transfer_instructions b WHERE b.order_id = NEW.order_id AND b.order_state = 'EXPIRED') THEN
      RAISE EXCEPTION 'IMMUTABLE_COLUMN: payment_orders.bank_slot_released_at is set once, for an EXPIRED bank order' USING ERRCODE = 'KA004';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_orders_bank_slot_guard BEFORE UPDATE OF bank_slot_released_at ON kauro.payment_orders
  FOR EACH ROW EXECUTE FUNCTION kauro.payment_orders_bank_slot_guard();
DROP TRIGGER payment_orders_version ON kauro.payment_orders;
CREATE TRIGGER payment_orders_version BEFORE UPDATE ON kauro.payment_orders FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump('allocated_cents,bank_slot_released_at');
DROP INDEX kauro.payment_orders_one_open_per_project;
CREATE UNIQUE INDEX payment_orders_one_open_per_project ON kauro.payment_orders (agency_id, project_id)
  WHERE state IN ('INTENT_CREATED', 'CREATING', 'CREATED', 'APPROVED', 'CAPTURING', 'CAPTURE_UNCERTAIN') AND bank_slot_released_at IS NULL;
GRANT UPDATE (bank_slot_released_at) ON kauro.payment_orders TO kauro_payment;

-- --- CMD214: the agency's billing member retires its open bank checkout (§7.12 E1, retirement half) ----------------------------------
-- The retirement is a person-authorized command of the payment boundary: its tenant unit runs on the payment service's pool (the
-- instruction's state, the order's lock and its slot are the payment service's columns, never kauro_app's). The B06 authorizer reads
-- the member's own live membership in the bound agency; its journal entry and security facts are the member's, in that agency.
CREATE POLICY memberships_payment_member_read ON kauro.memberships FOR SELECT TO kauro_payment
  USING (agency_id = kauro.current_agency_id() AND user_id = kauro.current_user_id());
GRANT SELECT ON kauro.memberships TO kauro_payment;
CREATE POLICY command_journal_payment_member ON kauro.command_journal FOR ALL TO kauro_payment
  USING (agency_id IS NOT NULL AND agency_id = kauro.current_agency_id() AND actor_kind = 'USER' AND actor_id = kauro.current_user_id()::text)
  WITH CHECK (agency_id IS NOT NULL AND agency_id = kauro.current_agency_id() AND actor_kind = 'USER' AND actor_id = kauro.current_user_id()::text);
CREATE POLICY security_events_payment_member ON kauro.security_events FOR INSERT TO kauro_payment
  WITH CHECK (
    agency_id IS NOT NULL AND agency_id = kauro.current_agency_id() AND actor_kind = 'USER' AND actor_id = kauro.current_user_id()::text
    AND EXISTS (
      SELECT 1 FROM kauro.memberships m
      WHERE m.agency_id = security_events.agency_id AND m.user_id = kauro.current_user_id() AND m.state IN ('INVITED', 'ACTIVE', 'SUSPENDED')
    )
  );
