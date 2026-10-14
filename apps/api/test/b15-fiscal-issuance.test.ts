// CMD035 IssueTaxDocument, its reconciler and the credit notes an issued invoice validates (package B15 lane L6;
// docs/design/B15-B17-B18-local-plan.md sections 1-5, M6, M15, M17, M19-M21; docs/design/B15-case-map.md CMD035-OK, CMD035-RACE, R2-084).
// The issuance route is a labelled contract fake (b15-fiscal-pages-fake.ts; CONTRACT_FAKE, SIMULATED): no live fiscal provider is
// called. The issuer of this world is the payment world's PROVIDER_API issuer, QUALIFIED with entitlement evidence; its route_state is
// suspended by the last tests of this file only (QUALIFIED -> SUSPENDED is one-way).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import type { CommerceEventDelivery } from "@kauro/application";
import { reconcileTaxDocument } from "@kauro/application";
import type { CorrelationId, RefundId, TaxDocumentId } from "@kauro/domain";
import { INJECTED_STATEMENT_TIMEOUT_MS, LOCK_WAIT_OBSERVATION_MS, ROLES, raceStatementTimeoutMs, testDatabaseEnvironment } from "@kauro/persistence/testing";
import { fiscalConsumer, openPaymentPools, reconcileFiscalDelivery, reevaluateBlockedDrafts, type FiscalConsumerPoint } from "../src/index.js";
import { NotDueYet } from "../src/payments/service-commands.js";
import { PAGE_SIZE } from "./b15-fiscal-pages-fake.js";
import {
  DOC_S_WAIT,
  DOC_X_HALF,
  DOC_X_WAIT,
  ISSUER_S_WAIT,
  ROW_LOCK,
  brief,
  dbPast,
  doc,
  docsOfCapture,
  eventsOf,
  fiscalWorld,
  holder,
  issue,
  issuerColumns,
  journalOf,
  pidWaiting,
  request,
  seenWaiting,
  tracked,
  validatedInvoice,
  type Doc,
  type FiscalWorld,
} from "./b15-fiscal-support.js";
import { approvedRefund, execute, rows, SimulatedCrash } from "./payment-support.js";
import { clock, completed, freshKey, ids, sha } from "./support.js";

let fw: FiscalWorld;
before(async () => {
  fw = await fiscalWorld();
});
after(async () => {
  await fw.stop();
});

/** Every cell is bounded: a hold never reached fails the cell instead of hanging the file. */
const CELL = { timeout: 120_000 };

const ISSUED_EVENTS = ["tax_document.drafted.v1", "tax_document.validated.v1", "tax_document.submitting.v1", "tax_document.issued.v1"];

function reconcile(d: Pick<Doc, "document_id" | "order_id">, rt = fw.rt) {
  return reconcileTaxDocument(rt, { documentId: d.document_id as TaxDocumentId, scope: { kind: "PAYMENT_ORDER", key: d.order_id }, correlationId: ids.next() as CorrelationId });
}

/** A runtime whose submit window is `ms` (absence cells: the deadline is near). */
function windowOf(ms: number) {
  return { ...fw.rt, submitWindowMs: ms };
}

async function deliveryOf(aggregateId: string, eventType: string): Promise<CommerceEventDelivery> {
  const r = (await rows<{ event_id: string; agency_id: string; aggregate_version: string; payload: Record<string, unknown> }>(fw.pw, "SELECT event_id, agency_id, aggregate_version::text, payload FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = $2", [aggregateId, eventType]))[0];
  if (r === undefined) throw new Error(`no ${eventType} of ${aggregateId}`);
  return { eventId: r.event_id as never, eventType, agencyId: r.agency_id as never, aggregateId, aggregateVersion: Number(r.aggregate_version), payload: r.payload };
}

/** The FISCAL consumer run on one delivery in the payment service's unit of work (the dispatcher's own call, without its inbox). */
function consume(delivery: CommerceEventDelivery, hold?: (point: FiscalConsumerPoint, subjectId: string) => Promise<void>) {
  return fw.pw.pools.commerce.run({ kind: "SERVICE", serviceId: "payment-service", correlationId: ids.next() as CorrelationId }, (uow) => fiscalConsumer(hold === undefined ? {} : { hold }).consume(uow, delivery, clock.now()));
}

/** A refund of the purchase approved and executed (COMPLETED; refund.completed.v1 published, not yet delivered). */
async function refunded(inv: Awaited<ReturnType<typeof validatedInvoice>>, cents: bigint): Promise<RefundId> {
  const refundId = await approvedRefund(fw.pw, inv.purchase, cents);
  completed(await execute(fw.pw, refundId, { expectedVersion: 2 }, { key: freshKey("b15-refund") }), 200);
  return refundId;
}

async function creditNotes(inv: Doc): Promise<Doc[]> {
  return (await docsOfCapture(fw, inv.capture_id)).filter((d) => d.kind === "CREDIT_NOTE");
}

// --- OK ------------------------------------------------------------------------------------------------------------------------------

test("CMD035-OK: FISCAL_SERVICE issues a VALIDATED document; legal number, provider id, DIAN acceptance and verification reference recorded; ISSUED", CELL, async () => {
  const inv = await validatedInvoice(fw, "b15-ok");
  const key = freshKey("cmd035-ok");
  const o = await issue(fw, request(inv, key));
  assert.equal(brief(o), "ANSWERED 200 ISSUED");
  const d = await doc(fw, inv.document_id);
  assert.equal(d.state, "ISSUED");
  assert.equal(d.version, inv.version + 2);
  assert.match(d.legal_number ?? "", /^SETP\d{6}$/);
  assert.match(d.provider_document_id ?? "", /^fake-doc-/);
  assert.equal(d.fiscal_status, "ACCEPTED");
  assert.match(d.verification_ref ?? "", /^CUFE-/);
  assert.ok(d.issue_request_hash !== null && d.submit_deadline_at !== null);
  assert.equal(fw.route.submits(d.issue_request_hash), 1);
  assert.deepEqual(await eventsOf(fw, inv.document_id), ISSUED_EVENTS);
  assert.deepEqual(await journalOf(fw, key), ["COMMITTED"]);
  if (o.kind !== "ANSWERED") throw new Error("answered");
  assert.deepEqual([o.view.legalNumber, o.view.fiscalStatus, o.view.verificationRef], [d.legal_number, "ACCEPTED", d.verification_ref]);
  // the issued event names its order (the FISCAL consumer adopts the scope through it)
  const issued = await deliveryOf(inv.document_id, "tax_document.issued.v1");
  assert.equal(issued.payload["orderId"], inv.order_id);

  // an acceptance with observations is a fiscal acceptance too (X2)
  const second = await validatedInvoice(fw, "b15-ok-observations");
  fw.route.script("ACCEPT_WITH_OBSERVATIONS");
  assert.equal(brief(await issue(fw, request(second, freshKey("cmd035-ok-obs")))), "ANSWERED 200 ISSUED");
  assert.equal((await doc(fw, second.document_id)).fiscal_status, "ACCEPTED_WITH_OBSERVATIONS");
});

// --- RACE: replay, conflict, two callers, crashes --------------------------------------------------------------------------------------

test("CMD035-RACE: the same key replays, a conflicting key is refused, two issuers on one document yield one submission, crash after the SUBMITTING commit reconciles", CELL, async () => {
  // the same key and request: the stored answer, no second submission
  const inv = await validatedInvoice(fw, "b15-race-replay");
  const key = freshKey("cmd035-replay");
  assert.equal(brief(await issue(fw, request(inv, key))), "ANSWERED 200 ISSUED");
  const hash = (await doc(fw, inv.document_id)).issue_request_hash!;
  assert.equal(brief(await issue(fw, request(inv, key))), "ANSWERED 200 ISSUED replayed");
  assert.equal(fw.route.submits(hash), 1);
  // the same key for another request: refused, nothing written
  const conflicting = await issue(fw, request(inv, key, { expectedVersion: inv.version + 1 }));
  assert.equal(brief(conflicting), "REFUSED IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.deepEqual(await journalOf(fw, key), ["COMMITTED"]);
  assert.equal(fw.route.submits(hash), 1);

  // two callers on one document, the second waiting at the document row: one submission; the loser is told to retry later
  const two = await validatedInvoice(fw, "b15-race-two");
  const atRow = fw.holds.arm("INTENT_AFTER_ROW", two.document_id, "WAIT");
  const committed = fw.holds.arm("INTENT_COMMITTED", two.document_id, "WAIT");
  const first = tracked(issue(fw, request(two, freshKey("cmd035-two-a"))));
  await atRow.reached;
  const second = tracked(issue(fw, request(two, freshKey("cmd035-two-b"))));
  await seenWaiting(fw, ROW_LOCK, "the second caller waits at the document row", { settled: second.settled });
  atRow.release();
  await committed.reached;
  assert.equal(brief(await second.promise), "REFUSED PAYMENT_PENDING OPERATION_PENDING retryable");
  committed.release();
  assert.equal(brief(await first.promise), "ANSWERED 200 ISSUED");
  assert.equal(fw.route.submits((await doc(fw, two.document_id)).issue_request_hash!), 1);
  assert.equal(fw.route.totalSubmits() > 0, true);

  // a crash after the SUBMITTING commit, before the submit: the retry of the key observes and never submits
  const crashed = await validatedInvoice(fw, "b15-race-crash");
  fw.holds.arm("INTENT_COMMITTED", crashed.document_id, "CRASH");
  const crashKey = freshKey("cmd035-crash");
  await assert.rejects(issue(fw, request(crashed, crashKey)), SimulatedCrash);
  const submitting = await doc(fw, crashed.document_id);
  assert.equal(submitting.state, "SUBMITTING");
  assert.deepEqual(await journalOf(fw, crashKey), ["RESERVED"]);
  const retried = await issue(fw, request(crashed, crashKey));
  assert.equal(brief(retried), "ANSWERED 202 UNCERTAIN replayed");
  assert.equal(fw.route.submits(submitting.issue_request_hash!), 0);
  assert.deepEqual(await journalOf(fw, crashKey), ["UNCERTAIN"]);
});

test("CMD035-RACE: two issuers held at the document row, both orders: one submit call", CELL, async () => {
  // order 1: B arrives while A holds the row (B waits, then finds SUBMITTING)
  const one = await validatedInvoice(fw, "b15-m15-one");
  const atRow = fw.holds.arm("INTENT_AFTER_ROW", one.document_id, "WAIT");
  const committed = fw.holds.arm("INTENT_COMMITTED", one.document_id, "WAIT");
  const a = tracked(issue(fw, request(one, freshKey("m15-a"))));
  await atRow.reached;
  const b = tracked(issue(fw, request(one, freshKey("m15-b"))));
  await seenWaiting(fw, ROW_LOCK, "B waits on A's row lock", { settled: b.settled });
  atRow.release();
  await committed.reached;
  assert.equal(brief(await b.promise), "REFUSED PAYMENT_PENDING OPERATION_PENDING retryable");
  committed.release();
  assert.equal(brief(await a.promise), "ANSWERED 200 ISSUED");
  assert.equal(fw.route.submits((await doc(fw, one.document_id)).issue_request_hash!), 1);

  // order 2: B arrives after A's intent committed, before A's submit (no wait: B finds SUBMITTING at once); then after A concluded
  const two = await validatedInvoice(fw, "b15-m15-two");
  const committed2 = fw.holds.arm("INTENT_COMMITTED", two.document_id, "WAIT");
  const a2 = tracked(issue(fw, request(two, freshKey("m15-a2"))));
  await committed2.reached;
  assert.equal(brief(await issue(fw, request(two, freshKey("m15-b2")))), "REFUSED PAYMENT_PENDING OPERATION_PENDING retryable");
  committed2.release();
  assert.equal(brief(await a2.promise), "ANSWERED 200 ISSUED");
  const after = await doc(fw, two.document_id);
  assert.equal(brief(await issue(fw, request(after, freshKey("m15-b3")))), "REFUSED PRECONDITION_FAILED DOCUMENT_NOT_VALIDATED");
  assert.equal(fw.route.submits(after.issue_request_hash!), 1);
  assert.deepEqual(await eventsOf(fw, two.document_id), ISSUED_EVENTS);
});

test("CMD035-RACE: CRASH before COMMIT: VALIDATED, no hash, no submit call", CELL, async () => {
  const inv = await validatedInvoice(fw, "b15-crash-before");
  const before = fw.route.totalSubmits();
  fw.holds.arm("INTENT_BEFORE_COMMIT", inv.document_id, "CRASH");
  const key = freshKey("cmd035-crash-before");
  // a death inside the unit of work rolls it back: the caller sees an internal, retryable failure
  assert.equal(brief(await issue(fw, request(inv, key))), "REFUSED INTERNAL_ERROR INTERNAL_ERROR retryable");
  const d = await doc(fw, inv.document_id);
  assert.deepEqual([d.state, d.version, d.issue_request_hash, d.submit_deadline_at], ["VALIDATED", inv.version, null, null]);
  assert.deepEqual(await journalOf(fw, key), [], "the reservation rolled back with the intent");
  assert.equal(fw.route.totalSubmits(), before);
  // the retry runs the whole command once
  assert.equal(brief(await issue(fw, request(inv, key))), "ANSWERED 200 ISSUED");
});

test("CMD035-RACE: crash after the SUBMITTING commit reconciles: the retry observes, never submits again", CELL, async () => {
  // the provider received the request and accepted it; the process died before the conclusion
  const inv = await validatedInvoice(fw, "b15-crash-answered");
  fw.holds.arm("SUBMIT_ANSWERED", inv.document_id, "CRASH");
  const key = freshKey("cmd035-crash-answered");
  await assert.rejects(issue(fw, request(inv, key)), SimulatedCrash);
  const d = await doc(fw, inv.document_id);
  assert.equal(d.state, "SUBMITTING");
  assert.equal(fw.route.submits(d.issue_request_hash!), 1);
  const retried = await issue(fw, request(inv, key));
  assert.equal(brief(retried), "ANSWERED 200 ISSUED replayed");
  assert.equal(fw.route.submits(d.issue_request_hash!), 1, "found by its exact identity, never submitted again");
  assert.deepEqual(await journalOf(fw, key), ["COMMITTED"]);
  // the stored answer is replayed from then on
  assert.equal(brief(await issue(fw, request(inv, key))), "ANSWERED 200 ISSUED replayed");
  assert.deepEqual(await eventsOf(fw, inv.document_id), ISSUED_EVENTS);
});

test("CMD035-RACE: a submit timeout concludes UNCERTAIN, never REJECTED", CELL, async () => {
  // the response was lost after the provider accepted: UNCERTAIN, then found by the reconciler
  const inv = await validatedInvoice(fw, "b15-timeout-accepted");
  fw.route.script("LOST_AFTER_ACCEPT");
  const key = freshKey("cmd035-lost");
  assert.equal(brief(await issue(fw, request(inv, key))), "ANSWERED 202 UNCERTAIN");
  const d = await doc(fw, inv.document_id);
  assert.deepEqual([d.state, d.rejection_code, d.legal_number], ["UNCERTAIN", null, null]);
  assert.deepEqual(await journalOf(fw, key), ["UNCERTAIN"]);
  // an unreconciled prior submission refuses another key (no blind second submission)
  assert.equal(brief(await issue(fw, request(d, freshKey("cmd035-lost-other")))), "REFUSED PAYMENT_UNCERTAIN SUBMISSION_UNRECONCILED");
  assert.equal(fw.route.submits(d.issue_request_hash!), 1);
  const settled = await reconcile(d);
  assert.equal(settled.kind, "SETTLED");
  assert.equal((await doc(fw, inv.document_id)).state, "ISSUED");
  // the pending key now answers the conclusion the reconciler recorded, without submitting
  assert.equal(brief(await issue(fw, request(inv, key))), "ANSWERED 200 ISSUED replayed");
  assert.equal(fw.route.submits(d.issue_request_hash!), 1);
  assert.deepEqual(await eventsOf(fw, inv.document_id), [...ISSUED_EVENTS.slice(0, 3), "tax_document.uncertain.v1", "tax_document.issued.v1"]);
});

test("CMD035-RACE: crash before the conclusion's COMMIT: SUBMITTING stays and the reconciler observes, never submits again", CELL, async () => {
  const inv = await validatedInvoice(fw, "b15-crash-conclude");
  fw.holds.arm("CONCLUDE_BEFORE_COMMIT", inv.document_id, "CRASH");
  assert.equal(brief(await issue(fw, request(inv, freshKey("cmd035-crash-conclude")))), "REFUSED INTERNAL_ERROR INTERNAL_ERROR retryable");
  const d = await doc(fw, inv.document_id);
  assert.deepEqual([d.state, d.legal_number], ["SUBMITTING", null]);
  assert.equal((await reconcile(d)).kind, "SETTLED");
  const issued = await doc(fw, inv.document_id);
  assert.equal(issued.state, "ISSUED");
  assert.equal(fw.route.submits(d.issue_request_hash!), 1);
  // a duplicate observation of a concluded document writes nothing
  assert.equal((await reconcile(d)).kind, "SETTLED");
  assert.equal((await doc(fw, inv.document_id)).version, issued.version);
  assert.deepEqual(await eventsOf(fw, inv.document_id), ISSUED_EVENTS);
});

test("CMD035-RACE: crash after the ISSUED commit: replay answers ISSUED", CELL, async () => {
  const inv = await validatedInvoice(fw, "b15-crash-issued");
  const key = freshKey("cmd035-crash-issued");
  // the answer is lost with the process after the conclusion committed: the caller retries the key
  await issue(fw, request(inv, key));
  const replay = await issue(fw, request(inv, key));
  assert.equal(brief(replay), "ANSWERED 200 ISSUED replayed");
  const d = await doc(fw, inv.document_id);
  if (replay.kind !== "ANSWERED") throw new Error("answered");
  assert.deepEqual([replay.view.legalNumber, replay.view.version], [d.legal_number, d.version]);
  assert.equal(fw.route.submits(d.issue_request_hash!), 1);
});

test("CMD035-RACE: PARTIAL the issued.v1 event insert fails after ISSUED: full rollback", CELL, async () => {
  const inv = await validatedInvoice(fw, "b15-partial");
  const oracle = fw.pw.w.h.oracle;
  await oracle.query(`CREATE OR REPLACE FUNCTION public.b15_fail_issued() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.event_type = 'tax_document.issued.v1' AND NEW.aggregate_id::text = '${inv.document_id}' THEN RAISE EXCEPTION 'injected: the issued.v1 insert fails'; END IF; RETURN NEW; END $$`);
  await oracle.query("CREATE TRIGGER b15_fail_issued BEFORE INSERT ON kauro.domain_events FOR EACH ROW EXECUTE FUNCTION public.b15_fail_issued()");
  let outcome: string;
  try {
    outcome = await issue(fw, request(inv, freshKey("cmd035-partial"))).then(brief, (e: unknown) => `THREW ${(e as Error).message}`);
  } finally {
    await oracle.query("DROP TRIGGER b15_fail_issued ON kauro.domain_events");
    await oracle.query("DROP FUNCTION public.b15_fail_issued()");
  }
  assert.ok(!outcome.startsWith("ANSWERED"), `the conclusion failed: ${outcome}`);
  const d = await doc(fw, inv.document_id);
  assert.deepEqual([d.state, d.legal_number, d.fiscal_status, d.verification_ref, d.provider_document_id], ["SUBMITTING", null, null, null, null], "nothing of the conclusion stands without its event");
  assert.deepEqual(await eventsOf(fw, inv.document_id), ISSUED_EVENTS.slice(0, 3));
  // the reconciler concludes it once the event can be written
  assert.equal((await reconcile(d)).kind, "SETTLED");
  assert.deepEqual(await eventsOf(fw, inv.document_id), ISSUED_EVENTS);
});

test("X2: a provider-found document whose fiscal acceptance is pending stays UNCERTAIN (not ISSUED); a correction-required rejection is not terminal", CELL, async () => {
  const pending = await validatedInvoice(fw, "b15-x2-pending");
  fw.route.script("PENDING");
  assert.equal(brief(await issue(fw, request(pending, freshKey("x2-pending")))), "ANSWERED 202 UNCERTAIN");
  const p = await doc(fw, pending.document_id);
  assert.deepEqual([p.state, p.legal_number, p.fiscal_status], ["UNCERTAIN", null, null]);
  // still pending at the provider: still UNCERTAIN
  assert.equal((await reconcile(p)).kind, "OBSERVING");
  assert.equal((await doc(fw, pending.document_id)).state, "UNCERTAIN");
  // the DIAN acceptance arrives: ISSUED with it
  fw.route.publish(p.issue_request_hash as never, "ACCEPTED");
  assert.equal((await reconcile(p)).kind, "SETTLED");
  assert.deepEqual([(await doc(fw, pending.document_id)).state, (await doc(fw, pending.document_id)).fiscal_status], ["ISSUED", "ACCEPTED"]);

  const correction = await validatedInvoice(fw, "b15-x2-correction");
  fw.route.script("CORRECTION");
  assert.equal(brief(await issue(fw, request(correction, freshKey("x2-correction")))), "ANSWERED 200 REJECTED");
  const c = await doc(fw, correction.document_id);
  assert.deepEqual([c.state, c.rejection_code, c.legal_number], ["REJECTED", "CORRECTION_REQUIRED", null]);
  // not terminal: a rejected document is corrected by its successor (REJECTED -> CORRECTED)
  const next = await rows<{ to_state: string }>(fw.pw, "SELECT to_state FROM kauro.state_transitions WHERE machine = 'TaxDocument' AND from_state = 'REJECTED'");
  assert.ok(next.some((r) => r.to_state === "CORRECTED"), "REJECTED -> CORRECTED is listed");

  const rejected = await validatedInvoice(fw, "b15-x2-rejected");
  fw.route.script("REJECT");
  assert.equal(brief(await issue(fw, request(rejected, freshKey("x2-rejected")))), "ANSWERED 200 REJECTED");
  assert.equal((await doc(fw, rejected.document_id)).rejection_code, "DIAN_RULE_FAU04");
});

// --- R2-084: exact identity through every page --------------------------------------------------------------------------------------

test("R2-084: RACE (timeout) an invoice issued before the timeout and listed on page 3 is found by exact identity before any replacement", CELL, async () => {
  const inv = await validatedInvoice(fw, "b15-page3");
  // the provider lists 2 full pages of other requests' documents before this one
  const need = 2 * PAGE_SIZE + 5 - fw.route.listed().length;
  assert.ok(need > 0, "the list is still shorter than two pages here");
  fw.route.pad(need);
  fw.route.script("LOST_AFTER_ACCEPT");
  const key = freshKey("r2-084-page3");
  assert.equal(brief(await issue(fw, request(inv, key))), "ANSWERED 202 UNCERTAIN");
  const d = await doc(fw, inv.document_id);
  const index = fw.route.listed().findIndex((x) => x.issueRequestHash === d.issue_request_hash);
  assert.ok(index >= 2 * PAGE_SIZE, `listed past page 2 (index ${index})`);
  const pageOf = Math.floor(index / PAGE_SIZE);
  assert.equal(pageOf, 2, "listed on page 3");
  // no replacement before the observation: another key is refused
  assert.equal(brief(await issue(fw, request(d, freshKey("r2-084-replacement")))), "REFUSED PAYMENT_UNCERTAIN SUBMISSION_UNRECONCILED");
  const reads = fw.route.pageReads.length;
  assert.equal((await reconcile(d)).kind, "SETTLED");
  assert.deepEqual(fw.route.pageReads.slice(reads), [null, ...Array.from({ length: pageOf }, (_, k) => String(k + 1))], "every page up to the one listing it");
  const issued = await doc(fw, inv.document_id);
  assert.equal(issued.state, "ISSUED");
  assert.equal(issued.provider_document_id, fw.route.listed()[index]!.providerDocumentId);
  assert.equal(fw.route.submits(d.issue_request_hash!), 1);
});

test("R2-084: a timeout on page k proves nothing; UNCERTAIN stays, and a re-observation re-reads every page", CELL, async () => {
  const rt = windowOf(1_000);
  const inv = await validatedInvoice(fw, "b15-page-timeout");
  if (fw.route.listed().length < 2 * PAGE_SIZE) fw.route.pad(2 * PAGE_SIZE);
  fw.route.script("LOST");
  assert.equal(brief(await issue(fw, request(inv, freshKey("r2-084-page-timeout")), rt)), "ANSWERED 202 UNCERTAIN");
  const d = await doc(fw, inv.document_id);
  await dbPast(fw, d.submit_deadline_at!);
  fw.route.failPage(1);
  try {
    assert.equal((await reconcile(d, rt)).kind, "OBSERVING");
  } finally {
    fw.route.failPage(null);
  }
  assert.deepEqual([(await doc(fw, inv.document_id)).state, (await doc(fw, inv.document_id)).rejection_code], ["UNCERTAIN", null]);
  // the re-observation reads from the first page again, every page, and only then may conclude the absence
  const reads = fw.route.pageReads.length;
  assert.equal((await reconcile(d, rt)).kind, "SETTLED");
  const pages = Math.ceil(fw.route.listed().length / PAGE_SIZE);
  assert.deepEqual(fw.route.pageReads.slice(reads), [null, ...Array.from({ length: pages - 1 }, (_, k) => String(k + 1))]);
  assert.deepEqual([(await doc(fw, inv.document_id)).state, (await doc(fw, inv.document_id)).rejection_code], ["REJECTED", "NOT_ISSUED_BY_DEADLINE"]);
  assert.equal(fw.route.submits(d.issue_request_hash!), 1);
});

test("R2-084: a partial page set never proves absence", CELL, async () => {
  const rt = windowOf(1_000);
  const inv = await validatedInvoice(fw, "b15-partial-pages");
  fw.route.script("LOST");
  assert.equal(brief(await issue(fw, request(inv, freshKey("r2-084-partial")), rt)), "ANSWERED 202 UNCERTAIN");
  const d = await doc(fw, inv.document_id);
  await dbPast(fw, d.submit_deadline_at!);
  const last = Math.ceil(fw.route.listed().length / PAGE_SIZE) - 1;
  for (const k of [0, last]) {
    fw.route.failPage(k);
    try {
      assert.equal((await reconcile(d, rt)).kind, "OBSERVING", `page ${k} unread`);
    } finally {
      fw.route.failPage(null);
    }
    assert.equal((await doc(fw, inv.document_id)).state, "UNCERTAIN");
  }
});

test("R2-084: RACE (expiry) NOT_FOUND observed before the submit deadline is not proof: UNCERTAIN, no second submit; an absence observed from after the deadline allows REJECTED", CELL, async () => {
  const rt = windowOf(2_000);
  const inv = await validatedInvoice(fw, "b15-expiry-absence");
  fw.route.script("LOST");
  assert.equal(brief(await issue(fw, request(inv, freshKey("r2-084-expiry")), rt)), "ANSWERED 202 UNCERTAIN");
  const d = await doc(fw, inv.document_id);
  // observed before the deadline: not due
  const early = await reconcile(d, rt);
  assert.equal(early.kind, "NOT_DUE");
  // the observation began before the deadline and its pages are read after it: still not proof (observedFrom is the judged instant)
  const hold = fw.holds.arm("OBSERVED_FROM_READ", inv.document_id, "WAIT");
  const straddling = tracked(reconcile(d, rt));
  await hold.reached;
  await dbPast(fw, d.submit_deadline_at!);
  hold.release();
  const late = await straddling.promise;
  assert.equal(late.kind, "NOT_DUE");
  if (late.kind === "NOT_DUE") assert.equal(Date.parse(late.deadline), d.submit_deadline_at!.getTime());
  assert.deepEqual([(await doc(fw, inv.document_id)).state, (await doc(fw, inv.document_id)).rejection_code], ["UNCERTAIN", null]);
  assert.equal(fw.route.submits(d.issue_request_hash!), 1);
  // an observation that began after the deadline over every page: the absence is proof
  assert.equal((await reconcile(d, rt)).kind, "SETTLED");
  assert.deepEqual([(await doc(fw, inv.document_id)).state, (await doc(fw, inv.document_id)).rejection_code], ["REJECTED", "NOT_ISSUED_BY_DEADLINE"]);
  assert.equal(fw.route.submits(d.issue_request_hash!), 1);
});

test("R2-084: the reconciler returns RETRY before the deadline and concludes after it", CELL, async () => {
  const rt = windowOf(1_500);
  const inv = await validatedInvoice(fw, "b15-reconciler-delivery");
  fw.holds.arm("INTENT_COMMITTED", inv.document_id, "CRASH");
  await assert.rejects(issue(fw, request(inv, freshKey("r2-084-delivery")), rt), SimulatedCrash);
  const d = await doc(fw, inv.document_id);
  const delivery = await deliveryOf(inv.document_id, "tax_document.submitting.v1");
  assert.equal(delivery.payload["orderId"], inv.order_id);
  await assert.rejects(reconcileFiscalDelivery(rt, delivery, clock.now()), (e: unknown) => e instanceof NotDueYet && Date.parse((e as NotDueYet).retryAt) === d.submit_deadline_at!.getTime());
  assert.equal((await doc(fw, inv.document_id)).state, "UNCERTAIN", "not due: the unknown submission is recorded UNCERTAIN, never REJECTED");
  await dbPast(fw, d.submit_deadline_at!);
  assert.equal(await reconcileFiscalDelivery(rt, await deliveryOf(inv.document_id, "tax_document.uncertain.v1"), clock.now()), "APPLIED");
  assert.equal((await doc(fw, inv.document_id)).state, "REJECTED");
  assert.equal(fw.route.submits(d.issue_request_hash!), 0, "a submission never sent is concluded by observation, never resent");
});

// --- the reconciler against the concluder ------------------------------------------------------------------------------------------

test("CMD035-RACE: the reconciler against the concluder, both orders: one terminal state", CELL, async () => {
  // order 1: the reconciler concludes while the concluder is between its submit and its conclusion
  const one = await validatedInvoice(fw, "b15-m21-one");
  const answered = fw.holds.arm("SUBMIT_ANSWERED", one.document_id, "WAIT");
  const key = freshKey("m21-one");
  const concluder = tracked(issue(fw, request(one, key)));
  await answered.reached;
  assert.equal((await reconcile(one)).kind, "SETTLED");
  answered.release();
  assert.equal(brief(await concluder.promise), "ANSWERED 200 ISSUED");
  assert.deepEqual(await eventsOf(fw, one.document_id), ISSUED_EVENTS);
  assert.deepEqual(await journalOf(fw, key), ["COMMITTED"]);

  // order 2: the concluder holds its row and halves; the reconciler waits at the row, then finds it concluded
  const two = await validatedInvoice(fw, "b15-m21-two");
  const answered2 = fw.holds.arm("SUBMIT_ANSWERED", two.document_id, "WAIT");
  const concluder2 = tracked(issue(fw, request(two, freshKey("m21-two"))));
  await answered2.reached;
  const atCommit = fw.holds.arm("CONCLUDE_BEFORE_COMMIT", two.document_id, "WAIT");
  answered2.release();
  await atCommit.reached;
  const reconciler = tracked(reconcile(two));
  await seenWaiting(fw, ROW_LOCK, "the reconciler waits at the concluder's row", { settled: reconciler.settled });
  atCommit.release();
  assert.equal(brief(await concluder2.promise), "ANSWERED 200 ISSUED");
  assert.equal((await reconciler.promise).kind, "SETTLED");
  assert.deepEqual(await eventsOf(fw, two.document_id), ISSUED_EVENTS);
});

// --- TIMEOUT, expiry -----------------------------------------------------------------------------------------------------------------

test("CMD035-RACE: TIMEOUT a lock wait past INJECTED_STATEMENT_TIMEOUT_MS is retryable, nothing written", CELL, async () => {
  const inv = await validatedInvoice(fw, "b15-lock-timeout");
  const { h } = fw.pw.w;
  const base = { host: "127.0.0.1", port: h.pg.port, database: ROLES.database, poolMax: 2 } as const;
  const pools = await openPaymentPools(fw.pw.w.db.pool, { payment: { ...base, user: ROLES.paymentLogin }, control: { ...base, user: ROLES.controlLogin }, ingress: { ...base, user: ROLES.ingressLogin } }, { clock, random: (n) => new Uint8Array(randomBytes(n)), statementTimeoutMs: INJECTED_STATEMENT_TIMEOUT_MS, environment: testDatabaseEnvironment("LOCAL") });
  const rt = { ...fw.rt, unitOfWork: pools.commerce };
  const key = freshKey("cmd035-lock-timeout");
  const x = await holder(fw);
  try {
    await x.query(DOC_X_HALF, [inv.document_id]);
    const started = Date.now();
    const timed = tracked(issue(fw, request(inv, key), rt));
    await seenWaiting(fw, DOC_X_WAIT, "CMD035 waits on the held exclusive half", { settled: timed.settled });
    const o = await timed.promise;
    const elapsed = Date.now() - started;
    assert.equal(brief(o), "REFUSED CAPACITY_UNAVAILABLE CAPACITY_UNAVAILABLE retryable");
    assert.ok(elapsed >= INJECTED_STATEMENT_TIMEOUT_MS && elapsed < INJECTED_STATEMENT_TIMEOUT_MS + LOCK_WAIT_OBSERVATION_MS, `the bound fired (${elapsed} ms)`);
  } finally {
    await x.rollback();
    await pools.close();
  }
  const d = await doc(fw, inv.document_id);
  assert.deepEqual([d.state, d.version, d.issue_request_hash], ["VALIDATED", inv.version, null]);
  assert.deepEqual(await journalOf(fw, key), []);
  // the retry, with nothing held, issues once
  assert.equal(brief(await issue(fw, request(inv, key))), "ANSWERED 200 ISSUED");
  assert.ok(raceStatementTimeoutMs() > INJECTED_STATEMENT_TIMEOUT_MS);
});

test("CMD035-DENY: RACE (expiry) the issuer valid_until passes while CMD035 waits on the document exclusive half: FISCAL_ISSUER_NOT_IN_FORCE, VALIDATED unchanged, no submit call", CELL, async () => {
  const inv = await validatedInvoice(fw, "b15-issuer-expiry");
  const oracle = fw.pw.w.h.oracle;
  const before = fw.route.totalSubmits();
  const x = await holder(fw);
  let refused: string;
  try {
    await x.query(DOC_X_HALF, [inv.document_id]);
    const until = (await oracle.query<{ valid_until: Date }>("UPDATE kauro.fiscal_issuers SET valid_until = kauro.effect_now() + interval '1500 milliseconds' WHERE issuer_ref = $1 RETURNING valid_until", [fw.pw.issuerRef])).rows[0]!.valid_until;
    const waiting = tracked(issue(fw, request(inv, freshKey("cmd035-issuer-expiry"))));
    // the last await before the effect instant is the exclusive half: the issuer is still in force while it waits
    await seenWaiting(fw, DOC_X_WAIT, "CMD035 waits on the document's exclusive half", { settled: waiting.settled });
    await dbPast(fw, until);
    await x.rollback();
    refused = brief(await waiting.promise);
  } finally {
    await oracle.query("UPDATE kauro.fiscal_issuers SET valid_until = NULL WHERE issuer_ref = $1", [fw.pw.issuerRef]);
  }
  assert.equal(refused, "REFUSED PRECONDITION_FAILED FISCAL_ISSUER_NOT_IN_FORCE");
  const d = await doc(fw, inv.document_id);
  assert.deepEqual([d.state, d.version, d.issue_request_hash], ["VALIDATED", inv.version, null]);
  assert.equal(fw.route.totalSubmits(), before);
  // the sibling with the issuer in force: issued
  assert.equal(brief(await issue(fw, request(inv, freshKey("cmd035-issuer-expiry-ok")))), "ANSWERED 200 ISSUED");
});

// --- credit notes waiting for their invoice (M19, M20, M6) ---------------------------------------------------------------------------

test("CMD035-RACE: a refund credit-note draft against the invoice issuance, both orders held at the invoice transition half: the note ends VALIDATED with the legal number", CELL, async () => {
  // order 1: the issuance holds the invoice's exclusive half (concluding ISSUED); the draft waits on its shared half and sees ISSUED
  const one = await validatedInvoice(fw, "b15-m19-one");
  const refundOne = await refunded(one, 1_000n);
  const atCommit = fw.holds.arm("CONCLUDE_BEFORE_COMMIT", one.document_id, "WAIT");
  const issuing = tracked(issue(fw, request(one, freshKey("m19-one"))));
  await atCommit.reached;
  const drafting = tracked(consume(await deliveryOf(refundOne, "refund.completed.v1")));
  await seenWaiting(fw, DOC_S_WAIT, "the credit note's draft waits on the invoice's half", { settled: drafting.settled });
  atCommit.release();
  assert.equal(brief(await issuing.promise), "ANSWERED 200 ISSUED");
  assert.equal(await drafting.promise, "APPLIED");
  const issuedOne = await doc(fw, one.document_id);
  const [noteOne] = await creditNotes(one);
  assert.deepEqual([noteOne!.state, noteOne!.corrects_document_id], ["VALIDATED", one.document_id]);
  assert.ok(issuedOne.legal_number !== null, "the note corrects an invoice with its legal number");

  // order 2: the draft holds the invoice's shared half; the conclusion waits on it, then the issued event validates the waiting note
  const two = await validatedInvoice(fw, "b15-m19-two");
  const refundTwo = await refunded(two, 1_000n);
  const answered = fw.holds.arm("SUBMIT_ANSWERED", two.document_id, "WAIT");
  const issuing2 = tracked(issue(fw, request(two, freshKey("m19-two"))));
  await answered.reached;
  let atHalf: () => void = () => undefined;
  const reachedHalf = new Promise<void>((resolve) => {
    atHalf = resolve;
  });
  let releaseHalf: () => void = () => undefined;
  const halfReleased = new Promise<void>((resolve) => {
    releaseHalf = resolve;
  });
  const drafting2 = tracked(consume(await deliveryOf(refundTwo, "refund.completed.v1"), async (point) => {
    if (point !== "CREDIT_NOTE_AFTER_INVOICE_HALF") return;
    atHalf();
    await halfReleased;
  }));
  await reachedHalf;
  answered.release();
  await seenWaiting(fw, DOC_X_WAIT, "the conclusion waits on the draft's shared half", { settled: issuing2.settled });
  releaseHalf();
  assert.equal(await drafting2.promise, "APPLIED");
  assert.equal(brief(await issuing2.promise), "ANSWERED 200 ISSUED");
  assert.equal((await creditNotes(two))[0]!.state, "DRAFT", "drafted while its invoice was not issued yet");
  assert.equal(await consume(await deliveryOf(two.document_id, "tax_document.issued.v1")), "APPLIED");
  assert.equal((await creditNotes(two))[0]!.state, "VALIDATED");

  // the interleaving the half closes: the draft read the invoice unlocked (SUBMITTING), the issuance concluded and its issued event
  // was delivered first (no note waiting yet); the draft re-reads under the half and validates the note itself
  const three = await validatedInvoice(fw, "b15-m19-three");
  const refundThree = await refunded(three, 1_000n);
  const answered3 = fw.holds.arm("SUBMIT_ANSWERED", three.document_id, "WAIT");
  const issuing3 = tracked(issue(fw, request(three, freshKey("m19-three"))));
  await answered3.reached;
  let atRead: () => void = () => undefined;
  const reachedRead = new Promise<void>((resolve) => {
    atRead = resolve;
  });
  let releaseRead: () => void = () => undefined;
  const readReleased = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const drafting3 = tracked(consume(await deliveryOf(refundThree, "refund.completed.v1"), async (point) => {
    if (point !== "CREDIT_NOTE_AFTER_INVOICE_READ") return;
    atRead();
    await readReleased;
  }));
  await reachedRead;
  answered3.release();
  assert.equal(brief(await issuing3.promise), "ANSWERED 200 ISSUED");
  assert.equal(await consume(await deliveryOf(three.document_id, "tax_document.issued.v1")), "DUPLICATE", "no note waits yet");
  releaseRead();
  assert.equal(await drafting3.promise, "APPLIED");
  assert.deepEqual((await creditNotes(three)).map((n) => n.state), ["VALIDATED"]);
});

test("CMD035-RACE: REEVALUATE holds a waiting credit note while CMD035 concludes ISSUED: no deadlock, the note validates once", CELL, async () => {
  const inv = await validatedInvoice(fw, "b15-m20");
  const refundId = await refunded(inv, 1_000n);
  assert.equal(await consume(await deliveryOf(refundId, "refund.completed.v1")), "APPLIED");
  const [waiting] = await creditNotes(inv);
  assert.deepEqual([waiting!.state, waiting!.blocked_reason], ["DRAFT", null]);
  const answered = fw.holds.arm("SUBMIT_ANSWERED", inv.document_id, "WAIT");
  const issuing = tracked(issue(fw, request(inv, freshKey("m20"))));
  await answered.reached;
  let atNote: () => void = () => undefined;
  const reachedNote = new Promise<void>((resolve) => {
    atNote = resolve;
  });
  let releaseNote: () => void = () => undefined;
  const noteReleased = new Promise<void>((resolve) => {
    releaseNote = resolve;
  });
  const reevaluating = tracked(
    fw.pw.pools.commerce.run({ kind: "SERVICE", serviceId: "payment-service", correlationId: ids.next() as CorrelationId }, async (uow) => {
      await uow.adoptScope("PAYMENT_ORDER", inv.order_id);
      return reevaluateBlockedDrafts(uow, clock.now(), 50, async (_point, documentId) => {
        if (documentId !== waiting!.document_id) return;
        atNote();
        await noteReleased;
      });
    }),
  );
  await reachedNote;
  answered.release();
  await seenWaiting(fw, DOC_X_WAIT, "the conclusion waits on the re-evaluation's shared half", { settled: issuing.settled });
  releaseNote();
  await reevaluating.promise;
  assert.equal(brief(await issuing.promise), "ANSWERED 200 ISSUED");
  assert.equal((await doc(fw, waiting!.document_id)).state, "DRAFT", "re-evaluated before the issuance: still waiting");
  assert.equal(await consume(await deliveryOf(inv.document_id, "tax_document.issued.v1")), "APPLIED");
  assert.equal((await doc(fw, waiting!.document_id)).state, "VALIDATED");
  // the other order: a re-evaluation after the issuance finds nothing waiting
  await fw.pw.pools.commerce.run({ kind: "SERVICE", serviceId: "payment-service", correlationId: ids.next() as CorrelationId }, async (uow) => {
    await uow.adoptScope("PAYMENT_ORDER", inv.order_id);
    await reevaluateBlockedDrafts(uow, clock.now());
  });
  assert.deepEqual(await eventsOf(fw, waiting!.document_id), ["tax_document.drafted.v1", "tax_document.validated.v1"], "validated once");
});

test("CMD035-RACE: issued.v1 re-delivered validates nothing twice", CELL, async () => {
  const inv = await validatedInvoice(fw, "b15-redelivery");
  const refundId = await refunded(inv, 1_000n);
  assert.equal(await consume(await deliveryOf(refundId, "refund.completed.v1")), "APPLIED");
  assert.equal(brief(await issue(fw, request(inv, freshKey("redelivery")))), "ANSWERED 200 ISSUED");
  const issued = await deliveryOf(inv.document_id, "tax_document.issued.v1");
  assert.equal(await consume(issued), "APPLIED");
  assert.equal(await consume(issued), "DUPLICATE");
  const [note] = await creditNotes(inv);
  assert.deepEqual(await eventsOf(fw, note!.document_id), ["tax_document.drafted.v1", "tax_document.validated.v1"]);
});

test("CMD035-RACE: the second credit note's validation fails: neither validated", CELL, async () => {
  const inv = await validatedInvoice(fw, "b15-two-notes");
  const r1 = await refunded(inv, 1_000n);
  const r2 = await refunded(inv, 2_000n);
  assert.equal(await consume(await deliveryOf(r1, "refund.completed.v1")), "APPLIED");
  assert.equal(await consume(await deliveryOf(r2, "refund.completed.v1")), "APPLIED");
  const notes = await creditNotes(inv);
  assert.equal(notes.length, 2);
  const second = [...notes].sort((a, b) => (a.document_id < b.document_id ? -1 : 1))[1]!;
  assert.equal(brief(await issue(fw, request(inv, freshKey("two-notes")))), "ANSWERED 200 ISSUED");
  const oracle = fw.pw.w.h.oracle;
  await oracle.query(`CREATE OR REPLACE FUNCTION public.b15_fail_note() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.document_id::text = '${second.document_id}' AND NEW.state = 'VALIDATED' THEN RAISE EXCEPTION 'injected: the second note fails'; END IF; RETURN NEW; END $$`);
  await oracle.query("CREATE TRIGGER b15_fail_note BEFORE UPDATE ON kauro.tax_documents FOR EACH ROW EXECUTE FUNCTION public.b15_fail_note()");
  const issued = await deliveryOf(inv.document_id, "tax_document.issued.v1");
  try {
    await assert.rejects(consume(issued));
  } finally {
    await oracle.query("DROP TRIGGER b15_fail_note ON kauro.tax_documents");
    await oracle.query("DROP FUNCTION public.b15_fail_note()");
  }
  assert.deepEqual((await creditNotes(inv)).map((n) => n.state), ["DRAFT", "DRAFT"], "one unit of work: neither validated");
  assert.equal(await consume(issued), "APPLIED");
  assert.deepEqual((await creditNotes(inv)).map((n) => n.state), ["VALIDATED", "VALIDATED"]);
});

// --- M17: each issuer column against the issuer's shared half (route_state last: QUALIFIED -> SUSPENDED is one-way) -----------------

interface ColumnChange {
  readonly column: string;
  readonly set: string;
  readonly restore: string | null;
  /** What CMD035 answers when the change committed first. */
  readonly afterChange: string;
}

async function columnRace(change: ColumnChange, seed: string): Promise<void> {
  const oracle = fw.pw.w.h.oracle;
  // order 1: CMD035 holds the issuer's shared half; the writer waits for it (and is rolled back after CMD035's intent committed)
  const one = await validatedInvoice(fw, `${seed}-1`);
  const atIssuer = fw.holds.arm("INTENT_AFTER_ISSUER_HALF", one.document_id, "WAIT");
  const cmd = tracked(issue(fw, request(one, freshKey(`${seed}-1`))));
  await atIssuer.reached;
  const w1 = await holder(fw);
  const writing = tracked(w1.client.query(change.set, [fw.pw.issuerRef]));
  await pidWaiting(fw, w1.pid, `${change.column}: the writer waits on CMD035's shared half`);
  assert.equal(writing.settled(), false);
  atIssuer.release();
  await writing.promise;
  await w1.rollback();
  assert.equal(brief(await cmd.promise), "ANSWERED 200 ISSUED", `${change.column} order 1`);

  // order 2: the writer holds the issuer's exclusive half; CMD035 waits for it and judges the committed change
  const two = await validatedInvoice(fw, `${seed}-2`);
  const w2 = await holder(fw);
  await w2.query(change.set, [fw.pw.issuerRef]);
  const cmd2 = tracked(issue(fw, request(two, freshKey(`${seed}-2`))));
  await seenWaiting(fw, ISSUER_S_WAIT, `${change.column}: CMD035 waits on the writer's exclusive half`, { holderPid: w2.pid, settled: cmd2.settled });
  await w2.commit();
  const answer = brief(await cmd2.promise);
  if (change.restore !== null) await oracle.query(change.restore, [fw.pw.issuerRef]);
  assert.equal(answer, change.afterChange, `${change.column} order 2`);
}

test("CMD035-DENY: RACE (revocation) each issuer column changed while CMD035 holds the issuer shared half, both orders", CELL, async () => {
  const original = await issuerColumns(fw, fw.pw.issuerRef);
  const validFromText = (await rows<{ v: string }>(fw.pw, "SELECT valid_from::text AS v FROM kauro.fiscal_issuers WHERE issuer_ref = $1", [fw.pw.issuerRef]))[0]!.v;
  const changes: ColumnChange[] = [
    { column: "legal_fact_status", set: "UPDATE kauro.fiscal_issuers SET legal_fact_status = 'OBSERVED' WHERE issuer_ref = $1", restore: "UPDATE kauro.fiscal_issuers SET legal_fact_status = 'PROFESSIONALLY_CONFIRMED' WHERE issuer_ref = $1", afterChange: "ANSWERED 200 ISSUED" },
    { column: "numbering_authorization_ref", set: "UPDATE kauro.fiscal_issuers SET numbering_authorization_ref = 'DIAN-18764000002' WHERE issuer_ref = $1", restore: `UPDATE kauro.fiscal_issuers SET numbering_authorization_ref = '${String(original["numbering_authorization_ref"])}' WHERE issuer_ref = $1`, afterChange: "ANSWERED 200 ISSUED" },
    { column: "entitlement_evidence_hash", set: `UPDATE kauro.fiscal_issuers SET entitlement_evidence_hash = '${sha("b15-entitlement-renewed")}' WHERE issuer_ref = $1`, restore: `UPDATE kauro.fiscal_issuers SET entitlement_evidence_hash = '${String(original["entitlement_evidence_hash"])}' WHERE issuer_ref = $1`, afterChange: "ANSWERED 200 ISSUED" },
    { column: "qualification_evidence_hashes", set: `UPDATE kauro.fiscal_issuers SET qualification_evidence_hashes = qualification_evidence_hashes || '["${sha("b15-qualification-2")}"]'::jsonb WHERE issuer_ref = $1`, restore: `UPDATE kauro.fiscal_issuers SET qualification_evidence_hashes = '${JSON.stringify(original["qualification_evidence_hashes"])}'::jsonb WHERE issuer_ref = $1`, afterChange: "ANSWERED 200 ISSUED" },
    { column: "valid_from", set: "UPDATE kauro.fiscal_issuers SET valid_from = kauro.effect_now() + interval '1 hour', valid_until = NULL WHERE issuer_ref = $1", restore: `UPDATE kauro.fiscal_issuers SET valid_from = '${validFromText}'::timestamptz WHERE issuer_ref = $1`, afterChange: "REFUSED PRECONDITION_FAILED FISCAL_ISSUER_NOT_IN_FORCE" },
    { column: "valid_until", set: "UPDATE kauro.fiscal_issuers SET valid_until = kauro.effect_now() WHERE issuer_ref = $1", restore: "UPDATE kauro.fiscal_issuers SET valid_until = NULL WHERE issuer_ref = $1", afterChange: "REFUSED PRECONDITION_FAILED FISCAL_ISSUER_NOT_IN_FORCE" },
  ];
  for (const change of changes) await columnRace(change, `b15-m17-${change.column}`);
  // route_state: order 1 here (the writer rolled back); order 2 commits the suspension (R2-083 DENY below)
  const one = await validatedInvoice(fw, "b15-m17-route_state-1");
  const atIssuer = fw.holds.arm("INTENT_AFTER_ISSUER_HALF", one.document_id, "WAIT");
  const cmd = tracked(issue(fw, request(one, freshKey("b15-m17-route_state-1"))));
  await atIssuer.reached;
  const w = await holder(fw);
  const writing = tracked(w.client.query("UPDATE kauro.fiscal_issuers SET route_state = 'SUSPENDED' WHERE issuer_ref = $1", [fw.pw.issuerRef]));
  await pidWaiting(fw, w.pid, "route_state: the writer waits on CMD035's shared half");
  atIssuer.release();
  await writing.promise;
  await w.rollback();
  assert.equal(brief(await cmd.promise), "ANSWERED 200 ISSUED");
  assert.deepEqual(await issuerColumns(fw, fw.pw.issuerRef), original, "every column restored");
});

test("R2-083: DENY a PROVIDER_API issuer that is not QUALIFIED or has no entitlement evidence (FISCAL_PROVIDER_ENTITLEMENT_UNVERIFIED), nothing submitted", CELL, async () => {
  const sibling = await validatedInvoice(fw, "b15-r2-083-sibling");
  const suspended = await validatedInvoice(fw, "b15-r2-083-suspended");
  const unentitled = await validatedInvoice(fw, "b15-r2-083-unentitled");
  // the OK sibling while the route is QUALIFIED with entitlement evidence
  assert.equal(brief(await issue(fw, request(sibling, freshKey("r2-083-ok")))), "ANSWERED 200 ISSUED");
  const before = fw.route.totalSubmits();
  // route_state order 2 (M17): the suspension holds the issuer's exclusive half; CMD035 waits and judges it
  const w = await holder(fw);
  await w.query("UPDATE kauro.fiscal_issuers SET route_state = 'SUSPENDED' WHERE issuer_ref = $1", [fw.pw.issuerRef]);
  const cmd = tracked(issue(fw, request(suspended, freshKey("r2-083-suspended"))));
  await seenWaiting(fw, ISSUER_S_WAIT, "CMD035 waits on the suspension", { holderPid: w.pid, settled: cmd.settled });
  await w.commit();
  assert.equal(brief(await cmd.promise), "REFUSED PRECONDITION_FAILED FISCAL_PROVIDER_ENTITLEMENT_UNVERIFIED");
  // no entitlement evidence at all
  await fw.pw.w.h.oracle.query("UPDATE kauro.fiscal_issuers SET entitlement_evidence_hash = NULL WHERE issuer_ref = $1", [fw.pw.issuerRef]);
  assert.equal(brief(await issue(fw, request(unentitled, freshKey("r2-083-unentitled")))), "REFUSED PRECONDITION_FAILED FISCAL_PROVIDER_ENTITLEMENT_UNVERIFIED");
  for (const d of [suspended, unentitled]) {
    const now = await doc(fw, d.document_id);
    assert.deepEqual([now.state, now.version, now.issue_request_hash], ["VALIDATED", d.version, null]);
  }
  assert.equal(fw.route.totalSubmits(), before, "nothing submitted");
  // the database's own backstop refuses the intent too (0074: judged at kauro.effect_now(), 23514)
  const backstop = await fw.pw.w.h.oracle
    .query("UPDATE kauro.tax_documents SET version = version + 1, state = 'SUBMITTING', issue_request_hash = $2, submit_deadline_at = now() + interval '1 minute' WHERE document_id = $1", [suspended.document_id, sha("b15-backstop")])
    .then(() => "WROTE", (e: { code?: string }) => e.code ?? "ERROR");
  assert.equal(backstop, "23514");
});
