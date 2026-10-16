/**
 * Runs, budgets, memory and tasks: the remaining contracts of the canon
 * (§10, §44–§48, §61, §76–§79), each small and closed.
 */
import type { TaskType } from './envelope.js';
import type { TaskOutcome } from './errors.js';

// --------------------------------------------------------------------- runs

export const RUN_STATES = Object.freeze([
  'CREATED',
  'ENVELOPE_VALIDATED',
  'EGRESS_APPROVED',
  'RUNNING',
  'COMPILING',
  'FULL_VALIDATING',
  'PROPOSAL_READY',
  'WAITING_FOR_PROVIDER',
  'BLOCKED_BY_POLICY',
  'BUDGET_EXHAUSTED',
  'FAILED_CONTRACT',
  'FAILED_PROVIDER',
  'FAILED_COMPILER',
  'ABSTAINED_MATERIAL',
  'CANCELLED',
  /** The absolute window closed before the run could be promoted (D3-TIME-1): never a draft, whatever the host validated. */
  'DEADLINE_EXCEEDED',
] as const);
export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>(['PROPOSAL_READY', 'BLOCKED_BY_POLICY', 'BUDGET_EXHAUSTED', 'FAILED_CONTRACT', 'FAILED_PROVIDER', 'FAILED_COMPILER', 'ABSTAINED_MATERIAL', 'CANCELLED', 'DEADLINE_EXCEEDED']);

/**
 * The transitions the state machine allows; anything else is
 * INVALID_TRANSITION. DEADLINE_EXCEEDED is reachable from every state that is
 * not terminal: the absolute window can close while the host validates, and
 * a run reopened after it closed ends there before any work (D3-TIME-1).
 */
export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = Object.freeze({
  CREATED: ['ENVELOPE_VALIDATED', 'FAILED_CONTRACT', 'BLOCKED_BY_POLICY', 'CANCELLED', 'ABSTAINED_MATERIAL', 'DEADLINE_EXCEEDED'],
  ENVELOPE_VALIDATED: ['EGRESS_APPROVED', 'BLOCKED_BY_POLICY', 'BUDGET_EXHAUSTED', 'CANCELLED', 'DEADLINE_EXCEEDED'],
  EGRESS_APPROVED: ['RUNNING', 'CANCELLED', 'BUDGET_EXHAUSTED', 'DEADLINE_EXCEEDED'],
  RUNNING: ['COMPILING', 'WAITING_FOR_PROVIDER', 'FAILED_PROVIDER', 'BUDGET_EXHAUSTED', 'CANCELLED', 'ENVELOPE_VALIDATED', 'DEADLINE_EXCEEDED'],
  WAITING_FOR_PROVIDER: ['RUNNING', 'FAILED_PROVIDER', 'CANCELLED', 'DEADLINE_EXCEEDED'],
  // FAILED_PROVIDER and BUDGET_EXHAUSTED from COMPILING: the task outcomes are read after assembly, and a task the provider failed names the provider, a task the budget ended names the budget — not the compiler and not a material abstention.
  COMPILING: ['FULL_VALIDATING', 'FAILED_COMPILER', 'FAILED_PROVIDER', 'BUDGET_EXHAUSTED', 'ABSTAINED_MATERIAL', 'ENVELOPE_VALIDATED', 'CANCELLED', 'DEADLINE_EXCEEDED'],
  FULL_VALIDATING: ['PROPOSAL_READY', 'FAILED_COMPILER', 'BUDGET_EXHAUSTED', 'ABSTAINED_MATERIAL', 'CANCELLED', 'DEADLINE_EXCEEDED'],
  PROPOSAL_READY: [],
  BLOCKED_BY_POLICY: [],
  BUDGET_EXHAUSTED: [],
  FAILED_CONTRACT: [],
  FAILED_PROVIDER: [],
  FAILED_COMPILER: [],
  ABSTAINED_MATERIAL: [],
  CANCELLED: [],
  DEADLINE_EXCEEDED: [],
});

export interface TaskRecord {
  readonly taskId: string;
  readonly taskType: TaskType;
  readonly partitionKey: string;
  readonly candidateRefs: readonly string[];
  readonly order: number;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Tokens the provider billed that the response did not carry — a refusal, a truncation, an ambiguous timeout. */
  readonly billedButUnusable: boolean;
}

// ------------------------------------------------------------------ budgets

export const BUDGET_LIMITS = Object.freeze({
  MAX_SEMANTIC_TASKS_PER_AUDIT: 32,
  MAX_SEMANTIC_ATTEMPTS_PER_TASK: 2,
  MAX_TRANSPORT_RETRIES_PER_REQUEST: 2,
  MAX_INPUT_TOKENS_PER_REQUEST: 200_000,
  MAX_OUTPUT_TOKENS_PER_REQUEST: 8_192,
  MAX_TOTAL_BILLED_INPUT_TOKENS_PER_AUDIT: 2_000_000,
  MAX_TOTAL_BILLED_OUTPUT_TOKENS_PER_AUDIT: 131_072,
  MAX_INTELLIGENCE_WALL_CLOCK_MS: 20 * 60 * 1000,
});

/**
 * The audit's absolute window (D3-TIME-1): twenty-four hours from the run's
 * start, or the host's absolute deadline when that is earlier. It gates
 * promotion; the semantic window — BUDGET_LIMITS.MAX_INTELLIGENCE_WALL_CLOCK_MS
 * from the start, shortened by the resource profile and the host's
 * interpretation deadline, never extended — gates every reservation and
 * dispatch. Neither is reset by a redelivery, a repair or a restart. Not one
 * of the budget bounds.
 */
export const ABSOLUTE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How many times one request may reach the provider: the initial send plus the transport retries. */
export const MAX_INVOCATIONS_PER_REQUEST = 1 + BUDGET_LIMITS.MAX_TRANSPORT_RETRIES_PER_REQUEST;

/**
 * How long one owner holds an attempt after it takes or renews the lease.
 * The owner is one run() invocation, named by a token minted for it and
 * written into the LEASE event — never the process: two invocations in one
 * process are two owners, and the second finds the first's lease in force.
 * A live owner renews before every reservation and every
 * WORKER_LEASE_RENEWAL_MS while it waits on the provider or on the host's
 * validation, so an owner at work never loses the lease however long the
 * call takes. Every write carries the owner: one from an owner the lease has
 * moved away from is refused (LEDGER_FENCED) and appended nowhere. A worker
 * that finds the lease held by another does not take it until it has lapsed
 * — which, after a crash, means recovery waits out the dead owner's
 * remaining lease: a redelivery inside it is WORKER_NOT_OWNER and the host
 * queue retries after it (at most 120 s). Clock-based, on the injected clock;
 * not one of the budget bounds.
 */
export const WORKER_LEASE_MS = 120_000;
/** How often a live owner renews while it waits: a quarter of the lease, so the lease survives three missed renewals before it lapses. */
export const WORKER_LEASE_RENEWAL_MS = WORKER_LEASE_MS / 4;

export interface Reservation {
  readonly reservationId: string;
  readonly taskId: string;
  readonly attempt: number;
  /** The request this invocation belongs to: task, envelope, policy, prompt bundle and attempt. */
  readonly requestKey: string;
  /** 1 for the initial send, 2 and 3 for the transport retries; each is its own billable unit. */
  readonly invocation: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly state: 'RESERVED' | 'COMMITTED' | 'RELEASED' | 'AMBIGUOUS_BILLED';
}

// ------------------------------------------------------------------- memory

export const MEMORY_SCOPES = Object.freeze(['CLIENT', 'AGENCY', 'GLOBAL'] as const);
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export const MEMORY_STATES = Object.freeze(['CANDIDATE', 'ACTIVE', 'STALE', 'CONFLICTED', 'RETIRED'] as const);
export type MemoryState = (typeof MEMORY_STATES)[number];
export const OUTCOME_LADDER = Object.freeze({
  PROPOSED_ONLY: 0.1,
  AGENCY_APPROVED: 0.3,
  EXECUTED: 0.4,
  OFFLINE_VERIFIED: 0.55,
  IMPORT_REPORTED: 0.6,
  IMPORT_VERIFIED: 0.85,
  REPEATED_VERIFIED: 1,
});
export type VerificationOutcome = keyof typeof OUTCOME_LADDER;

export interface MemoryEntry {
  readonly memoryId: string;
  readonly scope: MemoryScope;
  /** Who the entry belongs to; a CLIENT entry names its client, an AGENCY entry its agency, GLOBAL neither. */
  readonly tenant: { readonly agencyId: string | null; readonly clientId: string | null };
  readonly knowledgeType: 'FIELD_MAPPING_CONVENTION' | 'SEMANTIC_TYPE_CONVENTION' | 'ENUM_MAPPING_CONVENTION';
  /** A structured rule, never a value: what header pattern went to which target or type. */
  readonly ruleOrPattern: { readonly sourceHeaderPattern: string; readonly targetRef: string | null; readonly semanticType: string | null };
  readonly sourceProjectRef: string;
  readonly sourcePlanVersion: string;
  readonly targetInstanceRef: string | null;
  readonly targetSchemaVersion: string | null;
  readonly approvedBy: string;
  readonly verificationOutcome: VerificationOutcome;
  readonly provenance: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly status: MemoryState;
  readonly version: number;
}

export interface MemoryCandidate {
  readonly candidateId: string;
  readonly derivedFromRunId: string;
  readonly derivedFromTaskId: string;
  readonly proposedRule: MemoryEntry['ruleOrPattern'];
  readonly knowledgeType: MemoryEntry['knowledgeType'];
  readonly scope: MemoryScope;
  readonly tenant: MemoryEntry['tenant'];
  readonly status: 'CANDIDATE';
}

// -------------------------------------------------------------------- tasks

export interface TaskResult {
  readonly taskId: string;
  readonly taskType: TaskType;
  readonly outcome: TaskOutcome;
  readonly attempts: number;
  readonly envelopeHash: string | null;
  readonly proposalDigest: string | null;
  readonly codes: readonly string[];
}
