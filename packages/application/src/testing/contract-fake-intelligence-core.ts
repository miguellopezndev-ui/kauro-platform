/**
 * CONTRACT FAKE — evidence class SIMULATED. The labelled contract fake of `InterpretPort` and `PlanCompilerPort` (mandate
 * B08-CORE-PORTS; design docs/design/B08-audit-approval-jobs.md §10, §13 D8-AUD-3, D8-FAKE-1). It is the only fake of
 * these ports (one owner), lives only under the test-only subpath `@kauro/application/testing` (architecture rule
 * `testOnlySubpaths`), no composition root binds it, and every record it produces names the token
 * `contract-fake-intelligence-core` and reports `evidenceClass: "SIMULATED"` (21 "Evidence classes"). The real thin
 * adapter over kauro-intelligence-core is `b05/cores`'.
 *
 * What it models (manual 06; D8-AUD-3 "a stored response is compiled before any new dispatch"):
 * - `planCandidates` answers a complete candidate manifest with no dispatch and no spend, mirroring the core's own
 *   `planTasks`/`resolveDeterministically` exported apart from `run`.
 * - `interpret` reads the caller's `ModelTaskJournalPort` first: a response already recorded for this candidate set is
 *   returned as-is — no new reservation, no new dispatch, no new cost. Only when none is on record does it reserve
 *   against the funded ceiling (never past it: with no room, it answers FAILED and reserves nothing, so a dispatch never
 *   happens without a reservation preceding it in the journal) and then commits the scripted outcome — COMPILED,
 *   NEEDS_DECISION, UNSUPPORTED or FAILED, queued in call order by `scriptInterpretOutcomes` — as the response.
 * - A COMPILED interpretation's candidate decisions carry the system draft's plan body of the candidate manifest's own source and
 *   target — one MODEL_ASSISTED mapping per planned candidate — so `compile` of them yields that body, as the real compiler compiles
 *   the core's DraftMigrationPlan (decision D8-CAU-4).
 * - `compile` (`PlanCompilerPort`) turns a candidate decision already shaped as `{ body: PlanBody }` into B06's
 *   `PatchCompilation` (`COMPILED` with the body and its KAURO_PLAN_BODY_V1 digest, the hash B06's compilation names and every
 *   consumer recomputes, D-PLAN-5; or `REJECTED MALFORMED_PATCH`), so CMD022 and CMD023 answer with one compiler-reason vocabulary
 *   (decision D8-CAU-4).
 * - A call log of every port call, and a hold point before each awaited step (`planCandidates`'s plan, `interpret`'s
 *   journal read, reservation and commit, `compile`'s own step) so a test can interleave without a sleep.
 */
import { createHash } from "node:crypto";
import { DOMAINS, structuredDigest, type Sha256Hex } from "@kauro/contracts";
import type { PlanBody } from "@kauro/domain";
import type { PatchCompilation } from "../ports/plan-services.js";
import type {
  CandidateManifest,
  CoreEvidenceClass,
  InterpretOutcome,
  InterpretPort,
  InterpretRequest,
  InterpretResult,
  PlanCandidatesRequest,
  PlanCompilerPort,
} from "../ports/core-ports.js";

export const CONTRACT_FAKE_INTELLIGENCE_CORE_TOKEN = "contract-fake-intelligence-core";
/** The reservation and response event kinds this fake writes to the journal it is handed. */
export const CONTRACT_FAKE_INTELLIGENCE_CORE_RESERVATION = "contract-fake-intelligence-core-reservation";
export const CONTRACT_FAKE_INTELLIGENCE_CORE_RESPONSE = "contract-fake-intelligence-core-response";
/** The cents one dispatch reserves and spends, unless a test scripts another (default: never past a typical AUDIT ceiling). */
export const CONTRACT_FAKE_INTELLIGENCE_CORE_DEFAULT_COST_CENTS = 25;

export type IntelligenceCoreOperation = "planCandidates" | "interpret" | "compile";
export type IntelligenceCoreStep = "plan" | "read" | "reserve" | "dispatch" | "commit" | "compile";

export interface IntelligenceCoreCall {
  readonly sequence: number;
  readonly operation: IntelligenceCoreOperation;
  readonly outcome: string;
}

export interface IntelligenceCoreHold {
  readonly reached: Promise<void>;
  release(): void;
}

interface HoldRecord {
  readonly signal: () => void;
  readonly released: Promise<void>;
}

function digestOf(value: unknown): Sha256Hex {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const SHA256 = /^[0-9a-f]{64}$/;

/** A UUIDv7-shaped identity derived from a digest (deterministic: a replayed interpretation compiles the same body). */
function idOf(seed: unknown): string {
  const hex = digestOf({ token: CONTRACT_FAKE_INTELLIGENCE_CORE_TOKEN, seed });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The system draft's body of a candidate manifest this fake planned: its source and target, one mapping per candidate. */
function draftBodyOf(manifest: CandidateManifest): PlanBody | null {
  const document = manifest.document as { readonly revisionHash?: unknown; readonly targetContractHash?: unknown; readonly candidates?: unknown } | null;
  if (document === null || typeof document !== "object") return null;
  const { revisionHash, targetContractHash } = document;
  if (typeof revisionHash !== "string" || !SHA256.test(revisionHash) || typeof targetContractHash !== "string" || !SHA256.test(targetContractHash)) return null;
  const candidates = Array.isArray(document.candidates) ? (document.candidates as ReadonlyArray<{ readonly candidateRef?: unknown; readonly sourceFieldRef?: unknown }>) : [];
  const body = {
    revisionHash,
    targetContractHash,
    policyHash: digestOf({ token: CONTRACT_FAKE_INTELLIGENCE_CORE_TOKEN, policy: manifest.candidateSetHash }),
    mappings: candidates.map((candidate) => ({
      mappingId: idOf({ mapping: candidate.candidateRef, candidateSetHash: manifest.candidateSetHash }),
      sourceTableId: idOf({ table: candidate.sourceFieldRef }),
      sourceFieldId: idOf({ field: candidate.sourceFieldRef }),
      targetObject: "Contact",
      targetField: "Email",
      intent: { kind: "SET", reasonCode: "MAPPED" },
      evidence: {
        evidenceId: idOf({ evidence: candidate.candidateRef, candidateSetHash: manifest.candidateSetHash }),
        candidateId: idOf({ candidate: candidate.candidateRef }),
        provenance: "MODEL_ASSISTED",
        factHashes: [],
        ruleVersion: CONTRACT_FAKE_INTELLIGENCE_CORE_TOKEN,
        comparisonHash: digestOf({ token: CONTRACT_FAKE_INTELLIGENCE_CORE_TOKEN, comparison: candidate.candidateRef }),
        fragmentHash: digestOf({ token: CONTRACT_FAKE_INTELLIGENCE_CORE_TOKEN, fragment: candidate.candidateRef }),
      },
    })),
    identities: [],
    transforms: [],
    relationships: [],
  };
  return body as unknown as PlanBody;
}

export interface ContractFakeIntelligenceCoreOptions {
  readonly dispatchCostCents?: number;
}

export class ContractFakeIntelligenceCore implements InterpretPort, PlanCompilerPort {
  readonly evidenceClass: CoreEvidenceClass = "SIMULATED";
  readonly #dispatchCostCents: number;
  #sequence = 0;
  readonly #calls: IntelligenceCoreCall[] = [];
  readonly #holds = new Map<string, HoldRecord[]>();
  readonly #outcomes: InterpretOutcome[] = [];

  constructor(options: ContractFakeIntelligenceCoreOptions = {}) {
    this.#dispatchCostCents = options.dispatchCostCents ?? CONTRACT_FAKE_INTELLIGENCE_CORE_DEFAULT_COST_CENTS;
  }

  /** Queues the outcomes `interpret` answers on its next fresh dispatches, in call order. */
  scriptInterpretOutcomes(...outcomes: readonly InterpretOutcome[]): void {
    this.#outcomes.push(...outcomes);
  }

  /** A hold point on the next call to reach the named step. */
  holdNext(step: IntelligenceCoreStep): IntelligenceCoreHold {
    let signal: () => void = () => undefined;
    let release: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = this.#holds.get(step) ?? [];
    queue.push({ signal, released });
    this.#holds.set(step, queue);
    return { reached, release };
  }

  /** The calls so far, in arrival order (optionally of one operation). */
  calls(operation?: IntelligenceCoreOperation): readonly IntelligenceCoreCall[] {
    return this.#calls.filter((call) => operation === undefined || call.operation === operation);
  }

  async #wait(step: IntelligenceCoreStep): Promise<void> {
    const hold = this.#holds.get(step)?.shift();
    if (hold === undefined) return;
    hold.signal();
    await hold.released;
  }

  async #record<T>(operation: IntelligenceCoreOperation, effect: () => Promise<T>): Promise<T> {
    const sequence = (this.#sequence += 1);
    try {
      const value = await effect();
      this.#calls.push({ sequence, operation, outcome: "OK" });
      return value;
    } catch (error) {
      this.#calls.push({ sequence, operation, outcome: `FAILED ${error instanceof Error ? error.message : "ERROR"}` });
      throw error;
    }
  }

  planCandidates(request: PlanCandidatesRequest): Promise<CandidateManifest> {
    return this.#record("planCandidates", async () => {
      await this.#wait("plan");
      const candidateSetHash = digestOf({
        token: CONTRACT_FAKE_INTELLIGENCE_CORE_TOKEN,
        revisionHash: request.revisionHash,
        sourceProfileHash: request.sourceProfileHash,
        targetContractHash: request.targetContractHash,
      });
      // the manifest names the source and target it was planned for (the draft body of a compiled interpretation binds them)
      return {
        evidenceClass: this.evidenceClass,
        candidateSetHash,
        document: Object.freeze({
          token: CONTRACT_FAKE_INTELLIGENCE_CORE_TOKEN,
          complete: true,
          revisionHash: request.revisionHash,
          targetContractHash: request.targetContractHash,
          candidates: [Object.freeze({ candidateRef: `${CONTRACT_FAKE_INTELLIGENCE_CORE_TOKEN}-candidate-1`, sourceFieldRef: `${CONTRACT_FAKE_INTELLIGENCE_CORE_TOKEN}-field-1` })],
        }),
      };
    });
  }

  interpret(request: InterpretRequest): Promise<InterpretResult> {
    return this.#record("interpret", async () => {
      await this.#wait("read");
      const before = await request.journal.read(request.auditAttemptId);
      const stored = [...before].reverse().find((event) => event["kind"] === CONTRACT_FAKE_INTELLIGENCE_CORE_RESPONSE && event["candidateSetHash"] === request.candidateManifest.candidateSetHash);
      if (stored !== undefined) {
        return {
          evidenceClass: this.evidenceClass,
          outcome: stored["outcome"] as InterpretOutcome,
          candidateDecisions: stored["candidateDecisions"] ?? null,
          reservedCents: 0,
          spentCents: 0,
        };
      }

      if (this.#dispatchCostCents > request.fundedCeilingCents) {
        return { evidenceClass: this.evidenceClass, outcome: "FAILED", candidateDecisions: null, reservedCents: 0, spentCents: 0 };
      }

      await this.#wait("reserve");
      const reserved = await request.journal.append(
        request.auditAttemptId,
        { kind: CONTRACT_FAKE_INTELLIGENCE_CORE_RESERVATION, candidateSetHash: request.candidateManifest.candidateSetHash, costCents: this.#dispatchCostCents },
        before.length,
      );
      if (!reserved.ok) throw new Error(`${CONTRACT_FAKE_INTELLIGENCE_CORE_TOKEN}: reservation conflict at length ${String(before.length)}`);

      await this.#wait("dispatch");
      const outcome = this.#outcomes.shift() ?? "FAILED";
      const body = outcome === "COMPILED" ? draftBodyOf(request.candidateManifest) : null;
      const candidateDecisions =
        outcome === "COMPILED" || outcome === "NEEDS_DECISION"
          ? { token: CONTRACT_FAKE_INTELLIGENCE_CORE_TOKEN, outcome, candidateSetHash: request.candidateManifest.candidateSetHash, ...(body === null ? {} : { body }) }
          : null;

      await this.#wait("commit");
      const afterReservation = await request.journal.read(request.auditAttemptId);
      const committed = await request.journal.append(
        request.auditAttemptId,
        { kind: CONTRACT_FAKE_INTELLIGENCE_CORE_RESPONSE, candidateSetHash: request.candidateManifest.candidateSetHash, outcome, candidateDecisions, costCents: this.#dispatchCostCents },
        afterReservation.length,
      );
      if (!committed.ok) throw new Error(`${CONTRACT_FAKE_INTELLIGENCE_CORE_TOKEN}: commit conflict at length ${String(afterReservation.length)}`);

      return { evidenceClass: this.evidenceClass, outcome, candidateDecisions, reservedCents: this.#dispatchCostCents, spentCents: this.#dispatchCostCents };
    });
  }

  compile(candidateDecisions: unknown, _current: PlanBody | null): Promise<PatchCompilation> {
    return this.#record("compile", async () => {
      await this.#wait("compile");
      const decisions = candidateDecisions as { readonly body?: PlanBody } | null;
      if (decisions === null || decisions === undefined || decisions.body === undefined) {
        return { kind: "REJECTED", reason: "MALFORMED_PATCH" } as const;
      }
      const body = decisions.body;
      return { kind: "COMPILED", body, bodyHash: structuredDigest(DOMAINS.PLAN_BODY, 1, body) } as const;
    });
  }
}
