// Support cases on real PostgreSQL 17 (B11 W4, migration 0026, D-SUP-6): the table's guards are proven by the forbidden write
// performed as the runtime role that would perform it, beside the legitimate write that still commits (21 "Positive and
// negative symmetry"), and the repository is proven through a real unit of work.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { isDomainFailure, toUtcInstant, type CausationId, type ClientId, type MembershipId, type ProjectId, type SupportCaseId, type UserId } from "@kauro/domain";
import { start, type AgencyFixture, type Harness } from "../src/testing/harness.js";
import { constraintOf, event, ids, project, sqlState, supportCase, tx } from "./support.js";

let h: Harness;
let app: Client;
let alice: UserId;
let bob: UserId;
let A: AgencyFixture;
let B: AgencyFixture;
let projectA: ProjectId;
let projectA2: ProjectId;
let projectB: ProjectId;
let clientA: ClientId;
let capability: string;

before(async () => {
  h = await start();
  app = await h.pg.connect("kauro_app_test");
  alice = await h.person("alice-cases");
  bob = await h.person("bob-cases");
  A = await h.createAgency(alice, "Cases A");
  B = await h.createAgency(bob, "Cases B");
  clientA = await h.endClient(A, await h.processingAuthority(A), "Client A");
  const clientB = await h.endClient(B, await h.processingAuthority(B), "Client B");
  capability = await h.offeredCapability("CLEAN");
  projectA = (await project(app, A, clientA, capability)).projectId as ProjectId;
  projectA2 = (await project(app, A, clientA, capability)).projectId as ProjectId;
  projectB = (await project(app, B, clientB, capability)).projectId as ProjectId;
});
after(async () => {
  await app.end();
  await h.stop();
});

const refusedWith = (code: string, constraint?: string) => (e: unknown): boolean => sqlState(e) === code && (constraint === undefined || constraintOf(e) === constraint);
const ctxOf = (ag: AgencyFixture) => ({ agencyId: ag.agencyId, userId: ag.ownerUserId });
const SUMMARY = "The import preview shows the wrong column for the second sheet.";

/** The INSERT a handler performs for a case, with the columns under test replaceable; its event is written by the caller. */
async function insertCase(c: Client, ag: AgencyFixture, over: { readonly projectId?: string; readonly membership?: string; readonly summary?: string; readonly evidence?: string[]; readonly agencyId?: string; readonly state?: string } = {}): Promise<string> {
  const caseId = ids.next();
  await c.query(
    `INSERT INTO kauro.support_cases (case_id, agency_id, project_id, category, severity, state, summary, evidence_refs, created_by_user_id, created_by_membership_id, next_review_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'PRODUCT_DEFECT', 'S3', $4, $5, $6::uuid[], $7, $8, now() + interval '1 day', now(), now())`,
    [caseId, over.agencyId ?? ag.agencyId, over.projectId ?? projectA, over.state ?? "OPEN", over.summary ?? SUMMARY, over.evidence ?? [], ag.ownerUserId, over.membership ?? ag.ownerMembershipId],
  );
  return caseId;
}

test("a case commits with its opened event, is born OPEN at version 1, and the summary is in no event payload", async () => {
  const { caseId } = await supportCase(app, A, projectA, { severity: "S2", category: "SECURITY" });
  const row = await h.oracle.query<{ state: string; version: string; evidence_refs: string[]; severity: string }>("SELECT state, version, evidence_refs, severity FROM kauro.support_cases WHERE case_id = $1", [caseId]);
  assert.deepEqual(row.rows, [{ state: "OPEN", version: "1", evidence_refs: [], severity: "S2" }]);
  const events = await h.oracle.query<{ payload: Record<string, string> }>("SELECT payload FROM kauro.domain_events WHERE aggregate_kind = 'support_case' AND aggregate_id = $1", [caseId]);
  assert.equal(events.rows.length, 1);
  assert.ok(!JSON.stringify(events.rows[0]!.payload).includes("import preview"), "the summary never reaches an event");
});

test("a case without its event does not commit (D-EVT-1), and a case born in another state than OPEN is refused", async () => {
  await assert.rejects(tx(app, ctxOf(A), async (c) => void (await insertCase(c, A))), refusedWith("KA003"));
  await assert.rejects(
    tx(app, ctxOf(A), async (c) => void (await insertCase(c, A, { state: "TRIAGED" }))),
    refusedWith("KA008"),
    "the birth guard of the SupportCase machine",
  );
});

test("the composite foreign keys refuse another agency's project and another agency's membership; RLS refuses a row of another agency", async () => {
  // another agency's project: the project exists, but not in the case's agency
  await assert.rejects(tx(app, ctxOf(A), async (c) => void (await insertCase(c, A, { projectId: projectB }))), (e) => sqlState(e) === "23503" && (constraintOf(e) ?? "").startsWith("support_cases_agency_id_project_id"));
  // a membership of another agency
  await assert.rejects(tx(app, ctxOf(A), async (c) => void (await insertCase(c, A, { membership: B.ownerMembershipId }))), refusedWith("23503"));
  // a row that names another agency than the bound context (WITH CHECK)
  await assert.rejects(tx(app, ctxOf(A), async (c) => void (await insertCase(c, A, { agencyId: B.agencyId, projectId: projectB }))), refusedWith("42501"));
});

test("row-level security hides a case from every other agency and from a session without context", async () => {
  const { caseId } = await supportCase(app, A, projectA);
  const seen = async (c: { agencyId?: string; userId?: string }) => (await tx(app, c, (t) => t.query("SELECT case_id FROM kauro.support_cases WHERE case_id = $1", [caseId]))).rows.length;
  assert.equal(await seen(ctxOf(A)), 1);
  assert.equal(await seen(ctxOf(B)), 0);
  assert.equal(await seen({}), 0);
});

test("the summary is 20..4000 characters without control characters, and at most ten scoped evidence references", async () => {
  const refused = (over: Parameters<typeof insertCase>[2], constraint: string) => assert.rejects(tx(app, ctxOf(A), async (c) => void (await insertCase(c, A, over))), refusedWith("23514", constraint));
  await refused({ summary: "x".repeat(19) }, "support_cases_summary_length");
  await refused({ summary: "x".repeat(4001) }, "support_cases_summary_length");
  await refused({ summary: "a line of text\u0007 with a bell inside" }, "support_cases_summary_no_control");
  // a NUL byte never reaches a CHECK: the UTF8 encoding refuses it first
  await assert.rejects(tx(app, ctxOf(A), async (c) => void (await insertCase(c, A, { summary: "a line of text\u0000 with a NUL byte inside" }))), refusedWith("22021"));
  await refused({ summary: "a line of text\u001b[31m with an escape inside" }, "support_cases_summary_no_control");
  await refused({ evidence: Array.from({ length: 11 }, () => ids.next()) }, "support_cases_evidence_bounded");
  // the edges commit: 20 and 4000 characters, line breaks and tabs, ten references
  for (const [over, label] of [
    [{ summary: "x".repeat(20) }, "20 characters"],
    [{ summary: "y".repeat(4000) }, "4000 characters"],
    [{ summary: "first line of the problem\n\tsecond line, indented, of the same problem" }, "line break and tab"],
    [{ evidence: Array.from({ length: 10 }, () => ids.next()) }, "ten references"],
  ] as const) {
    await tx(app, ctxOf(A), async (c) => {
      const caseId = await insertCase(c, A, over);
      await event(c, { aggregateKind: "support_case", aggregateId: caseId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "support_case.opened.v1", actorUserId: A.ownerUserId, payload: { caseId, projectId: projectA } });
    }).catch((e: unknown) => assert.fail(`${label}: ${String(e)}`));
  }
});

test("a case cannot be edited or removed by the request handlers, and no listed edge exists: the columns are immutable and the state cannot move", async () => {
  const { caseId } = await supportCase(app, A, projectA);
  await assert.rejects(tx(app, ctxOf(A), (c) => c.query("UPDATE kauro.support_cases SET severity = 'S1', version = 2 WHERE case_id = $1", [caseId])), refusedWith("42501"));
  await assert.rejects(tx(app, ctxOf(A), (c) => c.query("DELETE FROM kauro.support_cases WHERE case_id = $1", [caseId])), refusedWith("42501"));
  // even the owner role that bypasses grants meets the guards: an immutable column, an unlisted edge
  await assert.rejects(h.oracle.query("UPDATE kauro.support_cases SET summary = 'a different summary of the same length', version = 2 WHERE case_id = $1", [caseId]), refusedWith("KA004"));
  await assert.rejects(h.oracle.query("UPDATE kauro.support_cases SET category = 'BILLING', version = 2 WHERE case_id = $1", [caseId]), refusedWith("KA004"));
  await assert.rejects(h.oracle.query("UPDATE kauro.support_cases SET state = 'TRIAGED', version = 2 WHERE case_id = $1", [caseId]), refusedWith("KA008"));
  await assert.rejects(h.oracle.query("UPDATE kauro.support_cases SET version = 3 WHERE case_id = $1", [caseId]), refusedWith("KA002"));
  const after = await h.oracle.query<{ state: string; version: string; summary: string }>("SELECT state, version, summary FROM kauro.support_cases WHERE case_id = $1", [caseId]);
  assert.deepEqual(after.rows, [{ state: "OPEN", version: "1", summary: SUMMARY }]);
});

test("the repository inserts an OPEN case with its event, reads it back inside its agency only, and pages one project's cases by (createdAt, caseId)", async () => {
  // a project of its own, so the cases the other tests opened do not join this page
  const paged = (await project(app, A, clientA, capability)).projectId as ProjectId;
  const opened: SupportCaseId[] = [];
  const t0 = Date.parse("2027-03-01T10:00:00.000Z");
  // two cases share an instant so the tie-break by id is exercised; one case belongs to the agency's other project
  const plan: ReadonlyArray<readonly [ProjectId, number]> = [[paged, 0], [paged, 0], [paged, 1000], [paged, 2000], [projectA2, 500]];
  for (const [projectId, offset] of plan) {
    await h.app.run(h.tenant(A.agencyId, alice), async (uow) => {
      const membership = A.ownerMembershipId as MembershipId;
      const caseId = uow.ids.next() as SupportCaseId;
      const created = await uow.supportCases.insert({
        caseId,
        agencyId: A.agencyId as never,
        projectId,
        category: "GENERAL",
        severity: "S4",
        summary: "A question about how the import preview groups the columns.",
        evidenceRefs: [],
        createdByUserId: alice,
        createdByMembershipId: membership,
        nextReviewAt: toUtcInstant(t0 + 86_400_000),
        createdAt: toUtcInstant(t0 + offset),
      });
      assert.equal(created.state, "OPEN");
      assert.equal(created.version, 1);
      assert.equal(created.nextReviewAt, toUtcInstant(t0 + 86_400_000));
      await uow.events.publish({
        aggregateKind: "support_case",
        aggregateId: caseId,
        aggregateVersion: 1,
        agencyId: A.agencyId as never,
        eventType: "support_case.opened.v1",
        actor: { kind: "USER", userId: alice },
        causationId: uow.ids.next() as CausationId,
        correlationId: uow.context.correlationId,
        payload: { caseId, projectId, category: "GENERAL", severity: "S4", nextReviewAt: toUtcInstant(t0 + 86_400_000) },
      });
      if (projectId === paged) opened.push(caseId);
    });
  }
  // the first two share the earliest instant: they come in id order, then the later ones
  const inOrder = [opened[0]!, opened[1]!].sort().concat([opened[2]!, opened[3]!]) as SupportCaseId[];
  const page1 = await h.app.run(h.tenant(A.agencyId, alice), (uow) => uow.supportCases.listByProject(A.agencyId as never, paged, { limit: 3 }));
  assert.deepEqual(page1.map((c) => c.caseId), inOrder.slice(0, 3));
  const last = page1[2]!;
  const page2 = await h.app.run(h.tenant(A.agencyId, alice), (uow) => uow.supportCases.listByProject(A.agencyId as never, paged, { limit: 3, after: { createdAt: last.createdAt, id: last.caseId } }));
  assert.deepEqual(page2.map((c) => c.caseId), inOrder.slice(3));
  assert.equal(opened.length, 4);
  // the other project has its own single case; another agency lists nothing and reads nothing
  const other = await h.app.run(h.tenant(A.agencyId, alice), (uow) => uow.supportCases.listByProject(A.agencyId as never, projectA2, { limit: 10 }));
  assert.equal(other.filter((c) => c.projectId === projectA2).length, other.length);
  assert.ok(other.length >= 1);
  const foreign = await h.app.run(h.tenant(B.agencyId, bob), async (uow) => ({
    list: await uow.supportCases.listByProject(A.agencyId as never, paged, { limit: 10 }),
    one: await uow.supportCases.get(inOrder[0]!),
  }));
  assert.deepEqual(foreign, { list: [], one: null });
  const mine = await h.app.run(h.tenant(A.agencyId, alice), (uow) => uow.supportCases.get(inOrder[0]!));
  assert.equal(mine?.caseId, inOrder[0]);
  assert.equal(mine?.createdByMembershipId, A.ownerMembershipId);
  // the page size is bounded like every keyset list (R2 policy api)
  await assert.rejects(
    h.app.run(h.tenant(A.agencyId, alice), (uow) => uow.supportCases.listByProject(A.agencyId as never, paged, { limit: 101 })),
    (e: unknown) => isDomainFailure(e) && e.code === "INVALID_REQUEST",
  );
});

test("the repository refuses a project of another agency through the composite key, as a reference the caller cannot use", async () => {
  await assert.rejects(
    h.app.run(h.tenant(A.agencyId, alice), (uow) =>
      uow.supportCases.insert({
        caseId: uow.ids.next() as SupportCaseId,
        agencyId: A.agencyId as never,
        projectId: projectB,
        category: "GENERAL",
        severity: "S4",
        summary: "A question about how the import preview groups the columns.",
        evidenceRefs: [],
        createdByUserId: alice,
        createdByMembershipId: A.ownerMembershipId as MembershipId,
        nextReviewAt: toUtcInstant(Date.now() + 86_400_000),
        createdAt: toUtcInstant(Date.now()),
      }),
    ),
    (e: unknown) => isDomainFailure(e) && e.code === "INVALID_REQUEST",
  );
});
