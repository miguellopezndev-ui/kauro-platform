-- 0008 — commerce foundation (package B09, payments and fiscal workflow): the SERVICE and OPERATOR principals and the finance
-- scope, the aggregate-kind registry, the B09 event types, the platform routes (payment merchant routes, fiscal issuers), the
-- corporate roles, the standing refund policies, the scope index, and the policies B09 adds to B06 tables.
--
-- Authority: 07 "Aggregate ownership" (Quote owns immutable commercial terms; PaymentOrder, PaymentAttempt, PaymentTransaction
-- and Refund own provider effects; CommercialAuthorization links valid payment and approved scope to one logical processing
-- entitlement; TaxDocument owns fiscal issuance and correction, independently from payment confirmation), 07 "Database
-- representation", 08 "Identity is not permission" and "Role and capability model" (a service account has only its technical
-- role; Private Owner has no automatic customer-record bypass; finance capability and customer-data support access are
-- separate), 08 "Database isolation", COMMAND_CATALOGUE "Shared execution contract" (service commands require a verified
-- service identity, with scope derived from the stored operation), 15 "Initial payment decision", "Accounting integration
-- decision" and "FiscalProfile", 19 "BusinessProfile and legal facts". Design: docs/design/B09-payments-fiscal.md
-- (D-CTX-B1..B3, D-SCOPE-B1, D-EVT-B1, D-ROUTE-B1, D-CORP-B1, D-RPOL-B1).
--
-- SQLSTATE vocabulary added by B09 (beside KA001..KA008 of migration 0001; adapters map them in design §7.3):
--   KA009 LEDGER_UNBALANCED        KA010 REFUND_EXCEEDS_CAPTURE      KA011 OBLIGATION_OVER_ALLOCATED
--   KA012 FACT_REGRESSION          KA013 AUTHORITY_WITHOUT_CAPTURE   KA014 AUTHORITY_OUTLIVES_REVERSAL

-- --- principals and the finance scope ------------------------------------------------------------------------------------
-- B06 binds kauro.agency_id and kauro.user_id. B09 adds two principals that are not agency members (D-CTX-B1):
--   SERVICE   the payment service and provider ingress: kauro.principal = 'SERVICE', no user; it resolves the scope of the
--             stored operation through kauro.commerce_scopes and then adopts that one agency as kauro.agency_id (full tenant
--             scope, one agency per transaction);
--   OPERATOR  a corporate owner (08 "Private Owner ... has no automatic customer-record bypass"): kauro.principal =
--             'OPERATOR', kauro.user_id = the operator's own identity, and after adoption kauro.finance_agency_id — never
--             kauro.agency_id — so the commerce tables of that agency are visible and the customer tables of B06 are not.
-- An unknown principal value raises (fail closed), like an unparsable agency id does in kauro.current_agency_id().
CREATE OR REPLACE FUNCTION kauro.current_principal() RETURNS text
  LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$
DECLARE
  p text := NULLIF(current_setting('kauro.principal', true), '');
BEGIN
  IF p IS NOT NULL AND p NOT IN ('SERVICE', 'OPERATOR') THEN
    RAISE EXCEPTION 'CONTEXT: unknown principal %', p USING ERRCODE = 'KA006';
  END IF;
  RETURN p;
END
$$;

CREATE OR REPLACE FUNCTION kauro.current_finance_agency_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$ SELECT NULLIF(current_setting('kauro.finance_agency_id', true), '')::uuid $$;

-- A commerce row is visible to the tenant context of its agency and to an OPERATOR whose finance scope is that agency.
CREATE OR REPLACE FUNCTION kauro.in_commerce_scope(target uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$
  SELECT coalesce(target = kauro.current_agency_id(), false)
      OR coalesce(kauro.current_principal() = 'OPERATOR' AND target = kauro.current_finance_agency_id(), false)
$$;

-- Distinct, NULL-free uuid arrays (PriceEligibilitySnapshot.qualifyingProjectIds: "Complete prior distinct ... project set").
CREATE OR REPLACE FUNCTION kauro.is_distinct_uuid_set(v uuid[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT array_position(v, NULL) IS NULL AND cardinality(v) = (SELECT count(DISTINCT x) FROM unnest(v) AS x) $$;

-- Money: BIGINT minor units, non-negative, bounded by the exactly representable JSON integer range so a value survives the
-- canonical profile and the event payloads (reference/HASHING_AND_ACCOUNTING_RULES "Exact money").
CREATE OR REPLACE FUNCTION kauro.is_money(v bigint) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT v >= 0 AND v <= 9007199254740991 $$;

-- Listed transitions over a state column that is not named `state` (CaptureFact.status, FiscalIssuer.route_state):
-- TG_ARGV[0] is the machine, TG_ARGV[1] the column. Same rule and SQLSTATE as kauro.enforce_listed_transition (KA008).
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

-- --- aggregate-kind registry (D-EVT-B1) ------------------------------------------------------------------------------------
-- B06 fixed domain_events.aggregate_kind with a CHECK. Every package adds aggregates, so the vocabulary becomes a registered
-- table (like event_types): packages insert their kinds, the foreign key refuses an unregistered kind. The drop is IF EXISTS so
-- the first package migration that runs replaces the CHECK and later ones only add rows.
CREATE TABLE IF NOT EXISTS kauro.aggregate_kinds (
  aggregate_kind  text PRIMARY KEY CHECK (aggregate_kind ~ '^[a-z][a-z_]{1,62}$'),
  registered_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE kauro.aggregate_kinds ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.aggregate_kinds NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.aggregate_kinds (aggregate_kind) VALUES
  ('agency'), ('membership'), ('end_client'), ('project'), ('dataset_revision'), ('plan'), ('approval'),
  ('quote'), ('payment_order'), ('payment_attempt'), ('capture'), ('commercial_authorization'), ('refund'),
  ('tax_document'), ('reconciliation_case')
ON CONFLICT (aggregate_kind) DO NOTHING;
ALTER TABLE kauro.aggregate_kinds FORCE ROW LEVEL SECURITY;
ALTER TABLE kauro.domain_events DROP CONSTRAINT IF EXISTS domain_events_aggregate_kind_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'domain_events_aggregate_kind_fkey') THEN
    ALTER TABLE kauro.domain_events ADD CONSTRAINT domain_events_aggregate_kind_fkey
      FOREIGN KEY (aggregate_kind) REFERENCES kauro.aggregate_kinds (aggregate_kind);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'kauro' AND tablename = 'aggregate_kinds' AND policyname = 'aggregate_kinds_read') THEN
    CREATE POLICY aggregate_kinds_read ON kauro.aggregate_kinds FOR SELECT TO kauro_app, kauro_control USING (true);
  END IF;
END
$$;
GRANT SELECT ON kauro.aggregate_kinds TO kauro_app, kauro_control;

-- --- B09 event types (design §9; mirrored by @kauro/domain COMMERCE_EVENT_TYPES, the persistence test proves equality) ------
-- event_types is FORCE ROW LEVEL SECURITY with read-only policies, so even its owner cannot insert. A later package registers
-- its vocabulary by lifting FORCE for the duration of this migration transaction only (the runner applies each file in one
-- transaction; nothing else can observe the lifted state) and restoring it before COMMIT.
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
  ('commercial_authorization.issued.v1'), ('commercial_authorization.consumed.v1'), ('commercial_authorization.delivered.v1'),
  ('commercial_authorization.revoked.v1'),
  ('refund.requested.v1'), ('refund.approved.v1'), ('refund.rejected.v1'), ('refund.submitting.v1'), ('refund.uncertain.v1'),
  ('refund.completed.v1'), ('refund.failed.v1'),
  ('tax_document.drafted.v1'), ('tax_document.validated.v1'), ('tax_document.submitting.v1'), ('tax_document.issued.v1'),
  ('tax_document.uncertain.v1'), ('tax_document.rejected.v1'), ('tax_document.corrected.v1'),
  ('reconciliation_case.opened.v1'), ('reconciliation_case.resolved.v1');
ALTER TABLE kauro.event_types FORCE ROW LEVEL SECURITY;

-- --- policies B09 adds to B06 tables ---------------------------------------------------------------------------------------
-- An OPERATOR records the events and outbox rows of the commerce aggregates of its finance scope, and nothing else.
CREATE POLICY domain_events_finance ON kauro.domain_events FOR ALL TO kauro_app
  USING (
    kauro.current_principal() = 'OPERATOR' AND agency_id = kauro.current_finance_agency_id()
    AND aggregate_kind IN ('quote', 'payment_order', 'payment_attempt', 'capture', 'commercial_authorization', 'refund', 'tax_document', 'reconciliation_case')
  )
  WITH CHECK (
    kauro.current_principal() = 'OPERATOR' AND agency_id = kauro.current_finance_agency_id()
    AND aggregate_kind IN ('quote', 'payment_order', 'payment_attempt', 'capture', 'commercial_authorization', 'refund', 'tax_document', 'reconciliation_case')
  );
CREATE POLICY outbox_records_finance ON kauro.outbox_records FOR ALL TO kauro_app
  USING (EXISTS (
    SELECT 1 FROM kauro.domain_events e
    WHERE e.event_id = outbox_records.event_id AND kauro.current_principal() = 'OPERATOR' AND e.agency_id = kauro.current_finance_agency_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM kauro.domain_events e
    WHERE e.event_id = outbox_records.event_id AND kauro.current_principal() = 'OPERATOR' AND e.agency_id = kauro.current_finance_agency_id()
  ));
-- A SERVICE principal records its own denials before a scope exists (a forged or misdirected provider call).
CREATE POLICY security_events_service_write ON kauro.security_events FOR INSERT TO kauro_app
  WITH CHECK (agency_id IS NULL AND actor_kind = 'SERVICE' AND kauro.current_principal() = 'SERVICE');

-- --- payment routes (platform; D-ROUTE-B1) ------------------------------------------------------------------------------------
-- The receiving merchant of each provider and environment, fixed by server configuration (15 "Merchant identity and
-- environment are fixed by server configuration") and qualified before CreatePaymentOrder may use it ("live merchant/fiscal
-- route is qualified"). The payee is kept as the SHA-256 of the provider merchant id; captures compare against it (S058).
CREATE TABLE kauro.payment_routes (
  route_id                        uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(route_id)),
  provider                        text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  environment                     text NOT NULL CHECK (environment IN ('SANDBOX', 'LIVE')),
  merchant_ref                    uuid NOT NULL,
  payee_digest                    text NOT NULL CHECK (kauro.is_sha256_hex(payee_digest)),
  currency                        text NOT NULL CHECK (currency IN ('USD')),
  -- a contract fake is labelled as such and can never carry money (22 B08/B09: payment is a labelled contract fake until B15)
  integration_class               text NOT NULL CHECK (integration_class IN ('PROVIDER', 'CONTRACT_FAKE')),
  state                           text NOT NULL DEFAULT 'CONFIGURED' CHECK (state IN ('CONFIGURED', 'QUALIFIED', 'SUSPENDED')),
  qualification_evidence_hashes   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(qualification_evidence_hashes) = 'array'),
  valid_from                      timestamptz,
  created_at                      timestamptz NOT NULL,
  updated_at                      timestamptz NOT NULL,
  UNIQUE (provider, environment, merchant_ref),
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
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('PaymentRoute', 'CONFIGURED', 'QUALIFIED'),
  ('PaymentRoute', 'CONFIGURED', 'SUSPENDED'),
  ('PaymentRoute', 'QUALIFIED', 'SUSPENDED');

-- --- fiscal issuers (platform; D-ROUTE-B1) ------------------------------------------------------------------------------------
-- The actual contracting and invoicing entity (FiscalProfile.operatorLegalRef) and its issuance route: a verified provider
-- API or the lawful manual-assisted bridge (15 "Accounting integration decision"). Legal facts carry the status vocabulary of
-- 19 "BusinessProfile and legal facts"; a route is QUALIFIED only with observed or professionally confirmed facts, a
-- numbering authorization and verified issuance entitlement (R2-083: a public price page is not entitlement).
CREATE TABLE kauro.fiscal_issuers (
  issuer_ref                      uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(issuer_ref)),
  jurisdiction                    text NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  legal_identity_hash             text NOT NULL CHECK (kauro.is_sha256_hex(legal_identity_hash)),
  legal_fact_status               text NOT NULL CHECK (legal_fact_status IN ('OBSERVED', 'OWNER_DECLARED', 'PROFESSIONALLY_CONFIRMED', 'PENDING', 'EXPIRED')),
  route_kind                      text NOT NULL CHECK (route_kind IN ('PROVIDER_API', 'MANUAL_BRIDGE')),
  integration_class               text NOT NULL CHECK (integration_class IN ('PROVIDER', 'CONTRACT_FAKE')),
  route_state                     text NOT NULL DEFAULT 'CONFIGURED' CHECK (route_state IN ('CONFIGURED', 'QUALIFIED', 'SUSPENDED')),
  numbering_authorization_ref     uuid,
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
  CONSTRAINT fiscal_issuers_validity CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from)
);
CREATE UNIQUE INDEX fiscal_issuers_one_qualified ON kauro.fiscal_issuers (jurisdiction) WHERE route_state = 'QUALIFIED';
CREATE TRIGGER fiscal_issuers_touch BEFORE UPDATE ON kauro.fiscal_issuers FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER fiscal_issuers_immutable BEFORE UPDATE ON kauro.fiscal_issuers
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('issuer_ref,jurisdiction,legal_identity_hash,route_kind,integration_class,created_at');
CREATE TRIGGER fiscal_issuers_transition BEFORE UPDATE OF route_state ON kauro.fiscal_issuers
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition_of('FiscalIssuerRoute', 'route_state');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('FiscalIssuerRoute', 'CONFIGURED', 'QUALIFIED'),
  ('FiscalIssuerRoute', 'CONFIGURED', 'SUSPENDED'),
  ('FiscalIssuerRoute', 'QUALIFIED', 'SUSPENDED');

-- --- corporate roles (platform; D-CORP-B1) --------------------------------------------------------------------------------------
-- The corporate authority of an individually managed corporate identity (08 "Corporate operators and sellers use
-- individually managed corporate identities"). KAURO_OWNER is the catalogue role of ApproveRefund (CMD032); later packages add
-- their corporate roles to the CHECK. A person reads only their own grants; the control plane provisions them.
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
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('CorporateRole');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES ('CorporateRole', 'ACTIVE', 'REVOKED');

-- --- standing refund policies (platform; D-RPOL-B1) ------------------------------------------------------------------------------
-- CMD032 failure: "a standing authorized policy must be referenced rather than invented". A policy is a reviewed, versioned,
-- step-up-authorized record with explicit applicability; ApproveRefund may cite it instead of a fresh step-up only when it
-- applies to the refund in front of it.
CREATE TABLE kauro.refund_policies (
  policy_id               uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(policy_id)),
  policy_kind             text NOT NULL CHECK (policy_kind IN ('PRE_EXECUTION_CANCELLATION', 'UNREMEDIED_KAURO_DEFECT', 'EXCESS_CAPTURE_RETURN')),
  policy_version          text NOT NULL CHECK (policy_version ~ '^[A-Z][A-Z0-9_.-]{0,63}$'),
  -- what the policy authorizes: the full remaining service (and its tax), only an excess capture, or a bounded amount
  refund_scope            text NOT NULL CHECK (refund_scope IN ('FULL_REMAINING', 'EXCESS_ONLY', 'BOUNDED')),
  max_refund_cents        bigint CHECK (max_refund_cents IS NULL OR (kauro.is_money(max_refund_cents) AND max_refund_cents > 0)),
  applies_to_phase        text NOT NULL CHECK (applies_to_phase IN ('PRE_EXECUTION', 'ANY')),
  conditions_hash         text NOT NULL CHECK (kauro.is_sha256_hex(conditions_hash)),
  authorized_by_user_id   uuid NOT NULL REFERENCES kauro.identities (user_id),
  authorization_proof_ref uuid NOT NULL REFERENCES kauro.assurance_proofs (proof_id),
  state                   text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'RETIRED')),
  valid_from              timestamptz NOT NULL,
  valid_until             timestamptz,
  retired_at              timestamptz,
  created_at              timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL,
  UNIQUE (policy_kind, policy_version),
  CONSTRAINT refund_policies_bounded_has_max CHECK ((refund_scope = 'BOUNDED') = (max_refund_cents IS NOT NULL)),
  CONSTRAINT refund_policies_retired_binding CHECK ((state = 'RETIRED') = (retired_at IS NOT NULL)),
  CONSTRAINT refund_policies_validity CHECK (valid_until IS NULL OR valid_until > valid_from)
);
CREATE TRIGGER refund_policies_touch BEFORE UPDATE ON kauro.refund_policies FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER refund_policies_immutable BEFORE UPDATE ON kauro.refund_policies
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('policy_id,policy_kind,policy_version,refund_scope,max_refund_cents,applies_to_phase,conditions_hash,authorized_by_user_id,authorization_proof_ref,valid_from,created_at');
CREATE TRIGGER refund_policies_transition BEFORE UPDATE OF state ON kauro.refund_policies
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('RefundPolicy');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES ('RefundPolicy', 'ACTIVE', 'RETIRED');

-- --- scope index (D-SCOPE-B1) -------------------------------------------------------------------------------------------------------
-- Maps a stored operation (a payment order, a refund) or a provider identity (order, capture, refund id, namespaced by provider
-- and environment) to its agency. Rows hold identifiers only. They are written in the transaction that creates the object, by
-- the agency's own context; SERVICE and OPERATOR principals read them to adopt the one agency of the operation they act on
-- (the catalogue's "scope derived from the stored operation"); nobody updates or deletes them, and a provider identity maps to
-- exactly one agency (PaymentOrder invariant "order identity cannot migrate between tenants").
CREATE TABLE kauro.commerce_scopes (
  scope_kind  text NOT NULL CHECK (scope_kind IN ('QUOTE', 'PAYMENT_ORDER', 'REFUND', 'TAX_DOCUMENT', 'PROVIDER_ORDER', 'PROVIDER_CAPTURE', 'PROVIDER_REFUND')),
  scope_key   text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 600 AND scope_key !~ '[[:cntrl:][:space:]]'),
  agency_id   uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  order_id    uuid,
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (scope_kind, scope_key),
  -- platform ids are the uuid itself; provider ids are "<provider>|<ENVIRONMENT>|<external id>"
  CONSTRAINT commerce_scopes_key_shape CHECK (
    (scope_kind IN ('QUOTE', 'PAYMENT_ORDER', 'REFUND', 'TAX_DOCUMENT') AND scope_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    OR (scope_kind IN ('PROVIDER_ORDER', 'PROVIDER_CAPTURE', 'PROVIDER_REFUND') AND scope_key ~ '^[a-z][a-z0-9_-]{1,63}\|(SANDBOX|LIVE)\|[A-Za-z0-9._:-]{1,256}$')
  )
);
CREATE INDEX commerce_scopes_by_agency ON kauro.commerce_scopes (agency_id, scope_kind);
CREATE TRIGGER commerce_scopes_append_only BEFORE UPDATE OR DELETE ON kauro.commerce_scopes
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- row-level security ------------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.payment_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.payment_routes FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_routes_read ON kauro.payment_routes FOR SELECT TO kauro_app USING (true);
CREATE POLICY payment_routes_control ON kauro.payment_routes FOR ALL TO kauro_control USING (true) WITH CHECK (true);

ALTER TABLE kauro.fiscal_issuers ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.fiscal_issuers FORCE ROW LEVEL SECURITY;
CREATE POLICY fiscal_issuers_read ON kauro.fiscal_issuers FOR SELECT TO kauro_app USING (true);
CREATE POLICY fiscal_issuers_control ON kauro.fiscal_issuers FOR ALL TO kauro_control USING (true) WITH CHECK (true);

ALTER TABLE kauro.corporate_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.corporate_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY corporate_roles_self_read ON kauro.corporate_roles FOR SELECT TO kauro_app USING (user_id = kauro.current_user_id());
CREATE POLICY corporate_roles_control ON kauro.corporate_roles FOR ALL TO kauro_control USING (true) WITH CHECK (true);

ALTER TABLE kauro.refund_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.refund_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY refund_policies_read ON kauro.refund_policies FOR SELECT TO kauro_app USING (true);
CREATE POLICY refund_policies_control ON kauro.refund_policies FOR ALL TO kauro_control USING (true) WITH CHECK (true);

ALTER TABLE kauro.commerce_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.commerce_scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_scopes_write ON kauro.commerce_scopes FOR INSERT TO kauro_app WITH CHECK (kauro.in_commerce_scope(agency_id));
CREATE POLICY commerce_scopes_read ON kauro.commerce_scopes FOR SELECT TO kauro_app
  USING (kauro.in_commerce_scope(agency_id) OR kauro.current_principal() IN ('SERVICE', 'OPERATOR'));
CREATE POLICY commerce_scopes_control ON kauro.commerce_scopes FOR SELECT TO kauro_control USING (true);

-- --- grants (no DELETE for request handlers) -------------------------------------------------------------------------------------
GRANT SELECT ON kauro.payment_routes, kauro.fiscal_issuers, kauro.refund_policies TO kauro_app;
GRANT SELECT, INSERT, UPDATE ON kauro.payment_routes, kauro.fiscal_issuers, kauro.refund_policies, kauro.corporate_roles TO kauro_control;
GRANT SELECT ON kauro.corporate_roles TO kauro_app;
GRANT SELECT, INSERT ON kauro.commerce_scopes TO kauro_app;
GRANT SELECT ON kauro.commerce_scopes TO kauro_control;
