/**
 * The money admission of one dispatch (closure plan D3-GRANT-1; manual 06
 * "Budget algebra"). Token ceilings are technical bounds; what a request may
 * cost is decided by the host's funded grant, before the send starts: the
 * core asks `admit` for the invocation's maximum charge, and only an ADMITTED
 * invocation is marked SEND_STARTED and dispatched. Every admitted invocation
 * is settled again on the record's terms — COMMITTED at its charge (the
 * reported usage priced by the tariff, or the maximum charge when the usage
 * is unknown), AMBIGUOUS at its maximum charge while nobody knows whether the
 * provider billed it, RELEASED only on the core's proof that it was never
 * dispatched. A charge above the reservation is liability: it blocks every
 * further dispatch and the promotion, and it is never trimmed to fit.
 *
 * The tariff is the host's model profile, never a price this core asserts;
 * until the provider adapter binds the provider's token counting, the input
 * upper bound of a request is its UTF-8 byte length (a byte-level tokenizer
 * never emits more tokens than bytes).
 *
 * `MemoryDispatchAdmission` is the labelled SIMULATED fake of the platform's
 * CostGrant (B08: the grant row, reserved under its row lock): one balance
 * shared by every run that is handed it.
 */
import { IntelligenceError } from '../contracts/errors.js';

/** The host model profile's tariff, in millionths of the grant's currency. */
export interface ModelTariff {
  /** Names the profile's tariff for the record; a label, not a price. */
  readonly tariffRef: string;
  readonly inputMicrosPerToken: number;
  readonly outputMicrosPerToken: number;
  /** The explicit uncertainty allowance every maximum charge carries on top of the bounds. */
  readonly allowanceMicros: number;
}

export const ADMISSION_OUTCOMES = Object.freeze(['ADMITTED', 'NO_FUNDED_GRANT', 'FENCED'] as const);
/** ADMITTED: the grant holds the maximum charge. NO_FUNDED_GRANT: it cannot, or a liability stands on it. FENCED: the host's step fence moved; this owner may dispatch nothing. */
export type AdmissionOutcome = (typeof ADMISSION_OUTCOMES)[number];

export interface AdmissionRequest {
  readonly runId: string;
  readonly reservationId: string;
  readonly maxChargeMicros: number;
  /** The idempotency key of the provider request this reservation admits, when the caller knows it (a campaign ledger records it on its HOLD line). */
  readonly requestKey?: string;
}

export type SettlementState = 'COMMITTED' | 'AMBIGUOUS' | 'RELEASED';

export interface Settlement {
  readonly runId: string;
  readonly reservationId: string;
  readonly state: SettlementState;
  /** COMMITTED: the charge; AMBIGUOUS: the maximum charge still held; RELEASED: zero. */
  readonly chargeMicros: number;
  /** False when the charge is the maximum charge standing in for a usage nobody reported. */
  readonly usageKnown: boolean;
}

/** The host's money port: asked before every SEND_STARTED, told every settlement. Both are idempotent per reservation. */
export interface DispatchAdmission {
  admit(request: AdmissionRequest): Promise<AdmissionOutcome>;
  settle(settlement: Settlement): Promise<void>;
}

const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isMicros = (value: unknown): value is number => isAmount(value) && Number.isSafeInteger(value);

/** What is wrong with a tariff, if anything: a label, and finite rates and allowance that are not negative. */
export function tariffProblems(tariff: unknown): readonly string[] {
  if (tariff === null || typeof tariff !== 'object') return ['the tariff is not a record'];
  const record = tariff as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof record['tariffRef'] !== 'string' || record['tariffRef'].trim() === '') problems.push('tariffRef is not a label');
  for (const member of ['inputMicrosPerToken', 'outputMicrosPerToken', 'allowanceMicros']) if (!isAmount(record[member])) problems.push(`${member} is not a finite amount of at least zero`);
  return problems;
}

/** maximum charge = input upper bound × input tariff + output ceiling × output tariff + allowance, rounded up to a whole micro. */
export function maxChargeMicros(tariff: ModelTariff, inputUpperBoundTokens: number, outputCeilingTokens: number): number {
  return Math.ceil(inputUpperBoundTokens * tariff.inputMicrosPerToken + outputCeilingTokens * tariff.outputMicrosPerToken + tariff.allowanceMicros);
}

/** What a reported usage costs under the tariff, rounded up to a whole micro. */
export function chargeMicrosOf(tariff: ModelTariff, usage: { readonly inputTokens: number; readonly outputTokens: number }): number {
  return Math.ceil(usage.inputTokens * tariff.inputMicrosPerToken + usage.outputTokens * tariff.outputMicrosPerToken);
}

/** One reservation as the grant holds it. */
export interface GrantHold {
  readonly runId: string;
  readonly reservationId: string;
  readonly maxChargeMicros: number;
  readonly state: 'HELD' | 'AMBIGUOUS' | 'COMMITTED' | 'RELEASED';
  /** The settled charge; null while held or ambiguous. */
  readonly chargeMicros: number | null;
  /** KNOWN or UNKNOWN once committed; null before. */
  readonly usage: 'KNOWN' | 'UNKNOWN' | null;
  /** A settlement for a reservation this grant never admitted (another grant's, or a lost admission): recorded as told. */
  readonly unadmitted: boolean;
}

/** The grant's balance. available = funded − held − what the committed charges consumed of their reservations; an excess over a reservation is liability, reported apart and never netted. */
export interface GrantBalance {
  readonly fundedMicros: number;
  readonly availableMicros: number;
  readonly heldMicros: number;
  readonly chargedMicros: number;
  readonly liabilityMicros: number;
}

/**
 * The labelled in-memory funded grant (evidence class SIMULATED): the check
 * and the hold of an admission are one step, as the platform's row lock
 * makes them one transaction, so two runs racing for the last funds cannot
 * both be admitted; the balance history records the grant after every step.
 */
export class MemoryDispatchAdmission implements DispatchAdmission {
  readonly evidenceClass = 'SIMULATED' as const;
  readonly fundedMicros: number;
  readonly admissions: { readonly runId: string; readonly reservationId: string; readonly maxChargeMicros: number; readonly outcome: AdmissionOutcome }[] = [];
  readonly settlements: Settlement[] = [];
  readonly history: GrantBalance[] = [];
  /** Keyed by run and reservation: a reservation id is unique within its run only. */
  private readonly holds = new Map<string, GrantHold>();
  private static keyOf(runId: string, reservationId: string): string {
    return JSON.stringify([runId, reservationId]);
  }

  constructor(options: { readonly fundedMicros: number }) {
    if (!isMicros(options.fundedMicros)) throw new IntelligenceError('CONTRACT_VIOLATION', 'a funded grant holds a whole, finite number of micros of at least zero');
    this.fundedMicros = options.fundedMicros;
    this.history.push(this.view());
  }

  view(): GrantBalance {
    let held = 0;
    let consumed = 0;
    let charged = 0;
    let liability = 0;
    for (const hold of this.holds.values()) {
      if (hold.state === 'HELD' || hold.state === 'AMBIGUOUS') held += hold.maxChargeMicros;
      if (hold.state === 'COMMITTED' && hold.chargeMicros !== null) {
        charged += hold.chargeMicros;
        consumed += Math.min(hold.chargeMicros, hold.maxChargeMicros);
        liability += Math.max(0, hold.chargeMicros - hold.maxChargeMicros);
      }
    }
    return { fundedMicros: this.fundedMicros, availableMicros: this.fundedMicros - held - consumed, heldMicros: held, chargedMicros: charged, liabilityMicros: liability };
  }

  /** The hold of one reservation, by its run when given; without a run, the one hold of that id on this grant (several runs holding the same id is a question only the run answers). */
  holdOf(reservationId: string, runId?: string): GrantHold | undefined {
    if (runId !== undefined) return this.holds.get(MemoryDispatchAdmission.keyOf(runId, reservationId));
    const matches = [...this.holds.values()].filter((hold) => hold.reservationId === reservationId);
    if (matches.length > 1) throw new IntelligenceError('CONTRACT_VIOLATION', `reservation ${reservationId} is held for ${String(matches.length)} runs on this grant; name the run`);
    return matches[0];
  }

  async admit(request: AdmissionRequest): Promise<AdmissionOutcome> {
    // Decided and held before the first await: nothing can interleave between the check and the hold.
    const outcome = this.decide(request);
    await Promise.resolve();
    return outcome;
  }

  private decide(request: AdmissionRequest): AdmissionOutcome {
    if (!isMicros(request.maxChargeMicros)) throw new IntelligenceError('CONTRACT_VIOLATION', `a maximum charge is a whole number of micros (${String(request.maxChargeMicros)})`);
    const key = MemoryDispatchAdmission.keyOf(request.runId, request.reservationId);
    const existing = this.holds.get(key);
    if (existing !== undefined) {
      // The same reservation asked again (a retried call) is the same admission; a settled one is never admitted twice.
      if (existing.state === 'HELD' && existing.maxChargeMicros === request.maxChargeMicros) return 'ADMITTED';
      throw new IntelligenceError('CONTRACT_VIOLATION', `reservation ${request.reservationId} is already ${existing.state} on this grant`);
    }
    const balance = this.view();
    const outcome: AdmissionOutcome = balance.liabilityMicros > 0 || request.maxChargeMicros > balance.availableMicros ? 'NO_FUNDED_GRANT' : 'ADMITTED';
    if (outcome === 'ADMITTED') this.holds.set(key, { runId: request.runId, reservationId: request.reservationId, maxChargeMicros: request.maxChargeMicros, state: 'HELD', chargeMicros: null, usage: null, unadmitted: false });
    this.admissions.push({ runId: request.runId, reservationId: request.reservationId, maxChargeMicros: request.maxChargeMicros, outcome });
    this.history.push(this.view());
    return outcome;
  }

  async settle(settlement: Settlement): Promise<void> {
    if (!isMicros(settlement.chargeMicros)) throw new IntelligenceError('CONTRACT_VIOLATION', `a charge is a whole number of micros (${String(settlement.chargeMicros)})`);
    this.settlements.push(settlement);
    const key = MemoryDispatchAdmission.keyOf(settlement.runId, settlement.reservationId);
    const hold = this.holds.get(key);
    const next = (from: GrantHold): GrantHold => {
      if (settlement.state === 'RELEASED') return { ...from, state: 'RELEASED', chargeMicros: 0, usage: null };
      if (settlement.state === 'AMBIGUOUS') return { ...from, state: 'AMBIGUOUS', chargeMicros: null, usage: null };
      return { ...from, state: 'COMMITTED', chargeMicros: settlement.chargeMicros, usage: settlement.usageKnown ? 'KNOWN' : 'UNKNOWN' };
    };
    if (hold === undefined) {
      // Nothing to release; anything else is recorded as the core states it, at the amount it names.
      if (settlement.state !== 'RELEASED') this.holds.set(key, next({ runId: settlement.runId, reservationId: settlement.reservationId, maxChargeMicros: settlement.chargeMicros, state: 'HELD', chargeMicros: null, usage: null, unadmitted: true }));
    } else if (hold.state === settlement.state) {
      // Idempotent: the same settlement again changes nothing; a different charge for a settled reservation is a defect, never a silent correction.
      if (hold.state === 'COMMITTED' && hold.chargeMicros !== settlement.chargeMicros) throw new IntelligenceError('CONTRACT_VIOLATION', `reservation ${settlement.reservationId} is already committed at ${String(hold.chargeMicros)} micros`);
    } else if (hold.state === 'HELD' || (hold.state === 'AMBIGUOUS' && settlement.state === 'COMMITTED')) {
      this.holds.set(key, next(hold));
    } else {
      // An ambiguous send is released only by reconciliation evidence, and a settled reservation does not move again.
      throw new IntelligenceError('CONTRACT_VIOLATION', `reservation ${settlement.reservationId} is ${hold.state}; it cannot be settled ${settlement.state}`);
    }
    this.history.push(this.view());
  }
}
