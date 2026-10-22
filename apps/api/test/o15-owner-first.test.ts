// Order 15 (OWASP API5 BFLA, ASVS 5.0 V8.2 "function before object"): the corporate owner's bank refund commands — F2 (CMD032 naming the
// destination, CMD220 ApproveTreasuryRefund), X1 CMD221, G2 CMD222, X3 CMD223, G3 CMD224 and X4 CMD225 — run in units of work of the payment
// service, which sees every agency. A person without the KAURO_OWNER grant must be refused before any of it: the same refusal for an
// unknown id and for an existing refund or attempt of any agency, one durable denial in the person's own stream naming no agency, no
// restricted-store read and no lock on the account's OUTBOUND stream (which would delay the owner's real commands). The owner's own refusals and successes are the
// refund lane's (refund-generic-cells, ach-refund-cells); here the owner is only the control. Real routes, real composition root, real
// PostgreSQL 17 (the refund lane's integration world).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PAYMENT_APPLICATION_NAME } from "../src/index.js";
import { recordSeller } from "./sales-support.js";
import {
  DEST,
  L,
  approved,
  bankRefundRoutes,
  declared,
  destinationEvidence,
  isolatedLane,
  requested,
  startLane,
  stopLane,
  type AttemptView,
  type Source,
} from "./refund-lane-support.js";
import { asProblem, call, freshKey, ids, type BrowserSession, type Person, type Reply } from "./support.js";

after(async () => {
  await stopLane();
});

interface OwnerCommand {
  readonly name: string;
  /** The url naming an existing object (`id`) or an unknown one. */
  readonly url: (id: string) => string;
  readonly body: (proof: string, evidence: { readonly artifactRef: string; readonly evidenceHash: string }) => Record<string, unknown>;
}

const destinationBody = (serviceCents: string) => (proof: string, evidence: { readonly artifactRef: string; readonly evidenceHash: string }) => ({
  expectedVersion: 1,
  serviceCents,
  taxCents: "0",
  authorizationRef: proof,
  destination: DEST,
  destinationEvidence: evidence,
});
const evidenceBody = (proof: string, evidence: { readonly artifactRef: string; readonly evidenceHash: string }) => ({ evidence, authorizationRef: proof });

/** A shape of a refusal stripped of what legitimately differs between two requests (the correlation id, the date). */
function shape(reply: Reply): unknown {
  const { correlationId: _c, ...problem } = asProblem(L().iw.w, reply);
  const { "x-correlation-id": _h, date: _d, ...headers } = reply.headers;
  return { status: reply.status, problem, headers };
}

const outcomeOf = (reply: Reply): string => {
  const p = asProblem(L().iw.w, reply);
  return `${reply.status} ${p.code} ${p.reason ?? "-"}`;
};

async function denialOf(reply: Reply): Promise<{ readonly outcome: string; readonly reason: string | null; readonly requestedAgencyId: string | null; readonly actor: string | null } | null> {
  const r = await L().iw.w.h.oracle.query<{ outcome: string; reason_code: string | null; requested_agency_id: string | null; actor_id: string | null }>(
    "SELECT outcome, reason_code, requested_agency_id, actor_id FROM kauro.security_events WHERE correlation_id = $1",
    [String(reply.headers["x-correlation-id"])],
  );
  assert.ok(r.rows.length <= 1, "one fact per request");
  const row = r.rows[0];
  return row === undefined ? null : { outcome: row.outcome, reason: row.reason_code, requestedAgencyId: row.requested_agency_id, actor: row.actor_id };
}

let capture: Source;
let treasury: Source;
let attempt: AttemptView;
let evidence: { readonly artifactRef: string; readonly evidenceHash: string };
let outsiders: ReadonlyArray<{ readonly who: string; readonly person: Person }>;

before(async () => {
  await startLane();
  const { iw } = L();
  // an APPROVED capture refund of a selling agency with its destination captured, a REQUESTED treasury refund, and a DECLARED attempt
  capture = await requested("CAPTURE", "o15-first-capture");
  treasury = await requested("BANK_CREDIT", "o15-first-treasury");
  attempt = (await declared("CAPTURE", "o15-first-attempt")).attempt;
  const stored = await destinationEvidence("o15-first");
  evidence = { artifactRef: stored.artifactRef, evidenceHash: stored.evidenceHash };
  const seller = await recordSeller(iw.w, iw.owner.userId, "o15-first-seller");
  outsiders = [
    // the refunded agency's own BILLING member: the agency's money, never the owner's decision
    { who: "the refund's agency BILLING member", person: capture.agent!.billing },
    { who: "another agency's VIEWER", person: iw.w.viewer },
    { who: "an ACTIVE seller", person: seller.person },
    { who: "a verified person with no role", person: await iw.w.person("o15-first-no-role") },
  ];
});

test("O15 F-01 BFLA: every owner bank refund command refuses a person without the KAURO_OWNER grant identically for an unknown and an existing refund or attempt, naming no agency, before any lock", async () => {
  const { iw } = L();
  const commands: ReadonlyArray<OwnerCommand & { readonly existing: string }> = [
    { name: "F2 CMD032 (destination)", url: (id) => bankRefundRoutes.approveRefund(id), body: destinationBody(capture.serviceCents.toString()), existing: capture.refundId },
    { name: "F2 CMD220", url: (id) => bankRefundRoutes.approveTreasuryRefund(id), body: destinationBody("25000"), existing: treasury.refundId },
    { name: "X1 CMD221", url: (id) => bankRefundRoutes.declareExecution(id), body: (proof) => ({ expectedVersion: 2, amountCents: "1", authorizationRef: proof }), existing: capture.refundId },
    { name: "G2 CMD222", url: (id) => bankRefundRoutes.recordExecution(id), body: evidenceBody, existing: attempt.attemptId },
    { name: "X3 CMD223", url: (id) => bankRefundRoutes.resolveUncertain(id), body: (proof, ev) => ({ outcome: "EXECUTED", evidence: ev, authorizationRef: proof }), existing: attempt.attemptId },
    { name: "G3 CMD224", url: (id) => bankRefundRoutes.recordBounce(id), body: (proof, ev) => ({ bouncedCents: "1", evidence: ev, authorizationRef: proof }), existing: attempt.attemptId },
    { name: "X4 CMD225", url: (id) => bankRefundRoutes.declareResend(id), body: (proof) => ({ amountCents: "1", authorizationRef: proof }), existing: attempt.attemptId },
  ];
  const failures: string[] = [];
  const storeReads = (): number => L().bw.evidence.calls.filter((c) => c.port === "BankEvidenceStore" && c.operation === "GET").length;
  const readsBefore = storeReads();
  for (const { who, person } of outsiders) {
    for (const c of commands) {
      const proof = await iw.w.stepUp(person);
      const send = (id: string) => call(iw.w, { url: c.url(id), token: person.token, agency: null, key: freshKey("o15-first"), body: c.body(proof, evidence) });
      const existing = await send(c.existing);
      const unknown = await send(ids.next());
      const what = `${c.name} by ${who}`;
      if (outcomeOf(existing) !== "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING") failures.push(`${what} (existing): ${outcomeOf(existing)}`);
      if (JSON.stringify(shape(existing)) !== JSON.stringify(shape(unknown))) failures.push(`${what}: an existing and an unknown id answer differently (${outcomeOf(existing)} / ${outcomeOf(unknown)})`);
      const fact = await denialOf(existing);
      if (fact?.outcome !== "DENY" || fact.reason !== "CORPORATE_ROLE_MISSING" || fact.requestedAgencyId !== null || fact.actor !== person.userId) failures.push(`${what}: the durable denial ${JSON.stringify(fact)} is missing, names an agency or is not the person's`);
    }
  }
  assert.deepEqual(failures, []);
  assert.equal(storeReads(), readsBefore, "no restricted-store read for a person without the grant");
});

test("O15 F-01 BFLA: a person without the grant takes no lock on the account's OUTBOUND stream (X1 is refused while the stream is held, never queued behind it)", async () => {
  const { iw, bw } = L();
  const src = await approved("CAPTURE", "o15-first-lock");
  const outsider = outsiders[1]!.person;
  const held = await bw.holdOutboundStream();
  try {
    const proof = await iw.w.stepUp(outsider);
    const pending = call(iw.w, { url: bankRefundRoutes.declareExecution(src.refundId), token: outsider.token, agency: null, key: freshKey("o15-first-lock"), body: { expectedVersion: 2, amountCents: src.totalCents.toString(), authorizationRef: proof } });
    const observed = await settlesOrWaitsOnStream(pending);
    assert.equal(observed, "SETTLED", "the outsider's request waited on the owner's OUTBOUND stream lock");
    assert.equal(outcomeOf(await pending), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  } finally {
    await held.release();
  }
});

test("O15 F-01 control: the corporate owner still declares the execution of an approved refund (X1 201)", async () => {
  const { iw } = L();
  const src = await approved("CAPTURE", "o15-first-control");
  const reply = await call(iw.w, { url: bankRefundRoutes.declareExecution(src.refundId), token: iw.owner.token, agency: null, key: freshKey("o15-first-control"), body: { expectedVersion: 2, amountCents: src.totalCents.toString(), authorizationRef: await iw.w.stepUp(iw.owner) } });
  assert.equal(reply.status, 201, reply.text);
});

test("O15 F-02 rule 16: an owner approval naming the destination is not committed once the browser session it was sent under is revoked while it waits", async () => {
  await isolatedLane(
    async () => {
      const { iw, bw } = L();
      for (const scope of ["CAPTURE", "BANK_CREDIT"] as const) {
        const src = await requested(scope, `o15-f02-${scope}`);
        const stored = await destinationEvidence(`o15-f02-${scope}`);
        const session: BrowserSession = await iw.w.identity().signIn(iw.owner);
        const url = scope === "CAPTURE" ? bankRefundRoutes.approveRefund(src.refundId) : bankRefundRoutes.approveTreasuryRefund(src.refundId);
        const body = { ...destinationBody(src.serviceCents.toString())(await iw.w.stepUp(iw.owner), { artifactRef: stored.artifactRef, evidenceHash: stored.evidenceHash }), taxCents: src.taxCents.toString() };
        const held = await bw.holdOutboundStream();
        let pending: Promise<Reply>;
        try {
          pending = call(iw.w, { url, token: null, agency: null, key: freshKey(`o15-f02-${scope}`), body, headers: { cookie: session.cookie, origin: iw.w.identity().origin, "x-kauro-csrf": session.view.csrfToken } });
          assert.equal(await settlesOrWaitsOnStream(pending), "WAITING", `${scope}: the owner's approval waits at L1`);
          const revoked = await iw.w.h.oracle.query("UPDATE kauro.web_sessions SET revoked_at = now(), revoke_reason = 'LOGOUT' WHERE secret_sha256 = $1 AND revoked_at IS NULL RETURNING 1", [session.secretSha256]);
          assert.equal(revoked.rowCount, 1, `${scope}: the presented session is revoked`);
        } finally {
          await held.release();
        }
        const reply = await pending;
        assert.equal(reply.status, 401, `${scope}: the approval after the session ended: ${reply.text}`);
        const state = await iw.w.h.oracle.query<{ state: string }>(scope === "CAPTURE" ? "SELECT state FROM kauro.refunds WHERE refund_id = $1" : "SELECT state FROM kauro.treasury_refunds WHERE treasury_refund_id = $1", [src.refundId]);
        assert.equal(state.rows[0]?.state, "REQUESTED", `${scope}: nothing approved`);
      }
    },
    { sessions: true },
  );
});

/**
 * Whether `operation` settles while the OUTBOUND stream is held, or a backend of the payment service waits on that stream's advisory lock
 * (pg_locks: an ungranted advisory lock of a kauro-api-payment backend). Bounded: neither within ten seconds throws.
 */
async function settlesOrWaitsOnStream(operation: Promise<unknown>): Promise<"SETTLED" | "WAITING"> {
  let settled = false;
  void operation.then(
    () => (settled = true),
    () => (settled = true),
  );
  const oracle = L().iw.w.h.oracle;
  for (let i = 0; i < 1000; i++) {
    if (settled) return "SETTLED";
    const r = await oracle.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory' AND NOT l.granted AND a.application_name LIKE $1 || '%'",
      [PAYMENT_APPLICATION_NAME],
    );
    if (settled) return "SETTLED";
    if (Number(r.rows[0]?.n) > 0) return "WAITING";
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the request neither settled nor waited on the OUTBOUND stream within ten seconds");
}
