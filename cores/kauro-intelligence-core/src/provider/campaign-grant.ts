/**
 * The campaign grant: the owner's funding of a campaign stage, enforced above
 * the B03 dispatch admission (B04 D4-CAMP-4; B04-campaign-envelope §6). Every
 * rule of the stop rule is code here, not a sentence in a document:
 *   1. a request is sent only if its worst-case charge fits what is left of the
 *      grant after the in-flight holds (the dispatch admission is not even asked
 *      otherwise, and the core marks nothing SEND_STARTED);
 *   2. a run starts only if its projected full cost (per-fixture cost x fixtures
 *      x 1.15) fits what is left, and one run at a time is in progress;
 *   3. at a checkpoint (the runner calls it every 50 fixtures), committed + held
 *      above the run's projection by 25 % stops the campaign;
 *   4. a hard-gate violation, a canary hit, a served-model change or a liability
 *      above a reservation stops the campaign (`stopFor`, settlement);
 *   5. an unknown usage holds its whole reservation (the core settles it AMBIGUOUS
 *      or at the maximum charge; this grant keeps it held or charged as told).
 * A stopped campaign admits nothing until a new `CampaignAdmission` is built on
 * a new owner approval. A grant is for named stages and expires. Amounts are
 * whole micro-USD. Pure and offline: the inner admission is the host's.
 *
 * The grant is spent once, across processes (D4-CAMP-6): with a `journal` (the
 * runner's append-only, fsync'd, exclusively locked ledger beside the grant
 * file) every hold, withdrawal, settlement and stop is written before it takes
 * effect, and a new admission over the same journal starts from what earlier
 * invocations spent. A hold no settlement followed (the process ended while
 * the request was in flight) comes back AMBIGUOUS: spent until reconciled.
 */
import { IntelligenceError } from '../contracts/errors.js';
import type { AdmissionOutcome, AdmissionRequest, DispatchAdmission, ModelTariff, Settlement } from '../kernel/admission.js';
import type { CandidateProfile } from '../gateway/candidates.js';

export const CAMPAIGN_STAGES = Object.freeze(['SMOKE', 'PILOT', 'SELECTION', 'QUALIFICATION'] as const);
export type CampaignStage = (typeof CAMPAIGN_STAGES)[number];

export interface CampaignGrant {
  readonly grantId: string;
  /** The stages this grant funds: grant A funds the smoke and the pilot, grant B the qualification runs. */
  readonly stages: readonly CampaignStage[];
  /** The hard cap, in micro-USD. */
  readonly capMicros: number;
  /** ISO instant after which nothing is admitted. */
  readonly expiresAt: string;
  /** The owner's approval this grant stands on. */
  readonly approvalRef: string;
  /** The candidates (profile ids) this grant funds: a run of any other candidate is refused before a hold (grant B names Sonnet only, A9 §4). */
  readonly candidates: readonly string[];
  /** The most runs the grant funds, counted from the ledger (a crashed run counts); null when the stage is bounded by its cap alone. */
  readonly maxRuns: number | null;
}

export function campaignGrantProblems(grant: unknown): readonly string[] {
  if (grant === null || typeof grant !== 'object') return ['the grant is not a record'];
  const record = grant as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof record['grantId'] !== 'string' || record['grantId'].trim() === '') problems.push('grantId is not a label');
  if (typeof record['approvalRef'] !== 'string' || record['approvalRef'].trim() === '') problems.push('approvalRef names no owner approval');
  if (typeof record['capMicros'] !== 'number' || !Number.isSafeInteger(record['capMicros']) || record['capMicros'] < 0) problems.push('capMicros is not a whole number of micros of at least zero');
  const stages = record['stages'];
  if (!Array.isArray(stages) || stages.length === 0 || !stages.every((stage) => (CAMPAIGN_STAGES as readonly unknown[]).includes(stage))) problems.push('stages names no known campaign stage');
  if (typeof record['expiresAt'] !== 'string' || Number.isNaN(Date.parse(record['expiresAt']))) problems.push('expiresAt is not an instant');
  const candidates = record['candidates'];
  if (!Array.isArray(candidates) || candidates.length === 0 || !candidates.every((candidate) => typeof candidate === 'string' && candidate.trim() !== '')) problems.push('candidates names no candidate (a non-empty list of profile ids)');
  const maxRuns = record['maxRuns'];
  if (maxRuns !== null && (typeof maxRuns !== 'number' || !Number.isSafeInteger(maxRuns) || maxRuns < 1)) problems.push('maxRuns is neither null nor a whole number of at least one');
  return problems;
}

/** The core's tariff for a candidate profile: its published prices per token, and the allowance every maximum charge carries. */
export function tariffForProfile(profile: CandidateProfile, allowanceMicros: number): ModelTariff {
  return { tariffRef: profile.profileId, inputMicrosPerToken: profile.inputMicroUsdPerToken, outputMicrosPerToken: profile.outputMicroUsdPerToken, allowanceMicros };
}

/** A run's projected full cost: per-fixture cost x fixtures x 1.15 (the repair and re-run reserve), rounded up to a micro. */
export function projectedRunMicros(perFixtureMicros: number, fixtures: number): number {
  return Math.ceil((perFixtureMicros * fixtures * 115) / 100);
}

export type StopEvent = 'HARD_GATE_VIOLATION' | 'CANARY_HIT' | 'SERVED_MODEL_CHANGE';

export interface CampaignBalance {
  readonly capMicros: number;
  readonly heldMicros: number;
  /** What committed charges consumed of their reservations. */
  readonly chargedMicros: number;
  readonly liabilityMicros: number;
  readonly remainingMicros: number;
}

export interface RunStart {
  readonly started: boolean;
  readonly projectedMicros: number;
  readonly reason: 'RUN_IN_PROGRESS' | 'PROJECTED_COST_DOES_NOT_FIT' | 'CANDIDATE_NOT_GRANTED' | 'MAX_RUNS_REACHED' | 'RUN_NO_ALREADY_USED' | string | null;
}

interface Hold {
  readonly maxChargeMicros: number;
  /** The idempotency key of the request this hold admitted: how a reconciliation finds it (G23). */
  readonly requestKey: string | null;
  state: 'HELD' | 'AMBIGUOUS' | 'COMMITTED' | 'RELEASED';
  chargeMicros: number | null;
}

/** One line of the grant's ledger: written before the change it records takes effect. */
export type CampaignLedgerEvent =
  | { readonly kind: 'HOLD'; readonly runId: string; readonly reservationId: string; readonly maxChargeMicros: number; readonly requestKey?: string }
  | { readonly kind: 'DROP'; readonly runId: string; readonly reservationId: string }
  | { readonly kind: 'SETTLE'; readonly runId: string; readonly reservationId: string; readonly state: 'COMMITTED' | 'AMBIGUOUS' | 'RELEASED'; readonly chargeMicros: number; readonly requestKey?: string; readonly reason?: string; readonly reconciled?: true }
  /** A run began (written before it starts, so a crashed or abandoned run still counts toward the grant). */
  | { readonly kind: 'RUN'; readonly runId: string; readonly stage: CampaignStage; readonly runNo: number | null; readonly candidate: string }
  /** The ledger's lock of a crashed holder was recovered on proof of its death (S10). */
  | { readonly kind: 'LOCK_RECOVERED'; readonly oldLock: unknown; readonly provedBy: string }
  | { readonly kind: 'STOP'; readonly reason: string };

/** The durable ledger of one grant: the events of every earlier invocation, and a synchronous, durable append. */
export interface CampaignJournal {
  readonly events: readonly CampaignLedgerEvent[];
  append(event: CampaignLedgerEvent): void;
}

const isMicros = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const keyOf = (runId: string, reservationId: string): string => JSON.stringify([runId, reservationId]);

/** The campaign's admission: a `DispatchAdmission` that asks the grant first and the host's admission second. */
export class CampaignAdmission implements DispatchAdmission {
  readonly grant: CampaignGrant;
  readonly stage: CampaignStage;
  readonly refusals: { readonly runId: string; readonly reservationId: string; readonly maxChargeMicros: number; readonly reason: string }[] = [];
  private readonly inner: DispatchAdmission;
  private readonly now: () => number;
  private readonly holds = new Map<string, Hold>();
  private haltedFor: string | null = null;
  private active: { readonly runId: string; readonly projectedMicros: number; readonly baselineMicros: number } | null = null;
  /** Every run this grant has begun, from the ledger and this invocation: the count and the numbers used. */
  private readonly runs: { readonly runId: string; readonly stage: CampaignStage; readonly runNo: number | null; readonly candidate: string }[] = [];

  private readonly journal: CampaignJournal | null;

  constructor(options: { readonly grant: CampaignGrant; readonly stage: CampaignStage; readonly inner: DispatchAdmission; readonly now: () => number; readonly journal?: CampaignJournal }) {
    const problems = campaignGrantProblems(options.grant);
    if (problems.length > 0) throw new IntelligenceError('CONTRACT_VIOLATION', `not a campaign grant: ${problems.join('; ')}`);
    this.grant = options.grant;
    this.stage = options.stage;
    this.inner = options.inner;
    this.now = options.now;
    this.journal = options.journal ?? null;
    if (this.journal !== null) this.replay(this.journal.events);
  }

  /** Rebuilds the grant from its ledger; a hold left in flight by an earlier invocation is AMBIGUOUS until reconciled. */
  private replay(events: readonly CampaignLedgerEvent[]): void {
    for (const event of events) {
      if (event.kind === 'STOP') this.haltedFor ??= event.reason;
      else if (event.kind === 'HOLD') {
        const key = keyOf(event.runId, event.reservationId);
        if (this.holds.has(key)) throw new IntelligenceError('CONTRACT_VIOLATION', `the grant ledger holds reservation ${event.reservationId} twice`);
        this.holds.set(key, { maxChargeMicros: event.maxChargeMicros, requestKey: event.requestKey ?? null, state: 'HELD', chargeMicros: null });
      } else if (event.kind === 'RUN') {
        this.runs.push({ runId: event.runId, stage: event.stage, runNo: event.runNo, candidate: event.candidate });
      } else if (event.kind === 'LOCK_RECOVERED') {
        continue;
      } else if (event.kind === 'DROP') {
        const key = keyOf(event.runId, event.reservationId);
        if (this.holds.get(key)?.state === 'HELD') this.holds.delete(key);
      } else this.apply(event.runId, event.reservationId, event.state, event.chargeMicros, event.reconciled === true);
    }
    for (const hold of this.holds.values()) if (hold.state === 'HELD') hold.state = 'AMBIGUOUS';
    if (this.balance().liabilityMicros > 0) this.haltedFor ??= 'LIABILITY_ABOVE_RESERVATION';
  }

  /** Written before the change it records; a ledger that cannot be written stops the change. */
  private record(event: CampaignLedgerEvent): void {
    this.journal?.append(event);
  }

  private halt(reason: string): void {
    if (this.haltedFor !== null) return;
    this.record({ kind: 'STOP', reason });
    this.haltedFor = reason;
  }

  /** The settlement rule: a hold settles once; an ambiguous hold may still be reconciled to a charge. */
  private apply(runId: string, reservationId: string, state: 'COMMITTED' | 'AMBIGUOUS' | 'RELEASED', chargeMicros: number, reconciled = false): void {
    const key = keyOf(runId, reservationId);
    const hold = this.holds.get(key);
    if (hold === undefined) {
      // A settlement for a reservation this grant never admitted is recorded as told, at the amount it names; a release is nothing.
      if (state !== 'RELEASED') this.holds.set(key, { maxChargeMicros: chargeMicros, requestKey: null, state: state === 'COMMITTED' ? 'COMMITTED' : 'AMBIGUOUS', chargeMicros: state === 'COMMITTED' ? chargeMicros : null });
    } else if (hold.state === 'HELD' || (hold.state === 'AMBIGUOUS' && (state === 'COMMITTED' || (state === 'RELEASED' && reconciled)))) {
      hold.state = state;
      hold.chargeMicros = state === 'COMMITTED' ? chargeMicros : state === 'RELEASED' ? 0 : null;
    }
  }

  balance(): CampaignBalance {
    let held = 0;
    let consumed = 0;
    let liability = 0;
    for (const hold of this.holds.values()) {
      if (hold.state === 'HELD' || hold.state === 'AMBIGUOUS') held += hold.maxChargeMicros;
      if (hold.state === 'COMMITTED' && hold.chargeMicros !== null) {
        consumed += Math.min(hold.chargeMicros, hold.maxChargeMicros);
        liability += Math.max(0, hold.chargeMicros - hold.maxChargeMicros);
      }
    }
    return { capMicros: this.grant.capMicros, heldMicros: held, chargedMicros: consumed, liabilityMicros: liability, remainingMicros: this.grant.capMicros - held - consumed };
  }

  /** Why the campaign stopped, or null while it may go on. The first reason stands. */
  halted(): string | null {
    return this.haltedFor;
  }

  stopFor(event: StopEvent): void {
    this.halt(event);
  }

  /** Why nothing is admitted at all right now; null when the grant is in force for this stage. */
  private standing(): string | null {
    if (this.haltedFor !== null) return this.haltedFor;
    if (!this.grant.stages.includes(this.stage)) return 'GRANT_DOES_NOT_FUND_THIS_STAGE';
    if (this.now() >= Date.parse(this.grant.expiresAt)) return 'GRANT_EXPIRED';
    if (this.balance().liabilityMicros > 0) {
      this.halt('LIABILITY_ABOVE_RESERVATION');
      return this.haltedFor;
    }
    return null;
  }

  async admit(request: AdmissionRequest): Promise<AdmissionOutcome> {
    if (!isMicros(request.maxChargeMicros)) throw new IntelligenceError('CONTRACT_VIOLATION', `a maximum charge is a whole number of micros (${String(request.maxChargeMicros)})`);
    const key = keyOf(request.runId, request.reservationId);
    const existing = this.holds.get(key);
    if (existing !== undefined) {
      // The same reservation asked again while held at the same maximum is the same admission; any other entry is never
      // re-admitted, overwritten or removed: a settled charge, an ambiguous hold and a hold at another maximum stay as they are.
      if (existing.state === 'HELD' && existing.maxChargeMicros === request.maxChargeMicros) return this.inner.admit(request);
      throw new IntelligenceError('CONTRACT_VIOLATION', `reservation ${request.reservationId} is already ${existing.state} at ${String(existing.maxChargeMicros)} micros on this campaign grant`);
    }
    // Decided and held before the first await: nothing interleaves between the check and the hold.
    const refusal = this.standing() ?? (request.maxChargeMicros > this.balance().remainingMicros ? 'REQUEST_DOES_NOT_FIT_REMAINING_GRANT' : null);
    if (refusal !== null) {
      this.refusals.push({ runId: request.runId, reservationId: request.reservationId, maxChargeMicros: request.maxChargeMicros, reason: refusal });
      return 'NO_FUNDED_GRANT';
    }
    const fresh: Hold = { maxChargeMicros: request.maxChargeMicros, requestKey: request.requestKey ?? null, state: 'HELD', chargeMicros: null };
    this.record({ kind: 'HOLD', runId: request.runId, reservationId: request.reservationId, maxChargeMicros: request.maxChargeMicros, ...(request.requestKey === undefined ? {} : { requestKey: request.requestKey }) });
    this.holds.set(key, fresh);
    // Only the hold this call made is withdrawn when the host does not admit it, and only while nothing settled it.
    const withdraw = (): void => {
      if (this.holds.get(key) === fresh && fresh.state === 'HELD') {
        this.record({ kind: 'DROP', runId: request.runId, reservationId: request.reservationId });
        this.holds.delete(key);
      }
    };
    let outcome: AdmissionOutcome;
    try {
      outcome = await this.inner.admit(request);
    } catch (error) {
      withdraw();
      throw error;
    }
    if (outcome !== 'ADMITTED') withdraw();
    return outcome;
  }

  async settle(settlement: Settlement): Promise<void> {
    await this.inner.settle(settlement);
    const hold = this.holds.get(keyOf(settlement.runId, settlement.reservationId));
    const changes = hold === undefined ? settlement.state !== 'RELEASED' : hold.state === 'HELD' || (hold.state === 'AMBIGUOUS' && settlement.state === 'COMMITTED');
    if (changes) {
      this.record({ kind: 'SETTLE', runId: settlement.runId, reservationId: settlement.reservationId, state: settlement.state, chargeMicros: settlement.chargeMicros });
      this.apply(settlement.runId, settlement.reservationId, settlement.state, settlement.chargeMicros);
    }
    // A charge above its reservation is liability: it is never netted and it stops the campaign.
    if (this.balance().liabilityMicros > 0) this.halt('LIABILITY_ABOVE_RESERVATION');
  }

  /**
   * G23: releases an AMBIGUOUS hold on proof the provider never accepted its request (the host's reconciliation of the protected
   * receipts, reconcileAmbiguousHold). The hold is found by the request key its HOLD line carries. Only an AMBIGUOUS hold is
   * released (a hold still in flight may have a live sender; a committed or released one is settled), once, and the release is written
   * to the ledger as a reconciled settlement with its reason before it takes effect. An ordinary RELEASED settlement never does this.
   */
  releaseAmbiguous(release: { readonly requestKey: string; readonly reason: string }): { readonly released: boolean; readonly why: string | null } {
    if (typeof release.reason !== 'string' || release.reason.trim() === '') throw new IntelligenceError('CONTRACT_VIOLATION', 'a reconciled release names its reason (the documented non-acceptance)');
    const entry = [...this.holds.entries()].find(([, hold]) => hold.requestKey === release.requestKey);
    if (entry === undefined) return { released: false, why: 'NO_HOLD_FOR_REQUEST_KEY' };
    const [key, hold] = entry;
    if (hold.state !== 'AMBIGUOUS') return { released: false, why: 'HOLD_IS_' + hold.state };
    const [runId, reservationId] = JSON.parse(key) as [string, string];
    this.record({ kind: 'SETTLE', runId, reservationId, state: 'RELEASED', chargeMicros: 0, requestKey: release.requestKey, reason: release.reason, reconciled: true });
    this.apply(runId, reservationId, 'RELEASED', 0, true);
    return { released: true, why: null };
  }

  private spentMicros(): number {
    const balance = this.balance();
    return balance.heldMicros + balance.chargedMicros;
  }

  /** A run starts only if its projected full cost fits what is left; one run at a time. */
  beginRun(run: { readonly runId: string; readonly candidate: string; readonly runNo?: number | null; readonly fixtures: number; readonly perFixtureMicros: number }): RunStart {
    const projectedMicros = projectedRunMicros(run.perFixtureMicros, run.fixtures);
    if (!isMicros(projectedMicros)) throw new IntelligenceError('CONTRACT_VIOLATION', 'a run projects a whole, finite cost');
    const standing = this.standing();
    if (standing !== null) return { started: false, projectedMicros, reason: standing };
    if (!this.grant.candidates.includes(run.candidate)) return { started: false, projectedMicros, reason: 'CANDIDATE_NOT_GRANTED' };
    const runNo = run.runNo ?? null;
    if (runNo !== null && this.runs.some((earlier) => earlier.stage === this.stage && earlier.runNo === runNo)) return { started: false, projectedMicros, reason: 'RUN_NO_ALREADY_USED' };
    if (this.grant.maxRuns !== null && this.runs.length >= this.grant.maxRuns) return { started: false, projectedMicros, reason: 'MAX_RUNS_REACHED' };
    if (this.active !== null) return { started: false, projectedMicros, reason: 'RUN_IN_PROGRESS' };
    if (projectedMicros > this.balance().remainingMicros) return { started: false, projectedMicros, reason: 'PROJECTED_COST_DOES_NOT_FIT' };
    // Written before the run starts: a run that crashes or is abandoned still counts toward the grant.
    this.record({ kind: 'RUN', runId: run.runId, stage: this.stage, runNo, candidate: run.candidate });
    this.runs.push({ runId: run.runId, stage: this.stage, runNo, candidate: run.candidate });
    this.active = { runId: run.runId, projectedMicros, baselineMicros: this.spentMicros() };
    return { started: true, projectedMicros, reason: null };
  }

  endRun(runId: string): void {
    if (this.active?.runId === runId) this.active = null;
  }

  /** The runner's check every 50 fixtures: committed + held above the run's projection by 25 % stops the campaign. */
  checkpoint(fixturesDone: number): 'CONTINUE' | 'STOP' {
    if (!Number.isSafeInteger(fixturesDone) || fixturesDone < 0) throw new IntelligenceError('CONTRACT_VIOLATION', 'fixtures done is a count');
    if (this.haltedFor !== null) return 'STOP';
    if (this.active !== null && (this.spentMicros() - this.active.baselineMicros) * 100 > this.active.projectedMicros * 125) {
      this.halt('RUN_PROJECTION_EXCEEDED_BY_25_PERCENT');
      return 'STOP';
    }
    return 'CONTINUE';
  }
}

export interface FixtureRequestBytes {
  readonly fixtureId: string;
  /** The UTF-8 byte length of each first-attempt request body of the fixture's run, in order. */
  readonly requests: readonly number[];
}

export interface EnvelopeOptions {
  /** Tokens added to every request for the provider's hidden structured-output and framing text. */
  readonly hiddenInputTokensPerRequest: number;
  readonly plannedOutputTokensPerRequest: number;
  readonly outputCeilingTokens: number;
  readonly bytesPerToken: number;
  /** Repair requests as a share of first-attempt requests, and the median bytes of one. */
  readonly repairShare: number;
  readonly repairBytes: number;
}

export interface Envelope {
  readonly fixtures: number;
  /** First-attempt requests and their bytes: counted from the sealed corpus, not estimated. */
  readonly requests: number;
  readonly requestBytes: number;
  readonly repairRequests: number;
  readonly inputUpperBoundTokens: number;
  /** Every request at its worst case: byte bound + allowance in, the output ceiling out. Never spent; the admission stops first. */
  readonly upperBoundMicros: number;
  readonly planningMicros: number;
  readonly perFixtureMicros: number;
  /** The first-attempt bytes are exact; the repairs, the output and the tokens per byte are the estimates. */
  readonly exactFirstAttemptBytes: true;
  readonly estimated: readonly string[];
}

/** The reservation of a stage from the sealed corpus's exact first-attempt request bytes, at the candidate's tariff. */
export function envelopeOf(fixtures: readonly FixtureRequestBytes[], profile: CandidateProfile, options: EnvelopeOptions): Envelope {
  const firstRequests = fixtures.reduce((sum, entry) => sum + entry.requests.length, 0);
  const firstBytes = fixtures.reduce((sum, entry) => sum + entry.requests.reduce((inner, bytes) => inner + bytes, 0), 0);
  const repairRequests = Math.ceil(firstRequests * options.repairShare);
  const requests = firstRequests + repairRequests;
  const bytes = firstBytes + repairRequests * options.repairBytes;
  const inputUpperBoundTokens = bytes + options.hiddenInputTokensPerRequest * requests;
  const upperBoundMicros = Math.ceil(inputUpperBoundTokens * profile.inputMicroUsdPerToken + requests * options.outputCeilingTokens * profile.outputMicroUsdPerToken);
  const planningMicros = Math.ceil((bytes / options.bytesPerToken + options.hiddenInputTokensPerRequest * requests) * profile.inputMicroUsdPerToken + requests * options.plannedOutputTokensPerRequest * profile.outputMicroUsdPerToken);
  return {
    fixtures: fixtures.length, requests: firstRequests, requestBytes: firstBytes, repairRequests, inputUpperBoundTokens, upperBoundMicros, planningMicros,
    perFixtureMicros: fixtures.length === 0 ? 0 : Math.ceil(planningMicros / fixtures.length), exactFirstAttemptBytes: true, estimated: ['repair requests', 'output tokens', 'tokens per byte', 'hidden input tokens'],
  };
}
