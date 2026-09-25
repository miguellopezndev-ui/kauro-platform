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
-- Login roles are provisioning concerns: CREATE ROLE kauro_api LOGIN IN ROLE kauro_app; they inherit the group grants. A
-- login is a member of exactly one of these groups (the verified pool refuses any other arrangement).
-- The migrator (table owner) is a separate role that never serves requests; FORCE ROW LEVEL SECURITY binds it as well.
--
-- SQLSTATE vocabulary raised by this schema (adapters map them to the failure taxonomy of @kauro/domain):
--   KA001 LAST_OWNER_PROTECTED   KA002 VERSION_DISCIPLINE   KA003 EVENT_MISSING   KA004 IMMUTABLE_COLUMN
--   KA005 LEASE guard (fence / deadline / subject / checkpoint)   KA006 CONTEXT (row not visible inside a trigger)
--   KA007 JOURNAL terminal state   KA008 UNLISTED_TRANSITION (an unlisted edge, or an aggregate born outside its machine's
--   initial state)

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
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname IN ('kauro_app', 'kauro_control', 'kauro_assurance', 'kauro_validator')
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)
  ) THEN
    RAISE EXCEPTION 'runtime roles must not be SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION (08 Database isolation)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'migrations must run as the owner role, not as a superuser or BYPASSRLS role (07 Restoration and migration)';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA kauro TO kauro_app, kauro_control, kauro_assurance, kauro_validator;

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

CREATE OR REPLACE FUNCTION kauro.is_label(v text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT length(v) BETWEEN 1 AND 200 AND v !~ '[[:cntrl:]]' $$;

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
