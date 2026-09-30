-- 0028 — agency recurrence, the founding cohort, quote issuances and the agency lifecycle records (package B10, agency recurrence
-- and commission domain): the commission service's runtime group, the qualifying-purchase history and its first designation, the
-- eligibility set, the founding slots and reservations, the agreement versions and acceptances, the closure record and its residual
-- guard, the reviewed relationship decisions, B10's event type and COMMISSIONS subscriptions, and the history of B10's platform
-- machines.
--
-- Authority: 16 "Recurrence decision" (a prior project counts when it was paid within the lookback, is another project of the
-- agency and is not fully refunded; the set is evaluated at quote issuance on a server timestamp and stored), "Founding incentive"
-- (three founding agencies, one reservation per quote until its expiry, no revival, capture uncertainty prevents release), "Quote
-- calculation", "Agency lifecycle"; 17 "First qualifying project" (sticky after the first capture; the persisted designation and
-- financial inbox transaction are the authority), "Termination and tail"; 07 "Database representation", "Transaction discipline";
-- 08 "Database isolation" (a service account has only its technical role); registry Agency (agreements_and_profile_accepted,
-- owner_requests_closure, closure_obligations_completed; firstQualifyingCaptureId), policy pricing (foundingAgencyCount 3,
-- repeatLookbackDays 365) and commission (firstProjectDesignation STICKY_AFTER_FIRST_CAPTURE); COMMERCIAL_LEDGER_WORKED_EXAMPLES
-- 2, 4, 5, 9, 16, 17, 24. Design: docs/design/B10-commercial-domain.md §3, §4, §9, §10 (D10-CTX-1, D10-FIRST-1, D10-FIRST-2,
-- D10-REC-1..3, D10-FOUND-1..4, D10-QUOTE-1, D10-AGY-1..5, D10-EVT-1, D10-TX-1, D10-BASE-1). This file references B06 and B09 objects
-- and the foundation's registry (0008); it edits no B06 or B09 rule — it adds triggers, policies and grants beside them.
--
-- SQLSTATE vocabulary added by B10 (a class of its own; the stage-2 adapters translate each, design §12):
--   KC001 DESIGNATION_REWRITE            (this file)  KC006 CLOSURE_RESIDUALS_OPEN  (this file)
--   KC014 RESERVATION_RELEASE_REFUSED    (this file)
--   KC002, KC003, KC005, KC007, KC009, KC010, KC011, KC015, KC016, KC017 are raised by 0029..0031.

-- --- the commission service's runtime group (D10-CTX-1) ---------------------------------------------------------------------------
-- kauro_commission is the commission service: the COMMISSIONS consumer, the sweeps of design §14 (QUOTE_EXPIRY among them) and the
-- service commands CMD051 and CMD053 (the finance-service identity shares the group). Like the payment service it acts on one agency
-- per transaction — the agency of the durable work item it adopted (kauro.agency_id) — or, for the corporate records of 0029..0031,
-- on none; one login per group (the verified pool refuses a login in two groups).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kauro_commission') THEN
    CREATE ROLE kauro_commission NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kauro_commission' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)
  ) THEN
    RAISE EXCEPTION 'runtime roles must not be SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION (08 Database isolation)';
  END IF;
END
$$;
GRANT USAGE ON SCHEMA kauro TO kauro_commission;
-- readiness (14 "Monitoring and service health"): the commission service reads the migration ledger like the other serving roles
GRANT USAGE ON SCHEMA kauro_meta TO kauro_commission;
GRANT SELECT ON kauro_meta.schema_migrations TO kauro_commission;
-- the listed-transition guards read the machines as the writer; the transition-lock protocol's shared half (B06 D-TX-2)
GRANT SELECT ON kauro.state_machines, kauro.state_transitions TO kauro_commission;
GRANT EXECUTE ON FUNCTION kauro.await_transition(text, text) TO kauro_commission;
-- the commission service appends events (the quote's expiry, the agency's first designation), so the foundation's binding reads the
-- registry as it: a read grant and a policy of its own (FOUNDATION §4, D-AGGK-3; never by altering aggregate_kinds_read)
GRANT SELECT ON kauro.aggregate_kinds TO kauro_commission;
CREATE POLICY aggregate_kinds_read_b10_commission ON kauro.aggregate_kinds FOR SELECT TO kauro_commission USING (true);

-- --- B10's event type and subscriptions (design §9, §14; @kauro/domain commercial/events.ts) ---------------------------------------
-- The vocabulary is extended by lifting FORCE for this migration's own transaction, as 0013 does, and restoring it before COMMIT.
ALTER TABLE kauro.event_types NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.event_types (event_type) VALUES ('agency.first_purchase_designated.v1');
ALTER TABLE kauro.event_types FORCE ROW LEVEL SECURITY;
-- COMMISSIONS learns the capture's funds availability (eligibility waits for AVAILABLE funds; D10-ELIG-1) and the authorization's
-- delivery (the FINAL completion of a single-stage purchase; D10-BIND-1): "a later package that subscribes to a commerce event adds its
-- row in its own migration" (0013).
ALTER TABLE kauro.commerce_event_subscriptions NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.commerce_event_subscriptions (event_type, consumer) VALUES
  ('capture.funds_observed.v1', 'COMMISSIONS'),
  ('commercial_authorization.delivered.v1', 'COMMISSIONS');
ALTER TABLE kauro.commerce_event_subscriptions FORCE ROW LEVEL SECURITY;
-- the first designation is mirrored by the commission service alone (D10-FIRST-2): the request handlers never publish its event
-- (restrictive, beside B06's domain_events_tenant, which is not edited; B07's domain_events_tenant_not_source_control is the precedent)
CREATE POLICY domain_events_tenant_not_first_designation ON kauro.domain_events AS RESTRICTIVE FOR INSERT TO kauro_app
  WITH CHECK (event_type <> 'agency.first_purchase_designated.v1');

-- --- the history of B10's platform machines (D10-EVT-1) --------------------------------------------------------------------------
-- B10's aggregates without an aggregate kind (the founding reservation here; the seller, prospect, claim, entitlement, statement,
-- payout intent, destination, hold and period of 0029..0031) publish no domain event: their history is this table, one row per
-- version that is a birth or a state change, written by kauro.record_commercial_transition in the transaction of the change and by
-- nothing else. Append-only.
CREATE TABLE kauro.commercial_transitions (
  machine          text NOT NULL REFERENCES kauro.state_machines (machine),
  subject_id       uuid NOT NULL,
  subject_version  bigint NOT NULL CHECK (subject_version >= 1),
  agency_id        uuid REFERENCES kauro.agencies (agency_id),
  from_state       text,
  to_state         text NOT NULL,
  actor_user_id    uuid REFERENCES kauro.identities (user_id),
  recorded_at      timestamptz NOT NULL,
  PRIMARY KEY (machine, subject_id, subject_version),
  -- every change is a listed edge of the subject's machine; a birth is version 1 and has no previous state
  CONSTRAINT commercial_transitions_listed_edge FOREIGN KEY (machine, from_state, to_state) REFERENCES kauro.state_transitions (machine, from_state, to_state),
  CONSTRAINT commercial_transitions_birth CHECK ((from_state IS NULL) = (subject_version = 1))
);
CREATE INDEX commercial_transitions_by_agency ON kauro.commercial_transitions (agency_id, recorded_at) WHERE agency_id IS NOT NULL;

-- The writer's half: AFTER INSERT OR UPDATE OF <state column>; TG_ARGV[0] the machine, [1] the id column, [2] the state column. The
-- subject's row carries `version` (and `agency_id` when it is agency-scoped); the actor is the session's person, if any.
CREATE OR REPLACE FUNCTION kauro.record_commercial_transition() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  new_j jsonb := to_jsonb(NEW);
  old_state text := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ->> TG_ARGV[2] END;
  new_state text := to_jsonb(NEW) ->> TG_ARGV[2];
BEGIN
  IF TG_OP = 'UPDATE' AND old_state IS NOT DISTINCT FROM new_state THEN
    RETURN NULL;
  END IF;
  INSERT INTO kauro.commercial_transitions (machine, subject_id, subject_version, agency_id, from_state, to_state, actor_user_id, recorded_at)
  VALUES (TG_ARGV[0], (new_j ->> TG_ARGV[1])::uuid, (new_j ->> 'version')::bigint, (new_j ->> 'agency_id')::uuid, old_state, new_state, kauro.current_user_id(), kauro.server_now());
  RETURN NULL;
END
$$;

-- written by the subjects' transition triggers only: a statement of a client runs at trigger depth 1, the history insert of a
-- subject's trigger one level deeper, a level no client reaches (the pattern of B06's owner counter and B09's allocation writer)
CREATE OR REPLACE FUNCTION kauro.commercial_transitions_recorded_by_trigger() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: commercial_transitions is recorded by the transition triggers of its subjects only' USING ERRCODE = 'KA004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commercial_transitions_recorded_by_trigger BEFORE INSERT ON kauro.commercial_transitions
  FOR EACH ROW EXECUTE FUNCTION kauro.commercial_transitions_recorded_by_trigger();
CREATE TRIGGER commercial_transitions_append_only BEFORE UPDATE OR DELETE ON kauro.commercial_transitions
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER commercial_transitions_no_truncate BEFORE TRUNCATE ON kauro.commercial_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

-- --- the platform machine FoundingReservation (design §8.2; @kauro/domain COMMERCIAL_PLATFORM_MACHINES; D10-FOUND-1) ---------------
INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('FoundingReservation', 'RESERVED');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('FoundingReservation', 'RESERVED', 'CONSUMED'),
  ('FoundingReservation', 'RESERVED', 'RELEASED'),
  ('FoundingReservation', 'RESERVED', 'RECONCILIATION_HOLD'),
  ('FoundingReservation', 'RECONCILIATION_HOLD', 'CONSUMED'),
  ('FoundingReservation', 'RECONCILIATION_HOLD', 'RELEASED');

-- --- the founding cohort: slots (D10-FOUND-1, D10-FOUND-2) --------------------------------------------------------------------------
-- One row per slot of a price policy's cohort: R2-INITIAL has 1..3 (policy pricing.foundingAgencyCount; the persistence test proves
-- the count equal). A slot is held by at most one reservation, the one it names (live_reservation_id, with that reservation's
-- agency): RESERVED or RECONCILIATION_HOLD while it lives, CONSUMED for ever once a qualifying purchase used it (R2-096). The last-slot
-- race is decided on this row: CMD027 takes a slot with UPDATE ... WHERE slot_no = $n AND NOT held in ascending order, a contender
-- waits for the first transaction's row lock, re-checks NOT held and moves to the next slot or to none (example 17). A freed slot's
-- reservation was RELEASED in the same transaction, and a consumed one is never freed (KC014). The slot rows are platform rows: the
-- request handlers and the commission service read which slots are held, never which agency holds one (column grants below).
CREATE TABLE kauro.founding_slots (
  policy_version       text NOT NULL REFERENCES kauro.price_policies (policy_version),
  slot_no              integer NOT NULL CHECK (slot_no >= 1),
  held                 boolean NOT NULL DEFAULT false,
  live_reservation_id  uuid,
  live_agency_id       uuid,
  updated_at           timestamptz NOT NULL,
  PRIMARY KEY (policy_version, slot_no),
  CONSTRAINT founding_slots_held_names_reservation CHECK (held = (live_reservation_id IS NOT NULL) AND (live_reservation_id IS NULL) = (live_agency_id IS NULL))
);
INSERT INTO kauro.founding_slots (policy_version, slot_no, updated_at) SELECT 'R2-INITIAL', n, now() FROM generate_series(1, 3) AS n;

-- --- founding reservations (platform machine FoundingReservation; D10-FOUND-1..4) --------------------------------------------------
-- The reservation of one slot by one quote until that quote's 336-hour expiry (ends_at = the quote's expires_at; R2-127). One per
-- agency per cohort, ever — a released reservation is never revived under a new quote id (examples 16, 17) — one per quote, and one
-- live per slot. The reservation names its quote and that quote's snapshot names the reservation (founding_slot_ref), checked from the
-- reservation's side at COMMIT: B09's snapshot table gets no guard (D10-REC-3). Released only once its quote EXPIRED, was SUPERSEDED or
-- WITHDRAWN (B09's release guard orders that with any payment in flight), with its slot freed in the same transaction (KC014); held
-- in RECONCILIATION_HOLD only after its end with the quote still accepted for checkout (a payment in flight; D10-FOUND-4); consumed
-- only by the designation of a qualifying purchase of its own quote (KC001). Writers: the agency's request handlers reserve and release
-- (CMD027 issuance and supersession, CMD043 withdrawal), the payment service consumes, the commission service's QUOTE_EXPIRY sweep holds
-- and releases.
CREATE TABLE kauro.founding_slot_reservations (
  reservation_id                uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(reservation_id)),
  agency_id                     uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  quote_id                      uuid NOT NULL,
  policy_version                text NOT NULL,
  slot_no                       integer NOT NULL,
  version                       bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                         text NOT NULL DEFAULT 'RESERVED' CHECK (state IN ('RESERVED', 'RECONCILIATION_HOLD', 'CONSUMED', 'RELEASED')),
  ends_at                       timestamptz NOT NULL,
  held_at                       timestamptz,
  consumed_at                   timestamptz,
  consumed_by_authorization_id  uuid,
  released_at                   timestamptz,
  release_reason                text CHECK (release_reason IS NULL OR release_reason IN ('QUOTE_SUPERSEDED', 'QUOTE_EXPIRED', 'QUOTE_WITHDRAWN')),
  created_at                    timestamptz NOT NULL,
  updated_at                    timestamptz NOT NULL,
  UNIQUE (agency_id, reservation_id),
  CONSTRAINT founding_slot_reservations_one_per_agency UNIQUE (policy_version, agency_id),
  CONSTRAINT founding_slot_reservations_one_per_quote UNIQUE (agency_id, quote_id),
  -- binding targets: a qualifying purchase and an issuance name the reservation of their own quote; a slot names a reservation of itself
  CONSTRAINT founding_slot_reservations_quote_binding UNIQUE (agency_id, quote_id, reservation_id),
  CONSTRAINT founding_slot_reservations_slot_binding UNIQUE (reservation_id, policy_version, slot_no, agency_id),
  CONSTRAINT founding_slot_reservations_quote_fk FOREIGN KEY (agency_id, quote_id) REFERENCES kauro.quotes (agency_id, quote_id),
  CONSTRAINT founding_slot_reservations_slot_fk FOREIGN KEY (policy_version, slot_no) REFERENCES kauro.founding_slots (policy_version, slot_no),
  CONSTRAINT founding_slot_reservations_consumer_fk FOREIGN KEY (agency_id, consumed_by_authorization_id) REFERENCES kauro.commercial_authorizations (agency_id, authorization_id),
  CONSTRAINT founding_slot_reservations_consumption CHECK ((state = 'CONSUMED') = (consumed_at IS NOT NULL) AND (consumed_at IS NULL) = (consumed_by_authorization_id IS NULL)),
  CONSTRAINT founding_slot_reservations_release CHECK ((state = 'RELEASED') = (released_at IS NOT NULL) AND (released_at IS NULL) = (release_reason IS NULL)),
  CONSTRAINT founding_slot_reservations_hold CHECK ((state <> 'RECONCILIATION_HOLD' OR held_at IS NOT NULL) AND (held_at IS NULL OR state <> 'RESERVED'))
);
-- a slot holds at most one live reservation (a consumption holds it for ever)
CREATE UNIQUE INDEX founding_slot_reservations_one_live_per_slot ON kauro.founding_slot_reservations (policy_version, slot_no)
  WHERE state IN ('RESERVED', 'RECONCILIATION_HOLD', 'CONSUMED');
-- the QUOTE_EXPIRY sweep's queue
CREATE INDEX founding_slot_reservations_due ON kauro.founding_slot_reservations (ends_at) WHERE state IN ('RESERVED', 'RECONCILIATION_HOLD');
CREATE TRIGGER founding_slot_reservations_touch BEFORE UPDATE ON kauro.founding_slot_reservations FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER founding_slot_reservations_version BEFORE UPDATE ON kauro.founding_slot_reservations FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER founding_slot_reservations_immutable BEFORE UPDATE ON kauro.founding_slot_reservations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('reservation_id,agency_id,quote_id,policy_version,slot_no,ends_at,created_at');
CREATE TRIGGER founding_slot_reservations_learned_once BEFORE UPDATE ON kauro.founding_slot_reservations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('held_at,consumed_at,consumed_by_authorization_id,released_at,release_reason');
CREATE TRIGGER founding_slot_reservations_transition BEFORE UPDATE OF state ON kauro.founding_slot_reservations
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('FoundingReservation');
CREATE TRIGGER founding_slot_reservations_initial_state BEFORE INSERT ON kauro.founding_slot_reservations
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('FoundingReservation');
CREATE TRIGGER founding_slot_reservations_history AFTER INSERT OR UPDATE OF state ON kauro.founding_slot_reservations
  FOR EACH ROW EXECUTE FUNCTION kauro.record_commercial_transition('FoundingReservation', 'reservation_id', 'state');
CREATE TRIGGER founding_slot_reservations_no_delete BEFORE DELETE ON kauro.founding_slot_reservations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER founding_slot_reservations_no_truncate BEFORE TRUNCATE ON kauro.founding_slot_reservations
  FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

-- A release follows the end of its quote (reservation_released: "the quote EXPIRED, SUPERSEDED or WITHDRAWN"), and names that end.
-- RESERVATION_RELEASE_REFUSED (KC014).
CREATE OR REPLACE FUNCTION kauro.founding_slot_reservations_release_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  quote_state text;
BEGIN
  SELECT q.state INTO quote_state FROM kauro.quotes q WHERE q.agency_id = OLD.agency_id AND q.quote_id = OLD.quote_id;
  IF quote_state IS NULL OR quote_state NOT IN ('EXPIRED', 'SUPERSEDED', 'WITHDRAWN') OR NEW.release_reason IS DISTINCT FROM 'QUOTE_' || quote_state THEN
    RAISE EXCEPTION 'RESERVATION_RELEASE_REFUSED: reservation % is released only once its quote ended, naming how (the quote is %, the reason %)', OLD.reservation_id, coalesce(quote_state, 'not visible'), coalesce(NEW.release_reason, 'none')
      USING ERRCODE = 'KC014';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER founding_slot_reservations_release_guard BEFORE UPDATE OF state ON kauro.founding_slot_reservations
  FOR EACH ROW WHEN (NEW.state = 'RELEASED' AND OLD.state IS DISTINCT FROM 'RELEASED') EXECUTE FUNCTION kauro.founding_slot_reservations_release_guard();

-- ... and frees its slot in the same transaction (checked at COMMIT; KC014)
CREATE OR REPLACE FUNCTION kauro.founding_slot_reservations_released_frees_slot() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF EXISTS (SELECT 1 FROM kauro.founding_slots s WHERE s.policy_version = NEW.policy_version AND s.slot_no = NEW.slot_no AND s.live_reservation_id = NEW.reservation_id) THEN
    RAISE EXCEPTION 'RESERVATION_RELEASE_REFUSED: reservation % is released while slot % still names it', NEW.reservation_id, NEW.slot_no USING ERRCODE = 'KC014';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER founding_slot_reservations_released_frees_slot AFTER UPDATE OF state ON kauro.founding_slot_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state = 'RELEASED') EXECUTE FUNCTION kauro.founding_slot_reservations_released_frees_slot();

-- A reservation is consumed by the designation of a qualifying purchase of its own quote and by nothing else: the designation trigger
-- (below) writes the purchase naming it and then the consumption, one trigger level below the reconciler's statement (DESIGNATION_REWRITE,
-- KC001, otherwise).
CREATE OR REPLACE FUNCTION kauro.founding_slot_reservations_consumed_by_designation() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF pg_trigger_depth() < 2 OR NOT EXISTS (
    SELECT 1 FROM kauro.qualifying_purchases q
     WHERE q.agency_id = OLD.agency_id AND q.founding_reservation_id = OLD.reservation_id AND q.authorization_id = NEW.consumed_by_authorization_id
  ) THEN
    RAISE EXCEPTION 'DESIGNATION_REWRITE: reservation % is consumed only by the designation of a qualifying purchase of its quote', OLD.reservation_id USING ERRCODE = 'KC001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER founding_slot_reservations_consumed_by_designation BEFORE UPDATE OF state ON kauro.founding_slot_reservations
  FOR EACH ROW WHEN (NEW.state = 'CONSUMED' AND OLD.state IS DISTINCT FROM 'CONSUMED') EXECUTE FUNCTION kauro.founding_slot_reservations_consumed_by_designation();

-- end_with_payment_in_flight: only once the reservation's end has passed on the server clock, with its quote still accepted for
-- checkout (the QUOTE_EXPIRY sweep holds it instead of releasing what a capture in flight may still consume; D10-FOUND-4). Named check
-- violation founding_slot_reservations_hold_guard (23514).
CREATE OR REPLACE FUNCTION kauro.founding_slot_reservations_hold_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  quote_state text;
BEGIN
  SELECT q.state INTO quote_state FROM kauro.quotes q WHERE q.agency_id = OLD.agency_id AND q.quote_id = OLD.quote_id;
  IF OLD.ends_at > kauro.server_now() OR quote_state IS DISTINCT FROM 'ACCEPTED_FOR_CHECKOUT' THEN
    RAISE EXCEPTION 'RESERVATION_HOLD: reservation % is held only after its end with its quote accepted for checkout (the quote is %)', OLD.reservation_id, coalesce(quote_state, 'not visible')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'founding_slot_reservations_hold_guard', SCHEMA = 'kauro', TABLE = 'founding_slot_reservations';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER founding_slot_reservations_hold_guard BEFORE UPDATE OF state ON kauro.founding_slot_reservations
  FOR EACH ROW WHEN (NEW.state = 'RECONCILIATION_HOLD' AND OLD.state IS DISTINCT FROM 'RECONCILIATION_HOLD') EXECUTE FUNCTION kauro.founding_slot_reservations_hold_guard();

-- The reservation's birth binds its quote, the quote's snapshot and its slot (checked at COMMIT: CMD027 takes the slot, issues the quote
-- with its snapshot and then records the reservation): the snapshot names this reservation under a founding rate of the same policy, the
-- reservation ends at the quote's price expiry, and while it is RESERVED its quote is ISSUED and its slot names it. Named check
-- violation founding_slot_reservations_snapshot_binding (23514).
CREATE OR REPLACE FUNCTION kauro.founding_slot_reservations_snapshot_binding() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  current_state text;
  quote_state text;
  quote_expiry timestamptz;
  snapshot record;
  slot_live uuid;
BEGIN
  SELECT r.state INTO current_state FROM kauro.founding_slot_reservations r WHERE r.reservation_id = NEW.reservation_id;
  SELECT q.state, q.expires_at INTO quote_state, quote_expiry FROM kauro.quotes q WHERE q.agency_id = NEW.agency_id AND q.quote_id = NEW.quote_id;
  SELECT s.founding_slot_ref, s.founding_discount_bps, s.policy_version INTO snapshot
    FROM kauro.price_eligibility_snapshots s WHERE s.agency_id = NEW.agency_id AND s.quote_id = NEW.quote_id;
  SELECT f.live_reservation_id INTO slot_live FROM kauro.founding_slots f WHERE f.policy_version = NEW.policy_version AND f.slot_no = NEW.slot_no;
  IF snapshot.founding_slot_ref IS DISTINCT FROM NEW.reservation_id OR coalesce(snapshot.founding_discount_bps, 0) = 0
     OR snapshot.policy_version IS DISTINCT FROM NEW.policy_version OR quote_expiry IS DISTINCT FROM NEW.ends_at
     OR (current_state = 'RESERVED' AND (quote_state IS DISTINCT FROM 'ISSUED' OR slot_live IS DISTINCT FROM NEW.reservation_id)) THEN
    RAISE EXCEPTION 'RESERVATION_BINDING: reservation % is not the founding reservation its ISSUED quote''s snapshot names on the slot that names it', NEW.reservation_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'founding_slot_reservations_snapshot_binding', SCHEMA = 'kauro', TABLE = 'founding_slot_reservations';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER founding_slot_reservations_snapshot_binding AFTER INSERT ON kauro.founding_slot_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.founding_slot_reservations_snapshot_binding();

-- the slot names a reservation of itself and of that reservation's agency (checked at COMMIT: the slot is taken before the reservation
-- is written)
ALTER TABLE kauro.founding_slots ADD CONSTRAINT founding_slots_live_reservation_fk
  FOREIGN KEY (live_reservation_id, policy_version, slot_no, live_agency_id) REFERENCES kauro.founding_slot_reservations (reservation_id, policy_version, slot_no, agency_id)
  DEFERRABLE INITIALLY DEFERRED;

-- A slot's identity never changes, and a held slot is never re-pointed to another reservation (RESERVATION_RELEASE_REFUSED, KC014).
CREATE OR REPLACE FUNCTION kauro.founding_slots_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF (NEW.policy_version, NEW.slot_no) IS DISTINCT FROM (OLD.policy_version, OLD.slot_no) THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: founding slot % of % keeps its identity', OLD.slot_no, OLD.policy_version USING ERRCODE = 'KA004';
  END IF;
  IF OLD.held AND NEW.held AND (NEW.live_reservation_id, NEW.live_agency_id) IS DISTINCT FROM (OLD.live_reservation_id, OLD.live_agency_id) THEN
    RAISE EXCEPTION 'RESERVATION_RELEASE_REFUSED: held slot % of % is never re-pointed to another reservation', OLD.slot_no, OLD.policy_version USING ERRCODE = 'KC014';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER founding_slots_guard BEFORE UPDATE ON kauro.founding_slots FOR EACH ROW EXECUTE FUNCTION kauro.founding_slots_guard();
CREATE TRIGGER founding_slots_no_delete BEFORE DELETE ON kauro.founding_slots FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER founding_slots_no_truncate BEFORE TRUNCATE ON kauro.founding_slots FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

-- At COMMIT: a slot is freed only with its reservation RELEASED — a consumed slot is never freed, not by a full refund (R2-096) — and a
-- held slot names a reservation that is not released (a reservation that does not exist is the foreign key's to refuse). KC014.
CREATE OR REPLACE FUNCTION kauro.founding_slots_settled() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  current_live uuid;
  previous_state text;
  live_state text;
BEGIN
  SELECT s.live_reservation_id INTO current_live FROM kauro.founding_slots s WHERE s.policy_version = NEW.policy_version AND s.slot_no = NEW.slot_no;
  IF OLD.live_reservation_id IS NOT NULL AND current_live IS DISTINCT FROM OLD.live_reservation_id THEN
    SELECT r.state INTO previous_state FROM kauro.founding_slot_reservations r WHERE r.reservation_id = OLD.live_reservation_id;
    IF previous_state IS DISTINCT FROM 'RELEASED' THEN
      RAISE EXCEPTION 'RESERVATION_RELEASE_REFUSED: slot % of % is freed while its reservation % is %', NEW.slot_no, NEW.policy_version, OLD.live_reservation_id, coalesce(previous_state, 'not visible')
        USING ERRCODE = 'KC014';
    END IF;
  END IF;
  IF current_live IS NOT NULL THEN
    SELECT r.state INTO live_state FROM kauro.founding_slot_reservations r WHERE r.reservation_id = current_live;
    IF FOUND AND live_state = 'RELEASED' THEN
      RAISE EXCEPTION 'RESERVATION_RELEASE_REFUSED: slot % of % names the released reservation %', NEW.slot_no, NEW.policy_version, current_live USING ERRCODE = 'KC014';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER founding_slots_settled AFTER UPDATE OF held, live_reservation_id, live_agency_id ON kauro.founding_slots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.founding_slots_settled();

-- --- the recurrence history: the agency's confirmations and its qualifying purchases (D10-FIRST-1, D10-REC-1) ------------------------
-- agency_recurrence: one row per agency with a qualifying purchase — the number of its confirmations and its sticky first designation
-- (17 "First qualifying project"; policy commission.firstProjectDesignation STICKY_AFTER_FIRST_CAPTURE). Its row lock and the exclusive
-- half of the transition subject kauro.agency_recurrence serialize the designations of one agency (R2-137). Written by the designation
-- trigger only: the first designation never changes and the count grows by one per confirmation (DESIGNATION_REWRITE, KC001).
CREATE TABLE kauro.agency_recurrence (
  agency_id               uuid PRIMARY KEY REFERENCES kauro.agencies (agency_id),
  confirmation_count      integer NOT NULL CHECK (confirmation_count >= 1),
  first_seq               integer NOT NULL DEFAULT 1 CHECK (first_seq = 1),
  first_authorization_id  uuid NOT NULL,
  first_capture_id        uuid NOT NULL,
  first_project_id        uuid NOT NULL,
  first_confirmed_at      timestamptz NOT NULL,
  last_confirmed_at       timestamptz NOT NULL,
  created_at              timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL,
  CONSTRAINT agency_recurrence_confirmation_order CHECK (last_confirmed_at >= first_confirmed_at)
);

-- qualifying_purchases: an original CommercialAuthorization (rebinding_id NULL; B09 KP004: its capture alone paid the whole obligation
-- and the subject still bound) recorded in the payment service's reconciler transaction — "the persisted first designation and
-- financial inbox transaction are the authority" (example 9). The confirmation sequence is the agency's (1 is the first designation);
-- confirmed_at is the authorization's server instant and provider_completed_at the capture's, recorded apart (R2-137, R2-138);
-- order_created_at makes an implausible provider time visible (example 10); allocated_service_cents is the capture's allocated service
-- (the recurrence basis before refunds); founding_basis records whether the quote's founding rate was backed by a reservation of the
-- cohort (RESERVED_SLOT, consumed here), not founding (NONE), or named none (UNBACKED: B09's fixtures fabricate founding references; such
-- a purchase is never counted as a slot; D10-REC-3). Nothing rewrites a row (KC001).
CREATE TABLE kauro.qualifying_purchases (
  authorization_id         uuid PRIMARY KEY,
  agency_id                uuid NOT NULL REFERENCES kauro.agency_recurrence (agency_id),
  project_id               uuid NOT NULL,
  quote_id                 uuid NOT NULL,
  order_id                 uuid NOT NULL,
  capture_id               uuid NOT NULL,
  confirmation_seq         integer NOT NULL CHECK (confirmation_seq >= 1),
  confirmed_at             timestamptz NOT NULL,
  provider_completed_at    timestamptz NOT NULL,
  order_created_at         timestamptz NOT NULL,
  allocated_service_cents  bigint NOT NULL CHECK (kauro.is_money(allocated_service_cents)),
  founding_basis           text NOT NULL CHECK (founding_basis IN ('NONE', 'RESERVED_SLOT', 'UNBACKED')),
  founding_reservation_id  uuid,
  created_at               timestamptz NOT NULL,
  UNIQUE (agency_id, authorization_id),
  CONSTRAINT qualifying_purchases_one_sequence UNIQUE (agency_id, confirmation_seq),
  CONSTRAINT qualifying_purchases_one_per_capture UNIQUE (agency_id, capture_id),
  CONSTRAINT qualifying_purchases_one_per_reservation UNIQUE (founding_reservation_id),
  -- binding target of agency_recurrence_first_fk: the first designation is exactly the agency's purchase of sequence 1
  CONSTRAINT qualifying_purchases_designation_binding UNIQUE (agency_id, confirmation_seq, authorization_id, capture_id, project_id, confirmed_at),
  -- the purchase is exactly its authorization's: capture, quote, order and project (composite keys, agency in each)
  CONSTRAINT qualifying_purchases_authorization_fk FOREIGN KEY (agency_id, authorization_id, capture_id, quote_id)
    REFERENCES kauro.commercial_authorizations (agency_id, authorization_id, capture_id, quote_id),
  CONSTRAINT qualifying_purchases_capture_fk FOREIGN KEY (agency_id, capture_id, order_id) REFERENCES kauro.capture_facts (agency_id, capture_id, order_id),
  CONSTRAINT qualifying_purchases_order_fk FOREIGN KEY (agency_id, order_id, quote_id) REFERENCES kauro.payment_orders (agency_id, order_id, quote_id),
  CONSTRAINT qualifying_purchases_quote_fk FOREIGN KEY (agency_id, quote_id, project_id) REFERENCES kauro.quotes (agency_id, quote_id, project_id),
  -- a consumed reservation is the reservation of the purchase's own quote
  CONSTRAINT qualifying_purchases_reservation_fk FOREIGN KEY (agency_id, quote_id, founding_reservation_id)
    REFERENCES kauro.founding_slot_reservations (agency_id, quote_id, reservation_id),
  CONSTRAINT qualifying_purchases_founding_basis CHECK ((founding_basis = 'RESERVED_SLOT') = (founding_reservation_id IS NOT NULL))
);
CREATE INDEX qualifying_purchases_window ON kauro.qualifying_purchases (agency_id, confirmed_at);
ALTER TABLE kauro.agency_recurrence ADD CONSTRAINT agency_recurrence_first_fk
  FOREIGN KEY (agency_id, first_seq, first_authorization_id, first_capture_id, first_project_id, first_confirmed_at)
  REFERENCES kauro.qualifying_purchases (agency_id, confirmation_seq, authorization_id, capture_id, project_id, confirmed_at) DEFERRABLE INITIALLY DEFERRED;

-- the designation's writes only, one trigger level below the reconciler's statement: the first designation fixed, the count by one
CREATE OR REPLACE FUNCTION kauro.agency_recurrence_designation_only() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF TG_OP NOT IN ('INSERT', 'UPDATE') OR pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'DESIGNATION_REWRITE: an agency''s recurrence is written by the designation of its qualifying purchases only' USING ERRCODE = 'KC001';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.confirmation_count <> 1 THEN
    RAISE EXCEPTION 'DESIGNATION_REWRITE: the recurrence of agency % starts at its first confirmation', NEW.agency_id USING ERRCODE = 'KC001';
  END IF;
  IF TG_OP = 'UPDATE' AND (
       (NEW.agency_id, NEW.first_seq, NEW.first_authorization_id, NEW.first_capture_id, NEW.first_project_id, NEW.first_confirmed_at, NEW.created_at)
         IS DISTINCT FROM (OLD.agency_id, OLD.first_seq, OLD.first_authorization_id, OLD.first_capture_id, OLD.first_project_id, OLD.first_confirmed_at, OLD.created_at)
       OR NEW.confirmation_count <> OLD.confirmation_count + 1 OR NEW.last_confirmed_at < OLD.last_confirmed_at) THEN
    RAISE EXCEPTION 'DESIGNATION_REWRITE: agency % keeps its first designation and counts its confirmations one at a time', OLD.agency_id USING ERRCODE = 'KC001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER agency_recurrence_designation_only BEFORE INSERT OR UPDATE OR DELETE ON kauro.agency_recurrence
  FOR EACH ROW EXECUTE FUNCTION kauro.agency_recurrence_designation_only();
CREATE TRIGGER agency_recurrence_no_truncate BEFORE TRUNCATE ON kauro.agency_recurrence
  FOR EACH STATEMENT EXECUTE FUNCTION kauro.agency_recurrence_designation_only();

-- a qualifying purchase is recorded once, by its designation, and never rewritten
CREATE OR REPLACE FUNCTION kauro.qualifying_purchases_designation_only() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF TG_OP <> 'INSERT' OR pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'DESIGNATION_REWRITE: a qualifying purchase is recorded once, by the designation of its authorization, and never rewritten (% refused)', TG_OP USING ERRCODE = 'KC001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER qualifying_purchases_designation_only BEFORE INSERT OR UPDATE OR DELETE ON kauro.qualifying_purchases
  FOR EACH ROW EXECUTE FUNCTION kauro.qualifying_purchases_designation_only();
CREATE TRIGGER qualifying_purchases_no_truncate BEFORE TRUNCATE ON kauro.qualifying_purchases
  FOR EACH STATEMENT EXECUTE FUNCTION kauro.qualifying_purchases_designation_only();

-- The designation (D10-FIRST-1): after the insert of an original authorization, in the payment service's reconciler transaction, the
-- exclusive half of the agency's recurrence lock (so a CreateQuote holding the shared half across its snapshot sees the purchase wholly
-- or not at all; D10-REC-2), the recurrence row's lock through its upsert (the next confirmation sequence), the qualifying purchase, and
-- the consumption of the quote's live founding reservation (RESERVED or RECONCILIATION_HOLD -> CONSUMED). The mirror into
-- agencies.first_qualifying_capture_id is the commission service's, never the reconciler's (D10-FIRST-2).
CREATE OR REPLACE FUNCTION kauro.designate_qualifying_purchase() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  confirmed timestamptz := kauro.server_now();
  paid record;
  ordered timestamptz;
  priced record;
  reservation uuid;
  basis text := 'NONE';
  seq integer;
BEGIN
  PERFORM pg_advisory_xact_lock(kauro.transition_key('kauro.agency_recurrence', NEW.agency_id::text));
  SELECT c.allocated_service_cents, c.provider_completed_at INTO paid FROM kauro.capture_facts c WHERE c.agency_id = NEW.agency_id AND c.capture_id = NEW.capture_id;
  SELECT o.created_at INTO ordered FROM kauro.payment_orders o WHERE o.agency_id = NEW.agency_id AND o.order_id = NEW.order_id;
  SELECT s.founding_discount_bps, s.founding_slot_ref INTO priced FROM kauro.price_eligibility_snapshots s WHERE s.agency_id = NEW.agency_id AND s.quote_id = NEW.quote_id;
  IF paid.provider_completed_at IS NULL OR ordered IS NULL OR priced.founding_discount_bps IS NULL THEN
    RAISE EXCEPTION 'CONTEXT: the capture, order or eligibility snapshot of authorization % is not visible to its designation', NEW.authorization_id USING ERRCODE = 'KA006';
  END IF;
  IF priced.founding_discount_bps > 0 THEN
    SELECT r.reservation_id INTO reservation FROM kauro.founding_slot_reservations r
     WHERE r.agency_id = NEW.agency_id AND r.quote_id = NEW.quote_id AND r.reservation_id = priced.founding_slot_ref AND r.state IN ('RESERVED', 'RECONCILIATION_HOLD')
       FOR UPDATE;
    basis := CASE WHEN reservation IS NULL THEN 'UNBACKED' ELSE 'RESERVED_SLOT' END;
  END IF;
  INSERT INTO kauro.agency_recurrence AS r (agency_id, confirmation_count, first_authorization_id, first_capture_id, first_project_id, first_confirmed_at, last_confirmed_at, created_at, updated_at)
  VALUES (NEW.agency_id, 1, NEW.authorization_id, NEW.capture_id, NEW.project_id, confirmed, confirmed, confirmed, confirmed)
  ON CONFLICT (agency_id) DO UPDATE SET confirmation_count = r.confirmation_count + 1, last_confirmed_at = EXCLUDED.last_confirmed_at, updated_at = EXCLUDED.updated_at
  RETURNING r.confirmation_count INTO seq;
  INSERT INTO kauro.qualifying_purchases (authorization_id, agency_id, project_id, quote_id, order_id, capture_id, confirmation_seq, confirmed_at, provider_completed_at, order_created_at,
                                          allocated_service_cents, founding_basis, founding_reservation_id, created_at)
  VALUES (NEW.authorization_id, NEW.agency_id, NEW.project_id, NEW.quote_id, NEW.order_id, NEW.capture_id, seq, confirmed, paid.provider_completed_at, ordered,
          paid.allocated_service_cents, basis, reservation, confirmed);
  IF reservation IS NOT NULL THEN
    UPDATE kauro.founding_slot_reservations
       SET state = 'CONSUMED', consumed_at = confirmed, consumed_by_authorization_id = NEW.authorization_id, version = version + 1
     WHERE reservation_id = reservation;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER commercial_authorizations_designation AFTER INSERT ON kauro.commercial_authorizations
  FOR EACH ROW WHEN (NEW.rebinding_id IS NULL) EXECUTE FUNCTION kauro.designate_qualifying_purchase();

-- The other writers of the eligibility set take the same exclusive half (D10-REC-2): a refund's completion (the service basis falls)
-- and a capture's reversal (the basis becomes zero). After the refund's and the capture's own locks, in the global order of design §10.
CREATE OR REPLACE FUNCTION kauro.take_recurrence_lock() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM pg_advisory_xact_lock(kauro.transition_key('kauro.agency_recurrence', NEW.agency_id::text));
  RETURN NULL;
END
$$;
CREATE TRIGGER refunds_recurrence_lock AFTER UPDATE OF state ON kauro.refunds
  FOR EACH ROW WHEN (NEW.state = 'COMPLETED' AND OLD.state IS DISTINCT FROM 'COMPLETED') EXECUTE FUNCTION kauro.take_recurrence_lock();
CREATE TRIGGER capture_facts_recurrence_lock AFTER UPDATE OF status ON kauro.capture_facts
  FOR EACH ROW WHEN (NEW.status = 'REVERSED' AND OLD.status IS DISTINCT FROM 'REVERSED') EXECUTE FUNCTION kauro.take_recurrence_lock();

-- --- the eligibility set (D10-REC-1..3) ---------------------------------------------------------------------------------------------
-- The one definition of the prior projects that count at `as_of` for a quote of `project`: a qualifying purchase of another project of
-- the agency confirmed in [as_of - 8760 hours, as_of) (365 duration days, time-zone independent; B09 D-TIME-B1) whose remaining service
-- basis is positive — its allocated service less its COMPLETED service refunds, zero once its capture is REVERSED (R2-089; a fully
-- refunded purchase leaves the set, its designation stays) — each project once however many purchases it has. CMD027 inserts its
-- snapshot's set from this function after taking the shared half of the agency's recurrence lock; the domain mirrors it for units.
-- SECURITY INVOKER: the caller's policies decide what it reads (an agency's session its own purchases only).
CREATE OR REPLACE FUNCTION kauro.qualifying_projects_at(agency uuid, as_of timestamptz, project uuid) RETURNS TABLE (project_id uuid)
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$
  SELECT DISTINCT q.project_id
    FROM kauro.qualifying_purchases q
    JOIN kauro.capture_facts c ON c.agency_id = q.agency_id AND c.capture_id = q.capture_id
   WHERE q.agency_id = agency
     AND q.confirmed_at >= as_of - interval '8760 hours' AND q.confirmed_at < as_of
     AND q.project_id IS DISTINCT FROM project
     AND c.status <> 'REVERSED'
     AND q.allocated_service_cents > (
       SELECT coalesce(sum(r.approved_service_cents), 0) FROM kauro.refunds r WHERE r.agency_id = q.agency_id AND r.capture_id = q.capture_id AND r.state = 'COMPLETED'
     )
$$;

-- The divergences of the issued snapshots from the recurrence history, for review (D10-REC-3; Q10-1, Q10-7) — no guard is added to
-- B09's snapshot table, whose fixtures fabricate founding references and sets. Exact because a basis only falls (D10-ADJ-2): a project
-- whose basis is positive now had a positive basis at its snapshot's as_of.
--   UNSUPPORTED_PROJECT     a counted project has no qualifying purchase of the agency confirmed in the snapshot's window
--   MISSING_PROJECT         a project with such a purchase whose basis is still positive is not counted
--   PARTLY_REFUNDED_COUNTED a counted project's purchase in the window is partly refunded (the owner's review of nominal balances)
--   UNBACKED_FOUNDING_RATE  a founding rate names no reservation of the quote
CREATE OR REPLACE FUNCTION kauro.eligibility_findings() RETURNS TABLE (agency_id uuid, quote_id uuid, finding text, project_id uuid)
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$
  SELECT s.agency_id, s.quote_id, 'UNSUPPORTED_PROJECT', p.id
    FROM kauro.price_eligibility_snapshots s CROSS JOIN LATERAL unnest(s.qualifying_project_ids) AS p(id)
   WHERE NOT EXISTS (
     SELECT 1 FROM kauro.qualifying_purchases q
      WHERE q.agency_id = s.agency_id AND q.project_id = p.id AND q.confirmed_at >= s.lookback_starts_at AND q.confirmed_at < s.as_of
   )
  UNION ALL
  SELECT s.agency_id, s.quote_id, 'MISSING_PROJECT', m.project_id
    FROM kauro.price_eligibility_snapshots s CROSS JOIN LATERAL kauro.qualifying_projects_at(s.agency_id, s.as_of, s.project_id) AS m
   WHERE NOT (m.project_id = ANY (s.qualifying_project_ids))
  UNION ALL
  SELECT s.agency_id, s.quote_id, 'PARTLY_REFUNDED_COUNTED', p.id
    FROM kauro.price_eligibility_snapshots s CROSS JOIN LATERAL unnest(s.qualifying_project_ids) AS p(id)
   WHERE EXISTS (
     SELECT 1 FROM kauro.qualifying_purchases q
      WHERE q.agency_id = s.agency_id AND q.project_id = p.id AND q.confirmed_at >= s.lookback_starts_at AND q.confirmed_at < s.as_of
        AND (SELECT coalesce(sum(r.approved_service_cents), 0) FROM kauro.refunds r WHERE r.agency_id = q.agency_id AND r.capture_id = q.capture_id AND r.state = 'COMPLETED')
            BETWEEN 1 AND q.allocated_service_cents - 1
   )
  UNION ALL
  SELECT s.agency_id, s.quote_id, 'UNBACKED_FOUNDING_RATE', NULL::uuid
    FROM kauro.price_eligibility_snapshots s
   WHERE s.founding_discount_bps > 0 AND NOT EXISTS (
     SELECT 1 FROM kauro.founding_slot_reservations r WHERE r.agency_id = s.agency_id AND r.quote_id = s.quote_id AND r.reservation_id = s.founding_slot_ref
   )
$$;

-- --- quote issuances (D10-QUOTE-1, D10-QUOTE-4) ---------------------------------------------------------------------------------
-- CMD027's record of what one journal entry issued: the quote, the unpaid quote it superseded or the paid quote it replaces (the
-- included replacement resumes by this row; D-M3-B6), and the founding reservation it took. Checked at COMMIT against the rows it
-- names: the issued quote's own replaces_quote_id, a superseded quote SUPERSEDED by exactly this one, the reservation exactly the quote's
-- (named check violation quote_issuances_binding, 23514). Append-only; the agency's request handlers write it.
CREATE TABLE kauro.quote_issuances (
  entry_id             uuid NOT NULL,
  agency_id            uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id           uuid NOT NULL,
  quote_id             uuid NOT NULL,
  superseded_quote_id  uuid,
  replaced_quote_id    uuid,
  reservation_id       uuid,
  issued_at            timestamptz NOT NULL,
  PRIMARY KEY (agency_id, entry_id),
  CONSTRAINT quote_issuances_one_per_quote UNIQUE (agency_id, quote_id),
  CONSTRAINT quote_issuances_entry_fk FOREIGN KEY (agency_id, entry_id) REFERENCES kauro.command_journal (agency_id, entry_id),
  CONSTRAINT quote_issuances_quote_fk FOREIGN KEY (agency_id, quote_id, project_id) REFERENCES kauro.quotes (agency_id, quote_id, project_id),
  CONSTRAINT quote_issuances_superseded_fk FOREIGN KEY (agency_id, superseded_quote_id, project_id) REFERENCES kauro.quotes (agency_id, quote_id, project_id),
  CONSTRAINT quote_issuances_replaced_fk FOREIGN KEY (agency_id, replaced_quote_id, project_id) REFERENCES kauro.quotes (agency_id, quote_id, project_id),
  CONSTRAINT quote_issuances_reservation_fk FOREIGN KEY (agency_id, quote_id, reservation_id) REFERENCES kauro.founding_slot_reservations (agency_id, quote_id, reservation_id),
  CONSTRAINT quote_issuances_one_predecessor CHECK (superseded_quote_id IS NULL OR replaced_quote_id IS NULL),
  CONSTRAINT quote_issuances_not_self CHECK (quote_id IS DISTINCT FROM superseded_quote_id AND quote_id IS DISTINCT FROM replaced_quote_id)
);
CREATE TRIGGER quote_issuances_append_only BEFORE UPDATE OR DELETE ON kauro.quote_issuances FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER quote_issuances_no_truncate BEFORE TRUNCATE ON kauro.quote_issuances FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

CREATE OR REPLACE FUNCTION kauro.quote_issuances_binding() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  replaces uuid;
BEGIN
  SELECT q.replaces_quote_id INTO replaces FROM kauro.quotes q WHERE q.agency_id = NEW.agency_id AND q.quote_id = NEW.quote_id;
  IF replaces IS DISTINCT FROM NEW.replaced_quote_id
     OR (NEW.superseded_quote_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM kauro.quotes s WHERE s.agency_id = NEW.agency_id AND s.quote_id = NEW.superseded_quote_id AND s.state = 'SUPERSEDED' AND s.superseded_by_quote_id = NEW.quote_id))
     OR NEW.reservation_id IS DISTINCT FROM (SELECT r.reservation_id FROM kauro.founding_slot_reservations r WHERE r.agency_id = NEW.agency_id AND r.quote_id = NEW.quote_id) THEN
    RAISE EXCEPTION 'ISSUANCE_BINDING: issuance % does not record what its quote % superseded, replaced and reserved', NEW.entry_id, NEW.quote_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'quote_issuances_binding', SCHEMA = 'kauro', TABLE = 'quote_issuances';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER quote_issuances_binding AFTER INSERT ON kauro.quote_issuances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.quote_issuances_binding();

-- --- agreement versions and acceptances (D10-AGY-1) ---------------------------------------------------------------------------------
-- The reviewed agreement texts the platform offers (B19 publishes their content, R2-111): a version is born PUBLISHED and only retires;
-- one PUBLISHED version per kind. CMD002 accepts exactly the PUBLISHED versions, read after their transition locks (a retirement in
-- flight is ordered before or after an activation). Platform rows: the control plane records them, the request handlers read them.
CREATE TABLE kauro.service_agreement_versions (
  agreement_kind  text NOT NULL CHECK (agreement_kind IN ('TERMS', 'PRIVACY')),
  version         text NOT NULL CHECK (kauro.is_label(version)),
  document_hash   text NOT NULL CHECK (kauro.is_sha256_hex(document_hash)),
  state           text NOT NULL DEFAULT 'PUBLISHED' CHECK (state IN ('PUBLISHED', 'RETIRED')),
  published_at    timestamptz NOT NULL,
  retired_at      timestamptz,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  PRIMARY KEY (agreement_kind, version),
  -- binding target of the acceptances: a version accepted with exactly its document
  CONSTRAINT service_agreement_versions_document_binding UNIQUE (agreement_kind, version, document_hash),
  CONSTRAINT service_agreement_versions_retired_binding CHECK ((state = 'RETIRED') = (retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX service_agreement_versions_one_published ON kauro.service_agreement_versions (agreement_kind) WHERE state = 'PUBLISHED';
-- born PUBLISHED; PUBLISHED -> RETIRED is the one edge (UNLISTED_TRANSITION, KA008)
CREATE OR REPLACE FUNCTION kauro.service_agreement_versions_edge() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.state <> 'PUBLISHED' THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: agreement version % % is born PUBLISHED', NEW.agreement_kind, NEW.version USING ERRCODE = 'KA008';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.state IS DISTINCT FROM OLD.state AND NOT (OLD.state = 'PUBLISHED' AND NEW.state = 'RETIRED') THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: agreement version % % % -> % is not a listed edge', OLD.agreement_kind, OLD.version, OLD.state, NEW.state USING ERRCODE = 'KA008';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER service_agreement_versions_edge BEFORE INSERT OR UPDATE ON kauro.service_agreement_versions
  FOR EACH ROW EXECUTE FUNCTION kauro.service_agreement_versions_edge();
CREATE TRIGGER service_agreement_versions_touch BEFORE UPDATE ON kauro.service_agreement_versions FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER service_agreement_versions_immutable BEFORE UPDATE ON kauro.service_agreement_versions
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('agreement_kind,version,document_hash,published_at,created_at');
CREATE TRIGGER service_agreement_versions_learned_once BEFORE UPDATE ON kauro.service_agreement_versions
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('retired_at');
CREATE TRIGGER service_agreement_versions_transition_lock BEFORE UPDATE OF state ON kauro.service_agreement_versions
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.take_transition_lock('kauro.service_agreement_versions', 'agreement_kind', 'version');
CREATE TRIGGER service_agreement_versions_no_delete BEFORE DELETE ON kauro.service_agreement_versions FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER service_agreement_versions_no_truncate BEFORE TRUNCATE ON kauro.service_agreement_versions FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

-- An agency's acceptance of the published terms and privacy versions with their exact documents, by its ACTIVE OWNER acting as itself,
-- at an instant (CMD002: "record versioned acceptance"; no default, no implicit signature). Append-only (kauro.forbid_change).
CREATE TABLE kauro.agency_agreement_acceptances (
  acceptance_id          uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(acceptance_id)),
  agency_id              uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  membership_id          uuid NOT NULL,
  user_id                uuid NOT NULL,
  terms_kind             text NOT NULL DEFAULT 'TERMS' CHECK (terms_kind = 'TERMS'),
  terms_version          text NOT NULL,
  terms_document_hash    text NOT NULL,
  privacy_kind           text NOT NULL DEFAULT 'PRIVACY' CHECK (privacy_kind = 'PRIVACY'),
  privacy_version        text NOT NULL,
  privacy_document_hash  text NOT NULL,
  accepted_at            timestamptz NOT NULL,
  created_at             timestamptz NOT NULL,
  UNIQUE (agency_id, acceptance_id),
  CONSTRAINT agency_agreement_acceptances_membership_fk FOREIGN KEY (agency_id, membership_id, user_id) REFERENCES kauro.memberships (agency_id, membership_id, user_id),
  CONSTRAINT agency_agreement_acceptances_terms_fk FOREIGN KEY (terms_kind, terms_version, terms_document_hash)
    REFERENCES kauro.service_agreement_versions (agreement_kind, version, document_hash),
  CONSTRAINT agency_agreement_acceptances_privacy_fk FOREIGN KEY (privacy_kind, privacy_version, privacy_document_hash)
    REFERENCES kauro.service_agreement_versions (agreement_kind, version, document_hash)
);
CREATE TRIGGER agency_agreement_acceptances_append_only BEFORE UPDATE OR DELETE ON kauro.agency_agreement_acceptances FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER agency_agreement_acceptances_no_truncate BEFORE TRUNCATE ON kauro.agency_agreement_acceptances FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

-- the versions PUBLISHED (named check violation agency_agreement_acceptances_published, 23514) and the membership an ACTIVE OWNER
-- (MEMBERSHIP_AUTHORITY, KA010), each read after its transition lock; a version or membership that does not exist is its foreign key's
-- to refuse
CREATE OR REPLACE FUNCTION kauro.agency_agreement_acceptances_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  accepting record;
BEGIN
  PERFORM kauro.await_transition('kauro.service_agreement_versions', 'TERMS:' || NEW.terms_version);
  PERFORM kauro.await_transition('kauro.service_agreement_versions', 'PRIVACY:' || NEW.privacy_version);
  IF EXISTS (
    SELECT 1 FROM kauro.service_agreement_versions v
     WHERE ((v.agreement_kind = 'TERMS' AND v.version = NEW.terms_version AND v.document_hash = NEW.terms_document_hash)
            OR (v.agreement_kind = 'PRIVACY' AND v.version = NEW.privacy_version AND v.document_hash = NEW.privacy_document_hash))
       AND v.state <> 'PUBLISHED'
  ) THEN
    RAISE EXCEPTION 'AGREEMENT_VERSION_NOT_PUBLISHED: agency % accepts only the PUBLISHED agreement versions', NEW.agency_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agency_agreement_acceptances_published', SCHEMA = 'kauro', TABLE = 'agency_agreement_acceptances';
  END IF;
  PERFORM kauro.await_transition('kauro.memberships', NEW.agency_id::text || ':' || NEW.user_id::text);
  SELECT m.role, m.state INTO accepting FROM kauro.memberships m WHERE m.agency_id = NEW.agency_id AND m.membership_id = NEW.membership_id AND m.user_id = NEW.user_id;
  IF FOUND AND (accepting.role <> 'OWNER' OR accepting.state <> 'ACTIVE') THEN
    RAISE EXCEPTION 'MEMBERSHIP_AUTHORITY: the agreements of agency % are accepted by its ACTIVE OWNER only', NEW.agency_id USING ERRCODE = 'KA010';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER agency_agreement_acceptances_guard BEFORE INSERT ON kauro.agency_agreement_acceptances
  FOR EACH ROW EXECUTE FUNCTION kauro.agency_agreement_acceptances_guard();

-- --- the closure record (D10-AGY-2, D10-AGY-4) ----------------------------------------------------------------------------------------
-- CMD043's record, written with the move to CLOSING (checked at COMMIT; named check violation agency_closures_agency_closing, 23514)
-- by the agency's ACTIVE OWNER under a step-up proof of its own: the state it left and the obligations inventory — open quotes
-- withdrawn, live authorizations, open refunds, non-terminal tax documents, OPEN reconciliation cases with kind, amount and age, active
-- work, the managed-deletion schedule — as a closed object of references, counts and amounts. One per agency; append-only.
CREATE TABLE kauro.agency_closures (
  closure_id                  uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(closure_id)),
  agency_id                   uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  requested_by_membership_id  uuid NOT NULL,
  requested_by_user_id        uuid NOT NULL,
  assurance_proof_ref         uuid NOT NULL,
  from_state                  text NOT NULL CHECK (from_state IN ('DRAFT', 'ACTIVE', 'RESTRICTED')),
  obligations                 jsonb NOT NULL CHECK (jsonb_typeof(obligations) = 'object' AND pg_column_size(obligations) <= 262144),
  obligations_hash            text NOT NULL CHECK (kauro.is_sha256_hex(obligations_hash)),
  deletion_scheduled_for      timestamptz,
  requested_at                timestamptz NOT NULL,
  created_at                  timestamptz NOT NULL,
  CONSTRAINT agency_closures_one_per_agency UNIQUE (agency_id),
  UNIQUE (agency_id, closure_id),
  CONSTRAINT agency_closures_requester_fk FOREIGN KEY (agency_id, requested_by_membership_id, requested_by_user_id) REFERENCES kauro.memberships (agency_id, membership_id, user_id),
  -- the step-up is the requester's own proof (08 "High-impact actions require recent step-up")
  CONSTRAINT agency_closures_proof_fk FOREIGN KEY (requested_by_user_id, assurance_proof_ref) REFERENCES kauro.assurance_proofs (user_id, proof_id)
);
CREATE TRIGGER agency_closures_append_only BEFORE UPDATE OR DELETE ON kauro.agency_closures FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER agency_closures_no_truncate BEFORE TRUNCATE ON kauro.agency_closures FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

CREATE OR REPLACE FUNCTION kauro.agency_closures_requester() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM kauro.await_transition('kauro.memberships', NEW.agency_id::text || ':' || NEW.requested_by_user_id::text);
  IF NOT EXISTS (
    SELECT 1 FROM kauro.memberships m
     WHERE m.agency_id = NEW.agency_id AND m.membership_id = NEW.requested_by_membership_id AND m.user_id = NEW.requested_by_user_id AND m.role = 'OWNER' AND m.state = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'MEMBERSHIP_AUTHORITY: the closure of agency % is requested by its ACTIVE OWNER only', NEW.agency_id USING ERRCODE = 'KA010';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER agency_closures_requester BEFORE INSERT ON kauro.agency_closures FOR EACH ROW EXECUTE FUNCTION kauro.agency_closures_requester();

CREATE OR REPLACE FUNCTION kauro.agency_closures_agency_closing() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM kauro.agencies a WHERE a.agency_id = NEW.agency_id AND a.state IN ('CLOSING', 'CLOSED')) THEN
    RAISE EXCEPTION 'CLOSURE_RECORD: the closure record of agency % is written with its move to CLOSING', NEW.agency_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agency_closures_agency_closing', SCHEMA = 'kauro', TABLE = 'agency_closures';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER agency_closures_agency_closing AFTER INSERT ON kauro.agency_closures
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.agency_closures_agency_closing();

-- --- reviewed relationship decisions (R2-141; D10-AGY-3) ------------------------------------------------------------------------------
-- A consolidation of legal agencies is a recorded, reviewed decision of the corporate owner — the agencies, the evidence, the effective
-- instant and an enumerated treatment — that merges no dataset, membership, designation or attribution and changes no quote
-- eligibility (Q10-3: no grouping). A display-name change is no decision at all: every B10 fact keys on agency_id. Append-only.
CREATE TABLE kauro.agency_relationship_decisions (
  decision_id          uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(decision_id)),
  agency_id            uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  related_agency_id    uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  treatment            text NOT NULL CHECK (treatment IN ('SEPARATE_TENANTS_CONFIRMED', 'COMMON_CONTROL_RECORDED', 'LEGAL_SUCCESSOR_RECORDED')),
  evidence_hash        text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  effective_at         timestamptz NOT NULL,
  reviewed_by_user_id  uuid NOT NULL REFERENCES kauro.identities (user_id),
  decided_at           timestamptz NOT NULL,
  created_at           timestamptz NOT NULL,
  UNIQUE (agency_id, decision_id),
  CONSTRAINT agency_relationship_decisions_two_agencies CHECK (agency_id <> related_agency_id)
);
CREATE TRIGGER agency_relationship_decisions_append_only BEFORE UPDATE OR DELETE ON kauro.agency_relationship_decisions FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER agency_relationship_decisions_no_truncate BEFORE TRUNCATE ON kauro.agency_relationship_decisions FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

-- --- the agency: the set-once first designation (D10-FIRST-2) and the closure residuals (D10-AGY-2, D10-AGY-4, D10-AGY-5) -----------
-- agencies.first_qualifying_capture_id (registry Agency.firstQualifyingCaptureId) is written once — by the commission service's
-- COMMISSIONS consumer, agency row first, with a version bump and agency.first_purchase_designated.v1 — and equals the capture of the
-- agency's first qualifying purchase; nothing rewrites it (DESIGNATION_REWRITE, KC001). The version that sets it carries exactly that
-- event (EVENT_MISSING, KA003, at COMMIT), which the request handlers may not publish (domain_events_tenant_not_first_designation).
CREATE OR REPLACE FUNCTION kauro.agencies_first_designation() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.first_qualifying_capture_id IS NOT NULL THEN
    RAISE EXCEPTION 'DESIGNATION_REWRITE: the first designation of agency % is set once', OLD.agency_id USING ERRCODE = 'KC001';
  END IF;
  IF NEW.first_qualifying_capture_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM kauro.agency_recurrence r WHERE r.agency_id = NEW.agency_id AND r.first_capture_id = NEW.first_qualifying_capture_id
  ) THEN
    RAISE EXCEPTION 'DESIGNATION_REWRITE: agency % designates the capture of its first qualifying purchase only', NEW.agency_id USING ERRCODE = 'KC001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER agencies_first_designation_birth BEFORE INSERT ON kauro.agencies
  FOR EACH ROW WHEN (NEW.first_qualifying_capture_id IS NOT NULL) EXECUTE FUNCTION kauro.agencies_first_designation();
CREATE TRIGGER agencies_first_designation BEFORE UPDATE OF first_qualifying_capture_id ON kauro.agencies
  FOR EACH ROW WHEN (OLD.first_qualifying_capture_id IS DISTINCT FROM NEW.first_qualifying_capture_id) EXECUTE FUNCTION kauro.agencies_first_designation();

CREATE OR REPLACE FUNCTION kauro.agencies_first_designation_event() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.domain_events e
     WHERE e.agency_id = NEW.agency_id AND e.aggregate_kind = 'agency' AND e.aggregate_id = NEW.agency_id AND e.aggregate_version = NEW.version
       AND e.event_type = 'agency.first_purchase_designated.v1'
  ) THEN
    RAISE EXCEPTION 'EVENT_MISSING: agency % version % sets its first designation without agency.first_purchase_designated.v1', NEW.agency_id, NEW.version USING ERRCODE = 'KA003';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER agencies_first_designation_event AFTER UPDATE OF first_qualifying_capture_id ON kauro.agencies
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.first_qualifying_capture_id IS DISTINCT FROM NEW.first_qualifying_capture_id)
  EXECUTE FUNCTION kauro.agencies_first_designation_event();

-- closure_obligations_completed (CLOSING -> CLOSED; its performer is B16, D10-AGY-2) is refused while an obligation of the agency is
-- open (CLOSURE_RESIDUALS_OPEN, KC006): a payment order not CAPTURED, FAILED, CANCELLED or EXPIRED; a refund not COMPLETED, FAILED or
-- REJECTED; a live authorization (ACTIVE or CONSUMED: a DELIVERED one is fulfilled service); a tax document DRAFT, VALIDATED,
-- SUBMITTING, UNCERTAIN or REJECTED (an ISSUED document is final until a correction, which opens its own draft); an OPEN reconciliation
-- case of any kind — since 0019 an UNKNOWN_REFUND keyed by provider_ref, money that left with no local refund (D10-AGY-4, D10-AGY-5).
-- Under the agency's exclusive transition lock, so a command in flight that relies on the agency's state commits first and is read.
-- B06's agencies_authority admits the edge only from the agency's own OWNER session, whose tenant policies read every row below; any
-- other context is refused rather than read blind (fail closed).
CREATE OR REPLACE FUNCTION kauro.agencies_closure_residuals() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  open_kinds text[] := ARRAY[]::text[];
BEGIN
  IF kauro.current_agency_id() IS DISTINCT FROM OLD.agency_id THEN
    RAISE EXCEPTION 'CLOSURE_RESIDUALS_OPEN: the obligations of agency % are read under its own context only', OLD.agency_id USING ERRCODE = 'KC006';
  END IF;
  PERFORM pg_advisory_xact_lock(kauro.transition_key('kauro.agencies', OLD.agency_id::text));
  IF EXISTS (SELECT 1 FROM kauro.payment_orders o WHERE o.agency_id = OLD.agency_id AND o.state NOT IN ('CAPTURED', 'FAILED', 'CANCELLED', 'EXPIRED')) THEN
    open_kinds := array_append(open_kinds, 'PAYMENT_ORDER');
  END IF;
  IF EXISTS (SELECT 1 FROM kauro.refunds r WHERE r.agency_id = OLD.agency_id AND r.state NOT IN ('COMPLETED', 'FAILED', 'REJECTED')) THEN
    open_kinds := array_append(open_kinds, 'REFUND');
  END IF;
  IF EXISTS (SELECT 1 FROM kauro.commercial_authorizations a WHERE a.agency_id = OLD.agency_id AND a.state IN ('ACTIVE', 'CONSUMED')) THEN
    open_kinds := array_append(open_kinds, 'COMMERCIAL_AUTHORIZATION');
  END IF;
  IF EXISTS (SELECT 1 FROM kauro.tax_documents d WHERE d.agency_id = OLD.agency_id AND d.state IN ('DRAFT', 'VALIDATED', 'SUBMITTING', 'UNCERTAIN', 'REJECTED')) THEN
    open_kinds := array_append(open_kinds, 'TAX_DOCUMENT');
  END IF;
  IF EXISTS (SELECT 1 FROM kauro.reconciliation_cases c WHERE c.agency_id = OLD.agency_id AND c.state = 'OPEN') THEN
    open_kinds := array_append(open_kinds, 'RECONCILIATION_CASE');
  END IF;
  IF cardinality(open_kinds) > 0 THEN
    RAISE EXCEPTION 'CLOSURE_RESIDUALS_OPEN: agency % keeps open obligations: %', OLD.agency_id, array_to_string(open_kinds, ', ') USING ERRCODE = 'KC006';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER agencies_closure_residuals BEFORE UPDATE OF state ON kauro.agencies
  FOR EACH ROW WHEN (OLD.state = 'CLOSING' AND NEW.state = 'CLOSED') EXECUTE FUNCTION kauro.agencies_closure_residuals();

-- --- row-level security of the B10 tables (FORCE everywhere; tenant policies on agency-scoped rows; no DELETE grant) -----------------
ALTER TABLE kauro.commercial_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.commercial_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY commercial_transitions_tenant_read ON kauro.commercial_transitions FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY commercial_transitions_owner_read ON kauro.commercial_transitions FOR SELECT TO kauro_app USING (kauro.holds_corporate_role('KAURO_OWNER'));
CREATE POLICY commercial_transitions_tenant_record ON kauro.commercial_transitions FOR INSERT TO kauro_app WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY commercial_transitions_payment_record ON kauro.commercial_transitions FOR INSERT TO kauro_payment WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY commercial_transitions_commission ON kauro.commercial_transitions FOR ALL TO kauro_commission
  USING (agency_id IS NULL OR agency_id = kauro.current_agency_id()) WITH CHECK (agency_id IS NULL OR agency_id = kauro.current_agency_id());

ALTER TABLE kauro.founding_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.founding_slots FORCE ROW LEVEL SECURITY;
CREATE POLICY founding_slots_read ON kauro.founding_slots FOR SELECT TO kauro_app, kauro_commission USING (true);
-- the request handlers take a free slot for their own agency, and free a slot of their own agency (CMD027, CMD043)
CREATE POLICY founding_slots_tenant ON kauro.founding_slots FOR UPDATE TO kauro_app
  USING (kauro.current_agency_id() IS NOT NULL AND (NOT held OR live_agency_id = kauro.current_agency_id()))
  WITH CHECK (live_agency_id IS NULL OR live_agency_id = kauro.current_agency_id());
-- the QUOTE_EXPIRY sweep frees a slot of the agency it adopted
CREATE POLICY founding_slots_commission_release ON kauro.founding_slots FOR UPDATE TO kauro_commission
  USING (held AND live_agency_id = kauro.current_agency_id()) WITH CHECK (NOT held);

ALTER TABLE kauro.founding_slot_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.founding_slot_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY founding_slot_reservations_tenant_read ON kauro.founding_slot_reservations FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY founding_slot_reservations_tenant_reserve ON kauro.founding_slot_reservations FOR INSERT TO kauro_app
  WITH CHECK (agency_id = kauro.current_agency_id() AND state = 'RESERVED');
CREATE POLICY founding_slot_reservations_tenant_release ON kauro.founding_slot_reservations FOR UPDATE TO kauro_app
  USING (agency_id = kauro.current_agency_id() AND state IN ('RESERVED', 'RECONCILIATION_HOLD'))
  WITH CHECK (agency_id = kauro.current_agency_id() AND state = 'RELEASED');
CREATE POLICY founding_slot_reservations_payment_read ON kauro.founding_slot_reservations FOR SELECT TO kauro_payment USING (agency_id = kauro.current_agency_id());
CREATE POLICY founding_slot_reservations_payment_consume ON kauro.founding_slot_reservations FOR UPDATE TO kauro_payment
  USING (agency_id = kauro.current_agency_id() AND state IN ('RESERVED', 'RECONCILIATION_HOLD'))
  WITH CHECK (agency_id = kauro.current_agency_id() AND state = 'CONSUMED');
CREATE POLICY founding_slot_reservations_commission_read ON kauro.founding_slot_reservations FOR SELECT TO kauro_commission USING (agency_id = kauro.current_agency_id());
CREATE POLICY founding_slot_reservations_commission_sweep ON kauro.founding_slot_reservations FOR UPDATE TO kauro_commission
  USING (agency_id = kauro.current_agency_id() AND state IN ('RESERVED', 'RECONCILIATION_HOLD'))
  WITH CHECK (agency_id = kauro.current_agency_id() AND state IN ('RECONCILIATION_HOLD', 'RELEASED'));

ALTER TABLE kauro.agency_recurrence ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.agency_recurrence FORCE ROW LEVEL SECURITY;
CREATE POLICY agency_recurrence_tenant_read ON kauro.agency_recurrence FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY agency_recurrence_payment ON kauro.agency_recurrence FOR ALL TO kauro_payment
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY agency_recurrence_commission_read ON kauro.agency_recurrence FOR SELECT TO kauro_commission USING (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.qualifying_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.qualifying_purchases FORCE ROW LEVEL SECURITY;
CREATE POLICY qualifying_purchases_tenant_read ON kauro.qualifying_purchases FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY qualifying_purchases_payment ON kauro.qualifying_purchases FOR ALL TO kauro_payment
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY qualifying_purchases_commission_read ON kauro.qualifying_purchases FOR SELECT TO kauro_commission USING (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.quote_issuances ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.quote_issuances FORCE ROW LEVEL SECURITY;
CREATE POLICY quote_issuances_tenant ON kauro.quote_issuances FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.service_agreement_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.service_agreement_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY service_agreement_versions_read ON kauro.service_agreement_versions FOR SELECT TO kauro_app USING (true);
CREATE POLICY service_agreement_versions_control ON kauro.service_agreement_versions FOR ALL TO kauro_control USING (true) WITH CHECK (true);

ALTER TABLE kauro.agency_agreement_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.agency_agreement_acceptances FORCE ROW LEVEL SECURITY;
CREATE POLICY agency_agreement_acceptances_tenant_read ON kauro.agency_agreement_acceptances FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY agency_agreement_acceptances_tenant_accept ON kauro.agency_agreement_acceptances FOR INSERT TO kauro_app
  WITH CHECK (agency_id = kauro.current_agency_id() AND user_id = kauro.current_user_id());

ALTER TABLE kauro.agency_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.agency_closures FORCE ROW LEVEL SECURITY;
CREATE POLICY agency_closures_tenant_read ON kauro.agency_closures FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY agency_closures_tenant_request ON kauro.agency_closures FOR INSERT TO kauro_app
  WITH CHECK (agency_id = kauro.current_agency_id() AND requested_by_user_id = kauro.current_user_id());

ALTER TABLE kauro.agency_relationship_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.agency_relationship_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY agency_relationship_decisions_tenant_read ON kauro.agency_relationship_decisions FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY agency_relationship_decisions_owner_read ON kauro.agency_relationship_decisions FOR SELECT TO kauro_app USING (kauro.holds_corporate_role('KAURO_OWNER'));
-- the corporate owner records a decision as itself (the reviewer is the session's person)
CREATE POLICY agency_relationship_decisions_owner_record ON kauro.agency_relationship_decisions FOR INSERT TO kauro_app
  WITH CHECK (kauro.holds_corporate_role('KAURO_OWNER') AND reviewed_by_user_id = kauro.current_user_id());

-- --- the commission service on B06 and B09 tables (D10-CTX-1; design §14) ---------------------------------------------------------
-- QUOTE_EXPIRY (price_expiry_reached, the reservation's release or hold): the quotes, snapshots and purchase facts of the agency it
-- adopted, read so B09's release guard orders the expiry with any payment in flight; the quote's expiry and its event.
CREATE POLICY quotes_commission_read ON kauro.quotes FOR SELECT TO kauro_commission USING (agency_id = kauro.current_agency_id());
CREATE POLICY quotes_commission_expiry ON kauro.quotes FOR UPDATE TO kauro_commission
  USING (agency_id = kauro.current_agency_id() AND state IN ('ISSUED', 'ACCEPTED_FOR_CHECKOUT'))
  WITH CHECK (agency_id = kauro.current_agency_id() AND state = 'EXPIRED');
CREATE POLICY price_eligibility_snapshots_commission_read ON kauro.price_eligibility_snapshots FOR SELECT TO kauro_commission USING (agency_id = kauro.current_agency_id());
CREATE POLICY payment_orders_commission_read ON kauro.payment_orders FOR SELECT TO kauro_commission USING (agency_id = kauro.current_agency_id());
CREATE POLICY payment_attempts_commission_read ON kauro.payment_attempts FOR SELECT TO kauro_commission USING (agency_id = kauro.current_agency_id());
CREATE POLICY capture_facts_commission_read ON kauro.capture_facts FOR SELECT TO kauro_commission USING (agency_id = kauro.current_agency_id());
CREATE POLICY commercial_authorizations_commission_read ON kauro.commercial_authorizations FOR SELECT TO kauro_commission USING (agency_id = kauro.current_agency_id());
CREATE POLICY refunds_commission_read ON kauro.refunds FOR SELECT TO kauro_commission USING (agency_id = kauro.current_agency_id());
CREATE POLICY purchase_rebindings_commission_read ON kauro.purchase_rebindings FOR SELECT TO kauro_commission USING (agency_id = kauro.current_agency_id());
-- the designation's mirror into the agency row (D10-FIRST-2): its version, state and designation column only
CREATE POLICY agencies_commission_read ON kauro.agencies FOR SELECT TO kauro_commission USING (agency_id = kauro.current_agency_id());
CREATE POLICY agencies_commission_designation ON kauro.agencies FOR UPDATE TO kauro_commission
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
-- its events: a quote's expiry and the agency's first designation, in the agency it adopted, and nothing else
CREATE POLICY domain_events_commission ON kauro.domain_events FOR ALL TO kauro_commission
  USING (agency_id = kauro.current_agency_id() AND aggregate_kind IN ('quote', 'agency'))
  WITH CHECK (
    agency_id = kauro.current_agency_id()
    AND ((aggregate_kind = 'quote' AND event_type = 'quote.expired.v1') OR (aggregate_kind = 'agency' AND event_type = 'agency.first_purchase_designated.v1'))
  );
CREATE POLICY commerce_event_bindings_commission_read ON kauro.commerce_event_bindings FOR SELECT TO kauro_commission USING (true);
-- its own authorization facts: a service stream (no agency, actor SERVICE; B09 D-FACT-B1)
CREATE POLICY security_events_commission_write ON kauro.security_events FOR INSERT TO kauro_commission
  WITH CHECK (agency_id IS NULL AND actor_kind = 'SERVICE' AND outcome IN ('ALLOW', 'DENY'));

-- --- grants (no DELETE for any runtime role) ------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON kauro.commercial_transitions TO kauro_app, kauro_commission;
GRANT INSERT ON kauro.commercial_transitions TO kauro_payment;
-- the slots' holding agency is never readable by the request handlers or the commission service: they read which slot is held
GRANT SELECT (policy_version, slot_no, held, live_reservation_id, updated_at) ON kauro.founding_slots TO kauro_app, kauro_commission;
GRANT UPDATE (held, live_reservation_id, live_agency_id, updated_at) ON kauro.founding_slots TO kauro_app, kauro_commission;
GRANT SELECT, INSERT ON kauro.founding_slot_reservations TO kauro_app;
GRANT UPDATE (version, state, released_at, release_reason, updated_at) ON kauro.founding_slot_reservations TO kauro_app;
GRANT SELECT ON kauro.founding_slot_reservations TO kauro_payment, kauro_commission;
GRANT UPDATE (version, state, consumed_at, consumed_by_authorization_id, updated_at) ON kauro.founding_slot_reservations TO kauro_payment;
GRANT UPDATE (version, state, held_at, released_at, release_reason, updated_at) ON kauro.founding_slot_reservations TO kauro_commission;
GRANT SELECT ON kauro.agency_recurrence, kauro.qualifying_purchases TO kauro_app, kauro_commission;
GRANT SELECT, INSERT, UPDATE ON kauro.agency_recurrence TO kauro_payment;
GRANT SELECT, INSERT ON kauro.qualifying_purchases TO kauro_payment;
GRANT SELECT, INSERT ON kauro.quote_issuances TO kauro_app;
GRANT SELECT ON kauro.service_agreement_versions TO kauro_app;
GRANT SELECT, INSERT ON kauro.service_agreement_versions TO kauro_control;
GRANT UPDATE (state, retired_at, updated_at) ON kauro.service_agreement_versions TO kauro_control;
GRANT SELECT, INSERT ON kauro.agency_agreement_acceptances, kauro.agency_closures, kauro.agency_relationship_decisions TO kauro_app;
GRANT SELECT ON kauro.quotes, kauro.price_eligibility_snapshots, kauro.payment_orders, kauro.payment_attempts, kauro.capture_facts,
  kauro.commercial_authorizations, kauro.refunds, kauro.purchase_rebindings TO kauro_commission;
GRANT UPDATE (version, state, updated_at) ON kauro.quotes TO kauro_commission;
GRANT SELECT (agency_id, version, state, first_qualifying_capture_id) ON kauro.agencies TO kauro_commission;
GRANT UPDATE (first_qualifying_capture_id, version, updated_at) ON kauro.agencies TO kauro_commission;
GRANT SELECT, INSERT ON kauro.domain_events TO kauro_commission;
GRANT USAGE ON SEQUENCE kauro.domain_events_sequence_seq TO kauro_commission;
GRANT SELECT ON kauro.commerce_event_bindings TO kauro_commission;
GRANT INSERT ON kauro.security_events TO kauro_commission;
