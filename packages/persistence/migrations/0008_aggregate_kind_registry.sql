-- 0008 — the shared aggregate-kind registry (foundation of every package after B06; docs/design/FOUNDATION-aggregate-kinds.md,
-- decisions D-AGGK-1..D-AGGK-5).
--
-- B06 fixed kauro.domain_events.aggregate_kind with a CHECK list and bound every event to its aggregate with one CASE arm per
-- kind (0005). Every later package adds aggregates; two packages rewriting that list and that function independently (B07, B09)
-- lose each other's kinds. The kinds become rows of a migration-owned table: a registered kind names the table and the uuid
-- primary-key column of its aggregate, the event table refers to it by a foreign key, and kauro.domain_events_bind_aggregate
-- reads the registered table instead of a CASE. A later package registers its kinds with one INSERT in its own migration and
-- never edits this file, the foreign key or the function.
--
-- Authority: 07 "Outbox, inbox and event ordering" (DomainEvent contains event ID, aggregate ID and version, agency scope);
-- 07 "Database representation" (composite foreign keys or equivalent enforced constraints; aggregate versions establish
-- concurrency order); 07 "Aggregate ownership" (stable identities, explicit invariants; responsibilities do not require one table
-- per noun); 08 "Database isolation" (foreign keys bind tenant and parent identity; SECURITY DEFINER requires a specific
-- justification and a fixed search_path — none is used; "Dynamic SQL based on customer input is prohibited": the identifiers
-- come from this migration-owned table only); 07 "Restoration and migration" (migration roles are separate from runtime).
-- Decisions: D-EVT-2 and review R3 of B06 (an event names an aggregate of its own agency, visible to its writer, at or below
-- that aggregate's version; an unknown and a foreign aggregate look alike, KA006), kept exactly.

-- --- the registry ------------------------------------------------------------------------------------------------------------------
-- One row per aggregate kind. The kind, the table and the column are lower snake case identifiers; one kind per table (a row of a
-- table is one aggregate, so two kinds over one table would give the same row two event streams). owner_package names the build
-- package that registered the kind (22 "Dependency graph": B00..B21).
CREATE TABLE kauro.aggregate_kinds (
  aggregate_kind  text PRIMARY KEY
                  CONSTRAINT aggregate_kinds_kind_lower_snake CHECK (aggregate_kind ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' AND length(aggregate_kind) <= 63),
  table_name      text NOT NULL
                  CONSTRAINT aggregate_kinds_table_lower_snake CHECK (table_name ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' AND length(table_name) <= 63),
  id_column       text NOT NULL
                  CONSTRAINT aggregate_kinds_id_column_lower_snake CHECK (id_column ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' AND length(id_column) <= 63),
  owner_package   text NOT NULL
                  CONSTRAINT aggregate_kinds_owner_package_shape CHECK (owner_package ~ '^B[0-9]{2}$'),
  CONSTRAINT aggregate_kinds_one_kind_per_table UNIQUE (table_name)
);

-- A registered row must be bindable (D-AGGK-2), checked against the catalog when it is inserted: table_name is an ordinary (or
-- partitioned) table of schema kauro; its primary key is exactly one column, id_column, of type uuid; and it carries the two
-- columns the binding reads, agency_id (uuid) and version (bigint). A row that names anything else — a table that does not exist,
-- a column that is not the key, a composite or non-uuid key, a table without agency scope or version, an object outside kauro —
-- is refused (23514), so no event insert can ever meet a registry row that the binding cannot evaluate. Reading pg_catalog needs
-- no privilege; the function is SECURITY INVOKER with a pinned search_path like every function of this schema.
CREATE OR REPLACE FUNCTION kauro.aggregate_kinds_bind_catalog() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  rel oid;
  key_column name;
  key_type regtype;
BEGIN
  SELECT c.oid INTO rel
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'kauro' AND c.relname = NEW.table_name AND c.relkind IN ('r', 'p');
  IF rel IS NULL THEN
    RAISE EXCEPTION 'AGGREGATE_KIND_BINDING: kind % names %, which is not a table of schema kauro', NEW.aggregate_kind, NEW.table_name
      USING ERRCODE = 'check_violation', CONSTRAINT = 'aggregate_kinds_bind_catalog', SCHEMA = 'kauro', TABLE = 'aggregate_kinds';
  END IF;
  SELECT a.attname, a.atttypid::pg_catalog.regtype INTO key_column, key_type
    FROM pg_catalog.pg_constraint k
    JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
   WHERE k.conrelid = rel AND k.contype = 'p' AND pg_catalog.cardinality(k.conkey) = 1;
  IF key_column IS DISTINCT FROM NEW.id_column::name OR key_type IS DISTINCT FROM 'pg_catalog.uuid'::pg_catalog.regtype THEN
    RAISE EXCEPTION 'AGGREGATE_KIND_BINDING: kind % names %.%, which is not the single uuid primary-key column of that table', NEW.aggregate_kind, NEW.table_name, NEW.id_column
      USING ERRCODE = 'check_violation', CONSTRAINT = 'aggregate_kinds_bind_catalog', SCHEMA = 'kauro', TABLE = 'aggregate_kinds';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = rel AND a.attname = 'agency_id' AND a.attnum > 0 AND NOT a.attisdropped
       AND a.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = rel AND a.attname = 'version' AND a.attnum > 0 AND NOT a.attisdropped
       AND a.atttypid = 'pg_catalog.int8'::pg_catalog.regtype
  ) THEN
    RAISE EXCEPTION 'AGGREGATE_KIND_BINDING: kind % names %, which lacks the agency_id uuid or version bigint column the event binding reads', NEW.aggregate_kind, NEW.table_name
      USING ERRCODE = 'check_violation', CONSTRAINT = 'aggregate_kinds_bind_catalog', SCHEMA = 'kauro', TABLE = 'aggregate_kinds';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER aggregate_kinds_bind_catalog BEFORE INSERT ON kauro.aggregate_kinds
  FOR EACH ROW EXECUTE FUNCTION kauro.aggregate_kinds_bind_catalog();

-- A kind is an identity recorded events refer to: re-pointing it at another table would reinterpret history, removing it would
-- orphan events (the foreign key below refuses that too). Append-only, TRUNCATE included (KA004).
CREATE TRIGGER aggregate_kinds_append_only BEFORE UPDATE OR DELETE ON kauro.aggregate_kinds
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER aggregate_kinds_no_truncate BEFORE TRUNCATE ON kauro.aggregate_kinds
  FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

-- --- who reads and who writes it (D-AGGK-3) ------------------------------------------------------------------------------------------
-- Row security is enabled and forced like on every kauro table. Only the migration owner writes the registry, and only by
-- INSERT: the one write policy names the role that runs the migrations (CURRENT_USER here is the migrator, which owns every
-- object of the schema; a runtime role never runs a migration, 07 "Restoration and migration"), so a later package registers
-- its kinds with one INSERT, and there is no UPDATE or DELETE policy for anybody. It is the migrator's only DML policy (B06
-- D-RLS-1 gives it none): on migration-owned reference data, INSERT only, never on a tenant row. No runtime role holds INSERT,
-- UPDATE, DELETE or TRUNCATE on the table. The binding below is SECURITY INVOKER, so the writer of an event reads the registry
-- as itself: SELECT goes to exactly the runtime groups that insert domain events on main today — the request handlers,
-- kauro_app (the control plane reads events and appends none, B06 review R3). A later package that lets one of its groups
-- insert events grants that group SELECT and a read policy of its own in the same migration.
ALTER TABLE kauro.aggregate_kinds ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.aggregate_kinds FORCE ROW LEVEL SECURITY;
CREATE POLICY aggregate_kinds_register ON kauro.aggregate_kinds FOR INSERT TO CURRENT_USER WITH CHECK (true);
CREATE POLICY aggregate_kinds_read ON kauro.aggregate_kinds FOR SELECT TO kauro_app USING (true);
GRANT SELECT ON kauro.aggregate_kinds TO kauro_app;

-- --- B06's seven kinds ---------------------------------------------------------------------------------------------------------------
-- Exactly the kinds, tables and id columns of B06's CHECK list, CASE arms and event-per-version triggers (0005); the domain mirrors
-- the kinds as AGGREGATE_KINDS and the persistence tests prove all three agree.
INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES
  ('agency', 'agencies', 'agency_id', 'B06'),
  ('membership', 'memberships', 'membership_id', 'B06'),
  ('end_client', 'end_clients', 'client_id', 'B06'),
  ('project', 'projects', 'project_id', 'B06'),
  ('dataset_revision', 'dataset_revisions', 'revision_id', 'B06'),
  ('plan', 'plans', 'plan_id', 'B06'),
  ('approval', 'approvals', 'approval_id', 'B06');

-- --- the CHECK becomes a foreign key (D-AGGK-1) ----------------------------------------------------------------------------------------
-- The binding trigger below fires before the row's constraints and still answers an unregistered kind with KA006, exactly as the
-- CASE's ELSE arm did; the foreign key is the declarative guarantee under it (it holds even for a writer whose trigger is not in
-- the way) and it keeps a kind from disappearing while events name it.
ALTER TABLE kauro.domain_events DROP CONSTRAINT domain_events_aggregate_kind_check;
ALTER TABLE kauro.domain_events ADD CONSTRAINT domain_events_aggregate_kind_fkey
  FOREIGN KEY (aggregate_kind) REFERENCES kauro.aggregate_kinds (aggregate_kind);

-- --- the table-driven binding (D-AGGK-4) --------------------------------------------------------------------------------------------
-- Same rule, same SQLSTATEs, same messages as 0005: the named aggregate must exist in the event's agency and be visible to the
-- writer, and it must already carry the version the event records. An unregistered kind, an unknown id, another agency's
-- aggregate, an aggregate the writer's policies hide and an event without agency all look alike (KA006); an event ahead of its
-- aggregate is KA002.
--   * The table and the column come from the registry row only, never from the event, and are quoted with %I (08: no dynamic SQL
--     based on customer input); the event's values are bound parameters ($1, $2), never text in the statement.
--   * SECURITY INVOKER: the lookup runs as the writer, so the writer's row-level security still decides what is visible — a
--     definer would see every tenant and turn KA006 into an existence oracle.
--   * search_path is pinned to pg_catalog, then pg_temp last; every relation is schema-qualified, so neither a temporary table nor
--     a schema a session puts first can stand in for the registry or for an aggregate table.
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
  EXECUTE pg_catalog.format('SELECT a.version FROM kauro.%I a WHERE a.%I = $1 AND a.agency_id = $2', binding.table_name, binding.id_column)
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
