// CMD035 against the agency's fiscal profile and the refusals of CMD035 (package B15 lane L6; docs/design/B15-B17-B18-local-plan.md
// sections 1-4, M16, M18; docs/design/B15-case-map.md CMD035-DENY). Its own world: these cells re-review agency A's profile and, last,
// suspend the issuer (QUALIFIED -> SUSPENDED is one-way). The issuance route is the labelled contract fake (CONTRACT_FAKE, SIMULATED).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { CorrelationId, FiscalIssuerRef, FiscalProfileId } from "@kauro/domain";
import { reevaluateBlockedDrafts } from "../src/index.js";
import { fiscalRouteFake } from "./b15-fiscal-pages-fake.js";
import {
  DOC_S_HALF,
  DOC_X_WAIT,
  PROFILE_S_WAIT,
  brief,
  dbPast,
  doc,
  docsOfCapture,
  draftedInvoice,
  fiscalWorld,
  gate,
  holder,
  issue,
  journalOf,
  reReview,
  request,
  seenWaiting,
  tracked,
  validatedInvoice,
  type Doc,
  type FiscalWorld,
} from "./b15-fiscal-support.js";
import { approvedRefund, dispatch, execute, rows } from "./payment-support.js";
import { clock, completed, freshKey, ids } from "./support.js";

/** Every cell is bounded: a hold never reached fails the cell instead of hanging the file. */
const CELL = { timeout: 120_000 };

let fw: FiscalWorld;
before(async () => {
  fw = await fiscalWorld();
});
after(async () => {
  await fw.stop();
});

/** Nothing written for the document and the key: same state and version, no journal row, no submit call. */
async function nothingWritten(d: Doc, key: string, submitsBefore: number): Promise<void> {
  const now = await doc(fw, d.document_id);
  assert.deepEqual([now.state, now.version, now.issue_request_hash], [d.state, d.version, null]);
  assert.deepEqual(await journalOf(fw, key), []);
  assert.equal(fw.route.totalSubmits(), submitsBefore);
}

test("CMD035-DENY: RACE (revocation) a profile re-review against CMD035 at the profile half, both orders", CELL, async () => {
  // order 1: CMD035 holds the profile's shared half; the re-review waits for it; CMD035 issues under the version it judged
  const one = await validatedInvoice(fw, "b15-m16-one");
  const atProfile = fw.holds.arm("INTENT_AFTER_PROFILE_HALF", one.document_id, "WAIT");
  const cmd = tracked(issue(fw, request(one, freshKey("m16-one"))));
  await atProfile.reached;
  const review = tracked(reReview(fw));
  await seenWaiting(fw, "fiscal_profiles", "the re-review waits on CMD035's shared half", { login: null, settled: review.settled });
  atProfile.release();
  assert.equal(brief(await cmd.promise), "ANSWERED 200 ISSUED");
  await review.promise;

  // order 2: the re-review holds the profile's exclusive half; CMD035 waits, then finds the document's version superseded
  const two = await validatedInvoice(fw, "b15-m16-two");
  const before = fw.route.totalSubmits();
  const g = gate();
  const review2 = tracked(reReview(fw, { gate: () => g.pass() }));
  await g.reached;
  const key = freshKey("m16-two");
  const cmd2 = tracked(issue(fw, request(two, key)));
  await seenWaiting(fw, PROFILE_S_WAIT, "CMD035 waits on the re-review's exclusive half", { settled: cmd2.settled });
  g.open();
  await review2.promise;
  assert.equal(brief(await cmd2.promise), "REFUSED PRECONDITION_FAILED FISCAL_PROFILE_NOT_IN_FORCE");
  await nothingWritten(two, key, before);
});

test("CMD035-RACE: REEVALUATE, recordProfile and CMD035 at once, opposite orders forced: no deadlock", CELL, async () => {
  // a credit note waiting for its invoice: REEVALUATE takes profile S -> the invoice's S half -> the note's row
  const inv = await validatedInvoice(fw, "b15-m18");
  const refundId = await approvedRefund(fw.pw, inv.purchase, 1_000n);
  completed(await execute(fw.pw, refundId, { expectedVersion: 2 }, { key: freshKey("m18-refund") }), 200);
  await dispatch(fw.pw, "FISCAL");
  const note = (await docsOfCapture(fw, inv.capture_id)).find((d) => d.kind === "CREDIT_NOTE")!;
  assert.equal(note.state, "DRAFT");
  const reevaluate = (hold?: (p: string, id: string) => Promise<void>) =>
    fw.pw.pools.commerce.run({ kind: "SERVICE", serviceId: "payment-service", correlationId: ids.next() as CorrelationId }, async (uow) => {
      await uow.adoptScope("PAYMENT_ORDER", inv.order_id);
      return reevaluateBlockedDrafts(uow, clock.now(), 50, hold);
    });

  // order 1: REEVALUATE holds the note's row (and the profile's shared half); the re-review queues its exclusive half; CMD035 on the
  // note takes the profile's shared half first, queued behind the re-review, holding no row: everyone settles, no 40P01
  const g = gate();
  const re = tracked(reevaluate(async (_p, id) => (id === note.document_id ? g.pass() : undefined)));
  await g.reached;
  const review = tracked(reReview(fw));
  await seenWaiting(fw, "fiscal_profiles", "the re-review waits on REEVALUATE's shared half", { login: null, settled: review.settled });
  const cmd = tracked(issue(fw, request(note, freshKey("m18-one"))));
  await seenWaiting(fw, PROFILE_S_WAIT, "CMD035 queues behind the re-review", { settled: cmd.settled });
  g.open();
  await re.promise;
  await review.promise;
  assert.equal(brief(await cmd.promise), "REFUSED PRECONDITION_FAILED DOCUMENT_NOT_VALIDATED");

  // order 2: CMD035 holds the note's row (profile and issuer halves before it); the re-review queues; REEVALUATE queues behind it
  // at the profile's shared half before any row: no deadlock either
  const atRow = fw.holds.arm("INTENT_AFTER_ROW", note.document_id, "WAIT");
  const cmd2 = tracked(issue(fw, request(note, freshKey("m18-two"))));
  await atRow.reached;
  const review2 = tracked(reReview(fw));
  await seenWaiting(fw, "fiscal_profiles", "the re-review waits on CMD035's shared half", { login: null, settled: review2.settled });
  const re2 = tracked(reevaluate());
  await seenWaiting(fw, "fiscal_profiles", "REEVALUATE queues behind the re-review", { settled: re2.settled });
  atRow.release();
  assert.equal(brief(await cmd2.promise), "REFUSED PRECONDITION_FAILED DOCUMENT_NOT_VALIDATED");
  await review2.promise;
  await re2.promise;

  // no control of a 40P01 here: with the profile's shared half taken first nothing is held while queued; PostgreSQL itself resolves
  // the soft edge a row-first order would add (wait-queue rearrangement), so the cell asserts what matters — every order settles.
});

test("CMD035-DENY: RACE (expiry) the profile valid_until passes while CMD035 waits on the document shared half: FISCAL_PROFILE_NOT_IN_FORCE, VALIDATED unchanged, no submit call", CELL, async () => {
  await reReview(fw, { validUntilMs: clock.nowMs() + 12_000 });
  const inv = await validatedInvoice(fw, "b15-profile-expiry");
  const until = (await rows<{ valid_until: Date }>(fw.pw, "SELECT valid_until FROM kauro.fiscal_profiles WHERE profile_id = $1", [inv.fiscal_profile_id]))[0]!.valid_until;
  assert.ok(until !== null, "the document's version ends");
  const before = fw.route.totalSubmits();
  const key = freshKey("profile-expiry");
  const s = await holder(fw);
  let refused: string;
  try {
    await s.query(DOC_S_HALF, [inv.document_id]);
    const waiting = tracked(issue(fw, request(inv, key)));
    await seenWaiting(fw, DOC_X_WAIT, "CMD035 waits on the document's half", { holderPid: s.pid, settled: waiting.settled });
    await dbPast(fw, until);
    await s.rollback();
    refused = brief(await waiting.promise);
  } finally {
    await s.rollback().catch(() => undefined);
  }
  assert.equal(refused, "REFUSED PRECONDITION_FAILED FISCAL_PROFILE_NOT_IN_FORCE");
  await nothingWritten(inv, key, before);
  // a version in force again for the cells after this one
  await reReview(fw);
});

test("CMD035-DENY: an unreviewed treatment, a profile or issuer mismatch, unconfirmed issuer facts, an unqualified route, an issuer or profile not in force and an unreconciled prior submission write nothing", CELL, async () => {
  const oracle = fw.pw.w.h.oracle;
  // the OK sibling
  const ok = await validatedInvoice(fw, "b15-deny-ok");
  assert.equal(brief(await issue(fw, request(ok, freshKey("deny-ok")))), "ANSWERED 200 ISSUED");
  let before = fw.route.totalSubmits();

  // an unreviewed treatment: the draft stays blocked (R2-128) and is never issued
  await reReview(fw, { treatment: "REVIEW_REQUIRED" });
  const unreviewed = await draftedInvoice(fw, "b15-deny-unreviewed");
  assert.deepEqual([unreviewed.state, unreviewed.blocked_reason !== null], ["DRAFT", true]);
  let key = freshKey("deny-unreviewed");
  assert.equal(brief(await issue(fw, request(unreviewed, key))), "REFUSED PRECONDITION_FAILED FISCAL_TREATMENT_UNREVIEWED");
  await nothingWritten(unreviewed, key, before);
  await reReview(fw);

  // a profile mismatch: the request names another version than the document's
  const mismatch = await validatedInvoice(fw, "b15-deny-profile-mismatch");
  const other = (await rows<{ profile_id: string }>(fw.pw, "SELECT profile_id FROM kauro.fiscal_profiles WHERE agency_id = $1 AND profile_id <> $2 LIMIT 1", [fw.pw.w.A.agencyId, mismatch.fiscal_profile_id]))[0]!.profile_id;
  key = freshKey("deny-profile-mismatch");
  assert.equal(brief(await issue(fw, request(mismatch, key, { fiscalProfileId: other as FiscalProfileId }))), "REFUSED PRECONDITION_FAILED FISCAL_PROFILE_MISMATCH");
  await nothingWritten(mismatch, key, before);
  assert.equal(brief(await issue(fw, request(mismatch, freshKey("deny-profile-mismatch-ok")))), "ANSWERED 200 ISSUED");
  before = fw.route.totalSubmits();

  // an issuer mismatch: the route bound for the document's issuer is another issuer's
  const issuerMismatch = await validatedInvoice(fw, "b15-deny-issuer-mismatch");
  const foreign = fiscalRouteFake({ bridge: fw.pw.fiscalBridge, issuerRef: ids.next() as FiscalIssuerRef });
  key = freshKey("deny-issuer-mismatch");
  assert.equal(brief(await issue(fw, request(issuerMismatch, key), { ...fw.rt, route: () => foreign })), "REFUSED PRECONDITION_FAILED FISCAL_ISSUER_MISMATCH");
  await nothingWritten(issuerMismatch, key, before);
  assert.equal(foreign.totalSubmits(), 0);

  // an issuer not in force: valid_from not reached
  const notYet = await validatedInvoice(fw, "b15-deny-issuer-not-yet");
  const validFrom = (await rows<{ v: string }>(fw.pw, "SELECT valid_from::text AS v FROM kauro.fiscal_issuers WHERE issuer_ref = $1", [fw.pw.issuerRef]))[0]!.v;
  await oracle.query("UPDATE kauro.fiscal_issuers SET valid_from = now() + interval '1 hour' WHERE issuer_ref = $1", [fw.pw.issuerRef]);
  key = freshKey("deny-issuer-not-yet");
  try {
    assert.equal(brief(await issue(fw, request(notYet, key))), "REFUSED PRECONDITION_FAILED FISCAL_ISSUER_NOT_IN_FORCE");
  } finally {
    await oracle.query("UPDATE kauro.fiscal_issuers SET valid_from = $2::timestamptz WHERE issuer_ref = $1", [fw.pw.issuerRef, validFrom]);
  }
  await nothingWritten(notYet, key, before);

  // a profile not in force: the document's version was superseded by a re-review
  await reReview(fw);
  key = freshKey("deny-profile-superseded");
  assert.equal(brief(await issue(fw, request(notYet, key))), "REFUSED PRECONDITION_FAILED FISCAL_PROFILE_NOT_IN_FORCE");
  await nothingWritten(notYet, key, before);

  // an unreconciled prior submission: a lost response left the document UNCERTAIN; another key is refused, nothing submitted again
  const lost = await validatedInvoice(fw, "b15-deny-unreconciled");
  fw.route.script("LOST");
  assert.equal(brief(await issue(fw, request(lost, freshKey("deny-unreconciled-first")))), "ANSWERED 202 UNCERTAIN");
  before = fw.route.totalSubmits();
  const uncertain = await doc(fw, lost.document_id);
  key = freshKey("deny-unreconciled");
  assert.equal(brief(await issue(fw, request(uncertain, key))), "REFUSED PAYMENT_UNCERTAIN SUBMISSION_UNRECONCILED");
  assert.deepEqual([(await doc(fw, lost.document_id)).state, (await doc(fw, lost.document_id)).version], ["UNCERTAIN", uncertain.version]);
  assert.deepEqual(await journalOf(fw, key), []);
  assert.equal(fw.route.totalSubmits(), before);

  // an unqualified route (last: QUALIFIED -> SUSPENDED is one-way), then unconfirmed issuer facts
  const unqualified = await validatedInvoice(fw, "b15-deny-unqualified");
  const facts = await validatedInvoice(fw, "b15-deny-facts");
  await oracle.query("UPDATE kauro.fiscal_issuers SET route_state = 'SUSPENDED' WHERE issuer_ref = $1", [fw.pw.issuerRef]);
  key = freshKey("deny-unqualified");
  assert.equal(brief(await issue(fw, request(unqualified, key))), "REFUSED PRECONDITION_FAILED FISCAL_PROVIDER_ENTITLEMENT_UNVERIFIED");
  await nothingWritten(unqualified, key, before);
  await oracle.query("UPDATE kauro.fiscal_issuers SET legal_fact_status = 'OWNER_DECLARED' WHERE issuer_ref = $1", [fw.pw.issuerRef]);
  key = freshKey("deny-facts");
  assert.equal(brief(await issue(fw, request(facts, key))), "REFUSED PRECONDITION_FAILED ISSUER_FACTS_UNCONFIRMED");
  await nothingWritten(facts, key, before);
});
