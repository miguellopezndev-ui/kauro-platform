-- 0072 — package B12 lane K1 (outreach kit): the sender registry, outreach content, sales resources, channel policies, the outreach
-- calendar, drafts, reviews, authorizations, send intents, sales activities, provider warnings, send evidence and diagnoses; the lock
-- subjects of plan §L and the triggers that assert them; the guards KA095..KA098 and KC028..KC037.
-- PROVISIONAL NUMBER: the plan names this file 0082_b12_outreach.sql; main ends at 0071 and batch B adds 0072..0078, and the migration
-- runner requires contiguous numbers from main (runner.ts), so the lane carries 0072 and the coordinator renumbers it at merge
-- (tools/renumber-migration.mjs).
--
-- Authority (plan docs/design/B12-outreach-plan.md §0 A1..A17, §L, §W, §G; companion docs/design/B12-outreach-plan-cells.md §K):
-- 12 "Outreach workspace", "Resources and training"; 18 "Initial channel decision", "Outreach cadence and health", "Communication
-- compliance"; reference MESSAGING_AND_SENDER_OPERATIONS "Draft, authority and send intent", "Selected routes", "Measurement";
-- registry contracts OutreachDraft, OutreachAuthorization, SalesActivity; COMMAND_CATALOGUE CMD061..CMD064.
--
-- Locks (plan §L; every B12 serializer is a transaction-level advisory subject, kauro.transition_key): L3 'kauro.outreach_prospects'
-- (prospect), L4 'kauro.outreach_person_caps' (sender person), L4g 'kauro.outreach_authorizations' (grant), L6 'kauro.sales_resources'
-- (family), L6p 'kauro.outreach_channel_policies' (jurisdiction:purpose), L7 'kauro.sender_identities' (sender), L8
-- 'kauro.prospect_suppressions' (key_kind:key), L10 'kauro.outreach_drafts' (draft). Global order L1, L2, L3, L4, L4g, L5, L6, L6p, L7,
-- L8, L10, L13, L14. The writers take them (persistence repositories/commercial-outreach.ts); the triggers below ACQUIRE NOTHING except
-- the CMD045 trigger's L8 S (prospects_not_suppressed): they ASSERT, from pg_locks of their own backend, that the subjects of the plan's
-- T2 table are held (KA096 LOCK_NOT_HELD), so a writer that skips a lock is refused instead of racing.
-- Co-guards, each its own trigger function (rule 24c): T1 the edge whitelists of the intent, draft, sender, policy and resource
-- machines (KA096); T2 the lock assertions (KA096 LOCK_NOT_HELD); T3 the intent counts at birth and claim (KC028..KC037), which see
-- committed rows only and are the rule-17 backstop, never the serializer; KA095 the bindings; KA097 the activity, warning and evidence
-- facts; KA098 the non-owner prospect UPDATE.
-- Decision (K1): an absent or WITHDRAWN channel policy of the prospect's jurisdiction and purpose refuses an intent with KC028
-- OUTREACH_ROUTE_FORBIDDEN (the route is not open for that recipient; plan A15), the "no policy row" control.
-- Clock (plan §W): every judged instant is kauro.effect_now() read in the trigger, i.e. after the writer's last lock wait; births
-- that are never judged stamp kauro.server_now(). Bounds (policy outreach v1, D-B12O-20): startGate 5 s, providerCallBound 30 s,
-- margin 2 s, so uncertain_after = submitted_at + 37 s; d4Grace 60 s.
--
-- SQLSTATE vocabulary (sqlstate.ts, docs/design/KC-CODES.md):
--   KA095 OUTREACH_BINDING  KA096 SEND_FENCE (edges, columns, LOCK_NOT_HELD)  KA097 ACTIVITY_EVIDENCE  KA098 OUTREACH_SUPPRESSION_SCOPE
--   KC028 OUTREACH_ROUTE_FORBIDDEN  KC029 SEND_UNCERTAIN_UNRESOLVED  KC030 OUTREACH_GRANT_INVALID  KC031 SENDER_NOT_VERIFIED
--   KC032 OUTREACH_CAP_REACHED (cap, cadence, calendar)  KC033 RESOURCE_NOT_CURRENT  KC034 OUTREACH_PAUSED  KC035 OUTREACH_REVIEW_INVALID
--   KC036 OUTREACH_ALREADY_SENT  KC037 OUTREACH_CALENDAR_UNAVAILABLE

-- --- the outreach service's runtime group (plan A1, A14, D-B12O-12) ----------------------------------------------------------------------
-- kauro_outreach runs the dispatcher units D2..D5 and the public opt-out (service outreach-service). It acts on no agency and holds no
-- grant on any table with an agency_id (A17).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kauro_outreach') THEN
    CREATE ROLE kauro_outreach NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kauro_outreach' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)
  ) THEN
    RAISE EXCEPTION 'runtime roles must not be SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION (08 Database isolation)';
  END IF;
  -- the P2 boundary of 0060 for the new group: no TEMPORARY or CREATE on the database
  EXECUTE pg_catalog.format('REVOKE TEMPORARY, CREATE ON DATABASE %I FROM kauro_outreach', pg_catalog.current_database());
END
$$;
GRANT USAGE ON SCHEMA kauro TO kauro_outreach;
GRANT USAGE ON SCHEMA kauro_meta TO kauro_outreach;
GRANT SELECT ON kauro_meta.schema_migrations TO kauro_outreach;
GRANT EXECUTE ON FUNCTION kauro.await_transition(text, text) TO kauro_outreach;

-- --- lock subjects (plan §L, T2) -----------------------------------------------------------------------------------------------------------
-- True when this backend holds the advisory transaction lock of the subject in the mode asked: 'X' only the exclusive lock, 'S' the
-- shared or the exclusive one. A bigint advisory key is (classid = high 32 bits, objid = low 32 bits, objsubid = 1) in pg_locks.
CREATE OR REPLACE FUNCTION kauro.outreach_lock_held(kind text, subject text, mode text) RETURNS boolean
  LANGUAGE sql STABLE STRICT SET search_path = pg_catalog AS
$$
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks l
     WHERE l.locktype = 'advisory' AND l.pid = pg_catalog.pg_backend_pid() AND l.granted AND l.objsubid = 1
       AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
       AND l.classid::bigint = ((kauro.transition_key(kind, subject) >> 32) & 4294967295)
       AND l.objid::bigint = (kauro.transition_key(kind, subject) & 4294967295)
       AND (l.mode = 'ExclusiveLock' OR (mode = 'S' AND l.mode = 'ShareLock'))
  )
$$;

-- KA096 LOCK_NOT_HELD naming the subject: the trigger's assertion (it never acquires).
CREATE OR REPLACE FUNCTION kauro.outreach_require_lock(kind text, subject text, mode text, what text) RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS
$$
BEGIN
  IF subject IS NULL OR NOT kauro.outreach_lock_held(kind, subject, mode) THEN
    RAISE EXCEPTION 'LOCK_NOT_HELD: % requires % % of %', what, kind, mode, coalesce(subject, '(none)') USING ERRCODE = 'KA096';
  END IF;
END
$$;

-- --- the outreach calendar (plan A10; application commercial/outreach/calendar.ts is the one source of the lists) -----------------------
CREATE TABLE kauro.outreach_calendar_days (
  version   text NOT NULL CHECK (kauro.is_label(version)),
  zone      text NOT NULL CHECK (zone IN ('CO', 'US')),
  day       date NOT NULL,
  business  boolean NOT NULL,
  source    text NOT NULL CHECK (kauro.is_label(source)),
  PRIMARY KEY (version, zone, day)
);
INSERT INTO kauro.outreach_calendar_days (version, zone, day, business, source)
SELECT 'OUTREACH-CAL-2026.10', 'CO', d::date,
       extract(isodow FROM d) < 6 AND d::date <> ALL (ARRAY[
         '2026-01-01','2026-01-12','2026-03-23','2026-04-02','2026-04-03','2026-05-01','2026-05-18','2026-06-08','2026-06-15','2026-06-29',
         '2026-07-13','2026-07-20','2026-08-07','2026-08-17','2026-10-12','2026-11-02','2026-11-16','2026-12-08','2026-12-25',
         '2027-01-01','2027-01-11','2027-03-22','2027-03-25','2027-03-26','2027-05-10','2027-05-31','2027-06-07','2027-07-05','2027-07-12',
         '2027-07-20','2027-08-16','2027-10-18','2027-11-01','2027-11-15','2027-12-08',
         '2028-01-10','2028-03-20','2028-04-13','2028-04-14','2028-05-01','2028-05-29','2028-06-19','2028-06-26','2028-07-03','2028-07-10',
         '2028-07-20','2028-08-07','2028-08-21','2028-10-16','2028-11-06','2028-11-13','2028-12-08','2028-12-25']::date[]),
       'Ley 51 de 1983 and Ley 2578 de 2026 (CO-HOLIDAYS-2026.09), read 2026-09-29'
  FROM generate_series('2026-01-01'::date, '2028-12-31'::date, interval '1 day') AS d;
INSERT INTO kauro.outreach_calendar_days (version, zone, day, business, source)
SELECT 'OUTREACH-CAL-2026.10', 'US', d::date,
       extract(isodow FROM d) < 6 AND d::date <> ALL (ARRAY[
         '2026-01-01','2026-01-19','2026-02-16','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-10-12','2026-11-11','2026-11-26',
         '2026-12-25','2027-01-01','2027-01-18','2027-02-15','2027-05-31','2027-06-18','2027-07-05','2027-09-06','2027-10-11','2027-11-11',
         '2027-11-25','2027-12-24','2027-12-31','2028-01-17','2028-02-21','2028-05-29','2028-06-19','2028-07-04','2028-09-04','2028-10-09',
         '2028-11-10','2028-11-23','2028-12-25']::date[]),
       '5 U.S.C. 6103(a), 6103(b)(1); E.O. 11582 s.3(a); retrieved 2026-10-14'
  FROM generate_series('2026-01-01'::date, '2028-12-31'::date, interval '1 day') AS d;
CREATE TRIGGER outreach_calendar_days_append_only BEFORE UPDATE OR DELETE ON kauro.outreach_calendar_days
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- An outreach business instant (both civil dates are business days); NULL when a date is not covered (KC037).
CREATE OR REPLACE FUNCTION kauro.outreach_business_instant(at timestamptz) RETURNS boolean
  LANGUAGE sql STABLE STRICT SET search_path = pg_catalog AS
$$
  SELECT co.business AND us.business
    FROM (SELECT 1) one
    LEFT JOIN kauro.outreach_calendar_days co ON co.version = 'OUTREACH-CAL-2026.10' AND co.zone = 'CO' AND co.day = (at AT TIME ZONE 'America/Bogota')::date
    LEFT JOIN kauro.outreach_calendar_days us ON us.version = 'OUTREACH-CAL-2026.10' AND us.zone = 'US' AND us.day = (at AT TIME ZONE 'America/New_York')::date
$$;

-- The instant n outreach business days after `at` at the same instant of day; NULL when the walk leaves the covered years.
CREATE OR REPLACE FUNCTION kauro.outreach_business_days_after(at timestamptz, n integer) RETURNS timestamptz
  LANGUAGE plpgsql STABLE STRICT SET search_path = pg_catalog AS
$$
DECLARE
  found integer := 0;
  b boolean;
BEGIN
  FOR k IN 1 .. 366 LOOP
    b := kauro.outreach_business_instant(at + make_interval(days => k));
    IF b IS NULL THEN
      RETURN NULL;
    END IF;
    IF b THEN
      found := found + 1;
      IF found = n THEN
        RETURN at + make_interval(days => k);
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

-- --- sender identities (plan A6; companion §K) ---------------------------------------------------------------------------------------------
CREATE TABLE kauro.sender_identities (
  sender_id            uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(sender_id)),
  user_id              uuid NOT NULL REFERENCES kauro.identities (user_id),
  address              text NOT NULL CHECK (kauro.is_label(address) AND address = lower(address) AND address LIKE '%_@_%'),
  route                text NOT NULL CHECK (route IN ('GMAIL_API', 'RESEND_TRANSACTIONAL')),
  consent_evidence_ref text CHECK (consent_evidence_ref IS NULL OR kauro.is_sha256_hex(consent_evidence_ref)),
  state                text NOT NULL DEFAULT 'PENDING_VERIFICATION' CHECK (state IN ('PENDING_VERIFICATION', 'VERIFIED', 'REVOKED')),
  verification_evidence_hash text CHECK (verification_evidence_hash IS NULL OR kauro.is_sha256_hex(verification_evidence_hash)),
  recorded_by_user_id  uuid NOT NULL REFERENCES kauro.identities (user_id),
  created_at           timestamptz NOT NULL DEFAULT kauro.server_now(),
  updated_at           timestamptz NOT NULL DEFAULT kauro.server_now(),
  CONSTRAINT sender_identities_gmail_consent CHECK (route <> 'GMAIL_API' OR consent_evidence_ref IS NOT NULL),
  CONSTRAINT sender_identities_verified_evidence CHECK (state <> 'VERIFIED' OR verification_evidence_hash IS NOT NULL),
  CONSTRAINT sender_identities_one_per_address UNIQUE (address, route)
);

-- KA095: born PENDING_VERIFICATION; address, person and route never change (companion §K (g)).
CREATE OR REPLACE FUNCTION kauro.sender_identities_binding() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'PENDING_VERIFICATION' THEN
      RAISE EXCEPTION 'OUTREACH_BINDING: sender % is born PENDING_VERIFICATION', NEW.sender_id USING ERRCODE = 'KA095';
    END IF;
  ELSIF NEW.address IS DISTINCT FROM OLD.address OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.route IS DISTINCT FROM OLD.route
     OR NEW.sender_id IS DISTINCT FROM OLD.sender_id OR NEW.recorded_by_user_id IS DISTINCT FROM OLD.recorded_by_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'OUTREACH_BINDING: the address, person and route of sender % are immutable', OLD.sender_id USING ERRCODE = 'KA095';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sender_identities_a_binding BEFORE INSERT OR UPDATE ON kauro.sender_identities
  FOR EACH ROW EXECUTE FUNCTION kauro.sender_identities_binding();

-- T6 (KA096): PENDING_VERIFICATION -> VERIFIED | REVOKED, VERIFIED -> REVOKED; REVOKED is terminal.
CREATE OR REPLACE FUNCTION kauro.sender_identities_edge() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT ((OLD.state = 'PENDING_VERIFICATION' AND NEW.state IN ('VERIFIED', 'REVOKED')) OR (OLD.state = 'VERIFIED' AND NEW.state = 'REVOKED')) THEN
    RAISE EXCEPTION 'SEND_FENCE: sender edge % -> % is not listed', OLD.state, NEW.state USING ERRCODE = 'KA096';
  END IF;
  NEW.updated_at := kauro.server_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER sender_identities_b_edge BEFORE UPDATE OF state ON kauro.sender_identities
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.sender_identities_edge();

-- T2: the sender state changes only under L7 X (RecordSenderRevocation, VerifySenderIdentity, D4 AUTH_REVOKED).
CREATE OR REPLACE FUNCTION kauro.sender_identities_locks() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM kauro.outreach_require_lock('kauro.sender_identities', OLD.sender_id::text, 'X', 'a sender state change');
  RETURN NEW;
END
$$;
CREATE TRIGGER sender_identities_c_locks BEFORE UPDATE OF state ON kauro.sender_identities
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.sender_identities_locks();
CREATE TRIGGER sender_identities_no_delete BEFORE DELETE ON kauro.sender_identities FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- outreach content (content-addressed; plan A17: never CRM data) ---------------------------------------------------------------------
CREATE TABLE kauro.outreach_contents (
  content_id           text PRIMARY KEY CHECK (kauro.is_sha256_hex(content_id)),
  subject              text NOT NULL CHECK (kauro.is_label(subject) AND subject IS NFC NORMALIZED),
  body                 text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000 AND body IS NFC NORMALIZED),
  recorded_by_user_id  uuid NOT NULL REFERENCES kauro.identities (user_id),
  created_at           timestamptz NOT NULL DEFAULT kauro.server_now(),
  CONSTRAINT outreach_contents_addressed CHECK (content_id = encode(sha256(convert_to('KAURO_OUTREACH_CONTENT_V1' || chr(10) || subject || chr(10) || body, 'UTF8')), 'hex'))
);
CREATE TRIGGER outreach_contents_append_only BEFORE UPDATE OR DELETE ON kauro.outreach_contents
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- sales resources (plan A8) -----------------------------------------------------------------------------------------------------------
CREATE TABLE kauro.sales_resources (
  resource_id            uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(resource_id)),
  family_id              uuid NOT NULL,
  version                integer NOT NULL CHECK (version >= 1),
  state                  text NOT NULL DEFAULT 'CURRENT' CHECK (state IN ('CURRENT', 'SUPERSEDED')),
  content_id             text NOT NULL REFERENCES kauro.outreach_contents (content_id),
  published_by_user_id   uuid NOT NULL REFERENCES kauro.identities (user_id),
  created_at             timestamptz NOT NULL DEFAULT kauro.server_now(),
  CONSTRAINT sales_resources_family_version UNIQUE (family_id, version),
  -- T7: one CURRENT per family, judged at COMMIT (publishing n+1 supersedes n in the same transaction)
  CONSTRAINT sales_resources_one_current EXCLUDE USING btree (family_id WITH =) WHERE (state = 'CURRENT') DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE kauro.sales_resource_capabilities (
  resource_id    uuid NOT NULL REFERENCES kauro.sales_resources (resource_id),
  capability_id  uuid NOT NULL REFERENCES kauro.capabilities (capability_id),
  PRIMARY KEY (resource_id, capability_id)
);
CREATE TRIGGER sales_resource_capabilities_append_only BEFORE UPDATE OR DELETE ON kauro.sales_resource_capabilities
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

CREATE OR REPLACE FUNCTION kauro.sales_resources_edge() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'CURRENT' OR (NEW.version > 1 AND NOT EXISTS (SELECT 1 FROM kauro.sales_resources r WHERE r.family_id = NEW.family_id AND r.version = NEW.version - 1)) THEN
      RAISE EXCEPTION 'SEND_FENCE: resource % is born CURRENT as version n+1 of its family', NEW.resource_id USING ERRCODE = 'KA096';
    END IF;
  ELSIF NEW.resource_id IS DISTINCT FROM OLD.resource_id OR NEW.family_id IS DISTINCT FROM OLD.family_id OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.content_id IS DISTINCT FROM OLD.content_id OR NEW.published_by_user_id IS DISTINCT FROM OLD.published_by_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NOT (OLD.state = 'CURRENT' AND NEW.state = 'SUPERSEDED') THEN
    RAISE EXCEPTION 'SEND_FENCE: resource % changes only CURRENT -> SUPERSEDED', OLD.resource_id USING ERRCODE = 'KA096';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sales_resources_a_edge BEFORE INSERT OR UPDATE ON kauro.sales_resources
  FOR EACH ROW EXECUTE FUNCTION kauro.sales_resources_edge();
-- T2: SUPERSEDED only under L6 X of the family (PublishSalesResource)
CREATE OR REPLACE FUNCTION kauro.sales_resources_locks() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM kauro.outreach_require_lock('kauro.sales_resources', OLD.family_id::text, 'X', 'a resource state change');
  RETURN NEW;
END
$$;
CREATE TRIGGER sales_resources_b_locks BEFORE UPDATE OF state ON kauro.sales_resources
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.sales_resources_locks();
CREATE TRIGGER sales_resources_no_delete BEFORE DELETE ON kauro.sales_resources FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- channel policies (plan A15; seeded, never inserted at runtime) ---------------------------------------------------------------------
CREATE TABLE kauro.outreach_channel_policies (
  jurisdiction          text NOT NULL CHECK (kauro.is_label(jurisdiction)),
  purpose               text NOT NULL CHECK (purpose IN ('REQUESTED_REPLY', 'INDIVIDUAL_PROSPECT_CONTACT', 'FOLLOW_UP')),
  version               integer NOT NULL CHECK (version >= 1),
  state                 text NOT NULL DEFAULT 'IN_FORCE' CHECK (state IN ('IN_FORCE', 'WITHDRAWN')),
  -- the deployment's commercial postal address and opt-out origin (A13); absent until the owner configures them (D-16, BLOCKED_OWNER):
  -- an intent of a policy without them is OUTREACH_COMPLIANCE_UNCONFIGURED at the command
  postal_address        text CHECK (postal_address IS NULL OR kauro.is_label(postal_address)),
  opt_out_origin        text CHECK (opt_out_origin IS NULL OR opt_out_origin ~ '^https://[a-z0-9.-]+$'),
  withdrawn_by_user_id  uuid REFERENCES kauro.identities (user_id),
  created_at            timestamptz NOT NULL DEFAULT kauro.server_now(),
  PRIMARY KEY (jurisdiction, purpose, version),
  CONSTRAINT outreach_channel_policies_withdrawn_by CHECK ((state = 'WITHDRAWN') = (withdrawn_by_user_id IS NOT NULL))
);
-- The policy jurisdiction of a prospect: its registered jurisdiction label (0029, free text) folded to the policy code; the spellings of
-- the United States fold to US, every other label is its own (unreviewed) jurisdiction (A15, OUTREACH_JURISDICTION_UNREVIEWED).
CREATE OR REPLACE FUNCTION kauro.outreach_jurisdiction(label text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT CASE WHEN lower(label) IN ('us', 'usa', 'united states', 'united states of america') THEN 'US' ELSE label END $$;
INSERT INTO kauro.outreach_channel_policies (jurisdiction, purpose, version)
VALUES ('US', 'REQUESTED_REPLY', 1), ('US', 'INDIVIDUAL_PROSPECT_CONTACT', 1), ('US', 'FOLLOW_UP', 1);

CREATE OR REPLACE FUNCTION kauro.outreach_channel_policies_edge() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.jurisdiction IS DISTINCT FROM OLD.jurisdiction OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NOT (OLD.state = 'IN_FORCE' AND NEW.state = 'WITHDRAWN')
     AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.withdrawn_by_user_id IS DISTINCT FROM OLD.withdrawn_by_user_id) THEN
    RAISE EXCEPTION 'SEND_FENCE: a channel policy changes only IN_FORCE -> WITHDRAWN' USING ERRCODE = 'KA096';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER outreach_channel_policies_a_edge BEFORE UPDATE ON kauro.outreach_channel_policies
  FOR EACH ROW EXECUTE FUNCTION kauro.outreach_channel_policies_edge();
-- T2: WITHDRAWN only under L6p X (WithdrawOutreachChannelPolicy)
CREATE OR REPLACE FUNCTION kauro.outreach_channel_policies_locks() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM kauro.outreach_require_lock('kauro.outreach_channel_policies', OLD.jurisdiction || ':' || OLD.purpose, 'X', 'a policy withdrawal');
  RETURN NEW;
END
$$;
CREATE TRIGGER outreach_channel_policies_b_locks BEFORE UPDATE OF state ON kauro.outreach_channel_policies
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.outreach_channel_policies_locks();
CREATE TRIGGER outreach_channel_policies_no_delete BEFORE DELETE ON kauro.outreach_channel_policies FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- prospect contact addresses (plan A14; written by lane L-SOURCE) ------------------------------------------------------------------
-- The restricted address behind a contact key: the key is KAURO_PROSPECT_CONTACT_V1 over the case-folded NFC address, which the
-- writer stores already normalized (domain commercial/outreach.ts contactKeyOf).
CREATE TABLE kauro.prospect_contact_addresses (
  contact_id           uuid PRIMARY KEY,
  recorded_by_user_id  uuid NOT NULL REFERENCES kauro.identities (user_id),
  address              text NOT NULL CHECK (kauro.is_label(address) AND address IS NFC NORMALIZED AND address LIKE '%_@_%'),
  created_at           timestamptz NOT NULL DEFAULT kauro.server_now(),
  CONSTRAINT prospect_contact_addresses_contact_fk FOREIGN KEY (recorded_by_user_id, contact_id) REFERENCES kauro.prospect_contacts (recorded_by_user_id, contact_id)
);
CREATE OR REPLACE FUNCTION kauro.prospect_contact_key(address text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT encode(sha256(convert_to('KAURO_PROSPECT_CONTACT_V1' || chr(10) || address, 'UTF8')), 'hex') $$;
-- KA095 (f): the address digest is the contact's key
CREATE OR REPLACE FUNCTION kauro.prospect_contact_addresses_binding() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.prospect_contacts c
     WHERE c.contact_id = NEW.contact_id AND c.recorded_by_user_id = NEW.recorded_by_user_id AND c.contact_key = kauro.prospect_contact_key(NEW.address)
  ) THEN
    RAISE EXCEPTION 'OUTREACH_BINDING: the address of contact % does not derive its contact key', NEW.contact_id USING ERRCODE = 'KA095';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER prospect_contact_addresses_binding BEFORE INSERT ON kauro.prospect_contact_addresses
  FOR EACH ROW EXECUTE FUNCTION kauro.prospect_contact_addresses_binding();
CREATE TRIGGER prospect_contact_addresses_append_only BEFORE UPDATE OR DELETE ON kauro.prospect_contact_addresses
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- drafts (registry OutreachDraft; plan A1, A2b) ------------------------------------------------------------------------------------------
CREATE TABLE kauro.outreach_drafts (
  draft_id                  uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(draft_id)),
  prospect_id               uuid NOT NULL REFERENCES kauro.prospects (prospect_id),
  sender_id                 uuid NOT NULL REFERENCES kauro.sender_identities (sender_id),
  author_user_id            uuid NOT NULL REFERENCES kauro.identities (user_id),
  purpose                   text NOT NULL CHECK (purpose IN ('REQUESTED_REPLY', 'INDIVIDUAL_PROSPECT_CONTACT', 'FOLLOW_UP')),
  content_ref               text NOT NULL REFERENCES kauro.outreach_contents (content_id),
  contact_key               text NOT NULL CHECK (kauro.is_sha256_hex(contact_key)),
  -- registry contentHash: the exact subject/body/recipient/sender/purpose binding (kauro.outreach_binding_hash)
  content_hash              text NOT NULL CHECK (kauro.is_sha256_hex(content_hash)),
  provenance_evidence_hash  text NOT NULL CHECK (kauro.is_sha256_hex(provenance_evidence_hash)),
  version                   bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                     text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'AUTHORIZED', 'SUBMITTING', 'PROVIDER_ACCEPTED', 'SEND_UNCERTAIN', 'BOUNCED', 'REPLIED', 'SUPPRESSED', 'CANCELLED')),
  created_at                timestamptz NOT NULL DEFAULT kauro.server_now(),
  updated_at                timestamptz NOT NULL DEFAULT kauro.server_now()
);
CREATE INDEX outreach_drafts_by_prospect ON kauro.outreach_drafts (prospect_id);
-- the resources a draft cites (A8): each CURRENT and each claimed capability offered, judged at the intent's birth (KC033)
CREATE TABLE kauro.outreach_draft_resources (
  draft_id     uuid NOT NULL REFERENCES kauro.outreach_drafts (draft_id),
  resource_id  uuid NOT NULL REFERENCES kauro.sales_resources (resource_id),
  PRIMARY KEY (draft_id, resource_id)
);
CREATE TRIGGER outreach_draft_resources_append_only BEFORE UPDATE OR DELETE ON kauro.outreach_draft_resources
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

CREATE OR REPLACE FUNCTION kauro.outreach_binding_hash(prospect uuid, contact_key text, sender uuid, purpose text, content_ref text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$
  SELECT encode(sha256(convert_to(
    'KAURO_OUTREACH_BINDING_V1' || chr(10) || prospect::text || chr(10) || contact_key || chr(10) || sender::text || chr(10) || purpose || chr(10) || content_ref, 'UTF8')), 'hex')
$$;

-- KA095: a draft binds its sender, prospect, contact, purpose and content (companion §K (c), (d)); its bound columns never change.
CREATE OR REPLACE FUNCTION kauro.outreach_drafts_binding() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  sender_user uuid;
  sender_seller uuid;
  owner_seller uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.draft_id IS DISTINCT FROM OLD.draft_id OR NEW.prospect_id IS DISTINCT FROM OLD.prospect_id OR NEW.sender_id IS DISTINCT FROM OLD.sender_id
       OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.content_ref IS DISTINCT FROM OLD.content_ref
       OR NEW.contact_key IS DISTINCT FROM OLD.contact_key OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
       OR NEW.provenance_evidence_hash IS DISTINCT FROM OLD.provenance_evidence_hash OR NEW.version IS DISTINCT FROM OLD.version OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'OUTREACH_BINDING: draft % keeps its binding and version across its state edges', OLD.draft_id USING ERRCODE = 'KA095';
    END IF;
    NEW.updated_at := kauro.server_now();
    RETURN NEW;
  END IF;
  IF NEW.state <> 'DRAFT' OR NEW.version <> 1 THEN
    RAISE EXCEPTION 'OUTREACH_BINDING: draft % is born DRAFT at version 1', NEW.draft_id USING ERRCODE = 'KA095';
  END IF;
  IF NEW.content_hash IS DISTINCT FROM kauro.outreach_binding_hash(NEW.prospect_id, NEW.contact_key, NEW.sender_id, NEW.purpose, NEW.content_ref) THEN
    RAISE EXCEPTION 'OUTREACH_BINDING: the content hash of draft % is not its recipient/sender/purpose/body binding', NEW.draft_id USING ERRCODE = 'KA095';
  END IF;
  SELECT s.user_id INTO sender_user FROM kauro.sender_identities s WHERE s.sender_id = NEW.sender_id;
  SELECT x.seller_id INTO sender_seller FROM kauro.sellers x WHERE x.user_id = sender_user;
  SELECT p.owner_seller_id INTO owner_seller FROM kauro.prospects p WHERE p.prospect_id = NEW.prospect_id;
  -- a SELLER sender drafts only on a prospect assigned to it; an owner sender (no seller row) is exempt (ADV-41(5))
  IF sender_seller IS NOT NULL AND owner_seller IS DISTINCT FROM sender_seller THEN
    RAISE EXCEPTION 'OUTREACH_BINDING: the seller sender of draft % is not assigned its prospect', NEW.draft_id USING ERRCODE = 'KA095';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER outreach_drafts_a_binding BEFORE INSERT OR UPDATE ON kauro.outreach_drafts
  FOR EACH ROW EXECUTE FUNCTION kauro.outreach_drafts_binding();

-- T1 (KA096): the draft machine of plan A2b, one function.
CREATE OR REPLACE FUNCTION kauro.outreach_drafts_edge() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  e text := OLD.state || '>' || NEW.state;
BEGIN
  IF e = ANY (ARRAY[
       'DRAFT>AUTHORIZED', 'AUTHORIZED>SUBMITTING', 'AUTHORIZED>DRAFT', 'AUTHORIZED>PROVIDER_ACCEPTED', 'DRAFT>PROVIDER_ACCEPTED',
       'AUTHORIZED>SUPPRESSED', 'AUTHORIZED>CANCELLED', 'SUBMITTING>PROVIDER_ACCEPTED', 'SUBMITTING>SEND_UNCERTAIN', 'SUBMITTING>DRAFT',
       'SUBMITTING>CANCELLED', 'SEND_UNCERTAIN>PROVIDER_ACCEPTED', 'PROVIDER_ACCEPTED>REPLIED', 'PROVIDER_ACCEPTED>BOUNCED', 'PROVIDER_ACCEPTED>SUPPRESSED']) THEN
    RETURN NEW;
  END IF;
  -- the one repeat path: a human observation that the uncertain send did not leave
  IF e = 'SEND_UNCERTAIN>DRAFT' AND EXISTS (SELECT 1 FROM kauro.outreach_send_intents i WHERE i.draft_id = OLD.draft_id AND i.state = 'OBSERVED_NOT_SENT') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SEND_FENCE: draft edge % is not listed (plan A2b)', e USING ERRCODE = 'KA096';
END
$$;

-- T2: every draft state edge under L10 X of the draft.
CREATE OR REPLACE FUNCTION kauro.outreach_drafts_locks() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM kauro.outreach_require_lock('kauro.outreach_drafts', OLD.draft_id::text, 'X', 'a draft state edge');
  RETURN NEW;
END
$$;
CREATE TRIGGER outreach_drafts_no_delete BEFORE DELETE ON kauro.outreach_drafts FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- reviews (plan A16; PrepareOutreachReview) ---------------------------------------------------------------------------------------------
CREATE TABLE kauro.outreach_reviews (
  review_id         uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(review_id)),
  owner_user_id     uuid NOT NULL REFERENCES kauro.identities (user_id),
  proof_id          uuid NOT NULL REFERENCES kauro.assurance_proofs (proof_id),
  sender_id         uuid NOT NULL REFERENCES kauro.sender_identities (sender_id),
  digest            text NOT NULL CHECK (kauro.is_sha256_hex(digest)),
  issued_at         timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  CONSTRAINT outreach_reviews_fifteen_minutes CHECK (expires_at = issued_at + interval '15 minutes')
);
CREATE TABLE kauro.outreach_review_items (
  review_id      uuid NOT NULL REFERENCES kauro.outreach_reviews (review_id),
  draft_id       uuid NOT NULL REFERENCES kauro.outreach_drafts (draft_id),
  draft_version  bigint NOT NULL,
  content_hash   text NOT NULL CHECK (kauro.is_sha256_hex(content_hash)),
  contact_label  text NOT NULL CHECK (kauro.is_label(contact_label)),
  PRIMARY KEY (review_id, draft_id)
);
-- KA095 (e): the proof is the owner's own; issued_at is the database's instant
CREATE OR REPLACE FUNCTION kauro.outreach_reviews_binding() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM kauro.assurance_proofs p WHERE p.proof_id = NEW.proof_id AND p.user_id = NEW.owner_user_id) THEN
    RAISE EXCEPTION 'OUTREACH_BINDING: review % cites a step-up proof of another person', NEW.review_id USING ERRCODE = 'KA095';
  END IF;
  NEW.issued_at := kauro.effect_now();
  NEW.expires_at := NEW.issued_at + interval '15 minutes';
  RETURN NEW;
END
$$;
CREATE TRIGGER outreach_reviews_binding BEFORE INSERT ON kauro.outreach_reviews FOR EACH ROW EXECUTE FUNCTION kauro.outreach_reviews_binding();
CREATE TRIGGER outreach_reviews_append_only BEFORE UPDATE OR DELETE ON kauro.outreach_reviews FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER outreach_review_items_append_only BEFORE UPDATE OR DELETE ON kauro.outreach_review_items FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- authorizations (registry OutreachAuthorization; CMD062) -------------------------------------------------------------------------------
CREATE TABLE kauro.outreach_authorizations (
  authorization_id          uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(authorization_id)),
  -- U1: a review is consumed by exactly one grant (M34)
  review_id                 uuid NOT NULL REFERENCES kauro.outreach_reviews (review_id) CONSTRAINT outreach_authorizations_one_per_review UNIQUE,
  granting_user_id          uuid NOT NULL REFERENCES kauro.identities (user_id),
  sender_id                 uuid NOT NULL REFERENCES kauro.sender_identities (sender_id),
  proof_id                  uuid NOT NULL REFERENCES kauro.assurance_proofs (proof_id),
  valid_from                timestamptz NOT NULL,
  expires_at                timestamptz NOT NULL,
  maximum_sends             integer NOT NULL CHECK (maximum_sends >= 1),
  permission_evidence_hash  text NOT NULL CHECK (kauro.is_sha256_hex(permission_evidence_hash)),
  policy_version            text NOT NULL CHECK (kauro.is_label(policy_version)),
  revoked                   boolean NOT NULL DEFAULT false,
  revoked_by_user_id        uuid REFERENCES kauro.identities (user_id),
  created_at                timestamptz NOT NULL DEFAULT kauro.server_now(),
  CONSTRAINT outreach_authorizations_window CHECK (expires_at > valid_from AND expires_at <= valid_from + interval '14 days'),
  CONSTRAINT outreach_authorizations_revoked_by CHECK (revoked = (revoked_by_user_id IS NOT NULL))
);
CREATE TABLE kauro.outreach_authorization_hashes (
  authorization_id  uuid NOT NULL REFERENCES kauro.outreach_authorizations (authorization_id),
  draft_id          uuid NOT NULL REFERENCES kauro.outreach_drafts (draft_id),
  content_hash      text NOT NULL CHECK (kauro.is_sha256_hex(content_hash)),
  PRIMARY KEY (authorization_id, draft_id)
);

-- KC035 (review invalid) and KA095 (b) at the grant's birth: the review is live, the owner's, under the grant's proof, and every item's
-- draft is still at the reviewed version and hash; validFrom before birth is clamped to the database's instant (rule 23).
CREATE OR REPLACE FUNCTION kauro.outreach_authorizations_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  r kauro.outreach_reviews;
  judged timestamptz := kauro.effect_now();
BEGIN
  SELECT * INTO r FROM kauro.outreach_reviews WHERE review_id = NEW.review_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTREACH_REVIEW_INVALID: no review row %', NEW.review_id USING ERRCODE = 'KC035';
  END IF;
  IF judged >= r.expires_at THEN
    RAISE EXCEPTION 'OUTREACH_REVIEW_INVALID: review % expired', NEW.review_id USING ERRCODE = 'KC035';
  END IF;
  IF r.proof_id IS DISTINCT FROM NEW.proof_id OR r.owner_user_id IS DISTINCT FROM NEW.granting_user_id THEN
    RAISE EXCEPTION 'OUTREACH_REVIEW_INVALID: review % was issued under another proof', NEW.review_id USING ERRCODE = 'KC035';
  END IF;
  IF EXISTS (
    SELECT 1 FROM kauro.outreach_review_items it JOIN kauro.outreach_drafts d ON d.draft_id = it.draft_id
     WHERE it.review_id = NEW.review_id AND (d.version <> it.draft_version OR d.content_hash <> it.content_hash OR d.state <> 'DRAFT')
  ) THEN
    RAISE EXCEPTION 'OUTREACH_REVIEW_INVALID: a draft of review % moved since it was reviewed', NEW.review_id USING ERRCODE = 'KC035';
  END IF;
  IF NEW.sender_id IS DISTINCT FROM r.sender_id THEN
    RAISE EXCEPTION 'OUTREACH_BINDING: grant % names another sender than its review', NEW.authorization_id USING ERRCODE = 'KA095';
  END IF;
  IF NEW.revoked THEN
    RAISE EXCEPTION 'OUTREACH_BINDING: grant % is born unrevoked', NEW.authorization_id USING ERRCODE = 'KA095';
  END IF;
  IF NEW.valid_from < judged THEN
    NEW.valid_from := judged;
  END IF;
  IF NEW.expires_at <= NEW.valid_from OR NEW.expires_at > NEW.valid_from + interval '14 days' THEN
    RAISE EXCEPTION 'OUTREACH_GRANT_INVALID: the window of grant % is empty or longer than 14 days', NEW.authorization_id USING ERRCODE = 'KC030';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER outreach_authorizations_a_birth BEFORE INSERT ON kauro.outreach_authorizations
  FOR EACH ROW EXECUTE FUNCTION kauro.outreach_authorizations_birth();

-- revoked false -> true only (owner), under L4g X; every other column immutable
CREATE OR REPLACE FUNCTION kauro.outreach_authorizations_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF (to_jsonb(NEW) - 'revoked' - 'revoked_by_user_id') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked' - 'revoked_by_user_id') OR NOT (NOT OLD.revoked AND NEW.revoked) THEN
    RAISE EXCEPTION 'SEND_FENCE: grant % changes only by its revocation', OLD.authorization_id USING ERRCODE = 'KA096';
  END IF;
  PERFORM kauro.outreach_require_lock('kauro.outreach_authorizations', OLD.authorization_id::text, 'X', 'a grant revocation');
  RETURN NEW;
END
$$;
CREATE TRIGGER outreach_authorizations_b_change BEFORE UPDATE ON kauro.outreach_authorizations
  FOR EACH ROW EXECUTE FUNCTION kauro.outreach_authorizations_change();
CREATE TRIGGER outreach_authorizations_no_delete BEFORE DELETE ON kauro.outreach_authorizations FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- KA095 (b): a sealed hash is the draft's current binding, of the grant's sender, reviewed by the grant's review
CREATE OR REPLACE FUNCTION kauro.outreach_authorization_hashes_binding() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.outreach_authorizations a JOIN kauro.outreach_drafts d ON d.draft_id = NEW.draft_id
     WHERE a.authorization_id = NEW.authorization_id AND d.sender_id = a.sender_id AND d.content_hash = NEW.content_hash AND d.state = 'DRAFT'
  ) THEN
    RAISE EXCEPTION 'OUTREACH_BINDING: the sealed hash of draft % is not a DRAFT of the grant''s sender', NEW.draft_id USING ERRCODE = 'KA095';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM kauro.outreach_authorizations a JOIN kauro.outreach_review_items it ON it.review_id = a.review_id
     WHERE a.authorization_id = NEW.authorization_id AND it.draft_id = NEW.draft_id AND it.content_hash = NEW.content_hash
  ) THEN
    RAISE EXCEPTION 'OUTREACH_REVIEW_INVALID: draft % was not reviewed by the grant''s review', NEW.draft_id USING ERRCODE = 'KC035';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER outreach_authorization_hashes_binding BEFORE INSERT ON kauro.outreach_authorization_hashes
  FOR EACH ROW EXECUTE FUNCTION kauro.outreach_authorization_hashes_binding();
CREATE TRIGGER outreach_authorization_hashes_append_only BEFORE UPDATE OR DELETE ON kauro.outreach_authorization_hashes
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
-- a grant has >= 1 sealed hash and maximum_sends <= its distinct hashes, at COMMIT
CREATE OR REPLACE FUNCTION kauro.outreach_authorizations_sealed() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  n integer;
BEGIN
  SELECT count(DISTINCT h.content_hash) INTO n FROM kauro.outreach_authorization_hashes h WHERE h.authorization_id = NEW.authorization_id;
  IF n = 0 OR NEW.maximum_sends > n THEN
    RAISE EXCEPTION 'OUTREACH_GRANT_INVALID: grant % seals % hashes for % sends', NEW.authorization_id, n, NEW.maximum_sends USING ERRCODE = 'KC030';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER outreach_authorizations_sealed AFTER INSERT ON kauro.outreach_authorizations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.outreach_authorizations_sealed();

-- --- send intents (plan A2, A3, §G; CMD063 births, D2..D5 and HUMAN_SEND_OBSERVED move) ------------------------------------------------
CREATE TABLE kauro.outreach_send_intents (
  intent_id                uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(intent_id)),
  draft_id                 uuid NOT NULL REFERENCES kauro.outreach_drafts (draft_id),
  authorization_id         uuid NOT NULL REFERENCES kauro.outreach_authorizations (authorization_id),
  sender_id                uuid NOT NULL REFERENCES kauro.sender_identities (sender_id),
  person_user_id           uuid NOT NULL REFERENCES kauro.identities (user_id),
  prospect_id              uuid NOT NULL REFERENCES kauro.prospects (prospect_id),
  purpose                  text NOT NULL CHECK (purpose IN ('REQUESTED_REPLY', 'INDIVIDUAL_PROSPECT_CONTACT', 'FOLLOW_UP')),
  route                    text NOT NULL CHECK (route IN ('GMAIL_API', 'RESEND_TRANSACTIONAL')),
  contact_key              text NOT NULL CHECK (kauro.is_sha256_hex(contact_key)),
  payload_hash             text NOT NULL CHECK (kauro.is_sha256_hex(payload_hash)),
  -- the sequence's first intent (FOLLOW_UP), the REPLIED activity a REQUESTED_REPLY answers
  sequence_first_intent_id uuid REFERENCES kauro.outreach_send_intents (intent_id),
  reply_activity_id        uuid,
  state                    text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED', 'SUBMITTING', 'PROVIDER_ACCEPTED', 'SEND_UNCERTAIN', 'OBSERVED_SENT', 'OBSERVED_NOT_SENT', 'NOT_SENT', 'CANCELLED')),
  counted_at               timestamptz NOT NULL,
  submitted_at             timestamptz,
  uncertain_after          timestamptz,
  claim_fence              bigint CHECK (claim_fence IS NULL OR claim_fence >= 1),
  answered_fence           bigint CHECK (answered_fence IS NULL OR answered_fence >= 1),
  provider_message_ref     text CHECK (provider_message_ref IS NULL OR kauro.is_label(provider_message_ref)),
  outcome_reason           text CHECK (outcome_reason IS NULL OR outcome_reason ~ '^[A-Z][A-Z0-9_:]{2,63}$'),
  created_at               timestamptz NOT NULL DEFAULT kauro.server_now(),
  updated_at               timestamptz NOT NULL DEFAULT kauro.server_now(),
  CONSTRAINT outreach_send_intents_sequence CHECK ((purpose = 'FOLLOW_UP') = (sequence_first_intent_id IS NOT NULL)),
  CONSTRAINT outreach_send_intents_reply CHECK ((purpose = 'REQUESTED_REPLY') = (reply_activity_id IS NOT NULL)),
  CONSTRAINT outreach_send_intents_claim CHECK ((submitted_at IS NULL) = (claim_fence IS NULL) AND (submitted_at IS NULL) = (uncertain_after IS NULL)),
  CONSTRAINT outreach_send_intents_accepted_ref CHECK (state <> 'PROVIDER_ACCEPTED' OR provider_message_ref IS NOT NULL)
);
CREATE INDEX outreach_send_intents_by_person ON kauro.outreach_send_intents (person_user_id, counted_at DESC);
CREATE INDEX outreach_send_intents_by_prospect ON kauro.outreach_send_intents (prospect_id, counted_at DESC);
CREATE INDEX outreach_send_intents_by_draft ON kauro.outreach_send_intents (draft_id);
CREATE UNIQUE INDEX outreach_send_intents_one_per_reply ON kauro.outreach_send_intents (reply_activity_id) WHERE reply_activity_id IS NOT NULL;

-- --- sales activities (registry SalesActivity; CMD064, D4, D5, opt-out) ---------------------------------------------------------------
CREATE TABLE kauro.sales_activities (
  activity_id             uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(activity_id)),
  prospect_id             uuid NOT NULL REFERENCES kauro.prospects (prospect_id),
  intent_id               uuid REFERENCES kauro.outreach_send_intents (intent_id),
  draft_id                uuid REFERENCES kauro.outreach_drafts (draft_id),
  authorization_id        uuid REFERENCES kauro.outreach_authorizations (authorization_id),
  kind                    text NOT NULL CHECK (kind IN ('PROVIDER_ACCEPTED', 'SEND_UNCERTAIN', 'BOUNCED', 'REPLIED', 'SUPPRESSED', 'HUMAN_SEND_OBSERVED')),
  observation             text CHECK (observation IN ('SENT', 'NOT_SENT')),
  suppression_key_kind    text CHECK (suppression_key_kind IN ('ORGANIZATION', 'CONTACT')),
  suppression_key         text CHECK (suppression_key IS NULL OR kauro.is_sha256_hex(suppression_key)),
  suppression_reason      text CHECK (suppression_reason IN ('OPT_OUT', 'COMPLAINT', 'REFUSAL', 'DISQUALIFIED')),
  provider_message_ref    text NOT NULL CHECK (kauro.is_label(provider_message_ref)),
  evidence_hash           text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  occurred_at             timestamptz NOT NULL,
  recorded_by_user_id     uuid REFERENCES kauro.identities (user_id),
  recorded_by_service     text CHECK (recorded_by_service = 'outreach-service'),
  recorded_at             timestamptz NOT NULL DEFAULT kauro.server_now(),
  CONSTRAINT sales_activities_one_recorder CHECK (num_nonnulls(recorded_by_user_id, recorded_by_service) = 1),
  CONSTRAINT sales_activities_bound CHECK (kind = 'SUPPRESSED' OR (intent_id IS NOT NULL AND draft_id IS NOT NULL AND authorization_id IS NOT NULL)),
  CONSTRAINT sales_activities_observation CHECK ((kind = 'HUMAN_SEND_OBSERVED') = (observation IS NOT NULL)),
  CONSTRAINT sales_activities_suppression CHECK ((kind = 'SUPPRESSED') = (suppression_key_kind IS NOT NULL AND suppression_key IS NOT NULL AND suppression_reason IS NOT NULL)
    AND (kind = 'SUPPRESSED' OR (suppression_key_kind IS NULL AND suppression_key IS NULL AND suppression_reason IS NULL)))
);
-- U2: one activity per identity of its kind (KA097 (a), (b), (c), (f)); writers INSERT ... ON CONFLICT DO NOTHING untargeted
CREATE UNIQUE INDEX sales_activities_one_accepted_per_intent ON kauro.sales_activities (intent_id) WHERE kind = 'PROVIDER_ACCEPTED';
CREATE UNIQUE INDEX sales_activities_one_uncertain_per_intent ON kauro.sales_activities (intent_id) WHERE kind = 'SEND_UNCERTAIN';
CREATE UNIQUE INDEX sales_activities_one_observation_per_intent ON kauro.sales_activities (intent_id) WHERE kind = 'HUMAN_SEND_OBSERVED';
CREATE UNIQUE INDEX sales_activities_one_bounce_per_intent ON kauro.sales_activities (intent_id) WHERE kind = 'BOUNCED';
CREATE UNIQUE INDEX sales_activities_one_reply_per_inbound ON kauro.sales_activities (provider_message_ref) WHERE kind = 'REPLIED';
CREATE UNIQUE INDEX sales_activities_one_suppression_per_reason ON kauro.sales_activities (prospect_id, suppression_key_kind, suppression_key, suppression_reason) WHERE kind = 'SUPPRESSED';
CREATE INDEX sales_activities_by_prospect ON kauro.sales_activities (prospect_id, recorded_at);
ALTER TABLE kauro.outreach_send_intents ADD CONSTRAINT outreach_send_intents_reply_fk FOREIGN KEY (reply_activity_id) REFERENCES kauro.sales_activities (activity_id);

-- --- provider warnings and send evidence (plan A3 "D4b", A12) ------------------------------------------------------------------------
CREATE TABLE kauro.outreach_provider_warnings (
  warning_id           uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(warning_id)),
  -- U5: one warning per intent (KA097 (j))
  intent_id            uuid NOT NULL REFERENCES kauro.outreach_send_intents (intent_id) CONSTRAINT outreach_provider_warnings_one_per_intent UNIQUE,
  person_user_id       uuid NOT NULL REFERENCES kauro.identities (user_id),
  status               integer NOT NULL CHECK (status IN (403, 429)),
  recorded_by_service  text NOT NULL CHECK (recorded_by_service = 'outreach-service'),
  recorded_at          timestamptz NOT NULL
);
CREATE TABLE kauro.outreach_send_evidence (
  evidence_id          uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(evidence_id)),
  intent_id            uuid NOT NULL REFERENCES kauro.outreach_send_intents (intent_id),
  fence                bigint NOT NULL CHECK (fence >= 1),
  status               text NOT NULL CHECK (status IN ('ACCEPTED', 'AUTH_REVOKED', 'REJECTED_DEFINITIVE', 'NOT_ATTEMPTED', 'UNKNOWN')),
  provider_ref         text NOT NULL DEFAULT 'NONE' CHECK (kauro.is_label(provider_ref)),
  http_status          integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  recorded_by_service  text NOT NULL CHECK (recorded_by_service = 'outreach-service'),
  received_at          timestamptz NOT NULL,
  -- U4: one evidence row per (intent, fence) (KA097 (k))
  CONSTRAINT outreach_send_evidence_one_per_fence UNIQUE (intent_id, fence),
  CONSTRAINT outreach_send_evidence_ref CHECK ((status = 'ACCEPTED') = (provider_ref <> 'NONE'))
);
CREATE TABLE kauro.outreach_diagnoses (
  diagnosis_id     uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(diagnosis_id)),
  person_user_id   uuid NOT NULL REFERENCES kauro.identities (user_id),
  owner_user_id    uuid NOT NULL REFERENCES kauro.identities (user_id),
  proof_id         uuid NOT NULL REFERENCES kauro.assurance_proofs (proof_id),
  evidence_hash    text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  recorded_at      timestamptz NOT NULL
);
CREATE TRIGGER outreach_provider_warnings_append_only BEFORE UPDATE OR DELETE ON kauro.outreach_provider_warnings FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER outreach_send_evidence_append_only BEFORE UPDATE OR DELETE ON kauro.outreach_send_evidence FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER outreach_diagnoses_append_only BEFORE UPDATE OR DELETE ON kauro.outreach_diagnoses FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER sales_activities_append_only BEFORE UPDATE OR DELETE ON kauro.sales_activities FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER outreach_send_intents_no_delete BEFORE DELETE ON kauro.outreach_send_intents FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- COUNTED (plan A2, ADV-43): these count as sent for the grant, the person cap, the 14-day anchor, the health window and the metric.
CREATE OR REPLACE FUNCTION kauro.outreach_intent_counted(intent uuid, state text) RETURNS boolean
  LANGUAGE sql STABLE STRICT SET search_path = pg_catalog AS
$$
  SELECT state IN ('QUEUED', 'SUBMITTING', 'PROVIDER_ACCEPTED', 'SEND_UNCERTAIN', 'OBSERVED_SENT')
      OR EXISTS (SELECT 1 FROM kauro.outreach_send_evidence e WHERE e.intent_id = intent AND e.status = 'ACCEPTED')
$$;

-- KA095 (a) and the birth shape of an intent: sender, person, prospect, purpose, contact and route are the draft's and its sender's.
CREATE OR REPLACE FUNCTION kauro.outreach_send_intents_binding() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  d kauro.outreach_drafts;
  s kauro.sender_identities;
BEGIN
  SELECT * INTO d FROM kauro.outreach_drafts WHERE draft_id = NEW.draft_id;
  SELECT * INTO s FROM kauro.sender_identities WHERE sender_id = d.sender_id;
  IF NEW.sender_id IS DISTINCT FROM d.sender_id OR NEW.person_user_id IS DISTINCT FROM s.user_id OR NEW.prospect_id IS DISTINCT FROM d.prospect_id
     OR NEW.purpose IS DISTINCT FROM d.purpose OR NEW.contact_key IS DISTINCT FROM d.contact_key OR NEW.route IS DISTINCT FROM s.route THEN
    RAISE EXCEPTION 'OUTREACH_BINDING: intent % is not bound to its draft''s sender, person, prospect, purpose, contact and route', NEW.intent_id USING ERRCODE = 'KA095';
  END IF;
  IF NEW.state <> 'QUEUED' OR NEW.submitted_at IS NOT NULL OR NEW.claim_fence IS NOT NULL OR NEW.answered_fence IS NOT NULL OR NEW.provider_message_ref IS NOT NULL OR NEW.outcome_reason IS NOT NULL THEN
    RAISE EXCEPTION 'OUTREACH_BINDING: intent % is born QUEUED and unclaimed', NEW.intent_id USING ERRCODE = 'KA095';
  END IF;
  NEW.counted_at := kauro.effect_now();
  RETURN NEW;
END
$$;

-- T1 (KA096): the intent machine (plan A2, A3), one function; (h) a late acceptance names its reference, (i) an answer of another fence
-- than the claim's is accepted only after its evidence row (the evidence path writes it first).
CREATE OR REPLACE FUNCTION kauro.outreach_send_intents_edge() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  e text := OLD.state || '>' || NEW.state;
BEGIN
  IF NOT (e = ANY (ARRAY[
       'QUEUED>SUBMITTING', 'QUEUED>NOT_SENT', 'QUEUED>CANCELLED', 'SUBMITTING>PROVIDER_ACCEPTED', 'SUBMITTING>SEND_UNCERTAIN',
       'SUBMITTING>NOT_SENT', 'SUBMITTING>CANCELLED', 'SEND_UNCERTAIN>PROVIDER_ACCEPTED', 'SEND_UNCERTAIN>OBSERVED_SENT', 'SEND_UNCERTAIN>OBSERVED_NOT_SENT'])) THEN
    RAISE EXCEPTION 'SEND_FENCE: intent edge % is not listed', e USING ERRCODE = 'KA096';
  END IF;
  IF NEW.state = 'PROVIDER_ACCEPTED' AND NEW.provider_message_ref IS NULL THEN
    RAISE EXCEPTION 'SEND_FENCE: % -> PROVIDER_ACCEPTED names the provider reference', OLD.state USING ERRCODE = 'KA096';
  END IF;
  IF NEW.state = 'PROVIDER_ACCEPTED' AND NEW.answered_fence IS DISTINCT FROM OLD.claim_fence AND NOT EXISTS (
       SELECT 1 FROM kauro.outreach_send_evidence v WHERE v.intent_id = OLD.intent_id AND v.fence = NEW.answered_fence AND v.status = 'ACCEPTED' AND v.provider_ref = NEW.provider_message_ref) THEN
    RAISE EXCEPTION 'SEND_FENCE: an answer of fence % to a claim of fence % is accepted only through its evidence row', NEW.answered_fence, OLD.claim_fence USING ERRCODE = 'KA096';
  END IF;
  RETURN NEW;
END
$$;

-- The claim columns (KA096 (c), (f), (g)): counted_at, submitted_at, uncertain_after and claim_fence move only with QUEUED -> SUBMITTING,
-- which stamps them at the database's instant (uncertain_after = submitted_at + startGate + callBound + margin); the bound columns never.
CREATE OR REPLACE FUNCTION kauro.outreach_send_intents_columns() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.intent_id IS DISTINCT FROM OLD.intent_id OR NEW.draft_id IS DISTINCT FROM OLD.draft_id OR NEW.authorization_id IS DISTINCT FROM OLD.authorization_id
     OR NEW.sender_id IS DISTINCT FROM OLD.sender_id OR NEW.person_user_id IS DISTINCT FROM OLD.person_user_id OR NEW.prospect_id IS DISTINCT FROM OLD.prospect_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.route IS DISTINCT FROM OLD.route OR NEW.contact_key IS DISTINCT FROM OLD.contact_key
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash OR NEW.sequence_first_intent_id IS DISTINCT FROM OLD.sequence_first_intent_id
     OR NEW.reply_activity_id IS DISTINCT FROM OLD.reply_activity_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'SEND_FENCE: the bound columns of intent % are immutable', OLD.intent_id USING ERRCODE = 'KA096';
  END IF;
  IF OLD.state = 'QUEUED' AND NEW.state = 'SUBMITTING' THEN
    IF NEW.claim_fence IS NULL THEN
      RAISE EXCEPTION 'SEND_FENCE: the claim of intent % names its lease fence', OLD.intent_id USING ERRCODE = 'KA096';
    END IF;
    NEW.counted_at := kauro.effect_now();
    NEW.submitted_at := NEW.counted_at;
    NEW.uncertain_after := NEW.submitted_at + interval '37 seconds';
  ELSIF NEW.counted_at IS DISTINCT FROM OLD.counted_at OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     OR NEW.uncertain_after IS DISTINCT FROM OLD.uncertain_after OR NEW.claim_fence IS DISTINCT FROM OLD.claim_fence THEN
    RAISE EXCEPTION 'SEND_FENCE: the claim columns of intent % move only with QUEUED -> SUBMITTING', OLD.intent_id USING ERRCODE = 'KA096';
  END IF;
  IF NEW.answered_fence IS DISTINCT FROM OLD.answered_fence AND (OLD.answered_fence IS NOT NULL OR NEW.state = OLD.state) THEN
    RAISE EXCEPTION 'SEND_FENCE: the answering fence of intent % is written once, with its edge', OLD.intent_id USING ERRCODE = 'KA096';
  END IF;
  NEW.updated_at := kauro.server_now();
  RETURN NEW;
END
$$;

-- T2 (plan §L T2 table): the subjects each intent write asserts.
CREATE OR REPLACE FUNCTION kauro.outreach_send_intents_locks() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  r kauro.outreach_send_intents := CASE WHEN TG_OP = 'INSERT' THEN NEW ELSE OLD END;
  e text := CASE WHEN TG_OP = 'INSERT' THEN 'INSERT' ELSE OLD.state || '>' || NEW.state END;
  cap_mode text;
BEGIN
  IF e = 'INSERT' THEN
    PERFORM kauro.outreach_require_lock('kauro.outreach_prospects', r.prospect_id::text, 'X', 'an intent birth');
    PERFORM kauro.outreach_require_lock('kauro.outreach_person_caps', r.person_user_id::text, 'X', 'an intent birth');
    PERFORM kauro.outreach_require_lock('kauro.outreach_authorizations', r.authorization_id::text, 'S', 'an intent birth');
    PERFORM kauro.outreach_require_lock('kauro.outreach_drafts', r.draft_id::text, 'X', 'an intent birth');
    RETURN NEW;
  END IF;
  PERFORM kauro.outreach_require_lock('kauro.outreach_prospects', r.prospect_id::text, 'S', 'intent edge ' || e);
  PERFORM kauro.outreach_require_lock('kauro.outreach_drafts', r.draft_id::text, 'X', 'intent edge ' || e);
  IF e = 'SEND_UNCERTAIN>OBSERVED_SENT' THEN
    RETURN NEW; -- HUMAN SENT: counts unchanged, no L4 / L4g
  END IF;
  cap_mode := CASE WHEN e = 'QUEUED>SUBMITTING' AND r.purpose = 'INDIVIDUAL_PROSPECT_CONTACT' THEN 'X' ELSE 'S' END;
  PERFORM kauro.outreach_require_lock('kauro.outreach_person_caps', r.person_user_id::text, cap_mode, 'intent edge ' || e);
  PERFORM kauro.outreach_require_lock('kauro.outreach_authorizations', r.authorization_id::text, 'S', 'intent edge ' || e);
  RETURN NEW;
END
$$;

-- T3 (plan §G, A10..A12; rule-17 backstop): the counts at the intent's birth and at its claim, judged at kauro.effect_now().
CREATE OR REPLACE FUNCTION kauro.outreach_send_intents_counts() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  judged timestamptz := kauro.effect_now();
  birth boolean := TG_OP = 'INSERT';
  g kauro.outreach_authorizations;
  d kauro.outreach_drafts;
  s kauro.sender_identities;
  p kauro.prospects;
  first_i kauro.outreach_send_intents;
  b boolean;
  n integer;
  opens timestamptz;
  last_diag timestamptz;
  margin interval := CASE WHEN TG_OP = 'INSERT' THEN interval '0' ELSE interval '37 seconds' END;
BEGIN
  SELECT * INTO d FROM kauro.outreach_drafts WHERE draft_id = NEW.draft_id;
  SELECT * INTO s FROM kauro.sender_identities WHERE sender_id = NEW.sender_id;
  SELECT * INTO p FROM kauro.prospects WHERE prospect_id = NEW.prospect_id;
  IF NEW.route = 'RESEND_TRANSACTIONAL' THEN
    RAISE EXCEPTION 'OUTREACH_ROUTE_FORBIDDEN: no outreach intent on the transactional route' USING ERRCODE = 'KC028';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kauro.outreach_channel_policies c WHERE c.jurisdiction = kauro.outreach_jurisdiction(p.jurisdiction) AND c.purpose = NEW.purpose AND c.state = 'IN_FORCE') THEN
    RAISE EXCEPTION 'OUTREACH_ROUTE_FORBIDDEN: no channel policy in force for % %', p.jurisdiction, NEW.purpose USING ERRCODE = 'KC028';
  END IF;
  IF s.state <> 'VERIFIED' THEN
    RAISE EXCEPTION 'SENDER_NOT_VERIFIED: sender % is %', s.sender_id, s.state USING ERRCODE = 'KC031';
  END IF;
  -- the grant (KC030)
  SELECT * INTO g FROM kauro.outreach_authorizations WHERE authorization_id = NEW.authorization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTREACH_GRANT_INVALID: no grant row' USING ERRCODE = 'KC030';
  END IF;
  IF g.revoked THEN
    RAISE EXCEPTION 'OUTREACH_GRANT_INVALID: grant % is revoked', g.authorization_id USING ERRCODE = 'KC030';
  END IF;
  IF judged < g.valid_from THEN
    RAISE EXCEPTION 'OUTREACH_GRANT_INVALID: grant % is not yet valid', g.authorization_id USING ERRCODE = 'KC030';
  END IF;
  IF g.expires_at <= judged + margin THEN
    RAISE EXCEPTION 'OUTREACH_GRANT_INVALID: grant % expired', g.authorization_id USING ERRCODE = 'KC030';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kauro.outreach_authorization_hashes h WHERE h.authorization_id = g.authorization_id AND h.draft_id = d.draft_id AND h.content_hash = d.content_hash) THEN
    RAISE EXCEPTION 'OUTREACH_GRANT_INVALID: the draft''s hash is not sealed by grant %', g.authorization_id USING ERRCODE = 'KC030';
  END IF;
  SELECT count(*) INTO n FROM kauro.outreach_send_intents i
   WHERE i.authorization_id = g.authorization_id AND i.intent_id <> NEW.intent_id AND kauro.outreach_intent_counted(i.intent_id, i.state);
  IF n >= g.maximum_sends THEN
    RAISE EXCEPTION 'OUTREACH_GRANT_INVALID: grant % has reserved % of % sends', g.authorization_id, n, g.maximum_sends USING ERRCODE = 'KC030';
  END IF;
  -- resources (KC033)
  IF EXISTS (SELECT 1 FROM kauro.outreach_draft_resources dr JOIN kauro.sales_resources r ON r.resource_id = dr.resource_id WHERE dr.draft_id = d.draft_id AND r.state <> 'CURRENT') THEN
    RAISE EXCEPTION 'RESOURCE_NOT_CURRENT: draft % cites a superseded resource', d.draft_id USING ERRCODE = 'KC033';
  END IF;
  IF EXISTS (
    SELECT 1 FROM kauro.outreach_draft_resources dr JOIN kauro.sales_resource_capabilities rc ON rc.resource_id = dr.resource_id
      JOIN kauro.capabilities c ON c.capability_id = rc.capability_id
     WHERE dr.draft_id = d.draft_id AND c.state NOT IN ('AVAILABLE', 'AVAILABLE_LIMITED')) THEN
    RAISE EXCEPTION 'RESOURCE_NOT_CURRENT: draft % claims a capability that is not offered', d.draft_id USING ERRCODE = 'KC033';
  END IF;
  -- health (KC034): after the person's latest diagnosis, a provider warning or a complaint, or a bounce among its latest 50 counted sends
  SELECT max(x.recorded_at) INTO last_diag FROM kauro.outreach_diagnoses x WHERE x.person_user_id = NEW.person_user_id;
  IF EXISTS (SELECT 1 FROM kauro.outreach_provider_warnings w WHERE w.person_user_id = NEW.person_user_id AND (last_diag IS NULL OR w.recorded_at > last_diag))
     OR EXISTS (
       SELECT 1 FROM kauro.sales_activities a JOIN kauro.outreach_send_intents i ON i.intent_id = a.intent_id
        WHERE i.person_user_id = NEW.person_user_id AND a.kind = 'SUPPRESSED' AND a.suppression_reason = 'COMPLAINT' AND (last_diag IS NULL OR a.recorded_at > last_diag))
     OR EXISTS (
       SELECT 1 FROM (
         SELECT i.intent_id FROM kauro.outreach_send_intents i
          WHERE i.person_user_id = NEW.person_user_id AND i.intent_id <> NEW.intent_id AND (last_diag IS NULL OR i.counted_at > last_diag)
            AND kauro.outreach_intent_counted(i.intent_id, i.state)
          ORDER BY i.counted_at DESC, i.intent_id DESC LIMIT 50) latest
        JOIN kauro.sales_activities a ON a.intent_id = latest.intent_id AND a.kind = 'BOUNCED') THEN
    RAISE EXCEPTION 'OUTREACH_PAUSED: the outreach of person % is paused pending diagnosis', NEW.person_user_id USING ERRCODE = 'KC034';
  END IF;
  IF birth THEN
    -- the draft is still a DRAFT: an AUTHORIZED, SUBMITTING, PROVIDER_ACCEPTED, SEND_UNCERTAIN, BOUNCED or REPLIED draft was sent or is
    -- being sent (KC036 (a)); CMD063 inserts the intent and then moves its draft DRAFT -> AUTHORIZED
    IF d.state <> 'DRAFT' THEN
      RAISE EXCEPTION 'OUTREACH_ALREADY_SENT: draft % is %, not DRAFT', d.draft_id, d.state USING ERRCODE = 'KC036';
    END IF;
    -- an open uncertainty of the prospect (KC029)
    IF EXISTS (SELECT 1 FROM kauro.outreach_send_intents i WHERE i.prospect_id = NEW.prospect_id AND i.state = 'SEND_UNCERTAIN') THEN
      RAISE EXCEPTION 'SEND_UNCERTAIN_UNRESOLVED: an uncertain send of prospect % is not reconciled', NEW.prospect_id USING ERRCODE = 'KC029';
    END IF;
    -- an earlier intent of the draft with ACCEPTED evidence (KC036 (c), ADV-43)
    IF EXISTS (
      SELECT 1 FROM kauro.outreach_send_intents i JOIN kauro.outreach_send_evidence v ON v.intent_id = i.intent_id AND v.status = 'ACCEPTED'
       WHERE i.draft_id = NEW.draft_id AND i.intent_id <> NEW.intent_id) THEN
      RAISE EXCEPTION 'OUTREACH_ALREADY_SENT: an earlier intent of draft % has accepted evidence', NEW.draft_id USING ERRCODE = 'KC036';
    END IF;
  END IF;
  -- cadence (KC032, A11): a stop fact ends every sequence of the prospect, except the requested reply that answers a reply
  IF NEW.purpose <> 'REQUESTED_REPLY' AND EXISTS (SELECT 1 FROM kauro.sales_activities a WHERE a.prospect_id = NEW.prospect_id AND a.kind IN ('REPLIED', 'BOUNCED', 'SUPPRESSED')) THEN
    RAISE EXCEPTION 'OUTREACH_CAP_REACHED: CADENCE_CLOSED, a stop fact of prospect % ends its sequences', NEW.prospect_id USING ERRCODE = 'KC032';
  END IF;
  IF NEW.purpose = 'REQUESTED_REPLY' THEN
    IF NOT EXISTS (SELECT 1 FROM kauro.sales_activities a WHERE a.activity_id = NEW.reply_activity_id AND a.prospect_id = NEW.prospect_id AND a.kind = 'REPLIED')
       OR EXISTS (SELECT 1 FROM kauro.sales_activities a WHERE a.prospect_id = NEW.prospect_id AND a.kind IN ('BOUNCED', 'SUPPRESSED')) THEN
      RAISE EXCEPTION 'OUTREACH_CAP_REACHED: CADENCE_CLOSED, a requested reply answers a reply of an unsuppressed prospect' USING ERRCODE = 'KC032';
    END IF;
  ELSIF NEW.purpose = 'INDIVIDUAL_PROSPECT_CONTACT' THEN
    b := kauro.outreach_business_instant(judged);
    IF b IS NULL THEN
      RAISE EXCEPTION 'OUTREACH_CALENDAR_UNAVAILABLE: no calendar row for %', judged USING ERRCODE = 'KC037';
    END IF;
    IF NOT b THEN
      RAISE EXCEPTION 'OUTREACH_CAP_REACHED: OUTSIDE_BUSINESS_DAY at %', judged USING ERRCODE = 'KC032';
    END IF;
    SELECT count(*) INTO n FROM kauro.outreach_send_intents i
     WHERE i.person_user_id = NEW.person_user_id AND i.purpose = 'INDIVIDUAL_PROSPECT_CONTACT' AND i.intent_id <> NEW.intent_id
       AND i.counted_at > judged - interval '24 hours' AND kauro.outreach_intent_counted(i.intent_id, i.state);
    IF n >= 10 THEN
      RAISE EXCEPTION 'OUTREACH_CAP_REACHED: CAP_REACHED, % first contacts of person % in 24 h', n, NEW.person_user_id USING ERRCODE = 'KC032';
    END IF;
    IF birth AND EXISTS (
         SELECT 1 FROM kauro.outreach_send_intents i WHERE i.prospect_id = NEW.prospect_id AND i.purpose <> 'REQUESTED_REPLY' AND i.intent_id <> NEW.intent_id
            AND i.counted_at > judged - interval '14 days' AND kauro.outreach_intent_counted(i.intent_id, i.state)) THEN
      RAISE EXCEPTION 'OUTREACH_CAP_REACHED: CADENCE_CLOSED, prospect % has an active sequence', NEW.prospect_id USING ERRCODE = 'KC032';
    END IF;
    IF birth AND EXISTS (
         SELECT 1 FROM kauro.outreach_send_intents i WHERE i.prospect_id = NEW.prospect_id AND i.purpose <> 'REQUESTED_REPLY' AND i.intent_id <> NEW.intent_id
            AND i.counted_at <= judged - interval '14 days' AND i.counted_at > judged - interval '90 days' AND kauro.outreach_intent_counted(i.intent_id, i.state)) THEN
      RAISE EXCEPTION 'OUTREACH_CAP_REACHED: CADENCE_CLOSED, a new sequence of prospect % opens 90 days after its last message', NEW.prospect_id USING ERRCODE = 'KC032';
    END IF;
  ELSE
    SELECT * INTO first_i FROM kauro.outreach_send_intents WHERE intent_id = NEW.sequence_first_intent_id;
    IF NOT FOUND OR first_i.prospect_id <> NEW.prospect_id OR first_i.purpose <> 'INDIVIDUAL_PROSPECT_CONTACT'
       OR NOT (first_i.state IN ('PROVIDER_ACCEPTED', 'OBSERVED_SENT') OR EXISTS (SELECT 1 FROM kauro.outreach_send_evidence v WHERE v.intent_id = first_i.intent_id AND v.status = 'ACCEPTED')) THEN
      RAISE EXCEPTION 'OUTREACH_CAP_REACHED: FIRST_NOT_SENT, the sequence''s first message was not sent' USING ERRCODE = 'KC032';
    END IF;
    SELECT count(*) INTO n FROM kauro.outreach_send_intents i
     WHERE i.sequence_first_intent_id = first_i.intent_id AND i.intent_id <> NEW.intent_id AND kauro.outreach_intent_counted(i.intent_id, i.state);
    IF n >= 1 THEN
      RAISE EXCEPTION 'OUTREACH_CAP_REACHED: CADENCE_CLOSED, the sequence has its one follow-up' USING ERRCODE = 'KC032';
    END IF;
    opens := kauro.outreach_business_days_after(first_i.counted_at, 5);
    IF opens IS NULL THEN
      RAISE EXCEPTION 'OUTREACH_CALENDAR_UNAVAILABLE: the follow-up window of % is not covered', first_i.intent_id USING ERRCODE = 'KC037';
    END IF;
    IF judged < opens THEN
      RAISE EXCEPTION 'OUTREACH_CAP_REACHED: CADENCE_CLOSED, the follow-up opens at %', opens USING ERRCODE = 'KC032';
    END IF;
    IF judged >= first_i.counted_at + interval '14 days' THEN
      RAISE EXCEPTION 'OUTREACH_CAP_REACHED: CADENCE_CLOSED, the follow-up window closed' USING ERRCODE = 'KC032';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- KC036 (b): SEND_UNCERTAIN -> OBSERVED_NOT_SENT is refused once the provider accepted the send (an ACCEPTED evidence row or a
-- PROVIDER_ACCEPTED activity of the intent): the human observation never reopens a sent message.
CREATE OR REPLACE FUNCTION kauro.outreach_send_intents_observed() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF EXISTS (SELECT 1 FROM kauro.outreach_send_evidence v WHERE v.intent_id = OLD.intent_id AND v.status = 'ACCEPTED')
     OR EXISTS (SELECT 1 FROM kauro.sales_activities a WHERE a.intent_id = OLD.intent_id AND a.kind = 'PROVIDER_ACCEPTED') THEN
    RAISE EXCEPTION 'OUTREACH_ALREADY_SENT: intent % was accepted by the provider', OLD.intent_id USING ERRCODE = 'KC036';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER outreach_send_intents_a_binding BEFORE INSERT ON kauro.outreach_send_intents
  FOR EACH ROW EXECUTE FUNCTION kauro.outreach_send_intents_binding();
CREATE TRIGGER outreach_send_intents_b_locks BEFORE INSERT ON kauro.outreach_send_intents
  FOR EACH ROW EXECUTE FUNCTION kauro.outreach_send_intents_locks();
CREATE TRIGGER outreach_send_intents_c_counts BEFORE INSERT ON kauro.outreach_send_intents
  FOR EACH ROW EXECUTE FUNCTION kauro.outreach_send_intents_counts();
CREATE TRIGGER outreach_send_intents_d_edge BEFORE UPDATE OF state ON kauro.outreach_send_intents
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.outreach_send_intents_edge();
CREATE TRIGGER outreach_send_intents_e_locks BEFORE UPDATE OF state ON kauro.outreach_send_intents
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.outreach_send_intents_locks();
CREATE TRIGGER outreach_send_intents_f_columns BEFORE UPDATE ON kauro.outreach_send_intents
  FOR EACH ROW EXECUTE FUNCTION kauro.outreach_send_intents_columns();
CREATE TRIGGER outreach_send_intents_h_observed BEFORE UPDATE OF state ON kauro.outreach_send_intents
  FOR EACH ROW WHEN (NEW.state = 'OBSERVED_NOT_SENT' AND OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.outreach_send_intents_observed();
CREATE TRIGGER outreach_send_intents_g_claim_counts BEFORE UPDATE OF state ON kauro.outreach_send_intents
  FOR EACH ROW WHEN (OLD.state = 'QUEUED' AND NEW.state = 'SUBMITTING') EXECUTE FUNCTION kauro.outreach_send_intents_counts();

-- the draft triggers that read the intents
CREATE TRIGGER outreach_drafts_b_edge BEFORE UPDATE OF state ON kauro.outreach_drafts
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.outreach_drafts_edge();
CREATE TRIGGER outreach_drafts_c_locks BEFORE UPDATE OF state ON kauro.outreach_drafts
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.outreach_drafts_locks();

-- KA097 and T2 of activities (plan §L T2 table: the subjects per kind).
CREATE OR REPLACE FUNCTION kauro.sales_activities_facts() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.occurred_at > kauro.effect_now() THEN
    RAISE EXCEPTION 'ACTIVITY_EVIDENCE: an activity cannot occur after the database''s instant' USING ERRCODE = 'KA097';
  END IF;
  IF NEW.kind IN ('PROVIDER_ACCEPTED', 'SEND_UNCERTAIN') AND NEW.recorded_by_service IS NULL THEN
    RAISE EXCEPTION 'ACTIVITY_EVIDENCE: % is recorded by the outreach service, never by a person', NEW.kind USING ERRCODE = 'KA097';
  END IF;
  IF NEW.kind IN ('REPLIED', 'BOUNCED') AND NEW.provider_message_ref = 'NONE' THEN
    RAISE EXCEPTION 'ACTIVITY_EVIDENCE: % names its provider message', NEW.kind USING ERRCODE = 'KA097';
  END IF;
  IF NEW.kind = 'REPLIED' AND EXISTS (SELECT 1 FROM kauro.outreach_send_intents i WHERE i.provider_message_ref = NEW.provider_message_ref) THEN
    RAISE EXCEPTION 'ACTIVITY_EVIDENCE: a reply names an inbound message, not an outbound one' USING ERRCODE = 'KA097';
  END IF;
  IF NEW.intent_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM kauro.outreach_send_intents i WHERE i.intent_id = NEW.intent_id AND i.draft_id = NEW.draft_id AND i.authorization_id = NEW.authorization_id AND i.prospect_id = NEW.prospect_id) THEN
    RAISE EXCEPTION 'ACTIVITY_EVIDENCE: the activity is not bound to its intent''s draft, grant and prospect' USING ERRCODE = 'KA097';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sales_activities_a_facts BEFORE INSERT ON kauro.sales_activities FOR EACH ROW EXECUTE FUNCTION kauro.sales_activities_facts();

CREATE OR REPLACE FUNCTION kauro.sales_activities_locks() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  person uuid;
BEGIN
  IF NEW.kind IN ('PROVIDER_ACCEPTED', 'SEND_UNCERTAIN', 'HUMAN_SEND_OBSERVED') THEN
    PERFORM kauro.outreach_require_lock('kauro.outreach_drafts', NEW.draft_id::text, 'X', 'a ' || NEW.kind || ' activity');
  ELSIF NEW.kind = 'REPLIED' THEN
    PERFORM kauro.outreach_require_lock('kauro.outreach_prospects', NEW.prospect_id::text, 'X', 'a REPLIED activity');
    PERFORM kauro.outreach_require_lock('kauro.outreach_drafts', NEW.draft_id::text, 'X', 'a REPLIED activity');
  ELSIF NEW.kind = 'BOUNCED' THEN
    SELECT i.person_user_id INTO person FROM kauro.outreach_send_intents i WHERE i.intent_id = NEW.intent_id;
    PERFORM kauro.outreach_require_lock('kauro.outreach_prospects', NEW.prospect_id::text, 'X', 'a BOUNCED activity');
    PERFORM kauro.outreach_require_lock('kauro.outreach_person_caps', person::text, 'X', 'a BOUNCED activity');
    PERFORM kauro.outreach_require_lock('kauro.outreach_drafts', NEW.draft_id::text, 'X', 'a BOUNCED activity');
  ELSE
    PERFORM kauro.outreach_require_lock('kauro.prospect_suppressions', NEW.suppression_key_kind || ':' || NEW.suppression_key, 'X', 'a SUPPRESSED activity');
    IF NEW.suppression_reason = 'COMPLAINT' THEN
      SELECT i.person_user_id INTO person FROM kauro.outreach_send_intents i WHERE i.intent_id = NEW.intent_id;
      PERFORM kauro.outreach_require_lock('kauro.outreach_person_caps', person::text, 'X', 'a COMPLAINT activity');
    END IF;
    IF NEW.intent_id IS NOT NULL THEN
      PERFORM kauro.outreach_require_lock('kauro.outreach_drafts', NEW.draft_id::text, 'X', 'a SUPPRESSED activity of an intent');
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sales_activities_b_locks BEFORE INSERT ON kauro.sales_activities FOR EACH ROW EXECUTE FUNCTION kauro.sales_activities_locks();

-- warnings (L4 X, L10 X), evidence (L10 X), diagnoses (L4 X): stamped at the database's instant
CREATE OR REPLACE FUNCTION kauro.outreach_provider_warnings_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  i kauro.outreach_send_intents;
BEGIN
  SELECT * INTO i FROM kauro.outreach_send_intents WHERE intent_id = NEW.intent_id;
  IF NEW.person_user_id IS DISTINCT FROM i.person_user_id THEN
    RAISE EXCEPTION 'ACTIVITY_EVIDENCE: the warning names the person of its intent' USING ERRCODE = 'KA097';
  END IF;
  PERFORM kauro.outreach_require_lock('kauro.outreach_person_caps', i.person_user_id::text, 'X', 'a provider warning');
  PERFORM kauro.outreach_require_lock('kauro.outreach_drafts', i.draft_id::text, 'X', 'a provider warning');
  NEW.recorded_at := kauro.effect_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER outreach_provider_warnings_birth BEFORE INSERT ON kauro.outreach_provider_warnings FOR EACH ROW EXECUTE FUNCTION kauro.outreach_provider_warnings_birth();
CREATE OR REPLACE FUNCTION kauro.outreach_send_evidence_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM kauro.outreach_require_lock('kauro.outreach_drafts', (SELECT i.draft_id::text FROM kauro.outreach_send_intents i WHERE i.intent_id = NEW.intent_id), 'X', 'a send evidence row');
  NEW.received_at := kauro.effect_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER outreach_send_evidence_birth BEFORE INSERT ON kauro.outreach_send_evidence FOR EACH ROW EXECUTE FUNCTION kauro.outreach_send_evidence_birth();
CREATE OR REPLACE FUNCTION kauro.outreach_diagnoses_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM kauro.assurance_proofs p WHERE p.proof_id = NEW.proof_id AND p.user_id = NEW.owner_user_id) THEN
    RAISE EXCEPTION 'OUTREACH_BINDING: a diagnosis cites the owner''s own step-up' USING ERRCODE = 'KA095';
  END IF;
  PERFORM kauro.outreach_require_lock('kauro.outreach_person_caps', NEW.person_user_id::text, 'X', 'a diagnosis');
  NEW.recorded_at := kauro.effect_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER outreach_diagnoses_birth BEFORE INSERT ON kauro.outreach_diagnoses FOR EACH ROW EXECUTE FUNCTION kauro.outreach_diagnoses_birth();

-- --- prospect suppressions (ALTER; plan A4, A14) -------------------------------------------------------------------------------------------
-- A suppression is recorded by a person (seller or owner) or by the outreach service (the public opt-out), never both, never neither.
ALTER TABLE kauro.prospect_suppressions ALTER COLUMN recorded_by_user_id DROP NOT NULL;
ALTER TABLE kauro.prospect_suppressions ADD COLUMN recorded_by_service text CHECK (recorded_by_service = 'outreach-service');
ALTER TABLE kauro.prospect_suppressions ADD CONSTRAINT prospect_suppressions_one_recorder CHECK (num_nonnulls(recorded_by_user_id, recorded_by_service) = 1);
-- T2: every suppression INSERT under L8 X of its key (CMD064 SUPPRESSED, the opt-out, and the fixtures that stand in for them)
CREATE OR REPLACE FUNCTION kauro.prospect_suppressions_locks() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM kauro.outreach_require_lock('kauro.prospect_suppressions', NEW.key_kind || ':' || NEW.suppression_key, 'X', 'a suppression');
  RETURN NEW;
END
$$;
CREATE TRIGGER prospect_suppressions_locks BEFORE INSERT ON kauro.prospect_suppressions FOR EACH ROW EXECUTE FUNCTION kauro.prospect_suppressions_locks();

-- CMD045 (0029): the registration takes L8 S of its organization key and its contact key (ascending) before it reads the suppressions,
-- so a suppression of either key in flight is ordered before or after it (the one trigger that acquires; plan §L, ADV-44(1)).
CREATE OR REPLACE FUNCTION kauro.prospects_not_suppressed() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  contact text;
  k text;
BEGIN
  SELECT c.contact_key INTO contact FROM kauro.prospect_contacts c WHERE c.recorded_by_user_id = NEW.registered_by_user_id AND c.contact_id = NEW.business_contact_id;
  FOR k IN SELECT x FROM unnest(ARRAY['ORGANIZATION:' || NEW.organization_key, CASE WHEN contact IS NULL THEN NULL ELSE 'CONTACT:' || contact END]) AS x WHERE x IS NOT NULL ORDER BY x LOOP
    PERFORM pg_advisory_xact_lock_shared(kauro.transition_key('kauro.prospect_suppressions', k));
  END LOOP;
  IF EXISTS (SELECT 1 FROM kauro.prospect_suppressions s WHERE s.key_kind = 'ORGANIZATION' AND s.suppression_key = NEW.organization_key)
     OR (contact IS NOT NULL AND EXISTS (SELECT 1 FROM kauro.prospect_suppressions s WHERE s.key_kind = 'CONTACT' AND s.suppression_key = contact)) THEN
    RAISE EXCEPTION 'PROSPECT_SUPPRESSED: the organization or business contact of this prospect is suppressed' USING ERRCODE = 'KC016';
  END IF;
  RETURN NEW;
END
$$;

-- --- prospects UPDATE by a non-owner (KA098, rev 4 ADV-40; one guard per control, rule 24c) -----------------------------------------
-- KA098-W: an update to SUPPRESSED by a seller or the outreach service changes only state, suppressed, version and updated_at.
CREATE OR REPLACE FUNCTION kauro.prospects_suppression_columns() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT kauro.acting_corporate_owner()
     AND (to_jsonb(NEW) - 'state' - 'suppressed' - 'version' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'suppressed' - 'version' - 'updated_at') THEN
    RAISE EXCEPTION 'OUTREACH_SUPPRESSION_SCOPE: a non-owner prospect update changes only its state' USING ERRCODE = 'KA098';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER prospects_suppression_columns BEFORE UPDATE ON kauro.prospects
  FOR EACH ROW WHEN (NEW.state = 'SUPPRESSED') EXECUTE FUNCTION kauro.prospects_suppression_columns();
-- KA098-R: a prospect becomes SUPPRESSED only when a suppression of its organization or contact key exists.
CREATE OR REPLACE FUNCTION kauro.prospects_suppression_reached() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM kauro.prospect_suppressions s WHERE s.key_kind = 'ORGANIZATION' AND s.suppression_key = NEW.organization_key)
     AND NOT EXISTS (
       SELECT 1 FROM kauro.prospect_contacts c JOIN kauro.prospect_suppressions s ON s.key_kind = 'CONTACT' AND s.suppression_key = c.contact_key
        WHERE c.recorded_by_user_id = NEW.registered_by_user_id AND c.contact_id = NEW.business_contact_id) THEN
    RAISE EXCEPTION 'OUTREACH_SUPPRESSION_SCOPE: prospect % is suppressed only by a suppression that reaches it', NEW.prospect_id USING ERRCODE = 'KA098';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER prospects_suppression_reached BEFORE UPDATE OF state ON kauro.prospects
  FOR EACH ROW WHEN (NEW.state = 'SUPPRESSED' AND OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.prospects_suppression_reached();
-- the seller's own prospect, to SUPPRESSED only (CMD064 SUPPRESSED); WITH CHECK owns the target state (rev 4)
CREATE POLICY prospects_seller_suppress ON kauro.prospects FOR UPDATE TO kauro_app
  USING (owner_seller_id = kauro.acting_seller_id())
  WITH CHECK (state = 'SUPPRESSED');

-- --- holdOutreachLease (L13; plan §L, §W) ------------------------------------------------------------------------------------------------
-- The outreach service locks and reads the liveness of the dispatcher's OUTBOX_DISPATCH lease, never changes it (the 0048 pattern).
CREATE POLICY leases_outreach_read ON kauro.leases FOR SELECT TO kauro_outreach USING (resource_kind = 'OUTBOX_DISPATCH');
CREATE POLICY leases_outreach_lock ON kauro.leases FOR UPDATE TO kauro_outreach USING (resource_kind = 'OUTBOX_DISPATCH') WITH CHECK (false);
GRANT SELECT (resource_kind, resource_id, owner_id, fence, expires_at) ON kauro.leases TO kauro_outreach;
GRANT UPDATE (resource_id) ON kauro.leases TO kauro_outreach;

-- --- row-level security and grants (FORCE everywhere; no DELETE, no TRUNCATE grant) ------------------------------------------------------
ALTER TABLE kauro.outreach_calendar_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.outreach_calendar_days FORCE ROW LEVEL SECURITY;
CREATE POLICY outreach_calendar_days_read ON kauro.outreach_calendar_days FOR SELECT TO kauro_app, kauro_outreach USING (true);
GRANT SELECT ON kauro.outreach_calendar_days TO kauro_app, kauro_outreach;

ALTER TABLE kauro.sender_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.sender_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY sender_identities_owner_read ON kauro.sender_identities FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY sender_identities_self_read ON kauro.sender_identities FOR SELECT TO kauro_app USING (kauro.current_agency_id() IS NULL AND user_id = kauro.current_user_id());
CREATE POLICY sender_identities_owner_record ON kauro.sender_identities FOR INSERT TO kauro_app WITH CHECK (kauro.acting_corporate_owner() AND recorded_by_user_id = kauro.current_user_id());
CREATE POLICY sender_identities_owner_update ON kauro.sender_identities FOR UPDATE TO kauro_app USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY sender_identities_outreach_read ON kauro.sender_identities FOR SELECT TO kauro_outreach USING (true);
-- D4 on AUTH_REVOKED: VERIFIED -> REVOKED only
CREATE POLICY sender_identities_outreach_revoke ON kauro.sender_identities FOR UPDATE TO kauro_outreach USING (state = 'VERIFIED') WITH CHECK (state = 'REVOKED');
GRANT SELECT, INSERT ON kauro.sender_identities TO kauro_app;
GRANT UPDATE (state, verification_evidence_hash, updated_at) ON kauro.sender_identities TO kauro_app;
GRANT SELECT ON kauro.sender_identities TO kauro_outreach;
GRANT UPDATE (state, updated_at) ON kauro.sender_identities TO kauro_outreach;

ALTER TABLE kauro.outreach_contents ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.outreach_contents FORCE ROW LEVEL SECURITY;
CREATE POLICY outreach_contents_read ON kauro.outreach_contents FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner() OR kauro.acting_seller_id() IS NOT NULL);
CREATE POLICY outreach_contents_record ON kauro.outreach_contents FOR INSERT TO kauro_app
  WITH CHECK (recorded_by_user_id = kauro.current_user_id() AND (kauro.acting_seller_id() IS NOT NULL OR kauro.acting_corporate_owner()));
CREATE POLICY outreach_contents_outreach_read ON kauro.outreach_contents FOR SELECT TO kauro_outreach USING (true);
GRANT SELECT, INSERT ON kauro.outreach_contents TO kauro_app;
GRANT SELECT ON kauro.outreach_contents TO kauro_outreach;

ALTER TABLE kauro.sales_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.sales_resources FORCE ROW LEVEL SECURITY;
CREATE POLICY sales_resources_read ON kauro.sales_resources FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner() OR kauro.acting_seller_id() IS NOT NULL);
CREATE POLICY sales_resources_publish ON kauro.sales_resources FOR INSERT TO kauro_app WITH CHECK (kauro.acting_corporate_owner() AND published_by_user_id = kauro.current_user_id());
CREATE POLICY sales_resources_supersede ON kauro.sales_resources FOR UPDATE TO kauro_app USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY sales_resources_outreach_read ON kauro.sales_resources FOR SELECT TO kauro_outreach USING (true);
GRANT SELECT, INSERT ON kauro.sales_resources TO kauro_app;
GRANT UPDATE (state) ON kauro.sales_resources TO kauro_app;
GRANT SELECT ON kauro.sales_resources TO kauro_outreach;
ALTER TABLE kauro.sales_resource_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.sales_resource_capabilities FORCE ROW LEVEL SECURITY;
CREATE POLICY sales_resource_capabilities_read ON kauro.sales_resource_capabilities FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner() OR kauro.acting_seller_id() IS NOT NULL);
CREATE POLICY sales_resource_capabilities_publish ON kauro.sales_resource_capabilities FOR INSERT TO kauro_app WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY sales_resource_capabilities_outreach_read ON kauro.sales_resource_capabilities FOR SELECT TO kauro_outreach USING (true);
GRANT SELECT, INSERT ON kauro.sales_resource_capabilities TO kauro_app;
GRANT SELECT ON kauro.sales_resource_capabilities TO kauro_outreach;
-- the intent's T3 reads the claimed capabilities' states as the outreach service (D2) too
CREATE POLICY capabilities_outreach_read ON kauro.capabilities FOR SELECT TO kauro_outreach USING (true);
GRANT SELECT (capability_id, kind, mode, state) ON kauro.capabilities TO kauro_outreach;

ALTER TABLE kauro.outreach_channel_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.outreach_channel_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY outreach_channel_policies_read ON kauro.outreach_channel_policies FOR SELECT TO kauro_app, kauro_outreach USING (true);
CREATE POLICY outreach_channel_policies_withdraw ON kauro.outreach_channel_policies FOR UPDATE TO kauro_app
  USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner() AND withdrawn_by_user_id = kauro.current_user_id());
GRANT SELECT ON kauro.outreach_channel_policies TO kauro_app, kauro_outreach;
GRANT UPDATE (state, withdrawn_by_user_id) ON kauro.outreach_channel_policies TO kauro_app;

ALTER TABLE kauro.prospect_contact_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.prospect_contact_addresses FORCE ROW LEVEL SECURITY;
CREATE POLICY prospect_contact_addresses_owner_read ON kauro.prospect_contact_addresses FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY prospect_contact_addresses_self_read ON kauro.prospect_contact_addresses FOR SELECT TO kauro_app USING (kauro.current_agency_id() IS NULL AND recorded_by_user_id = kauro.current_user_id());
CREATE POLICY prospect_contact_addresses_record ON kauro.prospect_contact_addresses FOR INSERT TO kauro_app
  WITH CHECK (recorded_by_user_id = kauro.current_user_id() AND (kauro.acting_seller_id() IS NOT NULL OR kauro.acting_corporate_owner()));
CREATE POLICY prospect_contact_addresses_outreach_read ON kauro.prospect_contact_addresses FOR SELECT TO kauro_outreach USING (true);
GRANT SELECT, INSERT ON kauro.prospect_contact_addresses TO kauro_app;
GRANT SELECT ON kauro.prospect_contact_addresses TO kauro_outreach;

ALTER TABLE kauro.outreach_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.outreach_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY outreach_drafts_owner_read ON kauro.outreach_drafts FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY outreach_drafts_author_read ON kauro.outreach_drafts FOR SELECT TO kauro_app USING (kauro.current_agency_id() IS NULL AND author_user_id = kauro.current_user_id());
CREATE POLICY outreach_drafts_record ON kauro.outreach_drafts FOR INSERT TO kauro_app
  WITH CHECK (author_user_id = kauro.current_user_id() AND (kauro.acting_seller_id() IS NOT NULL OR kauro.acting_corporate_owner()));
-- CMD063 (the sender person) and CMD064 (the recorder of its own intent's activity) move the draft's state
CREATE POLICY outreach_drafts_move ON kauro.outreach_drafts FOR UPDATE TO kauro_app
  USING (kauro.acting_corporate_owner() OR (kauro.current_agency_id() IS NULL AND author_user_id = kauro.current_user_id()))
  WITH CHECK (kauro.acting_corporate_owner() OR (kauro.current_agency_id() IS NULL AND author_user_id = kauro.current_user_id()));
CREATE POLICY outreach_drafts_outreach_read ON kauro.outreach_drafts FOR SELECT TO kauro_outreach USING (true);
CREATE POLICY outreach_drafts_outreach_move ON kauro.outreach_drafts FOR UPDATE TO kauro_outreach USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON kauro.outreach_drafts TO kauro_app;
GRANT UPDATE (state, updated_at) ON kauro.outreach_drafts TO kauro_app, kauro_outreach;
GRANT SELECT ON kauro.outreach_drafts TO kauro_outreach;
ALTER TABLE kauro.outreach_draft_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.outreach_draft_resources FORCE ROW LEVEL SECURITY;
CREATE POLICY outreach_draft_resources_read ON kauro.outreach_draft_resources FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner() OR kauro.acting_seller_id() IS NOT NULL);
CREATE POLICY outreach_draft_resources_record ON kauro.outreach_draft_resources FOR INSERT TO kauro_app
  WITH CHECK (EXISTS (SELECT 1 FROM kauro.outreach_drafts d WHERE d.draft_id = outreach_draft_resources.draft_id AND d.author_user_id = kauro.current_user_id()));
CREATE POLICY outreach_draft_resources_outreach_read ON kauro.outreach_draft_resources FOR SELECT TO kauro_outreach USING (true);
GRANT SELECT, INSERT ON kauro.outreach_draft_resources TO kauro_app;
GRANT SELECT ON kauro.outreach_draft_resources TO kauro_outreach;

ALTER TABLE kauro.outreach_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.outreach_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY outreach_reviews_owner ON kauro.outreach_reviews FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY outreach_reviews_record ON kauro.outreach_reviews FOR INSERT TO kauro_app WITH CHECK (kauro.acting_corporate_owner() AND owner_user_id = kauro.current_user_id());
GRANT SELECT, INSERT ON kauro.outreach_reviews TO kauro_app;
ALTER TABLE kauro.outreach_review_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.outreach_review_items FORCE ROW LEVEL SECURITY;
CREATE POLICY outreach_review_items_owner ON kauro.outreach_review_items FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY outreach_review_items_record ON kauro.outreach_review_items FOR INSERT TO kauro_app WITH CHECK (kauro.acting_corporate_owner());
GRANT SELECT, INSERT ON kauro.outreach_review_items TO kauro_app;

ALTER TABLE kauro.outreach_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.outreach_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY outreach_authorizations_owner_read ON kauro.outreach_authorizations FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
-- the sender person reads the grants of its own senders (CMD063)
CREATE POLICY outreach_authorizations_sender_read ON kauro.outreach_authorizations FOR SELECT TO kauro_app
  USING (kauro.current_agency_id() IS NULL AND EXISTS (SELECT 1 FROM kauro.sender_identities s WHERE s.sender_id = outreach_authorizations.sender_id AND s.user_id = kauro.current_user_id()));
CREATE POLICY outreach_authorizations_grant ON kauro.outreach_authorizations FOR INSERT TO kauro_app WITH CHECK (kauro.acting_corporate_owner() AND granting_user_id = kauro.current_user_id());
CREATE POLICY outreach_authorizations_revoke ON kauro.outreach_authorizations FOR UPDATE TO kauro_app
  USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner() AND revoked_by_user_id = kauro.current_user_id());
CREATE POLICY outreach_authorizations_outreach_read ON kauro.outreach_authorizations FOR SELECT TO kauro_outreach USING (true);
GRANT SELECT, INSERT ON kauro.outreach_authorizations TO kauro_app;
GRANT UPDATE (revoked, revoked_by_user_id) ON kauro.outreach_authorizations TO kauro_app;
GRANT SELECT ON kauro.outreach_authorizations TO kauro_outreach;
ALTER TABLE kauro.outreach_authorization_hashes ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.outreach_authorization_hashes FORCE ROW LEVEL SECURITY;
CREATE POLICY outreach_authorization_hashes_owner_read ON kauro.outreach_authorization_hashes FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY outreach_authorization_hashes_sender_read ON kauro.outreach_authorization_hashes FOR SELECT TO kauro_app
  USING (kauro.current_agency_id() IS NULL AND EXISTS (SELECT 1 FROM kauro.outreach_drafts d WHERE d.draft_id = outreach_authorization_hashes.draft_id AND d.author_user_id = kauro.current_user_id()));
CREATE POLICY outreach_authorization_hashes_seal ON kauro.outreach_authorization_hashes FOR INSERT TO kauro_app WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY outreach_authorization_hashes_outreach_read ON kauro.outreach_authorization_hashes FOR SELECT TO kauro_outreach USING (true);
GRANT SELECT, INSERT ON kauro.outreach_authorization_hashes TO kauro_app;
GRANT SELECT ON kauro.outreach_authorization_hashes TO kauro_outreach;

ALTER TABLE kauro.outreach_send_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.outreach_send_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY outreach_send_intents_owner_read ON kauro.outreach_send_intents FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY outreach_send_intents_person_read ON kauro.outreach_send_intents FOR SELECT TO kauro_app USING (kauro.current_agency_id() IS NULL AND person_user_id = kauro.current_user_id());
-- CMD063: the sender person queues its own intent
CREATE POLICY outreach_send_intents_queue ON kauro.outreach_send_intents FOR INSERT TO kauro_app
  WITH CHECK (person_user_id = kauro.current_user_id() AND (kauro.acting_seller_id() IS NOT NULL OR kauro.acting_corporate_owner()));
-- HUMAN_SEND_OBSERVED (CMD064): the person reconciles its own uncertain intent
CREATE POLICY outreach_send_intents_observe ON kauro.outreach_send_intents FOR UPDATE TO kauro_app
  USING (kauro.current_agency_id() IS NULL AND person_user_id = kauro.current_user_id() AND state = 'SEND_UNCERTAIN')
  WITH CHECK (state IN ('OBSERVED_SENT', 'OBSERVED_NOT_SENT'));
CREATE POLICY outreach_send_intents_prospect_read ON kauro.outreach_send_intents FOR SELECT TO kauro_app
  USING (kauro.current_agency_id() IS NULL AND EXISTS (SELECT 1 FROM kauro.prospects p WHERE p.prospect_id = outreach_send_intents.prospect_id));
CREATE POLICY outreach_send_intents_outreach_read ON kauro.outreach_send_intents FOR SELECT TO kauro_outreach USING (true);
CREATE POLICY outreach_send_intents_outreach_move ON kauro.outreach_send_intents FOR UPDATE TO kauro_outreach USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON kauro.outreach_send_intents TO kauro_app;
GRANT UPDATE (state, updated_at) ON kauro.outreach_send_intents TO kauro_app;
GRANT SELECT ON kauro.outreach_send_intents TO kauro_outreach;
GRANT UPDATE (state, counted_at, submitted_at, uncertain_after, claim_fence, answered_fence, provider_message_ref, outcome_reason, updated_at) ON kauro.outreach_send_intents TO kauro_outreach;

ALTER TABLE kauro.sales_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.sales_activities FORCE ROW LEVEL SECURITY;
CREATE POLICY sales_activities_owner_read ON kauro.sales_activities FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY sales_activities_recorder_read ON kauro.sales_activities FOR SELECT TO kauro_app USING (kauro.current_agency_id() IS NULL AND recorded_by_user_id = kauro.current_user_id());
CREATE POLICY sales_activities_record ON kauro.sales_activities FOR INSERT TO kauro_app
  WITH CHECK (recorded_by_user_id = kauro.current_user_id() AND recorded_by_service IS NULL AND kind IN ('BOUNCED', 'REPLIED', 'SUPPRESSED', 'HUMAN_SEND_OBSERVED')
              AND (kauro.acting_seller_id() IS NOT NULL OR kauro.acting_corporate_owner()));
CREATE POLICY sales_activities_prospect_read ON kauro.sales_activities FOR SELECT TO kauro_app
  USING (kauro.current_agency_id() IS NULL AND EXISTS (SELECT 1 FROM kauro.prospects p WHERE p.prospect_id = sales_activities.prospect_id));
CREATE POLICY sales_activities_person_read ON kauro.sales_activities FOR SELECT TO kauro_app
  USING (kauro.current_agency_id() IS NULL AND EXISTS (SELECT 1 FROM kauro.outreach_send_intents i WHERE i.intent_id = sales_activities.intent_id AND i.person_user_id = kauro.current_user_id()));
CREATE POLICY sales_activities_outreach_read ON kauro.sales_activities FOR SELECT TO kauro_outreach USING (true);
-- the service records PROVIDER_ACCEPTED / SEND_UNCERTAIN (D4, D5) and the opt-out's SUPPRESSED (OPT_OUT, contact key)
CREATE POLICY sales_activities_outreach_record ON kauro.sales_activities FOR INSERT TO kauro_outreach
  WITH CHECK (recorded_by_service = 'outreach-service' AND recorded_by_user_id IS NULL
              AND (kind IN ('PROVIDER_ACCEPTED', 'SEND_UNCERTAIN') OR (kind = 'SUPPRESSED' AND suppression_reason = 'OPT_OUT' AND suppression_key_kind = 'CONTACT')));
GRANT SELECT, INSERT ON kauro.sales_activities TO kauro_app, kauro_outreach;

ALTER TABLE kauro.outreach_provider_warnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.outreach_provider_warnings FORCE ROW LEVEL SECURITY;
CREATE POLICY outreach_provider_warnings_owner_read ON kauro.outreach_provider_warnings FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY outreach_provider_warnings_person_read ON kauro.outreach_provider_warnings FOR SELECT TO kauro_app USING (kauro.current_agency_id() IS NULL AND person_user_id = kauro.current_user_id());
CREATE POLICY outreach_provider_warnings_outreach ON kauro.outreach_provider_warnings FOR SELECT TO kauro_outreach USING (true);
CREATE POLICY outreach_provider_warnings_outreach_record ON kauro.outreach_provider_warnings FOR INSERT TO kauro_outreach WITH CHECK (recorded_by_service = 'outreach-service');
GRANT SELECT ON kauro.outreach_provider_warnings TO kauro_app;
GRANT SELECT, INSERT ON kauro.outreach_provider_warnings TO kauro_outreach;

ALTER TABLE kauro.outreach_send_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.outreach_send_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY outreach_send_evidence_owner_read ON kauro.outreach_send_evidence FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY outreach_send_evidence_person_read ON kauro.outreach_send_evidence FOR SELECT TO kauro_app
  USING (kauro.current_agency_id() IS NULL AND EXISTS (SELECT 1 FROM kauro.outreach_send_intents i WHERE i.intent_id = outreach_send_evidence.intent_id AND i.person_user_id = kauro.current_user_id()));
CREATE POLICY outreach_send_evidence_prospect_read ON kauro.outreach_send_evidence FOR SELECT TO kauro_app
  USING (kauro.current_agency_id() IS NULL AND EXISTS (SELECT 1 FROM kauro.outreach_send_intents i WHERE i.intent_id = outreach_send_evidence.intent_id));
CREATE POLICY outreach_send_evidence_outreach ON kauro.outreach_send_evidence FOR SELECT TO kauro_outreach USING (true);
CREATE POLICY outreach_send_evidence_outreach_record ON kauro.outreach_send_evidence FOR INSERT TO kauro_outreach WITH CHECK (recorded_by_service = 'outreach-service');
GRANT SELECT ON kauro.outreach_send_evidence TO kauro_app;
GRANT SELECT, INSERT ON kauro.outreach_send_evidence TO kauro_outreach;

ALTER TABLE kauro.outreach_diagnoses ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.outreach_diagnoses FORCE ROW LEVEL SECURITY;
CREATE POLICY outreach_diagnoses_owner ON kauro.outreach_diagnoses FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY outreach_diagnoses_person_read ON kauro.outreach_diagnoses FOR SELECT TO kauro_app USING (kauro.current_agency_id() IS NULL AND person_user_id = kauro.current_user_id());
CREATE POLICY outreach_diagnoses_record ON kauro.outreach_diagnoses FOR INSERT TO kauro_app WITH CHECK (kauro.acting_corporate_owner() AND owner_user_id = kauro.current_user_id());
CREATE POLICY outreach_diagnoses_outreach ON kauro.outreach_diagnoses FOR SELECT TO kauro_outreach USING (true);
GRANT SELECT, INSERT ON kauro.outreach_diagnoses TO kauro_app;
GRANT SELECT ON kauro.outreach_diagnoses TO kauro_outreach;

-- the corporate rows the outreach service reads (its triggers and D2's rechecks): no agency_id table among them (A17)
CREATE POLICY prospects_outreach_read ON kauro.prospects FOR SELECT TO kauro_outreach USING (true);
-- the public opt-out: a prospect reached by its suppression moves to SUPPRESSED only (KA098 judges the columns and the reach)
CREATE POLICY prospects_outreach_suppress ON kauro.prospects FOR UPDATE TO kauro_outreach USING (state <> 'SUPPRESSED') WITH CHECK (state = 'SUPPRESSED');
GRANT SELECT ON kauro.prospects TO kauro_outreach;
GRANT UPDATE (state, suppressed, version, updated_at) ON kauro.prospects TO kauro_outreach;
CREATE POLICY prospect_contacts_outreach_read ON kauro.prospect_contacts FOR SELECT TO kauro_outreach USING (true);
GRANT SELECT ON kauro.prospect_contacts TO kauro_outreach;
CREATE POLICY prospect_suppressions_outreach_read ON kauro.prospect_suppressions FOR SELECT TO kauro_outreach USING (true);
CREATE POLICY prospect_suppressions_outreach_record ON kauro.prospect_suppressions FOR INSERT TO kauro_outreach
  WITH CHECK (recorded_by_service = 'outreach-service' AND recorded_by_user_id IS NULL AND key_kind = 'CONTACT' AND reason = 'OPT_OUT');
GRANT SELECT, INSERT ON kauro.prospect_suppressions TO kauro_outreach;
CREATE POLICY sellers_outreach_read ON kauro.sellers FOR SELECT TO kauro_outreach USING (true);
GRANT SELECT (seller_id, user_id, state) ON kauro.sellers TO kauro_outreach;
CREATE POLICY assurance_proofs_outreach_none ON kauro.assurance_proofs FOR SELECT TO kauro_outreach USING (false);

-- 0060 (P2): the new trigger functions are not EXECUTE-able by PUBLIC
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'kauro' AND p.prorettype = 'trigger'::regtype
  LOOP
    EXECUTE pg_catalog.format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', r.sig);
  END LOOP;
END
$$;
