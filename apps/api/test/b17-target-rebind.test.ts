// B17 L7, T7 (docs/design/B15-B17-B18-local-plan.md sections 3 meeting row 3, 5 M8; R2-026 REPAIR): a paid ACTIVE authorization whose
// target contract CMD019 superseded re-binds at no charge to the quote of the re-check plan CMD019 bore for the paid plan, once that plan is
// validated and approved against the newer contract with the same revision, mode, band and terms: CreateQuote on the re-check plan takes
// the drift branch of the included replacement (replacement.ts issueReplacement), and the payment service's PurchaseRebinder records the
// re-binding TARGET_DRIFT_REPAIR (no included source replacement spent, KAURO_TARGET_REPAIR_V1 lineage), revokes the old authorization
// TARGET_REPAIRED and issues the new one on the same capture. Real routes over the real units of work and PostgreSQL 17; every actor uses
// only ids the routes emitted (r24b): the re-check plan id from CMD019's answer, the quote ids from CreateQuote's answers.
//
// Holds: a tenant unit is held at a named port call (instrumentPort `<port>.<method>.after`, its locks taken), CreateQuote between its
// steps by the quote hook (INTENT_BEFORE_COMMIT, AFTER_INTENT, AFTER_SETTLE), and the payment service's re-binding inside its SERVICE unit
// of work by the test's re-binder: B09's own PurchaseRebinder over the unit with its `commerce.authorizations` and `commerce.rebindings`
// instrumented (`pay.<port>.<method>`), passing `rebind.after` after its last write, before its COMMIT, with every lock it took held.
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import type { CreateQuoteView, PurchaseRebinder, QuoteHoldPoint, TargetContractView } from "@kauro/application";
import { ContractFakeBuyerTypeReader } from "@kauro/application/testing";
import type { PlanId } from "@kauro/domain";
import { targetRepairLineageHash, toUtcInstant } from "@kauro/domain";
import { FaultPoints, INJECTED_STATEMENT_TIMEOUT_MS, LOCK_WAIT_POLL_ATTEMPTS, LOCK_WAIT_POLL_INTERVAL_MS, instrumentPort, openConnection, paidPurchase, serverNow } from "@kauro/persistence/testing";
import { createPurchaseRebinder } from "../src/index.js";
import { sourceLineageReader } from "../src/edition.js";
import { paymentRoutes, paymentsWorld, type PaymentsWorld } from "./commerce-support.js";
import { endLiveJobs, execute, jobsOfAuthorization, suspendCapability } from "./execution-support.js";
import { SimulatedCrash, approveThroughRoute, call, clock, completed, freshKey, ids, outcome, rawEvent, sha, type PlanFixture, type Reply, type World } from "./support.js";

// --- the world ------------------------------------------------------------------------------------------------------------------------

let statementTimeoutMs: number | null = null;
const points = new FaultPoints();
const pidAt = new Map<string, number>();
const PORTS = new Set(["targetContracts", "plans", "approvals", "projects"]);

const pidOf = (uow: unknown): number | undefined => (uow as { readonly client?: { readonly processID?: number } }).client?.processID;

function instrumentedUnit(uow: object): object {
  const pid = pidOf(uow);
  return new Proxy(uow, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof prop === "string" && PORTS.has(prop) && typeof value === "object" && value !== null) {
        const port = instrumentPort(value, points, prop);
        return new Proxy(port, {
          get(p, method) {
            const f: unknown = Reflect.get(p, method, p);
            if (typeof f !== "function" || typeof method !== "string") return f;
            return (...args: unknown[]) => {
              if (typeof pid === "number") pidAt.set(`${prop}.${method}`, pid);
              return (f as (...a: unknown[]) => unknown)(...args);
            };
          },
        });
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function instrumented<F extends object>(inner: F): F {
  return new Proxy(inner, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if ((prop === "run" || prop === "runSource") && typeof value === "function") {
        return (context: unknown, work: (uow: unknown) => Promise<unknown>, options?: Record<string, unknown>) =>
          (value as (...a: unknown[]) => Promise<unknown>).call(target, context, async (uow: unknown) => work(instrumentedUnit(uow as object)), statementTimeoutMs === null ? options : { ...(options ?? {}), statementTimeoutMs });
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** The payment service's SERVICE unit with its authorization and re-binding repositories instrumented as `pay.<port>`. */
function paymentUnit<U extends object>(uow: U): U {
  const commerce = (uow as unknown as { readonly commerce: Record<string, unknown> }).commerce;
  // over an empty target: the unit's `commerce` is frozen, and a proxy may not answer a frozen target's property with anything but its own value
  const wrapped = new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      const value: unknown = Reflect.get(commerce, prop, commerce);
      if ((prop === "authorizations" || prop === "rebindings") && typeof value === "object" && value !== null) return instrumentPort(value, points, `pay.${prop}`);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(commerce) : value;
    },
  });
  return new Proxy(uow, {
    get(target, prop) {
      if (prop === "commerce") return wrapped;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** B09's PurchaseRebinder with B07's lineage, run over the instrumented SERVICE unit; `rebind.after` is passed before its COMMIT. */
const real = createPurchaseRebinder({ lineage: sourceLineageReader });
const rebinder: PurchaseRebinder = {
  async rebind(uow, input) {
    const pid = pidOf(uow);
    if (typeof pid === "number") pidAt.set("rebind", pid);
    const out = await real.rebind(paymentUnit(uow), input);
    await points.pass("rebind.after");
    return out;
  },
};

/** CreateQuote's own hold points (QuoteCollaborators.hold): PAUSE holds the request there, CRASH dies there. */
class QuoteHolds {
  readonly #armed = new Map<QuoteHoldPoint, { readonly mode: "PAUSE" | "CRASH"; readonly reached: () => void; readonly release: Promise<void> }>();
  arm(point: QuoteHoldPoint, mode: "PAUSE" | "CRASH"): { readonly reached: Promise<void>; release(): void } {
    let reached: () => void = () => undefined;
    const reachedP = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => undefined;
    const releaseP = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#armed.set(point, { mode, reached, release: releaseP });
    return { reached: reachedP, release: () => release() };
  }
  readonly hook = async (point: QuoteHoldPoint): Promise<void> => {
    const armed = this.#armed.get(point);
    if (armed === undefined) return;
    this.#armed.delete(point);
    armed.reached();
    if (armed.mode === "CRASH") throw new SimulatedCrash(`at ${point}`);
    await armed.release;
  };
}
const quoteHolds = new QuoteHolds();
const buyer = new ContractFakeBuyerTypeReader({ clock });

let pw: PaymentsWorld;
let w: World;
before(async () => {
  pw = await paymentsWorld({ unbound: ["capacity"], wrapUnitOfWork: instrumented, quotes: () => ({ buyerType: buyer, hold: quoteHolds.hook, rebinder }) });
  w = pw.w;
  buyer.set(w.A.agencyId, "AGENCY");
});
after(async () => {
  await pw.stop();
});
afterEach(async () => {
  statementTimeoutMs = null;
  await endLiveJobs(pw);
});

// --- instruments -----------------------------------------------------------------------------------------------------------------------

async function waiterOn(holderPid: number, settled: () => boolean, what: string): Promise<number> {
  for (let attempt = 0; attempt < LOCK_WAIT_POLL_ATTEMPTS; attempt++) {
    if (settled()) throw new Error(`${what}: the waiter finished without waiting on the holder's lock`);
    const r = await w.h.oracle.query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND $1::int = ANY (pg_blocking_pids(pid))", [holderPid]);
    if (r.rows.length === 1) return r.rows[0]!.pid;
    if (r.rows.length > 1) throw new Error(`${what}: ${r.rows.length} backends wait on the holder, not the one waiter`);
    await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_POLL_INTERVAL_MS));
  }
  throw new Error(`${what}: the waiter was never seen waiting on the holder's lock`);
}

function tracked<T>(p: Promise<T>): { readonly promise: Promise<T>; readonly settled: () => boolean } {
  let done = false;
  const promise = p.finally(() => {
    done = true;
  });
  return { promise, settled: () => done };
}

/** Holds the actor at the instrumented `point` (after its statement) and returns its backend once it is there. */
async function hold<T>(point: string, start: () => Promise<T>): Promise<{ readonly actor: { readonly promise: Promise<T>; readonly settled: () => boolean }; readonly pid: number; release(): void }> {
  const pause = points.pause(`${point}.after`);
  const actor = tracked(start());
  await pause.reachedBy(actor.promise);
  const pid = pidAt.get(point);
  assert.ok(pid !== undefined, `the holder's backend at ${point}`);
  return { actor, pid, release: () => pause.release() };
}

/** Holds the payment service's re-binding before its COMMIT (every lock it took held) and returns its backend. */
async function holdRebind<T>(start: () => Promise<T>): Promise<{ readonly actor: { readonly promise: Promise<T>; readonly settled: () => boolean }; readonly pid: number; release(): void }> {
  const pause = points.pause("rebind.after");
  const actor = tracked(start());
  await pause.reachedBy(actor.promise);
  const pid = pidAt.get("rebind");
  assert.ok(pid !== undefined, "the re-binding's backend");
  return { actor, pid, release: () => pause.release() };
}

// --- B: a newer contract through CMD018 and CMD019 -------------------------------------------------------------------------------------

const OBJECTS = [{ apiName: "Contact", operations: ["CREATE", "UPDATE"], fields: [{ apiName: "email", dataType: "TEXT", createable: true, updateable: true, requiredOnCreate: false, allowedValues: [], clearMechanism: "UNSUPPORTED", unique: true, nillable: true }], identifierFields: ["email"], relationships: [] }];

async function currentOf(projectId: string): Promise<{ readonly contractId: string; readonly bodyHash: string; readonly instanceId: string; readonly observedAt: Date; readonly mode: string }> {
  const r = await w.row<{ contract_id: string; body_hash: string; instance_id: string; observed_at: Date; mode: string }>("target_contracts", "project_id = $1 AND confirmed_at IS NOT NULL AND superseded_at IS NULL", [projectId]);
  assert.ok(r, "the project's current contract");
  return { contractId: r.contract_id, bodyHash: r.body_hash, instanceId: r.instance_id, observedAt: r.observed_at, mode: r.mode };
}

async function storeArtifact(projectId: string, instanceId: string, mode: string, kind: "METADATA" | "CONFIRMATION_EVIDENCE", document: Record<string, unknown>): Promise<string> {
  const artifactRef = ids.next();
  await w.asTenant(w.A, (conn) =>
    conn.query(
      "INSERT INTO kauro.target_artifacts (artifact_id, agency_id, project_id, kind, mode, instance_id, document, content_hash, created_by_membership_id) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)",
      [artifactRef, w.A.agencyId, projectId, kind, mode, instanceId, JSON.stringify(document), sha(JSON.stringify(document) + artifactRef), w.A.ownerMembershipId],
    ),
  );
  return artifactRef;
}

interface Newer {
  readonly draft: TargetContractView;
  readonly body: Record<string, unknown>;
}
/** A re-observation of the project's current instance (identical objects), `afterMs` after the current one, as a DRAFT through CMD018. */
async function newerDraft(projectId: string, afterMs = 1): Promise<Newer> {
  const current = await currentOf(projectId);
  const observedAt = toUtcInstant(current.observedAt.getTime() + afterMs);
  assert.ok(observedAt <= toUtcInstant(Date.parse(await serverNow(w.h.oracle))), "the re-observation is not ahead of the database clock");
  const metadata = await storeArtifact(projectId, current.instanceId, current.mode, "METADATA", { importerVersion: "R2-INITIAL", capabilityVersion: "R2-INITIAL", observedAt, objects: OBJECTS });
  const draft = completed<TargetContractView>(await call(w, { url: `/api/v1/projects/${projectId}/target-contracts`, token: w.operator.token, key: freshKey("t7-cmd018"), body: { metadataArtifactRef: metadata, importerProfileId: ids.next() } }), 201).data;
  const evidence = await storeArtifact(projectId, current.instanceId, current.mode, "CONFIRMATION_EVIDENCE", { shown: "complete body and destination scope" });
  return { draft, body: { expectedVersion: draft.version, bodyHash: draft.bodyHash, confirmationEvidenceRef: evidence } };
}
const confirm = (newer: Newer, key: string = freshKey("t7-cmd019")): Promise<Reply> =>
  call(w, { url: `/api/v1/target-contracts/${newer.draft.contractId}/confirm`, token: w.approver.token, key, body: newer.body });

// --- the REPAIR path: a paid purchase, its drifted target, the re-check plan validated and approved ---------------------------------

/** A purchase paid by one capture that alone pays it, over a plan approved through CMD025 that froze 120 billable units. */
interface Paid {
  readonly projectId: string;
  readonly plan: PlanFixture;
  readonly quoteId: string;
  readonly orderId: string;
  readonly captureId: string;
  readonly authorizationId: string;
}
async function paidOn(label: string, mode: "CLEAN" | "HUBSPOT" = "CLEAN"): Promise<Paid> {
  const { projectId } = await w.project(w.A, w.clientA, { mode });
  const plan = await w.approvable(w.A, projectId, label, "SET", { recent: true, billableSourceUnits: 120, mode });
  await approveThroughRoute(w, plan);
  const purchase = await paidPurchase(w.h, { agency: w.A, planId: plan.planId as PlanId, route: pw.route, issuerRef: pw.issuerRef, profileId: pw.profileId, treatment: "EXEMPT_EXPORT", billableUnits: 120 });
  return { projectId, plan, quoteId: purchase.quoteId, orderId: purchase.orderId, captureId: purchase.captureId, authorizationId: purchase.authorizationId };
}

/** CMD019 confirms a newer contract of the paid project; its answer names the re-check plan of the paid plan (r24b). */
async function drifted(sale: Paid): Promise<{ readonly recheckPlanId: string; readonly newer: Newer }> {
  const newer = await newerDraft(sale.projectId);
  const view = completed<TargetContractView>(await confirm(newer), 200).data;
  assert.equal(view.recheckPlanIds?.length, 1, "one re-check plan for the paid plan");
  return { recheckPlanId: view.recheckPlanIds![0]!, newer };
}

/**
 * The re-check plan validated (VALIDATION_REQUIRED -> VALIDATING by the request side, the independent validator's VALID receipt,
 * VALIDATING -> VALIDATED on its edge), as the world's plan fixture writes the lifecycle, read back as a plan fixture.
 */
async function validated(recheckPlanId: string): Promise<PlanFixture> {
  const row = await w.row<{ version: number; body: PlanFixture["body"]; body_hash: string; project_id: string; revision_hash: string; target_contract_hash: string; state: string }>("plans", "plan_id = $1", [recheckPlanId]);
  assert.ok(row, "the re-check plan exists");
  assert.equal(row.state, "VALIDATION_REQUIRED", "the re-check waits for its validation");
  const planId = recheckPlanId as PlanId;
  const bodyHash = row.body_hash as PlanFixture["bodyHash"];
  const affectedRows = 120;
  let version = Number(row.version);
  const ev = (c: Parameters<Parameters<World["asTenant"]>[1]>[0], v: number, eventType: string, payload: Record<string, string | number | boolean>): Promise<void> =>
    rawEvent(c, { aggregateKind: "plan", aggregateId: planId, aggregateVersion: v, agencyId: w.A.agencyId, eventType, actorUserId: w.A.ownerUserId, payload });
  await w.asTenant(w.A, async (c) => {
    await c.query("UPDATE kauro.plans SET state = 'VALIDATING', version = $2 WHERE plan_id = $1", [planId, version + 1]);
    await ev(c, version + 1, "plan.validating.v1", { planId, agencyId: w.A.agencyId, bodyHash });
  });
  version += 1;
  const receiptHash = sha(`receipt-${planId}`) as NonNullable<PlanFixture["receiptHash"]>;
  const counts = { physicalSourceRows: affectedRows, logicalSourceRecords: affectedRows, billableSourceUnits: affectedRows, associationEdges: 0, emittedRepresentatives: affectedRows, mergedNonSurvivors: 0, rejected: 0, withheld: 0, unresolved: 0, emittedArtifactRows: affectedRows };
  const completedMs = Date.now();
  await w.h.recordValidationReceipt({
    receiptId: ids.next() as never,
    agencyId: w.A.agencyId,
    planId,
    receiptHash,
    revisionHash: row.revision_hash as PlanFixture["revisionHash"],
    targetContractHash: row.target_contract_hash as PlanFixture["targetContractHash"],
    planHash: bodyHash,
    corePackageHash: sha("core"),
    profileEvidenceHash: sha("profile"),
    dispositionEvidenceHash: sha("disposition"),
    artifactEvidenceHash: sha("artifact"),
    startedAt: toUtcInstant(completedMs - 60_000),
    completedAt: toUtcInstant(completedMs),
    result: "VALID",
    counts,
    blockingIssueCodes: [],
  });
  await w.asTenant(w.A, async (c) => {
    await c.query("UPDATE kauro.plans SET state = 'VALIDATED', version = $2, validation_receipt_hash = $3 WHERE plan_id = $1", [planId, version + 1, receiptHash]);
    await ev(c, version + 1, "plan.validated.v1", { planId, agencyId: w.A.agencyId, bodyHash, validationReceiptHash: receiptHash });
  });
  version += 1;
  return {
    planId,
    projectId: row.project_id as PlanFixture["projectId"],
    version,
    state: "VALIDATED",
    body: row.body,
    bodyHash,
    revisionHash: row.revision_hash as PlanFixture["revisionHash"],
    targetContractHash: row.target_contract_hash as PlanFixture["targetContractHash"],
    receiptHash,
    affectedRows,
  };
}

/** A paid purchase whose target drifted, its re-check plan validated and approved through CMD025: ready for REPAIR. */
async function repairable(label: string, mode: "CLEAN" | "HUBSPOT" = "CLEAN"): Promise<{ readonly sale: Paid; readonly recheck: PlanFixture; readonly newer: Newer }> {
  const sale = await paidOn(label, mode);
  const { recheckPlanId, newer } = await drifted(sale);
  const recheck = await validated(recheckPlanId);
  await approveThroughRoute(w, recheck);
  return { sale, recheck, newer };
}

/** CMD027 CreateQuote on the re-check plan by the agency's billing member. */
const quoteOn = (plan: Pick<PlanFixture, "planId" | "projectId">, key: string = freshKey("t7-cmd027")): Promise<Reply> =>
  call(w, { url: `/api/v1/projects/${plan.projectId}/quotes`, token: w.billing.token, key, body: { planId: plan.planId, billingProfileRef: pw.profileId } });
const quoteView = (reply: Reply): CreateQuoteView => completed<CreateQuoteView>(reply, 201).data;

type Rebinding = { rebinding_id: string; reason_code: string; from_quote_id: string; to_quote_id: string; from_authorization_id: string; allowance_ordinal: number; lineage_evidence_hash: string };
const rebindingsOf = async (captureId: string): Promise<ReadonlyArray<Rebinding>> => (await w.h.oracle.query<Rebinding>("SELECT * FROM kauro.purchase_rebindings WHERE capture_id = $1 ORDER BY created_at", [captureId])).rows;
const authorization = (id: string) => w.row<{ state: string; revocation_code: string | null; capture_id: string; quote_id: string; target_contract_hash: string; rebinding_id: string | null }>("commercial_authorizations", "authorization_id = $1", [id]);
const liveOfCapture = (captureId: string) => w.row<{ authorization_id: string; state: string; target_contract_hash: string; quote_id: string }>("commercial_authorizations", "capture_id = $1 AND state <> 'REVOKED'", [captureId]);
/** CMD036 on an authorization of the project. */
const executeOn = (projectId: string, authorizationId: string): Promise<Reply> => execute(pw, { projectId, authorizationId } as unknown as Parameters<typeof execute>[1]);
const quotesOf = (projectId: string): Promise<number> => w.count("quotes", "project_id = $1", [projectId]);
const charges = async (projectId: string): Promise<readonly [number, number]> => [await w.count("payment_orders", "project_id = $1", [projectId]), await w.count("capture_facts", "order_id IN (SELECT order_id FROM kauro.payment_orders WHERE project_id = $1)", [projectId])];

/** Nothing of the repair was recorded: the old authorization ACTIVE and live, no re-binding. */
async function notRepaired(sale: Paid, what: string): Promise<void> {
  assert.deepEqual(await rebindingsOf(sale.captureId), [], `${what}: 0 rebindings`);
  const old = await authorization(sale.authorizationId);
  assert.deepEqual([old?.state, old?.revocation_code], ["ACTIVE", null], `${what}: the old authorization ACTIVE`);
  assert.equal((await liveOfCapture(sale.captureId))?.authorization_id, sale.authorizationId, `${what}: still the capture's live authorization`);
}

/** The one TARGET_DRIFT_REPAIR re-binding of the purchase, and its effects. */
async function repairedOnce(sale: Paid, recheck: PlanFixture, toQuoteId: string, what: string): Promise<string> {
  const rebindings = await rebindingsOf(sale.captureId);
  assert.equal(rebindings.length, 1, `${what}: exactly one re-binding`);
  const r = rebindings[0]!;
  assert.deepEqual([r.reason_code, r.from_quote_id, r.to_quote_id, r.from_authorization_id, Number(r.allowance_ordinal)], ["TARGET_DRIFT_REPAIR", sale.quoteId, toQuoteId, sale.authorizationId, 1], `${what}: a drift repair of the paid quote`);
  assert.equal(r.lineage_evidence_hash, targetRepairLineageHash(sale.plan.targetContractHash, recheck.targetContractHash), `${what}: the KAURO_TARGET_REPAIR_V1 lineage`);
  const old = await authorization(sale.authorizationId);
  assert.deepEqual([old?.state, old?.revocation_code], ["REVOKED", "TARGET_REPAIRED"], `${what}: the old authorization revoked TARGET_REPAIRED`);
  const live = await liveOfCapture(sale.captureId);
  assert.ok(live, `${what}: the capture's new authorization`);
  assert.deepEqual([live.state, live.quote_id, live.target_contract_hash], ["ACTIVE", toQuoteId, recheck.targetContractHash], `${what}: issued on the same capture under the newer contract`);
  return live.authorization_id;
}

// --- R2-026 REPAIR: OK ---------------------------------------------------------------------------------------------------------------

test("R2-026: OK an ACTIVE authorization re-binds at no charge to a plan revalidated against the newer contract with the same scope and price; CMD036 then queues", async () => {
  const { sale, recheck } = await repairable("t7-ok");
  const before = await charges(sale.projectId);
  // before the repair: the paid authorization is stale, not consumed
  assert.equal(outcome(w, await executeOn(sale.projectId, sale.authorizationId)), "422 TARGET_STALE -");
  const view = quoteView(await quoteOn(recheck));
  assert.deepEqual([view.replacement?.outcome, view.replacement?.replacedQuoteId, view.replacement?.revokedAuthorizationId, view.quote.state], ["REBOUND", sale.quoteId, sale.authorizationId, "ACCEPTED_FOR_CHECKOUT"]);
  // the forbidden effect first: no charge
  assert.deepEqual(await charges(sale.projectId), before, "0 new orders and 0 new captures: no charge");
  const repaired = await repairedOnce(sale, recheck, view.quote.quoteId, "REPAIR");
  const paidQuote = await w.row<{ state: string; superseded_by_quote_id: string | null }>("quotes", "quote_id = $1", [sale.quoteId]);
  assert.deepEqual([paidQuote?.state, paidQuote?.superseded_by_quote_id], ["SUPERSEDED", view.quote.quoteId]);
  // the repair spent no included source replacement: none counted
  assert.equal(await w.count("purchase_rebindings", "capture_id = $1 AND reason_code = 'PRE_EXECUTION_SOURCE_REPLACEMENT'", [sale.captureId]), 0);
  // CMD036 then queues on the repaired authorization
  const queued = await executeOn(sale.projectId, repaired);
  assert.equal(queued.status, 202, `CMD036 queues on the repaired authorization: ${queued.text}`);
  assert.equal((await jobsOfAuthorization(pw, repaired)).length, 1);
  assert.deepEqual(await jobsOfAuthorization(pw, sale.authorizationId), [], "nothing runs on the revoked one");
});

// --- M3: the re-binder against CMD019 --------------------------------------------------------------------------------------------------

test("R2-026: RACE the payments rebinder re-binds an authorization while CMD019 supersedes its target, both orders: no authorization is issued on an already superseded contract; one issued before is paused and offered REPAIR", async () => {
  // order 1: the re-binder holds the newer contract's shared half (the purchased subject's chain) before its COMMIT; a further CMD019
  // waits on it at the contract's exclusive half; the repair commits, then the supersession: the new authorization is paused, REPAIR offered
  {
    const { sale, recheck } = await repairable("t7-m3-rebinder-first");
    const further = await newerDraft(sale.projectId, 2);
    const rb = await holdRebind(() => quoteOn(recheck));
    const b = tracked(confirm(further));
    await waiterOn(rb.pid, b.settled, "CMD019 behind the re-binder's shared half");
    rb.release();
    const [rebound, confirmed] = await Promise.all([rb.actor.promise, b.promise]);
    const view = quoteView(rebound);
    assert.equal(view.replacement?.outcome, "REBOUND", "the re-binding committed under the contract that held");
    const repaired = await repairedOnce(sale, recheck, view.quote.quoteId, "order 1");
    const b2 = completed<TargetContractView>(confirmed, 200).data;
    assert.equal(outcome(w, await executeOn(sale.projectId, repaired)), "422 TARGET_STALE -", "the authorization issued before is paused");
    assert.equal((await authorization(repaired))?.state, "ACTIVE", "and not consumed");
    assert.ok(b2.includedPaths?.includes("REPAIR"), "REPAIR is offered again");
    assert.equal(b2.recheckPlanIds?.length, 1, "the repaired plan has its own re-check plan");
  }
  // order 2: CMD019 holds the newer contract's exclusive half (held at its bound-plans read); the re-binder waits on its shared half, then
  // reads it superseded and refuses TARGET_NOT_CURRENT: nothing recorded (on main the issuance trigger answered KP004)
  {
    const { sale, recheck } = await repairable("t7-m3-b-first");
    const further = await newerDraft(sale.projectId, 2);
    const intent = quoteHolds.arm("AFTER_INTENT", "PAUSE");
    const cq = tracked(quoteOn(recheck));
    await intent.reached;
    const b = await hold("targetContracts.approvedPlansBoundTo", () => confirm(further));
    intent.release();
    await waiterOn(b.pid, cq.settled, "the re-binder behind CMD019");
    b.release();
    const [confirmed, refused] = await Promise.all([b.actor.promise, cq.promise]);
    assert.equal(confirmed.status, 200);
    // the forbidden effect first: no authorization on the superseded contract
    await notRepaired(sale, "order 2");
    assert.equal(await w.count("commercial_authorizations", "target_contract_hash = $1", [recheck.targetContractHash]), 0, "no authorization issued on the superseded contract");
    const view = quoteView(refused);
    assert.deepEqual([view.replacement?.outcome, view.replacement?.reason, view.quote.state], ["WITHDRAWN", "TARGET_NOT_CURRENT", "WITHDRAWN"]);
  }
});

// --- M8: the drift replacement quote (REPL drift branch) -------------------------------------------------------------------------------

test("R2-026: TIMEOUT a lock wait in the drift replacement is retryable, nothing written", async () => {
  const { sale, recheck } = await repairable("t7-timeout");
  const quotes = await quotesOf(sale.projectId);
  const key = freshKey("t7-timeout");
  const client = await openConnection(w.h.pg.clientConfig("postgres"));
  try {
    await client.query("BEGIN");
    // the paid quote's row, which the replacement's intent locks as the project's live quote
    await client.query("SELECT quote_id FROM kauro.quotes WHERE quote_id = $1 FOR UPDATE", [sale.quoteId]);
    statementTimeoutMs = INJECTED_STATEMENT_TIMEOUT_MS;
    const reply = await quoteOn(recheck, key);
    statementTimeoutMs = null;
    assert.equal(outcome(w, reply), "503 CAPACITY_UNAVAILABLE -", "retryable");
    assert.equal(await quotesOf(sale.projectId), quotes, "no replacement quote");
    await notRepaired(sale, "timeout");
  } finally {
    statementTimeoutMs = null;
    await client.query("ROLLBACK");
    await client.end();
  }
  const retried = quoteView(await quoteOn(recheck, key));
  assert.equal(retried.replacement?.outcome, "REBOUND", "the retry repairs");
  await repairedOnce(sale, recheck, retried.quote.quoteId, "after the timeout");
});

test("R2-026: CRASH before COMMIT of the drift quote: no quote, the authorization ACTIVE", async () => {
  const { sale, recheck } = await repairable("t7-crash-before-quote");
  const quotes = await quotesOf(sale.projectId);
  const key = freshKey("t7-crash-before-quote");
  quoteHolds.arm("INTENT_BEFORE_COMMIT", "CRASH");
  const crashed = await quoteOn(recheck, key);
  assert.equal(crashed.status, 500);
  assert.equal(await quotesOf(sale.projectId), quotes, "no replacement quote");
  await notRepaired(sale, "crash before the intent's COMMIT");
  const again = quoteView(await quoteOn(recheck, key));
  assert.equal(again.replacement?.outcome, "REBOUND");
  await repairedOnce(sale, recheck, again.quote.quoteId, "after the crash");
});

test("R2-026: RACE (crash after COMMIT) the drift quote answer is lost; the same key returns it", async () => {
  const { sale, recheck } = await repairable("t7-crash-after-quote");
  const key = freshKey("t7-crash-after-quote");
  // the answer of the last unit (COMPLETE) is lost after its COMMIT
  const settled = quoteHolds.arm("AFTER_SETTLE", "PAUSE");
  const lost = tracked(quoteOn(recheck, key));
  await settled.reached;
  w.holds.arm("after.commit", { fail: new SimulatedCrash("after the CreateQuote commit") });
  settled.release();
  assert.equal((await lost.promise).status, 500, "the answer is lost");
  const toQuote = (await rebindingsOf(sale.captureId))[0]?.to_quote_id;
  assert.ok(toQuote !== undefined, "the repair committed");
  const again = completed<CreateQuoteView>(await quoteOn(recheck, key), 201);
  assert.equal(again.replayed, true, "the same key returns the committed answer");
  assert.deepEqual([again.data.replacement?.outcome, again.data.quote.quoteId], ["REBOUND", toQuote]);
  await repairedOnce(sale, recheck, toQuote, "after the lost answer");
});

test("R2-026: RETRY a second drift replacement of the same superseded quote is refused (the from-quote is SUPERSEDED)", async () => {
  const { sale, recheck } = await repairable("t7-retry-quote");
  const first = quoteView(await quoteOn(recheck));
  assert.equal(first.replacement?.outcome, "REBOUND");
  const quotes = await quotesOf(sale.projectId);
  // a new key: not a replay; the paid quote is SUPERSEDED and the project's live quote is the repaired one, of the same plan and target
  const second = await quoteOn(recheck, freshKey("t7-retry-second"));
  assert.ok(second.status !== 201 || quoteView(second).replacement?.outcome !== "REBOUND", "no second re-binding answered");
  assert.equal((await rebindingsOf(sale.captureId)).length, 1, "1 rebinding");
  assert.equal((await w.row<{ state: string }>("quotes", "quote_id = $1", [sale.quoteId]))?.state, "SUPERSEDED");
  assert.ok((await quotesOf(sale.projectId)) <= quotes + 1, "at most a withdrawn quote, never a second repair");
  await repairedOnce(sale, recheck, first.quote.quoteId, "after the second attempt");
});

test("R2-026: RACE (revocation) CMD026 withdraws the re-check plan approval while CreateQuote waits on its approval half: refused", async () => {
  const withdraw = async (plan: PlanFixture): Promise<Reply> => {
    const row = await w.row<{ version: number }>("plans", "plan_id = $1", [plan.planId]);
    assert.ok(row);
    return call(w, { url: `/api/v1/plans/${plan.planId}/withdraw`, token: w.approver.token, key: freshKey("t7-cmd026"), body: { expectedVersion: Number(row.version), reasonCode: "SCOPE_CHANGED" } });
  };
  const { sale, recheck } = await repairable("t7-revocation-quote");
  const quotes = await quotesOf(sale.projectId);
  // CMD026 holds the plan row and the approval's exclusive half; CreateQuote waits on the approval's shared half, then reads it withdrawn
  const held = await hold("plans.lock", () => withdraw(recheck));
  const cq = tracked(quoteOn(recheck));
  await waiterOn(held.pid, cq.settled, "CreateQuote behind the withdrawal");
  held.release();
  const [withdrawn, refused] = await Promise.all([held.actor.promise, cq.promise]);
  assert.equal(withdrawn.status, 200);
  // the forbidden effect first: no repair under a withdrawn approval
  await notRepaired(sale, "a withdrawn approval");
  assert.equal(await quotesOf(sale.projectId), quotes, "no replacement quote");
  assert.match(outcome(w, refused), /^409 PRECONDITION_FAILED (APPROVAL_NOT_CURRENT|PLAN_WITHDRAWN|PLAN_NOT_APPROVED)$/);
});

// --- M8: the re-binding record, revocation and issuance (RB) ---------------------------------------------------------------------------

test("R2-026: RACE drift repair against a refund request on the same capture at the capture_refunds half (0015:742), both orders: the refund request lands on the new authorization, or the repair is refused PURCHASE_NOT_INTACT", async () => {
  const requestRefund = (sale: Paid): Promise<Reply> =>
    call(w, { url: paymentRoutes.requestRefund(sale.projectId), token: w.billing.token, key: freshKey("t7-cmd031"), body: { reasonCode: "The target changed before execution", evidenceRef: ids.next() } });
  // order 1: the re-binder holds the capture's refund commitment half (the 0084 guard took it at the re-binding insert); the refund request
  // waits on it; the repair commits first and the request lands on the capture whose live authorization is the new one
  {
    const { sale, recheck } = await repairable("t7-refund-rebinder-first");
    const rb = await holdRebind(() => quoteOn(recheck));
    const refund = tracked(requestRefund(sale));
    await waiterOn(rb.pid, refund.settled, "CMD031 behind the re-binder's capture_refunds half");
    rb.release();
    const [rebound, requested] = await Promise.all([rb.actor.promise, refund.promise]);
    const view = quoteView(rebound);
    const repaired = await repairedOnce(sale, recheck, view.quote.quoteId, "order 1");
    const r = completed<{ refund: { state: string; captureId: string } }>(requested, 201).data.refund;
    assert.deepEqual([r.state, r.captureId], ["REQUESTED", sale.captureId], "the refund request lands on the repaired capture");
    assert.equal((await liveOfCapture(sale.captureId))?.authorization_id, repaired, "whose live authorization is the new one");
  }
  // order 2: the refund request commits while CreateQuote waits between its intent and its settlement; the re-binder then reads a refund
  // awaiting review and refuses PURCHASE_NOT_INTACT (the 0084 guard re-checks it under the same half)
  {
    const { sale, recheck } = await repairable("t7-refund-request-first");
    const intent = quoteHolds.arm("AFTER_INTENT", "PAUSE");
    const cq = tracked(quoteOn(recheck));
    await intent.reached;
    completed(await requestRefund(sale), 201);
    intent.release();
    const view = quoteView(await cq.promise);
    await notRepaired(sale, "order 2");
    assert.deepEqual([view.replacement?.outcome, view.replacement?.reason], ["WITHDRAWN", "PURCHASE_NOT_INTACT"]);
  }
});

test.todo("R2-026: RACE drift repair against admission at the authorization exclusive half (0015:740), both orders: no job consumes either authorization", () => {
  // GAP L7: admission is the control plane's pipeline (apps/control admission.ts:110-121); the api world has no driver that holds it at
  // the authorization's exclusive half. Needs the apps/control execution world (execution-world.ts) with the re-binder bound.
});

test("R2-026: CRASH before COMMIT after the new authorization insert: old authorization ACTIVE, 0 rebindings", async () => {
  const { sale, recheck } = await repairable("t7-crash-before-rebind");
  const key = freshKey("t7-crash-before-rebind");
  // the re-binder's last write is the new authorization's issuance (and its event); it dies after it, before its COMMIT
  points.crash("rebind.after");
  const crashed = await quoteOn(recheck, key);
  assert.equal(crashed.status, 500);
  await notRepaired(sale, "crash before the re-binding's COMMIT");
  assert.equal(await w.count("commercial_authorizations", "capture_id = $1", [sale.captureId]), 1, "no new authorization survives");
  const resumed = quoteView(await quoteOn(recheck, key));
  assert.equal(resumed.replacement?.outcome, "REBOUND", "the same key resumes and repairs");
  await repairedOnce(sale, recheck, resumed.quote.quoteId, "after the crash");
});

test("R2-026: RACE (crash after COMMIT) the rebind answer is lost; the replay returns the one rebinding", async () => {
  const { sale, recheck } = await repairable("t7-crash-after-rebind");
  const key = freshKey("t7-crash-after-rebind");
  // the payment service's unit committed; the request dies before it hears the answer
  quoteHolds.arm("AFTER_SETTLE", "CRASH");
  const lost = await quoteOn(recheck, key);
  assert.equal(lost.status, 500);
  assert.equal((await rebindingsOf(sale.captureId)).length, 1, "the re-binding committed");
  const resumed = quoteView(await quoteOn(recheck, key));
  assert.equal(resumed.replacement?.outcome, "REBOUND", "the replay observes the re-binding by its identity");
  await repairedOnce(sale, recheck, resumed.quote.quoteId, "after the lost answer");
});

test("R2-026: RETRY the same rebind replays; 1 rebinding", async () => {
  const { sale, recheck } = await repairable("t7-retry-rebind");
  const key = freshKey("t7-retry-rebind");
  const first = completed<CreateQuoteView>(await quoteOn(recheck, key), 201);
  const replay = completed<CreateQuoteView>(await quoteOn(recheck, key), 201);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.data, first.data, "the same answer");
  await repairedOnce(sale, recheck, first.data.quote.quoteId, "after the replay");
});

test("R2-026: PARTIAL the new authorization insert fails after the revoke: full rollback, old authorization ACTIVE", async () => {
  const { sale, recheck } = await repairable("t7-partial");
  const key = freshKey("t7-partial");
  // the third write of the re-binding (rule 3: record, revoke, issue) fails after the first two
  points.crash("pay.authorizations.issue.before");
  const failed = await quoteOn(recheck, key);
  assert.equal(failed.status, 500);
  await notRepaired(sale, "the issuance failed");
  assert.equal((await w.row<{ state: string }>("quotes", "quote_id = $1", [sale.quoteId]))?.state, "ACCEPTED_FOR_CHECKOUT", "the paid quote is not superseded");
  const resumed = quoteView(await quoteOn(recheck, key));
  assert.equal(resumed.replacement?.outcome, "REBOUND");
  await repairedOnce(sale, recheck, resumed.quote.quoteId, "after the failed issuance");
});

// the world's last step: the CLEAN capability is suspended for every agency (execution-support suspendCapability)
test("R2-026: RACE (revocation) the capability is revoked while the rebinder holds its shared half: REFUSED", async () => {
  // a second repair stands between its intent and its settlement before the suspension, so its re-binder reads the suspended capability
  const later = await repairable("t7-capability-later");
  const intent = quoteHolds.arm("AFTER_INTENT", "PAUSE");
  const waiting = tracked(quoteOn(later.recheck));
  await intent.reached;
  // order 1: the re-binder holds the capability's shared half; the suspension waits on it; the repair commits under the capability that held
  {
    const { sale, recheck } = await repairable("t7-capability-rebinder-first");
    const rb = await holdRebind(() => quoteOn(recheck));
    const suspension = tracked(suspendCapability(pw));
    await waiterOn(rb.pid, suspension.settled, "the suspension behind the re-binder's capability half");
    rb.release();
    const [rebound] = await Promise.all([rb.actor.promise, suspension.promise]);
    const view = quoteView(rebound);
    assert.equal(view.replacement?.outcome, "REBOUND");
    await repairedOnce(sale, recheck, view.quote.quoteId, "order 1");
  }
  // order 2: the suspension committed; the re-binder reads it after the shared half and refuses: nothing recorded
  intent.release();
  const view = quoteView(await waiting.promise);
  await notRepaired(later.sale, "order 2");
  assert.deepEqual([view.replacement?.outcome, view.replacement?.reason], ["WITHDRAWN", "CAPABILITY_RESTRICTED"]);
});
