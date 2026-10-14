/**
 * AUDIT_ORCHESTRATION (package B08, mandate B08-CONTROL-AUDIT; docs/design/B08-audit-approval-jobs.md §3, §6, §7, §8.1, §11; decisions
 * D8-AUD-1..4, D8-GRANT-2, D8-CANCEL-1, D8-DUP-1, D8-CAU-4, D8-CAU-5, D8-CAU-7, D8-CAU-8, D8-CAU-9; supporting B03's IC-02 and R2-035).
 *
 * The consumer of an audit's live phases. An audit event is acted on only at the audit's own version — a redelivery of an older one
 * finds the audit moved on and is DONE — and then the step of the audit's state runs, each claiming `audits.fence + 1` in a unit of
 * its own, calling its core outside any transaction and recording its result only under that fence, in the phase it claimed, uncancelled
 * and before the absolute deadline (the next unit re-reads the audit under its row lock; the database refuses the rest, KA080/KA081):
 *
 *   PROFILE    (QUEUED or PROFILING; the first claim takes QUEUED -> PROFILING) `ProfilePort.profile` over the sealed manifest's exact
 *              ACCEPTED generations through B08-WORKER-HOST's GenerationSourceReader (a read-only capability of the audit and the step),
 *              then `InterpretPort.planCandidates` (no dispatch, no spend); PROFILING -> INTERPRETING with the profile evidence and the
 *              complete candidate manifest's hash (the interpretation deadline stamped once by the database).
 *   INTERPRET  (INTERPRETING) the candidate manifest re-derived and checked against the recorded hash (D8-CAU-5), then
 *              `InterpretPort.interpret` with the AUDIT grant's room, the interpretation deadline and the platform's fenced
 *              ModelTaskJournalPort of the audit's run (a stored response is compiled before any new dispatch; a sent request without
 *              a response stays UNCERTAIN and reserved, D8-AUD-3); a COMPILED answer through `PlanCompilerPort` into the system draft's
 *              body, its digest recomputed and its subjects the audit's own; then the system draft (DRAFT -> VALIDATION_REQUIRED ->
 *              VALIDATING with its validation intent, created for the audit's requester) and INTERPRETING -> VALIDATING in one unit —
 *              or NEEDS_DECISION, UNSUPPORTED or FAILED.
 *   VALIDATE   (VALIDATING) `ValidatePort` on the draft's exact body, source and target; the receipt judged and recorded by the
 *              validator's own pool (receipts.ts); then, under the fence and cancel version before the absolute deadline, the intent
 *              settled and DRAFT_READY with the draft VALIDATED (the database's deferred guard, D8-AUD-4) — or NEEDS_DECISION on an
 *              INVALID receipt's blocking issues, FAILED on a null, incomplete or foreign one.
 *
 * `audit.cancelled.v1` (CMD021, or EXECUTION_CONTROL for a lost source) settles the system draft's open intent CANCELLED: a later
 * VALID receipt stays evidence and promotes nothing. A thrown core failure is left to the dispatcher's retry, whose delivery claims
 * fence + 1 (§7 "audit step claimed, result lost"). No provider identity, prompt or customer value is logged or recorded.
 */
import { join } from "node:path";
import {
  attemptIdentityOf,
  attemptStagingPrefixOf,
  stagedManifestObjectNameOf,
  type AttemptCapability,
  type AuditUnits,
  type CancellationChannel,
  type CancellationState,
  type CandidateManifest,
  type ConsumerOutcome,
  type CoreEvidenceClass,
  type ExecutionLimits,
  type InterpretPort,
  type InterpretResult,
  type ObjectStoragePort,
  type OutboxConsumer,
  type CoreDocumentStore,
  type PlanCompilerPort,
  type ProfilePort,
  type ProfileResult,
} from "@kauro/application";
import { isSha256Hex, type Sha256Hex, type UtcInstant } from "@kauro/contracts";
import { AttemptEnvelopeFailure, AttemptScratchStore, GenerationSourceReader } from "@kauro/data-plane";
import {
  LIVE_AUDIT_STATES,
  type AgencyId,
  type AuditEdge,
  type AuditId,
  type AuditRecord,
  type AuditStepKind,
  type AuditStepOutcome,
  type AuditStepId,
  type AuditStepRecord,
  type AuditUnitOfWork,
  type CostGrantRecord,
  type DomainEventRecord,
  type DraftValidation,
  type ExecutionSourceGeneration,
  type IdGenerator,
  type PlanBody,
  type PlanId,
  type PlanValidationId,
  type SystemContext,
  type ValidationReceiptId,
  type ValidationSource,
} from "@kauro/domain";
import { modelTaskJournalOf } from "@kauro/persistence";
import { EXECUTION_SERVICES, applied, boundSystem, refused, type ExecutionStep } from "../execution/work.js";
import { planBodyHashOf, type PlanValidator } from "./receipts.js";
import { StepRefused, channelOf, guarded, inAgency, reached, serverNowIn, type AuditWorkDependencies } from "./work.js";

const SERVICE = EXECUTION_SERVICES.AUDIT_ORCHESTRATION;

/** The finding of an interpretation that needs the agency's choice, and of an unsupported capability (tokens; audits_terminal_explained). */
export const AGENCY_DECISION_REQUIRED = "AGENCY_DECISION_REQUIRED";
export const CAPABILITY_NOT_SUPPORTED = "CAPABILITY_NOT_SUPPORTED";

export interface AuditOrchestrationDependencies extends AuditWorkDependencies {
  readonly units: AuditUnits;
  readonly ids: IdGenerator;
  /** The object storage the sealed ACCEPTED generations are read from (B07's port). */
  readonly storage: ObjectStoragePort;
  readonly profile: ProfilePort;
  readonly interpret: InterpretPort;
  readonly compiler: PlanCompilerPort;
  /** The stored core documents (D5-14): the PROFILE step stores the profile the interpretation later reads by its hash; absent, the intelligence adapter fails PROFILE_EVIDENCE_MISSING. */
  readonly documents?: CoreDocumentStore;
  /** The validator's call and the receipt's recording (receipts.ts). */
  readonly validator: PlanValidator;
  readonly limits: ExecutionLimits;
  /** An absolute directory: each PROFILE step owns, and removes, a scratch directory of its own under it (D8-CAU-9). */
  readonly scratchRoot: string;
}

/** The phase a step of each kind runs in once claimed. */
const PHASE: Readonly<Record<AuditStepKind, AuditRecord["state"]>> = Object.freeze({ PROFILE: "PROFILING", INTERPRET: "INTERPRETING", VALIDATE: "VALIDATING" });

/** What the claim unit returns: the step at the audit's next fence and what its core call reads. */
interface Claim {
  readonly audit: AuditRecord;
  readonly step: AuditStepRecord;
  /** The server's instant at the claim (a receipt's start). */
  readonly claimedAt: UtcInstant;
  readonly generations: ReadonlyArray<ExecutionSourceGeneration>;
  readonly grant: CostGrantRecord | null;
  readonly draft: DraftValidation | null;
  /** VALIDATE: the sealed revision the draft binds (B05 L1v). */
  readonly validationSource: ValidationSource | null;
}

/** A step's result, recorded once under its fence, and the edges it takes in the same unit. */
interface Answer {
  readonly outcome: AuditStepOutcome;
  readonly evidenceHash: Sha256Hex | null;
  readonly evidenceClass: CoreEvidenceClass;
  readonly what: string;
  apply(uow: AuditUnitOfWork, audit: AuditRecord): Promise<void>;
}

async function advance(uow: AuditUnitOfWork, audit: AuditRecord, edge: AuditEdge): Promise<void> {
  const moved = await uow.audits.advanceAudit(audit.auditId, audit.version, edge);
  if (moved.kind !== "APPLIED") throw new StepRefused("STALE_VERSION");
}

/** A step that ends the audit FAILED with a classified cause (fatal_integrity_error, fatal_contract_or_provider_error, fatal_contract_error). */
function failed(reasonCode: string, evidenceClass: CoreEvidenceClass): Answer {
  return { outcome: "FAILED", evidenceHash: null, evidenceClass, what: `FAILED_${reasonCode}`, apply: (uow, audit) => advance(uow, audit, { to: "FAILED", reasonCode }) };
}

export class AuditOrchestration implements OutboxConsumer {
  readonly consumer = "AUDIT_ORCHESTRATION" as const;

  constructor(private readonly deps: AuditOrchestrationDependencies) {}

  async handle(event: DomainEventRecord, _context: SystemContext): Promise<ConsumerOutcome> {
    if (event.agencyId === undefined || event.agencyId === null) return { kind: "DONE" };
    const agencyId = event.agencyId as AgencyId;
    const auditId = event.aggregateId as AuditId;
    let step: ExecutionStep;
    switch (event.eventType) {
      case "audit.queued.v1":
      case "audit.profiling.v1":
      case "audit.interpreting.v1":
      case "audit.validating.v1":
        step = await this.step(auditId, agencyId, event.aggregateVersion);
        break;
      case "audit.cancelled.v1":
        step = await this.settleCancelled(auditId, agencyId);
        break;
      default:
        return { kind: "DONE" };
    }
    return step.kind === "RETRY" ? { kind: "RETRY", afterSeconds: step.afterSeconds, reason: step.reason } : { kind: "DONE" };
  }

  /** The step of the audit's state, when the event is of the audit's own version (header; D8-CAU-8). */
  async step(auditId: AuditId, agencyId: AgencyId, eventVersion: number): Promise<ExecutionStep> {
    return guarded(this.deps.retryAfterSeconds, async () => {
      const claim = await this.claim(auditId, agencyId, eventVersion);
      const answer = claim.step.kind === "PROFILE" ? await this.profile(claim) : claim.step.kind === "INTERPRET" ? await this.interpret(claim) : await this.validate(claim);
      if ("kind" in answer) return answer;
      return this.record(claim, answer);
    });
  }

  /** The claim unit: the audit under its row lock, at the event's version, live, before its deadline; the step at fence + 1. */
  private claim(auditId: AuditId, agencyId: AgencyId, eventVersion: number): Promise<Claim> {
    return inAgency(this.deps, SERVICE, agencyId, async (uow) => {
      const audit = await uow.audits.lockAudit(auditId);
      if (audit === null) throw new StepRefused("AUDIT_NOT_FOUND");
      if (audit.version !== eventVersion) throw new StepRefused("AUDIT_MOVED_ON");
      if (audit.cancelVersion !== 0 || !LIVE_AUDIT_STATES.includes(audit.state)) throw new StepRefused("AUDIT_NOT_LIVE");
      const claimedAt = await uow.executionDiscovery.serverNow();
      if (reached(claimedAt, audit.absoluteDeadlineAt)) throw new StepRefused("ABSOLUTE_DEADLINE_REACHED");
      const kind: AuditStepKind = audit.state === "QUEUED" || audit.state === "PROFILING" ? "PROFILE" : audit.state === "INTERPRETING" ? "INTERPRET" : "VALIDATE";
      let generations: ReadonlyArray<ExecutionSourceGeneration> = [];
      let grant: CostGrantRecord | null = null;
      let draft: DraftValidation | null = null;
      let validationSource: ValidationSource | null = null;
      if (kind === "PROFILE") {
        // profile_worker_claims: the source SEALED and the grant AUTHORIZED and unexpired (a lost source is EXECUTION_CONTROL's)
        const source = await uow.auditDiscovery.auditSource(audit);
        if (source.revisionState !== "SEALED") throw new StepRefused("SOURCE_NOT_SEALED");
        const funding = await uow.audits.getGrant(audit.grantId);
        if (funding === null || funding.state !== "AUTHORIZED" || reached(claimedAt, funding.expiresAt)) throw new StepRefused("GRANT_NOT_FUNDED");
        generations = source.acceptedGenerations;
      } else if (kind === "INTERPRET") {
        grant = await uow.audits.getGrant(audit.grantId);
        if (grant === null) throw new StepRefused("GRANT_NOT_VISIBLE");
      } else {
        // the system draft's open intent (D8-AUD-4): the one the INTERPRET step created with the VALIDATING edge
        const open = (await uow.auditDiscovery.openDraftValidations(auditId)).filter((d) => d.planState === "VALIDATING");
        draft = open[open.length - 1] ?? null;
        if (draft === null) throw new StepRefused("NO_OPEN_DRAFT");
        validationSource = await uow.auditDiscovery.validationSource(audit.agencyId, draft.validation.revisionHash);
      }
      const claimed = await uow.audits.claimStep(auditId, kind, this.deps.ids.next() as AuditStepId);
      return { audit: claimed.audit, step: claimed.step, claimedAt, generations, grant, draft, validationSource };
    });
  }

  /** The record unit: the answer recorded only under the step's fence, in its phase, uncancelled, before the absolute deadline (§6). */
  private record(claim: Claim, answer: Answer): Promise<ExecutionStep> {
    const phase = PHASE[claim.step.kind];
    return inAgency(this.deps, SERVICE, claim.audit.agencyId, async (uow) => {
      const audit = await uow.audits.lockAudit(claim.audit.auditId);
      if (audit === null) throw new StepRefused("AUDIT_NOT_FOUND");
      if (audit.fence !== claim.step.fence) throw new StepRefused("STEP_FENCED");
      if (audit.cancelVersion !== 0 || audit.state !== phase) throw new StepRefused("AUDIT_MOVED_ON");
      if (reached(await uow.executionDiscovery.serverNow(), audit.absoluteDeadlineAt)) throw new StepRefused("ABSOLUTE_DEADLINE_REACHED");
      await uow.audits.recordStep(claim.step.stepId, { outcome: answer.outcome, evidenceHash: answer.evidenceHash, evidenceClass: answer.evidenceClass });
      await answer.apply(uow, audit);
      return applied(answer.what);
    });
  }

  /** The check after every await of a step's core call (D8-CANCEL-1): the claim still current, the audit live in its phase. */
  private channel(claim: Claim): CancellationChannel {
    const phase = PHASE[claim.step.kind];
    return channelOf(this.deps, SERVICE, claim.audit.agencyId, async (uow): Promise<CancellationState> => {
      const audit = await uow.audits.getAudit(claim.audit.auditId);
      if (audit === null) return "CANCELLED";
      if (audit.fence !== claim.step.fence) return "FENCED";
      if (audit.cancelVersion !== 0 || audit.state !== phase || reached(await uow.executionDiscovery.serverNow(), audit.absoluteDeadlineAt)) return "CANCELLED";
      return "CONTINUE";
    });
  }

  // --- PROFILE -----------------------------------------------------------------------------------------------------------------------

  private async profile(claim: Claim): Promise<Answer | ExecutionStep> {
    const { audit, step } = claim;
    // the read-only capability of the audit's step over exactly its sealed ACCEPTED generations (D8-CAU-9): nothing is written under
    // the derived prefix, since PROFILE writes no artifact
    const stagingPrefix = attemptStagingPrefixOf(audit.agencyId, audit.projectId, audit.auditId, step.stepId);
    const capability: AttemptCapability = {
      agencyId: audit.agencyId,
      projectId: audit.projectId,
      jobId: audit.auditId,
      attemptId: step.stepId,
      identity: attemptIdentityOf(step.stepId),
      stagingPrefix,
      manifestObjectName: stagedManifestObjectNameOf(stagingPrefix, step.stepId),
      acceptedGenerations: claim.generations.map((g) => ({ objectName: g.objectName, generation: g.generation, sha256: g.sha256, byteLength: g.byteLength })),
    };
    let profiled: ProfileResult;
    const scratch = new AttemptScratchStore({ root: join(this.deps.scratchRoot, "profile"), attemptId: step.stepId, quotaBytes: this.deps.limits.scratchBudgetBytes });
    try {
      const source = new GenerationSourceReader({ capability, storage: this.deps.storage });
      profiled = await this.deps.profile.profile({ source, revisionHash: audit.revisionHash, scratch, limits: this.deps.limits, cancellation: this.channel(claim) });
    } catch (e) {
      // a sealed generation that is longer, shorter, other or gone, or outside the capability: the source's integrity failed
      if (e instanceof AttemptEnvelopeFailure) return failed(e.terminalCause, "EXECUTED_LOCAL");
      throw e;
    } finally {
      scratch.dispose();
    }
    if (profiled.outcome === "CANCELLED") return refused("PROFILE_CANCELLED");
    if (profiled.outcome === "REJECTED") return failed("SOURCE_PROFILE_REJECTED", profiled.evidenceClass);
    const profileHash = profiled.profileHash;
    if (profiled.outcome !== "PROFILED" || !isSha256Hex(profileHash)) return failed("PROFILE_ANSWER_MALFORMED", profiled.evidenceClass);
    if (this.deps.documents !== undefined) await this.deps.documents.putDocument(audit.agencyId, "SOURCE_PROFILE", profileHash, profiled.profileDocument);
    const manifest = await this.deps.interpret.planCandidates({ agencyId: audit.agencyId, revisionHash: audit.revisionHash, sourceProfileHash: profileHash, targetContractHash: audit.targetContractHash });
    if (!isSha256Hex(manifest.candidateSetHash)) return failed("CANDIDATE_MANIFEST_MALFORMED", manifest.evidenceClass);
    return {
      outcome: "COMPLETED",
      evidenceHash: profileHash,
      evidenceClass: profiled.evidenceClass,
      what: "INTERPRETING",
      apply: (uow, current) => advance(uow, current, { to: "INTERPRETING", profileEvidenceHash: profileHash, candidateManifestHash: manifest.candidateSetHash }),
    };
  }

  // --- INTERPRET -----------------------------------------------------------------------------------------------------------------

  private async interpret(claim: Claim): Promise<Answer | ExecutionStep> {
    const { audit, step, grant } = claim;
    if (grant === null || audit.profileEvidenceHash === undefined || audit.candidateManifestHash === undefined || audit.interpretationDeadlineAt === undefined) {
      return failed("PROFILE_EVIDENCE_MISSING", "EXECUTED_LOCAL");
    }
    // the manifest re-derived with no dispatch and no spend, and bound to the one the PROFILE step recorded (D8-CAU-5)
    const manifest: CandidateManifest = await this.deps.interpret.planCandidates({ agencyId: audit.agencyId, revisionHash: audit.revisionHash, sourceProfileHash: audit.profileEvidenceHash, targetContractHash: audit.targetContractHash });
    if (manifest.candidateSetHash !== audit.candidateManifestHash) return failed("CANDIDATE_MANIFEST_CHANGED", manifest.evidenceClass);
    // the platform's fenced journal of the audit's run: every append by this step at its fence, each call a unit of its own
    const context = boundSystem(SERVICE, audit.agencyId, this.deps.ids.next() as never);
    const journal = modelTaskJournalOf(this.deps.units, context, { auditId: audit.auditId, stepFence: step.fence });
    const room = grant.ceilingCents - grant.reservedCents - grant.reconciledSpendCents;
    const result: InterpretResult = await this.deps.interpret.interpret({
      auditAttemptId: audit.auditId,
      agencyId: audit.agencyId,
      projectId: audit.projectId,
      revisionId: audit.revisionId,
      candidateManifest: manifest,
      journal,
      fundedCeilingCents: room > 0n ? Number(room) : 0,
      interpretationDeadlineAt: audit.interpretationDeadlineAt,
      cancellation: this.channel(claim),
    });
    switch (result.outcome) {
      case "COMPILED":
        return this.compiled(audit, result);
      case "NEEDS_DECISION":
        return { outcome: "NEEDS_DECISION", evidenceHash: null, evidenceClass: result.evidenceClass, what: "NEEDS_DECISION", apply: (uow, current) => advance(uow, current, { to: "NEEDS_DECISION", findingCodes: [AGENCY_DECISION_REQUIRED] }) };
      case "UNSUPPORTED":
        return { outcome: "UNSUPPORTED", evidenceHash: null, evidenceClass: result.evidenceClass, what: "UNSUPPORTED", apply: (uow, current) => advance(uow, current, { to: "UNSUPPORTED", findingCodes: [CAPABILITY_NOT_SUPPORTED] }) };
      case "FAILED":
        return failed("INTERPRETATION_FAILED", result.evidenceClass);
      default:
        return failed("INTERPRET_ANSWER_MALFORMED", "EXECUTED_LOCAL");
    }
  }

  /** compiled_decisions_ready: the compiler's body, its digest recomputed, its subjects the audit's own; the system draft (D8-CAU-4). */
  private async compiled(audit: AuditRecord, result: InterpretResult): Promise<Answer> {
    const compilation = await this.deps.compiler.compile(result.candidateDecisions, null);
    if (compilation.kind !== "COMPILED") return failed(compilation.reason, result.evidenceClass);
    const body: PlanBody = compilation.body;
    const bodyHash = planBodyHashOf(body);
    if (compilation.bodyHash !== bodyHash) return failed("BODY_DIGEST_MISMATCH", result.evidenceClass);
    if (body.revisionHash !== audit.revisionHash || body.targetContractHash !== audit.targetContractHash) return failed("DRAFT_SUBJECT_MISMATCH", result.evidenceClass);
    const planId = this.deps.ids.next() as PlanId;
    const validationId = this.deps.ids.next() as PlanValidationId;
    return {
      outcome: "COMPILED",
      evidenceHash: bodyHash,
      evidenceClass: result.evidenceClass,
      what: "VALIDATING",
      apply: async (uow, current) => {
        // DRAFT -> VALIDATION_REQUIRED -> VALIDATING with the draft's first intent, for the audit's requester, then the audit's edge
        await uow.audits.recordSystemDraft(current.auditId, { planId, validationId, body, bodyHash });
        await advance(uow, current, { to: "VALIDATING" });
      },
    };
  }

  // --- VALIDATE ------------------------------------------------------------------------------------------------------------------

  private async validate(claim: Claim): Promise<Answer | ExecutionStep> {
    const { audit, draft } = claim;
    if (draft === null) return refused("NO_OPEN_DRAFT");
    const intent = draft.validation;
    const judged = await this.deps.validator.run({
      subject: { agencyId: audit.agencyId, planId: intent.planId, planHash: intent.planHash, revisionHash: intent.revisionHash, targetContractHash: intent.targetContractHash },
      body: draft.body as PlanBody,
      receiptId: this.deps.ids.next() as ValidationReceiptId,
      startedAt: claim.claimedAt,
      cancellation: this.channel(claim),
      source: claim.validationSource,
      completedAt: () => serverNowIn(this.deps, SERVICE, audit.agencyId),
    });
    const settle = async (uow: AuditUnitOfWork, result: "VALID" | "INVALID" | "ERROR", receiptHash: Sha256Hex | null): Promise<void> => {
      const settled = await uow.audits.settleValidation(intent.validationId, { result, receiptHash });
      if (!settled.current) throw new StepRefused("INTENT_NOT_CURRENT");
    };
    if (judged.kind === "CONTRACT_FAILURE") {
      // fatal_contract_error: a null, incomplete or foreign receipt; the intent settles ERROR and the draft needs validation again
      return { ...failed(judged.reason, judged.evidenceClass), apply: async (uow, current) => {
        await settle(uow, "ERROR", null);
        await advance(uow, current, { to: "FAILED", reasonCode: judged.reason });
      } };
    }
    const receipt = judged.receipt;
    if (receipt.result === "VALID") {
      return {
        outcome: "VALID",
        evidenceHash: receipt.receiptHash,
        evidenceClass: judged.evidenceClass,
        what: "DRAFT_READY",
        apply: async (uow, current) => {
          // complete_valid_receipt_and_current_authority: the draft VALIDATED under the receipt, then DRAFT_READY (deferred guard)
          await settle(uow, "VALID", receipt.receiptHash);
          await advance(uow, current, { to: "DRAFT_READY", draftPlanId: intent.planId });
        },
      };
    }
    // validatable_issue_needs_agency_choice: a structurally valid receipt whose blocking issues the agency must decide
    return {
      outcome: "NEEDS_DECISION",
      evidenceHash: receipt.receiptHash,
      evidenceClass: judged.evidenceClass,
      what: "NEEDS_DECISION",
      apply: async (uow, current) => {
        await settle(uow, "INVALID", receipt.receiptHash);
        await advance(uow, current, { to: "NEEDS_DECISION", findingCodes: receipt.blockingIssueCodes });
      },
    };
  }

  // --- the cancellation's own event ------------------------------------------------------------------------------------------------

  /** A CANCELLED audit's system draft: its open intent settles CANCELLED, so no later receipt promotes it (D8-AUD-4, D8-CAU-8). */
  async settleCancelled(auditId: AuditId, agencyId: AgencyId): Promise<ExecutionStep> {
    return guarded(this.deps.retryAfterSeconds, () =>
      inAgency(this.deps, SERVICE, agencyId, async (uow) => {
        const audit = await uow.audits.lockAudit(auditId);
        if (audit === null || audit.state !== "CANCELLED") return refused("AUDIT_NOT_CANCELLED");
        const open = await uow.auditDiscovery.openDraftValidations(auditId);
        for (const draft of open) await uow.audits.settleValidation(draft.validation.validationId, { result: "CANCELLED", receiptHash: null });
        return applied(open.length === 0 ? "NOTHING_OPEN" : "DRAFT_INTENT_CANCELLED");
      }),
    );
  }
}
