-- 0001 — schema, runtime roles, tenant-context helpers and the shared trigger functions.
--
-- Authority: 07 "Database representation" (runtime roles are neither database owners nor superusers and do not have
-- BYPASSRLS; aggregate versions and event sequence numbers establish concurrency order; UUIDv7 server-generated ids),
-- 08 "Database isolation" (tenant context is set transaction-locally and cleared on pool return; a request without valid
-- context fails closed; privileged migration roles are never used by request handlers; SECURITY DEFINER requires specific
-- justification — none is used here), 07 "Transaction discipline" (a successful command commits state, domain event and
-- outbox record atomically).
--
-- Roles (cluster-wide, created once, verified on every run):
--   kauro_app        request handlers (api). Tenant policies keyed on kauro.agency_id / kauro.user_id.
--   kauro_control    control plane (outbox dispatch, sweeper, capability publication). Operational tables and safe
--                    technical metadata only (08 "Role and capability model": the Technical Operator inspects safe
--                    technical metadata; no tenant business data).
--   kauro_assurance  the step-up verifier (08 "Authentication and assurance": authentication produces the assurance facts;
--                    a service account has only its technical role). It records step-up proofs and nothing else; the
--                    request handlers read the proofs but can never mint one.
--   kauro_validator  the independent Migration validator (registry ValidationReceipt: producer "MC validator", "independently
--                    checked"; 06 "Migration validation and final states"). It records validation receipts and nothing
--                    else; the request handlers read receipts but can never mint one.
--   kauro_ingress    the provider-webhook ingress (COMMAND_CATALOGUE CMD030: authorized role AUTHENTICATED_PROVIDER, "Ingress
--                    authenticates provider-specific signature, freshness, environment and bounded raw body before event
--                    acceptance"; 10 "separate ingress/authentication policy from browser APIs"; 08 trust boundary "provider
--                    webhook to inbox"). It records authenticated provider event references in the inbox and nothing else;
--                    the request handlers of agency users cannot write the inbox at all (re-check finding N2, 0005).
-- Login roles are provisioning concerns: CREATE ROLE kauro_api LOGIN IN ROLE kauro_app; they inherit the group grants. A
-- login is a member of exactly one of these groups (the verified pool refuses any other arrangement).
-- The migrator (table owner) is a separate role that never serves requests; FORCE ROW LEVEL SECURITY binds it as well.
--
-- SQLSTATE vocabulary raised by this schema (adapters map them to the failure taxonomy of @kauro/domain):
--   KA001 LAST_OWNER_PROTECTED   KA002 VERSION_DISCIPLINE   KA003 EVENT_MISSING   KA004 IMMUTABLE_COLUMN
--   KA005 LEASE guard (fence / deadline / subject / checkpoint)   KA006 CONTEXT (row not visible inside a trigger)
--   KA007 JOURNAL terminal state   KA008 UNLISTED_TRANSITION (an unlisted edge, or an aggregate born outside its machine's
--   initial state)   KA009 UPSTREAM_UNRESOLVED (request journal, S089)   KA010 MEMBERSHIP_AUTHORITY (a membership or
--   invitation write the acting session has no team authority for, 0002)   KA011 INVITATION_NOT_OPEN (an invitation consumed,
--   revoked or expired, or an acceptance without a consumed invitation, 0002)   KA012 INBOX_BODY_CONFLICT (an inbox record
--   settled while a delivery of the same event carried another body, 0005)   KA020 LIVE_APPROVAL_UNBOUND (a live approval on
--   a plan that is not APPROVED under it, or an APPROVED plan whose approval is not live, 0004)

CREATE SCHEMA IF NOT EXISTS kauro;
REVOKE ALL ON SCHEMA kauro FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kauro_app') THEN
    CREATE ROLE kauro_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kauro_control') THEN
    CREATE ROLE kauro_control NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kauro_assurance') THEN
    CREATE ROLE kauro_assurance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kauro_validator') THEN
    CREATE ROLE kauro_validator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kauro_ingress') THEN
    CREATE ROLE kauro_ingress NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname IN ('kauro_app', 'kauro_control', 'kauro_assurance', 'kauro_validator', 'kauro_ingress')
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)
  ) THEN
    RAISE EXCEPTION 'runtime roles must not be SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION (08 Database isolation)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'migrations must run as the owner role, not as a superuser or BYPASSRLS role (07 Restoration and migration)';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA kauro TO kauro_app, kauro_control, kauro_assurance, kauro_validator, kauro_ingress;

-- Readiness (14 "Monitoring and service health": readiness checks the schema compatibility the service's role needs): the
-- runtime roles read the ledger the migration runner keeps (kauro_meta.schema_migrations, created by the runner before this
-- file) and nothing else of kauro_meta; they never write it.
GRANT USAGE ON SCHEMA kauro_meta TO kauro_app, kauro_control;
GRANT SELECT ON kauro_meta.schema_migrations TO kauro_app, kauro_control;

-- Tenant context: SET LOCAL kauro.agency_id / kauro.user_id (set_config(..., true)) inside the transaction. Missing or empty
-- settings yield NULL, and every policy compares against NULL as false: no context, no rows (fail closed). An unparsable
-- value raises instead of matching anything.
CREATE OR REPLACE FUNCTION kauro.current_agency_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$ SELECT NULLIF(current_setting('kauro.agency_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION kauro.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$ SELECT NULLIF(current_setting('kauro.user_id', true), '')::uuid $$;

-- Identity scheme checks (07: UUIDv7 aggregate ids; @kauro/domain identityUserId: UUIDv5 identity references).
CREATE OR REPLACE FUNCTION kauro.is_uuid_v7(id uuid) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b') $$;

CREATE OR REPLACE FUNCTION kauro.is_uuid_v5(id uuid) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT substr(id::text, 15, 1) = '5' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b') $$;

-- Field vocabulary (reference/FIELD_CONTRACTS.md "Common rules"): lowercase SHA-256, label of 1..200 characters without
-- control characters, uppercase machine tokens.
CREATE OR REPLACE FUNCTION kauro.is_sha256_hex(v text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT v ~ '^[0-9a-f]{64}$' $$;

-- A control character is a code point of Unicode General Category Cc: U+0000..U+001F (C0), U+007F (DEL) and U+0080..U+009F
-- (C1). The classes are spelled as code point ranges, not as [[:cntrl:]], whose meaning for non-ASCII characters depends on the
-- cluster's locale provider: the request schema (@kauro/application LABEL), the domain (isLabel) and this check refuse exactly
-- the same characters on every cluster (re-check finding N6). U+0000 cannot occur in a text value.
CREATE OR REPLACE FUNCTION kauro.is_label(v text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT length(v) BETWEEN 1 AND 200 AND v !~ '[\u0001-\u001f\u007f-\u009f]' $$;

CREATE OR REPLACE FUNCTION kauro.is_token(v text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT v ~ '^[A-Z][A-Z0-9_]{2,63}$' $$;

-- updated_at bookkeeping (transaction time; business instants come from the application clock).
CREATE OR REPLACE FUNCTION kauro.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- Version discipline (07: aggregate versions establish concurrency order). An UPDATE either bumps version by exactly one or
-- changes nothing but the columns named in TG_ARGV[0] (comma separated) and updated_at.
CREATE OR REPLACE FUNCTION kauro.enforce_version_bump() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  exempt text[] := ARRAY['updated_at'] || string_to_array(coalesce(TG_ARGV[0], ''), ',');
  old_j jsonb := to_jsonb(OLD) - exempt;
  new_j jsonb := to_jsonb(NEW) - exempt;
BEGIN
  IF NEW.version = OLD.version THEN
    IF new_j <> old_j THEN
      RAISE EXCEPTION 'VERSION_DISCIPLINE: % % changed without a version bump', TG_TABLE_NAME, OLD.version USING ERRCODE = 'KA002';
    END IF;
  ELSIF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'VERSION_DISCIPLINE: % version % -> % is not a single bump', TG_TABLE_NAME, OLD.version, NEW.version USING ERRCODE = 'KA002';
  END IF;
  RETURN NEW;
END
$$;

-- Event-per-version (07 "Transaction discipline"): deferred to commit, a new aggregate version without its domain event
-- cannot commit. TG_ARGV[0] is the aggregate kind; the id column is TG_ARGV[1]. The event must carry the aggregate's own
-- agency scope (08 "Database isolation": uniqueness and identity include scope) — an event of another tenant naming the same
-- aggregate id and version never satisfies this rule.
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
    WHERE e.agency_id = agg_agency AND e.aggregate_kind = TG_ARGV[0] AND e.aggregate_id = agg_id AND e.aggregate_version = agg_version
  ) THEN
    RAISE EXCEPTION 'EVENT_MISSING: % % version % has no domain event in this transaction', TG_ARGV[0], agg_id, agg_version USING ERRCODE = 'KA003';
  END IF;
  RETURN NULL;
END
$$;

-- Append-only tables (domain events, validation receipts, security events).
CREATE OR REPLACE FUNCTION kauro.forbid_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_COLUMN: % is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'KA004';
END
$$;

-- Immutable columns: TG_ARGV[0] is a comma separated list of columns that may never change after insert.
CREATE OR REPLACE FUNCTION kauro.forbid_column_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  col text;
  old_j jsonb := to_jsonb(OLD);
  new_j jsonb := to_jsonb(NEW);
BEGIN
  FOREACH col IN ARRAY string_to_array(TG_ARGV[0], ',') LOOP
    IF (old_j -> col) IS DISTINCT FROM (new_j -> col) THEN
      RAISE EXCEPTION 'IMMUTABLE_COLUMN: %.% cannot change after insert', TG_TABLE_NAME, col USING ERRCODE = 'KA004';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

-- State machines and their listed transitions (reference/TRANSITIONS_AND_EVENT_EFFECTS.md: every machine names its initial
-- state; an unlisted edge is rejected rather than inferred; registry state_transitions: unlistedTransition =
-- REJECT_UNLESS_A_NEW_VERSIONED_CONTRACT_IS_ACCEPTED). Both tables are seeded per aggregate from the registry (EndClient and
-- Project from the platform machines of decisions D-AGG-1/D-AGG-2) in the migration that creates the aggregate's table; the
-- persistence tests compare both seeds with the registry. kauro.enforce_initial_state refuses an aggregate born in any other
-- state than its machine's initial one (an INSERT is the edge "from nothing"; skipping the listed edges by inserting a row in a
-- later state is the same unlisted transition), and kauro.enforce_listed_transition refuses any unlisted state change.
CREATE TABLE kauro.state_machines (
  machine text PRIMARY KEY,
  initial_state text NOT NULL
);
GRANT SELECT ON kauro.state_machines TO kauro_app, kauro_control;

CREATE TABLE kauro.state_transitions (
  machine text NOT NULL REFERENCES kauro.state_machines (machine),
  from_state text NOT NULL,
  to_state text NOT NULL,
  PRIMARY KEY (machine, from_state, to_state)
);
GRANT SELECT ON kauro.state_transitions TO kauro_app, kauro_control;

CREATE OR REPLACE FUNCTION kauro.enforce_initial_state() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  initial text;
BEGIN
  SELECT m.initial_state INTO initial FROM kauro.state_machines m WHERE m.machine = TG_ARGV[0];
  IF initial IS NULL THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: machine % has no seeded initial state', TG_ARGV[0] USING ERRCODE = 'KA008';
  END IF;
  IF NEW.state IS DISTINCT FROM initial THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: a % is born %; its initial state is % and later states are reached by the listed edges', TG_ARGV[0], NEW.state, initial USING ERRCODE = 'KA008';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION kauro.enforce_listed_transition() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT EXISTS (
    SELECT 1 FROM kauro.state_transitions t WHERE t.machine = TG_ARGV[0] AND t.from_state = OLD.state AND t.to_state = NEW.state
  ) THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: % % -> % is not a listed edge', TG_ARGV[0], OLD.state, NEW.state USING ERRCODE = 'KA008';
  END IF;
  RETURN NEW;
END
$$;

-- --- the transition-lock protocol (decision D-TX-2; re-check findings N1, N3) -----------------------------------------------------
-- A command relies on facts it does not change: the caller's identity status and membership, the agency's state, the offered
-- capability of a mode, the sealed source revision and the current target contract (07 "Transaction discipline":
-- preconditions are rechecked inside the transaction; 10 "Concurrency and preconditions"). Each such fact is a SUBJECT
-- (a kind and a key). A reader calls kauro.await_transition(kind, key) and only then reads the row in the next statement: the
-- call takes a shared transaction-level advisory lock on the subject, held to COMMIT. A writer that changes the fact takes the
-- exclusive lock on the same subject in a BEFORE UPDATE trigger (kauro.take_transition_lock) before its change is applied, so
--   * a transition issued while a command is in flight waits for that command (the command is ordered before it);
--   * a transition committed first is what the command's next statement reads (READ COMMITTED: a new snapshot per statement);
--   * a reader arriving after a transition was queued waits behind it: PostgreSQL's lock manager queues a new shared request
--     behind a waiting exclusive one, which a row-level FOR SHARE does not do — a share lock is granted beside the current
--     share lockers even while an UPDATE is waiting, so a stream of overlapping commands could starve a suspension, a
--     restriction or a revocation indefinitely (N3). The readers therefore take no row lock on these rows at all.
-- The key is a 64-bit digest of the namespaced subject; two subjects that collide only wait for each other, which is never
-- incorrect. Lock order, which every command and every writer follows: identity → membership → agency → client → capability;
-- plan → source revision → target contract.
CREATE OR REPLACE FUNCTION kauro.transition_key(kind text, subject text) RETURNS bigint
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT hashtextextended('kauro.transition:' || kind || ':' || subject, 0) $$;

CREATE OR REPLACE FUNCTION kauro.await_transition(kind text, subject text) RETURNS void
  LANGUAGE sql VOLATILE STRICT SET search_path = pg_catalog AS
$$ SELECT pg_advisory_xact_lock_shared(kauro.transition_key(kind, subject)) $$;

-- The writer's half: TG_ARGV[0] is the subject kind, TG_ARGV[1..] the columns whose values (of the row before the change)
-- form the subject key, joined by ':'. Installed as BEFORE UPDATE OF <the guarded columns> ... WHEN (<they change>).
CREATE OR REPLACE FUNCTION kauro.take_transition_lock() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  old_j jsonb := to_jsonb(OLD);
  subject text := '';
  i integer;
BEGIN
  FOR i IN 1 .. TG_NARGS - 1 LOOP
    IF (old_j ->> TG_ARGV[i]) IS NULL THEN
      RAISE EXCEPTION 'CONTEXT: % has no value for transition subject column %', TG_TABLE_NAME, TG_ARGV[i] USING ERRCODE = 'KA006';
    END IF;
    subject := subject || CASE WHEN i > 1 THEN ':' ELSE '' END || (old_j ->> TG_ARGV[i]);
  END LOOP;
  PERFORM pg_advisory_xact_lock(kauro.transition_key(TG_ARGV[0], subject));
  RETURN NEW;
END
$$;

GRANT EXECUTE ON FUNCTION kauro.await_transition(text, text) TO kauro_app;
