-- Migration 0071: the corporate owner's approval of a manual-rail refund, applied by the payment service (Payments V1, lane L-REFUND, slice 1:
-- F2 `Kapprove`; docs/design/ACH-ROUTE.md r12 §7.13-§7.14 F1/F2, D-ACH-16, D-ACH-19; DV1-10, DV1-11). Provisional number (renumbered at merge).
--
-- Every bank outbound command runs its units of work as the payment service (kauro_payment), so the owner's authority is judged where the
-- payment service cannot forge it:
--   1. kauro.bank_owner_acts: the owner authorities judged in a transaction (txid_current()), written ONLY by kauro.bank_owner_authority.
--   2. kauro.bank_owner_authority(user, proof, freshness): SECURITY DEFINER (the second definer of the schema; the first is 0046's route
--      registration). After the transition locks of the identity and of its corporate grants it judges: the identity ACTIVE, an ACTIVE
--      KAURO_OWNER grant, the proof a STEP_UP of that identity, fresh at kauro.server_now() (issued no later than now, at most `freshness`
--      seconds old, never past its expiry). Only then it records the act of this transaction and answers OK; otherwise the refusal token.
--      kauro_payment never writes an act itself (SELECT of its own transaction's acts only) and never reads identities, grants or proofs.
--   3. kauro.refunds: the payment service may move a REQUESTED refund to APPROVED only with an act of this transaction naming the approver and
--      the proof the row cites, an OWNER_STEP_UP authorization, a captured destination, and never for the requester (KP007, KP008).
--   4. kauro.treasury_refunds: an aggregate of the Refund machine in route scope (agency NULL): approval columns, the listed transitions, the
--      version discipline, one event per version (agency-less, decision #1 of 0046), and the same owner-act guard.
--   5. kauro.command_journal: the owner's own journal entries (actor USER, agency NULL) of the bank owner commands, readable and writable by
--      the payment service only inside a transaction whose act names that owner.
-- Idempotent where PostgreSQL allows it; never edits an earlier migration (ALTER and CREATE OR REPLACE only).

-- --- 1. the acts ------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kauro.bank_owner_acts (
  txid        bigint NOT NULL,
  user_id     uuid NOT NULL REFERENCES kauro.identities (user_id),
  proof_id    uuid NOT NULL,
  judged_at   timestamptz NOT NULL,
  PRIMARY KEY (txid, user_id, proof_id),
  FOREIGN KEY (user_id, proof_id) REFERENCES kauro.assurance_proofs (user_id, proof_id)
);
DROP TRIGGER IF EXISTS bank_owner_acts_append_only ON kauro.bank_owner_acts;
CREATE TRIGGER bank_owner_acts_append_only BEFORE UPDATE OR DELETE ON kauro.bank_owner_acts FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
ALTER TABLE kauro.bank_owner_acts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.bank_owner_acts FORCE ROW LEVEL SECURITY;
-- the function owner (FORCE applies to it inside the definer) writes and reads acts; the payment service reads its own transaction's only
DROP POLICY IF EXISTS bank_owner_acts_definer ON kauro.bank_owner_acts;
CREATE POLICY bank_owner_acts_definer ON kauro.bank_owner_acts FOR ALL TO CURRENT_USER USING (true) WITH CHECK (txid = pg_catalog.txid_current());
DROP POLICY IF EXISTS bank_owner_acts_payment_read ON kauro.bank_owner_acts;
CREATE POLICY bank_owner_acts_payment_read ON kauro.bank_owner_acts FOR SELECT TO kauro_payment USING (txid = pg_catalog.txid_current());
GRANT SELECT ON kauro.bank_owner_acts TO kauro_payment;

-- --- 2. the authority -------------------------------------------------------------------------------------------------------------------
-- inside the definer FORCE ROW LEVEL SECURITY applies to its owner: it reads the person's identity and proofs under these policies only
DROP POLICY IF EXISTS identities_bank_owner_read ON kauro.identities;
CREATE POLICY identities_bank_owner_read ON kauro.identities FOR SELECT TO CURRENT_USER USING (true);
DROP POLICY IF EXISTS assurance_proofs_bank_owner_read ON kauro.assurance_proofs;
CREATE POLICY assurance_proofs_bank_owner_read ON kauro.assurance_proofs FOR SELECT TO CURRENT_USER USING (true);

CREATE OR REPLACE FUNCTION kauro.bank_owner_authority(p_user uuid, p_proof uuid, p_freshness_seconds integer)
  RETURNS TABLE (verdict text, issued_at timestamptz, expires_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  now_at timestamptz := kauro.server_now();
  person_state text;
  proof record;
BEGIN
  IF p_user IS NULL OR p_freshness_seconds IS NULL OR p_freshness_seconds < 1 OR p_freshness_seconds > 900 THEN
    RAISE EXCEPTION 'INTEGRITY: the owner authority is judged for a person within a freshness of at most 900 seconds' USING ERRCODE = '22023';
  END IF;
  -- the shared halves of the identity's and of its grants' transitions: a disable or a revocation in flight is ordered before or after
  PERFORM kauro.await_transition('kauro.identities', p_user::text);
  PERFORM kauro.await_transition('kauro.corporate_roles', p_user::text);
  SELECT i.state INTO person_state FROM kauro.identities i WHERE i.user_id = p_user;
  IF person_state IS DISTINCT FROM 'ACTIVE' THEN
    RETURN QUERY SELECT 'IDENTITY_DISABLED'::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kauro.corporate_roles g WHERE g.user_id = p_user AND g.role = 'KAURO_OWNER' AND g.state = 'ACTIVE') THEN
    RETURN QUERY SELECT 'CORPORATE_ROLE_MISSING'::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  IF p_proof IS NULL THEN
    RETURN QUERY SELECT 'STEP_UP_MISSING'::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT a.kind, a.issued_at, a.expires_at INTO proof FROM kauro.assurance_proofs a WHERE a.proof_id = p_proof AND a.user_id = p_user;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'STEP_UP_NOT_OWNED'::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  IF proof.kind IS DISTINCT FROM 'STEP_UP' THEN
    RETURN QUERY SELECT 'STEP_UP_MISSING'::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  IF proof.issued_at > now_at OR now_at - proof.issued_at > pg_catalog.make_interval(secs => p_freshness_seconds) OR now_at >= proof.expires_at THEN
    RETURN QUERY SELECT 'STEP_UP_STALE'::text, proof.issued_at, proof.expires_at;
    RETURN;
  END IF;
  INSERT INTO kauro.bank_owner_acts (txid, user_id, proof_id, judged_at) VALUES (pg_catalog.txid_current(), p_user, p_proof, now_at)
    ON CONFLICT (txid, user_id, proof_id) DO NOTHING;
  RETURN QUERY SELECT 'OK'::text, proof.issued_at, proof.expires_at;
END
$$;
REVOKE ALL ON FUNCTION kauro.bank_owner_authority(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kauro.bank_owner_authority(uuid, uuid, integer) TO kauro_payment;
GRANT EXECUTE ON FUNCTION kauro.await_transition(text, text) TO kauro_payment;

-- the act of this transaction naming `who` with `proof` (SECURITY INVOKER: the caller's own policy decides what it sees)
CREATE OR REPLACE FUNCTION kauro.bank_owner_acted(who uuid, proof uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$ SELECT who IS NOT NULL AND proof IS NOT NULL AND EXISTS (SELECT 1 FROM kauro.bank_owner_acts a WHERE a.txid = pg_catalog.txid_current() AND a.user_id = who AND a.proof_id = proof) $$;
GRANT EXECUTE ON FUNCTION kauro.bank_owner_acted(uuid, uuid) TO kauro_payment;

-- --- 3. refunds: the payment service applies an owner's approval -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kauro.refunds_review_authority() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  reviewer uuid := kauro.current_user_id();
  phase text;
  auth_id uuid;
  auth_state text;
  auth_phase text;
BEGIN
  IF reviewer IS NULL THEN
    -- no session person: only the payment service applying a corporate owner's step-up approval judged in this very transaction by
    -- kauro.bank_owner_authority, of a refund whose destination is captured (Payments V1 F2; 0071)
    IF NOT pg_catalog.pg_has_role(current_user, 'kauro_payment', 'USAGE') OR NEW.state <> 'APPROVED' OR NEW.authorization_kind IS DISTINCT FROM 'OWNER_STEP_UP' OR NEW.authorization_policy_id IS NOT NULL
       OR NOT kauro.bank_owner_acted(NEW.approved_by_user_id, NEW.authorization_proof_ref) THEN
      RAISE EXCEPTION 'CORPORATE_ROLE_MISSING: refund % is reviewed by a person', OLD.refund_id USING ERRCODE = 'KP007';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM kauro.refund_destinations d WHERE d.refund_id = OLD.refund_id AND d.agency_id = OLD.agency_id) THEN
      RAISE EXCEPTION 'CORPORATE_ROLE_MISSING: refund % is approved for the manual rail only with its destination captured', OLD.refund_id USING ERRCODE = 'KP007';
    END IF;
    IF OLD.requested_by_user_id = NEW.approved_by_user_id THEN
      RAISE EXCEPTION 'SELF_APPROVAL_FORBIDDEN: the identity that requested refund % cannot review it', OLD.refund_id USING ERRCODE = 'KP008';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM kauro.await_transition('kauro.corporate_roles', reviewer::text);
  IF NOT kauro.holds_corporate_role('KAURO_OWNER') THEN
    RAISE EXCEPTION 'CORPORATE_ROLE_MISSING: the reviewer of refund % holds no ACTIVE KAURO_OWNER grant', OLD.refund_id USING ERRCODE = 'KP007';
  END IF;
  IF (NEW.state = 'APPROVED' AND NEW.approved_by_user_id IS DISTINCT FROM reviewer) OR (NEW.state = 'REJECTED' AND NEW.rejected_by_user_id IS DISTINCT FROM reviewer) THEN
    RAISE EXCEPTION 'CORPORATE_ROLE_MISSING: refund % names a reviewer other than the session''s person', OLD.refund_id USING ERRCODE = 'KP007';
  END IF;
  IF OLD.requested_by_user_id = reviewer THEN
    RAISE EXCEPTION 'SELF_APPROVAL_FORBIDDEN: the identity that requested refund % cannot review it', OLD.refund_id USING ERRCODE = 'KP008';
  END IF;
  IF NEW.state = 'APPROVED' AND NEW.authorization_kind = 'STANDING_POLICY' THEN
    SELECT s.authorization_id INTO auth_id FROM kauro.commercial_authorizations s
     WHERE s.agency_id = OLD.agency_id AND s.capture_id = OLD.capture_id ORDER BY (s.state <> 'REVOKED') DESC, s.created_at DESC LIMIT 1;
    IF auth_id IS NOT NULL THEN
      PERFORM kauro.await_transition('kauro.commercial_authorizations', auth_id::text);
      SELECT s.state, s.revocation_phase INTO auth_state, auth_phase
        FROM kauro.commercial_authorizations s WHERE s.agency_id = OLD.agency_id AND s.authorization_id = auth_id;
    END IF;
    phase := CASE WHEN auth_id IS NULL THEN 'NO_AUTHORIZATION' WHEN auth_state = 'ACTIVE' THEN 'PRE_EXECUTION'
                  WHEN auth_state = 'CONSUMED' THEN 'DURING_EXECUTION' WHEN auth_state = 'DELIVERED' THEN 'POST_DELIVERY'
                  ELSE auth_phase END;
    IF NOT EXISTS (
      SELECT 1 FROM kauro.refund_policies p
       WHERE p.policy_id = NEW.authorization_policy_id AND p.state = 'ACTIVE'
         AND p.valid_from <= NEW.approved_at AND (p.valid_until IS NULL OR p.valid_until > NEW.approved_at)
         AND p.applies_to_origin = OLD.origin
         AND (p.applies_to_phase = 'ANY' OR phase IN ('PRE_EXECUTION', 'NO_AUTHORIZATION'))
         AND (p.refund_scope <> 'BOUNDED' OR NEW.approved_service_cents + NEW.approved_tax_cents + NEW.approved_excess_cents <= p.max_refund_cents)
         AND (p.refund_scope <> 'EXCESS_ONLY' OR (NEW.approved_service_cents = 0 AND NEW.approved_tax_cents = 0))
    ) THEN
      RAISE EXCEPTION 'POLICY_NOT_APPLICABLE: the standing policy cited by refund % does not cover it', OLD.refund_id USING ERRCODE = 'KP010';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- the payment service locks and approves a REQUESTED refund of its adopted agency; the trigger above decides whether it may (an act, a
-- destination, segregation); it never rejects one and never edits a REQUESTED row in place (WITH CHECK admits APPROVED only)
DROP POLICY IF EXISTS refunds_payment_owner_approval ON kauro.refunds;
CREATE POLICY refunds_payment_owner_approval ON kauro.refunds FOR UPDATE TO kauro_payment
  USING (agency_id = kauro.current_agency_id() AND state = 'REQUESTED')
  WITH CHECK (agency_id = kauro.current_agency_id() AND state = 'APPROVED');
GRANT UPDATE (approved_service_cents, approved_tax_cents, approved_excess_cents, authorization_kind, authorization_proof_ref, authorization_policy_id, authorization_hash, effects_hash, credit_note_required, approved_by_user_id, approved_at)
  ON kauro.refunds TO kauro_payment;

-- --- 4. treasury refunds: the route-scope aggregate of the Refund machine ---------------------------------------------------------------
ALTER TABLE kauro.treasury_refunds
  ADD COLUMN IF NOT EXISTS agency_id uuid CHECK (agency_id IS NULL),
  ADD COLUMN IF NOT EXISTS approved_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS authorization_proof_ref uuid,
  ADD COLUMN IF NOT EXISTS authorization_hash text CHECK (authorization_hash IS NULL OR kauro.is_sha256_hex(authorization_hash)),
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'treasury_refunds_approval_whole') THEN
    ALTER TABLE kauro.treasury_refunds ADD CONSTRAINT treasury_refunds_approval_whole CHECK (
      (approved_by_user_id IS NULL) = (authorization_proof_ref IS NULL) AND (approved_by_user_id IS NULL) = (authorization_hash IS NULL)
      AND (approved_by_user_id IS NULL) = (approved_at IS NULL)
      AND (state IN ('REQUESTED', 'REJECTED') OR approved_by_user_id IS NOT NULL));
    ALTER TABLE kauro.treasury_refunds ADD CONSTRAINT treasury_refunds_approver_proof_fk FOREIGN KEY (approved_by_user_id, authorization_proof_ref) REFERENCES kauro.assurance_proofs (user_id, proof_id);
  END IF;
END
$$;
DROP TRIGGER IF EXISTS treasury_refunds_version ON kauro.treasury_refunds;
CREATE TRIGGER treasury_refunds_version BEFORE UPDATE ON kauro.treasury_refunds FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
DROP TRIGGER IF EXISTS treasury_refunds_immutable ON kauro.treasury_refunds;
CREATE TRIGGER treasury_refunds_immutable BEFORE UPDATE ON kauro.treasury_refunds
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('treasury_refund_id,route_id,environment,account_ref,bank_credit_id,amount_cents,agency_id,created_at');
DROP TRIGGER IF EXISTS treasury_refunds_learned_once ON kauro.treasury_refunds;
CREATE TRIGGER treasury_refunds_learned_once BEFORE UPDATE ON kauro.treasury_refunds
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('approved_by_user_id,authorization_proof_ref,authorization_hash,approved_at');
DROP TRIGGER IF EXISTS treasury_refunds_transition ON kauro.treasury_refunds;
CREATE TRIGGER treasury_refunds_transition BEFORE UPDATE OF state ON kauro.treasury_refunds
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('Refund');
DROP TRIGGER IF EXISTS treasury_refunds_initial_state ON kauro.treasury_refunds;
CREATE TRIGGER treasury_refunds_initial_state BEFORE INSERT ON kauro.treasury_refunds
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('Refund');

CREATE OR REPLACE FUNCTION kauro.treasury_refunds_review_authority() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.state <> 'APPROVED' OR NOT kauro.bank_owner_acted(NEW.approved_by_user_id, NEW.authorization_proof_ref) THEN
    RAISE EXCEPTION 'CORPORATE_ROLE_MISSING: treasury refund % is reviewed by a corporate owner whose authority was judged in this transaction', OLD.treasury_refund_id USING ERRCODE = 'KP007';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kauro.refund_destinations d WHERE d.treasury_refund_id = OLD.treasury_refund_id) THEN
    RAISE EXCEPTION 'CORPORATE_ROLE_MISSING: treasury refund % is approved only with its destination captured', OLD.treasury_refund_id USING ERRCODE = 'KP007';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS treasury_refunds_review_authority ON kauro.treasury_refunds;
CREATE TRIGGER treasury_refunds_review_authority BEFORE UPDATE OF state ON kauro.treasury_refunds
  FOR EACH ROW WHEN (OLD.state = 'REQUESTED' AND NEW.state IN ('APPROVED', 'REJECTED')) EXECUTE FUNCTION kauro.treasury_refunds_review_authority();

-- the refundable ceiling of one bank credit: its committing treasury refunds never exceed its gross (taken under the credit's row lock)
CREATE OR REPLACE FUNCTION kauro.treasury_refunds_commitment_ceiling() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  gross bigint;
  committed bigint;
BEGIN
  SELECT c.gross_cents INTO gross FROM kauro.bank_credits c WHERE c.bank_credit_id = OLD.bank_credit_id FOR NO KEY UPDATE;
  SELECT coalesce(sum(t.amount_cents), 0) INTO committed FROM kauro.treasury_refunds t
   WHERE t.bank_credit_id = OLD.bank_credit_id AND t.treasury_refund_id <> OLD.treasury_refund_id AND t.state IN ('APPROVED', 'SUBMITTING', 'UNCERTAIN', 'COMPLETED');
  IF gross IS NULL OR committed + NEW.amount_cents > gross THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_REMAINING: treasury refund % exceeds the credit''s refundable gross', OLD.treasury_refund_id USING ERRCODE = 'KP003';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS treasury_refunds_commitment_ceiling ON kauro.treasury_refunds;
CREATE TRIGGER treasury_refunds_commitment_ceiling BEFORE UPDATE OF state ON kauro.treasury_refunds
  FOR EACH ROW WHEN (OLD.state = 'REQUESTED' AND NEW.state = 'APPROVED') EXECUTE FUNCTION kauro.treasury_refunds_commitment_ceiling();

INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES ('treasury_refund', 'treasury_refunds', 'treasury_refund_id', 'B09')
  ON CONFLICT DO NOTHING;
-- the corporate owner reads the treasury refunds (the owner queue; the same precedent as bank_transfer_instructions_owner_read of 0046);
-- a tenant session sees none, so the shared event binding answers it KA006 as for every other kind
DROP POLICY IF EXISTS treasury_refunds_owner_read ON kauro.treasury_refunds;
CREATE POLICY treasury_refunds_owner_read ON kauro.treasury_refunds FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
GRANT SELECT ON kauro.treasury_refunds TO kauro_app;
ALTER TABLE kauro.event_types NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.event_types (event_type) VALUES ('treasury_refund.approved.v1') ON CONFLICT DO NOTHING;
ALTER TABLE kauro.event_types FORCE ROW LEVEL SECURITY;
-- one event per version of a treasury refund's change (the request row itself is the credit's fixture/consumer insert at version 1)
DROP TRIGGER IF EXISTS treasury_refunds_event_per_version ON kauro.treasury_refunds;
CREATE CONSTRAINT TRIGGER treasury_refunds_event_per_version AFTER UPDATE OF version ON kauro.treasury_refunds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('treasury_refund', 'treasury_refund_id');
-- the payment service's agency-less treasury refund events and their outbox records (decision #1 of 0046: agency NULL, owner scope)
DROP POLICY IF EXISTS domain_events_payment_treasury ON kauro.domain_events;
CREATE POLICY domain_events_payment_treasury ON kauro.domain_events FOR ALL TO kauro_payment
  USING (agency_id IS NULL AND aggregate_kind = 'treasury_refund')
  WITH CHECK (agency_id IS NULL AND aggregate_kind = 'treasury_refund' AND split_part(event_type, '.', 1) = 'treasury_refund');
DROP POLICY IF EXISTS outbox_records_payment_treasury ON kauro.outbox_records;
CREATE POLICY outbox_records_payment_treasury ON kauro.outbox_records FOR ALL TO kauro_payment
  USING (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id IS NULL AND e.aggregate_kind = 'treasury_refund'))
  WITH CHECK (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id IS NULL AND e.aggregate_kind = 'treasury_refund'));

-- --- 5. the owner's journal entries of the bank owner commands ---------------------------------------------------------------------------
-- CMD032 (F2 on a capture refund) and the lane's operational ids CMD220..CMD229 (route-scope owner commands); agency NULL, actor the owner
DROP POLICY IF EXISTS command_journal_bank_owner ON kauro.command_journal;
CREATE POLICY command_journal_bank_owner ON kauro.command_journal FOR ALL TO kauro_payment
  USING (actor_kind = 'USER' AND agency_id IS NULL AND operation IN ('CMD032', 'CMD220', 'CMD221', 'CMD222', 'CMD223', 'CMD224', 'CMD225', 'CMD226', 'CMD227', 'CMD228', 'CMD229')
         AND EXISTS (SELECT 1 FROM kauro.bank_owner_acts a WHERE a.txid = pg_catalog.txid_current() AND a.user_id::text = command_journal.actor_id))
  WITH CHECK (actor_kind = 'USER' AND agency_id IS NULL AND operation IN ('CMD032', 'CMD220', 'CMD221', 'CMD222', 'CMD223', 'CMD224', 'CMD225', 'CMD226', 'CMD227', 'CMD228', 'CMD229')
         AND EXISTS (SELECT 1 FROM kauro.bank_owner_acts a WHERE a.txid = pg_catalog.txid_current() AND a.user_id::text = command_journal.actor_id));

-- =====================================================================================================================================
-- Slice 2: X1 DeclareRefundExecution, G2/G4 RecordExecution (Koffer, G1, outcome) and the X2 EXECUTION_WINDOW sweep (docs/design/ACH-ROUTE.md
-- r12 §7.21-§7.22d, §7.28; DV1-08, DV1-11). The attempt is an aggregate of the OutboundExecutionAttempt machine (bank_machine_edges): its
-- declaration frozen, what its record learned set once, one event per version; a manual-rail refund is never COMPLETED without the RECORDED
-- execution that proves it.
-- =====================================================================================================================================

-- --- 6. the attempt aggregate ------------------------------------------------------------------------------------------------------------
-- the listed edges of a bank machine (kauro.bank_machine_edges; TG_ARGV[0] the machine)
CREATE OR REPLACE FUNCTION kauro.enforce_bank_machine_edge() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT EXISTS (
    SELECT 1 FROM kauro.bank_machine_edges m WHERE m.machine = TG_ARGV[0] AND m.from_state = OLD.state AND m.to_state = NEW.state
  ) THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: % % -> % is not a listed edge', TG_ARGV[0], OLD.state, NEW.state USING ERRCODE = 'KA008';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS outbound_execution_attempts_transition ON kauro.outbound_execution_attempts;
CREATE TRIGGER outbound_execution_attempts_transition BEFORE UPDATE OF state ON kauro.outbound_execution_attempts
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.enforce_bank_machine_edge('OutboundExecutionAttempt');
-- frozen at declaration (DV1-08); the fingerprint's key id, key version and normalizer version are not frozen here (a key rotation re-keys them)
DROP TRIGGER IF EXISTS outbound_execution_attempts_immutable ON kauro.outbound_execution_attempts;
CREATE TRIGGER outbound_execution_attempts_immutable BEFORE UPDATE ON kauro.outbound_execution_attempts
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('attempt_id,environment,account_ref,kind,source_kind,agency_id,capture_id,refund_id,bank_credit_id,treasury_refund_id,parent_bounce_id,attempt_number,reference,amount_cents,currency,declared_at,declared_by,destination_fingerprint,recipient_ref,recipient_version,created_at');
-- what the record learned is learned once
DROP TRIGGER IF EXISTS outbound_execution_attempts_learned_once ON kauro.outbound_execution_attempts;
CREATE TRIGGER outbound_execution_attempts_learned_once BEFORE UPDATE ON kauro.outbound_execution_attempts
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('bank_execution_id,destination_proof,evidence_hash,recorded_at');
INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES ('outbound_execution_attempt', 'outbound_execution_attempts', 'attempt_id', 'B09')
  ON CONFLICT DO NOTHING;
DROP TRIGGER IF EXISTS outbound_execution_attempts_event_per_version ON kauro.outbound_execution_attempts;
CREATE CONSTRAINT TRIGGER outbound_execution_attempts_event_per_version AFTER UPDATE OF version ON kauro.outbound_execution_attempts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('outbound_execution_attempt', 'attempt_id');
ALTER TABLE kauro.event_types NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.event_types (event_type) VALUES
  ('outbound.declared.v1'), ('outbound.uncertain.v1'), ('outbound.recorded.v1'), ('outbound.not_executed.v1'), ('outbound.bounced.v1'), ('outbound.resent.v1'),
  ('treasury_refund.submitting.v1'), ('treasury_refund.uncertain.v1'), ('treasury_refund.completed.v1'), ('treasury_refund.failed.v1')
  ON CONFLICT DO NOTHING;
ALTER TABLE kauro.event_types FORCE ROW LEVEL SECURITY;
-- the payment service's attempt events (agency NULL for a BANK_CREDIT source, the adopted agency for a CAPTURE source) and their outbox
DROP POLICY IF EXISTS domain_events_payment_outbound ON kauro.domain_events;
CREATE POLICY domain_events_payment_outbound ON kauro.domain_events FOR ALL TO kauro_payment
  USING (aggregate_kind = 'outbound_execution_attempt' AND (agency_id IS NULL OR agency_id = kauro.current_agency_id()))
  WITH CHECK (aggregate_kind = 'outbound_execution_attempt' AND (agency_id IS NULL OR agency_id = kauro.current_agency_id()) AND split_part(event_type, '.', 1) = 'outbound');
DROP POLICY IF EXISTS outbox_records_payment_outbound ON kauro.outbox_records;
CREATE POLICY outbox_records_payment_outbound ON kauro.outbox_records FOR ALL TO kauro_payment
  USING (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.aggregate_kind = 'outbound_execution_attempt' AND (e.agency_id IS NULL OR e.agency_id = kauro.current_agency_id())))
  WITH CHECK (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.aggregate_kind = 'outbound_execution_attempt' AND (e.agency_id IS NULL OR e.agency_id = kauro.current_agency_id())));

-- --- 7. the route timing the payment service judges (X2: declared_at + the window of the route version in force) --------------------------
DROP POLICY IF EXISTS bank_routes_payment_timing ON kauro.bank_routes;
CREATE POLICY bank_routes_payment_timing ON kauro.bank_routes FOR SELECT TO kauro_payment USING (true);
DROP POLICY IF EXISTS bank_route_versions_payment_timing ON kauro.bank_route_versions;
CREATE POLICY bank_route_versions_payment_timing ON kauro.bank_route_versions FOR SELECT TO kauro_payment USING (true);
GRANT SELECT (route_id, environment, account_ref, current_version) ON kauro.bank_routes TO kauro_payment;
GRANT SELECT (route_id, route_version, manual_execution_window_ms, coverage_lag_ms) ON kauro.bank_route_versions TO kauro_payment;

-- --- 8. the owner queue: the corporate owner reads the send details of the attempts (never the offers, never the evidence) ------------------
DROP POLICY IF EXISTS outbound_execution_attempts_owner_read ON kauro.outbound_execution_attempts;
CREATE POLICY outbound_execution_attempts_owner_read ON kauro.outbound_execution_attempts FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
DROP POLICY IF EXISTS refund_destinations_owner_read ON kauro.refund_destinations;
CREATE POLICY refund_destinations_owner_read ON kauro.refund_destinations FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
-- (agency_id, version: the event binding of the foundation reads them as the caller; a tenant sees no row, KA006)
GRANT SELECT (attempt_id, agency_id, version, kind, state, source_kind, refund_id, treasury_refund_id, reference, amount_cents, currency, declared_at) ON kauro.outbound_execution_attempts TO kauro_app;
GRANT SELECT (refund_id, treasury_refund_id, account_last4, holder_name) ON kauro.refund_destinations TO kauro_app;

-- --- 9. never COMPLETED without execution evidence ---------------------------------------------------------------------------------------
-- a manual-rail refund (one with a captured destination) completes only with a RECORDED RETURN attempt whose execution id it cites
CREATE OR REPLACE FUNCTION kauro.refunds_manual_completion_evidence() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF EXISTS (SELECT 1 FROM kauro.refund_destinations d WHERE d.refund_id = OLD.refund_id) AND NOT EXISTS (
    SELECT 1 FROM kauro.outbound_execution_attempts a
     WHERE a.refund_id = OLD.refund_id AND a.kind = 'RETURN' AND a.state = 'RECORDED' AND a.bank_execution_id = NEW.provider_refund_id
  ) THEN
    RAISE EXCEPTION 'EXECUTION_EVIDENCE_MISSING: refund % completes only with the recorded execution it cites', OLD.refund_id USING ERRCODE = 'KP014';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS refunds_manual_completion_evidence ON kauro.refunds;
CREATE TRIGGER refunds_manual_completion_evidence BEFORE UPDATE OF state ON kauro.refunds
  FOR EACH ROW WHEN (NEW.state = 'COMPLETED' AND OLD.state IS DISTINCT FROM 'COMPLETED') EXECUTE FUNCTION kauro.refunds_manual_completion_evidence();
-- a treasury refund completes only with a RECORDED attempt of its own
CREATE OR REPLACE FUNCTION kauro.treasury_refunds_completion_evidence() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM kauro.outbound_execution_attempts a WHERE a.treasury_refund_id = OLD.treasury_refund_id AND a.state = 'RECORDED') THEN
    RAISE EXCEPTION 'EXECUTION_EVIDENCE_MISSING: treasury refund % completes only with a recorded execution', OLD.treasury_refund_id USING ERRCODE = 'KP014';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS treasury_refunds_completion_evidence ON kauro.treasury_refunds;
CREATE TRIGGER treasury_refunds_completion_evidence BEFORE UPDATE OF state ON kauro.treasury_refunds
  FOR EACH ROW WHEN (NEW.state = 'COMPLETED' AND OLD.state IS DISTINCT FROM 'COMPLETED') EXECUTE FUNCTION kauro.treasury_refunds_completion_evidence();

-- =====================================================================================================================================
-- Slice 3: G3 RecordReturnBounce and X4 DeclareResendExecution (docs/design/ACH-ROUTE.md r12 §7.21-§7.22, DV1-08). A recorded transfer whose
-- money came back has one bounce row (once per transfer); the REFUND_PAYABLE O of a bounce is its cents less the RESEND attempts that are
-- RECORDED or still open. A RESEND attempt names its bounce (parent_bounce_id) and can never exceed it.
-- =====================================================================================================================================

-- --- 10. the bounce of a recorded transfer -----------------------------------------------------------------------------------------------
CREATE TABLE kauro.outbound_return_bounces (
  bounce_id            uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(bounce_id)),
  attempt_id           uuid NOT NULL UNIQUE,
  environment          text NOT NULL CHECK (environment IN ('SANDBOX', 'LIVE')),
  account_ref          text NOT NULL CHECK (kauro.is_provider_ref(account_ref)),
  source_kind          text NOT NULL CHECK (source_kind IN ('CAPTURE', 'BANK_CREDIT')),
  source_id            uuid NOT NULL,
  bounced_cents        bigint NOT NULL CHECK (kauro.is_money(bounced_cents) AND bounced_cents > 0),
  evidence_hash        text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  recorded_by          uuid NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT kauro.server_now(),
  CONSTRAINT outbound_return_bounces_attempt_fk FOREIGN KEY (attempt_id, source_kind, source_id)
    REFERENCES kauro.outbound_execution_attempts (attempt_id, source_kind, source_id)
);
ALTER TABLE kauro.outbound_return_bounces ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.outbound_return_bounces FORCE ROW LEVEL SECURITY;
CREATE POLICY outbound_return_bounces_service ON kauro.outbound_return_bounces FOR ALL TO kauro_payment USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON kauro.outbound_return_bounces TO kauro_payment;
DROP TRIGGER IF EXISTS outbound_return_bounces_append_only ON kauro.outbound_return_bounces;
CREATE TRIGGER outbound_return_bounces_append_only BEFORE UPDATE OR DELETE ON kauro.outbound_return_bounces FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
-- a bounce belongs to a RECORDED attempt and never exceeds what that attempt sent (B <= P)
CREATE OR REPLACE FUNCTION kauro.outbound_return_bounces_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM kauro.outbound_execution_attempts a WHERE a.attempt_id = NEW.attempt_id AND a.state = 'RECORDED' AND NEW.bounced_cents <= a.amount_cents) THEN
    RAISE EXCEPTION 'a bounce is recorded only for a RECORDED attempt and never above its amount (%)', NEW.attempt_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS outbound_return_bounces_guard ON kauro.outbound_return_bounces;
CREATE TRIGGER outbound_return_bounces_guard BEFORE INSERT ON kauro.outbound_return_bounces FOR EACH ROW EXECUTE FUNCTION kauro.outbound_return_bounces_guard();

-- --- 11. a RESEND names its bounce and never exceeds it ------------------------------------------------------------------------------------
ALTER TABLE kauro.outbound_execution_attempts DROP CONSTRAINT IF EXISTS outbound_attempts_parent_bounce_fk;
ALTER TABLE kauro.outbound_execution_attempts ADD CONSTRAINT outbound_attempts_parent_bounce_fk FOREIGN KEY (parent_bounce_id) REFERENCES kauro.outbound_return_bounces (bounce_id);
CREATE INDEX IF NOT EXISTS outbound_execution_attempts_by_bounce ON kauro.outbound_execution_attempts (parent_bounce_id) WHERE parent_bounce_id IS NOT NULL;
CREATE OR REPLACE FUNCTION kauro.outbound_resend_ceiling() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  ceiling bigint;
  spent bigint;
BEGIN
  SELECT b.bounced_cents INTO ceiling FROM kauro.outbound_return_bounces b WHERE b.bounce_id = NEW.parent_bounce_id;
  SELECT coalesce(sum(a.amount_cents), 0) INTO spent FROM kauro.outbound_execution_attempts a WHERE a.parent_bounce_id = NEW.parent_bounce_id AND a.state IN ('DECLARED', 'UNCERTAIN', 'RECORDED');
  IF ceiling IS NULL OR spent + NEW.amount_cents > ceiling THEN
    RAISE EXCEPTION 'a resend never exceeds the open payable of its bounce (%)', NEW.parent_bounce_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS outbound_resend_ceiling ON kauro.outbound_execution_attempts;
CREATE TRIGGER outbound_resend_ceiling BEFORE INSERT ON kauro.outbound_execution_attempts FOR EACH ROW WHEN (NEW.kind = 'RESEND') EXECUTE FUNCTION kauro.outbound_resend_ceiling();
