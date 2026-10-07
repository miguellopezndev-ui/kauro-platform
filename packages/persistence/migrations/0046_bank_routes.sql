-- 0046 — Payments V1 bank-transfer route, lane L-ROUTE (PROVISIONAL number, renumbered at merge by tools/renumber-migration.mjs).
--
-- Authority: docs/design/ACH-ROUTE.md r12 §7.1 (R1, R2), §7.2 (I1, I2), §7.3 (I3), §7.24 (I2Δ), §7.29 (enable condition), DV1-01 (no table,
-- column, enum value or event type names a provider), DV1-07 (transfer window, frozen sendBy). Coordinator decisions (L-ROUTE handoff):
--   #1 route events are agency-less and owner-only: kauro.domain_events_bind_aggregate compares the agency IS NOT DISTINCT FROM, and an
--      agency-less row of domain_events / outbox_records is visible to an acting corporate owner only (never to an agency session);
--   #2 (amended) one SECURITY DEFINER function registers the payment_routes row of a bank route (search_path pinned), callable by kauro_app
--      only for an ACTIVE KAURO_OWNER acting as itself; payment_routes gains an INSERT policy for the function owner only (CURRENT_USER, the
--      precedent of 0008) limited to CONFIGURED rows of class CONTRACT_FAKE or PROVIDER; kauro_app gains no grant and no policy on it. The
--      owner role reads corporate_roles under its own SELECT policy (FORCE ROW LEVEL SECURITY applies to it inside the function);
--   #3 bank_routes, bank_route_versions, bank_route_participants, bank_transfer_instructions, their guards, two aggregate kinds and their
--      event types.
--
-- Lock order (failure-matrix template rule 13; ACH-ROUTE §7.28 extended for the route rows, coordinator decision (b)):
--   Kroute (configure excepted): the route row FOR UPDATE is taken FIRST — before the owner's access decision (identity, grant transition
--     locks) and the journal — so a revocation of the owner's grant issued while the command waits for the route is never blocked by it
--     (covered by ACH-M-R2-REVOCATION). Verify and details replacement read the details evidence before the route lock (R1).
--   Kinstructions: the project row FOR NO KEY UPDATE (the subject lock), then the route row FOR KEY SHARE (conflicts with Kroute's FOR
--     UPDATE, not with another issuance), then the member's access decision, the journal and the B09 subject reads.
--   No actor holding a route lock takes L1..L4 of §7.28.
-- Reads of the internal evidence store (a store of the platform, not an external call-out) run inside the transaction where the cells
-- require it (coordinator decision (c)): Kroute's enable after the route lock, I3 before its access decision.

-- --- agency-less aggregates: the event binding (decision #1) -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kauro.domain_events_bind_aggregate() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  binding record;
  current_version bigint;
BEGIN
  SELECT k.table_name, k.id_column INTO binding FROM kauro.aggregate_kinds k WHERE k.aggregate_kind = NEW.aggregate_kind;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTEXT: aggregate kind % has no binding', NEW.aggregate_kind USING ERRCODE = 'KA006';
  END IF;
  EXECUTE pg_catalog.format('SELECT a.version FROM kauro.%I a WHERE a.%I = $1 AND a.agency_id IS NOT DISTINCT FROM $2', binding.table_name, binding.id_column)
    INTO current_version USING NEW.aggregate_id, NEW.agency_id;
  IF current_version IS NULL THEN
    RAISE EXCEPTION 'CONTEXT: % % is not an aggregate of agency % visible in this transaction', NEW.aggregate_kind, NEW.aggregate_id, NEW.agency_id USING ERRCODE = 'KA006';
  END IF;
  IF NEW.aggregate_version > current_version THEN
    RAISE EXCEPTION 'VERSION_DISCIPLINE: an event of % % records version % ahead of the aggregate (version %)', NEW.aggregate_kind, NEW.aggregate_id, NEW.aggregate_version, current_version USING ERRCODE = 'KA002';
  END IF;
  RETURN NEW;
END
$$;

-- the event-per-version rule of an agency-less aggregate: the same comparison (an agency's rows compare exactly as before)
CREATE OR REPLACE FUNCTION kauro.require_event_for_version() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  row_j jsonb := to_jsonb(NEW);
  agg_id uuid := (row_j ->> TG_ARGV[1])::uuid;
  agg_version bigint := (row_j ->> 'version')::bigint;
  agg_agency uuid := (row_j ->> 'agency_id')::uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.domain_events e
    WHERE e.agency_id IS NOT DISTINCT FROM agg_agency AND e.aggregate_kind = TG_ARGV[0] AND e.aggregate_id = agg_id AND e.aggregate_version = agg_version
  ) THEN
    RAISE EXCEPTION 'EVENT_MISSING: % % version % has no domain event in this transaction', TG_ARGV[0], agg_id, agg_version USING ERRCODE = 'KA003';
  END IF;
  RETURN NULL;
END
$$;

-- --- bank routes --------------------------------------------------------------------------------------------------------------------
-- One receiving bank account of the platform in one environment, owner-configured and qualified (ACH-ROUTE §7.1). `current_version` is the
-- version of its details and configuration (bank_route_versions; what expectedVersion names), `version` the aggregate version every Kroute
-- bumps (one event per version). agency_id is always NULL: a route is platform scope, its events are agency-less (decision #1).
CREATE TABLE kauro.bank_routes (
  route_id           uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(route_id)),
  agency_id          uuid CHECK (agency_id IS NULL),
  environment        text NOT NULL CHECK (environment IN ('SANDBOX', 'LIVE')),
  account_ref        text NOT NULL CHECK (kauro.is_provider_ref(account_ref)),
  provider           text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  integration_class  text NOT NULL CHECK (integration_class IN ('PROVIDER', 'CONTRACT_FAKE')),
  currency           text NOT NULL CHECK (currency = 'USD'),
  payment_route_id   uuid NOT NULL UNIQUE REFERENCES kauro.payment_routes (route_id),
  state              text NOT NULL DEFAULT 'PENDING_VERIFICATION' CHECK (state IN ('PENDING_VERIFICATION', 'VERIFIED', 'ENABLED', 'DISABLED')),
  rollout            text CHECK (rollout IN ('CONTROLLED', 'GENERAL')),
  current_version    integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  -- the aggregate version whose allowlist is in force (bank_route_participants.set_version); rows are appended, never deleted
  participants_version bigint CHECK (participants_version IS NULL OR participants_version >= 1),
  version            bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT kauro.server_now(),
  updated_at         timestamptz NOT NULL DEFAULT kauro.server_now(),
  UNIQUE (environment, account_ref),
  CONSTRAINT bank_routes_fake_never_live CHECK (integration_class <> 'CONTRACT_FAKE' OR environment <> 'LIVE'),
  CONSTRAINT bank_routes_enabled_has_rollout CHECK (state <> 'ENABLED' OR rollout IS NOT NULL)
);
CREATE TRIGGER bank_routes_touch BEFORE UPDATE ON kauro.bank_routes FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER bank_routes_immutable BEFORE UPDATE ON kauro.bank_routes
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('route_id,agency_id,environment,account_ref,provider,integration_class,currency,payment_route_id,created_by,created_at');

-- the listed edges of a route (a disable is retained whatever else was revoked; a replacement of the details returns to unqualified), and a
-- rollout only while ENABLED: leaving ENABLED clears it
CREATE OR REPLACE FUNCTION kauro.bank_routes_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'PENDING_VERIFICATION' AND NEW.state IN ('VERIFIED', 'DISABLED'))
    OR (OLD.state = 'VERIFIED' AND NEW.state IN ('ENABLED', 'PENDING_VERIFICATION', 'DISABLED'))
    OR (OLD.state = 'ENABLED' AND NEW.state IN ('VERIFIED', 'PENDING_VERIFICATION', 'DISABLED'))
    OR (OLD.state = 'DISABLED' AND NEW.state = 'PENDING_VERIFICATION')
  ) THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: bank route % from % to %', OLD.route_id, OLD.state, NEW.state USING ERRCODE = 'KA008';
  END IF;
  IF NEW.state <> 'ENABLED' THEN
    NEW.rollout := NULL;
  END IF;
  IF NEW.current_version < OLD.current_version OR NEW.version < OLD.version THEN
    RAISE EXCEPTION 'VERSION_DISCIPLINE: bank route % versions never decrease', OLD.route_id USING ERRCODE = 'KA002';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bank_routes_guard BEFORE UPDATE ON kauro.bank_routes FOR EACH ROW EXECUTE FUNCTION kauro.bank_routes_guard();

-- each version of a route's details and configuration: the owner-supplied evidence artifact (its reference and hash), the window and
-- lifetime of instructions, the provider-time tolerance, the fee policy and the cited timing source; verification facts set once
CREATE TABLE kauro.bank_route_versions (
  route_id                    uuid NOT NULL REFERENCES kauro.bank_routes (route_id),
  route_version               integer NOT NULL CHECK (route_version >= 1),
  details_artifact_ref        text NOT NULL CHECK (length(details_artifact_ref) BETWEEN 1 AND 128 AND details_artifact_ref ~ '^[A-Za-z0-9._:-]+$'),
  details_evidence_hash       text NOT NULL CHECK (kauro.is_sha256_hex(details_evidence_hash)),
  payee_digest                text NOT NULL CHECK (kauro.is_sha256_hex(payee_digest)),
  accepted_rails              text[] NOT NULL CHECK (cardinality(accepted_rails) >= 1 AND accepted_rails <@ ARRAY['ACH', 'DOMESTIC_WIRE']::text[]),
  minimum_transfer_window_ms  bigint NOT NULL CHECK (minimum_transfer_window_ms > 0),
  instruction_lifetime_ms     bigint NOT NULL CHECK (instruction_lifetime_ms > 0),
  provider_time_tolerance_ms  bigint NOT NULL CHECK (provider_time_tolerance_ms >= 0),
  fee_policy_version          text NOT NULL CHECK (fee_policy_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  timing_source_url           text NOT NULL CHECK (length(timing_source_url) <= 2048 AND timing_source_url ~ '^https://[A-Za-z0-9.-]+(/[!-~]*)?$'),
  timing_source_accessed_on   date NOT NULL,
  verification_evidence_ref   text CHECK (verification_evidence_ref IS NULL OR (length(verification_evidence_ref) BETWEEN 1 AND 128 AND verification_evidence_ref ~ '^[A-Za-z0-9._:-]+$')),
  verified_at                 timestamptz,
  verified_by                 uuid,
  created_by                  uuid NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT kauro.server_now(),
  PRIMARY KEY (route_id, route_version),
  CONSTRAINT bank_route_versions_verification_whole CHECK ((verified_at IS NULL) = (verified_by IS NULL) AND (verified_at IS NULL) = (verification_evidence_ref IS NULL))
);
CREATE TRIGGER bank_route_versions_immutable BEFORE UPDATE ON kauro.bank_route_versions
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('route_id,route_version,details_artifact_ref,details_evidence_hash,payee_digest,accepted_rails,minimum_transfer_window_ms,instruction_lifetime_ms,provider_time_tolerance_ms,fee_policy_version,timing_source_url,timing_source_accessed_on,created_by,created_at');
CREATE TRIGGER bank_route_versions_verified_once BEFORE UPDATE ON kauro.bank_route_versions
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('verified_at,verified_by,verification_evidence_ref');

-- the agencies a CONTROLLED rollout admits (K-9): each enable appends the allowlist of its aggregate version (set_version) and names it in
-- bank_routes.participants_version; a request handler holds no DELETE (an earlier allowlist simply stops being the one in force)
CREATE TABLE kauro.bank_route_participants (
  route_id     uuid NOT NULL REFERENCES kauro.bank_routes (route_id),
  set_version  bigint NOT NULL CHECK (set_version >= 1),
  agency_id    uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  created_at   timestamptz NOT NULL DEFAULT kauro.server_now(),
  PRIMARY KEY (route_id, set_version, agency_id)
);
CREATE TRIGGER bank_route_participants_append_only BEFORE UPDATE ON kauro.bank_route_participants FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE INDEX bank_route_participants_by_agency ON kauro.bank_route_participants (agency_id);

-- --- transfer instructions (D-ACH-04, DV1-07) ---------------------------------------------------------------------------------------
-- The immutable snapshot an issuance froze for one payment order: the route and its version, the account, the 23-character reference
-- (unique per account and environment), the exact amount, the deadline (min of the instruction lifetime and the quote's price expiry)
-- and the frozen sendBy (deadline - minimum window). The bank order state of BANK_ORDER_EXTENSION lives here, never in
-- payment_orders.state (the vendored PaymentOrder machine is not extended). No role may change the reference.
CREATE TABLE kauro.bank_transfer_instructions (
  order_id             uuid PRIMARY KEY,
  agency_id            uuid NOT NULL,
  version              bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  route_id             uuid NOT NULL REFERENCES kauro.bank_routes (route_id),
  route_version        integer NOT NULL,
  environment          text NOT NULL CHECK (environment IN ('SANDBOX', 'LIVE')),
  account_ref          text NOT NULL CHECK (kauro.is_provider_ref(account_ref)),
  reference            text NOT NULL CHECK (reference ~ '^K[0-9A-HJKMNP-TV-Z]{22}$'),
  amount_cents         bigint NOT NULL CHECK (kauro.is_money(amount_cents) AND amount_cents > 0),
  currency             text NOT NULL CHECK (currency = 'USD'),
  order_state          text NOT NULL DEFAULT 'AWAITING_TRANSFER' CHECK (order_state IN ('AWAITING_TRANSFER', 'PARTIALLY_RECEIVED', 'RECEIVED_REVIEW', 'CAPTURED', 'EXPIRED')),
  transfer_expires_at  timestamptz NOT NULL,
  send_by              timestamptz NOT NULL,
  issued_at            timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT kauro.server_now(),
  updated_at           timestamptz NOT NULL DEFAULT kauro.server_now(),
  FOREIGN KEY (agency_id, order_id) REFERENCES kauro.payment_orders (agency_id, order_id),
  FOREIGN KEY (route_id, route_version) REFERENCES kauro.bank_route_versions (route_id, route_version),
  CONSTRAINT bank_transfer_instructions_reference_unique UNIQUE (environment, account_ref, reference),
  CONSTRAINT bank_transfer_instructions_send_by CHECK (send_by < transfer_expires_at)
);
CREATE INDEX bank_transfer_instructions_by_route ON kauro.bank_transfer_instructions (route_id);
CREATE TRIGGER bank_transfer_instructions_touch BEFORE UPDATE ON kauro.bank_transfer_instructions FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER bank_transfer_instructions_immutable BEFORE UPDATE ON kauro.bank_transfer_instructions
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('order_id,agency_id,route_id,route_version,environment,account_ref,reference,amount_cents,currency,issued_at,created_at');

-- --- aggregate kinds, events, the event-per-version rule ----------------------------------------------------------------------------
INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES
  ('bank_route', 'bank_routes', 'route_id', 'B09'),
  ('bank_transfer_instruction', 'bank_transfer_instructions', 'order_id', 'B09');
-- the vocabulary is extended by lifting FORCE for this migration's own transaction, as 0013 and 0028 do, and restoring it before COMMIT
ALTER TABLE kauro.event_types NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.event_types (event_type) VALUES
  ('bank_route.configured.v1'), ('bank_route.verified.v1'), ('bank_route.enabled.v1'), ('bank_route.disabled.v1'), ('bank_route.details_replaced.v1'),
  ('bank_transfer_instruction.issued.v1');
ALTER TABLE kauro.event_types FORCE ROW LEVEL SECURITY;
CREATE CONSTRAINT TRIGGER bank_routes_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.bank_routes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('bank_route', 'route_id');
CREATE CONSTRAINT TRIGGER bank_transfer_instructions_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.bank_transfer_instructions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('bank_transfer_instruction', 'order_id');

-- --- the payment route of a bank route (decision #2, amended) ------------------------------------------------------------------------
-- The function owner (the migration role, never a runtime login) may insert CONFIGURED rows of a real or contract-fake integration only.
CREATE POLICY payment_routes_register_bank ON kauro.payment_routes FOR INSERT TO CURRENT_USER
  WITH CHECK (state = 'CONFIGURED' AND integration_class IN ('CONTRACT_FAKE', 'PROVIDER') AND qualification_evidence_hashes = '[]'::jsonb AND valid_from IS NULL);
-- inside the function FORCE ROW LEVEL SECURITY applies to its owner: it reads the caller's grant under this policy, nothing else
CREATE POLICY corporate_roles_register_bank_read ON kauro.corporate_roles FOR SELECT TO CURRENT_USER USING (true);

CREATE OR REPLACE FUNCTION kauro.register_bank_payment_route(p_route_id uuid, p_provider text, p_environment text, p_merchant_ref uuid, p_payee_digest text, p_integration_class text)
  RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  caller uuid := NULLIF(pg_catalog.current_setting('kauro.user_id', true), '')::uuid;
BEGIN
  IF NULLIF(pg_catalog.current_setting('kauro.agency_id', true), '') IS NOT NULL OR caller IS NULL OR NOT EXISTS (
    SELECT 1 FROM kauro.corporate_roles g WHERE g.user_id = caller AND g.role = 'KAURO_OWNER' AND g.state = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only an active corporate owner acting as itself registers a bank payment route' USING ERRCODE = '42501';
  END IF;
  IF p_integration_class NOT IN ('CONTRACT_FAKE', 'PROVIDER') THEN
    RAISE EXCEPTION 'INTEGRITY: integration class % is not registrable', p_integration_class USING ERRCODE = '22023';
  END IF;
  INSERT INTO kauro.payment_routes (route_id, provider, environment, merchant_ref, payee_digest, currency, integration_class, state, created_at, updated_at)
  VALUES (p_route_id, p_provider, p_environment, p_merchant_ref, p_payee_digest, 'USD', p_integration_class, 'CONFIGURED', pg_catalog.now(), pg_catalog.now());
  RETURN p_route_id;
END
$$;
REVOKE ALL ON FUNCTION kauro.register_bank_payment_route(uuid, text, text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kauro.register_bank_payment_route(uuid, text, text, uuid, text, text) TO kauro_app;

-- --- row-level security ---------------------------------------------------------------------------------------------------------------
-- agency-less events and their outbox records: an acting corporate owner only (decision #1); an agency session never sees them
CREATE POLICY domain_events_owner_route ON kauro.domain_events FOR ALL TO kauro_app
  USING (agency_id IS NULL AND aggregate_kind = 'bank_route' AND kauro.acting_corporate_owner())
  WITH CHECK (agency_id IS NULL AND aggregate_kind = 'bank_route' AND split_part(event_type, '.', 1) = 'bank_route' AND kauro.acting_corporate_owner());
CREATE POLICY outbox_records_owner_route ON kauro.outbox_records FOR ALL TO kauro_app
  USING (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id IS NULL AND e.aggregate_kind = 'bank_route' AND kauro.acting_corporate_owner()))
  WITH CHECK (EXISTS (SELECT 1 FROM kauro.domain_events e WHERE e.event_id = outbox_records.event_id AND e.agency_id IS NULL AND e.aggregate_kind = 'bank_route' AND kauro.acting_corporate_owner()));

ALTER TABLE kauro.bank_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.bank_routes FORCE ROW LEVEL SECURITY;
ALTER TABLE kauro.bank_route_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.bank_route_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE kauro.bank_route_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.bank_route_participants FORCE ROW LEVEL SECURITY;
ALTER TABLE kauro.bank_transfer_instructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.bank_transfer_instructions FORCE ROW LEVEL SECURITY;

-- the corporate owner configures and qualifies routes
CREATE POLICY bank_routes_owner ON kauro.bank_routes FOR ALL TO kauro_app USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY bank_route_versions_owner ON kauro.bank_route_versions FOR ALL TO kauro_app USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY bank_route_participants_owner ON kauro.bank_route_participants FOR ALL TO kauro_app USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY bank_transfer_instructions_owner_read ON kauro.bank_transfer_instructions FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());

-- an agency session sees a route it may buy through (a participant, a GENERAL rollout) or one its orders were issued on; it may lock it
-- (FOR KEY SHARE, the issuance's and the projection's route lock) and never change it (WITH CHECK false)
CREATE OR REPLACE FUNCTION kauro.bank_route_visible_to_tenant(p_route_id uuid, p_rollout text, p_participants_version bigint) RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$
  SELECT kauro.current_agency_id() IS NOT NULL AND (
    p_rollout = 'GENERAL'
    OR EXISTS (SELECT 1 FROM kauro.bank_route_participants p WHERE p.route_id = p_route_id AND p.set_version = p_participants_version AND p.agency_id = kauro.current_agency_id())
    OR EXISTS (SELECT 1 FROM kauro.bank_transfer_instructions i WHERE i.route_id = p_route_id AND i.agency_id = kauro.current_agency_id())
  )
$$;
CREATE POLICY bank_routes_tenant_read ON kauro.bank_routes FOR SELECT TO kauro_app USING (kauro.bank_route_visible_to_tenant(route_id, rollout, participants_version));
CREATE POLICY bank_routes_tenant_lock ON kauro.bank_routes FOR UPDATE TO kauro_app USING (kauro.bank_route_visible_to_tenant(route_id, rollout, participants_version)) WITH CHECK (false);
CREATE POLICY bank_route_versions_tenant_read ON kauro.bank_route_versions FOR SELECT TO kauro_app
  USING (kauro.current_agency_id() IS NOT NULL AND EXISTS (SELECT 1 FROM kauro.bank_routes r WHERE r.route_id = bank_route_versions.route_id));
CREATE POLICY bank_route_participants_tenant_read ON kauro.bank_route_participants FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY bank_transfer_instructions_tenant ON kauro.bank_transfer_instructions FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY bank_transfer_instructions_payment ON kauro.bank_transfer_instructions FOR ALL TO kauro_payment
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

-- --- grants -------------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON kauro.bank_routes, kauro.bank_route_versions, kauro.bank_route_participants TO kauro_app;
GRANT UPDATE (state, rollout, current_version, participants_version, version, updated_at) ON kauro.bank_routes TO kauro_app;
GRANT UPDATE (verified_at, verified_by, verification_evidence_ref) ON kauro.bank_route_versions TO kauro_app;
GRANT SELECT, INSERT ON kauro.bank_transfer_instructions TO kauro_app;
GRANT SELECT ON kauro.bank_transfer_instructions TO kauro_payment;
GRANT UPDATE (order_state, version, updated_at) ON kauro.bank_transfer_instructions TO kauro_payment;
