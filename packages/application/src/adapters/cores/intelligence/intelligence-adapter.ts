/**
 * The Intelligence core behind the platform's InterpretPort (B05 L3; D5-4, D5-13, D5-14; kauro-intelligence-core 0.6.0 through its
 * wrapper). planCandidates plans the complete candidate manifest from the stored profile with no dispatch and no spend; interpret runs
 * the core under the platform's fenced journal (journal-ledger.ts), its money admission and its gateway, which the composition supplies
 * per run (`runtime`): the durable admission and send edge live in the request journal, never here.
 *
 * Bounds (D5-2b style): the interpretation deadline is fixed at entry from the injected clock; every await of the journal and of the
 * authority check is raced against it; a cancellation watcher polls the channel while the core runs and cancels the core; the result is
 * judged again after the run, and a draft that returns after revocation or past the deadline is FAILED.
 */
import type { Sha256Hex } from "@kauro/contracts";
import { createIntelligenceCore, MODEL_POLICY_V1, PROMPT_BUNDLE_V1, planCandidates as planExpectedCandidates } from "@kauro/intelligence-core";
import type { Clock, CoreDependencies, DispatchAdmission, EgressKey, FullDatasetValidationPort, IntelligenceInput, IntelligenceResult, ModelGateway, ModelTariff } from "@kauro/intelligence-core";
import type { CandidateManifest, CoreDocumentStore, InterpretPort, InterpretRequest, InterpretResult, PlanCandidatesRequest } from "../../../ports/index.js";
import { loadInputs, ProfileEvidenceMissing } from "./inputs.js";
import { JournalLedger, RunIdRefused, type RevocationReason } from "./journal-ledger.js";
import { centsOfMicros, outcomeOf } from "./outcome.js";

/** What the composition binds per run: the durable gateway, admission and the full-dataset validation (D5-15, D5-18). */
export interface IntelligenceRunBindings {
  readonly gateway: ModelGateway;
  readonly dispatchAdmission: DispatchAdmission;
  readonly validationPort: FullDatasetValidationPort;
}

export interface IntelligenceAdapterDeps {
  readonly documents: CoreDocumentStore;
  /** The injected clock the deadline is measured on (D5-2): never Date.now. */
  readonly clock: Clock;
  /** The egress key from the deployment secret (D5-17); tests use a labelled key. */
  readonly egressKey: EgressKey;
  readonly tariff: ModelTariff;
  /** The support envelope version the revision is pinned to. */
  readonly supportEnvelopeVersion: string;
  readonly runtime: (request: InterpretRequest) => IntelligenceRunBindings;
  readonly actor?: string;
  /** How often the channel is polled while the core runs (default 1000 ms). */
  readonly pollIntervalMs?: number;
  /** A repeating timer; setInterval when absent. */
  readonly ticker?: (intervalMs: number, onTick: () => void) => () => void;
  readonly sleep?: (ms: number) => Promise<void>;
  /** A one-shot timer for the deadline race; setTimeout when absent. */
  readonly after?: (ms: number, fire: () => void) => () => void;
}

export const INTELLIGENCE_DRAFT_KIND = "KAURO_IC_DRAFT_V1" as const;
export const CANDIDATE_MANIFEST_KIND = "KAURO_CANDIDATE_MANIFEST_V1" as const;

/** The opaque candidate decisions of a COMPILED or NEEDS_DECISION interpretation: the plan compiler reads exactly this. */
export interface IntelligenceDraftDecisions {
  readonly kind: typeof INTELLIGENCE_DRAFT_KIND;
  readonly agencyId: string;
  readonly auditAttemptId: string;
  readonly revisionHash: string;
  readonly targetContractHash: string | null;
  readonly profileHash: string;
  readonly candidateSetHash: string;
  readonly proposalDigest: string;
  readonly draft: IntelligenceResult["draft"];
}

interface ManifestDocument {
  readonly kind: typeof CANDIDATE_MANIFEST_KIND;
  readonly revisionHash: string;
  readonly sourceProfileHash: string;
  readonly targetContractHash: string | null;
  readonly expectedSetHash: string;
  readonly truncated: boolean;
  readonly produced: number;
  readonly candidates: readonly { readonly candidateRef: string; readonly origin: string; readonly candidateType: string; readonly family: string | null }[];
}

function isManifestDocument(value: unknown): value is ManifestDocument {
  const v = value as Partial<ManifestDocument> | null;
  return typeof v === "object" && v !== null && v.kind === CANDIDATE_MANIFEST_KIND && typeof v.revisionHash === "string" && typeof v.sourceProfileHash === "string" && typeof v.expectedSetHash === "string";
}

function oneShotTimer(ms: number, fire: () => void): () => void {
  const handle = setTimeout(fire, ms);
  return () => clearTimeout(handle);
}

function repeatingTimer(ms: number, on: () => void): () => void {
  const handle = setInterval(on, ms);
  return () => clearInterval(handle);
}

export class IntelligenceCoreAdapter implements InterpretPort {
  readonly evidenceClass = "EXECUTED_LOCAL" as const;
  readonly #d: IntelligenceAdapterDeps;

  constructor(deps: IntelligenceAdapterDeps) {
    this.#d = deps;
  }

  /** Plans the complete candidate manifest from the stored profile: no dispatch, no spend, no write (J5). */
  async planCandidates(request: PlanCandidatesRequest): Promise<CandidateManifest> {
    const inputs = await loadInputs(this.#d.documents, request.agencyId, request.sourceProfileHash, request.targetContractHash);
    const expected = planExpectedCandidates({
      projectRevision: { projectRevisionId: request.revisionHash, projectRevisionHash: request.revisionHash, mode: inputs.targetContract === null ? "CLEAN_ONLY" : inputs.targetContract.contract.instance.mode, supportEnvelopeVersion: this.#d.supportEnvelopeVersion },
      sourceProfile: inputs.sourceProfile,
      candidateSet: inputs.candidateSet,
      targetContract: inputs.targetContract,
    });
    const document: ManifestDocument = {
      kind: CANDIDATE_MANIFEST_KIND,
      revisionHash: request.revisionHash,
      sourceProfileHash: request.sourceProfileHash,
      targetContractHash: request.targetContractHash,
      expectedSetHash: expected.expectedSetHash,
      truncated: expected.truncated,
      produced: expected.produced,
      candidates: expected.candidates.map((c) => ({ candidateRef: c.candidateRef, origin: c.origin, candidateType: c.candidateType, family: c.family })),
    };
    return { evidenceClass: this.evidenceClass, candidateSetHash: expected.candidateSetHash as Sha256Hex, document };
  }

  async interpret(request: InterpretRequest): Promise<InterpretResult> {
    const failed = (): InterpretResult => ({ evidenceClass: this.evidenceClass, outcome: "FAILED", candidateDecisions: null, reservedCents: 0, spentCents: 0 });
    const document = request.candidateManifest.document;
    if (!isManifestDocument(document)) return failed();
    const d = this.#d;
    const deadlineMs = Date.parse(request.interpretationDeadlineAt);
    if (!Number.isFinite(deadlineMs)) return failed();
    const remaining = deadlineMs - d.clock.nowMs();
    if (remaining <= 0) return failed();
    const deadlinePassed = (): boolean => d.clock.nowMs() >= deadlineMs;
    const bounded = this.#bounded(deadlineMs);

    let inputs;
    try {
      inputs = await loadInputs(d.documents, request.agencyId, document.sourceProfileHash as Sha256Hex, document.targetContractHash as Sha256Hex | null);
    } catch (e) {
      if (e instanceof ProfileEvidenceMissing) return failed();
      throw e;
    }
    // the manifest the step was given must be the one this profile plans now (D8-CAU-5): a changed expected set fails before any reservation
    const mode = inputs.targetContract === null ? ("CLEAN_ONLY" as const) : inputs.targetContract.contract.instance.mode;
    const projectRevision = { projectRevisionId: request.revisionId, projectRevisionHash: document.revisionHash, mode, supportEnvelopeVersion: d.supportEnvelopeVersion };
    const expected = planExpectedCandidates({ projectRevision, sourceProfile: inputs.sourceProfile, candidateSet: inputs.candidateSet, targetContract: inputs.targetContract });
    if (expected.candidateSetHash !== request.candidateManifest.candidateSetHash || expected.expectedSetHash !== document.expectedSetHash) return failed();

    const tenant = { agencyId: request.agencyId as string, clientId: request.projectId as string };
    const coreRunId = JournalLedger.coreRunIdOf(request.auditAttemptId, tenant);
    // a journal that cannot be read at entry is infrastructure, not a verdict: the step is retried
    const ledger = await JournalLedger.open({ journal: request.journal, journalRunId: request.auditAttemptId, coreRunId, cancellation: request.cancellation, deadlinePassed, bounded });
    const bindings = d.runtime(request);
    const deps: CoreDependencies = {
      gateway: bindings.gateway,
      validationPort: bindings.validationPort,
      ledgerStore: ledger,
      clock: d.clock,
      egressKey: d.egressKey,
      dispatchAdmission: bindings.dispatchAdmission,
      tariff: d.tariff,
      ...(d.sleep === undefined ? {} : { sleep: d.sleep }),
    };
    const core = createIntelligenceCore(deps);
    const input: IntelligenceInput = {
      projectRevision,
      sourceProfile: inputs.sourceProfile,
      candidateSet: inputs.candidateSet,
      targetContract: inputs.targetContract,
      scopedMemorySnapshot: [],
      policyBundle: { modelPolicyVersion: MODEL_POLICY_V1.modelPolicyVersion, promptBundleVersion: PROMPT_BUNDLE_V1.promptBundleVersion },
      resourceProfile: { wallClockMs: remaining },
    };

    // the cancellation watcher: a revocation seen while the core runs cancels the core and refuses every later barrier
    const stopWatching = this.#watch(request, ledger, () => core.cancel(coreRunId, "AUTHORITY_REVOKED"), deadlinePassed);
    let result: IntelligenceResult;
    try {
      result = await core.run(input, { tenant, actor: d.actor ?? "kauro-control", auditAttemptId: request.auditAttemptId, interpretationDeadlineAt: request.interpretationDeadlineAt });
    } catch (e) {
      if (e instanceof RunIdRefused || ledger.refusal !== null || (e as { name?: string }).name === "IntelligenceError") return failed();
      throw e;
    } finally {
      stopWatching();
    }
    // judged again after the run: a draft that returns after revocation or the deadline is never COMPILED (I05)
    let standing: RevocationReason | null = ledger.refusal;
    if (standing === null) {
      const state = await bounded(request.cancellation.check().catch(() => "UNAVAILABLE" as const));
      standing = state === null ? "DEADLINE_EXCEEDED" : state === "CONTINUE" ? null : state === "UNAVAILABLE" ? "AUTHORITY_UNAVAILABLE" : state;
    }
    const outcome = outcomeOf(result, { revoked: standing, deadlinePassed: deadlinePassed() });
    const grant = result.resourceEvidence.grant;
    const reservedCents = centsOfMicros(grant.heldMicros + grant.chargedMicros);
    const spentCents = centsOfMicros(grant.chargedMicros);
    const candidateDecisions: IntelligenceDraftDecisions | null =
      outcome === "COMPILED" || outcome === "NEEDS_DECISION"
        ? {
            kind: INTELLIGENCE_DRAFT_KIND,
            agencyId: request.agencyId,
            auditAttemptId: request.auditAttemptId,
            revisionHash: document.revisionHash,
            targetContractHash: document.targetContractHash,
            profileHash: document.sourceProfileHash,
            candidateSetHash: expected.candidateSetHash,
            proposalDigest: result.proposalDigest,
            draft: result.draft,
          }
        : null;
    return { evidenceClass: this.evidenceClass, outcome, candidateDecisions, reservedCents, spentCents };
  }

  /** Races `work` against the deadline: null when the deadline passes first (late results are dropped by the caller). */
  #bounded(deadlineMs: number): <T>(work: Promise<T>) => Promise<T | null> {
    const d = this.#d;
    return <T>(work: Promise<T>): Promise<T | null> =>
      new Promise<T | null>((resolve, reject) => {
        const wait = Math.max(0, deadlineMs - d.clock.nowMs());
        const cancel = (d.after ?? oneShotTimer)(wait, () => resolve(null));
        work.then(
          (v) => {
            cancel();
            resolve(v);
          },
          (e: unknown) => {
            cancel();
            reject(e);
          },
        );
      });
  }

  #watch(request: InterpretRequest, ledger: JournalLedger, cancelCore: () => void, deadlinePassed: () => boolean): () => void {
    const d = this.#d;
    let busy = false;
    const tick = (): void => {
      if (busy || ledger.refusal !== null) return;
      busy = true;
      void (async () => {
        try {
          const reason: RevocationReason | null = deadlinePassed()
            ? "DEADLINE_EXCEEDED"
            : await request.cancellation.check().then(
                (s) => (s === "CONTINUE" ? null : s),
                () => "AUTHORITY_UNAVAILABLE" as const,
              );
          if (reason !== null) {
            ledger.revoke(reason);
            cancelCore();
          }
        } finally {
          busy = false;
        }
      })();
    };
    return (d.ticker ?? repeatingTimer)(d.pollIntervalMs ?? 1000, tick);
  }
}
