# Foundation — the shared aggregate-kind registry

Branch `foundation/aggregate-kinds`, from `main` at `02c0bd2` (B05 + the final B06). One migration,
`packages/persistence/migrations/0008_aggregate_kind_registry.sql`, shared by every package after B06. It extends B06 and forks
nothing: the unit of work, the runtime roles, the pipeline, the event publisher, the event-per-version rule and the error contract
are unchanged.

## 1. Why

B06 closed `kauro.domain_events.aggregate_kind` with a CHECK list of its seven kinds and bound every event to its aggregate with
one CASE arm per kind in `kauro.domain_events_bind_aggregate` (0005; D-EVT-2, review R3). Every later package adds aggregates. The
two packages designed in parallel on B06 (22 "Dependency graph": B07 and B09 both close on B06 alone) each replaced that CHECK
with a registry table `kauro.aggregate_kinds`, in shapes that cannot both merge:

| design | registry shape | binding |
|---|---|---|
| `b07/design` 0008 (D-MIG-1) | `aggregate_kind` only | B06's CASE rewritten with two more arms |
| `b09/design` 0008 (D-EVT-B1) | `aggregate_kind`, `table_name`, `id_column` | table-driven dynamic SQL |

The critic of B07 (finding B07-F7) and the B09 open question Q-B09-13 both ask for one table-driven shape before implementation.
This branch is that shape, owned by neither package, so that each registers its kinds and nobody rewrites anybody else's list or
function (22 "Common execution obligations": correct defects in the owning component and validate affected consumers; do not hide
an upstream defect in a downstream adapter).

## 2. Shape

```
kauro.aggregate_kinds
  aggregate_kind  text PK      lower snake case, ≤ 63            (aggregate_kinds_kind_lower_snake)
  table_name      text NOT NULL lower snake case, one kind per table (aggregate_kinds_one_kind_per_table)
  id_column       text NOT NULL lower snake case
  owner_package   text NOT NULL B + two digits                  (aggregate_kinds_owner_package_shape)
  BEFORE INSERT  aggregate_kinds_bind_catalog: kauro table, single uuid PK = id_column, agency_id uuid, version bigint (23514)
  append-only    UPDATE / DELETE / TRUNCATE refused (KA004; TRUNCATE also by the foreign key from the events)
  RLS forced     aggregate_kinds_register  INSERT TO <the migrator>      WITH CHECK (true)
                 aggregate_kinds_read      SELECT TO kauro_app            USING (true)
  grants         SELECT to kauro_app; nothing else to any runtime role

kauro.domain_events.aggregate_kind  → FOREIGN KEY domain_events_aggregate_kind_fkey → kauro.aggregate_kinds (was the CHECK)
kauro.domain_events_bind_aggregate  → reads the registered table (was the CASE)
```

Seed (owner `B06`): `agency`/`agencies`/`agency_id`, `membership`/`memberships`/`membership_id`, `end_client`/`end_clients`/`client_id`,
`project`/`projects`/`project_id`, `dataset_revision`/`dataset_revisions`/`revision_id`, `plan`/`plans`/`plan_id`,
`approval`/`approvals`/`approval_id` — exactly B06's CHECK list, CASE arms and `require_event_for_version` arguments.

The binding keeps B06's rule, SQLSTATEs and messages: the named aggregate exists in the event's agency, is visible to the writer
and already carries the version the event records. An unregistered kind, an unknown id, another agency's aggregate, an aggregate
the writer's policies hide, an event without agency and a writer without context are all KA006 (`NOT_FOUND /
TENANT_CONTEXT_MISSING`); an event ahead of its aggregate is KA002 (`INTEGRITY_FAILURE / VERSION_DISCIPLINE`). The BEFORE
trigger runs before the row's constraints, so an unregistered kind is still answered KA006 by the binding, as B06's ELSE arm did;
the foreign key is the declarative guarantee under it.

## 3. Decisions

| id | decision | why (authority) |
|---|---|---|
| D-AGGK-1 | Aggregate kinds are rows of the migration-owned `kauro.aggregate_kinds`; `domain_events.aggregate_kind` references it by a foreign key instead of B06's CHECK; `kauro.domain_events_bind_aggregate` reads the registered table and column instead of a CASE arm per kind. A package registers its kinds and never edits 0008, the foreign key or the function. `@kauro/domain` `AGGREGATE_KINDS` mirrors the rows (tested equal). | 07 "Outbox, inbox and event ordering" (DomainEvent contains aggregate ID and version and agency scope); 08 "Database isolation" (foreign keys bind tenant and parent identity); 07 "Aggregate ownership" (stable identities; one table per noun is not required); B06 D-EVT-2; B07-F7, Q-B09-13. |
| D-AGGK-2 | A row must be bindable, checked against the catalog at insert (`aggregate_kinds_bind_catalog`, 23514): `table_name` is a table of schema `kauro`; its primary key is exactly `id_column`, of type uuid; the table carries `agency_id uuid` and `version bigint` (the binding reads both). One kind per table; kind, table and column are lower snake case; `owner_package` is a build package id. The registry is append-only: a recorded event refers to its kind, so re-pointing or removing a kind would reinterpret or orphan history. | 07 "Database representation" (tenant-owned rows carry agency_id; UUIDv7 ids; aggregate versions establish concurrency order); B06 D-ID-1, D-VER-1; the authority is silent on a registry of kinds — decided here, open question Q-AGGK-1 for agency-less aggregates. |
| D-AGGK-3 | Only the migration owner writes the registry, only by INSERT: row security is forced, the one write policy is `FOR INSERT TO CURRENT_USER` evaluated when 0008 runs (the migrator, which owns every object of the schema), and no role has an UPDATE or DELETE policy. No runtime role holds INSERT, UPDATE, DELETE or TRUNCATE. SELECT (grant and read policy) goes to exactly the runtime groups that insert domain events on main: `kauro_app` (the control plane reads events and appends none, B06 R3). A later package whose role appends events grants that role SELECT and creates a read policy of its own for it (never by altering `aggregate_kinds_read`, which another package may also extend). | 07 "Restoration and migration" (migration roles are separate from runtime); 08 "Database isolation" (runtime roles are not owners; FORCE ROW LEVEL SECURITY where the ownership arrangement requires it); 14 "Identity matrix" ("API identity accesses the domain database and narrowly required control services"); B06 D-RLS-1. The one policy of the migrator is on reference data, never on a tenant row. |
| D-AGGK-4 | The binding is table-driven dynamic SQL: `format('SELECT a.version FROM kauro.%I a WHERE a.%I = $1 AND a.agency_id = $2', table_name, id_column)` with identifiers only from the registry row (never from the event) and the event's values as bound parameters; `SECURITY INVOKER`, so the writer's row security decides what is visible (a definer would see every tenant or, as the owner under forced row security, none); `SET search_path = pg_catalog, pg_temp`, every relation schema-qualified, so no temporary table or schema a session puts first can stand in for the registry or an aggregate table. | 08 "Database isolation" ("Dynamic SQL based on customer input is prohibited"; SECURITY DEFINER requires justification and a fixed search_path — none is used); B06 D-EVT-2, R3 (unknown and foreign aggregates look alike). |
| D-AGGK-5 | Migration numbering: B06 owns 0001–0007; 0008 is this foundation. B07 and B09 each number their own migrations from 0009 upward on their own branches and reference only tables that exist on `main` (never each other's); the integrator renumbers the second package to merge. The runner requires contiguous versions from 0001 and records checksums, so renumbering happens before any shared database applies the second package's files. | 07 "Restoration and migration" ("Checksums and applied versions are recorded"); `packages/persistence/src/migrations/runner.ts` (contiguous versions from 0001); 22 "Program decision" ("A package may start independent preparatory work before every closing dependency is accepted when the live mandate explicitly identifies that boundary") and "Dependency graph" (B07 and B09 both close on B06). |

## 4. How a package registers its kinds

In its own migration (numbered from 0009 on its branch), after the table exists, with one statement:

```sql
INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES
  ('upload_session', 'upload_sessions', 'upload_id', 'B07');
```

- The table is a `kauro` table whose primary key is the single uuid `id_column`, with `agency_id uuid` and `version bigint`
  (otherwise the INSERT is refused, 23514 `aggregate_kinds_bind_catalog`). A kind whose table a later migration creates is
  registered by that later migration (B07's `retention_record` in the file that creates `retention_records`).
- Its event-per-version trigger names the same kind and column:
  `require_event_for_version('<kind>', '<id_column>')` (the persistence test compares both directions).
- The same commit adds the kind to `@kauro/domain` `AGGREGATE_KINDS` (the persistence test proves the lists equal).
- A runtime group the package lets append events (e.g. B09's `kauro_payment`, B07's control-plane appends of D-CTRL-2) gets
  `GRANT SELECT ON kauro.aggregate_kinds TO <role>` and `CREATE POLICY aggregate_kinds_read_<package>_<group> ON
  kauro.aggregate_kinds FOR SELECT TO <role> USING (true)` (e.g. `aggregate_kinds_read_b09_payment`) in the same migration that
  grants it INSERT on `kauro.domain_events`, and the runtime-boundary matrix is updated in the same review. The package prefix
  keeps two packages that both let one group append events from creating the same policy name at integration. The catalog
  assertion "registry readers are exactly the event inserters" (`aggregate-kinds.test.ts`, test 4 below) refuses a group that
  reads the registry without inserting events and one that inserts events without reading it; the package extends that test's
  expected list of inserters in the same commit.
- Nothing else: no edit of 0008, of `domain_events_aggregate_kind_fkey`, of `kauro.domain_events_bind_aggregate` or of another
  package's rows or policies.

## 5. Tests (real PostgreSQL 17, `@kauro/persistence/testing`)

`packages/persistence/test/aggregate-kinds.test.ts`:

1. every B06 kind binds — each of the seven aggregates was born and walked under `kauro_app` with one bound event per version,
   and an event at or below the aggregate's version passes the binding (refused only by the one-event-per-version identity);
2. an unregistered kind is refused KA006 by the binding, and with the binding switched off (superuser, rolled back) by the foreign
   key `domain_events_aggregate_kind_fkey` (23503);
3. for every kind: another agency's aggregate, one hidden by the writer's policies, an unknown id, an event without agency and a
   writer without context are KA006; an event ahead is KA002; nothing refused is recorded;
4. every runtime login is refused INSERT, UPDATE, DELETE and TRUNCATE on the registry (42501); only `kauro_app` reads it; the
   catalog holds exactly one runtime grant and the two policies; the owner's UPDATE and DELETE touch no row; a superuser meets
   KA004 (TRUNCATE: the foreign key, 0A000, or with CASCADE the guard);
5. registration refuses a missing table, a non-key column, text, composite and bigint keys, tables without `agency_id` or
   `version` (or with the wrong type), objects outside `kauro`, a sequence, an injection-shaped name, malformed identifiers, a
   duplicate kind and a second kind for one table; the one legitimate shape registers with one INSERT;
6. a kind registered by a simulated later migration (a tenant table, its grants, one INSERT) binds through the unchanged function
   (`pg_get_functiondef` equal before and after): its events bind in their own agency, KA006 across agencies, KA002 ahead;
7. the binding cannot be redirected by a session `search_path`: SECURITY INVOKER with `search_path=pg_catalog, pg_temp`, and
   neither temporary tables nor a schema the session puts first (with a phantom client, a higher version and a phantom kind)
   changes an answer.

`migrations.test.ts` now lists the eight files and proves the registry equals `AGGREGATE_KINDS`, holds B06's seven rows exactly,
agrees with every `require_event_for_version` trigger both ways, and that the CHECK was replaced by the foreign key; the domain
test checks the shape of `AGGREGATE_KINDS`. The existing B06 suites are unchanged except the three assertions that counted seven
migrations (`migrations`, `adapters-unit-of-work`, `apps/api` `composition`), which now read the shipped list. The runtime
boundary changed by exactly three reviewed entries, added by hand to `test/fixtures/runtime-boundary.json`: `kauro_app` SELECT on
`kauro.aggregate_kinds`, the policy `aggregate_kinds_read` (SELECT, `kauro_app`) and `aggregate_kinds_register` (INSERT, the
migrator); every other entry is byte-identical.

Revert proofs (each mutation applied to 0008 in place, `aggregate-kinds`, `migrations` and `runtime-boundary` run, the file
restored byte for byte and checked by SHA-256): an unpinned binding that names its relations unqualified
(`search_path = kauro, pg_catalog`) fails only test 7; no catalog trigger fails only test 5; B06's CASE left in place fails
tests 6 and 7; a binding that ignores the agency (`AND $2::uuid IS NOT NULL`) fails only test 3; a SECURITY DEFINER binding
fails every test of `aggregate-kinds` (KA006 for every event: the owner reads no registry row under forced row security) and the
`migrations` test that refuses SECURITY DEFINER functions; the CHECK dropped without the foreign key fails tests 2 and 4 and the
`migrations` registry test; `GRANT SELECT, INSERT` to `kauro_app`, or `kauro_app` added to the migrator's INSERT policy, fails
test 4 and the runtime-boundary matrix. Every other test of the three suites stays green under each mutation.

## 6. Open questions

| # | question | interim decision |
|---|---|---|
| Q-AGGK-1 | Registry contract DomainEvent: `agencyId` is "Tenant scope where applicable" — may an aggregate have no agency (B09's platform-level settlements and reconciliation cases)? | Every registered kind is agency-scoped (D-AGGK-2) and B06's rule is kept exactly. A package that needs a platform-scoped kind proposes it in its own design: a column added to the registry by its migration with a default preserving every existing row, and a binding branch that keeps the agency rule for agency-scoped kinds — reviewed as a change to this foundation, not made inside a package silently. |
| Q-AGGK-2 | `kauro.event_types` (B06) is forced-RLS reference data without a write policy, so a package extends the vocabulary only by lifting FORCE inside its migration's transaction (as `b09/design` does). Should event types get the same migrator INSERT policy as the registry? | Unchanged here (not this foundation's subject); each package extends `event_types` in its own migration. Proposed for the integrator of B07 and B09. |
