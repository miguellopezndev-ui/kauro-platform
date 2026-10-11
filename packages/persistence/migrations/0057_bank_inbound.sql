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
  ADD COLUMN created_by    uuid;

ALTER TABLE kauro.statement_imports
  ADD COLUMN agency_id uuid CHECK (agency_id IS NULL),
  ADD COLUMN version   bigint NOT NULL DEFAULT 1 CHECK (version = 1);

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
  RETURN NEW;
END
$$;
CREATE TRIGGER bank_credits_guard BEFORE UPDATE ON kauro.bank_credits FOR EACH ROW EXECUTE FUNCTION kauro.bank_credits_guard();
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

-- --- the payment service's reads of the route and of an instruction by its reference (M1) ----------------------------------------------
CREATE POLICY bank_routes_payment_read ON kauro.bank_routes FOR SELECT TO kauro_payment USING (true);
CREATE POLICY bank_route_versions_payment_read ON kauro.bank_route_versions FOR SELECT TO kauro_payment USING (true);
GRANT SELECT ON kauro.bank_routes, kauro.bank_route_versions TO kauro_payment;
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
