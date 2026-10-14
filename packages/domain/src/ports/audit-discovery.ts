/**
 * The control plane's discovery of audit work (package B08, mandate B08-CONTROL-AUDIT; docs/design/B08-audit-approval-jobs.md §3, §6,
 * §8.1, §11; decisions D8-AUD-2, D8-AUD-4, D8-GRANT-2, D8-PLAN-2, D8-DL-1, D8-CANCEL-2, D8-CAU-1): what AUDIT_ORCHESTRATION,
 * PLAN_VALIDATION, EXECUTION_CONTROL and the sweepers AUDIT_DEADLINES and GRANT_RECONCILIATION read to find their work and a step's
 * inputs. Reads only, over the policies and grants migrations 0021 to 0023 (and B06's and B07's) already give the control plane: ids
 * and states across agencies from an unbound SYSTEM unit (the audits and grants of every agency), a step's inputs from a unit bound to
 * the audit's agency. GRANT_RECONCILIATION's two reads of one grant take the grant's and its requests' row locks (FOR UPDATE), so a
 * send, a reservation or another reconciliation of that grant is ordered before or after its settlement. Every deadline is compared
 * with kauro.server_now() in SQL (D8-CLOCK-1): no method takes an instant from its caller. The pg implementation is
 * @kauro/persistence's; the writes stay the AuditStore's.
 */
import type { AgencyId, PlanId, ProjectId, RequestId, RevisionId } from "../model/ids.js";
import type { SourcePopulations } from "../model/source/records.js";
import type { TargetBody } from "../model/target-contract.js";
import type { AuditId, CostGrantId } from "../model/audit/ids.js";
import type { AuditRecord, AuditState, CostGrantRecord, PlanValidationRecord } from "../model/audit/records.js";
import type { ExecutionSourceGeneration } from "./execution-discovery.js";
import type { RequestJournalRecord } from "./request-journal.js";

/** An audit the control plane found work for, with the agency its SYSTEM unit of work binds (B07 D-CTRL-1). */
export interface AuditRef {
  readonly auditId: AuditId;
  readonly agencyId: AgencyId;
}

/** A grant due for reconciliation: an agency's AUDIT grant (a unit bound to it), or the platform's pool (no agency: an unbound unit). */
export interface GrantRef {
  readonly grantId: CostGrantId;
  readonly agencyId: AgencyId | null;
}

/** What PROFILE reads (§3 step 1): the revision's state and the sealed manifest's exact ACCEPTED generations. */
export interface AuditSource {
  readonly revisionState: string;
  readonly acceptedGenerations: ReadonlyArray<ExecutionSourceGeneration>;
}

/**
 * What a validation reads (B05 L1v): the sealed revision a plan binds (by its agency and manifest hash), the sealed manifest's exact
 * ACCEPTED generations and the populations frozen before capture, so the core counts the revision's own source and is told its
 * billable units; null when the agency has no such revision.
 */
export interface ValidationSource {
  readonly projectId: ProjectId;
  readonly revisionId: RevisionId;
  readonly revisionState: string;
  readonly acceptedGenerations: ReadonlyArray<ExecutionSourceGeneration>;
  /** null while a population is not frozen. */
  readonly populations: SourcePopulations | null;
}

/** An open validation intent of an audit's system draft (D8-AUD-4), with the draft's body and state. */
export interface DraftValidation {
  readonly validation: PlanValidationRecord;
  readonly planState: string;
  readonly planVersion: number;
  /** The draft's closed body, as stored. */
  readonly body: unknown;
}

/** What PLAN_VALIDATION validates (D8-PLAN-2): the plan's exact subjects and its current (latest) validation intent. */
export interface ValidationSubject {
  readonly planId: PlanId;
  readonly agencyId: AgencyId;
  readonly planState: string;
  readonly planVersion: number;
  readonly body: unknown;
  readonly bodyHash: string;
  readonly revisionHash: string;
  readonly targetContractHash: string;
  /** The plan's latest intent (the only one that moves it), or null for a plan without any (B06's own paths, D8-PAU-6). */
  readonly current: PlanValidationRecord | null;
}

/** A grant under its row lock with the scope it funds: an AUDIT grant's audit state; a pool's grants not yet CLOSED. */
export interface GrantScope {
  readonly grant: CostGrantRecord;
  /** The state of the one audit an AUDIT grant funds (audits_one_per_grant); null for a pool. */
  readonly auditState: AuditState | null;
  /** The AUDIT grants carved from a pool that are not CLOSED (its hold); 0 for an AUDIT grant. */
  readonly liveCarves: number;
}

/**
 * One dispatch intent reserved on the grant whose usage is not reconciled yet, under its row lock. `provablyUnsent` is the
 * database's own verdict that it can never be sent (D8-GRANT-2): a RESERVED intent of a model task whose audit no longer interprets,
 * whose interpretation deadline passed on the server clock, or whose MODEL_TASK lease moved to another fence — exactly the refusals of
 * the check before SEND_STARTED (migration 0023, request_journal_model_task_send). Any other intent may have reached its provider.
 * B05 S09: a core reservation its core RELEASED unsent is listed too (still RESERVED, its usage already reconciled at 0; a settled
 * row is refused the DISPATCHING edge) and is provablyUnsent.
 */
export interface GrantUsage {
  readonly requestId: RequestId;
  readonly fence: number;
  readonly state: RequestJournalRecord["state"];
  readonly usageState: RequestJournalRecord["usageState"];
  /** BIGINT cents, read as bigint like the grant's own. */
  readonly reservedCents: bigint;
  readonly actualCents: bigint | null;
  readonly provablyUnsent: boolean;
  /** B05 D5-18 branch (a): DISPATCHING and no longer sendable by its owner (the UNSENDABLE predicate). */
  readonly staleDispatch: boolean;
  /** B05 D5-18 branch (b): FAILED with non-acceptance evidence and usage UNKNOWN. */
  readonly nonAccepted: boolean;
}

export interface AuditDiscovery {
  /** AUDIT_DEADLINES: live audits whose absolute deadline is at or before the server clock (never early, D8-DL-1). */
  auditsPastDeadline(limit: number): Promise<ReadonlyArray<AuditRef>>;
  /** EXECUTION_CONTROL (D8-CANCEL-2): the agency's live, uncancelled audits of a revision whose source is lost. */
  liveAuditsOfRevision(agencyId: AgencyId, revisionId: RevisionId): Promise<ReadonlyArray<AuditRef>>;
  /** PROFILE's inputs, in a unit bound to the audit's agency: its revision's state and sealed ACCEPTED generations. */
  auditSource(audit: AuditRecord): Promise<AuditSource>;
  /** A validation's source (ValidationSource), in a unit bound to the agency. */
  validationSource(agencyId: AgencyId, revisionHash: string): Promise<ValidationSource | null>;
  /** The unsettled validation intents of the audit's system drafts, in a unit bound to its agency. */
  openDraftValidations(auditId: AuditId): Promise<ReadonlyArray<DraftValidation>>;
  /** PLAN_VALIDATION's subject, in a unit bound to the plan's agency; null for a plan the control plane cannot see. */
  validationSubject(planId: PlanId): Promise<ValidationSubject | null>;
  /**
   * The body of the target contract the plan binds (its project's contract with the plan's targetContractHash), in a unit bound to the
   * plan's agency; null when the control plane cannot see one. Read without a lock: the currency of the target is the database's (0084).
   */
  validationTarget(planId: PlanId): Promise<TargetBody | null>;
  /**
   * GRANT_RECONCILIATION's work, across agencies: a grant with a known usage to reconcile, an intent the database can no longer
   * send, an edge due on the server clock (expiry, exhaustion, room again) or a scope closed with nothing uncertain left.
   */
  grantsToReconcile(limit: number): Promise<ReadonlyArray<GrantRef>>;
  /** The grant under its row lock (FOR UPDATE) with its scope; null for a grant this unit cannot see. */
  lockGrant(grantId: CostGrantId): Promise<GrantScope | null>;
  /** The grant's dispatch intents not reconciled yet, under their row locks (FOR UPDATE), oldest first. */
  grantUsage(grantId: CostGrantId): Promise<ReadonlyArray<GrantUsage>>;
}
