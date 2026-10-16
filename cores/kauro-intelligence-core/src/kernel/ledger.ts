/**
 * The immutable Run Ledger: an append-only event log from which every fact
 * about a run is derived — its state, its budget, its reservations, its
 * stored responses, its cancellation. Nothing is edited; a restart rebuilds
 * the same view from the same events, which is how a restart neither resets
 * a budget nor hides an attempt.
 *
 * The store and the clock are injected. The ledger never reads a wall clock
 * of its own, so a deadline can be tested without waiting for it. Every
 * write is a compare-and-append against the length the ledger read, so two
 * workers that both decided on the same stale view cannot both get their
 * decision in: the second one learns it lost and decides again, or gives up.
 *
 * Ownership is fenced. Each RunLedger handle mints an owner token; the LEASE
 * event records it, and every write the handle makes — a reservation, a
 * commit, a transition, an outcome, a note, the result — is checked against
 * the lease in force: a handle whose token is not the one on the latest
 * LEASE is fenced out (LEDGER_FENCED) and appends nothing. A late response
 * from a worker that lost the attempt is therefore discarded, never
 * committed beside the takeover's. The host's cancel is not a write of an
 * owner and is never fenced. The one append a fenced-out owner may still
 * make is RECONCILIATION_EVIDENCE for its own reservation: the usage and the
 * digest of its late answer, which settle what it cost and nothing else.
 *
 * A request is PREPARED once — its exact envelope, what every send of it
 * sends — and each invocation of it then leaves these facts, in this order
 * (D3-JRN-1): RESERVED, ADMISSION (the host's money admission of its maximum
 * charge), SEND_STARTED (the last write before the request may leave),
 * RESPONSE_STORED naming its reservation, then COMMITTED, AMBIGUOUS or
 * RELEASED; TASK_OUTCOME follows from what was answered. A reopening releases a
 * reservation with no SEND_STARTED — the proof it was never dispatched —
 * keeps a sent one AMBIGUOUS, and hands back one whose answer is stored so
 * its reported usage is committed before the answer is compiled. The store's
 * durability barrier (D3-JRN-2) is awaited at the points the core names; a
 * refused barrier is the fence.
 */
import { randomBytes } from 'node:crypto';

import { digestOf, stableRef } from '../contracts/canonical.js';
import type { IntelligenceEnvelopeV1 } from '../contracts/envelope.js';
import { IntelligenceError } from '../contracts/errors.js';
import { ABSOLUTE_WINDOW_MS, BUDGET_LIMITS, MAX_INVOCATIONS_PER_REQUEST, RUN_TRANSITIONS, TERMINAL_RUN_STATES } from '../contracts/run.js';
import type { Reservation, RunState, Usage } from '../contracts/run.js';
import { RUN_LEDGER_VERSION } from '../contracts/versions.js';
import type { AdmissionOutcome } from './admission.js';

export interface Clock {
  now(): string;
  nowMs(): number;
}

export type LedgerEvent =
  /**
   * semanticDeadlineAt gates every reservation and dispatch; absoluteDeadlineAt gates promotion (D3-TIME-1). Both are fixed here, at creation, and read from here by every reopening.
   * egressKeyId and egressKeyCheck bind the attempt's egress key (D3-KEY-1): the host's key id and a keyed check value, never the secret.
   */
  | { readonly kind: 'RUN_CREATED'; readonly at: string; readonly runId: string; readonly auditAttemptId: string; readonly projectRevisionHash: string; readonly hashes: Readonly<Record<string, string | null>>; readonly versions: Readonly<Record<string, string>>; readonly semanticDeadlineAt: string; readonly absoluteDeadlineAt: string; readonly tenant: { readonly agencyId: string; readonly clientId: string }; readonly egressKeyId: string | null; readonly egressKeyCheck: string | null }
  | { readonly kind: 'STATE'; readonly at: string; readonly from: RunState; readonly to: RunState; readonly reason: string }
  /**
   * One request as it will be sent, before anything is reserved for it
   * (D3-JRN-1): the exact envelope — so, with the pinned bundle, the exact
   * bytes — its hash, the digest and length of the provider request those
   * bytes make, its maximum charge and deadline. Every send of the request,
   * a retry by another process included, sends this, never a rebuild. The
   * envelope is the host's protected record; the public projection keeps the
   * key, the hashes, the length, the charge and the deadline (D3-PRIV-1).
   */
  | { readonly kind: 'PREPARED'; readonly at: string; readonly requestKey: string; readonly envelopeHash: string; readonly envelope: IntelligenceEnvelopeV1; readonly requestDigest: string; readonly requestBytes: number; readonly maxChargeMicros: number; readonly deadlineAt: string }
  | { readonly kind: 'RESERVED'; readonly at: string; readonly reservation: Reservation; readonly idempotencyKey: string }
  /** The host's money admission of one reservation's maximum charge (D3-GRANT-1): only an ADMITTED reservation may be marked sent. */
  | { readonly kind: 'ADMISSION'; readonly at: string; readonly reservationId: string; readonly maxChargeMicros: number; readonly outcome: AdmissionOutcome }
  /** The last write before the request may leave the process: a reservation without it provably never reached the provider. */
  | { readonly kind: 'SEND_STARTED'; readonly at: string; readonly reservationId: string }
  /** chargeMicros: what the grant is charged — the reported usage priced by the tariff, or the maximum charge when the usage is unknown; null where no tariff priced it. */
  | { readonly kind: 'COMMITTED'; readonly at: string; readonly reservationId: string; readonly usage: Usage; readonly usageKnown: boolean; readonly chargeMicros: number | null }
  | { readonly kind: 'RELEASED'; readonly at: string; readonly reservationId: string; readonly reason: string }
  | { readonly kind: 'AMBIGUOUS'; readonly at: string; readonly reservationId: string; readonly reason: string }
  /**
   * envelopeHash is the hash of the envelope the response answered — the one the proposal names — which a resumed run rebuilds with another budget snapshot and therefore another hash. reservationId names the invocation it answers; providerRequestId is the provider's own identity of the request when the answer carried one.
   * `response` is the provider's answer as it came: protected evidence of the host's store under its retention class, never in the public projection (D3-PRIV-1).
   */
  | { readonly kind: 'RESPONSE_STORED'; readonly at: string; readonly idempotencyKey: string; readonly envelopeHash: string; readonly responseDigest: string; readonly response: unknown; readonly reservationId: string; readonly providerRequestId: string | null }
  /** The one append of a fenced-out owner (D3-FENCE-1): what its late answer reported for its own reservation — usage, charge, digest — which settles that reservation. Never the answer itself. */
  | { readonly kind: 'RECONCILIATION_EVIDENCE'; readonly at: string; readonly reservationId: string; readonly ownerId: string; readonly usage: Usage; readonly usageKnown: boolean; readonly chargeMicros: number | null; readonly responseDigest: string | null; readonly providerRequestId: string | null }
  | { readonly kind: 'TASK_OUTCOME'; readonly at: string; readonly taskId: string; readonly outcome: string; readonly attempt: number; readonly codes: readonly string[]; readonly envelopeHash: string | null; readonly proposalDigest: string | null }
  | { readonly kind: 'CANCELLED'; readonly at: string; readonly reason: string }
  /** Ownership of the attempt: the owner token holds it until leaseUntil by the run's clock; the latest LEASE event is the one in force. workerId names the process, for the record; ownerId is what a write is checked against. */
  | { readonly kind: 'LEASE'; readonly at: string; readonly workerId: string; readonly ownerId: string; readonly leaseUntil: string }
  | { readonly kind: 'RESULT'; readonly at: string; readonly result: unknown }
  | { readonly kind: 'NOTE'; readonly at: string; readonly note: string; readonly counters: Readonly<Record<string, number>> };

/**
 * The persistence port. The one property a host implementation must give
 * is optimistic concurrency on append: the event lands only when the log
 * holds exactly `expectedLength` events at that moment, and otherwise
 * nothing is written and the outcome names the length it found. A store
 * that appends unconditionally lets two consumers reserve, and therefore
 * send, the same billable unit. A database implements this as a unique
 * index on (runId, sequence); a file as a length check under a lock.
 */
export type AppendOutcome = { readonly ok: true; readonly length: number } | { readonly ok: false; readonly conflict: 'LENGTH_MISMATCH'; readonly actualLength: number };

/**
 * Where the core waits for the journal to be durable (D3-JRN-2):
 * BEFORE_DISPATCH after SEND_STARTED and before the request may leave,
 * AFTER_RESPONSE once an invocation's outcome is written, BEFORE_VALIDATION
 * before the host validates, AFTER_RESULT once the answer and its closing
 * state are written.
 */
export const BARRIER_POINTS = Object.freeze(['BEFORE_DISPATCH', 'AFTER_RESPONSE', 'BEFORE_VALIDATION', 'AFTER_RESULT'] as const);
export type BarrierPoint = (typeof BARRIER_POINTS)[number];
/** A refused barrier is the fence: the store will not make this owner's events durable, and nothing is dispatched on them. */
export type BarrierOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface LedgerStore {
  append(runId: string, event: LedgerEvent, expectedLength: number): AppendOutcome;
  read(runId: string): readonly LedgerEvent[];
  /**
   * Resolves once the first `length` events of the run are durable. A store
   * that writes through (a database row per append) resolves at once; a
   * buffering adapter flushes there under its step fence and refuses when
   * the fence has moved.
   */
  barrier(runId: string, length: number, point: BarrierPoint): Promise<BarrierOutcome>;
}

/**
 * RESPONSE_STORED as the public ledger shows it (D3-PRIV-1): which request it
 * answered (key and envelope hash), the digest of the stored answer, its size
 * in bytes, the usage it was counted at and its stop reason — never its
 * content, which may echo a credential, customer text or the prompt. The
 * digest lets an auditor with access to the host's protected store match the
 * two.
 */
export interface PublicResponseStored {
  readonly kind: 'RESPONSE_STORED';
  readonly at: string;
  readonly idempotencyKey: string;
  readonly envelopeHash: string;
  readonly responseDigest: string;
  readonly byteLength: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly stopReason: 'end_turn' | 'max_tokens' | 'refusal' | 'other' | null;
  /** The invocation it answers, and the provider's own request id when the answer carried one an id alphabet allows. */
  readonly reservationId: string;
  readonly providerRequestId: string | null;
}

/**
 * PREPARED as the public ledger shows it (D3-PRIV-1): which request it is
 * (its key and the hash of its envelope), the digest and UTF-8 length of the
 * provider request its envelope makes, its maximum charge and its deadline —
 * never the envelope itself, which only the host's protected store keeps
 * beside the stored answers.
 */
export type PublicPrepared = Omit<Extract<LedgerEvent, { kind: 'PREPARED' }>, 'envelope'>;

/** An event of the public ledger: every event as the store holds it, except a prepared request and a stored response, which are projected. */
export type PublicLedgerEvent = Exclude<LedgerEvent, { readonly kind: 'RESPONSE_STORED' | 'PREPARED' }> | PublicResponseStored | PublicPrepared;

const STOP_REASONS: readonly string[] = ['end_turn', 'max_tokens', 'refusal', 'other'];

/** What the public ledger says of a stored answer: its size, the usage it was counted at, its stop reason — each read defensively, since a store holds what it was given. */
function responseFacts(response: unknown): Pick<PublicResponseStored, 'byteLength' | 'usage' | 'stopReason'> {
  const record = response !== null && typeof response === 'object' && !Array.isArray(response) ? (response as Record<string, unknown>) : {};
  const content = record['content'];
  const byteLength = Buffer.byteLength(typeof content === 'string' ? content : (JSON.stringify(response) ?? ''), 'utf8');
  const usage = record['usage'];
  const counted = usage !== null && typeof usage === 'object' && usageIsValid(usage as { readonly inputTokens: unknown; readonly outputTokens: unknown }) ? { inputTokens: (usage as { inputTokens: number }).inputTokens, outputTokens: (usage as { outputTokens: number }).outputTokens } : null;
  const stop = record['stopReason'];
  return { byteLength, usage: counted, stopReason: typeof stop === 'string' && STOP_REASONS.includes(stop) ? (stop as PublicResponseStored['stopReason']) : null };
}

/** One event as the public ledger shows it. */
export function publicEvent(event: LedgerEvent): PublicLedgerEvent {
  if (event.kind === 'PREPARED') {
    const { envelope: prepared, ...digests } = event;
    void prepared;
    return digests;
  }
  if (event.kind !== 'RESPONSE_STORED') return event;
  const { response, ...kept } = event;
  return { ...kept, ...responseFacts(response) };
}

/**
 * The public projection of a run's log (D3-PRIV-1): what `result.runLedger`
 * and `readRun()` return. The host's LedgerStore stays the protected,
 * bounded evidence record; what leaves the core as a result is this.
 */
export function publicLedger(events: readonly LedgerEvent[]): readonly PublicLedgerEvent[] {
  return events.map(publicEvent);
}

export class MemoryLedgerStore implements LedgerStore {
  private readonly events = new Map<string, LedgerEvent[]>();
  append(runId: string, event: LedgerEvent, expectedLength: number): AppendOutcome {
    const list = this.events.get(runId) ?? [];
    if (list.length !== expectedLength) return { ok: false, conflict: 'LENGTH_MISMATCH', actualLength: list.length };
    list.push(structuredClone(event));
    this.events.set(runId, list);
    return { ok: true, length: list.length };
  }
  read(runId: string): readonly LedgerEvent[] {
    return (this.events.get(runId) ?? []).map((event) => structuredClone(event));
  }
  /** Every append is already as durable as this store gets: the barrier resolves at once, whatever the point. */
  async barrier(runId: string, length: number, point: BarrierPoint): Promise<BarrierOutcome> {
    void [runId, length, point];
    return { ok: true };
  }
}

export interface BudgetView {
  /** Usage the provider reported, or the reservation size where it reported none. */
  readonly billedInputTokens: number;
  readonly billedOutputTokens: number;
  /** Open and ambiguous reservations, both counted at full size. */
  readonly reservedInputTokens: number;
  readonly reservedOutputTokens: number;
  /** The part of reserved that is ambiguous: sent or possibly sent, never answered. */
  readonly ambiguousInputTokens: number;
  readonly ambiguousOutputTokens: number;
  readonly remainingInputTokens: number;
  readonly remainingOutputTokens: number;
  readonly tasksStarted: number;
  readonly remainingTasks: number;
  /** Every reservation made: every call that could have reached the provider. */
  readonly invocations: number;
  /** Invocations that came back with a response, whatever it said. */
  readonly responses: number;
  readonly ambiguousReservations: number;
  /** The semantic deadline: what the envelope's budget snapshot names as the time left to answer. */
  readonly deadlineAt: string;
}

/** The run's money, read off its ADMISSION, COMMITTED, AMBIGUOUS, RELEASED and RECONCILIATION_EVIDENCE facts. */
export interface GrantLedgerView {
  /** Reservations the grant admitted, and those it refused (NO_FUNDED_GRANT or FENCED). */
  readonly admissions: number;
  readonly refusals: number;
  /** The maximum charge of every admitted reservation not settled yet: in flight, or ambiguous. */
  readonly heldMicros: number;
  /** Every settled charge: reported usage priced by the tariff, unknown usage at its maximum charge. */
  readonly chargedMicros: number;
  /** Charges settled at the maximum charge because no usage was reported. */
  readonly unknownUsageCharges: number;
  /** What was charged above the reservations' maximum charges: actual liability, never netted. */
  readonly liabilityMicros: number;
}

/** What the journal knows of one invocation beyond its reservation. */
export interface DispatchFacts {
  readonly admission: { readonly maxChargeMicros: number; readonly outcome: AdmissionOutcome } | null;
  readonly sendStarted: boolean;
  /** What its settlement charged, from its COMMITTED or, failing that, the reconciliation evidence that settled it; null while unsettled. */
  readonly charge: { readonly chargeMicros: number | null; readonly usageKnown: boolean } | null;
}

export interface RunView {
  readonly runId: string;
  readonly state: RunState;
  readonly cancelled: boolean;
  /** Gates every reservation and dispatch (D3-TIME-1). */
  readonly semanticDeadlineAt: string;
  /** Gates promotion (D3-TIME-1). */
  readonly absoluteDeadlineAt: string;
  readonly budget: BudgetView;
  readonly grant: GrantLedgerView;
  readonly reservations: readonly Reservation[];
  readonly taskOutcomes: readonly Extract<LedgerEvent, { kind: 'TASK_OUTCOME' }>[];
  readonly events: number;
  /** The owner of the attempt (token and process name) and until when, by the latest LEASE event; null before any worker took it. */
  readonly lease: { readonly workerId: string; readonly ownerId: string; readonly leaseUntil: string } | null;
}

export type LeaseView = NonNullable<RunView['lease']>;

/** A request as PREPARED records it: what every send of it sends. */
export interface PreparedRequest {
  readonly envelope: IntelligenceEnvelopeV1;
  readonly envelopeHash: string;
  /** sha256 of the provider request bytes the envelope makes under the pinned bundle, and their UTF-8 length. */
  readonly requestDigest: string;
  readonly requestBytes: number;
  readonly maxChargeMicros: number;
  readonly deadlineAt: string;
}

/** A stored answer as the ledger holds it: the body, the envelope it answered and the invocation it answers. */
export interface StoredResponse {
  readonly response: unknown;
  readonly envelopeHash: string;
  readonly reservationId: string;
}

/** What a reopening did with every reservation left open (D3-JRN-1). */
export interface ReopenOutcome {
  /** No SEND_STARTED on the record: never dispatched, released. */
  readonly released: readonly Reservation[];
  /** Sent, with no answer on the record: kept AMBIGUOUS at full size. */
  readonly ambiguous: readonly Reservation[];
  /** Sent and answered, not billed: left open for the caller to commit with the usage the stored answer reports. */
  readonly answered: readonly { readonly reservation: Reservation; readonly stored: StoredResponse }[];
}

export interface CreateRunInput {
  /** The host's AuditAttempt identity; the run id derives from it, never from the clock. */
  readonly auditAttemptId: string;
  readonly projectRevisionHash: string;
  readonly hashes: Readonly<Record<string, string | null>>;
  readonly versions: Readonly<Record<string, string>>;
  readonly tenant: { readonly agencyId: string; readonly clientId: string };
  /** The resource profile's semantic window; it can only shorten the policy's. */
  readonly wallClockMs?: number;
  /** The host's interpretation and absolute deadlines, as instants in milliseconds; each can only shorten its window. */
  readonly interpretationDeadlineMs?: number;
  readonly absoluteDeadlineMs?: number;
  /**
   * The attempt's egress key as the record may hold it (D3-KEY-1): the
   * host's key id and a keyed check value that tells two secrets apart —
   * never the secret. A reopening under another key is IDENTITY_CONFLICT.
   */
  readonly egressKey?: { readonly keyId: string; readonly check: string };
}

type Created = Extract<LedgerEvent, { kind: 'RUN_CREATED' }>;

/** A usage figure the ledger will count: finite, integral, not negative. Anything else is unknown, never zero. */
export function usageIsValid(usage: { readonly inputTokens: unknown; readonly outputTokens: unknown } | null | undefined): usage is { readonly inputTokens: number; readonly outputTokens: number } {
  if (usage === null || usage === undefined) return false;
  return [usage.inputTokens, usage.outputTokens].every((value) => typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0);
}

export class RunLedger {
  readonly runId: string;
  /**
   * The owner token of this handle: minted once per handle, never shared,
   * written into the LEASE event when the handle takes the lease and checked
   * on every write. A run() invocation opens one handle, so the owner of an
   * attempt is that invocation — not the process, not the core instance.
   */
  readonly ownerId: string;
  private readonly store: LedgerStore;
  private readonly clock: Clock;

  private constructor(runId: string, store: LedgerStore, clock: Clock) {
    this.runId = runId;
    this.ownerId = `owner_${randomBytes(12).toString('hex')}`;
    this.store = store;
    this.clock = clock;
  }

  /** The run id: the host's attempt within its tenant, and nothing that changes with time. */
  static runIdFor(auditAttemptId: string, tenant: { readonly agencyId: string; readonly clientId: string }): string {
    return stableRef('run', { auditAttemptId, tenant });
  }

  /**
   * A new run, or the same run again. The id is the host's AuditAttempt
   * within its tenant — never the clock — so a redelivery of the same
   * attempt, a second later or after a restart, opens the existing log
   * instead of starting a second run, which is how a durable response is
   * found instead of bought again. What the attempt is about (revision,
   * hashes, versions) is written once at creation and checked on every
   * reopening: an attempt id reused for different content is a host defect
   * and fails before anything is spent.
   */
  static create(store: LedgerStore, clock: Clock, input: CreateRunInput): RunLedger {
    const at = clock.now();
    if (input.auditAttemptId.trim() === '') throw new IntelligenceError('CONTRACT_VIOLATION', 'a run needs the host AuditAttempt identity');
    const runId = RunLedger.runIdFor(input.auditAttemptId, input.tenant);
    const versions = { ...input.versions, runLedgerVersion: RUN_LEDGER_VERSION };
    const existing = store.read(runId);
    if (existing.length === 0) {
      const windows = RunLedger.windowsFrom(clock.nowMs(), input);
      const appended = store.append(runId, { kind: 'RUN_CREATED', at, runId, auditAttemptId: input.auditAttemptId, projectRevisionHash: input.projectRevisionHash, hashes: input.hashes, versions, semanticDeadlineAt: windows.semanticDeadlineAt, absoluteDeadlineAt: windows.absoluteDeadlineAt, tenant: input.tenant, ...RunLedger.keyBinding(input) }, 0);
      // Lost the race to another worker creating the same attempt: fall through and check its content like any reopening.
      if (appended.ok) return new RunLedger(runId, store, clock);
    }
    const created = store.read(runId)[0];
    if (created === undefined || created.kind !== 'RUN_CREATED') throw new IntelligenceError('CONTRACT_VIOLATION', `the log of run ${runId} does not start with RUN_CREATED`);
    RunLedger.assertSameIdentity(created, { ...input, versions });
    return new RunLedger(runId, store, clock);
  }

  /**
   * The two windows of a run starting at `startMs` (D3-TIME-1). The absolute
   * deadline is the earlier of twenty-four hours from the start and the
   * host's absolute deadline. The semantic deadline is the earliest of the
   * policy's twenty minutes from the start — which the resource profile can
   * shorten and never extend — the host's interpretation deadline and the
   * absolute deadline: nothing is dispatched once the audit is over.
   */
  static windowsFrom(startMs: number, input: Pick<CreateRunInput, 'wallClockMs' | 'interpretationDeadlineMs' | 'absoluteDeadlineMs'>): { readonly semanticDeadlineAt: string; readonly absoluteDeadlineAt: string } {
    const bounded = (value: number | undefined): number => (typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY);
    const absolute = Math.min(startMs + ABSOLUTE_WINDOW_MS, bounded(input.absoluteDeadlineMs));
    const window = Math.min(bounded(input.wallClockMs), BUDGET_LIMITS.MAX_INTELLIGENCE_WALL_CLOCK_MS);
    const semantic = Math.min(startMs + window, bounded(input.interpretationDeadlineMs), absolute);
    return { semanticDeadlineAt: new Date(semantic).toISOString(), absoluteDeadlineAt: new Date(absolute).toISOString() };
  }

  private static assertSameIdentity(created: Created, input: CreateRunInput): void {
    const differing: string[] = [];
    if (created.auditAttemptId !== input.auditAttemptId) differing.push('auditAttemptId');
    if (digestOf(created.tenant) !== digestOf(input.tenant)) differing.push('tenant');
    if (created.projectRevisionHash !== input.projectRevisionHash) differing.push('projectRevisionHash');
    // The hashes, and each declared member among them by name: the conflict says which one the redelivery changed (D3-ID-1).
    if (digestOf(created.hashes) !== digestOf(input.hashes)) {
      const names = [...new Set([...Object.keys(created.hashes), ...Object.keys(input.hashes)])].sort();
      differing.push('hashes', ...names.filter((name) => created.hashes[name] !== input.hashes[name]).map((name) => `hashes.${name}`));
    }
    if (digestOf(created.versions) !== digestOf(input.versions)) differing.push('versions');
    // The attempt's egress key: masked labels and scoped references are keyed by it, so another key would rebuild every request differently and buy every stored answer again.
    const key = RunLedger.keyBinding(input);
    if ((created.egressKeyId ?? null) !== key.egressKeyId) differing.push('egressKeyId');
    else if ((created.egressKeyCheck ?? null) !== key.egressKeyCheck) differing.push('egressKeyCheck');
    if (differing.length > 0) throw new IntelligenceError('IDENTITY_CONFLICT', `AuditAttempt ${input.auditAttemptId} already names a run about different content (${differing.join(', ')}); a new attempt needs a new identity`, { runId: created.runId, differing });
  }

  /** What RUN_CREATED records of the attempt's key: its id and check value, or nulls for a run created without one (a ledger used on its own). */
  private static keyBinding(input: CreateRunInput): { readonly egressKeyId: string | null; readonly egressKeyCheck: string | null } {
    return { egressKeyId: input.egressKey?.keyId ?? null, egressKeyCheck: input.egressKey?.check ?? null };
  }

  /** The same run, after a restart: nothing but the events. */
  static open(store: LedgerStore, clock: Clock, runId: string): RunLedger {
    const events = store.read(runId);
    if (events.length === 0 || events[0]?.kind !== 'RUN_CREATED') throw new IntelligenceError('CONTRACT_VIOLATION', `no run ${runId} in the store`);
    return new RunLedger(runId, store, clock);
  }

  private events(): readonly LedgerEvent[] {
    return this.store.read(this.runId);
  }

  /** One write against the length that was read; a loss is a conflict, never a silent second write — and a loss to a takeover is the fence, named as such. */
  private appendAt(expectedLength: number, event: LedgerEvent): void {
    const outcome = this.store.append(this.runId, event, expectedLength);
    if (outcome.ok) return;
    this.fence(this.events(), event.kind);
    throw new IntelligenceError('LEDGER_CONFLICT', `another writer appended to run ${this.runId} first (${event.kind} at ${String(expectedLength)}, log is ${String(outcome.actualLength)})`, { kind: event.kind, expectedLength, actualLength: outcome.actualLength });
  }

  /** How many times a write decides again after losing its append to a writer that did not change what it decides on; a real store has one such writer (the host's cancel), so one retry is the case and the bound is generous. */
  private static readonly MAX_DECIDING_APPENDS = 4;

  /**
   * One write that decides again when it loses its compare-and-append to a
   * writer that changed nothing about it — the host's cancel, a note landing
   * beside it — instead of failing the owner's flow between two appends that
   * belong together. Every try re-reads the log, is fenced (a loss to a
   * takeover is still the fence) and asks `stillWanted` whether the write
   * is still due on what the log now says; a write already on the record
   * or no longer due is not made twice.
   */
  private appendDeciding(build: () => LedgerEvent, stillWanted: (view: RunView, events: readonly LedgerEvent[]) => boolean): void {
    let last: AppendOutcome | null = null;
    for (let tries = 0; tries < RunLedger.MAX_DECIDING_APPENDS; tries += 1) {
      const events = this.events();
      const event = build();
      const view = this.fence(events, event.kind);
      if (!stillWanted(view, events)) return;
      last = this.store.append(this.runId, event, events.length);
      if (last.ok) return;
    }
    throw new IntelligenceError('LEDGER_CONFLICT', `another writer kept appending to run ${this.runId} while a write was being decided`, { actualLength: last !== null && !last.ok ? last.actualLength : -1 });
  }

  /**
   * The fence on every write of an owner, and the view the write decides on.
   * A run nobody has taken is open to its creator (the core takes the lease
   * before the first reservation). Once a lease is on the record, the latest
   * LEASE must carry this handle's token: a write from an owner the lease
   * has moved away from — a worker whose lease lapsed during a slow call and
   * was taken over, a second invocation on the same attempt — is
   * LEDGER_FENCED, and what it carried is appended nowhere. A lease lapsed
   * but not taken over is still its owner's: what that owner writes is the
   * only account of what it did, and the next taker finds it on the record.
   * When the attempt is already finished under the other owner, the discard
   * itself goes on the record as a NOTE — at the end of a closed log, where
   * nothing live is disturbed by it; a run still in progress gets no write
   * from a fenced-out owner at all.
   */
  private fence(events: readonly LedgerEvent[], kind: string): RunView {
    const view = this.viewOf(events);
    if (view.lease === null || view.lease.ownerId === this.ownerId) return view;
    if (events.some((entry) => entry.kind === 'RESULT')) this.store.append(this.runId, { kind: 'NOTE', at: this.clock.now(), note: `late ${kind} from a fenced-out owner discarded; the attempt was taken over and finished`, counters: { discarded: 1 } }, events.length);
    throw new IntelligenceError('LEDGER_FENCED', `run ${this.runId} is held by ${view.lease.workerId} (${view.lease.ownerId}) until ${view.lease.leaseUntil}; a ${kind} from ${this.ownerId} is discarded`, { runId: this.runId, kind, holder: view.lease.workerId, holderOwnerId: view.lease.ownerId, leaseUntil: view.lease.leaseUntil, ownerId: this.ownerId });
  }

  view(): RunView {
    return this.viewOf(this.events());
  }

  private viewOf(events: readonly LedgerEvent[]): RunView {
    const created = events[0] as Created;
    let state: RunState = 'CREATED';
    let cancelled = false;
    let lease: LeaseView | null = null;
    const reservations = new Map<string, Reservation>();
    let billedInput = 0;
    let billedOutput = 0;
    let responses = 0;
    const tasks = new Set<string>();
    const outcomes: Extract<LedgerEvent, { kind: 'TASK_OUTCOME' }>[] = [];
    const admitted = new Map<string, number>();
    let admissions = 0;
    let refusals = 0;
    let chargedMicros = 0;
    let unknownUsageCharges = 0;
    let liabilityMicros = 0;
    /** A reservation settled at a charge: billed at its usage, and priced against the maximum charge the grant admitted. */
    const settle = (event: Extract<LedgerEvent, { kind: 'COMMITTED' | 'RECONCILIATION_EVIDENCE' }>): void => {
      const reservation = reservations.get(event.reservationId);
      if (reservation !== undefined) reservations.set(event.reservationId, { ...reservation, state: 'COMMITTED' });
      billedInput += event.usage.inputTokens;
      billedOutput += event.usage.outputTokens;
      if (event.chargeMicros === null) return;
      chargedMicros += event.chargeMicros;
      if (!event.usageKnown) unknownUsageCharges += 1;
      const maxCharge = admitted.get(event.reservationId);
      if (maxCharge !== undefined) liabilityMicros += Math.max(0, event.chargeMicros - maxCharge);
    };
    for (const event of events) {
      switch (event.kind) {
        case 'STATE':
          state = event.to;
          break;
        case 'LEASE':
          lease = { workerId: event.workerId, ownerId: event.ownerId, leaseUntil: event.leaseUntil };
          break;
        case 'CANCELLED':
          cancelled = true;
          break;
        case 'RESERVED':
          reservations.set(event.reservation.reservationId, event.reservation);
          tasks.add(event.reservation.taskId);
          break;
        case 'ADMISSION':
          if (event.outcome === 'ADMITTED') {
            admissions += 1;
            admitted.set(event.reservationId, event.maxChargeMicros);
          } else refusals += 1;
          break;
        case 'COMMITTED':
          settle(event);
          break;
        case 'RECONCILIATION_EVIDENCE': {
          // Evidence settles only what is still open or ambiguous: a reservation already committed is never billed twice.
          const reservation = reservations.get(event.reservationId);
          if (reservation !== undefined && (reservation.state === 'RESERVED' || reservation.state === 'AMBIGUOUS_BILLED')) settle(event);
          break;
        }
        case 'RELEASED': {
          const reservation = reservations.get(event.reservationId);
          if (reservation !== undefined) reservations.set(event.reservationId, { ...reservation, state: 'RELEASED' });
          break;
        }
        case 'AMBIGUOUS': {
          // A timeout after the request was sent may have been billed. The
          // reservation stays counted against the budget at its full size;
          // it is never released on a guess.
          const reservation = reservations.get(event.reservationId);
          if (reservation !== undefined) reservations.set(event.reservationId, { ...reservation, state: 'AMBIGUOUS_BILLED' });
          break;
        }
        case 'RESPONSE_STORED':
          responses += 1;
          break;
        case 'TASK_OUTCOME':
          outcomes.push(event);
          break;
        default:
          break;
      }
    }
    let reservedInput = 0;
    let reservedOutput = 0;
    let ambiguousInput = 0;
    let ambiguousOutput = 0;
    let ambiguous = 0;
    let heldMicros = 0;
    for (const reservation of reservations.values()) {
      if (reservation.state === 'RESERVED' || reservation.state === 'AMBIGUOUS_BILLED') {
        reservedInput += reservation.inputTokens;
        reservedOutput += reservation.outputTokens;
        heldMicros += admitted.get(reservation.reservationId) ?? 0;
      }
      if (reservation.state === 'AMBIGUOUS_BILLED') {
        ambiguousInput += reservation.inputTokens;
        ambiguousOutput += reservation.outputTokens;
        ambiguous += 1;
      }
    }
    return {
      runId: this.runId,
      state,
      cancelled,
      lease,
      semanticDeadlineAt: created.semanticDeadlineAt,
      absoluteDeadlineAt: created.absoluteDeadlineAt,
      budget: {
        billedInputTokens: billedInput,
        billedOutputTokens: billedOutput,
        reservedInputTokens: reservedInput,
        reservedOutputTokens: reservedOutput,
        ambiguousInputTokens: ambiguousInput,
        ambiguousOutputTokens: ambiguousOutput,
        remainingInputTokens: Math.max(0, BUDGET_LIMITS.MAX_TOTAL_BILLED_INPUT_TOKENS_PER_AUDIT - billedInput - reservedInput),
        remainingOutputTokens: Math.max(0, BUDGET_LIMITS.MAX_TOTAL_BILLED_OUTPUT_TOKENS_PER_AUDIT - billedOutput - reservedOutput),
        tasksStarted: tasks.size,
        remainingTasks: Math.max(0, BUDGET_LIMITS.MAX_SEMANTIC_TASKS_PER_AUDIT - tasks.size),
        invocations: reservations.size,
        responses,
        ambiguousReservations: ambiguous,
        deadlineAt: created.semanticDeadlineAt,
      },
      grant: { admissions, refusals, heldMicros, chargedMicros, unknownUsageCharges, liabilityMicros },
      reservations: [...reservations.values()],
      taskOutcomes: outcomes,
      events: events.length,
    };
  }

  /** When the run was created, by the host's clock at the time; a validation dated before this cannot be about it. */
  createdAt(): string {
    return (this.events()[0] as Created).at;
  }

  transition(to: RunState, reason: string): void {
    const events = this.events();
    const { state } = this.fence(events, 'STATE');
    if (!RUN_TRANSITIONS[state].includes(to)) throw new IntelligenceError('INVALID_TRANSITION', `${state} → ${to} is not a transition of the run state machine`, { from: state, to });
    this.appendAt(events.length, { kind: 'STATE', at: this.clock.now(), from: state, to, reason });
  }

  /** The host's cancellation: not a write of an owner, so never fenced — any handle may cancel, whoever holds the lease. */
  cancel(reason: string): void {
    const events = this.events();
    const view = this.viewOf(events);
    if (view.cancelled) return;
    this.appendAt(events.length, { kind: 'CANCELLED', at: this.clock.now(), reason });
    if (!TERMINAL_RUN_STATES.has(view.state)) this.appendAt(events.length + 1, { kind: 'STATE', at: this.clock.now(), from: view.state, to: 'CANCELLED', reason });
  }

  /** Whether the semantic window has closed: no reservation, no dispatch after it (D3-TIME-1). */
  deadlinePassed(): boolean {
    return this.clock.nowMs() >= Date.parse(this.view().semanticDeadlineAt);
  }

  /** Whether the absolute window has closed: no promotion after it, whatever the host validated (D3-TIME-1). */
  absoluteDeadlinePassed(): boolean {
    return this.clock.nowMs() >= Date.parse(this.view().absoluteDeadlineAt);
  }

  /** Refuses new work once cancelled or past the semantic deadline; the caller decides the terminal state. */
  assertOpen(): void {
    const view = this.view();
    if (view.cancelled) throw new IntelligenceError('RUN_CANCELLED', `run ${this.runId} is cancelled`);
    if (this.deadlinePassed()) throw new IntelligenceError('DEADLINE_PASSED', `run ${this.runId} passed its semantic deadline ${view.semanticDeadlineAt}`);
    if (TERMINAL_RUN_STATES.has(view.state)) throw new IntelligenceError('INVALID_TRANSITION', `run ${this.runId} is terminal (${view.state})`);
  }

  /**
   * The key one request is identified by: task, attempt, policy, prompt
   * bundle (version and hash) and what the envelope asks — its semantic
   * content, not its budget snapshot. The snapshot is what was left to spend
   * when the envelope was built; a run resumed after N answers rebuilds the
   * same request with N answers' worth less remaining, and a key that read
   * the snapshot would miss every response the ledger already holds and buy
   * them all again. The envelope hash the response answered travels with the
   * stored response instead (canon §78).
   */
  static idempotencyKey(parts: { taskId: string; attempt: number; modelPolicyVersion: string; promptBundleVersion: string; promptBundleHash: string; envelope: IntelligenceEnvelopeV1 }): string {
    return digestOf({ taskId: parts.taskId, attempt: parts.attempt, modelPolicyVersion: parts.modelPolicyVersion, promptBundleVersion: parts.promptBundleVersion, promptBundleHash: parts.promptBundleHash, envelope: RunLedger.semanticEnvelope(parts.envelope) });
  }

  /** The envelope without the fields that change between two builds of the same request. */
  static semanticEnvelope(envelope: IntelligenceEnvelopeV1): Omit<IntelligenceEnvelopeV1, 'budgetSnapshot'> {
    const { budgetSnapshot, ...semantic } = envelope;
    void budgetSnapshot;
    return semantic;
  }

  /** The key one billable unit is identified by: the request and which of its sends this is. */
  static invocationKey(requestKey: string, invocation: number): string {
    return digestOf({ requestKey, invocation });
  }

  /** A response already stored under this key, with the hash of the envelope it answered and the reservation it answers; a redelivery returns it instead of spending. */
  storedResponse(idempotencyKey: string): StoredResponse | undefined {
    const event = this.events().find((entry): entry is Extract<LedgerEvent, { kind: 'RESPONSE_STORED' }> => entry.kind === 'RESPONSE_STORED' && entry.idempotencyKey === idempotencyKey);
    return event === undefined ? undefined : { response: event.response, envelopeHash: event.envelopeHash, reservationId: event.reservationId };
  }

  /** The request prepared under this key, if one was: what every send of it sends. */
  preparedRequest(requestKey: string): PreparedRequest | undefined {
    const event = this.events().find((entry): entry is Extract<LedgerEvent, { kind: 'PREPARED' }> => entry.kind === 'PREPARED' && entry.requestKey === requestKey);
    return event === undefined ? undefined : { envelope: event.envelope, envelopeHash: event.envelopeHash, requestDigest: event.requestDigest, requestBytes: event.requestBytes, maxChargeMicros: event.maxChargeMicros, deadlineAt: event.deadlineAt };
  }

  /**
   * Records a request as it will be sent, once per request key and before
   * any reservation for it; a request already prepared — by this process or
   * one that died — is returned as it was, and that is what is sent.
   */
  prepare(requestKey: string, prepared: PreparedRequest): PreparedRequest {
    this.appendDeciding(() => ({ kind: 'PREPARED', at: this.clock.now(), requestKey, ...prepared }), (unused, log) => !log.some((entry) => entry.kind === 'PREPARED' && entry.requestKey === requestKey));
    const recorded = this.preparedRequest(requestKey);
    if (recorded === undefined) throw new IntelligenceError('LEDGER_CONFLICT', `the request ${requestKey} could not be prepared on run ${this.runId}`);
    return recorded;
  }

  /** What the journal holds of one invocation beyond its reservation: its admission and whether its send started. */
  dispatchOf(reservationId: string): DispatchFacts {
    const events = this.events();
    const admission = events.find((entry): entry is Extract<LedgerEvent, { kind: 'ADMISSION' }> => entry.kind === 'ADMISSION' && entry.reservationId === reservationId);
    const settled = events.find((entry): entry is Extract<LedgerEvent, { kind: 'COMMITTED' }> => entry.kind === 'COMMITTED' && entry.reservationId === reservationId) ?? events.find((entry): entry is Extract<LedgerEvent, { kind: 'RECONCILIATION_EVIDENCE' }> => entry.kind === 'RECONCILIATION_EVIDENCE' && entry.reservationId === reservationId);
    return { admission: admission === undefined ? null : { maxChargeMicros: admission.maxChargeMicros, outcome: admission.outcome }, sendStarted: events.some((entry) => entry.kind === 'SEND_STARTED' && entry.reservationId === reservationId), charge: settled === undefined ? null : { chargeMicros: settled.chargeMicros, usageKnown: settled.usageKnown } };
  }

  /**
   * The host's answer to the money admission of one open reservation, on the
   * record before anything else is decided about it: the maximum charge the
   * grant was asked to hold and whether it did.
   */
  recordAdmission(reservationId: string, maxChargeMicros: number, outcome: AdmissionOutcome): void {
    this.appendDeciding(() => ({ kind: 'ADMISSION', at: this.clock.now(), reservationId, maxChargeMicros, outcome }), (view, log) => {
      const reservation = view.reservations.find((entry) => entry.reservationId === reservationId);
      if (reservation === undefined || reservation.state !== 'RESERVED') throw new IntelligenceError('BUDGET_RESERVATION_CONFLICT', `reservation ${reservationId} is not open`);
      return !log.some((entry) => entry.kind === 'ADMISSION' && entry.reservationId === reservationId);
    });
  }

  /**
   * The last write before a request may leave the process. Only an admitted,
   * open reservation of an open run is marked; a run cancelled or past its
   * deadline since the reservation refuses here, and the caller releases the
   * reservation — nothing was sent. A reservation without this fact on the
   * record was never dispatched, which is what lets a reopening release it.
   */
  sendStarted(reservationId: string): void {
    this.appendDeciding(() => ({ kind: 'SEND_STARTED', at: this.clock.now(), reservationId }), (view, log) => {
      this.assertOpen();
      const reservation = view.reservations.find((entry) => entry.reservationId === reservationId);
      if (reservation === undefined || reservation.state !== 'RESERVED') throw new IntelligenceError('BUDGET_RESERVATION_CONFLICT', `reservation ${reservationId} is not open`);
      if (!log.some((entry) => entry.kind === 'ADMISSION' && entry.reservationId === reservationId && entry.outcome === 'ADMITTED')) throw new IntelligenceError('BUDGET_EXHAUSTED', `reservation ${reservationId} was not admitted on a funded grant`, { cause: 'NO_FUNDED_GRANT' });
      return !log.some((entry) => entry.kind === 'SEND_STARTED' && entry.reservationId === reservationId);
    });
  }

  /**
   * Waits for the store to make the log durable up to here (D3-JRN-2). The
   * fence is checked before and again after the wait: an owner the lease
   * moved away from while the store flushed passes no barrier, and a store
   * that refuses is the fence as well. Nothing is appended.
   */
  async barrier(point: BarrierPoint): Promise<void> {
    const events = this.events();
    this.fence(events, `${point} barrier`);
    const outcome = await this.store.barrier(this.runId, events.length, point);
    if (!outcome.ok) throw new IntelligenceError('LEDGER_FENCED', `the store refused the ${point} barrier of run ${this.runId} (${outcome.reason}); ${this.ownerId} dispatches and publishes nothing on it`, { runId: this.runId, kind: `${point} barrier`, ownerId: this.ownerId });
    this.fence(this.events(), `${point} barrier`);
  }

  /** How many times this request has already been sent or reserved for sending, released ones included. */
  invocationsOf(requestKey: string): number {
    return this.view().reservations.filter((reservation) => reservation.requestKey === requestKey).length;
  }

  /**
   * Reserve budget for one invocation of one request, atomically against the
   * ledger: the per-request ceilings, the per-audit totals net of what is
   * billed and reserved, the task count, the attempt count, the invocation
   * count, the deadline and the cancellation are all checked against the
   * events that were read, and the event lands only if nothing was appended
   * since. Two workers reserving the same invocation get one reservation; a
   * retry is a new invocation with its own reservation, never a reuse.
   */
  /**
   * Ownership of the attempt, before any reservation. One owner holds the
   * run at a time — this handle, by its token, which the LEASE event
   * records beside the process name. The lease is taken, or renewed by its
   * holder, by compare-and-append against the length that was read, so two
   * handles deciding on the same view cannot both take it. A handle that
   * finds another owner's lease still in force by the run's clock — another
   * process's, or another invocation's in this very process, a renewal
   * inside the window included — or that loses the append, is not the
   * owner: it reserves nothing, sends nothing and writes nothing
   * (WORKER_NOT_OWNER). It takes over only once the lease has lapsed — a
   * dead owner's, since a live one renews — and what that owner left in
   * flight stays ambiguous.
   */
  acquireLease(workerId: string, leaseMs: number): void {
    if (typeof workerId !== 'string' || workerId.trim() === '') throw new IntelligenceError('CONTRACT_VIOLATION', 'a lease needs a worker id');
    const events = this.events();
    const { lease } = this.viewOf(events);
    const nowMs = this.clock.nowMs();
    if (lease !== null && lease.ownerId !== this.ownerId && Date.parse(lease.leaseUntil) > nowMs) throw new IntelligenceError('WORKER_NOT_OWNER', `run ${this.runId} is held by worker ${lease.workerId} (${lease.ownerId}) until ${lease.leaseUntil}`, { holder: lease.workerId, holderOwnerId: lease.ownerId, leaseUntil: lease.leaseUntil });
    const appended = this.store.append(this.runId, { kind: 'LEASE', at: this.clock.now(), workerId, ownerId: this.ownerId, leaseUntil: new Date(nowMs + leaseMs).toISOString() }, events.length);
    // Another worker wrote first — its lease, or anything else on the view this decision was made on; either way this handle did not take the run.
    if (!appended.ok) throw new IntelligenceError('WORKER_NOT_OWNER', `another worker appended to run ${this.runId} while the lease was being taken`, { expectedLength: events.length, actualLength: appended.actualLength });
  }

  /** Whether this handle holds the lease in force: the latest LEASE carries its token and has not lapsed by the run's clock. */
  holdsLease(): boolean {
    const { lease } = this.view();
    return lease !== null && lease.ownerId === this.ownerId && Date.parse(lease.leaseUntil) > this.clock.nowMs();
  }

  /** To reserve, the lease as it stands must be this handle's and still in force; a run nobody has taken is not checked here (the core takes it before any reservation). */
  private assertOwner(view: RunView): void {
    if (view.lease === null) return;
    if (view.lease.ownerId !== this.ownerId || Date.parse(view.lease.leaseUntil) <= this.clock.nowMs()) throw new IntelligenceError('WORKER_NOT_OWNER', `run ${this.runId} is held by worker ${view.lease.workerId} (${view.lease.ownerId}) until ${view.lease.leaseUntil}; ${this.ownerId} may not reserve`, { holder: view.lease.workerId, holderOwnerId: view.lease.ownerId, leaseUntil: view.lease.leaseUntil, ownerId: this.ownerId });
  }

  reserve(input: { taskId: string; attempt: number; invocation: number; inputTokens: number; outputTokens: number; idempotencyKey: string }): Reservation {
    this.assertOpen();
    const events = this.events();
    const view = this.viewOf(events);
    this.assertOwner(view);
    const unitKey = RunLedger.invocationKey(input.idempotencyKey, input.invocation);
    const existing = events.find((entry): entry is Extract<LedgerEvent, { kind: 'RESERVED' }> => entry.kind === 'RESERVED' && entry.idempotencyKey === unitKey);
    if (existing !== undefined) {
      const current = view.reservations.find((reservation) => reservation.reservationId === existing.reservation.reservationId);
      if (current !== undefined && current.state !== 'RELEASED') throw new IntelligenceError('BUDGET_RESERVATION_CONFLICT', `a reservation already stands for this request (${current.state})`, { reservationId: current.reservationId });
    }
    const sameRequest = view.reservations.filter((reservation) => reservation.requestKey === input.idempotencyKey);
    const inFlight = sameRequest.find((reservation) => reservation.state === 'RESERVED');
    if (inFlight !== undefined) throw new IntelligenceError('BUDGET_RESERVATION_CONFLICT', `invocation ${String(inFlight.invocation)} of this request is still open`, { reservationId: inFlight.reservationId });
    if (input.invocation < 1 || input.invocation > MAX_INVOCATIONS_PER_REQUEST) throw new IntelligenceError('BUDGET_EXHAUSTED', `invocation ${String(input.invocation)} exceeds the initial send plus ${String(BUDGET_LIMITS.MAX_TRANSPORT_RETRIES_PER_REQUEST)} transport retries`);
    if (input.inputTokens > BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST) throw new IntelligenceError('BUDGET_EXHAUSTED', `the request asks for ${String(input.inputTokens)} input tokens against a ceiling of ${String(BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST)}`);
    if (input.outputTokens > BUDGET_LIMITS.MAX_OUTPUT_TOKENS_PER_REQUEST) throw new IntelligenceError('BUDGET_EXHAUSTED', `the request asks for ${String(input.outputTokens)} output tokens against a ceiling of ${String(BUDGET_LIMITS.MAX_OUTPUT_TOKENS_PER_REQUEST)}`);
    if (input.attempt < 1 || input.attempt > BUDGET_LIMITS.MAX_SEMANTIC_ATTEMPTS_PER_TASK) throw new IntelligenceError('BUDGET_EXHAUSTED', `attempt ${String(input.attempt)} exceeds ${String(BUDGET_LIMITS.MAX_SEMANTIC_ATTEMPTS_PER_TASK)} semantic attempts per task`);
    const taskIsNew = !view.reservations.some((reservation) => reservation.taskId === input.taskId);
    if (taskIsNew && view.budget.remainingTasks <= 0) throw new IntelligenceError('BUDGET_EXHAUSTED', `${String(BUDGET_LIMITS.MAX_SEMANTIC_TASKS_PER_AUDIT)} semantic tasks already started`);
    if (input.inputTokens > view.budget.remainingInputTokens) throw new IntelligenceError('BUDGET_EXHAUSTED', `${String(input.inputTokens)} input tokens asked, ${String(view.budget.remainingInputTokens)} remain`);
    if (input.outputTokens > view.budget.remainingOutputTokens) throw new IntelligenceError('BUDGET_EXHAUSTED', `${String(input.outputTokens)} output tokens asked, ${String(view.budget.remainingOutputTokens)} remain`);
    const reservation: Reservation = { reservationId: stableRef('rsv', { key: unitKey, n: view.reservations.length }), taskId: input.taskId, attempt: input.attempt, requestKey: input.idempotencyKey, invocation: input.invocation, inputTokens: input.inputTokens, outputTokens: input.outputTokens, state: 'RESERVED' };
    const appended = this.store.append(this.runId, { kind: 'RESERVED', at: this.clock.now(), reservation, idempotencyKey: unitKey }, events.length);
    // The other worker's write may have been this very reservation or spent what this one was checked against; either way this decision is void.
    if (!appended.ok) throw new IntelligenceError('BUDGET_RESERVATION_CONFLICT', `another worker appended to the ledger between the budget check and the reservation`, { expectedLength: events.length, actualLength: appended.actualLength });
    return reservation;
  }

  /**
   * The provider answered, or failed after billing: the reservation becomes
   * what was actually used. Usage the provider did not report, or reported
   * malformed, is unknown — the reservation is billed at its full size, not
   * at zero — and the event says the figure is not the provider's.
   *
   * The answer goes on the record before the bill, naming the reservation it
   * answers. A process that dies between the two leaves a stored response
   * under a reservation still open: the reopening hands it back and the
   * caller commits the usage the stored answer reports before the answer is
   * compiled (D3-JRN-1), so the request is neither bought again nor billed
   * at a guess. The other order left a bill without its answer, and a
   * reopening that had to buy the answer a second time. Neither append fails
   * the owner on a host write that lands between them (a cancel, a note):
   * each is decided again on the re-read log, and a loss to a takeover is
   * still the fence. `charge` is what the grant is charged for it, when a
   * tariff priced it.
   */
  commit(reservationId: string, usage: { readonly inputTokens: number; readonly outputTokens: number; readonly billedButUnusable: boolean } | null, response: { idempotencyKey: string; envelopeHash: string; body: unknown; providerRequestId?: string | null } | null, charge: { readonly chargeMicros: number } | null = null): void {
    const events = this.events();
    const reservation = this.fence(events, 'COMMITTED').reservations.find((entry) => entry.reservationId === reservationId);
    if (reservation === undefined || (reservation.state !== 'RESERVED' && reservation.state !== 'AMBIGUOUS_BILLED')) throw new IntelligenceError('BUDGET_RESERVATION_CONFLICT', `reservation ${reservationId} is not open`);
    const counted = RunLedger.counted(reservation, usage);
    const chargeMicros = charge?.chargeMicros ?? null;
    if (response !== null) this.appendDeciding(() => ({ kind: 'RESPONSE_STORED', at: this.clock.now(), idempotencyKey: response.idempotencyKey, envelopeHash: response.envelopeHash, responseDigest: digestOf(response.body), response: response.body, reservationId, providerRequestId: response.providerRequestId ?? null }), (unused, log) => !log.some((entry) => entry.kind === 'RESPONSE_STORED' && entry.idempotencyKey === response.idempotencyKey));
    this.appendDeciding(() => ({ kind: 'COMMITTED', at: this.clock.now(), reservationId, usage: counted.usage, usageKnown: counted.known, chargeMicros }), (view) => { const current = view.reservations.find((entry) => entry.reservationId === reservationId); return current !== undefined && (current.state === 'RESERVED' || current.state === 'AMBIGUOUS_BILLED'); });
  }

  /** Usage as the ledger counts it: the provider's figure when it is one, the reservation's full size when it is not — never zero. */
  private static counted(reservation: Reservation, usage: { readonly inputTokens: number; readonly outputTokens: number; readonly billedButUnusable: boolean } | null): { readonly usage: Usage; readonly known: boolean } {
    const billedButUnusable = usage?.billedButUnusable ?? false;
    const known = usageIsValid(usage);
    return { usage: known ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, billedButUnusable } : { inputTokens: reservation.inputTokens, outputTokens: reservation.outputTokens, billedButUnusable }, known };
  }

  /**
   * The one append of an owner the lease has moved away from (D3-FENCE-1):
   * the usage, charge and digest of its late answer, for a reservation it
   * made itself and that is still open or ambiguous. It settles that
   * reservation and nothing else — no response is stored, no state moves, no
   * barrier is passed, nothing is published. Returns whether it landed; an
   * owner still holding the attempt commits instead.
   */
  reconcileAsFencedOwner(reservationId: string, evidence: { readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly billedButUnusable: boolean } | null; readonly chargeMicros: number | null; readonly answer: unknown; readonly providerRequestId: string | null }): boolean {
    for (let tries = 0; tries < RunLedger.MAX_DECIDING_APPENDS; tries += 1) {
      const events = this.events();
      const view = this.viewOf(events);
      if (view.lease === null || view.lease.ownerId === this.ownerId) throw new IntelligenceError('CONTRACT_VIOLATION', `${this.ownerId} holds run ${this.runId}; an owner commits, only a fenced-out one reconciles`);
      const reservation = view.reservations.find((entry) => entry.reservationId === reservationId);
      if (reservation === undefined || (reservation.state !== 'RESERVED' && reservation.state !== 'AMBIGUOUS_BILLED')) return false;
      if (!this.reservedUnderOwnLease(events, reservationId)) throw new IntelligenceError('LEDGER_FENCED', `reservation ${reservationId} of run ${this.runId} is not ${this.ownerId}'s to reconcile`, { runId: this.runId, kind: 'RECONCILIATION_EVIDENCE', ownerId: this.ownerId });
      if (events.some((entry) => entry.kind === 'RECONCILIATION_EVIDENCE' && entry.reservationId === reservationId)) return false;
      const counted = RunLedger.counted(reservation, evidence.usage);
      const appended = this.store.append(this.runId, { kind: 'RECONCILIATION_EVIDENCE', at: this.clock.now(), reservationId, ownerId: this.ownerId, usage: counted.usage, usageKnown: counted.known, chargeMicros: evidence.chargeMicros, responseDigest: evidence.answer === null ? null : digestOf(evidence.answer), providerRequestId: evidence.providerRequestId }, events.length);
      if (appended.ok) return true;
    }
    throw new IntelligenceError('LEDGER_CONFLICT', `another writer kept appending to run ${this.runId} while reconciliation evidence was being decided`);
  }

  /** Whether the lease in force when the reservation was appended was this handle's: its own reservation, not the taker's. */
  private reservedUnderOwnLease(events: readonly LedgerEvent[], reservationId: string): boolean {
    const at = events.findIndex((entry) => entry.kind === 'RESERVED' && entry.reservation.reservationId === reservationId);
    for (let index = at - 1; index >= 0; index -= 1) {
      const entry = events[index];
      if (entry?.kind === 'LEASE') return entry.ownerId === this.ownerId;
    }
    return false;
  }

  /** Only for a request that provably never reached the provider. */
  release(reservationId: string, reason: string): void {
    const events = this.events();
    const reservation = this.fence(events, 'RELEASED').reservations.find((entry) => entry.reservationId === reservationId);
    if (reservation === undefined || reservation.state !== 'RESERVED') throw new IntelligenceError('BUDGET_RESERVATION_CONFLICT', `reservation ${reservationId} is not open`);
    this.appendAt(events.length, { kind: 'RELEASED', at: this.clock.now(), reservationId, reason });
  }

  markAmbiguous(reservationId: string, reason: string): void {
    const events = this.events();
    const reservation = this.fence(events, 'AMBIGUOUS').reservations.find((entry) => entry.reservationId === reservationId);
    if (reservation === undefined || reservation.state !== 'RESERVED') throw new IntelligenceError('BUDGET_RESERVATION_CONFLICT', `reservation ${reservationId} is not open`);
    this.appendAt(events.length, { kind: 'AMBIGUOUS', at: this.clock.now(), reservationId, reason });
  }

  /**
   * What was billed, committed and ambiguous together, against the audit
   * totals — after the fact, since a provider reports what it reports: a
   * reservation holds a figure below the ceiling, the usage that comes back
   * can be anything. Null while the totals hold; the reason once they do
   * not. The caller ends the run on it; nothing is trimmed or forgiven.
   */
  overCeiling(): string | null {
    const { budget } = this.view();
    const input = budget.billedInputTokens + budget.ambiguousInputTokens;
    const output = budget.billedOutputTokens + budget.ambiguousOutputTokens;
    if (input > BUDGET_LIMITS.MAX_TOTAL_BILLED_INPUT_TOKENS_PER_AUDIT) return `${String(input)} input tokens billed against a ceiling of ${String(BUDGET_LIMITS.MAX_TOTAL_BILLED_INPUT_TOKENS_PER_AUDIT)}`;
    if (output > BUDGET_LIMITS.MAX_TOTAL_BILLED_OUTPUT_TOKENS_PER_AUDIT) return `${String(output)} output tokens billed against a ceiling of ${String(BUDGET_LIMITS.MAX_TOTAL_BILLED_OUTPUT_TOKENS_PER_AUDIT)}`;
    return null;
  }

  /**
   * After a restart, a reservation still open is judged by what the journal
   * holds of it (D3-JRN-1). No SEND_STARTED: the request provably never left,
   * and the reservation is released. SEND_STARTED and no answer: the provider
   * may have received and billed it — lease expiry proves nothing about that
   * — so it is kept ambiguous, counted at full size, never released. An
   * answer on the record under it: handed back open, for the caller to
   * commit the usage the answer reports before anything compiles it. The run
   * goes on from there.
   */
  reopenInFlight(reason: string): ReopenOutcome {
    const events = this.events();
    const open = this.viewOf(events).reservations.filter((reservation) => reservation.state === 'RESERVED');
    const released: Reservation[] = [];
    const ambiguous: Reservation[] = [];
    const answered: { reservation: Reservation; stored: StoredResponse }[] = [];
    for (const reservation of open) {
      const stored = events.find((entry): entry is Extract<LedgerEvent, { kind: 'RESPONSE_STORED' }> => entry.kind === 'RESPONSE_STORED' && entry.reservationId === reservation.reservationId);
      const sent = events.some((entry) => entry.kind === 'SEND_STARTED' && entry.reservationId === reservation.reservationId);
      if (stored !== undefined) {
        answered.push({ reservation, stored: { response: stored.response, envelopeHash: stored.envelopeHash, reservationId: reservation.reservationId } });
      } else if (sent) {
        this.markAmbiguous(reservation.reservationId, `${reason}; the send had started, so the request may have reached the provider`);
        ambiguous.push(reservation);
      } else {
        this.release(reservation.reservationId, `${reason}; no SEND_STARTED on the record: never dispatched`);
        released.push(reservation);
      }
    }
    return { released, ambiguous, answered };
  }

  /** Idempotent: a resumed run that reaches the same outcome from stored responses does not record it twice. */
  recordTaskOutcome(event: Omit<Extract<LedgerEvent, { kind: 'TASK_OUTCOME' }>, 'kind' | 'at'>): void {
    const events = this.events();
    this.fence(events, 'TASK_OUTCOME');
    const same = events.some((entry) => entry.kind === 'TASK_OUTCOME' && entry.taskId === event.taskId && entry.attempt === event.attempt && entry.outcome === event.outcome && entry.envelopeHash === event.envelopeHash && entry.proposalDigest === event.proposalDigest && digestOf(entry.codes) === digestOf(event.codes));
    if (same) return;
    this.appendAt(events.length, { kind: 'TASK_OUTCOME', at: this.clock.now(), ...event });
  }

  note(note: string, counters: Readonly<Record<string, number>> = {}): void {
    const events = this.events();
    this.fence(events, 'NOTE');
    this.appendAt(events.length, { kind: 'NOTE', at: this.clock.now(), note, counters });
  }

  /**
   * The result, once. Two workers finishing the same run keep the first
   * result the ledger accepted; the second learns it and returns that one,
   * so a redelivery never sees two answers to one attempt. A result from an
   * owner the lease moved away from is not a second answer either: fenced.
   */
  storeResult(result: unknown): unknown {
    const events = this.events();
    this.fence(events, 'RESULT');
    const existing = events.find((entry): entry is Extract<LedgerEvent, { kind: 'RESULT' }> => entry.kind === 'RESULT');
    if (existing !== undefined) return existing.result;
    const appended = this.store.append(this.runId, { kind: 'RESULT', at: this.clock.now(), result }, events.length);
    if (appended.ok) return result;
    const raced = this.storedResult();
    if (raced !== undefined) return raced;
    throw new IntelligenceError('LEDGER_CONFLICT', `another writer appended to run ${this.runId} while the result was being stored`, { expectedLength: events.length, actualLength: appended.actualLength });
  }

  storedResult(): unknown | undefined {
    const event = this.events().find((entry): entry is Extract<LedgerEvent, { kind: 'RESULT' }> => entry.kind === 'RESULT');
    return event?.result;
  }

  /** The whole log as the store holds it: the host's protected record, stored responses included. Never handed out as a result. */
  export(): readonly LedgerEvent[] {
    return this.events();
  }

  /** The public projection of the log (D3-PRIV-1): what the result and readRun carry. */
  publicExport(): readonly PublicLedgerEvent[] {
    return publicLedger(this.events());
  }
}

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
  nowMs(): number {
    return Date.now();
  }
}

/** A clock a test moves by hand: exhaustion in twenty virtual minutes, not twenty real ones. */
export class VirtualClock implements Clock {
  private current: number;
  constructor(startIso = '2026-09-11T00:00:00.000Z') {
    this.current = Date.parse(startIso);
  }
  now(): string {
    return new Date(this.current).toISOString();
  }
  nowMs(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}
