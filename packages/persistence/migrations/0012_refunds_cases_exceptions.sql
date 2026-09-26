-- 0012 — refunds, reconciliation cases, provider event exceptions, the quote's release guard and the scope index's key binding
-- (package B09).
--
-- Authority: 15 "Refund policy and calculation" (a customer request is recorded with project, reason, requested scope and current
-- processing/delivery state and is not itself permission for a provider transfer; a partial refund names the affected service
-- component and allocates tax consistently; the total refunded cannot exceed the confirmed captured amount minus earlier refunds
-- and relevant reversals; concurrent refund requests serialize that invariant), 15 "Exact representation and rounding" (a partial
-- refund allocates service and tax explicitly; summed allocations equal the total; any rounding remainder follows a deterministic
-- rule), 15 "Price and source expiry races" (otherwise refund and issue a new quote), 15 "Disputes and chargebacks", 08
-- "High-impact actions require recent step-up: ... significant refund", 08 "Corporate operators ... individually managed
-- corporate identities", COMMAND_CATALOGUE CMD031..CMD033 (CMD032 failure: "The total cannot exceed reconciled remaining capture;
-- a standing authorized policy must be referenced rather than invented"), 15 "Webhooks and reconciliation" (mismatch incidents; a
-- verified event no order can take is kept for review), TRANSITIONS "Cross-aggregate finalization" (capture confirmation can create
-- financial facts even when source expiry prevents execution; offer the documented reupload/reapproval or refund path), registry
-- contract Refund; scenarios S058, S059, R2-081, R2-140. Design: docs/design/B09-payments-fiscal.md (D-MACH-B5, D-MACH-B6,
-- D-REF-B1..B6, D-AUTHZ-B2, D-ING-B2, D-ING-B3, D-QUOTE-B4, D-DISPUTE-B1, D-SCOPE-B2, D-EVT-B3, D-BIND-B2).

-- --- refunds (platform machine Refund, D-MACH-B5) ---------------------------------------------------------------------------------------
-- A refund of one capture: requested by the agency (CUSTOMER_REQUEST, CMD031), by the reconciler for an overpayment
-- (EXCESS_CAPTURE, R2-140), or as Kauro's own remedy of a capture that can carry no entitlement (KAURO_REMEDY); reviewed by a
-- corporate owner who records the immutable intent (CMD032) or rejects it; executed by the payment service (CMD033). The request
-- keeps what was asked (proposed components, the agency's reason — a registry label, never copied into an event — and the delivery
-- phase at the time); the approval keeps what was authorized, by whom and under which authority. The approved components of every
-- committing refund of a capture (APPROVED, SUBMITTING, UNCERTAIN, COMPLETED) never exceed the capture's allocation, component by
-- component, and the tax component follows the service component cumulatively (KP003, KP012; READ COMMITTED only, KP009).
CREATE TABLE kauro.refunds (
  refund_id                   uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(refund_id)),
  agency_id                   uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id                  uuid NOT NULL,
  order_id                    uuid NOT NULL,
  capture_id                  uuid NOT NULL,
  provider                    text NOT NULL,
  environment                 text NOT NULL,
  version                     bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                       text NOT NULL DEFAULT 'REQUESTED' CHECK (state IN ('REQUESTED', 'APPROVED', 'SUBMITTING', 'UNCERTAIN', 'COMPLETED', 'FAILED', 'REJECTED')),
  origin                      text NOT NULL CHECK (origin IN ('CUSTOMER_REQUEST', 'EXCESS_CAPTURE', 'KAURO_REMEDY')),
  -- named: a refusal maps to the request field (sqlstate.ts LABEL_CONSTRAINT_FIELDS; B06 D-API-1, D-LABEL-1)
  reason_code                 text NOT NULL CONSTRAINT refunds_reason_code_label CHECK (kauro.is_label(reason_code)),
  evidence_ref                uuid,
  terms_hash                  text NOT NULL CHECK (kauro.is_sha256_hex(terms_hash)),
  delivery_phase              text NOT NULL CHECK (delivery_phase IN ('NO_AUTHORIZATION', 'PRE_EXECUTION', 'DURING_EXECUTION', 'POST_DELIVERY')),
  proposed_service_cents      bigint NOT NULL CHECK (kauro.is_money(proposed_service_cents)),
  proposed_tax_cents          bigint NOT NULL CHECK (kauro.is_money(proposed_tax_cents)),
  proposed_excess_cents       bigint NOT NULL CHECK (kauro.is_money(proposed_excess_cents)),
  requested_by_membership_id  uuid,
  requested_by_user_id        uuid,
  requested_at                timestamptz NOT NULL,
  approved_service_cents      bigint CHECK (approved_service_cents IS NULL OR kauro.is_money(approved_service_cents)),
  approved_tax_cents          bigint CHECK (approved_tax_cents IS NULL OR kauro.is_money(approved_tax_cents)),
  approved_excess_cents       bigint CHECK (approved_excess_cents IS NULL OR kauro.is_money(approved_excess_cents)),
  authorization_kind          text CHECK (authorization_kind IS NULL OR authorization_kind IN ('OWNER_STEP_UP', 'STANDING_POLICY')),
  authorization_proof_ref     uuid,
  authorization_policy_id     uuid REFERENCES kauro.refund_policies (policy_id),
  authorization_hash          text CHECK (authorization_hash IS NULL OR kauro.is_sha256_hex(authorization_hash)),
  effects_hash                text CHECK (effects_hash IS NULL OR kauro.is_sha256_hex(effects_hash)),
  credit_note_required        boolean,
  approved_by_user_id         uuid REFERENCES kauro.identities (user_id),
  approved_at                 timestamptz,
  rejection_code              text CHECK (rejection_code IS NULL OR kauro.is_token(rejection_code)),
  rejected_by_user_id         uuid REFERENCES kauro.identities (user_id),
  rejected_at                 timestamptz,
  provider_refund_id          text CHECK (provider_refund_id IS NULL OR kauro.is_provider_ref(provider_refund_id)),
  evidence_hash               text CHECK (evidence_hash IS NULL OR kauro.is_sha256_hex(evidence_hash)),
  completed_at                timestamptz,
  failure_code                text CHECK (failure_code IS NULL OR kauro.is_token(failure_code)),
  created_at                  timestamptz NOT NULL,
  updated_at                  timestamptz NOT NULL,
  UNIQUE (agency_id, refund_id),
  -- binding targets of payment_attempts_refund_fk, commerce_scopes_refund_fk and tax_documents_refund_fk
  CONSTRAINT refunds_order_binding UNIQUE (agency_id, refund_id, order_id),
  CONSTRAINT refunds_document_binding UNIQUE (agency_id, refund_id, order_id, capture_id),
  -- the refunded capture is a capture of the order, and the order is the project's, under the terms it was sold with
  FOREIGN KEY (agency_id, capture_id, order_id) REFERENCES kauro.capture_facts (agency_id, capture_id, order_id),
  CONSTRAINT refunds_order_fk FOREIGN KEY (agency_id, order_id, project_id, terms_hash, provider, environment)
    REFERENCES kauro.payment_orders (agency_id, order_id, project_id, terms_hash, provider, environment),
  -- the requesting member is the requesting identity's own membership of this agency
  CONSTRAINT refunds_requester_fk FOREIGN KEY (agency_id, requested_by_membership_id, requested_by_user_id) REFERENCES kauro.memberships (agency_id, membership_id, user_id),
  -- a step-up authorizing an approval is the approver's own proof (the key ignores the self-only policy on proofs, so it binds both)
  CONSTRAINT refunds_approver_proof_fk FOREIGN KEY (approved_by_user_id, authorization_proof_ref) REFERENCES kauro.assurance_proofs (user_id, proof_id),
  -- an agency request names its requester; a server-originated request (excess return, remedy) names none
  CONSTRAINT refunds_requester_by_origin CHECK (
    (origin = 'CUSTOMER_REQUEST') = (requested_by_membership_id IS NOT NULL) AND (requested_by_membership_id IS NULL) = (requested_by_user_id IS NULL)
  ),
  -- a customer request or a remedy proposes service and tax; an excess return proposes only the excess (R2-140)
  CONSTRAINT refunds_proposed_components CHECK (
    (origin = 'EXCESS_CAPTURE' AND proposed_service_cents = 0 AND proposed_tax_cents = 0 AND proposed_excess_cents > 0)
    OR (origin <> 'EXCESS_CAPTURE' AND proposed_excess_cents = 0)
  ),
  -- the immutable intent exists exactly from APPROVED on (a rejected request never had one), complete, positive, and naming one
  -- authority: the approver's step-up proof or a standing policy
  CONSTRAINT refunds_intent_present CHECK (
    (state IN ('REQUESTED', 'REJECTED')) = (approved_at IS NULL)
    AND (approved_at IS NULL) = (approved_service_cents IS NULL) AND (approved_at IS NULL) = (approved_tax_cents IS NULL)
    AND (approved_at IS NULL) = (approved_excess_cents IS NULL) AND (approved_at IS NULL) = (authorization_kind IS NULL)
    AND (approved_at IS NULL) = (authorization_hash IS NULL) AND (approved_at IS NULL) = (effects_hash IS NULL)
    AND (approved_at IS NULL) = (credit_note_required IS NULL) AND (approved_at IS NULL) = (approved_by_user_id IS NULL)
  ),
  CONSTRAINT refunds_intent_positive CHECK (approved_at IS NULL OR approved_service_cents + approved_tax_cents + approved_excess_cents > 0),
  CONSTRAINT refunds_intent_components CHECK (
    approved_at IS NULL
    OR (origin = 'EXCESS_CAPTURE' AND approved_service_cents = 0 AND approved_tax_cents = 0)
    OR (origin <> 'EXCESS_CAPTURE' AND approved_excess_cents = 0)
  ),
  CONSTRAINT refunds_intent_authority CHECK (
    (authorization_kind IS NULL AND authorization_proof_ref IS NULL AND authorization_policy_id IS NULL)
    OR (authorization_kind = 'OWNER_STEP_UP' AND authorization_proof_ref IS NOT NULL AND authorization_policy_id IS NULL)
    OR (authorization_kind = 'STANDING_POLICY' AND authorization_policy_id IS NOT NULL AND authorization_proof_ref IS NULL)
  ),
  -- a credit note follows a refunded service or tax component; an excess return needs none (D-FISC-B2)
  CONSTRAINT refunds_credit_note_rule CHECK (credit_note_required IS NULL OR credit_note_required = (approved_service_cents + approved_tax_cents > 0)),
  CONSTRAINT refunds_rejection CHECK (
    (state = 'REJECTED') = (rejected_at IS NOT NULL) AND (rejected_at IS NULL) = (rejection_code IS NULL) AND (rejected_at IS NULL) = (rejected_by_user_id IS NULL)
  ),
  CONSTRAINT refunds_completion CHECK ((state = 'COMPLETED') = (completed_at IS NOT NULL) AND (state <> 'COMPLETED' OR (provider_refund_id IS NOT NULL AND evidence_hash IS NOT NULL))),
  CONSTRAINT refunds_failure CHECK ((state = 'FAILED') = (failure_code IS NOT NULL))
);
-- one request of a capture awaits review at a time per origin (CMD031-RACE: a concurrent second customer request is
-- REFUND_REQUEST_OPEN; B09-F3, D-REF-B1): the reconciler's EXCESS_CAPTURE and KAURO_REMEDY requests of one capture coexist with
-- each other and with a customer request, so filing both in the transaction that records an overpaid capture whose subject no
-- longer binds never conflicts, and a repeated filing of the same origin is a no-op (INSERT ... ON CONFLICT DO NOTHING against
-- this index) that can never roll back the capture fact it follows (TRANSITIONS "it cannot ignore a real capture").
CREATE UNIQUE INDEX refunds_one_requested_per_origin ON kauro.refunds (agency_id, capture_id, origin) WHERE state = 'REQUESTED';
CREATE UNIQUE INDEX refunds_provider_identity ON kauro.refunds (provider, environment, provider_refund_id) WHERE provider_refund_id IS NOT NULL;
CREATE INDEX refunds_by_capture ON kauro.refunds (agency_id, capture_id, state);
CREATE TRIGGER refunds_touch BEFORE UPDATE ON kauro.refunds FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER refunds_version BEFORE UPDATE ON kauro.refunds FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER refunds_immutable BEFORE UPDATE ON kauro.refunds
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('refund_id,agency_id,project_id,order_id,capture_id,provider,environment,origin,reason_code,evidence_ref,terms_hash,delivery_phase,proposed_service_cents,proposed_tax_cents,proposed_excess_cents,requested_by_membership_id,requested_by_user_id,requested_at,created_at');
-- the intent, the rejection and the provider's refund identity are written once and never re-pointed (CMD032 "immutable refund intent")
CREATE TRIGGER refunds_learned_once BEFORE UPDATE ON kauro.refunds
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('approved_service_cents,approved_tax_cents,approved_excess_cents,authorization_kind,authorization_proof_ref,authorization_policy_id,authorization_hash,effects_hash,credit_note_required,approved_by_user_id,approved_at,rejection_code,rejected_by_user_id,rejected_at,provider_refund_id,completed_at');

-- The review of a request (REQUESTED -> APPROVED | REJECTED) is the act of the session's own corporate owner (D-CORP-B1,
-- D-AUTHZ-B2): an ACTIVE KAURO_OWNER grant, read after the grant's transition lock (KP007); never the identity that requested
-- the refund (segregation of duties, KP008); and a standing policy it cites must cover the refund in front of it — ACTIVE and
-- valid at the approval instant, for this origin, for the capture's current delivery phase, within a BOUNDED ceiling (KP010;
-- the domain's policyCovers also checks the FULL_REMAINING and EXCESS_ONLY amounts against the remaining balance).
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
    RAISE EXCEPTION 'CORPORATE_ROLE_MISSING: refund % is reviewed by a person', OLD.refund_id USING ERRCODE = 'KP007';
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
    -- the capture's current delivery phase (commerce/authority deliveryPhaseOf), read after the transition lock of the capture's
    -- live authorization (or of its latest one when none is live)
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
CREATE TRIGGER refunds_review_authority BEFORE UPDATE OF state ON kauro.refunds
  FOR EACH ROW WHEN (OLD.state = 'REQUESTED' AND NEW.state IN ('APPROVED', 'REJECTED')) EXECUTE FUNCTION kauro.refunds_review_authority();

-- The tax a capture keeps while `basis` of its allocated service is not refunded (D-REF-B6; B09-F6): the capture's whole allocated
-- tax while no service is refunded, nothing once no service basis remains, and in between the sale's reviewed rule applied once to
-- the remaining basis (RATE_HALF_UP: floor((basis x rate + 5000) / 10000), the quote's own rounding; ZERO_REVIEWED: zero), never
-- more than the tax the capture collected. A refund's tax component is the difference between this value before and after it,
-- so the tax refunded follows the service refunded cumulatively and a sequence of partial refunds ends at exactly the collected
-- tax with no rounding residue (15 "Exact representation and rounding"; the cumulative recomputation of reference/HASHING "For a
-- partial refund, compute new cumulative ... from the remaining service basis").
CREATE OR REPLACE FUNCTION kauro.refund_tax_remaining(allocated_service bigint, allocated_tax bigint, basis bigint, rule text, rate integer) RETURNS bigint
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$
  SELECT CASE
    WHEN basis >= allocated_service THEN allocated_tax
    WHEN basis <= 0 OR rule = 'ZERO_REVIEWED' THEN 0::bigint
    ELSE least(allocated_tax, kauro.round_half_up_bps(basis, rate))
  END
$$;

-- The commitment ceiling (D-REF-B3; 15 "concurrent refund requests serialize that invariant"): an approval commits its
-- components only while the capture is COMPLETED (a reversed capture's money went back through the chargeback) and every
-- committing refund of the capture together stays within its allocation, per component (KP003); and its tax component is exactly
-- the tax its service component releases under the sale's reviewed rule, given every committing refund before it (KP012,
-- D-REF-B6). The approvals of one capture take the exclusive commitment lock in turn, and each re-reads the others with a new
-- snapshot — so a second approval waits for the first and sees it — which only READ COMMITTED provides (KP009). The shared half of
-- the capture's transition lock orders the approval with a reversal in flight.
CREATE OR REPLACE FUNCTION kauro.refunds_commitment_ceiling() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  c record;
  booked record;
  sale record;
  basis_after bigint;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'COMMITMENT_ISOLATION: refund % is approved under READ COMMITTED only, so that its ceiling reads what committed while it waited', OLD.refund_id USING ERRCODE = 'KP009';
  END IF;
  PERFORM kauro.await_transition('kauro.capture_facts', OLD.capture_id::text);
  PERFORM pg_advisory_xact_lock(kauro.transition_key('kauro.capture_refunds', OLD.capture_id::text));
  SELECT f.status, f.allocated_service_cents, f.allocated_tax_cents, f.excess_cents INTO c
    FROM kauro.capture_facts f WHERE f.agency_id = OLD.agency_id AND f.capture_id = OLD.capture_id;
  IF c.status IS DISTINCT FROM 'COMPLETED' THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_REMAINING: capture % is not refundable (%)', OLD.capture_id, coalesce(c.status, 'not visible') USING ERRCODE = 'KP003';
  END IF;
  SELECT coalesce(sum(r.approved_service_cents), 0) AS service, coalesce(sum(r.approved_tax_cents), 0) AS tax, coalesce(sum(r.approved_excess_cents), 0) AS excess INTO booked
    FROM kauro.refunds r
   WHERE r.agency_id = OLD.agency_id AND r.capture_id = OLD.capture_id AND r.refund_id <> OLD.refund_id
     AND r.state IN ('APPROVED', 'SUBMITTING', 'UNCERTAIN', 'COMPLETED');
  IF booked.service + NEW.approved_service_cents > c.allocated_service_cents
     OR booked.tax + NEW.approved_tax_cents > c.allocated_tax_cents
     OR booked.excess + NEW.approved_excess_cents > c.excess_cents THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_REMAINING: refund % exceeds the remaining components of capture %', OLD.refund_id, OLD.capture_id USING ERRCODE = 'KP003';
  END IF;
  SELECT q.tax_rule, q.tax_rate_bps INTO sale
    FROM kauro.payment_orders o JOIN kauro.quotes q ON q.agency_id = o.agency_id AND q.quote_id = o.quote_id
   WHERE o.agency_id = OLD.agency_id AND o.order_id = OLD.order_id;
  basis_after := c.allocated_service_cents - booked.service - NEW.approved_service_cents;
  IF sale.tax_rule IS NULL OR NEW.approved_tax_cents IS DISTINCT FROM
     c.allocated_tax_cents - kauro.refund_tax_remaining(c.allocated_service_cents, c.allocated_tax_cents, basis_after, sale.tax_rule, sale.tax_rate_bps) - booked.tax THEN
    RAISE EXCEPTION 'REFUND_TAX_INCONSISTENT: the tax of refund % is not the tax its service releases under the sale''s reviewed rule', OLD.refund_id USING ERRCODE = 'KP012';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER refunds_commitment_ceiling BEFORE UPDATE OF state ON kauro.refunds
  FOR EACH ROW WHEN (OLD.state = 'REQUESTED' AND NEW.state = 'APPROVED') EXECUTE FUNCTION kauro.refunds_commitment_ceiling();
CREATE TRIGGER refunds_transition BEFORE UPDATE OF state ON kauro.refunds
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('Refund');
CREATE TRIGGER refunds_initial_state BEFORE INSERT ON kauro.refunds
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('Refund');
CREATE CONSTRAINT TRIGGER refunds_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.refunds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('refund', 'refund_id');
CREATE CONSTRAINT TRIGGER refunds_event_type_per_version AFTER INSERT OR UPDATE OF version ON kauro.refunds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_commerce_event_type('refund', 'refund_id', 'state');

-- A completed refund that leaves no service basis revokes the entitlement it paid for (CommercialAuthorization authority_revoked:
-- "Reversal or full service refund"), in the same transaction, checked at COMMIT. AUTHORITY_OUTLIVES_REVERSAL (KP006).
CREATE OR REPLACE FUNCTION kauro.full_service_refund_revokes_authority() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  allocated bigint;
  refunded bigint;
BEGIN
  SELECT f.allocated_service_cents INTO allocated FROM kauro.capture_facts f WHERE f.agency_id = NEW.agency_id AND f.capture_id = NEW.capture_id;
  SELECT coalesce(sum(r.approved_service_cents), 0) INTO refunded FROM kauro.refunds r
   WHERE r.agency_id = NEW.agency_id AND r.capture_id = NEW.capture_id AND r.state = 'COMPLETED';
  IF allocated > 0 AND refunded >= allocated AND EXISTS (
    SELECT 1 FROM kauro.commercial_authorizations a WHERE a.agency_id = NEW.agency_id AND a.capture_id = NEW.capture_id AND a.state <> 'REVOKED'
  ) THEN
    RAISE EXCEPTION 'AUTHORITY_OUTLIVES_REVERSAL: capture % is fully refunded while its authorization is still live', NEW.capture_id USING ERRCODE = 'KP006';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER refunds_full_service_revokes AFTER UPDATE OF state ON kauro.refunds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state = 'COMPLETED') EXECUTE FUNCTION kauro.full_service_refund_revokes_authority();

INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('Refund', 'REQUESTED');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('Refund', 'REQUESTED', 'APPROVED'),
  ('Refund', 'REQUESTED', 'REJECTED'),
  ('Refund', 'APPROVED', 'SUBMITTING'),
  ('Refund', 'APPROVED', 'FAILED'),
  ('Refund', 'SUBMITTING', 'COMPLETED'),
  ('Refund', 'SUBMITTING', 'UNCERTAIN'),
  ('Refund', 'SUBMITTING', 'APPROVED'),
  ('Refund', 'SUBMITTING', 'FAILED'),
  ('Refund', 'UNCERTAIN', 'COMPLETED'),
  ('Refund', 'UNCERTAIN', 'APPROVED'),
  ('Refund', 'UNCERTAIN', 'FAILED');

INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES ('refund', 'refunds', 'refund_id', 'B09');

-- a REFUND attempt refunds a capture of its own order (the order its refund was requested for)
ALTER TABLE kauro.payment_attempts ADD CONSTRAINT payment_attempts_refund_fk
  FOREIGN KEY (agency_id, refund_id, order_id) REFERENCES kauro.refunds (agency_id, refund_id, order_id);

-- --- the quote's release guard (Quote machine guards, D-MACH-B1; D-QUOTE-B4; B09-F2) ------------------------------------------------------
-- ACCEPTED_FOR_CHECKOUT -> EXPIRED | SUPERSEDED | WITHDRAWN. Under the quote's exclusive transition lock — a checkout or a capture
-- intent in flight holds the shared half, so the release waits for it and then reads, with a new snapshot, what it committed:
--  1. nothing of its purchase is in flight or uncertain ("pending attempts reconciled first"; 16 "Founding incentive": only a
--     proven absence of capture releases what the quote reserved);
--  2. a paid purchase re-bound to its replacement under the included source replacement is superseded by exactly that replacement
--     (D-QUOTE-B6);
--  3. otherwise the purchase is closed: no live entitlement of the quote, and every completed capture paying it (its orders'
--     captures, and a capture re-bound to it) has had its whole service and tax returned by completed refunds, or was reversed —
--     the remedy path of 15 "Price and source expiry races" ("otherwise refund and issue a new quote") and TRANSITIONS
--     "Cross-aggregate finalization" ("offer the documented reupload/reapproval or refund path"). A delivered or live purchase
--     keeps its quote: the project carries one purchased revision (16 "Billable unit and fairness"; Q-B09-15).
CREATE OR REPLACE FUNCTION kauro.quotes_release_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM pg_advisory_xact_lock(kauro.transition_key('kauro.quotes', OLD.quote_id::text));
  IF EXISTS (
    SELECT 1 FROM kauro.payment_orders o
     WHERE o.agency_id = OLD.agency_id AND o.quote_id = OLD.quote_id AND o.state IN ('CREATING', 'CAPTURING', 'CAPTURE_UNCERTAIN')
  ) OR EXISTS (
    SELECT 1 FROM kauro.capture_facts c JOIN kauro.payment_orders o ON o.agency_id = c.agency_id AND o.order_id = c.order_id
     WHERE o.agency_id = OLD.agency_id AND o.quote_id = OLD.quote_id AND c.status = 'PENDING'
  ) OR EXISTS (
    SELECT 1 FROM kauro.payment_attempts a JOIN kauro.payment_orders o ON o.agency_id = a.agency_id AND o.order_id = a.order_id
     WHERE o.agency_id = OLD.agency_id AND o.quote_id = OLD.quote_id AND a.operation IN ('CREATE_ORDER', 'CAPTURE')
       AND a.state IN ('PREPARED', 'DISPATCHING', 'PROVIDER_PENDING', 'UNCERTAIN')
  ) THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: quote % cannot leave ACCEPTED_FOR_CHECKOUT while a capture of it is in flight or uncertain', OLD.quote_id USING ERRCODE = 'KA008';
  END IF;
  IF NEW.state = 'SUPERSEDED' AND EXISTS (
    SELECT 1 FROM kauro.purchase_rebindings b
     WHERE b.agency_id = OLD.agency_id AND b.from_quote_id = OLD.quote_id AND b.to_quote_id = NEW.superseded_by_quote_id
  ) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM kauro.commercial_authorizations a WHERE a.agency_id = OLD.agency_id AND a.quote_id = OLD.quote_id AND a.state <> 'REVOKED'
  ) OR EXISTS (
    SELECT 1 FROM kauro.capture_facts c
     WHERE c.agency_id = OLD.agency_id AND c.status = 'COMPLETED'
       AND (
         c.order_id IN (SELECT o.order_id FROM kauro.payment_orders o WHERE o.agency_id = OLD.agency_id AND o.quote_id = OLD.quote_id)
         OR c.capture_id IN (SELECT b.capture_id FROM kauro.purchase_rebindings b WHERE b.agency_id = OLD.agency_id AND b.to_quote_id = OLD.quote_id)
       )
       AND EXISTS (
         SELECT 1 FROM (
           SELECT coalesce(sum(r.approved_service_cents), 0) AS service, coalesce(sum(r.approved_tax_cents), 0) AS tax
             FROM kauro.refunds r WHERE r.agency_id = c.agency_id AND r.capture_id = c.capture_id AND r.state = 'COMPLETED'
         ) returned
          WHERE returned.service < c.allocated_service_cents OR returned.tax < c.allocated_tax_cents
       )
  ) THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: quote % cannot leave ACCEPTED_FOR_CHECKOUT while its purchase stands (a live entitlement, or a completed capture not wholly refunded)', OLD.quote_id USING ERRCODE = 'KA008';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER quotes_release_guard BEFORE UPDATE OF state ON kauro.quotes
  FOR EACH ROW WHEN (OLD.state = 'ACCEPTED_FOR_CHECKOUT' AND NEW.state IS DISTINCT FROM OLD.state) EXECUTE FUNCTION kauro.quotes_release_guard();

-- --- reconciliation cases (platform machine ReconciliationCase, D-MACH-B6) --------------------------------------------------------------
-- A mismatch incident of an agency's payment (15 "record mismatch incidents"; S058 "raise the specific incident"; R2-140 the excess
-- obligation): an amount that differs from the obligation, an excess capture, a capture with no valid subject left, an uncertain
-- effect past its watchdog, an unrecognized provider state, a provider contradiction, a reversal, a fee mismatch (opened by the
-- settlement comparison of B15), or a dispute in progress whose funds the provider holds (DISPUTE_OPEN, D-DISPUTE-B1: the capture
-- stays COMPLETED and its entitlement live until the provider actually reverses it). A repeated observation adds history, never a
-- second open case of the same kind and subject. Opened by the payment service only (B09-F1); resolution is a reviewed decision of
-- the finance scope recorded once (no catalogue command in this package; open question Q-B09-3), and its event is the source of a
-- correcting ledger posting set (D-LEDGER-B4).
CREATE TABLE kauro.reconciliation_cases (
  case_id              uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(case_id)),
  agency_id            uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  order_id             uuid,
  capture_id           uuid,
  refund_id            uuid,
  kind                 text NOT NULL CHECK (kind IN ('AMOUNT_MISMATCH', 'EXCESS_CAPTURE', 'CAPTURE_WITHOUT_VALID_SUBJECT', 'UNCERTAIN_EFFECT', 'UNRECOGNIZED_PROVIDER_STATE', 'PROVIDER_INCONSISTENCY', 'REVERSAL', 'FEE_MISMATCH', 'DISPUTE_OPEN')),
  version              bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'RESOLVED')),
  detail_code          text NOT NULL CHECK (kauro.is_token(detail_code)),
  amount_cents         bigint CHECK (amount_cents IS NULL OR kauro.is_money(amount_cents)),
  currency             text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  evidence_hash        text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  opened_at            timestamptz NOT NULL,
  resolved_at          timestamptz,
  resolution_code      text CHECK (resolution_code IS NULL OR kauro.is_token(resolution_code)),
  resolved_by_user_id  uuid REFERENCES kauro.identities (user_id),
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  UNIQUE (agency_id, case_id),
  FOREIGN KEY (agency_id, order_id) REFERENCES kauro.payment_orders (agency_id, order_id),
  FOREIGN KEY (agency_id, capture_id) REFERENCES kauro.capture_facts (agency_id, capture_id),
  FOREIGN KEY (agency_id, refund_id) REFERENCES kauro.refunds (agency_id, refund_id),
  -- a case that names several subjects names one purchase: its capture is a capture of its order, its refund a refund of its order
  -- and of its capture (07 "Composite foreign keys"; B09-N6; each key applies when the columns it binds are all named)
  CONSTRAINT reconciliation_cases_capture_order_fk FOREIGN KEY (agency_id, capture_id, order_id) REFERENCES kauro.capture_facts (agency_id, capture_id, order_id),
  CONSTRAINT reconciliation_cases_refund_order_fk FOREIGN KEY (agency_id, refund_id, order_id) REFERENCES kauro.refunds (agency_id, refund_id, order_id),
  CONSTRAINT reconciliation_cases_refund_capture_fk FOREIGN KEY (agency_id, refund_id, order_id, capture_id) REFERENCES kauro.refunds (agency_id, refund_id, order_id, capture_id),
  CONSTRAINT reconciliation_cases_subject CHECK (num_nonnulls(order_id, capture_id, refund_id) >= 1),
  -- a dispute is about a capture and names the disputed amount (15 "Dispute records contain ... amount")
  CONSTRAINT reconciliation_cases_dispute_subject CHECK (kind <> 'DISPUTE_OPEN' OR (capture_id IS NOT NULL AND amount_cents IS NOT NULL)),
  CONSTRAINT reconciliation_cases_amount_currency CHECK ((amount_cents IS NULL) = (currency IS NULL)),
  CONSTRAINT reconciliation_cases_resolution CHECK (
    (state = 'RESOLVED') = (resolved_at IS NOT NULL) AND (resolved_at IS NULL) = (resolution_code IS NULL) AND (resolved_at IS NULL) = (resolved_by_user_id IS NULL)
  )
);
CREATE UNIQUE INDEX reconciliation_cases_one_open ON kauro.reconciliation_cases (
  agency_id, kind,
  coalesce(order_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(capture_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(refund_id, '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE state = 'OPEN';
CREATE INDEX reconciliation_cases_by_order ON kauro.reconciliation_cases (agency_id, order_id) WHERE order_id IS NOT NULL;
CREATE TRIGGER reconciliation_cases_touch BEFORE UPDATE ON kauro.reconciliation_cases FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER reconciliation_cases_version BEFORE UPDATE ON kauro.reconciliation_cases FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER reconciliation_cases_immutable BEFORE UPDATE ON kauro.reconciliation_cases
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('case_id,agency_id,order_id,capture_id,refund_id,kind,detail_code,amount_cents,currency,evidence_hash,opened_at,created_at');
CREATE TRIGGER reconciliation_cases_transition BEFORE UPDATE OF state ON kauro.reconciliation_cases
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('ReconciliationCase');
CREATE TRIGGER reconciliation_cases_initial_state BEFORE INSERT ON kauro.reconciliation_cases
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('ReconciliationCase');
CREATE CONSTRAINT TRIGGER reconciliation_cases_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.reconciliation_cases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('reconciliation_case', 'case_id');
CREATE CONSTRAINT TRIGGER reconciliation_cases_event_type_per_version AFTER INSERT OR UPDATE OF version ON kauro.reconciliation_cases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_commerce_event_type('reconciliation_case', 'case_id', 'state');

INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('ReconciliationCase', 'OPEN');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES ('ReconciliationCase', 'OPEN', 'RESOLVED');

INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES ('reconciliation_case', 'reconciliation_cases', 'case_id', 'B09');

-- --- provider event exceptions (platform; D-ING-B2, D-ING-B3; B09-F9) -------------------------------------------------------------------
-- An authenticated provider observation no order can take — an unknown provider reference, a provider, order, payee, currency or
-- environment that is not the order's (S058; the vocabulary is exactly the domain's CaptureMismatch plus the ingress's own kinds),
-- an unrecognized status, a conflicting body — is kept for the owner's finance review and never applied: no money, no commission,
-- no authority. The source is exactly one of: a verified webhook (its inbox record; it may name no agency when it could not be
-- attributed), a dispatch response of a stored operation (its attempt) or a stored provider query (its artifact) — the latter two
-- are attributed to the stored operation's order and agency, and a dispatch response's attempt is an attempt of exactly the order
-- the row names (provider_event_exceptions_attempt_fk; D-ING-B3, B09-N6). One row per source and kind; append-only.
ALTER TABLE kauro.inbox_records ADD CONSTRAINT inbox_records_provider_binding UNIQUE (inbox_id, provider, environment);

CREATE TABLE kauro.provider_event_exceptions (
  exception_id   uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(exception_id)),
  source         text NOT NULL CHECK (source IN ('WEBHOOK', 'DISPATCH_RESPONSE', 'PROVIDER_QUERY')),
  agency_id      uuid REFERENCES kauro.agencies (agency_id),
  order_id       uuid,
  inbox_id       uuid,
  attempt_id     uuid,
  artifact_ref   uuid,
  provider       text NOT NULL,
  environment    text NOT NULL CHECK (environment IN ('LOCAL', 'SANDBOX', 'LIVE')),
  kind           text NOT NULL CHECK (kind IN ('UNKNOWN_PROVIDER_REFERENCE', 'WRONG_PROVIDER', 'WRONG_ORDER', 'WRONG_PAYEE', 'WRONG_CURRENCY', 'WRONG_ENVIRONMENT', 'UNRECOGNIZED_PROVIDER_STATE', 'BODY_CONFLICT')),
  provider_ref   text CHECK (provider_ref IS NULL OR kauro.is_provider_ref(provider_ref)),
  amount_cents   bigint CHECK (amount_cents IS NULL OR kauro.is_money(amount_cents)),
  currency       text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  evidence_hash  text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  observed_at    timestamptz NOT NULL,
  created_at     timestamptz NOT NULL,
  CONSTRAINT provider_event_exceptions_webhook_once UNIQUE (inbox_id, kind),
  CONSTRAINT provider_event_exceptions_attempt_once UNIQUE (attempt_id, kind),
  CONSTRAINT provider_event_exceptions_artifact_once UNIQUE (artifact_ref, kind),
  FOREIGN KEY (inbox_id, provider, environment) REFERENCES kauro.inbox_records (inbox_id, provider, environment),
  FOREIGN KEY (agency_id, order_id) REFERENCES kauro.payment_orders (agency_id, order_id),
  CONSTRAINT provider_event_exceptions_attempt_fk FOREIGN KEY (agency_id, attempt_id, order_id) REFERENCES kauro.payment_attempts (agency_id, attempt_id, order_id),
  CONSTRAINT provider_event_exceptions_one_source CHECK (
    (source = 'WEBHOOK' AND inbox_id IS NOT NULL AND attempt_id IS NULL AND artifact_ref IS NULL)
    OR (source = 'DISPATCH_RESPONSE' AND attempt_id IS NOT NULL AND inbox_id IS NULL AND artifact_ref IS NULL)
    OR (source = 'PROVIDER_QUERY' AND artifact_ref IS NOT NULL AND inbox_id IS NULL AND attempt_id IS NULL)
  ),
  -- a stored operation's own observation is attributed to its order and agency; only a delivered event may be unattributable
  CONSTRAINT provider_event_exceptions_attribution CHECK ((agency_id IS NULL) = (order_id IS NULL) AND (source = 'WEBHOOK' OR agency_id IS NOT NULL)),
  -- a conflicting body and an unknown reference exist only for a delivered event
  CONSTRAINT provider_event_exceptions_webhook_kinds CHECK (kind NOT IN ('BODY_CONFLICT', 'UNKNOWN_PROVIDER_REFERENCE') OR source = 'WEBHOOK'),
  CONSTRAINT provider_event_exceptions_amount_currency CHECK ((amount_cents IS NULL) = (currency IS NULL))
);
CREATE TRIGGER provider_event_exceptions_append_only BEFORE UPDATE OR DELETE ON kauro.provider_event_exceptions
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- the scope index's key binding (B09-F11, D-SCOPE-B2) ---------------------------------------------------------------------------------
-- A provider key is the provider identity its object learned: PROVIDER_ORDER the order's "<provider>|<ENVIRONMENT>|<provider order
-- id>", PROVIDER_CAPTURE the capture's, PROVIDER_REFUND the refund's. Checked as the writer (the payment service, which alone
-- records provider keys and alone learns provider identities, B09-F1), so a row can never claim an identity its object did not
-- learn or name an object of another agency (the composite foreign keys).
ALTER TABLE kauro.commerce_scopes ADD CONSTRAINT commerce_scopes_refund_fk FOREIGN KEY (agency_id, refund_id, order_id) REFERENCES kauro.refunds (agency_id, refund_id, order_id);

CREATE OR REPLACE FUNCTION kauro.commerce_scopes_bind_key() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  expected text;
BEGIN
  IF NEW.scope_kind = 'PROVIDER_ORDER' THEN
    SELECT o.provider || '|' || o.environment || '|' || o.provider_order_id INTO expected
      FROM kauro.payment_orders o WHERE o.agency_id = NEW.agency_id AND o.order_id = NEW.order_id;
  ELSIF NEW.scope_kind = 'PROVIDER_CAPTURE' THEN
    SELECT c.provider || '|' || c.environment || '|' || c.provider_capture_id INTO expected
      FROM kauro.capture_facts c WHERE c.agency_id = NEW.agency_id AND c.capture_id = NEW.capture_id AND c.order_id = NEW.order_id;
  ELSIF NEW.scope_kind = 'PROVIDER_REFUND' THEN
    SELECT r.provider || '|' || r.environment || '|' || r.provider_refund_id INTO expected
      FROM kauro.refunds r WHERE r.agency_id = NEW.agency_id AND r.refund_id = NEW.refund_id AND r.order_id = NEW.order_id;
  ELSE
    RETURN NEW;
  END IF;
  IF expected IS NULL OR expected <> NEW.scope_key THEN
    RAISE EXCEPTION 'SCOPE_BINDING: a % scope key must be the provider identity its object learned', NEW.scope_kind
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commerce_scopes_bind_key', SCHEMA = 'kauro', TABLE = 'commerce_scopes';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commerce_scopes_bind_key BEFORE INSERT ON kauro.commerce_scopes FOR EACH ROW EXECUTE FUNCTION kauro.commerce_scopes_bind_key();

-- --- row-level security ------------------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.refunds FORCE ROW LEVEL SECURITY;
-- the agency reads its refunds and files its own requests (CMD031), as itself; it never reviews or executes one
CREATE POLICY refunds_tenant_read ON kauro.refunds FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY refunds_tenant_request ON kauro.refunds FOR INSERT TO kauro_app
  WITH CHECK (agency_id = kauro.current_agency_id() AND origin = 'CUSTOMER_REQUEST' AND state = 'REQUESTED' AND requested_by_user_id = kauro.current_user_id());
-- the corporate owner of the finance scope reads the agency's refunds and reviews a REQUESTED one (CMD032, or a rejection)
CREATE POLICY refunds_finance_read ON kauro.refunds FOR SELECT TO kauro_app USING (kauro.in_finance_scope(agency_id));
CREATE POLICY refunds_finance_review ON kauro.refunds FOR UPDATE TO kauro_app
  USING (kauro.in_finance_scope(agency_id) AND state = 'REQUESTED')
  WITH CHECK (kauro.in_finance_scope(agency_id) AND state IN ('APPROVED', 'REJECTED'));
-- the payment service files server-originated requests and executes approved refunds; it never reviews one
CREATE POLICY refunds_payment_read ON kauro.refunds FOR SELECT TO kauro_payment USING (agency_id = kauro.current_agency_id());
CREATE POLICY refunds_payment_request ON kauro.refunds FOR INSERT TO kauro_payment
  WITH CHECK (agency_id = kauro.current_agency_id() AND origin IN ('EXCESS_CAPTURE', 'KAURO_REMEDY') AND state = 'REQUESTED');
CREATE POLICY refunds_payment_execute ON kauro.refunds FOR UPDATE TO kauro_payment
  USING (agency_id = kauro.current_agency_id() AND state NOT IN ('REQUESTED', 'REJECTED'))
  WITH CHECK (agency_id = kauro.current_agency_id() AND state NOT IN ('REQUESTED', 'REJECTED'));

ALTER TABLE kauro.reconciliation_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.reconciliation_cases FORCE ROW LEVEL SECURITY;
-- the agency reads the cases of its payments; only the payment service opens one (every case follows a provider observation,
-- which the request handlers never apply; B09-F1); resolution is the finance scope's
CREATE POLICY reconciliation_cases_tenant_read ON kauro.reconciliation_cases FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY reconciliation_cases_finance_read ON kauro.reconciliation_cases FOR SELECT TO kauro_app USING (kauro.in_finance_scope(agency_id));
CREATE POLICY reconciliation_cases_finance_resolve ON kauro.reconciliation_cases FOR UPDATE TO kauro_app
  USING (kauro.in_finance_scope(agency_id) AND state = 'OPEN')
  WITH CHECK (kauro.in_finance_scope(agency_id) AND resolved_by_user_id = kauro.current_user_id());
CREATE POLICY reconciliation_cases_payment_read ON kauro.reconciliation_cases FOR SELECT TO kauro_payment USING (agency_id = kauro.current_agency_id());
CREATE POLICY reconciliation_cases_payment_open ON kauro.reconciliation_cases FOR INSERT TO kauro_payment
  WITH CHECK (agency_id = kauro.current_agency_id() AND state = 'OPEN');

ALTER TABLE kauro.provider_event_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.provider_event_exceptions FORCE ROW LEVEL SECURITY;
-- the payment service records a platform-level exception with no agency adopted, and an attributed one in the agency it adopted
CREATE POLICY provider_event_exceptions_payment ON kauro.provider_event_exceptions FOR ALL TO kauro_payment
  USING ((agency_id IS NULL AND kauro.current_agency_id() IS NULL) OR agency_id = kauro.current_agency_id())
  WITH CHECK ((agency_id IS NULL AND kauro.current_agency_id() IS NULL) OR agency_id = kauro.current_agency_id());
CREATE POLICY provider_event_exceptions_owner_read ON kauro.provider_event_exceptions FOR SELECT TO kauro_app USING (kauro.holds_corporate_role('KAURO_OWNER'));
CREATE POLICY provider_event_exceptions_control_read ON kauro.provider_event_exceptions FOR SELECT TO kauro_control USING (true);

-- --- grants -------------------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON kauro.refunds TO kauro_app;
GRANT UPDATE (version, state, approved_service_cents, approved_tax_cents, approved_excess_cents, authorization_kind, authorization_proof_ref, authorization_policy_id, authorization_hash, effects_hash, credit_note_required, approved_by_user_id, approved_at, rejection_code, rejected_by_user_id, rejected_at, updated_at)
  ON kauro.refunds TO kauro_app;
GRANT SELECT, INSERT ON kauro.refunds TO kauro_payment;
GRANT UPDATE (version, state, provider_refund_id, evidence_hash, completed_at, failure_code, updated_at) ON kauro.refunds TO kauro_payment;
GRANT SELECT ON kauro.reconciliation_cases TO kauro_app;
GRANT SELECT, INSERT ON kauro.reconciliation_cases TO kauro_payment;
GRANT UPDATE (version, state, resolved_at, resolution_code, resolved_by_user_id, updated_at) ON kauro.reconciliation_cases TO kauro_app;
GRANT SELECT, INSERT ON kauro.provider_event_exceptions TO kauro_payment;
GRANT SELECT ON kauro.provider_event_exceptions TO kauro_app, kauro_control;
