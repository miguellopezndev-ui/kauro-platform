/**
 * The OUTREACH dispatcher (package B12, lane L-SEND; plan docs/design/B12-outreach-plan.md A3, §L, §M, §W, D1..D6; the shape of the
 * commissions dispatcher, B10 §14): one bounded pass holds the consumer's lease (B06 PgLeaseStore, resource kind OUTBOX_DISPATCH, the
 * consumer OUTREACH_SENDER, a name-based UUID of B12's own namespace), claims the due outbox records of outreach.send_intended.v1 and
 * for each one runs, each step in a unit of work of its own:
 *   D1  the lease claim and the batch claim, fenced by the lease (SYSTEM units, kauro_control)
 *   D2  outreachSendOf(uow).claim: ONE unit of the outreach service (kauro_outreach) takes the serializers in the global order, judges the
 *       intent at the database's instant and either refuses it (NOT_SENT / CANCELLED with the reason of the failed check), defers it
 *       (repeat grace, KC037), or writes SUBMITTING under the lease's fence after re-verifying the sealed payload
 *   D3  the start gate (ONE statement: still SUBMITTING under this fence and effect_now <= submitted_at + 5 s) and, with NO await between
 *       its answer and the port call, the provider call with an AbortSignal created synchronously: the port is called once, never retried
 *   D4  the answer is classified (A3) and recorded; a late ACCEPTED answer is evidence (D4b, UNIQUE (intent, fence)), never a second send
 *   D5  intents still SUBMITTING past uncertain_after become SEND_UNCERTAIN (recovery.ts)
 *   D6  the outbox record is settled under the attempt it claimed, after a heartbeat under the fence: DELIVERED once the intent left
 *       QUEUED (every later fault is D5's), RETRYABLE only while the intent is still QUEUED (the claim rolled back) or, at retryAt, when
 *       D2 deferred it.
 * The dispatcher never caches a fence: it takes it from each claim and heartbeat. The process clock is the injected runtime clock; every
 * instant a send is judged at is the database's.
 */
import { createHash } from "node:crypto";
import type { OutreachPorts, OutreachSendPort, OutreachSubmission } from "@kauro/application";
import { providerCallSignal } from "@kauro/application";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { Clock, CorrelationId, IdGenerator, LeaseOwnerId, OutboxDelivery, ResourceId, ServiceContext, SystemContext } from "@kauro/domain";
import { DomainFailure, isUuidV7, toUtcInstant } from "@kauro/domain";
import { outreachSendOf, type ClaimedSubmission, type ClaimVerdict, type OutcomeAnswer, type PgCommercialUnitOfWorkFactory, type SealCheck } from "@kauro/persistence";
import { DISPATCH_LEASE_DEADLINE, DISPATCH_LEASE_SECONDS, MAX_DELIVERY_ATTEMPTS, OUTBOX_CLAIM_SECONDS } from "../payments/index.js";
import { buildOutreachMime, payloadHashOf, type OptOutKey, type OutreachCompliance } from "./mime.js";
import { classifyAnswer, recordAnswer, thrownAnswer } from "./late-evidence.js";
import { recoverDue } from "./recovery.js";

export const OUTREACH_CONSUMER = "OUTREACH_SENDER";
export const OUTREACH_SERVICE_ID = "outreach-service";
const LEASE_NAMESPACE = "b12-outreach-dispatcher";

/** The lease resource of the OUTREACH_SENDER consumer: a stable UUID of its name (name-based, SHA-1 as RFC 9562 version 5, B12's namespace). */
export function outreachLeaseResource(): ResourceId {
  const hash = createHash("sha1").update(`${LEASE_NAMESPACE}:${OUTREACH_CONSUMER}`, "utf8").digest();
  const b = Uint8Array.prototype.slice.call(hash, 0, 16);
  b[6] = 0x50 | ((b[6] as number) & 0x0f);
  b[8] = 0x80 | ((b[8] as number) & 0x3f);
  const hex = Buffer.from(b).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}` as ResourceId;
}

function subjectHash(): Sha256Hex {
  return createHash("sha256").update(`B12 outreach dispatcher|${OUTREACH_CONSUMER}`, "utf8").digest("hex");
}

/** The lease a step runs under: the accessor's L13 judges it FOR SHARE at the database's instant. */
export interface OutreachLeaseRef {
  readonly resourceId: string;
  readonly ownerId: string;
  readonly fence: number;
}

/** Where an interleaving is fixed or a crash injected (tests only). */
export type OutreachHoldPoint = "BATCH_BEFORE_CLAIM" | "AFTER_CLAIM" | "AFTER_SUBMIT" | "DELIVERY_BEFORE_SETTLE";
export type OutreachHold = (point: OutreachHoldPoint, subject: { readonly intentId: string | null; readonly ownerId: string }) => Promise<void>;

export interface OutreachRuntime {
  readonly units: PgCommercialUnitOfWorkFactory;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly ports: OutreachPorts;
  /** The deployment's compliance configuration (A13); null until configured: every D2 then refuses OUTREACH_COMPLIANCE_UNCONFIGURED. */
  readonly compliance: OutreachCompliance | null;
  readonly optOutKey: OptOutKey | null;
  readonly hold: OutreachHold | null;
  readonly onBackgroundFailure: (correlationId: string, error: unknown) => void;
}

export type OutreachDeliveryOutcome = "SUBMITTED" | "REFUSED" | "DEFERRED" | "GONE" | "FAILED" | "DEAD_LETTER" | "FENCED";

export interface OutreachDispatchPass {
  readonly consumer: typeof OUTREACH_CONSUMER;
  readonly held: boolean;
  readonly fence: number | null;
  readonly deliveries: ReadonlyArray<{ readonly eventId: string; readonly intentId: string; readonly outcome: OutreachDeliveryOutcome; readonly intentState?: string; readonly errorCode?: string }>;
  readonly recovered: ReadonlyArray<string>;
}

export type OutreachSubmitResult = { readonly state: "SUBMITTED"; readonly intentState: string } | { readonly state: "NOT_ATTEMPTED"; readonly intentState: string };

export interface OutreachDispatcher {
  readonly ownerId: LeaseOwnerId;
  readonly resourceId: ResourceId;
  /** D1 lease: takes (or resumes, or takes over) the consumer's lease; HELD when another dispatcher holds it. */
  takeOver(): Promise<{ readonly kind: "HELD" } | { readonly kind: "CLAIMED"; readonly fence: number }>;
  /** D2 for one intent. */
  claim(intentId: string, lease: OutreachLeaseRef): Promise<ClaimVerdict>;
  /** D3 alone: the start gate and the one provider call; the classified answer, recorded by nobody (NOT_ATTEMPTED when the gate is closed). */
  call(claimed: ClaimedSubmission & { readonly fence: number }, lease: OutreachLeaseRef): Promise<OutcomeAnswer>;
  /** D3 + D4 for an admitted submission: the start gate, the one port call, the recorded answer. */
  submit(claimed: ClaimedSubmission & { readonly fence: number }, lease: OutreachLeaseRef): Promise<OutreachSubmitResult>;
  /** D4 for an answer the caller already holds (the claimant's own, or a late one: D4b). */
  record(intentId: string, lease: OutreachLeaseRef, answer: OutcomeAnswer): Promise<string>;
  /** D5. */
  recover(lease: OutreachLeaseRef, limit?: number): Promise<ReadonlyArray<string>>;
  /** D2..D4 of one claimed delivery. */
  dispatch(intentId: string, lease: OutreachLeaseRef): Promise<{ readonly outcome: OutreachDeliveryOutcome; readonly intentState?: string; readonly retryAt?: string }>;
  /** One bounded pass: D1 .. D6. */
  pass(options?: { readonly limit?: number }): Promise<OutreachDispatchPass>;
}

const serviceContext = (rt: OutreachRuntime): ServiceContext => ({ kind: "SERVICE", serviceId: OUTREACH_SERVICE_ID, correlationId: rt.ids.next() as CorrelationId });
const controlContext = (rt: OutreachRuntime): SystemContext => ({ kind: "SYSTEM", serviceId: "outreach-dispatcher", correlationId: rt.ids.next() as CorrelationId });

function errorCodeOf(e: unknown): string {
  return e instanceof DomainFailure ? e.code : "UNEXPECTED_ERROR";
}

/** The re-verification of the sealed payload (D2): the same bytes are rebuilt from the same inputs and hash to the intent's payload hash. */
function sealCheckOf(rt: OutreachRuntime): SealCheck {
  return (facts, payloadHash) => {
    if (rt.compliance === null || rt.optOutKey === null) return "UNCONFIGURED";
    return payloadHash !== null && payloadHashOf(buildOutreachMime(facts, rt.compliance, rt.optOutKey)) === payloadHash ? "OK" : "CHANGED";
  };
}

export function createOutreachDispatcher(rt: OutreachRuntime, options: { readonly ownerId?: LeaseOwnerId } = {}): OutreachDispatcher {
  const ownerId = options.ownerId ?? (rt.ids.next() as LeaseOwnerId);
  if (!isUuidV7(ownerId)) throw new DomainFailure("INTEGRITY_FAILURE", "a dispatcher's lease owner is a UUIDv7");
  const resourceId = outreachLeaseResource();
  const portOf = (route: string): OutreachSendPort => (route === "GMAIL_API" ? rt.ports.gmail : rt.ports.resend);

  const self: OutreachDispatcher = {
    ownerId,
    resourceId,

    async takeOver() {
      const claim = await rt.units.run(controlContext(rt), (uow) =>
        uow.leases.claim({ resourceKind: "OUTBOX_DISPATCH", resourceId, ownerId, ttlSeconds: DISPATCH_LEASE_SECONDS, deadlineAt: DISPATCH_LEASE_DEADLINE, subjectHash: subjectHash(), costAuthorityId: null, checkpointHash: null }, rt.clock.now()),
      );
      if (claim.kind === "HELD") return { kind: "HELD" } as const;
      if (claim.kind === "REFUSED") throw new DomainFailure("INTEGRITY_FAILURE", `the lease of ${OUTREACH_CONSUMER} was refused: ${claim.reason}`);
      return { kind: "CLAIMED", fence: claim.lease.fence } as const;
    },

    claim(intentId, lease) {
      return rt.units.run(serviceContext(rt), (uow) => outreachSendOf(uow).claim(intentId, lease, sealCheckOf(rt)));
    },

    async call(claimed) {
      // D3: the gate is one statement in its own unit; the abort signal is created and the port called with no await in between
      const gate = /* b12:gate */ await rt.units.run(serviceContext(rt), (uow) => outreachSendOf(uow).gate(claimed.intentId, claimed.fence));
      if (!gate.fenceMatches || !gate.open || gate.state !== "SUBMITTING") {
        // the start gate is closed: nothing was sent, and the intent is judged by D5 (it never submits late)
        return { kind: "NOT_ATTEMPTED" };
      }
      if (rt.compliance === null || rt.optOutKey === null) throw new DomainFailure("INTEGRITY_FAILURE", "a sealed intent was admitted without the compliance configuration");
      const mime = buildOutreachMime(claimed.facts, rt.compliance, rt.optOutKey);
      if (payloadHashOf(mime) !== claimed.payloadHash) throw new DomainFailure("INTEGRITY_FAILURE", "the rebuilt message does not hash to the intent's payload hash");
      const submission: OutreachSubmission = { intentId: claimed.intentId, fence: claimed.fence, senderId: claimed.senderId, senderAddress: claimed.senderAddress, route: claimed.route, mime };
      const signal = providerCallSignal();
      const call = /* b12:submit */ portOf(claimed.route).submit(submission, signal);
      try {
        return classifyAnswer(await call);
      } catch (e) {
        return thrownAnswer(e);
      }
    },

    async submit(claimed, lease) {
      const answer = await self.call(claimed, lease);
      if (answer.kind === "NOT_ATTEMPTED") {
        const intentState = await self.record(claimed.intentId, lease, answer);
        return { state: "NOT_ATTEMPTED", intentState };
      }
      if (rt.hold !== null) await rt.hold("AFTER_SUBMIT", { intentId: claimed.intentId, ownerId });
      const state = await self.record(claimed.intentId, lease, answer);
      return { state: "SUBMITTED", intentState: state };
    },

    record(intentId, lease, answer) {
      return recordAnswer(rt, intentId, lease, answer);
    },

    async recover(lease, limit = 25) {
      return (await recoverDue(rt, lease, limit)).recovered;
    },

    async dispatch(intentId, lease) {
      const verdict = await self.claim(intentId, lease);
      if (verdict.kind === "REFUSED") return { outcome: "REFUSED", intentState: verdict.state };
      if (verdict.kind === "DEFERRED") return { outcome: "DEFERRED", retryAt: verdict.retryAt };
      if (verdict.kind === "GONE") return { outcome: "GONE", intentState: verdict.state };
      if (rt.hold !== null) await rt.hold("AFTER_CLAIM", { intentId, ownerId });
      const result = await self.submit({ ...verdict.submission, fence: verdict.fence }, { ...lease, fence: verdict.fence });
      return { outcome: result.state === "SUBMITTED" ? "SUBMITTED" : "REFUSED", intentState: result.intentState };
    },

    async pass(passOptions = {}) {
      const taken = await self.takeOver();
      if (taken.kind === "HELD") return { consumer: OUTREACH_CONSUMER, held: true, fence: null, deliveries: [], recovered: [] };
      const claimedFence = taken.fence;
      const lease = (): OutreachLeaseRef => ({ resourceId, ownerId, fence: claimedFence });
      if (rt.hold !== null) await rt.hold("BATCH_BEFORE_CLAIM", { intentId: null, ownerId });
      // the one heartbeat call site: a unit whose heartbeat is refused did not hold the lease and does nothing else
      const heartbeat = async <T>(work: (uow: Parameters<Parameters<PgCommercialUnitOfWorkFactory["run"]>[1]>[0], now: UtcInstant) => Promise<T>): Promise<T | null> =>
        rt.units.run(controlContext(rt), async (uow) => {
          const now = rt.clock.now();
          const held = await uow.leases.heartbeat("OUTBOX_DISPATCH", resourceId, ownerId, claimedFence, DISPATCH_LEASE_SECONDS, now);
          return held === null ? null : work(uow, now);
        });
      const batch = await heartbeat((uow, now) => uow.outboxDispatch.claim(OUTREACH_CONSUMER, passOptions.limit ?? 25, now, OUTBOX_CLAIM_SECONDS));
      if (batch === null) throw new DomainFailure("PRECONDITION_FAILED", `the dispatcher ${ownerId} no longer holds the lease of ${OUTREACH_CONSUMER} under fence ${claimedFence}: nothing was claimed`, { reason: "LEASE_FENCED" });
      const deliveries: Array<OutreachDispatchPass["deliveries"][number] & { eventId: string }> = [];
      for (const d of batch as ReadonlyArray<OutboxDelivery>) {
        const intentId = d.event.aggregateId as string;
        let outcome: OutreachDeliveryOutcome;
        let intentState: string | undefined;
        let errorCode: string | undefined;
        let settle: { readonly kind: "DELIVERED" } | { readonly kind: "FAILED"; readonly code: string; readonly retryAt: UtcInstant | null };
        try {
          const r = await self.dispatch(intentId, lease());
          outcome = r.outcome;
          intentState = r.intentState;
          settle = r.outcome === "DEFERRED" ? { kind: "FAILED", code: "DEFERRED", retryAt: r.retryAt as UtcInstant } : { kind: "DELIVERED" };
        } catch (e) {
          if (e instanceof DomainFailure && e.details.reason === "LEASE_FENCED") {
            deliveries.push({ eventId: d.event.eventId, intentId, outcome: "FENCED", errorCode: "LEASE_FENCED" });
            break;
          }
          errorCode = errorCodeOf(e);
          rt.onBackgroundFailure(d.event.correlationId, e);
          // RETRYABLE only while the intent is still QUEUED (the claim rolled back); once it left QUEUED every later fault is D5's
          const state = await rt.units.run(serviceContext(rt), (uow) => outreachSendOf(uow).stateOf(intentId)).then((s) => s ?? "UNKNOWN", () => "UNKNOWN");
          const retryable = state === "QUEUED" && d.attempt < MAX_DELIVERY_ATTEMPTS;
          outcome = state === "QUEUED" ? (retryable ? "FAILED" : "DEAD_LETTER") : "SUBMITTED";
          intentState = state;
          settle = state === "QUEUED" ? { kind: "FAILED", code: errorCode, retryAt: retryable ? toUtcInstant(rt.clock.nowMs() + Math.min(300, 2 ** d.attempt) * 1000) : null } : { kind: "DELIVERED" };
        }
        if (rt.hold !== null) await rt.hold("DELIVERY_BEFORE_SETTLE", { intentId, ownerId });
        const settled = await heartbeat(async (uow, now) => (settle.kind === "DELIVERED" ? uow.outboxDispatch.delivered(d.outboxId, d.attempt, now) : uow.outboxDispatch.failed(d.outboxId, d.attempt, settle.code, settle.retryAt, now)));
        if (settled === null) {
          deliveries.push({ eventId: d.event.eventId, intentId, outcome: "FENCED" });
          break;
        }
        deliveries.push({ eventId: d.event.eventId, intentId, outcome: settled === "FENCED" ? "FENCED" : outcome, ...(intentState !== undefined ? { intentState } : {}), ...(errorCode !== undefined ? { errorCode } : {}) });
      }
      const recovered = await self.recover(lease()).catch((e: unknown) => {
        rt.onBackgroundFailure(ownerId, e);
        return [] as ReadonlyArray<string>;
      });
      return { consumer: OUTREACH_CONSUMER, held: false, fence: claimedFence, deliveries, recovered };
    },
  };
  return self;
}
