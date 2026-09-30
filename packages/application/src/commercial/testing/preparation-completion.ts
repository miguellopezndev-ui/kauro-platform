/**
 * The contract fake of PreparationCompletionSource (design §7, §11, D10-FAKE-1): the platform port B13's stage completions will
 * answer. It answers only what a test recorded for that agency and capture — a STAGE completion is a STAGE, a FINAL is a FINAL —
 * in instant order with a STAGE before a FINAL of the same instant, and nothing recorded is nothing completed. The evidence hash
 * of a completion is a function of what was recorded, so the same script always gives the same evidence.
 * `binding: CONTRACT_FAKE`, evidence class SIMULATED, a call log and a hold point; reachable only from the testing subpath.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { AgencyId, CaptureId, Clock, UnitOfWork } from "@kauro/domain";
import { CONTRACT_FAKE, FAKE_EVIDENCE_CLASS, sha256Hex, type FakeCall } from "../../commerce/testing/labels.js";
import type { PreparationCompletion, PreparationCompletionKind, PreparationCompletionSource } from "../ports.js";
import { HoldPoints, type CommercialFakeHold } from "./holds.js";

export const PREPARATION_COMPLETION_FAKE_PROVIDER = "contract-fake-preparation-completion" as const;

/** What a test records: one completion of one purchase (an agency's capture) of one kind. */
export interface RecordedCompletion {
  readonly agencyId: AgencyId;
  readonly captureId: CaptureId;
  readonly kind: PreparationCompletionKind;
  readonly completedAt: UtcInstant;
  readonly source: string;
}

const KIND_ORDER: Readonly<Record<PreparationCompletionKind, number>> = { STAGE: 0, FINAL: 1 };

export class ContractFakePreparationCompletion implements PreparationCompletionSource {
  readonly provider = PREPARATION_COMPLETION_FAKE_PROVIDER;
  readonly integrationClass = CONTRACT_FAKE;
  readonly evidenceClass = FAKE_EVIDENCE_CLASS;
  readonly contractFake = true as const;
  readonly binding = CONTRACT_FAKE;

  private readonly recorded = new Map<string, PreparationCompletion[]>();
  private readonly log: FakeCall[] = [];
  private readonly holds = new HoldPoints<"COMPLETIONS_OF">();

  constructor(private readonly options: { readonly clock: Clock }) {}

  /** The calls received so far, oldest first; a frozen copy. */
  get calls(): ReadonlyArray<FakeCall> {
    return Object.freeze([...this.log]);
  }

  /** Records one completion. One completion per purchase and kind: a second is refused, as the platform's own fact is written once. */
  record(completion: RecordedCompletion): void {
    const key = `${completion.agencyId}/${completion.captureId}`;
    const held = this.recorded.get(key) ?? [];
    if (held.some((c) => c.kind === completion.kind)) throw new Error(`a ${completion.kind} completion is already recorded for ${key} (contract fake)`);
    held.push(
      Object.freeze({
        kind: completion.kind,
        completedAt: completion.completedAt,
        evidenceHash: sha256Hex(["preparation-completion", completion.agencyId, completion.captureId, completion.kind, completion.completedAt, completion.source].join("|")),
        source: completion.source,
      }),
    );
    this.recorded.set(key, held);
  }

  /** Stops the next `completionsOf` after it was recorded, until the test releases it. */
  hold(operation: "COMPLETIONS_OF"): CommercialFakeHold {
    return this.holds.hold(operation);
  }

  async completionsOf(uow: UnitOfWork, request: { readonly agencyId: AgencyId; readonly captureId: CaptureId }): Promise<ReadonlyArray<PreparationCompletion>> {
    const key = `${request.agencyId}/${request.captureId}`;
    this.log.push(Object.freeze({ port: "PreparationCompletionSource", operation: `COMPLETIONS_OF ${uow.context.kind}`, identity: key, at: this.options.clock.now(), sent: true }));
    await this.holds.arrive("COMPLETIONS_OF");
    const held = this.recorded.get(key) ?? [];
    return Object.freeze([...held].sort((a, b) => (a.completedAt < b.completedAt ? -1 : a.completedAt > b.completedAt ? 1 : KIND_ORDER[a.kind] - KIND_ORDER[b.kind])));
  }
}
