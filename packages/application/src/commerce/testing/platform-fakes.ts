/**
 * Contract fakes of the platform ports B09 meets at integration (design §5, §15; decision D-FAKE-B1): `binding: "CONTRACT_FAKE"`,
 * evidence class SIMULATED, never counted as the owning package's behaviour. They stand in until their package is on main:
 *
 *  - SourceAvailabilityReader — the source lifecycle's retention record of a sealed revision (package B07; D-QUOTE-B7): the
 *    effective and the hard deadline; programmed per revision hash, unknown revisions answer null;
 *  - SourceLineageReader — the source lifecycle's lineage of a replacement revision (package B07; D-QUOTE-B6);
 *  - DeliveryCapacityPort — the processing package's admission (package B08; D-CAP-B1): AVAILABLE, a stated refusal, or no answer
 *    at all (the call fails), which a command treats like a refusal (CAPACITY_UNAVAILABLE / DELIVERY_CAPACITY_UNAVAILABLE).
 * Each keeps the call log of what it was asked, with the unit of work's context kind (a platform port is read inside the caller's
 * unit of work, never outside a transaction).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { Clock } from "@kauro/domain";
import type { DeliveryCapacityPort, SourceAvailabilityReader, SourceLineageReader } from "../ports.js";
import { CONTRACT_FAKE, FAKE_EVIDENCE_CLASS, sha256Hex, type FakeCall } from "./labels.js";

type Availability = NonNullable<Awaited<ReturnType<SourceAvailabilityReader["availabilityOf"]>>>;
type Lineage = NonNullable<Awaited<ReturnType<SourceLineageReader["replacementOf"]>>>;

export interface SourceAvailabilityFake extends SourceAvailabilityReader {
  readonly binding: typeof CONTRACT_FAKE;
  readonly evidenceClass: typeof FAKE_EVIDENCE_CLASS;
  readonly calls: ReadonlyArray<FakeCall>;
  /** Programs the retention record of a sealed revision (null: the lifecycle knows no such revision). */
  set(revisionHash: Sha256Hex, availability: Omit<Availability, "evidenceHash"> | null): void;
}

export function createSourceAvailabilityFake(options: { readonly clock: Clock }): SourceAvailabilityFake {
  const records = new Map<string, Availability | null>();
  const calls: FakeCall[] = [];
  return {
    binding: CONTRACT_FAKE,
    evidenceClass: FAKE_EVIDENCE_CLASS,
    get calls() {
      return calls;
    },
    async availabilityOf(uow, request) {
      calls.push(Object.freeze({ port: "SourceAvailabilityReader", operation: `AVAILABILITY_OF ${uow.context.kind}`, identity: request.revisionHash, at: options.clock.now(), sent: true }));
      return records.get(request.revisionHash) ?? null;
    },
    set(revisionHash, availability) {
      records.set(revisionHash, availability === null ? null : Object.freeze({ ...availability, evidenceHash: sha256Hex(`retention|${revisionHash}|${availability.state}|${availability.effectiveDeadline}`) }));
    },
  };
}

export interface SourceLineageFake extends SourceLineageReader {
  readonly binding: typeof CONTRACT_FAKE;
  readonly evidenceClass: typeof FAKE_EVIDENCE_CLASS;
  readonly calls: ReadonlyArray<FakeCall>;
  /** Programs the lineage of a replacement revision (the replacement supersedes the replaced one). */
  set(replacedRevisionHash: Sha256Hex, replacementRevisionHash: Sha256Hex, lineage: Omit<Lineage, "evidenceHash"> | null): void;
}

export function createSourceLineageFake(options: { readonly clock: Clock }): SourceLineageFake {
  const records = new Map<string, Lineage | null>();
  const calls: FakeCall[] = [];
  return {
    binding: CONTRACT_FAKE,
    evidenceClass: FAKE_EVIDENCE_CLASS,
    get calls() {
      return calls;
    },
    async replacementOf(uow, request) {
      calls.push(Object.freeze({ port: "SourceLineageReader", operation: `REPLACEMENT_OF ${uow.context.kind}`, identity: request.replacementRevisionHash, at: options.clock.now(), sent: true }));
      return records.get(`${request.replacedRevisionHash}|${request.replacementRevisionHash}`) ?? null;
    },
    set(replaced, replacement, lineage) {
      records.set(`${replaced}|${replacement}`, lineage === null ? null : Object.freeze({ ...lineage, evidenceHash: sha256Hex(`lineage|${replaced}|${replacement}`) }));
    },
  };
}

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

/** A convenience availability of a revision sealed at `sealedAt` whose effective deadline is `effectiveDeadline`. */
export function sealedAvailability(revisionId: string, sealedAt: UtcInstant, effectiveDeadline: UtcInstant, hardDeadline: UtcInstant = effectiveDeadline): Omit<Availability, "evidenceHash"> {
  return { revisionId, state: "SEALED", sealedAt, effectiveDeadline, hardDeadline };
}
