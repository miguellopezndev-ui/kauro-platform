// CMD044 CreateSupportCase — POST /api/v1/projects/{projectId}/support-cases — AGENCY_MEMBER (registry cases CMD044-OK / -DENY /
// -RACE; design docs/design/B11-agency-app.md §5 W4 and decisions D-SUP-1..D-SUP-5; catalogue effect "Create a classified case with
// accountable next response and visible status"; invariant "Support metadata must not become an unrestricted raw-data channel").
// Real route, adapters, oracle: the case, its event and its journal entry are read back from PostgreSQL 17 as the superuser.
//
// Time is deterministic: the api runs on a settable clock, so the covered-hours next review (policy `support.*`: America/Bogota,
// MON-FRI 09:00-17:00, Colombian holidays from the versioned calendar) is asserted to the instant. Bogota is UTC-5 all year.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Clock, ProjectId } from "@kauro/domain";
import { toUtcInstant } from "@kauro/domain";
import { SimulatedCrash, asProblem, call, completed, freshKey, ids, outcome, rawEvent, rootCause, routes, waitForApiLockWait, world, type World } from "./support.js";

/** The wire shape of a case as the test reads it (a local shape: the test states what the client is promised). */
interface CaseView {
  readonly caseId: string;
  readonly agencyId: string;
  readonly projectId: string;
  readonly category: string;
  readonly severity: string;
  readonly state: string;
  readonly summary: string;
  readonly evidenceRefs: ReadonlyArray<string>;
  readonly nextReviewAt: string;
  readonly createdByMembershipId: string;
  readonly createdAt: string;
  readonly version: number;
}

let pinnedMs: number | null = null;
const apiClock: Clock = { now: () => toUtcInstant(pinnedMs ?? Date.now()), nowMs: () => pinnedMs ?? Date.now() };
/** Every line the api's logger wrote, at the most verbose level (the DENY case proves no submitted text is among them). */
const logLines: string[] = [];

let w: World;
let projectA: ProjectId;
let projectB: ProjectId;
before(async () => {
  w = await world({ clock: apiClock, logger: { level: "trace", stream: { write: (line: string) => void logLines.push(line) } } });
  projectA = (await w.project(w.A, w.clientA)).projectId;
  projectB = (await w.project(w.B, w.clientB)).projectId;
});
after(async () => {
  await w.stop();
});

/** Runs `work` with the api clock pinned to `iso`, and always releases the pin. */
async function pinnedAt<T>(iso: string, work: () => Promise<T>): Promise<T> {
  pinnedMs = Date.parse(iso);
  try {
    return await work();
  } finally {
    pinnedMs = null;
  }
}

const OPENED = "support_case.opened.v1";

test("OK: a member with access to the project opens a classified case — 201 with its category, severity, OPEN state and the covered-hours next review; one case, one support_case.opened.v1 event without the summary, one journal entry", async () => {
  // Tuesday 2026-09-29, 10:20 in Bogota
  await pinnedAt("2026-09-29T15:20:00.000Z", async () => {
    // a VIEWER (the least-privileged live role) is a member with access to the project: AGENCY_MEMBER is any ACTIVE membership
    const key = freshKey("cmd044-ok");
    const summary = "Every CRM import stops at forty percent since yesterday and the screen shows no error message at all.";
    const created = completed<CaseView>(await call(w, { url: routes.createSupportCase(projectA), token: w.viewer.token, key, body: { category: "PRODUCT_DEFECT", summary, evidenceRefs: [] } }), 201);
    assert.equal(created.version, 1);
    assert.equal(created.replayed, false);
    const view = created.data;
    assert.deepEqual(view, {
      caseId: view.caseId,
      agencyId: w.A.agencyId,
      projectId: projectA,
      category: "PRODUCT_DEFECT",
      severity: "S3",
      state: "OPEN",
      summary,
      evidenceRefs: [],
      // S3: 17:00 Bogota of the next covered business day (Wednesday 2026-09-30)
      nextReviewAt: "2026-09-30T22:00:00.000Z",
      createdByMembershipId: w.memberships.viewer,
      createdAt: "2026-09-29T15:20:00.000Z",
      version: 1,
    });

    // oracle: exactly one case row, bound to its project and its opener, born OPEN at version 1
    assert.equal(await w.count("support_cases", "case_id = $1", [view.caseId]), 1);
    const row = await w.row<{ agency_id: string; project_id: string; category: string; severity: string; state: string; summary: string; evidence_refs: unknown; created_by_user_id: string; created_by_membership_id: string; next_review_at: Date; version: string }>("support_cases", "case_id = $1", [view.caseId]);
    assert.deepEqual(
      row && { agency: row.agency_id, project: row.project_id, category: row.category, severity: row.severity, state: row.state, summary: row.summary, evidence: row.evidence_refs, user: row.created_by_user_id, membership: row.created_by_membership_id, review: row.next_review_at.toISOString(), version: row.version },
      { agency: w.A.agencyId, project: projectA, category: "PRODUCT_DEFECT", severity: "S3", state: "OPEN", summary, evidence: [], user: w.viewer.userId, membership: w.memberships.viewer, review: "2026-09-30T22:00:00.000Z", version: "1" },
    );
    // one event, of the case's own stream, carrying the classification and never the summary
    const events = await w.events("support_case", view.caseId);
    assert.deepEqual(events.map((e) => [e.version, e.type]), [[1, OPENED]]);
    assert.deepEqual(events[0]?.payload, { caseId: view.caseId, projectId: projectA, category: "PRODUCT_DEFECT", severity: "S3", nextReviewAt: "2026-09-30T22:00:00.000Z" });
    assert.equal(JSON.stringify(events[0]?.payload).includes("forty percent"), false, "the event carries no summary text");
    // one journal entry, committed, that answers a replay with the same view
    assert.equal(await w.count("command_journal", "idempotency_key = $1", [key]), 1);
    const journal = await w.journal(key);
    assert.deepEqual(journal && { state: journal.state, status: journal.status, kind: journal.resourceKind, id: journal.resourceId }, { state: "COMMITTED", status: 201, kind: "support_case", id: view.caseId });
    assert.deepEqual(journal?.body, view);

    // the category decides the severity (design §5 W4) and the severity the next review: an S2 case is reviewed at the end of the
    // next covered hour (11:00-12:00 Bogota), an S3 or S4 case at 17:00 of the next covered business day
    const expected: ReadonlyArray<readonly [category: string, severity: string, nextReviewAt: string]> = [
      ["SECURITY", "S2", "2026-09-29T17:00:00.000Z"],
      ["PRIVACY", "S2", "2026-09-29T17:00:00.000Z"],
      ["PRODUCT_DEFECT", "S3", "2026-09-30T22:00:00.000Z"],
      ["BILLING", "S3", "2026-09-30T22:00:00.000Z"],
      ["IMPORT_GUIDANCE", "S4", "2026-09-30T22:00:00.000Z"],
      ["GENERAL", "S4", "2026-09-30T22:00:00.000Z"],
    ];
    const openers = [w.owner, w.operator, w.billing];
    for (const [index, [category, severity, nextReviewAt]] of expected.entries()) {
      const opener = openers[index % openers.length] ?? w.owner;
      const other = completed<CaseView>(await call(w, { url: routes.createSupportCase(projectA), token: opener.token, body: { category, summary: `A ${category} question about the second import batch of this project.` } }), 201).data;
      assert.deepEqual([other.category, other.severity, other.state, other.nextReviewAt], [category, severity, "OPEN", nextReviewAt], category);
      assert.deepEqual(other.evidenceRefs, [], "the evidence list is empty when none is sent");
    }
    assert.equal(await w.count("support_cases", "project_id = $1 AND state = 'OPEN'", [projectA]), 1 + expected.length);
  });

  // Friday 2026-10-09 10:20: the next covered business day skips the weekend and Monday 2026-10-12, a Colombian holiday (the
  // calendar's Columbus Day), so the S3 case is due Tuesday 2026-10-13 at 17:00 Bogota
  await pinnedAt("2026-10-09T15:20:00.000Z", async () => {
    const view = completed<CaseView>(await call(w, { url: routes.createSupportCase(projectA), token: w.admin.token, body: { category: "BILLING", summary: "The invoice for the second month shows a plan the agency never chose." } }), 201).data;
    assert.deepEqual([view.severity, view.nextReviewAt], ["S3", "2026-10-13T22:00:00.000Z"]);
  });
  // Saturday 2026-10-10 12:00: an S2 case waits for the first covered hour, Tuesday 09:00-10:00 after the holiday
  await pinnedAt("2026-10-10T17:00:00.000Z", async () => {
    const view = completed<CaseView>(await call(w, { url: routes.createSupportCase(projectA), token: w.owner.token, body: { category: "SECURITY", summary: "A former contractor may still be able to open the agency workspace." } }), 201).data;
    assert.deepEqual([view.severity, view.nextReviewAt], ["S2", "2026-10-13T15:00:00.000Z"]);
  });
});

// The submitted texts the DENY case must find nowhere. Each is assembled at run time, so no secret-looking literal sits in the
// repository, and each carries a fragment that no other text and no fixture contains.
const PRIVATE_KEY_FRAGMENT = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";
const privateKey = [["-----BEGIN", "PRIVATE KEY-----"].join(" "), PRIVATE_KEY_FRAGMENT, "MBzUG3s2xJr0fT4VQwNfHkZ1LQ2eYb8u", ["-----END", "PRIVATE KEY-----"].join(" ")].join("\n");
const CRM_FRAGMENT = "ana.perez@example.test";
const crmRows = [
  `${CRM_FRAGMENT},Ana Perez,+57 300 555 0101,Bogota`,
  "luis.gomez@example.test,Luis Gomez,+57 300 555 0102,Cali",
  "marta.rios@example.test,Marta Rios,+57 300 555 0103,Medellin",
  "jorge.diaz@example.test,Jorge Diaz,+57 300 555 0104,Cartagena",
].join("\n");
const CLOUD_KEY_FRAGMENT = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const JWT_FRAGMENT = ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"].join(".");
const BEARER_FRAGMENT = "q8Zk2mVx7TnR4wYc1PdLs9HbGf3JuE6A";
const PASSWORD_FRAGMENT = "hunter2-correct-horse";
const ENTROPY_FRAGMENT = "Xk9fQ2mZp7RtLw4vBn8sYc3HdJ6gAe1UoTq5iMzKx0WbPa";
const EMAILS_FRAGMENT = "first.contact@example.test";
const CONTROL_FRAGMENT = "control-marker-4d2f7c19e0";

interface Refusal {
  readonly label: string;
  readonly category: string;
  readonly summary: string;
  readonly reason: "SECRET_LIKE_CONTENT" | "RECORD_LIKE_CONTENT";
  readonly fragment: string;
}
const REFUSALS: ReadonlyArray<Refusal> = [
  { label: "a private key", category: "SECURITY", summary: `The import fails with this credential attached, please help:\n${privateKey}\nThank you.`, reason: "SECRET_LIKE_CONTENT", fragment: PRIVATE_KEY_FRAGMENT },
  { label: "CRM rows", category: "IMPORT_GUIDANCE", summary: `These are the contacts that fail to import:\n${crmRows}`, reason: "RECORD_LIKE_CONTENT", fragment: CRM_FRAGMENT },
  { label: "a cloud access key", category: "GENERAL", summary: `The upload role uses access key ${CLOUD_KEY_FRAGMENT} and it stopped working yesterday.`, reason: "SECRET_LIKE_CONTENT", fragment: CLOUD_KEY_FRAGMENT },
  { label: "a JWT", category: "GENERAL", summary: `The session cookie holds ${JWT_FRAGMENT} and the page refuses it.`, reason: "SECRET_LIKE_CONTENT", fragment: JWT_FRAGMENT },
  { label: "a bearer token", category: "PRODUCT_DEFECT", summary: `Calling the endpoint with Authorization: Bearer ${BEARER_FRAGMENT} answers forbidden.`, reason: "SECRET_LIKE_CONTENT", fragment: BEARER_FRAGMENT },
  { label: "a password pair", category: "GENERAL", summary: `I signed in with user=ana password=${PASSWORD_FRAGMENT} and the page reloads itself.`, reason: "SECRET_LIKE_CONTENT", fragment: PASSWORD_FRAGMENT },
  { label: "a long high-entropy string", category: "GENERAL", summary: `The value ${ENTROPY_FRAGMENT} is what the CRM shows in the field.`, reason: "SECRET_LIKE_CONTENT", fragment: ENTROPY_FRAGMENT },
  { label: "three e-mail addresses", category: "IMPORT_GUIDANCE", summary: `Contacts ${EMAILS_FRAGMENT}, second.contact@example.test and third.contact@example.test were not merged.`, reason: "RECORD_LIKE_CONTENT", fragment: EMAILS_FRAGMENT },
];

/** Superuser oracle: the tables of schema kauro that hold a row whose text contains `fragment` (every tenant, every table). */
async function tablesHolding(fragment: string): Promise<ReadonlyArray<string>> {
  const tables = await w.h.oracle.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'kauro' AND table_type = 'BASE TABLE' ORDER BY table_name");
  const holding: string[] = [];
  for (const { table_name } of tables.rows) {
    const found = await w.h.oracle.query<{ n: string }>(`SELECT count(*)::text AS n FROM kauro."${table_name}" x WHERE x::text LIKE $1`, [`%${fragment}%`]);
    if (Number(found.rows[0]?.n ?? "0") > 0) holding.push(table_name);
  }
  return holding;
}

test("DENY: a foreign tenant, a wrong role and then one missing prerequisite — another agency's project answers 404 like a nonexistent one, a suspended membership 403, a summary with a private key or CRM rows 422 with the secure-upload next action; no case, event, outbox record or log line holds the submitted text", async () => {
  const url = routes.createSupportCase(projectA);
  const safe = { category: "GENERAL", summary: "The export button on the results page does nothing when clicked." };
  const casesBefore = await w.count("support_cases");
  const eventsBefore = await w.count("domain_events", "event_type = $1", [OPENED]);
  const outboxBefore = await w.count("outbox_records");
  const journalBefore = await w.count("command_journal");
  const denialsBefore = (await w.securityEvents("CMD044")).length;
  const internalBefore = w.internalErrors.length;

  // a foreign tenant: another agency's project, under its own context or under the caller's, is invisible like one that never
  // existed (the same answer, so the route is no existence oracle)
  assert.equal(outcome(w, await call(w, { url, token: w.stranger.token, agency: w.B.agencyId, body: safe })), "404 NOT_FOUND -", "A's project under B's context");
  assert.equal(outcome(w, await call(w, { url: routes.createSupportCase(projectB), token: w.operator.token, body: safe })), "404 NOT_FOUND -", "B's project under A's context");
  assert.equal(outcome(w, await call(w, { url: routes.createSupportCase(ids.next()), token: w.operator.token, body: safe })), "404 NOT_FOUND -", "a project that does not exist");
  assert.equal(outcome(w, await call(w, { url, token: w.stranger.token, body: safe })), "404 NOT_FOUND NOT_A_MEMBER", "the stranger has no membership in A");

  // a membership that is not live: revoked answers like no membership (404), invited and suspended are known and refused (403)
  const revoked = await w.person("revoked-member");
  const revokedMembershipId = await w.h.addMember(w.A, revoked.userId, "OPERATOR");
  await w.asTenant(w.A, async (c) => {
    const moved = await c.query<{ version: string }>("UPDATE kauro.memberships SET state = 'REVOKED', revoked_at = now(), version = version + 1 WHERE membership_id = $1 RETURNING version", [revokedMembershipId]);
    await rawEvent(c, {
      aggregateKind: "membership",
      aggregateId: revokedMembershipId,
      aggregateVersion: Number(moved.rows[0]?.version),
      agencyId: w.A.agencyId,
      eventType: "membership.revoked.v1",
      actorUserId: w.owner.userId,
      payload: { membershipId: revokedMembershipId, agencyId: w.A.agencyId, byMembershipId: w.A.ownerMembershipId, reasonCode: "OFFBOARDED" },
    });
  });
  assert.equal(outcome(w, await call(w, { url, token: revoked.token, body: safe })), "404 NOT_FOUND NOT_A_MEMBER", "a revoked membership");
  assert.equal(outcome(w, await call(w, { url, token: w.invited.token, body: safe })), "403 NOT_AUTHORIZED MEMBERSHIP_NOT_ACTIVE", "an invited membership");
  assert.equal(outcome(w, await call(w, { url, token: w.suspended.token, body: safe })), "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED", "a suspended membership");
  // access is decided before the content is read: a caller who may not open a case learns nothing about the content rules
  const secretBody = { category: "SECURITY", summary: `Please look at this key: ${privateKey}` };
  assert.equal(outcome(w, await call(w, { url, token: w.stranger.token, body: secretBody })), "404 NOT_FOUND NOT_A_MEMBER");
  assert.equal(outcome(w, await call(w, { url, token: w.suspended.token, body: secretBody })), "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED");
  assert.equal(outcome(w, await call(w, { url: routes.createSupportCase(projectB), token: w.operator.token, body: secretBody })), "404 NOT_FOUND -");

  // one missing prerequisite: safe content. Every refusal is 422 CONTENT_REFUSED with the secure-upload route as its next action,
  // and the refusal never echoes what it refused
  for (const r of REFUSALS) {
    const reply = await call(w, { url, token: w.operator.token, body: { category: r.category, summary: r.summary } });
    assert.equal(outcome(w, reply), `422 CONTENT_REFUSED ${r.reason}`, r.label);
    assert.deepEqual(asProblem(w, reply).nextActions, [{ action: "SECURE_UPLOAD" }], r.label);
    assert.equal(reply.text.includes(r.fragment), false, `${r.label}: the refusal does not echo the submitted text`);
  }

  // oracle: no case, event, outbox record or journal entry came of any denied or refused call
  assert.equal(await w.count("support_cases"), casesBefore);
  assert.equal(await w.count("domain_events", "event_type = $1", [OPENED]), eventsBefore);
  assert.equal(await w.count("outbox_records"), outboxBefore);
  assert.equal(await w.count("command_journal"), journalBefore, "nothing was journaled: a refusal rolls its reservation back with the rest");
  // the authorization denials are durable facts (safe tokens only); a missing project and a content refusal are not denials
  const denials = (await w.securityEvents("CMD044")).slice(denialsBefore);
  assert.deepEqual(denials.map((d) => d.reason).sort(), ["MEMBERSHIP_NOT_ACTIVE", "MEMBERSHIP_SUSPENDED", "MEMBERSHIP_SUSPENDED", "NOT_A_MEMBER", "NOT_A_MEMBER", "NOT_A_MEMBER"]);

  // control: an accepted case does hold its text, exactly in the case row and its journaled answer — so the sweep below can see
  // text where text is, and finds none where the submitted text was refused
  const control = completed<CaseView>(await call(w, { url, token: w.operator.token, body: { category: "GENERAL", summary: `A plain question about the weekly schedule page (${CONTROL_FRAGMENT}).` } }), 201).data;
  assert.equal(control.state, "OPEN");
  assert.deepEqual(await tablesHolding(CONTROL_FRAGMENT), ["command_journal", "support_cases"]);
  for (const r of REFUSALS) assert.deepEqual(await tablesHolding(r.fragment), [], `${r.label}: no table of any tenant holds the refused text`);
  assert.deepEqual(await tablesHolding(PRIVATE_KEY_FRAGMENT), [], "the key sent by callers who were denied access is nowhere either");

  // the api's own log, at trace level, holds every request and no submitted text — refused or accepted
  assert.ok(logLines.length > 0 && logLines.some((line) => line.includes("support-cases")), "the log sink captured these requests (a control: an empty sink proves nothing)");
  const submitted = [...REFUSALS.flatMap((r) => [r.fragment, JSON.stringify(r.summary).slice(1, -1)]), JSON.stringify(secretBody.summary).slice(1, -1), CONTROL_FRAGMENT, safe.summary];
  for (const text of submitted) assert.equal(logLines.some((line) => line.includes(text)), false, `no log line holds ${text.slice(0, 24)}...`);
  assert.equal(w.internalErrors.length, internalBefore, "no request ended in an internal error whose text could carry the input");
});

test("RACE: an identical retry, the same key with another digest (IDEMPOTENCY_CONFLICT) and a crash at the intent/commit boundary — at most one case, the retry replays it, the conflict creates nothing, and a crash before COMMIT leaves nothing for the retry to duplicate", async () => {
  const url = routes.createSupportCase(projectA);
  const key = freshKey("cmd044-race");
  const body = { category: "GENERAL", summary: "Raced case: the export button does nothing in Safari on the results page." };
  // two identical requests: A reserves its journal entry and holds, B waits on the identity index, A commits, B replays
  const hold = w.holds.arm("journal.reserved");
  const requestA = call(w, { url, token: w.operator.token, key, body });
  await hold.reached;
  const requestB = call(w, { url, token: w.operator.token, key, body });
  try {
    await waitForApiLockWait(w, "command_journal");
  } finally {
    // a wait that never happens fails the test above; the held request is let go either way, so no transaction outlives it
    hold.release();
  }
  const [a, b] = await Promise.all([requestA, requestB]);
  const first = completed<CaseView>(a, 201);
  const second = completed<CaseView>(b, 201);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true, "the retry replays the journaled answer");
  assert.deepEqual(second.data, first.data);
  assert.equal(await w.count("support_cases", "summary = $1", [body.summary]), 1, "at most one case");
  assert.equal(await w.count("command_journal", "idempotency_key = $1", [key]), 1);
  assert.deepEqual((await w.events("support_case", first.data.caseId)).map((e) => e.type), [OPENED], "one event for the one case");

  // the same key with another digest is the typed conflict, and it creates nothing
  const conflict = await call(w, { url, token: w.operator.token, key, body: { ...body, summary: `${body.summary} (edited)` } });
  assert.equal(outcome(w, conflict), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal(await w.count("support_cases", "summary LIKE $1", ["Raced case:%"]), 1);

  // a crash at the intent/commit boundary: the case row and its event were written, the journal entry was about to complete
  const crashKey = freshKey("cmd044-crash");
  const crashBody = { category: "PRIVACY", summary: "Crashed case: a former client asks which of their records the agency still holds." };
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await call(w, { url, token: w.operator.token, key: crashKey, body: crashBody });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.equal(rootCause(w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true);
  assert.equal(await w.count("support_cases", "summary = $1", [crashBody.summary]), 0, "no case survives a crash before COMMIT");
  assert.equal(await w.count("domain_events", "event_type = $1 AND payload->>'category' = 'PRIVACY'", [OPENED]), 0, "nor its event");
  assert.equal(await w.journal(crashKey), null, "nor its journal entry");
  // the retry with the same key is the first execution of that logical operation: exactly one case, once
  const retried = completed<CaseView>(await call(w, { url, token: w.operator.token, key: crashKey, body: crashBody }), 201);
  assert.equal(retried.replayed, false);
  assert.equal(await w.count("support_cases", "summary = $1", [crashBody.summary]), 1, "the retry did not duplicate anything: there was nothing to duplicate");
  assert.deepEqual((await w.events("support_case", retried.data.caseId)).map((e) => e.type), [OPENED]);
  const again = completed<CaseView>(await call(w, { url, token: w.operator.token, key: crashKey, body: crashBody }), 201);
  assert.equal(again.replayed, true);
  assert.equal(await w.count("support_cases", "summary = $1", [crashBody.summary]), 1);
});

