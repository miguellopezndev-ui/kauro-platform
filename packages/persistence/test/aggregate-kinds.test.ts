// The shared aggregate-kind registry and the table-driven event binding on real PostgreSQL 17 (migration 0008;
// docs/design/FOUNDATION-aggregate-kinds.md). The binding keeps B06's rule exactly (D-EVT-2, review R3: an event names an
// aggregate of its own agency, visible to its writer, at or below that aggregate's version; an unknown and a foreign aggregate
// look alike, KA006; an event ahead of its aggregate is KA002), now read from kauro.aggregate_kinds instead of a CASE per kind.
// Every forbidden write is performed as the role that would perform it — the request handlers (kauro_app_test), the other
// runtime logins, the migration owner (kauro_owner) — and refused beside the legitimate write that still commits (21 "Positive
// and negative symmetry"; 08 "Database isolation": foreign keys bind tenant and parent identity, "Dynamic SQL based on customer
// input is prohibited"; 07 "Restoration and migration": migration roles are separate from runtime). The superuser oracle only
// reads, except where a test plays an adversary that controls a schema, or switches the binding trigger off to show the
// foreign key under it, inside a transaction it rolls back.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { AGGREGATE_KINDS, AUDIT_AGGREGATE_KINDS, BANK_CREDIT_AGGREGATE_KINDS, BANK_ROUTE_AGGREGATE_KINDS, COMMERCE_AGGREGATE_KINDS, EXECUTION_AGGREGATE_KINDS, type AggregateKind, type UserId } from "@kauro/domain";
import { RUNTIME_ROLES } from "../src/index.js";
import { ROLES, sealSourceRevision, startHarness, type AgencyFixture, type Harness } from "../src/testing/index.js";
import { constraintOf, event, ids, plan, project, sha, sourceSessions, sqlState, supportCase, tx, type PlanFixture } from "./support.js";

let h: Harness;
let app: Client;
let control: Client;
let validator: Client;
let owner: Client;
let alice: UserId;
let bob: UserId;
let approver: UserId;
let carol: UserId;
let A: AgencyFixture;
let B: AgencyFixture;
/** Carol founded C and is also an ACTIVE VIEWER of A: A's agency row and her own membership in A are visible to her from C. */
let C: AgencyFixture;
let carolInA: string;
/**
 * The kinds this file walks: B06's seven and B07's three, one aggregate of each in agency A with its current version (read by the
 * oracle). The kinds package B09 registers bind through the same unchanged function and are exercised by that package: every B09
 * schema test appends their events (b09-migrations.test.ts, b09-critique.test.ts).
 */
// package B08's kinds (processing_job, package_version; audit, cost_grant) bind through the same unchanged function and are walked by
// its own schema tests (execution-migrations.test.ts, execution-adapters.test.ts; audit-migrations.test.ts, audit-adapters.test.ts)
type WalkedKind = Exclude<AggregateKind, (typeof COMMERCE_AGGREGATE_KINDS)[number] | (typeof EXECUTION_AGGREGATE_KINDS)[number] | (typeof AUDIT_AGGREGATE_KINDS)[number] | (typeof BANK_ROUTE_AGGREGATE_KINDS)[number] | (typeof BANK_CREDIT_AGGREGATE_KINDS)[number]>;
const WALKED_KINDS: ReadonlyArray<WalkedKind> = AGGREGATE_KINDS.filter(
  (k): k is WalkedKind =>
    !(COMMERCE_AGGREGATE_KINDS as ReadonlyArray<string>).includes(k) && !(EXECUTION_AGGREGATE_KINDS as ReadonlyArray<string>).includes(k) && !(AUDIT_AGGREGATE_KINDS as ReadonlyArray<string>).includes(k) && !(BANK_ROUTE_AGGREGATE_KINDS as ReadonlyArray<string>).includes(k) && !(BANK_CREDIT_AGGREGATE_KINDS as ReadonlyArray<string>).includes(k),
);
const ofA = new Map<WalkedKind, { readonly id: string; readonly version: number }>();

/**
 * Where each kind lives (B06: 0002..0004; B07: 0009, 0010, 0012; B09: 0014..0017 — each package extends this list with the kinds
 * it registers, as the foundation asks); the oracle reads current versions from here, independently of the registry.
 */
const TABLE_OF: Readonly<Record<AggregateKind, readonly [table: string, idColumn: string]>> = Object.freeze({
  agency: ["agencies", "agency_id"],
  membership: ["memberships", "membership_id"],
  end_client: ["end_clients", "client_id"],
  project: ["projects", "project_id"],
  dataset_revision: ["dataset_revisions", "revision_id"],
  plan: ["plans", "plan_id"],
  approval: ["approvals", "approval_id"],
  upload_session: ["upload_sessions", "upload_id"],
  source_file: ["source_files", "file_id"],
  retention_record: ["retention_records", "retention_id"],
  quote: ["quotes", "quote_id"],
  payment_order: ["payment_orders", "order_id"],
  payment_attempt: ["payment_attempts", "attempt_id"],
  capture: ["capture_facts", "capture_id"],
  commercial_authorization: ["commercial_authorizations", "authorization_id"],
  refund: ["refunds", "refund_id"],
  tax_document: ["tax_documents", "document_id"],
  reconciliation_case: ["reconciliation_cases", "case_id"],
  // package B08 (0021, 0022)
  processing_job: ["processing_jobs", "job_id"],
  package_version: ["package_versions", "package_version_id"],
  // package B08 (0023)
  audit: ["audits", "audit_id"],
  cost_grant: ["cost_grants", "grant_id"],
  // package B11 (0026)
  support_case: ["support_cases", "case_id"],
  // Payments V1 bank-transfer route (0046, lane L-ROUTE; walked by apps/api/test/ach-route-cells.test.ts)
  bank_route: ["bank_routes", "route_id"],
  bank_transfer_instruction: ["bank_transfer_instructions", "order_id"],
  // Payments V1 inbound credits (0057, lane PV1-INBOUND)
  bank_credit: ["bank_credits", "bank_credit_id"],
  statement_import: ["statement_imports", "import_id"],
});

// every runtime login of this branch: B06 five, package B09's payment service and package B10's commission service
const RUNTIME_LOGINS = [ROLES.appLogin, ROLES.controlLogin, ROLES.assuranceLogin, ROLES.validatorLogin, ROLES.ingressLogin, ROLES.paymentLogin, ROLES.commissionLogin] as const;

const refusedWith = (code: string, constraint?: string) => (e: unknown): boolean => sqlState(e) === code && (constraint === undefined || constraintOf(e) === constraint);

/** Runs `probe` under a savepoint of the caller's open transaction and expects it refused; the transaction stays usable. */
async function refusedInSavepoint(c: Client, probe: () => Promise<unknown>, code: string, constraint: string | undefined, message: string): Promise<void> {
  await c.query("SAVEPOINT probe");
  try {
    await assert.rejects(probe(), refusedWith(code, constraint), message);
  } finally {
    await c.query("ROLLBACK TO SAVEPOINT probe");
  }
}

/** Runs `fn` inside a transaction of `c` that is always rolled back. */
async function rolledBack(c: Client, fn: () => Promise<void>): Promise<void> {
  await c.query("BEGIN");
  try {
    await fn();
  } finally {
    await c.query("ROLLBACK");
  }
}

/** The event row an aggregate of `kind` would carry (what the EventPublisher adapter writes); the type plays no part in the binding. */
function eventOf(c: Client, kind: string, aggregateId: string, aggregateVersion: number, agencyId: string | null): Promise<string> {
  return event(c, { aggregateKind: kind, aggregateId, aggregateVersion, agencyId, eventType: "agency.created.v1", actorUserId: alice, payload: {} });
}

const registryRow = "INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES ($1, $2, $3, $4)";

before(async () => {
  h = await startHarness();
  app = await h.pg.connect("kauro_app_test");
  control = await h.pg.connect("kauro_control_test");
  validator = await h.pg.connect("kauro_validator_test");
  owner = await h.pg.connect("kauro_owner");
  alice = await h.person("alice-kinds");
  bob = await h.person("bob-kinds");
  approver = await h.person("approver-kinds");
  carol = await h.person("carol-kinds");
  A = await h.createAgency(alice, "Kinds A");
  B = await h.createAgency(bob, "Kinds B");
  C = await h.createAgency(carol, "Kinds C");
  // one aggregate of every B06 kind in A, each born (and walked) under kauro_app with one event per version — every one of those
  // events passed the table-driven binding
  const approverMembership = await h.addMember(A, approver, "APPROVER");
  carolInA = await h.addMember(A, carol, "VIEWER");
  const clientA = await h.endClient(A, await h.processingAuthority(A), "Client A");
  const capabilityId = await h.offeredCapability("CLEAN");
  const { projectId, revisionId } = await project(app, A, clientA, capabilityId);
  const p: PlanFixture & { receiptHash?: string } = await plan({ app, control }, A, projectId, "VALIDATED", "kinds", validator);
  // B07's kinds: an upload, the file it admitted and the retention record of the seal, each born and walked under the role that
  // owns it with one event per version (the source-lifecycle fixture), in a project of their own
  const sourceProject = await project(app, A, clientA, capabilityId);
  const source = await sealSourceRevision(sourceSessions({ app, control }, A), { agencyId: A.agencyId, projectId: sourceProject.projectId, ownerUserId: A.ownerUserId, ownerMembershipId: A.ownerMembershipId }, { seed: "kinds-source" });
  const proof = await h.recordStepUp(approver);
  const approvalId = ids.next();
  // CMD025's writes as the approver's own session: the approval (v1) and its event, the plan APPROVED (v5) naming it and its event
  await tx(app, { agencyId: A.agencyId, userId: approver }, async (c) => {
    await c.query(
      `INSERT INTO kauro.approvals (approval_id, agency_id, plan_id, actor_id, actor_membership_id, actor_membership_version, assurance_proof_ref, plan_hash, revision_hash, target_contract_hash, validation_receipt_hash, disclosures_hash, approval_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 2, $6, $7, $8, $9, $10, $11, $12, now(), now())`,
      [approvalId, A.agencyId, p.planId, approver, approverMembership, proof, p.bodyHash, p.revisionHash, p.targetContractHash, p.receiptHash, sha("disclosures-" + approvalId), sha("approval-" + approvalId)],
    );
    await event(c, { aggregateKind: "approval", aggregateId: approvalId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "approval.created.v1", actorUserId: approver, payload: { approvalId, agencyId: A.agencyId, planId: p.planId } });
    await c.query("UPDATE kauro.plans SET state = 'APPROVED', approval_id = $2, version = 5 WHERE plan_id = $1 AND version = 4", [p.planId, approvalId]);
    await event(c, { aggregateKind: "plan", aggregateId: p.planId, aggregateVersion: 5, agencyId: A.agencyId, eventType: "plan.approved.v1", actorUserId: approver, payload: { planId: p.planId, agencyId: A.agencyId, approvalId } });
  });
  const idOf: Record<WalkedKind, string> = {
    agency: A.agencyId,
    membership: approverMembership,
    end_client: clientA,
    project: projectId,
    dataset_revision: revisionId,
    plan: p.planId,
    approval: approvalId,
    upload_session: source.uploadId,
    source_file: source.fileId,
    retention_record: source.retentionId,
    support_case: (await supportCase(app, A, projectId)).caseId,
  };
  for (const kind of WALKED_KINDS) {
    const [table, column] = TABLE_OF[kind];
    const r = await h.oracle.query<{ version: string }>(`SELECT version FROM kauro.${table} WHERE ${column} = $1 AND agency_id = $2`, [idOf[kind], A.agencyId]);
    assert.equal(r.rows.length, 1, kind);
    ofA.set(kind, { id: idOf[kind], version: Number(r.rows[0]!.version) });
  }
});
after(async () => {
  await app.end();
  await control.end();
  await validator.end();
  await owner.end();
  await h.stop();
});

function aggregateOfA(kind: WalkedKind): { readonly id: string; readonly version: number } {
  const a = ofA.get(kind);
  assert.ok(a, kind);
  return a;
}

async function eventCount(): Promise<number> {
  return (await h.oracle.query<{ n: number }>("SELECT count(*)::int AS n FROM kauro.domain_events")).rows[0]!.n;
}

test("every registered kind binds to the table TABLE_OF names; each B06 and B07 aggregate of A was born and walked under the role that owns it with one bound event per version, and an event at or below its version passes the binding (only the one-event-per-version identity refuses a second; package B09's commerce kinds are walked by its own schema tests)", async () => {
  // the registry of the merged schema: exactly the domain's kinds, each bound to the table and key TABLE_OF names (B06, B07, B09)
  const registry = await h.oracle.query<{ aggregate_kind: string; table_name: string; id_column: string }>("SELECT aggregate_kind, table_name, id_column FROM kauro.aggregate_kinds ORDER BY aggregate_kind");
  assert.deepEqual(
    registry.rows.map((r) => [r.aggregate_kind, r.table_name, r.id_column]),
    [...AGGREGATE_KINDS].sort().map((k) => [k, ...TABLE_OF[k]]),
  );
  assert.deepEqual([...ofA.keys()].sort(), [...WALKED_KINDS].sort());
  for (const kind of WALKED_KINDS) {
    const { id, version } = aggregateOfA(kind);
    const recorded = await h.oracle.query<{ v: string }>(
      "SELECT aggregate_version AS v FROM kauro.domain_events WHERE agency_id = $1 AND aggregate_kind = $2 AND aggregate_id = $3 ORDER BY aggregate_version",
      [A.agencyId, kind, id],
    );
    assert.deepEqual(recorded.rows.map((r) => Number(r.v)), Array.from({ length: version }, (_, i) => i + 1), `${kind}: one event per version`);
  }
  // the binding admits an event at the aggregate's version and below it; what refuses the row is the identity after it (a
  // BEFORE trigger runs before the row's constraints and indexes, so 23505 proves the binding let it through)
  await tx(app, { agencyId: A.agencyId, userId: alice }, async (c) => {
    for (const kind of WALKED_KINDS) {
      const { id, version } = aggregateOfA(kind);
      for (const v of new Set([version, 1])) {
        await refusedInSavepoint(c, () => eventOf(c, kind, id, v, A.agencyId), "23505", "domain_events_one_per_aggregate_version", `${kind} v${v} passes the binding`);
      }
    }
  });
});

test("an unregistered kind is refused: KA006 by the binding (as B06's CASE answered it), and by the foreign key to the registry under it", async () => {
  const before_ = await eventCount();
  await tx(app, { agencyId: A.agencyId, userId: alice }, async (c) => {
    // kinds no package on this tree registers (B07 registers upload_session and B09 quote since the B07+B09 merge)
    for (const kind of ["upload", "job", "Agency", "agency ", "agencies", ""]) {
      await refusedInSavepoint(c, () => eventOf(c, kind, A.agencyId, 1, A.agencyId), "KA006", undefined, `unregistered kind ${JSON.stringify(kind)}`);
    }
  });
  // the foreign key stands on its own: with the binding trigger switched off (superuser, rolled back), the same row is refused
  // by domain_events_aggregate_kind_fkey
  await rolledBack(h.oracle, async () => {
    await h.oracle.query("ALTER TABLE kauro.domain_events DISABLE TRIGGER domain_events_bind_aggregate");
    await assert.rejects(eventOf(h.oracle, "job", A.agencyId, 1, A.agencyId), refusedWith("23503", "domain_events_aggregate_kind_fkey"));
  });
  const trigger = await h.oracle.query<{ tgenabled: string }>("SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'kauro.domain_events'::regclass AND tgname = 'domain_events_bind_aggregate'");
  assert.deepEqual(trigger.rows, [{ tgenabled: "O" }], "the binding trigger is back in force");
  assert.equal(await eventCount(), before_);
});

test("for every kind: another agency's aggregate, an aggregate the writer's policies hide, an unknown id, an event without agency and a writer without context are refused KA006; an event ahead of its aggregate is refused KA002; another agency's aggregate the writer can see is refused KA006 too", async () => {
  const before_ = await eventCount();
  for (const kind of WALKED_KINDS) {
    const { id, version } = aggregateOfA(kind);
    // B's handlers name A's aggregate: as an aggregate of B it does not exist, as an aggregate of A it is invisible to B's policies
    await tx(app, { agencyId: B.agencyId, userId: bob }, async (c) => {
      await refusedInSavepoint(c, () => eventOf(c, kind, id, 1, B.agencyId), "KA006", undefined, `${kind}: A's aggregate is not one of B`);
      await refusedInSavepoint(c, () => eventOf(c, kind, id, 1, A.agencyId), "KA006", undefined, `${kind}: A's aggregate is invisible to B`);
    });
    await tx(app, { agencyId: A.agencyId, userId: alice }, async (c) => {
      // an id nobody has looks exactly like a foreign one
      await refusedInSavepoint(c, () => eventOf(c, kind, ids.next(), 1, A.agencyId), "KA006", undefined, `${kind}: unknown id`);
      // an event without agency scope binds to no aggregate
      await refusedInSavepoint(c, () => eventOf(c, kind, id, 1, null), "KA006", undefined, `${kind}: no agency`);
      // ahead of the aggregate
      await refusedInSavepoint(c, () => eventOf(c, kind, id, version + 1, A.agencyId), "KA002", undefined, `${kind}: v${version + 1} is ahead`);
      await refusedInSavepoint(c, () => eventOf(c, kind, id, version + 7, A.agencyId), "KA002", undefined, `${kind}: v${version + 7} is ahead`);
    });
    // a writer with no context sees nothing, so nothing binds
    await tx(app, {}, async (c) => {
      await refusedInSavepoint(c, () => eventOf(c, kind, id, 1, A.agencyId), "KA006", undefined, `${kind}: no context`);
    });
  }
  // Another agency's aggregate the writer CAN see: row security alone would let it through, so what refuses it is the binding's
  // own agency predicate (B06's `AND x.agency_id = NEW.agency_id`). Carol, working in C, sees agency A (she holds a live
  // membership there: agencies_member_read) and her own membership in A (memberships_self_read).
  await tx(app, { agencyId: C.agencyId, userId: carol }, async (c) => {
    const visible = await c.query<{ agencies: number; memberships: number }>(
      "SELECT (SELECT count(*) FROM kauro.agencies WHERE agency_id = $1)::int AS agencies, (SELECT count(*) FROM kauro.memberships WHERE membership_id = $2)::int AS memberships",
      [A.agencyId, carolInA],
    );
    assert.deepEqual(visible.rows, [{ agencies: 1, memberships: 1 }], "agency A and Carol's membership in A are visible to Carol in C's context");
    await refusedInSavepoint(c, () => eventOf(c, "agency", A.agencyId, 1, C.agencyId), "KA006", undefined, "agency A, visible to Carol, is not an aggregate of C");
    await refusedInSavepoint(c, () => eventOf(c, "membership", carolInA, 1, C.agencyId), "KA006", undefined, "Carol's membership in A, visible to her, is not an aggregate of C");
  });
  assert.equal(await eventCount(), before_, "no refused event was recorded");
});

test("only the migration owner writes the registry: every runtime login is refused INSERT, UPDATE, DELETE and TRUNCATE, only the event inserters (the request handlers, since B07 the control plane, and package B09's payment service) read it, and the owner can register but never rewrite or remove a kind", async () => {
  const registry = (await h.oracle.query<{ aggregate_kind: string; table_name: string; id_column: string; owner_package: string }>("SELECT * FROM kauro.aggregate_kinds ORDER BY aggregate_kind")).rows;
  for (const login of RUNTIME_LOGINS) {
    const c = await h.pg.connect(login);
    try {
      await assert.rejects(c.query(registryRow, ["rogue_kind", "end_clients", "client_id", "B99"]), refusedWith("42501"), `${login} INSERT`);
      await assert.rejects(c.query("UPDATE kauro.aggregate_kinds SET table_name = 'plans', id_column = 'plan_id' WHERE aggregate_kind = 'end_client'"), refusedWith("42501"), `${login} UPDATE`);
      await assert.rejects(c.query("DELETE FROM kauro.aggregate_kinds WHERE aggregate_kind = 'end_client'"), refusedWith("42501"), `${login} DELETE`);
      await assert.rejects(c.query("TRUNCATE kauro.aggregate_kinds"), refusedWith("42501"), `${login} TRUNCATE`);
      if (login === ROLES.appLogin || login === ROLES.controlLogin || login === ROLES.paymentLogin || login === ROLES.commissionLogin) {
        // the request handlers insert domain events, since B07 the control plane appends the source-lifecycle events it owns
        // (B07 D-CTRL-2), and so does package B09's payment service (its read policy aggregate_kinds_read_b09_payment,
        // FOUNDATION §4) and package B10's commission service (aggregate_kinds_read_b10_commission: a quote's expiry and the agency's
        // first designation), so the binding (SECURITY INVOKER) reads the registry as any of them
        const seen = await c.query("SELECT aggregate_kind, table_name, id_column, owner_package FROM kauro.aggregate_kinds ORDER BY aggregate_kind");
        assert.deepEqual(seen.rows, registry);
      } else {
        await assert.rejects(c.query("SELECT aggregate_kind FROM kauro.aggregate_kinds"), refusedWith("42501"), `${login} SELECT`);
      }
    } finally {
      await c.end();
    }
  }
  // the catalog says the same: one table grant and one read policy per event-inserting runtime group (the request handlers; since
  // B07 the control plane, with its package-prefixed policy), one INSERT policy for the migrator, and no policy that lets anybody
  // UPDATE or DELETE a kind
  const grants = await h.oracle.query<{ role: string; privilege: string }>(
    `SELECT r.rolname AS role, a.privilege_type AS privilege FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee
      WHERE c.oid = 'kauro.aggregate_kinds'::regclass AND r.rolname = ANY($1::text[]) ORDER BY 1, 2`,
    [[...RUNTIME_ROLES]],
  );
  assert.deepEqual(grants.rows, [{ role: "kauro_app", privilege: "SELECT" }, { role: "kauro_commission", privilege: "SELECT" }, { role: "kauro_control", privilege: "SELECT" }, { role: "kauro_payment", privilege: "SELECT" }]);
  // the rule behind that one grant, stated over the catalog so that a later package that lets a runtime group append events cannot
  // forget the registry the binding reads as that group: the groups that may read the registry (a grant and a SELECT policy) are
  // exactly the groups that may insert domain events — on main the request handlers alone, with B07 also the control plane
  const inserters = await h.oracle.query<{ role: string }>(
    "SELECT r AS role FROM unnest($1::text[]) r WHERE has_any_column_privilege(r, 'kauro.domain_events', 'INSERT') ORDER BY 1",
    [[...RUNTIME_ROLES]],
  );
  const readers = await h.oracle.query<{ role: string }>(
    `SELECT r AS role FROM unnest($1::text[]) r
      WHERE has_any_column_privilege(r, 'kauro.aggregate_kinds', 'SELECT')
        AND EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'kauro' AND p.tablename = 'aggregate_kinds' AND p.cmd IN ('SELECT', 'ALL') AND r = ANY (p.roles::text[]))
      ORDER BY 1`,
    [[...RUNTIME_ROLES]],
  );
  assert.deepEqual(readers.rows, inserters.rows, "registry readers are exactly the event inserters");
  // B07 extends the foundation's list (FOUNDATION-aggregate-kinds.md §4): the control plane appends the events of its edges; and
  // package B09 extends it: its payment service appends the commerce events of the agency it adopted; and package B10: its commission
  // service appends a quote's expiry and the agency's first designation
  assert.deepEqual(inserters.rows, [{ role: "kauro_app" }, { role: "kauro_commission" }, { role: "kauro_control" }, { role: "kauro_payment" }]);
  const columnGrants = await h.oracle.query("SELECT attname FROM pg_attribute WHERE attrelid = 'kauro.aggregate_kinds'::regclass AND attacl IS NOT NULL");
  assert.deepEqual(columnGrants.rows, []);
  const policies = await h.oracle.query<{ policyname: string; cmd: string; roles: string[] }>(
    "SELECT policyname, cmd, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'kauro' AND tablename = 'aggregate_kinds' ORDER BY policyname",
  );
  assert.deepEqual(policies.rows, [
    { policyname: "aggregate_kinds_read", cmd: "SELECT", roles: ["kauro_app"] },
    { policyname: "aggregate_kinds_read_b07_control", cmd: "SELECT", roles: ["kauro_control"] },
    { policyname: "aggregate_kinds_read_b09_payment", cmd: "SELECT", roles: ["kauro_payment"] },
    { policyname: "aggregate_kinds_read_b10_commission", cmd: "SELECT", roles: ["kauro_commission"] },
    { policyname: "aggregate_kinds_register", cmd: "INSERT", roles: [ROLES.owner] },
  ]);
  const rls = await h.oracle.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'kauro.aggregate_kinds'::regclass");
  assert.deepEqual(rls.rows, [{ relrowsecurity: true, relforcerowsecurity: true }]);
  // the owner: under forced row security with no UPDATE or DELETE policy, a rewrite or removal touches no row
  const rewrite = await owner.query("UPDATE kauro.aggregate_kinds SET table_name = 'plans', id_column = 'plan_id' WHERE aggregate_kind = 'end_client'");
  assert.equal(rewrite.rowCount, 0);
  const removal = await owner.query("DELETE FROM kauro.aggregate_kinds WHERE aggregate_kind = 'end_client'");
  assert.equal(removal.rowCount, 0);
  // and a role that bypasses row security meets the append-only guard (KA004); TRUNCATE is refused by the foreign key from the
  // events, and with CASCADE by the guard (all inside a transaction rolled back)
  const su = h.oracle;
  await rolledBack(su, async () => {
    await refusedInSavepoint(su, () => su.query("UPDATE kauro.aggregate_kinds SET table_name = 'plans', id_column = 'plan_id' WHERE aggregate_kind = 'end_client'"), "KA004", undefined, "superuser UPDATE");
    await refusedInSavepoint(su, () => su.query("DELETE FROM kauro.aggregate_kinds WHERE aggregate_kind = 'end_client'"), "KA004", undefined, "superuser DELETE");
    await refusedInSavepoint(su, () => su.query("TRUNCATE kauro.aggregate_kinds"), "0A000", undefined, "superuser TRUNCATE");
    await refusedInSavepoint(su, () => su.query("TRUNCATE kauro.aggregate_kinds CASCADE"), "KA004", undefined, "superuser TRUNCATE CASCADE");
  });
  const after_ = (await h.oracle.query("SELECT * FROM kauro.aggregate_kinds ORDER BY aggregate_kind")).rows;
  assert.deepEqual(after_, registry, "the registry is unchanged");
});

test("a registry row names a kauro table's single uuid primary key with agency scope and version: a missing table, a non-key column, a composite or non-uuid key, a table without agency_id or version, an object outside kauro, malformed identifiers and a second kind for one table are refused", async () => {
  const registered = (await h.oracle.query<{ n: number }>("SELECT count(*)::int AS n FROM kauro.aggregate_kinds")).rows[0]!.n;
  const c = owner;
  await rolledBack(c, async () => {
    const refusedRow = (row: readonly [string, string, string, string], code: string, constraint: string | undefined, why: string) =>
      refusedInSavepoint(c, () => c.query(registryRow, [...row]), code, constraint, why);
    const unbindable = "aggregate_kinds_bind_catalog";
    await refusedRow(["ghost", "ghosts", "ghost_id", "B99"], "23514", unbindable, "a table that does not exist");
    await refusedRow(["client_by_agency", "end_clients", "agency_id", "B99"], "23514", unbindable, "a column that is not the key");
    await refusedRow(["client_by_label", "end_clients", "display_name", "B99"], "23514", unbindable, "a text column that is not the key");
    await refusedRow(["client_by_nothing", "end_clients", "no_such_column", "B99"], "23514", unbindable, "a column that does not exist");
    await refusedRow(["event_type", "event_types", "event_type", "B99"], "23514", unbindable, "a text primary key");
    await refusedRow(["lease", "leases", "resource_id", "B99"], "23514", unbindable, "a composite primary key");
    await refusedRow(["state_machine", "state_machines", "machine", "B99"], "23514", unbindable, "reference data with a text key");
    await refusedRow(["identity", "identities", "user_id", "B99"], "23514", unbindable, "a uuid key without agency scope");
    await refusedRow(["capability", "capabilities", "capability_id", "B99"], "23514", unbindable, "no agency scope and a text version");
    await refusedRow(["validation_receipt", "validation_receipts", "receipt_id", "B99"], "23514", unbindable, "agency scope without version");
    await refusedRow(["schema_migration", "schema_migrations", "version", "B99"], "23514", unbindable, "a table outside schema kauro");
    await refusedRow(["event_sequence", "domain_events_sequence_seq", "last_value", "B99"], "23514", unbindable, "a sequence, not a table");
    await refusedRow(["injected", "agencies; DROP TABLE kauro.plans", "agency_id", "B99"], "23514", unbindable, "an identifier that is not a table name");
    // shapes a later package could get wrong, on scratch tables of this transaction
    await c.query("CREATE TABLE kauro.kind_probes (probe_id uuid PRIMARY KEY, agency_id uuid NOT NULL, version bigint NOT NULL)");
    await c.query("CREATE TABLE kauro.kind_probes_text_agency (probe_id uuid PRIMARY KEY, agency_id text NOT NULL, version bigint NOT NULL)");
    await c.query("CREATE TABLE kauro.kind_probes_int_version (probe_id uuid PRIMARY KEY, agency_id uuid NOT NULL, version integer NOT NULL)");
    await c.query("CREATE TABLE kauro.kind_probes_bigint_key (probe_id bigint PRIMARY KEY, agency_id uuid NOT NULL, version bigint NOT NULL)");
    await refusedRow(["probe", "kind_probes_text_agency", "probe_id", "B99"], "23514", unbindable, "agency_id that is not a uuid");
    await refusedRow(["probe", "kind_probes_int_version", "probe_id", "B99"], "23514", unbindable, "version that is not a bigint");
    await refusedRow(["probe", "kind_probes_bigint_key", "probe_id", "B99"], "23514", unbindable, "a bigint primary key");
    await refusedRow(["Probe", "kind_probes", "probe_id", "B99"], "23514", "aggregate_kinds_kind_lower_snake", "an upper-case kind");
    await refusedRow(["probe__kind", "kind_probes", "probe_id", "B99"], "23514", "aggregate_kinds_kind_lower_snake", "a doubled underscore");
    await refusedRow(["_probe", "kind_probes", "probe_id", "B99"], "23514", "aggregate_kinds_kind_lower_snake", "a leading underscore");
    await refusedRow(["probe", "kind_probes", "probe_id", "b99"], "23514", "aggregate_kinds_owner_package_shape", "an owner that is not a build package");
    await refusedRow(["agency", "kind_probes", "probe_id", "B99"], "23505", "aggregate_kinds_pkey", "a kind registered twice");
    await refusedRow(["client_again", "end_clients", "client_id", "B99"], "23505", "aggregate_kinds_one_kind_per_table", "a second kind for one table");
    // the one legitimate shape registers with one INSERT (rolled back with the scratch tables)
    const registeredProbe = await c.query(registryRow, ["probe", "kind_probes", "probe_id", "B99"]);
    assert.equal(registeredProbe.rowCount, 1);
  });
  assert.equal((await h.oracle.query<{ n: number }>("SELECT count(*)::int AS n FROM kauro.aggregate_kinds")).rows[0]!.n, registered);
  assert.deepEqual((await h.oracle.query("SELECT relname FROM pg_class WHERE relname LIKE 'kind_probes%'")).rows, []);
  assert.deepEqual((await h.oracle.query("SELECT to_regclass('kauro.plans') IS NOT NULL AS plans")).rows, [{ plans: true }]);
});

test("a kind registered by a later migration binds through the same function, unchanged: its events bind in their own agency, and are refused KA006 across agencies and KA002 ahead", async () => {
  const definition = async (): Promise<string> =>
    (await h.oracle.query<{ def: string }>("SELECT pg_get_functiondef('kauro.domain_events_bind_aggregate()'::regprocedure) AS def")).rows[0]!.def;
  const bindingBefore = await definition();
  // what a later package's migration does, as the migrator: its table (tenant row security like every B06 table), its grants,
  // and one INSERT into the registry — no edit of the binding, of the foreign key or of any B06 object
  await tx(owner, {}, async (c) => {
    await c.query(
      `CREATE TABLE kauro.widgets (
         widget_id uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(widget_id)),
         agency_id uuid NOT NULL REFERENCES kauro.agencies (agency_id),
         version   bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
         UNIQUE (agency_id, widget_id)
       )`,
    );
    await c.query("ALTER TABLE kauro.widgets ENABLE ROW LEVEL SECURITY");
    await c.query("ALTER TABLE kauro.widgets FORCE ROW LEVEL SECURITY");
    await c.query("CREATE POLICY widgets_tenant ON kauro.widgets FOR ALL TO kauro_app USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id())");
    await c.query("GRANT SELECT, INSERT ON kauro.widgets TO kauro_app");
    await c.query(registryRow, ["widget", "widgets", "widget_id", "B99"]);
  });
  assert.equal(await definition(), bindingBefore, "registering a kind does not touch the binding");
  const widgetOf = async (ag: AgencyFixture, userId: UserId): Promise<string> => {
    const widgetId = ids.next();
    await tx(app, { agencyId: ag.agencyId, userId }, async (c) => {
      await c.query("INSERT INTO kauro.widgets (widget_id, agency_id) VALUES ($1, $2)", [widgetId, ag.agencyId]);
      await event(c, { aggregateKind: "widget", aggregateId: widgetId, aggregateVersion: 1, agencyId: ag.agencyId, eventType: "agency.created.v1", actorUserId: userId, payload: {} });
    });
    return widgetId;
  };
  const widgetA = await widgetOf(A, alice);
  const widgetB = await widgetOf(B, bob);
  await tx(app, { agencyId: A.agencyId, userId: alice }, async (c) => {
    await refusedInSavepoint(c, () => eventOf(c, "widget", widgetB, 1, A.agencyId), "KA006", undefined, "B's widget is not one of A");
    await refusedInSavepoint(c, () => eventOf(c, "widget", widgetB, 1, B.agencyId), "KA006", undefined, "B's widget is invisible to A");
    await refusedInSavepoint(c, () => eventOf(c, "widget", ids.next(), 1, A.agencyId), "KA006", undefined, "an unknown widget");
    await refusedInSavepoint(c, () => eventOf(c, "widget", widgetA, 2, A.agencyId), "KA002", undefined, "ahead of A's widget");
    await refusedInSavepoint(c, () => eventOf(c, "widget", widgetA, 1, A.agencyId), "23505", "domain_events_one_per_aggregate_version", "A's widget v1 passes the binding");
  });
  const recorded = await h.oracle.query("SELECT agency_id, aggregate_id, aggregate_version FROM kauro.domain_events WHERE aggregate_kind = 'widget' ORDER BY sequence");
  assert.deepEqual(recorded.rows, [
    { agency_id: A.agencyId, aggregate_id: widgetA, aggregate_version: "1" },
    { agency_id: B.agencyId, aggregate_id: widgetB, aggregate_version: "1" },
  ]);
});

test("the binding cannot be redirected by a session search_path: neither temporary tables nor a schema the session puts first can stand in for the registry or an aggregate table, and the functions are SECURITY INVOKER with a pinned search_path", async () => {
  const client = aggregateOfA("end_client");
  const phantom = ids.next();
  /** The three redirections a shadowing relation would enable, each refused as if the shadow did not exist. */
  const probes = async (c: Client, where: string): Promise<void> => {
    // a client that exists only in the shadow table
    await refusedInSavepoint(c, () => eventOf(c, "end_client", phantom, 1, A.agencyId), "KA006", undefined, `${where}: a phantom client`);
    // the shadow says version 9; the real client is at its own version, so the next one is still ahead
    await refusedInSavepoint(c, () => eventOf(c, "end_client", client.id, client.version + 1, A.agencyId), "KA002", undefined, `${where}: the real version decides`);
    // a kind that exists only in the shadow registry
    await refusedInSavepoint(c, () => eventOf(c, "shadow_kind", client.id, 1, A.agencyId), "KA006", undefined, `${where}: a shadow kind`);
  };
  const before_ = await eventCount();
  // (1) temporary tables of the request handlers' own session, searched first
  await tx(app, { agencyId: A.agencyId, userId: alice }, async (c) => {
    await c.query("CREATE TEMP TABLE aggregate_kinds (aggregate_kind text, table_name text, id_column text, owner_package text) ON COMMIT DROP");
    await c.query("INSERT INTO pg_temp.aggregate_kinds VALUES ('end_client', 'end_clients', 'client_id', 'B06'), ('shadow_kind', 'end_clients', 'client_id', 'B06')");
    await c.query("CREATE TEMP TABLE end_clients (client_id uuid, agency_id uuid, version bigint) ON COMMIT DROP");
    await c.query("INSERT INTO pg_temp.end_clients VALUES ($1, $3, 9), ($2, $3, 9)", [phantom, client.id, A.agencyId]);
    await c.query("SET LOCAL search_path = pg_temp, kauro, public");
    // the session itself does resolve the unqualified names to its temporary tables
    assert.equal((await c.query("SELECT count(*)::int AS n FROM aggregate_kinds WHERE aggregate_kind = 'shadow_kind'")).rows[0].n, 1);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM end_clients WHERE client_id = $1", [phantom])).rows[0].n, 1);
    await probes(c, "temporary tables");
  });
  // (2) a schema an adversary controls, put first by the session
  await h.oracle.query("CREATE SCHEMA shadow");
  try {
    await h.oracle.query("CREATE TABLE shadow.aggregate_kinds (aggregate_kind text, table_name text, id_column text, owner_package text)");
    await h.oracle.query("INSERT INTO shadow.aggregate_kinds VALUES ('end_client', 'end_clients', 'client_id', 'B06'), ('shadow_kind', 'end_clients', 'client_id', 'B06')");
    await h.oracle.query("CREATE TABLE shadow.end_clients (client_id uuid, agency_id uuid, version bigint)");
    await h.oracle.query("INSERT INTO shadow.end_clients VALUES ($1, $3, 9), ($2, $3, 9)", [phantom, client.id, A.agencyId]);
    await h.oracle.query("GRANT USAGE ON SCHEMA shadow TO kauro_app");
    await h.oracle.query("GRANT SELECT ON ALL TABLES IN SCHEMA shadow TO kauro_app");
    await tx(app, { agencyId: A.agencyId, userId: alice }, async (c) => {
      await c.query("SET LOCAL search_path = shadow, kauro, public");
      // the session itself does resolve the unqualified names to the shadow
      assert.equal((await c.query("SELECT count(*)::int AS n FROM end_clients WHERE client_id = $1", [phantom])).rows[0].n, 1);
      await probes(c, "a shadow schema");
    });
  } finally {
    await h.oracle.query("DROP SCHEMA shadow CASCADE");
  }
  assert.equal(await eventCount(), before_, "no redirected event was recorded");
  // what makes it so, as the catalog states it (checked after the behaviour, so a mutation shows up in the probes first): both
  // functions run as their invoker, with a search_path that no session setting replaces
  const functions = await h.oracle.query<{ proname: string; prosecdef: boolean; proconfig: string[] }>(
    "SELECT p.proname, p.prosecdef, p.proconfig FROM pg_proc p WHERE p.oid IN ('kauro.domain_events_bind_aggregate()'::regprocedure, 'kauro.aggregate_kinds_bind_catalog()'::regprocedure) ORDER BY 1",
  );
  assert.deepEqual(functions.rows, [
    { proname: "aggregate_kinds_bind_catalog", prosecdef: false, proconfig: ["search_path=pg_catalog, pg_temp"] },
    { proname: "domain_events_bind_aggregate", prosecdef: false, proconfig: ["search_path=pg_catalog, pg_temp"] },
  ]);
});
