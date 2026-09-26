-- 0009 — payments foundation (package B09, payments and fiscal workflow): the payment service's runtime group, the finance
-- scope of a corporate operator, the payment service's read of the shared aggregate-kind registry (foundation 0008), the B09
-- event types, the platform configuration (merchant routes, fiscal issuer routes, corporate grants, standing refund policies),
-- the scope index, and the policies B09 adds to B06 tables for its two new principals.
--
-- Authority: 07 "Aggregate ownership" (Quote owns immutable commercial terms; PaymentOrder, PaymentAttempt, PaymentTransaction
-- and Refund own provider effects; CommercialAuthorization links valid payment and approved scope to one logical processing
-- entitlement; TaxDocument owns fiscal issuance and correction, independently from payment confirmation), 07 "Database
-- representation", 08 "Identity is not permission" and "Role and capability model" (a service account has only its technical
-- role; Private Owner has no automatic customer-record bypass; finance capability and customer-data support access are
-- separate), 08 "Database isolation", 14 "Identity matrix" (runtime service identities have only required database roles),
-- COMMAND_CATALOGUE "Shared execution contract" (service commands require a verified service identity, with scope derived from
-- the stored operation), 15 "Initial payment decision", "Accounting integration decision", "FiscalProfile", 19 "BusinessProfile
-- and legal facts". Design: docs/design/B09-payments-fiscal.md (D-CTX-B1, D-CTX-B2, D-SCOPE-B1, D-EVT-B1, D-ROUTE-B1,
-- D-CORP-B1, D-RPOL-B1, D-ING-B1). This file references only B05/B06 objects and the foundation's registry (0008), never a
-- table of a package built in parallel (FOUNDATION D-AGGK-5: B09 numbers its migrations 0009..0013 on its own branch; the
-- integrator renumbers the second package to merge).
--
-- SQLSTATE vocabulary added by B09 (a class of its own beside B06's KA0nn; sqlstate.ts maps each):
--   KP001 LEDGER_UNBALANCED          KP002 OBLIGATION_OVER_ALLOCATED   KP003 REFUND_EXCEEDS_REMAINING
--   KP004 AUTHORITY_WITHOUT_CAPTURE  KP005 FACT_REGRESSION             KP006 AUTHORITY_OUTLIVES_REVERSAL
--   KP007 CORPORATE_ROLE_MISSING     KP008 SELF_APPROVAL_FORBIDDEN     KP009 COMMITMENT_ISOLATION
--   KP010 POLICY_NOT_APPLICABLE      KP011 FISCAL_VALIDATION_REFUSED   KP012 REFUND_TAX_INCONSISTENT
--   KP013 REPLACEMENT_REFUSED

-- --- the payment service's runtime group (D-CTX-B1) ------------------------------------------------------------------------------
-- kauro_payment is the payment service: the executor of refunds and the reconciler (CMD033, CMD034), the consumer of payment
-- providers' inbox events (CMD030) and of the platform's own financial events (the ledger poster FINANCE, the fiscal drafter
-- FISCAL). It acts on one agency per transaction — the agency of the stored operation it adopted (kauro.agency_id) — or on
-- platform-level finance facts with no agency bound (settlements, exceptions), and it holds privileges on the commerce tables and
-- on the commercial prerequisites of B06 tables column by column: never on customer workspace content (a plan's body, a client's
-- label, a project's purpose), never a user id (it runs no browser command), never a membership.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kauro_payment') THEN
    CREATE ROLE kauro_payment NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kauro_payment' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)
  ) THEN
    RAISE EXCEPTION 'runtime roles must not be SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION (08 Database isolation)';
  END IF;
END
$$;
GRANT USAGE ON SCHEMA kauro TO kauro_payment;
-- readiness (14 "Monitoring and service health"): the payment service reads the migration ledger like the other serving roles
GRANT USAGE ON SCHEMA kauro_meta TO kauro_payment;
GRANT SELECT ON kauro_meta.schema_migrations TO kauro_payment;

-- --- helpers ----------------------------------------------------------------------------------------------------------------------
-- Money: BIGINT minor units, non-negative, bounded by the exactly representable JSON integer range so a value survives the
-- canonical profile, the event payloads and the MoneyMinorUnits wire strings (reference/HASHING_AND_ACCOUNTING_RULES "Exact
-- money"; D-MONEY-B1).
CREATE OR REPLACE FUNCTION kauro.is_money(v bigint) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT v >= 0 AND v <= 9007199254740991 $$;

-- The finance scope of a corporate operator (D-CTX-B2): kauro.finance_agency_id, bound transaction-locally by the commerce unit of
-- work of an OPERATOR context, never by a tenant or a service context. Missing or empty yields NULL (fail closed).
CREATE OR REPLACE FUNCTION kauro.current_finance_agency_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$ SELECT NULLIF(current_setting('kauro.finance_agency_id', true), '')::uuid $$;

-- A provider's own identifier (an order, capture, refund or document id; 10 "provider-specific ids are namespaced by environment
-- and account"): 1..256 characters of a conservative alphabet. PostgreSQL bounds a regular-expression repetition at 255, so the
-- length is checked on its own.
CREATE OR REPLACE FUNCTION kauro.is_provider_ref(v text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT length(v) BETWEEN 1 AND 256 AND v ~ '^[A-Za-z0-9._:-]+$' $$;

-- Distinct, NULL-free uuid arrays (PriceEligibilitySnapshot.qualifyingProjectIds: "Complete prior distinct ... project set").
CREATE OR REPLACE FUNCTION kauro.is_distinct_uuid_set(v uuid[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT array_position(v, NULL) IS NULL AND coalesce(array_ndims(v), 1) = 1 AND cardinality(v) = (SELECT count(DISTINCT x) FROM unnest(v) AS x) $$;

-- Listed transitions and birth states over a state column that is not named `state` (CaptureFact.status,
-- FiscalIssuerRoute.route_state): TG_ARGV[0] is the machine, TG_ARGV[1] the column. Same rules and SQLSTATE as B06's
-- kauro.enforce_listed_transition and kauro.enforce_initial_state (KA008).
CREATE OR REPLACE FUNCTION kauro.enforce_listed_transition_of() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  old_state text := to_jsonb(OLD) ->> TG_ARGV[1];
  new_state text := to_jsonb(NEW) ->> TG_ARGV[1];
BEGIN
  IF new_state IS DISTINCT FROM old_state AND NOT EXISTS (
    SELECT 1 FROM kauro.state_transitions t WHERE t.machine = TG_ARGV[0] AND t.from_state = old_state AND t.to_state = new_state
  ) THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: % % -> % is not a listed edge', TG_ARGV[0], old_state, new_state USING ERRCODE = 'KA008';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION kauro.enforce_initial_state_of() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  initial text;
  born text := to_jsonb(NEW) ->> TG_ARGV[1];
BEGIN
  SELECT m.initial_state INTO initial FROM kauro.state_machines m WHERE m.machine = TG_ARGV[0];
  IF initial IS NULL THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: machine % has no seeded initial state', TG_ARGV[0] USING ERRCODE = 'KA008';
  END IF;
  IF born IS DISTINCT FROM initial THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: a % is born %; its initial state is %', TG_ARGV[0], born, initial USING ERRCODE = 'KA008';
  END IF;
  RETURN NEW;
END
$$;

-- The birth of an observed fact (D-INIT-B1): a record of an external state the platform does not decide — a provider capture —
-- is born at the first step of its machine that its first authenticated observation shows: the initial state, or a state one
-- listed edge away from it (a capture first seen COMPLETED, DENIED or REVERSED had been PENDING at the provider). Anything
-- further is the same unlisted transition B06 refuses (KA008). TG_ARGV[0] is the machine, TG_ARGV[1] the state column.
CREATE OR REPLACE FUNCTION kauro.enforce_observed_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  initial text;
  born text := to_jsonb(NEW) ->> TG_ARGV[1];
BEGIN
  SELECT m.initial_state INTO initial FROM kauro.state_machines m WHERE m.machine = TG_ARGV[0];
  IF initial IS NULL THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: machine % has no seeded initial state', TG_ARGV[0] USING ERRCODE = 'KA008';
  END IF;
  IF born IS DISTINCT FROM initial AND NOT EXISTS (
    SELECT 1 FROM kauro.state_transitions t WHERE t.machine = TG_ARGV[0] AND t.from_state = initial AND t.to_state = born
  ) THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: an observed % is born % (initial %, and no listed edge leads there from it)', TG_ARGV[0], born, initial USING ERRCODE = 'KA008';
  END IF;
  RETURN NEW;
END
$$;

-- Columns learned once (a provider's own identifier, the instant a job consumed an entitlement, an approval's decision): NULL until
-- the fact is known, then never re-pointed. TG_ARGV[0] is a comma separated list of such columns.
CREATE OR REPLACE FUNCTION kauro.forbid_reassignment() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  col text;
  old_j jsonb := to_jsonb(OLD);
  new_j jsonb := to_jsonb(NEW);
BEGIN
  FOREACH col IN ARRAY string_to_array(TG_ARGV[0], ',') LOOP
    IF jsonb_typeof(old_j -> col) IS DISTINCT FROM 'null' AND (old_j -> col) IS DISTINCT FROM (new_j -> col) THEN
      RAISE EXCEPTION 'IMMUTABLE_COLUMN: %.% was learned once and cannot be re-pointed', TG_TABLE_NAME, col USING ERRCODE = 'KA004';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

-- --- the shared aggregate-kind registry (foundation migration 0008; FOUNDATION D-AGGK-1..D-AGGK-5; B09 D-EVT-B1) ------------------
-- The kinds are rows of kauro.aggregate_kinds, owned by the foundation (0008): this package never edits that table, its foreign
-- key or kauro.domain_events_bind_aggregate. Each B09 kind is registered with one INSERT by the migration that creates its table
-- (quote 0010; payment_order, payment_attempt, capture, commercial_authorization 0011; refund, reconciliation_case 0012;
-- tax_document 0013), after the table exists (aggregate_kinds_bind_catalog checks the table, its uuid key, agency_id and
-- version). The binding is SECURITY INVOKER, so the payment service — a runtime group that appends events (domain_events_payment
-- below) — reads the registry as itself: it gets SELECT and a read policy of its own here (FOUNDATION §4 and D-AGGK-3: never by
-- altering the foundation's aggregate_kinds_read). The request handlers (kauro_app, whose finance scope also appends commerce
-- events) already read it through the foundation's policy; the control plane appends no commerce event and reads nothing here.
GRANT SELECT ON kauro.aggregate_kinds TO kauro_payment;
CREATE POLICY aggregate_kinds_read_b09_payment ON kauro.aggregate_kinds FOR SELECT TO kauro_payment USING (true);

-- --- B09 event types (design §9; mirrored by @kauro/domain COMMERCE_EVENT_TYPES; the persistence test proves equality) --------------
-- event_types is FORCE ROW LEVEL SECURITY with read-only policies, so even its owner cannot insert: the vocabulary is extended by
-- lifting FORCE for this migration's own transaction (the runner applies each file in one transaction; nothing else observes the
-- lifted state) and restoring it before COMMIT.
ALTER TABLE kauro.event_types NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.event_types (event_type) VALUES
  ('quote.drafted.v1'), ('quote.issued.v1'), ('quote.accepted_for_checkout.v1'), ('quote.expired.v1'), ('quote.superseded.v1'),
  ('quote.withdrawn.v1'),
  ('payment_order.intent_created.v1'), ('payment_order.creating.v1'), ('payment_order.created.v1'), ('payment_order.approved.v1'),
  ('payment_order.capturing.v1'), ('payment_order.capture_uncertain.v1'), ('payment_order.captured.v1'), ('payment_order.failed.v1'),
  ('payment_order.cancelled.v1'), ('payment_order.expired.v1'),
  ('payment_attempt.prepared.v1'), ('payment_attempt.dispatching.v1'), ('payment_attempt.provider_pending.v1'),
  ('payment_attempt.confirmed.v1'), ('payment_attempt.failed_no_effect.v1'), ('payment_attempt.uncertain.v1'),
  ('payment_attempt.cancelled_before_dispatch.v1'),
  ('capture.pending.v1'), ('capture.completed.v1'), ('capture.denied.v1'), ('capture.reversed.v1'),
  -- a provider fact learned after the status (a fee, the availability of the funds) is a new capture version with an event of its
  -- own, never a second capture.completed.v1 (B09-F8, B09-F15; D-EVT-B2)
  ('capture.fee_observed.v1'), ('capture.funds_observed.v1'),
  ('commercial_authorization.issued.v1'), ('commercial_authorization.consumed.v1'), ('commercial_authorization.delivered.v1'),
  ('commercial_authorization.revoked.v1'),
  ('refund.requested.v1'), ('refund.approved.v1'), ('refund.rejected.v1'), ('refund.submitting.v1'), ('refund.uncertain.v1'),
  ('refund.completed.v1'), ('refund.failed.v1'),
  ('tax_document.drafted.v1'), ('tax_document.validated.v1'), ('tax_document.submitting.v1'), ('tax_document.issued.v1'),
  ('tax_document.uncertain.v1'), ('tax_document.rejected.v1'), ('tax_document.corrected.v1'),
  ('reconciliation_case.opened.v1'), ('reconciliation_case.resolved.v1');
ALTER TABLE kauro.event_types FORCE ROW LEVEL SECURITY;
CREATE POLICY event_types_payment_read ON kauro.event_types FOR SELECT TO kauro_payment USING (true);
GRANT SELECT ON kauro.event_types TO kauro_payment;
GRANT SELECT ON kauro.state_machines, kauro.state_transitions TO kauro_payment;

-- --- payment routes (platform; D-ROUTE-B1) ------------------------------------------------------------------------------------------
-- The receiving merchant of each provider and environment, fixed by server configuration (15 "Merchant identity and environment
-- are fixed by server configuration") and qualified before CreatePaymentOrder may use it ("live merchant/fiscal route is
-- qualified"). The payee is kept as the SHA-256 of the provider merchant id; captures compare against it (S058). A labelled
-- contract fake (D-FAKE-B1) can never be a LIVE route: nothing but the real provider can carry money.
CREATE TABLE kauro.payment_routes (
  route_id                        uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(route_id)),
  provider                        text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  environment                     text NOT NULL CHECK (environment IN ('SANDBOX', 'LIVE')),
  merchant_ref                    uuid NOT NULL,
  payee_digest                    text NOT NULL CHECK (kauro.is_sha256_hex(payee_digest)),
  currency                        text NOT NULL CHECK (currency IN ('USD')),
  integration_class               text NOT NULL CHECK (integration_class IN ('PROVIDER', 'CONTRACT_FAKE')),
  state                           text NOT NULL DEFAULT 'CONFIGURED' CHECK (state IN ('CONFIGURED', 'QUALIFIED', 'SUSPENDED')),
  qualification_evidence_hashes   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(qualification_evidence_hashes) = 'array'),
  valid_from                      timestamptz,
  created_at                      timestamptz NOT NULL,
  updated_at                      timestamptz NOT NULL,
  UNIQUE (provider, environment, merchant_ref),
  -- binding target of payment_orders: an order charges exactly the route's merchant, payee, currency and environment
  UNIQUE (route_id, provider, environment, merchant_ref, payee_digest, currency),
  CONSTRAINT payment_routes_fake_never_live CHECK (integration_class <> 'CONTRACT_FAKE' OR environment <> 'LIVE'),
  CONSTRAINT payment_routes_qualified_cites_evidence CHECK (
    state <> 'QUALIFIED' OR (jsonb_array_length(qualification_evidence_hashes) > 0 AND valid_from IS NOT NULL)
  )
);
-- CreatePaymentOrder reads exactly one qualified route per provider and environment
CREATE UNIQUE INDEX payment_routes_one_qualified ON kauro.payment_routes (provider, environment) WHERE state = 'QUALIFIED';
CREATE TRIGGER payment_routes_touch BEFORE UPDATE ON kauro.payment_routes FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER payment_routes_immutable BEFORE UPDATE ON kauro.payment_routes
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('route_id,provider,environment,merchant_ref,payee_digest,currency,integration_class,created_at');
CREATE TRIGGER payment_routes_transition BEFORE UPDATE OF state ON kauro.payment_routes
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('PaymentRoute');
CREATE TRIGGER payment_routes_initial_state BEFORE INSERT ON kauro.payment_routes
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('PaymentRoute');
-- a checkout relies on its route being qualified when the intent commits (B06 D-TX-2): a suspension issued while a checkout is in
-- flight waits for it, and checkouts arriving after a queued suspension wait behind it and read it
CREATE TRIGGER payment_routes_transition_lock BEFORE UPDATE OF state ON kauro.payment_routes
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.take_transition_lock('kauro.payment_routes', 'provider', 'environment');
INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('PaymentRoute', 'CONFIGURED');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('PaymentRoute', 'CONFIGURED', 'QUALIFIED'),
  ('PaymentRoute', 'CONFIGURED', 'SUSPENDED'),
  ('PaymentRoute', 'QUALIFIED', 'SUSPENDED');

-- --- fiscal issuer routes (platform; D-ROUTE-B1) ---------------------------------------------------------------------------------------
-- The actual contracting and invoicing entity (FiscalProfile.operatorLegalRef) and its issuance route: a verified provider API or
-- the lawful manual-assisted bridge (15 "Accounting integration decision"). Legal facts carry the status vocabulary of 19
-- "BusinessProfile and legal facts"; a route is QUALIFIED only with observed or professionally confirmed facts, a numbering
-- authorization and verified issuance entitlement (R2-083: a public price page is not entitlement).
CREATE TABLE kauro.fiscal_issuers (
  issuer_ref                      uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(issuer_ref)),
  jurisdiction                    text NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  legal_identity_hash             text NOT NULL CHECK (kauro.is_sha256_hex(legal_identity_hash)),
  legal_fact_status               text NOT NULL CHECK (legal_fact_status IN ('OBSERVED', 'OWNER_DECLARED', 'PROFESSIONALLY_CONFIRMED', 'PENDING', 'EXPIRED')),
  route_kind                      text NOT NULL CHECK (route_kind IN ('PROVIDER_API', 'MANUAL_BRIDGE')),
  integration_class               text NOT NULL CHECK (integration_class IN ('PROVIDER', 'CONTRACT_FAKE')),
  route_state                     text NOT NULL DEFAULT 'CONFIGURED' CHECK (route_state IN ('CONFIGURED', 'QUALIFIED', 'SUSPENDED')),
  numbering_authorization_ref     text CHECK (numbering_authorization_ref IS NULL OR numbering_authorization_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  entitlement_evidence_hash       text CHECK (entitlement_evidence_hash IS NULL OR kauro.is_sha256_hex(entitlement_evidence_hash)),
  qualification_evidence_hashes   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(qualification_evidence_hashes) = 'array'),
  valid_from                      timestamptz,
  valid_until                     timestamptz,
  created_at                      timestamptz NOT NULL,
  updated_at                      timestamptz NOT NULL,
  CONSTRAINT fiscal_issuers_qualified_route CHECK (
    route_state <> 'QUALIFIED'
    OR (legal_fact_status IN ('OBSERVED', 'PROFESSIONALLY_CONFIRMED') AND numbering_authorization_ref IS NOT NULL
        AND entitlement_evidence_hash IS NOT NULL AND jsonb_array_length(qualification_evidence_hashes) > 0 AND valid_from IS NOT NULL)
  ),
  -- a labelled contract fake stands only for a provider API (D-FAKE-B1); a manual-assisted bridge is a human procedure, never faked
  CONSTRAINT fiscal_issuers_fake_is_provider_api CHECK (integration_class <> 'CONTRACT_FAKE' OR route_kind = 'PROVIDER_API'),
  CONSTRAINT fiscal_issuers_validity CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from)
);
CREATE UNIQUE INDEX fiscal_issuers_one_qualified ON kauro.fiscal_issuers (jurisdiction) WHERE route_state = 'QUALIFIED';
CREATE TRIGGER fiscal_issuers_touch BEFORE UPDATE ON kauro.fiscal_issuers FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER fiscal_issuers_immutable BEFORE UPDATE ON kauro.fiscal_issuers
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('issuer_ref,jurisdiction,legal_identity_hash,route_kind,integration_class,created_at');
CREATE TRIGGER fiscal_issuers_transition BEFORE UPDATE OF route_state ON kauro.fiscal_issuers
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition_of('FiscalIssuerRoute', 'route_state');
CREATE TRIGGER fiscal_issuers_initial_state BEFORE INSERT ON kauro.fiscal_issuers
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state_of('FiscalIssuerRoute', 'route_state');
CREATE TRIGGER fiscal_issuers_transition_lock BEFORE UPDATE OF route_state ON kauro.fiscal_issuers
  FOR EACH ROW WHEN (OLD.route_state IS DISTINCT FROM NEW.route_state) EXECUTE FUNCTION kauro.take_transition_lock('kauro.fiscal_issuers', 'issuer_ref');
INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('FiscalIssuerRoute', 'CONFIGURED');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('FiscalIssuerRoute', 'CONFIGURED', 'QUALIFIED'),
  ('FiscalIssuerRoute', 'CONFIGURED', 'SUSPENDED'),
  ('FiscalIssuerRoute', 'QUALIFIED', 'SUSPENDED');

-- --- corporate grants (platform; D-CORP-B1) --------------------------------------------------------------------------------------------
-- The corporate authority of an individually managed corporate identity (08 "Corporate operators and sellers use individually
-- managed corporate identities"; "A corporate login does not grant customer-data access"). KAURO_OWNER is the catalogue role of
-- ApproveRefund (CMD032; the registry's owner role under the brand of amendment A2); later packages add their corporate roles to the CHECK. The
-- control plane provisions grants; a person reads only their own; the database reads them for every finance-scoped row
-- (kauro.holds_corporate_role). A revocation takes the grant's transition lock (B06 D-TX-2): it waits for an operator's command in
-- flight, and one committed first is what the command's authorizer reads.
CREATE TABLE kauro.corporate_roles (
  grant_id       uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(grant_id)),
  user_id        uuid NOT NULL REFERENCES kauro.identities (user_id),
  role           text NOT NULL CHECK (role IN ('KAURO_OWNER')),
  state          text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'REVOKED')),
  evidence_hash  text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  granted_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  CONSTRAINT corporate_roles_revoked_binding CHECK ((state = 'REVOKED') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX corporate_roles_one_active ON kauro.corporate_roles (user_id, role) WHERE state = 'ACTIVE';
CREATE TRIGGER corporate_roles_touch BEFORE UPDATE ON kauro.corporate_roles FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER corporate_roles_immutable BEFORE UPDATE ON kauro.corporate_roles
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('grant_id,user_id,role,evidence_hash,granted_at,created_at');
CREATE TRIGGER corporate_roles_transition BEFORE UPDATE OF state ON kauro.corporate_roles
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('CorporateGrant');
CREATE TRIGGER corporate_roles_initial_state BEFORE INSERT ON kauro.corporate_roles
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('CorporateGrant');
CREATE TRIGGER corporate_roles_transition_lock BEFORE UPDATE OF state ON kauro.corporate_roles
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.take_transition_lock('kauro.corporate_roles', 'user_id');
INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('CorporateGrant', 'ACTIVE');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES ('CorporateGrant', 'ACTIVE', 'REVOKED');

-- The session's own ACTIVE grant of a corporate role (SECURITY INVOKER: evaluated under the caller's own policies, so it finds
-- only the caller's grants, and a runtime role with no policy on corporate_roles — the payment service — never holds one).
CREATE OR REPLACE FUNCTION kauro.holds_corporate_role(wanted text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$
  SELECT kauro.current_user_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM kauro.corporate_roles g WHERE g.user_id = kauro.current_user_id() AND g.role = wanted AND g.state = 'ACTIVE'
  )
$$;

-- A commerce row is in the finance scope of an OPERATOR when its agency is the adopted finance agency and the session's person
-- holds an ACTIVE KAURO_OWNER grant; nothing of B06 keys on this scope, so the agency's customer rows stay invisible to it.
CREATE OR REPLACE FUNCTION kauro.in_finance_scope(target uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$ SELECT coalesce(target = kauro.current_finance_agency_id(), false) AND kauro.holds_corporate_role('KAURO_OWNER') $$;

-- --- standing refund policies (platform; D-RPOL-B1) --------------------------------------------------------------------------------------
-- CMD032 failure: "a standing authorized policy must be referenced rather than invented". A policy is a reviewed, versioned,
-- step-up-authorized record with explicit applicability (origin, delivery phase, scope); ApproveRefund may cite it instead of a
-- fresh step-up only when it covers the refund in front of it (commerce/refunds policyCovers).
CREATE TABLE kauro.refund_policies (
  policy_id               uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(policy_id)),
  policy_kind             text NOT NULL CHECK (policy_kind IN ('PRE_EXECUTION_CANCELLATION', 'UNREMEDIED_KAURO_DEFECT', 'EXCESS_CAPTURE_RETURN')),
  policy_version          text NOT NULL CHECK (policy_version ~ '^[A-Z][A-Z0-9_.-]{0,63}$'),
  refund_scope            text NOT NULL CHECK (refund_scope IN ('FULL_REMAINING', 'EXCESS_ONLY', 'BOUNDED')),
  max_refund_cents        bigint CHECK (max_refund_cents IS NULL OR (kauro.is_money(max_refund_cents) AND max_refund_cents > 0)),
  applies_to_phase        text NOT NULL CHECK (applies_to_phase IN ('PRE_EXECUTION', 'ANY')),
  applies_to_origin       text NOT NULL CHECK (applies_to_origin IN ('CUSTOMER_REQUEST', 'EXCESS_CAPTURE', 'KAURO_REMEDY')),
  conditions_hash         text NOT NULL CHECK (kauro.is_sha256_hex(conditions_hash)),
  authorized_by_user_id   uuid NOT NULL REFERENCES kauro.identities (user_id),
  authorization_proof_ref uuid NOT NULL,
  state                   text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'RETIRED')),
  valid_from              timestamptz NOT NULL,
  valid_until             timestamptz,
  retired_at              timestamptz,
  created_at              timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL,
  UNIQUE (policy_kind, policy_version),
  -- the step-up that authorized the policy is the authorizing owner's own (08 "Granting a capability is itself an owner action")
  CONSTRAINT refund_policies_authorization_proof_fk FOREIGN KEY (authorized_by_user_id, authorization_proof_ref) REFERENCES kauro.assurance_proofs (user_id, proof_id),
  CONSTRAINT refund_policies_bounded_has_max CHECK ((refund_scope = 'BOUNDED') = (max_refund_cents IS NOT NULL)),
  CONSTRAINT refund_policies_excess_scope CHECK ((refund_scope = 'EXCESS_ONLY') = (applies_to_origin = 'EXCESS_CAPTURE')),
  CONSTRAINT refund_policies_retired_binding CHECK ((state = 'RETIRED') = (retired_at IS NOT NULL)),
  CONSTRAINT refund_policies_validity CHECK (valid_until IS NULL OR valid_until > valid_from)
);
CREATE TRIGGER refund_policies_touch BEFORE UPDATE ON kauro.refund_policies FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER refund_policies_immutable BEFORE UPDATE ON kauro.refund_policies
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('policy_id,policy_kind,policy_version,refund_scope,max_refund_cents,applies_to_phase,applies_to_origin,conditions_hash,authorized_by_user_id,authorization_proof_ref,valid_from,created_at');
CREATE TRIGGER refund_policies_transition BEFORE UPDATE OF state ON kauro.refund_policies
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('RefundPolicy');
CREATE TRIGGER refund_policies_initial_state BEFORE INSERT ON kauro.refund_policies
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('RefundPolicy');
INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('RefundPolicy', 'ACTIVE');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES ('RefundPolicy', 'ACTIVE', 'RETIRED');

-- --- scope index (D-SCOPE-B1) ---------------------------------------------------------------------------------------------------------------
-- Maps a stored operation (a payment order, a refund) or a provider identity (order, capture, refund id, namespaced by provider and
-- environment) to its agency. Rows hold identifiers only. They are written in the transaction that creates the object or learns
-- the identity, by that transaction's own scope; the payment service reads them to adopt the one agency of the operation it acts
-- on (the catalogue's "scope derived from the stored operation"), a corporate owner reads the refund rows to adopt the finance
-- scope of the refund it reviews; nobody updates or deletes them, and a provider identity maps to exactly one agency (PaymentOrder
-- invariant "order identity cannot migrate between tenants").
--
-- Every row is bound to the object it indexes (B09-F11): it names its order, and its capture or refund by kind; the composite
-- foreign keys to payment_orders, capture_facts and refunds (agency in the key, so a row can never point into another agency)
-- are added by the migrations that create those tables (0011, 0012), and a provider key must be the provider identity that object
-- actually learned (commerce_scopes_bind_key, 0012). A platform key is the object's own id (commerce_scopes_platform_key).
CREATE TABLE kauro.commerce_scopes (
  scope_kind  text NOT NULL CHECK (scope_kind IN ('PAYMENT_ORDER', 'REFUND', 'PROVIDER_ORDER', 'PROVIDER_CAPTURE', 'PROVIDER_REFUND')),
  scope_key   text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 400),
  agency_id   uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  order_id    uuid NOT NULL,
  capture_id  uuid,
  refund_id   uuid,
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (scope_kind, scope_key),
  -- platform ids are the uuid itself; provider ids are "<provider>|<ENVIRONMENT>|<external id>"
  CONSTRAINT commerce_scopes_key_shape CHECK (
    (scope_kind IN ('PAYMENT_ORDER', 'REFUND') AND scope_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    OR (scope_kind IN ('PROVIDER_ORDER', 'PROVIDER_CAPTURE', 'PROVIDER_REFUND') AND scope_key ~ '^[a-z][a-z0-9_-]{1,63}\|(SANDBOX|LIVE)\|[A-Za-z0-9._:-]+$')
  ),
  -- the subject each kind names: an order (PAYMENT_ORDER, PROVIDER_ORDER), a capture of it, or a refund of it
  CONSTRAINT commerce_scopes_subject CHECK (
    (scope_kind IN ('PAYMENT_ORDER', 'PROVIDER_ORDER') AND capture_id IS NULL AND refund_id IS NULL)
    OR (scope_kind = 'PROVIDER_CAPTURE' AND capture_id IS NOT NULL AND refund_id IS NULL)
    OR (scope_kind IN ('REFUND', 'PROVIDER_REFUND') AND refund_id IS NOT NULL AND capture_id IS NULL)
  ),
  CONSTRAINT commerce_scopes_platform_key CHECK (
    (scope_kind = 'PAYMENT_ORDER' AND scope_key = order_id::text)
    OR (scope_kind = 'REFUND' AND scope_key = refund_id::text)
    OR scope_kind IN ('PROVIDER_ORDER', 'PROVIDER_CAPTURE', 'PROVIDER_REFUND')
  )
);
CREATE INDEX commerce_scopes_by_agency ON kauro.commerce_scopes (agency_id, scope_kind);
CREATE TRIGGER commerce_scopes_append_only BEFORE UPDATE OR DELETE ON kauro.commerce_scopes
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- row-level security of the B09 platform tables ---------------------------------------------------------------------------------------------
ALTER TABLE kauro.payment_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.payment_routes FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_routes_read ON kauro.payment_routes FOR SELECT TO kauro_app, kauro_payment USING (true);
CREATE POLICY payment_routes_control ON kauro.payment_routes FOR ALL TO kauro_control USING (true) WITH CHECK (true);

ALTER TABLE kauro.fiscal_issuers ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.fiscal_issuers FORCE ROW LEVEL SECURITY;
CREATE POLICY fiscal_issuers_read ON kauro.fiscal_issuers FOR SELECT TO kauro_app, kauro_payment USING (true);
CREATE POLICY fiscal_issuers_control ON kauro.fiscal_issuers FOR ALL TO kauro_control USING (true) WITH CHECK (true);

ALTER TABLE kauro.corporate_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.corporate_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY corporate_roles_self_read ON kauro.corporate_roles FOR SELECT TO kauro_app USING (user_id = kauro.current_user_id());
CREATE POLICY corporate_roles_control ON kauro.corporate_roles FOR ALL TO kauro_control USING (true) WITH CHECK (true);

ALTER TABLE kauro.refund_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.refund_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY refund_policies_read ON kauro.refund_policies FOR SELECT TO kauro_app, kauro_payment USING (true);
CREATE POLICY refund_policies_control ON kauro.refund_policies FOR ALL TO kauro_control USING (true) WITH CHECK (true);

ALTER TABLE kauro.commerce_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.commerce_scopes FORCE ROW LEVEL SECURITY;
-- The request handlers record only the platform ids of the operations they create (CMD028's order, CMD031's refund); a provider
-- identity is learned only from an authenticated provider result, which only the payment service applies (B09-F1, B09-F11). The
-- payment service records the provider identities and the refunds it files (EXCESS_CAPTURE, KAURO_REMEDY), never an order.
CREATE POLICY commerce_scopes_tenant_read ON kauro.commerce_scopes FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY commerce_scopes_tenant_record ON kauro.commerce_scopes FOR INSERT TO kauro_app
  WITH CHECK (agency_id = kauro.current_agency_id() AND scope_kind IN ('PAYMENT_ORDER', 'REFUND'));
CREATE POLICY commerce_scopes_operator_read ON kauro.commerce_scopes FOR SELECT TO kauro_app
  USING (scope_kind = 'REFUND' AND kauro.holds_corporate_role('KAURO_OWNER'));
CREATE POLICY commerce_scopes_payment_read ON kauro.commerce_scopes FOR SELECT TO kauro_payment USING (true);
CREATE POLICY commerce_scopes_payment_record ON kauro.commerce_scopes FOR INSERT TO kauro_payment
  WITH CHECK (agency_id = kauro.current_agency_id() AND scope_kind IN ('REFUND', 'PROVIDER_ORDER', 'PROVIDER_CAPTURE', 'PROVIDER_REFUND'));
CREATE POLICY commerce_scopes_control ON kauro.commerce_scopes FOR SELECT TO kauro_control USING (true);

-- --- policies and grants B09 adds to B06 tables -------------------------------------------------------------------------------------------------
-- The payment service records the events, outbox rows and journal entries of the commerce aggregates of the one agency it
-- adopted; a corporate operator records those of its finance scope. Neither can write an event of a B06 aggregate.
CREATE POLICY domain_events_payment ON kauro.domain_events FOR ALL TO kauro_payment
  USING (agency_id = kauro.current_agency_id()
         AND aggregate_kind IN ('quote', 'payment_order', 'payment_attempt', 'capture', 'commercial_authorization', 'refund', 'tax_document', 'reconciliation_case'))
  WITH CHECK (agency_id = kauro.current_agency_id()
         AND aggregate_kind IN ('quote', 'payment_order', 'payment_attempt', 'capture', 'commercial_authorization', 'refund', 'tax_document', 'reconciliation_case'));
CREATE POLICY domain_events_finance ON kauro.domain_events FOR ALL TO kauro_app
  USING (kauro.in_finance_scope(agency_id)
         AND aggregate_kind IN ('quote', 'payment_order', 'payment_attempt', 'capture', 'commercial_authorization', 'refund', 'tax_document', 'reconciliation_case'))
  WITH CHECK (kauro.in_finance_scope(agency_id)
         AND aggregate_kind IN ('quote', 'payment_order', 'payment_attempt', 'capture', 'commercial_authorization', 'refund', 'tax_document', 'reconciliation_case'));
CREATE POLICY outbox_records_payment ON kauro.outbox_records FOR ALL TO kauro_payment
  USING (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id = kauro.current_agency_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id = kauro.current_agency_id()));
CREATE POLICY outbox_records_finance ON kauro.outbox_records FOR ALL TO kauro_app
  USING (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND kauro.in_finance_scope(e.agency_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND kauro.in_finance_scope(e.agency_id)));
-- a service command's journal entry is the service's, in the adopted agency (10 "trusted system actor, agency, operation, key")
CREATE POLICY command_journal_payment ON kauro.command_journal FOR ALL TO kauro_payment
  USING (agency_id = kauro.current_agency_id() AND actor_kind = 'SERVICE')
  WITH CHECK (agency_id = kauro.current_agency_id() AND actor_kind = 'SERVICE');
-- the payment service's own authorization facts: a service stream (no agency, actor SERVICE; D-FACT-B1)
CREATE POLICY security_events_payment_write ON kauro.security_events FOR INSERT TO kauro_payment
  WITH CHECK (agency_id IS NULL AND actor_kind = 'SERVICE' AND outcome IN ('ALLOW', 'DENY'));
-- the provider ingress records its own authentication decisions on CMD030 (08 "Threat model and assets": "provider webhook to
-- inbox" is a trust boundary, and "Every boundary has a schema, identity, authorization predicate, replay behavior and audit
-- event"): the
-- acceptance of an authenticated provider event (actor SERVICE, the provider label) and the denial of a delivery whose signature,
-- freshness or environment does not verify (ANONYMOUS: an unverified sender is nobody); never an agency's stream (D-FACT-B1)
CREATE POLICY security_events_ingress_write ON kauro.security_events FOR INSERT TO kauro_ingress
  WITH CHECK (
    agency_id IS NULL AND requested_agency_id IS NULL AND action = 'CMD030'
    AND ((actor_kind = 'SERVICE' AND outcome IN ('ALLOW', 'DENY')) OR (actor_kind = 'ANONYMOUS' AND outcome = 'DENY'))
  );

-- The payment service is the consumer of the payment providers' inbox events (D-ING-B1): it settles a record in the transaction
-- that applies it, under the B06 guards (a record with a conflicting delivery is never APPLIED, KA012; settled states are final,
-- KA007; APPLIED only under READ COMMITTED). It sees the records and conflicts of providers that have a merchant route, and
-- changes only the consumer columns.
CREATE POLICY inbox_records_payment_read ON kauro.inbox_records FOR SELECT TO kauro_payment
  USING (EXISTS (SELECT 1 FROM kauro.payment_routes r WHERE r.provider = inbox_records.provider));
CREATE POLICY inbox_records_payment_settle ON kauro.inbox_records FOR UPDATE TO kauro_payment
  USING (EXISTS (SELECT 1 FROM kauro.payment_routes r WHERE r.provider = inbox_records.provider))
  WITH CHECK (EXISTS (SELECT 1 FROM kauro.payment_routes r WHERE r.provider = inbox_records.provider));
CREATE POLICY inbox_body_conflicts_payment_read ON kauro.inbox_body_conflicts FOR SELECT TO kauro_payment
  USING (EXISTS (SELECT 1 FROM kauro.inbox_records i JOIN kauro.payment_routes r ON r.provider = i.provider WHERE i.inbox_id = inbox_body_conflicts.inbox_id));

-- The commercial prerequisites a CommercialAuthorization binds (07 "CommercialAuthorization": every prerequisite binds the same
-- source and policy), readable by the payment service in its adopted agency column by column — states, hashes and references,
-- never a plan's body, a client's label or a project's purpose.
CREATE POLICY agencies_payment_read ON kauro.agencies FOR SELECT TO kauro_payment USING (agency_id = kauro.current_agency_id());
CREATE POLICY projects_payment_read ON kauro.projects FOR SELECT TO kauro_payment USING (agency_id = kauro.current_agency_id());
CREATE POLICY plans_payment_read ON kauro.plans FOR SELECT TO kauro_payment USING (agency_id = kauro.current_agency_id());
CREATE POLICY approvals_payment_read ON kauro.approvals FOR SELECT TO kauro_payment USING (agency_id = kauro.current_agency_id());
CREATE POLICY dataset_revisions_payment_read ON kauro.dataset_revisions FOR SELECT TO kauro_payment USING (agency_id = kauro.current_agency_id());
CREATE POLICY target_contracts_payment_read ON kauro.target_contracts FOR SELECT TO kauro_payment USING (agency_id = kauro.current_agency_id());
CREATE POLICY capabilities_payment_read ON kauro.capabilities FOR SELECT TO kauro_payment USING (true);

GRANT SELECT (agency_id, version, state) ON kauro.agencies TO kauro_payment;
GRANT SELECT (project_id, agency_id, client_id, version, state, mode, capability_id, capability_version, current_revision_id) ON kauro.projects TO kauro_payment;
GRANT SELECT (plan_id, agency_id, project_id, version, state, revision_hash, target_contract_hash, policy_hash, body_hash, validation_receipt_hash, approval_id, superseded_by_plan_id) ON kauro.plans TO kauro_payment;
GRANT SELECT (approval_id, agency_id, plan_id, version, plan_hash, revision_hash, target_contract_hash, approval_hash, created_at, withdrawn_at) ON kauro.approvals TO kauro_payment;
-- supersedes_revision_id: the lineage a paid capture's re-binding to a replacement revision is checked against (D-QUOTE-B6)
GRANT SELECT (revision_id, agency_id, project_id, version, state, manifest_hash, sealed_at, supersedes_revision_id) ON kauro.dataset_revisions TO kauro_payment;
GRANT SELECT (contract_id, agency_id, project_id, mode, body_hash, confirmed_at, superseded_at) ON kauro.target_contracts TO kauro_payment;
GRANT SELECT ON kauro.capabilities TO kauro_payment;
GRANT SELECT, INSERT ON kauro.domain_events TO kauro_payment;
GRANT USAGE ON SEQUENCE kauro.domain_events_sequence_seq TO kauro_payment;
GRANT SELECT, INSERT ON kauro.outbox_records TO kauro_payment;
GRANT SELECT, INSERT, UPDATE ON kauro.command_journal TO kauro_payment;
GRANT INSERT ON kauro.security_events TO kauro_payment, kauro_ingress;
GRANT SELECT (inbox_id, provider, environment, external_event_id, body_hash, state, received_at, applied_at, result_event_id) ON kauro.inbox_records TO kauro_payment;
GRANT UPDATE (state, applied_at, result_event_id, updated_at) ON kauro.inbox_records TO kauro_payment;
GRANT SELECT (conflict_id, inbox_id, body_hash, received_at) ON kauro.inbox_body_conflicts TO kauro_payment;
GRANT EXECUTE ON FUNCTION kauro.await_transition(text, text) TO kauro_payment;

GRANT SELECT ON kauro.payment_routes, kauro.fiscal_issuers, kauro.refund_policies TO kauro_app, kauro_payment;
GRANT SELECT, INSERT, UPDATE ON kauro.payment_routes, kauro.fiscal_issuers, kauro.refund_policies, kauro.corporate_roles TO kauro_control;
GRANT SELECT ON kauro.corporate_roles TO kauro_app;
GRANT SELECT, INSERT ON kauro.commerce_scopes TO kauro_app, kauro_payment;
GRANT SELECT ON kauro.commerce_scopes TO kauro_control;
