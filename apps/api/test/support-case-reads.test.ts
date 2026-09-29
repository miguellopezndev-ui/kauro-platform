// The two support reads (B11 W4; design docs/design/B11-agency-app.md §5 W4 row: "keyset list per project, and one case"; owner
// manual 18; registry R2-060 "Reject cursor scope/signature mismatch without leaking rows or totals"; S048 "Deny without
// resource-existence or data leakage"). Real routes, real composition root, real PostgreSQL 17 under the request handlers' own
// role and policies. Time is a settable clock, so cases can share an instant and the keyset tiebreak is exercised.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Page, SupportCaseView } from "@kauro/application";
import type { Clock } from "@kauro/domain";
import { toUtcInstant } from "@kauro/domain";
import { asProblem, call, completed, effectCounts, ids, outcome, routes, world, type Person, type Reply, type World } from "./support.js";

let pinnedMs: number | null = null;
const apiClock: Clock = { now: () => toUtcInstant(pinnedMs ?? Date.now()), nowMs: () => pinnedMs ?? Date.now() };

let w: World;
before(async () => {
  w = await world({ clock: apiClock });
});
after(async () => {
  await w.stop();
});

/** A GET as `person`; `agency` is the X-Kauro-Agency selector (the caller's agency A unless another value or null is given). */
function read(url: string, person: Person | null, agency?: string | null): Promise<Reply> {
  return call(w, { method: "GET", url, token: person === null ? null : person.token, key: null, contentType: null, ...(agency !== undefined ? { agency } : {}) });
}

function data<T>(reply: Reply): T {
  if (reply.status !== 200) throw new Error(`expected 200, got ${reply.status}: ${reply.text}`);
  const body = reply.json<{ kind: string; data: T }>();
  assert.equal(body.kind, "READ");
  return body.data;
}

/** Opens a case through the command at the instant `iso`; the reads below then see what a real caller created. */
async function open(projectId: string, person: Person, category: string, summary: string, iso: string, agency?: string): Promise<SupportCaseView> {
  pinnedMs = Date.parse(iso);
  try {
    return completed<SupportCaseView>(await call(w, { url: routes.createSupportCase(projectId), token: person.token, ...(agency !== undefined ? { agency } : {}), body: { category, summary } }), 201).data;
  } finally {
    pinnedMs = null;
  }
}

/** The order the list promises: oldest first, ties broken by the case id. */
function keysetOrder(cases: ReadonlyArray<SupportCaseView>): ReadonlyArray<string> {
  return [...cases].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0)).map((c) => c.caseId);
}

const CASE_KEYS = ["agencyId", "caseId", "category", "createdAt", "createdByMembershipId", "evidenceRefs", "nextReviewAt", "projectId", "severity", "state", "summary", "version"];

test("ListSupportCases: one project's cases, oldest first, in keyset pages bound to the caller, the agency and the project — every live member reads them, a cursor of another list, caller or project is CURSOR_INVALID without a row or a total", async () => {
  const projectP = (await w.project(w.A, w.clientA)).projectId;
  const projectQ = (await w.project(w.A, w.clientA)).projectId;
  const projectEmpty = (await w.project(w.A, w.clientA)).projectId;
  const t0 = "2026-09-29T15:00:00.000Z";
  const t1 = "2026-09-29T15:01:00.000Z";
  const t2 = "2026-09-29T15:02:00.000Z";
  const t3 = "2026-09-29T15:03:00.000Z";
  // five cases in P, two of them at the same instant (the tiebreak is the case id), and one in Q
  const inP = [
    await open(projectP, w.owner, "GENERAL", "The first question about the weekly schedule page of this project.", t0),
    await open(projectP, w.viewer, "BILLING", "The second question, opened at the same instant as the third one.", t1),
    await open(projectP, w.operator, "SECURITY", "The third question, opened at the same instant as the second one.", t1),
    await open(projectP, w.billing, "IMPORT_GUIDANCE", "The fourth question about how the second import batch is mapped.", t2),
    await open(projectP, w.admin, "PRODUCT_DEFECT", "The fifth question about a button that does nothing in Safari.", t3),
  ];
  const inQ = await open(projectQ, w.owner, "GENERAL", "A question that belongs to the other project of the same client.", t0);
  const expected = keysetOrder(inP);

  // every live member reads the whole list, in the promised order, as the safe view (exactly the case's members, nothing else)
  for (const person of [w.owner, w.admin, w.operator, w.approver, w.viewer, w.billing]) {
    const page = data<Page<SupportCaseView>>(await read(routes.listSupportCases(projectP), person));
    assert.deepEqual(page.items.map((c) => c.caseId), expected);
    assert.equal(page.nextCursor, undefined, "five cases fit the default page");
    assert.deepEqual(Object.keys(page.items[0] ?? {}).sort(), CASE_KEYS);
    assert.ok(page.items.every((c) => c.projectId === projectP && c.agencyId === w.A.agencyId && c.state === "OPEN"));
  }
  assert.deepEqual(data<Page<SupportCaseView>>(await read(routes.listSupportCases(projectQ), w.viewer)).items.map((c) => c.caseId), [inQ.caseId], "a project lists only its own cases");
  assert.deepEqual(data<Page<SupportCaseView>>(await read(routes.listSupportCases(projectEmpty), w.viewer)), { items: [] }, "a project without cases lists none, and no cursor");

  // pages of two reach every case exactly once, in order; the last page is the one shorter than its limit
  const seen: string[] = [];
  const sizes: number[] = [];
  let cursor: string | undefined;
  do {
    const page: Page<SupportCaseView> = data<Page<SupportCaseView>>(await read(`${routes.listSupportCases(projectP)}?limit=2${cursor ? `&cursor=${cursor}` : ""}`, w.viewer));
    seen.push(...page.items.map((c) => c.caseId));
    sizes.push(page.items.length);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  assert.deepEqual(seen, expected);
  assert.deepEqual(sizes, [2, 2, 1]);
  // a page boundary that falls between two cases of the same instant neither skips nor repeats one of them
  const firstPage = data<Page<SupportCaseView>>(await read(`${routes.listSupportCases(projectP)}?limit=2`, w.viewer));
  const secondPage = data<Page<SupportCaseView>>(await read(`${routes.listSupportCases(projectP)}?limit=2&cursor=${firstPage.nextCursor}`, w.viewer));
  assert.deepEqual([...firstPage.items, ...secondPage.items].map((c) => c.caseId), expected.slice(0, 4));

  // limits, and a list that takes no filter
  const list = routes.listSupportCases(projectP);
  for (const query of ["limit=0", "limit=101", "limit=2&limit=3", "state=OPEN", "category=GENERAL", "limit=abc"]) assert.equal(outcome(w, await read(`${list}?${query}`, w.viewer)), "400 INVALID_REQUEST SCHEMA_VIOLATION", query);

  // cursors: a cursor of P's list opens neither Q's list, nor another caller's, nor another list; an edited one is refused too
  const before = await effectCounts(w);
  assert.ok(firstPage.nextCursor !== undefined);
  const cursorOfP = firstPage.nextCursor;
  const onOtherProject = await read(`${routes.listSupportCases(projectQ)}?limit=2&cursor=${cursorOfP}`, w.viewer);
  assert.equal(outcome(w, onOtherProject), "400 INVALID_REQUEST CURSOR_INVALID");
  assert.ok(!onOtherProject.text.includes(inQ.caseId) && !onOtherProject.text.includes("items") && !/"total/.test(onOtherProject.text), "no row and no total");
  assert.equal(outcome(w, await read(`${list}?limit=2&cursor=${cursorOfP}`, w.owner)), "400 INVALID_REQUEST CURSOR_INVALID", "another caller of the same agency");
  assert.equal(outcome(w, await read(`/api/v1/agencies/${w.A.agencyId}/clients?limit=2&cursor=${cursorOfP}`, w.viewer, null)), "400 INVALID_REQUEST CURSOR_INVALID", "another list");
  assert.equal(outcome(w, await read(`${list}?limit=2&cursor=${cursorOfP}`, w.stranger, w.B.agencyId)), "400 INVALID_REQUEST CURSOR_INVALID", "a member of another agency");
  const [position, mac] = cursorOfP.split(".") as [string, string];
  const edited = `${position.slice(0, -2)}${position.endsWith("A") ? "B" : "A"}${position.slice(-1)}.${mac}`;
  assert.equal(outcome(w, await read(`${list}?limit=2&cursor=${edited}`, w.viewer)), "400 INVALID_REQUEST CURSOR_INVALID", "an edited cursor");
  assert.equal(outcome(w, await read(`${list}?limit=2&cursor=not-a-cursor`, w.viewer)), "400 INVALID_REQUEST CURSOR_INVALID");
  assert.deepEqual(await effectCounts(w), before, "nothing was written by a read, a refused one included");
  // the genuine continuation still works for its caller
  assert.deepEqual(data<Page<SupportCaseView>>(await read(`${list}?limit=2&cursor=${cursorOfP}`, w.viewer)).items.map((c) => c.caseId), expected.slice(2, 4));
});

test("ListSupportCases: another agency's project answers the same 404 as one that does not exist, a non-live membership is refused, and access is decided before any row is read", async () => {
  const projectP = (await w.project(w.A, w.clientA)).projectId;
  const projectB = (await w.project(w.B, w.clientB)).projectId;
  const inP = await open(projectP, w.owner, "PRIVACY", "A former client asks which of their records the agency still holds.", "2026-09-29T15:00:00.000Z");
  const inB = await open(projectB, w.stranger, "GENERAL", "A question that belongs to the other agency and must stay there.", "2026-09-29T15:00:00.000Z", w.B.agencyId);

  // S048: B's project under A's context and a project that never existed look alike, and the stranger's own project is theirs alone
  const foreign = await read(routes.listSupportCases(projectB), w.owner);
  const nowhere = await read(routes.listSupportCases(ids.next()), w.owner);
  for (const reply of [foreign, nowhere]) assert.equal(outcome(w, reply), "404 NOT_FOUND -");
  const { correlationId: _a, ...foreignRest } = asProblem(w, foreign);
  const { correlationId: _b, ...nowhereRest } = asProblem(w, nowhere);
  assert.deepEqual(foreignRest, nowhereRest, "the answers differ only in their correlation ids");
  assert.ok(!foreign.text.includes(inB.caseId) && !foreign.text.includes("Bravo"), "nothing of the other agency's case");
  assert.equal(outcome(w, await read(routes.listSupportCases(projectP), w.stranger, w.B.agencyId)), "404 NOT_FOUND -", "A's project under B's context");
  assert.equal(outcome(w, await read(routes.listSupportCases(projectP), w.stranger)), "404 NOT_FOUND NOT_A_MEMBER", "the stranger has no membership in A");
  assert.deepEqual(data<Page<SupportCaseView>>(await read(routes.listSupportCases(projectB), w.stranger, w.B.agencyId)).items.map((c) => c.caseId), [inB.caseId], "the owner of B reads B's own");

  // a membership that is not live, and no session at all
  assert.equal(outcome(w, await read(routes.listSupportCases(projectP), w.suspended)), "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED");
  assert.equal(outcome(w, await read(routes.listSupportCases(projectP), w.invited)), "403 NOT_AUTHORIZED MEMBERSHIP_NOT_ACTIVE");
  assert.equal(outcome(w, await read(routes.listSupportCases(projectP), null)), "401 AUTHENTICATION_REQUIRED -");
  assert.equal(outcome(w, await read(routes.listSupportCases(projectP), w.owner, null)), "400 INVALID_REQUEST AGENCY_SELECTOR_INVALID");
  assert.equal(outcome(w, await read(routes.listSupportCases("not-an-id"), w.owner)), "400 INVALID_REQUEST PATH_ID_INVALID");
  assert.deepEqual(data<Page<SupportCaseView>>(await read(routes.listSupportCases(projectP), w.owner)).items.map((c) => c.caseId), [inP.caseId], "A's own project lists its case to A's own members");
});

test("GetSupportCase: the case with its classification, state and next review for every live member of its agency; another agency's case answers the same 404 as one that does not exist", async () => {
  const projectP = (await w.project(w.A, w.clientA)).projectId;
  const projectB = (await w.project(w.B, w.clientB)).projectId;
  const created = await open(projectP, w.operator, "BILLING", "The invoice for the second month shows a plan the agency never chose.", "2026-09-29T15:20:00.000Z");
  const foreignCase = await open(projectB, w.stranger, "GENERAL", "A question that belongs to the other agency and must stay there.", "2026-09-29T15:20:00.000Z", w.B.agencyId);
  assert.equal(created.state, "OPEN");

  // every live member reads it, and what they read is what the command answered
  for (const person of [w.owner, w.admin, w.operator, w.approver, w.viewer, w.billing]) {
    const reply = await read(routes.getSupportCase(created.caseId), person);
    assert.deepEqual(data<SupportCaseView>(reply), created, "the read view is the created view");
    assert.deepEqual(Object.keys(data<SupportCaseView>(reply)).sort(), CASE_KEYS);
  }
  assert.deepEqual(data<SupportCaseView>(await read(routes.getSupportCase(foreignCase.caseId), w.stranger, w.B.agencyId)), foreignCase, "the owner of B reads B's own");

  // S048: B's case under A's context, A's case under B's context and an id that never existed answer alike, and nothing of the case leaks
  const foreign = await read(routes.getSupportCase(foreignCase.caseId), w.owner);
  const crossed = await read(routes.getSupportCase(created.caseId), w.stranger, w.B.agencyId);
  const nowhere = await read(routes.getSupportCase(ids.next()), w.owner);
  for (const reply of [foreign, crossed, nowhere]) assert.equal(outcome(w, reply), "404 NOT_FOUND -");
  const rests = [foreign, crossed, nowhere].map((reply) => {
    const { correlationId: _c, ...rest } = asProblem(w, reply);
    return rest;
  });
  assert.deepEqual(rests[0], rests[2]);
  assert.deepEqual(rests[1], rests[2]);
  assert.ok(!foreign.text.includes("belongs to the other agency") && !crossed.text.includes("second month"), "no summary text in a refusal");
  assert.equal(outcome(w, await read(routes.getSupportCase(created.caseId), w.stranger)), "404 NOT_FOUND NOT_A_MEMBER", "the stranger has no membership in A");

  // a membership that is not live, no session, no selector, a malformed id, a query on a read that takes none
  assert.equal(outcome(w, await read(routes.getSupportCase(created.caseId), w.suspended)), "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED");
  assert.equal(outcome(w, await read(routes.getSupportCase(created.caseId), w.invited)), "403 NOT_AUTHORIZED MEMBERSHIP_NOT_ACTIVE");
  assert.equal(outcome(w, await read(routes.getSupportCase(created.caseId), null)), "401 AUTHENTICATION_REQUIRED -");
  assert.equal(outcome(w, await read(routes.getSupportCase(created.caseId), w.owner, null)), "400 INVALID_REQUEST AGENCY_SELECTOR_INVALID");
  assert.equal(outcome(w, await read(routes.getSupportCase("not-an-id"), w.owner)), "400 INVALID_REQUEST PATH_ID_INVALID");
  assert.equal(outcome(w, await read(`${routes.getSupportCase(created.caseId)}?limit=2`, w.owner)), "400 INVALID_REQUEST SCHEMA_VIOLATION", "a read without a list takes no query");

  // a read writes nothing: no case, event, outbox record, journal entry or security event came of these reads
  const before = await effectCounts(w);
  await read(routes.getSupportCase(created.caseId), w.viewer);
  await read(routes.listSupportCases(projectP), w.viewer);
  assert.deepEqual(await effectCounts(w), before);
  assert.equal(await w.count("support_cases", "case_id = $1", [created.caseId]), 1);
  assert.equal((await w.events("support_case", created.caseId)).length, 1, "reading a case adds no event to its stream");
});
