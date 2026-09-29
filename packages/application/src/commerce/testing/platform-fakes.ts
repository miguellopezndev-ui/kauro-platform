/**
 * Contract fakes of the platform ports B09 meets at integration (design §5, §15; decision D-FAKE-B1): `binding: "CONTRACT_FAKE"`,
 * evidence class SIMULATED, never counted as the owning package's behaviour. They stand in until their package is on main. The
 * fakes of the source lifecycle's SourceAvailabilityReader and SourceLineageReader (package B07) were removed by the B07 + B09
 * merge, which binds B07's own readers (apps/api edition.ts; docs/design/B07-B09-merge.md); what remains:
 *
 *  - DeliveryCapacityPort — the processing package's admission (package B08; D-CAP-B1): AVAILABLE, a stated refusal, or no answer
 *    at all (the call fails), which a command treats like a refusal (CAPACITY_UNAVAILABLE / DELIVERY_CAPACITY_UNAVAILABLE).
 * Each keeps the call log of what it was asked, with the unit of work's context kind (a platform port is read inside the caller's
 * unit of work, never outside a transaction).
 */
import type { Clock } from "@kauro/domain";
import type { DeliveryCapacityPort } from "../ports.js";
import { CONTRACT_FAKE, FAKE_EVIDENCE_CLASS, sha256Hex, type FakeCall } from "./labels.js";

/** The admission's programmed answer: capacity, a stated refusal, or no answer (the call fails). */
export type CapacityAnswer = { readonly available: true } | { readonly available: false; readonly reason: "ADMISSION_QUEUE_FULL" | "OUTSIDE_QUALIFIED_ENVELOPE" | "EXECUTION_UNFUNDED" } | { readonly noAnswer: true };

/** The failure of an admission that answered nothing (a timeout or an unavailable dependency). */
export class CapacityUnansweredError extends Error {
  constructor() {
    super("the processing admission answered nothing (contract fake)");
    this.name = "CapacityUnansweredError";
  }
}

export interface DeliveryCapacityFake extends DeliveryCapacityPort {
  readonly binding: typeof CONTRACT_FAKE;
  readonly evidenceClass: typeof FAKE_EVIDENCE_CLASS;
  readonly calls: ReadonlyArray<FakeCall>;
  set(answer: CapacityAnswer): void;
}

export function createDeliveryCapacityFake(options: { readonly clock: Clock; readonly initial?: CapacityAnswer }): DeliveryCapacityFake {
  let answer: CapacityAnswer = options.initial ?? { available: true };
  const calls: FakeCall[] = [];
  return {
    binding: CONTRACT_FAKE,
    evidenceClass: FAKE_EVIDENCE_CLASS,
    get calls() {
      return calls;
    },
    async checkoutCapacity(uow, request) {
      calls.push(Object.freeze({ port: "DeliveryCapacityPort", operation: `CHECKOUT_CAPACITY ${uow.context.kind}`, identity: request.projectId, at: options.clock.now(), sent: true }));
      if ("noAnswer" in answer) throw new CapacityUnansweredError();
      if (answer.available) return { available: true, evidenceHash: sha256Hex(`capacity|${request.projectId}|${request.mode}|${request.billableUnits}|${request.at}`) };
      return { available: false, reason: answer.reason };
    },
    set(next) {
      answer = next;
    },
  };
}
