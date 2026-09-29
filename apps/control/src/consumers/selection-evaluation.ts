/**
 * SELECTION_EVALUATION (docs/design/B07-upload-source-lifecycle.md §12.2; decisions D-SEL-3, D-DP-4, D-LOCK-2, D-CLOCK-1; 03 "Count
 * the correct population"; 04 "Facts used as proof must be exact"): the consumer of `dataset_revision.selection_changed.v1`.
 *
 * If the revision still binds that selection and is INSPECTING, the platform's evaluator (@kauro/data-plane, isolated, always real)
 * opens every included table's accepted generation by exact generation, re-verifies its digest and counts the four populations
 * exactly. The pass's start and completion are read from the database clock around it. One unit of work, revision row first,
 * records the evaluation and moves the revision: COMPLETE → READY_TO_SEAL (dataset_revision.ready_to_seal.v1); ADMISSION_FAILED →
 * REJECTED (dataset_revision.rejected.v1; no silent removal from the source set); ERROR (other bytes than the admitted ones, an
 * evaluator that did not finish) is recorded as evidence and retried, then dead-lettered. A selection rebound while the pass ran
 * leaves this pass nothing to decide (DONE: the new binding has its own event).
 */
import type { Sha256Hex } from "@kauro/contracts";
import type { ConsumerOutcome, ObjectStoragePort, OutboxConsumer, SelectionEvaluationInput, SelectionEvaluationOutcome, SelectionEvaluatorPort } from "@kauro/application";
import {
  PRICING_DEFINITION,
  evaluationHashOf,
  isUuidV7,
  type AssociationDeclaration,
  type CausationId,
  type DomainEventRecord,
  type EvaluatedTable,
  type EvaluationId,
  type RevisionId,
  type SelectionEvaluationRecord,
  type SelectionManifestId,
  type SourceUnitOfWorkFactory,
  type SystemContext,
} from "@kauro/domain";
import { evaluationLimits } from "@kauro/data-plane";
import { locationOf } from "../storage-work.js";
import { applied, boundTo, lostTheSubject, publish, type WorkItem } from "../work.js";

export interface SelectionEvaluationDependencies {
  readonly storage: ObjectStoragePort;
  /** The platform's counting pass (@kauro/data-plane IsolatedSelectionEvaluator): always real. */
  readonly evaluator: SelectionEvaluatorPort;
  readonly retryAfterSeconds?: number;
}

/** The reason a revision's fatal_input_rejection records (a token; 07 "no silent removal"). */
export const SELECTED_INPUT_REJECTED = "SELECTED_INPUT_REJECTED";

export class SelectionEvaluation implements OutboxConsumer {
  readonly consumer = "SELECTION_EVALUATION" as const;

  constructor(private readonly deps: SelectionEvaluationDependencies) {}

  async handle(event: DomainEventRecord, context: SystemContext, units: SourceUnitOfWorkFactory): Promise<ConsumerOutcome> {
    if (event.eventType !== "dataset_revision.selection_changed.v1") return { kind: "DEAD_LETTER", reason: "EVENT_NOT_ROUTED_TO_SELECTION_EVALUATION" };
    const revisionId = event.payload["revisionId"];
    const selectionHash = event.payload["selectionHash"];
    const selectionManifestId = event.payload["selectionManifestId"];
    if (context.agencyId === undefined || !isUuidV7(revisionId) || !isUuidV7(selectionManifestId) || typeof selectionHash !== "string") return { kind: "DEAD_LETTER", reason: "EVENT_WITHOUT_SUBJECT" };
    const item: WorkItem = { serviceId: context.serviceId, agencyId: context.agencyId, correlationId: context.correlationId, causationId: event.eventId as unknown as CausationId };
    try {
      return await this.evaluate(item, units, revisionId as RevisionId, selectionManifestId as SelectionManifestId, selectionHash as Sha256Hex);
    } catch (e) {
      if (lostTheSubject(e)) return { kind: "DONE" };
      throw e;
    }
  }

  async evaluate(item: WorkItem, units: SourceUnitOfWorkFactory, revisionId: RevisionId, selectionManifestId: SelectionManifestId, selectionHash: Sha256Hex): Promise<ConsumerOutcome> {
    const read = await units.runSource(boundTo(item), async (uow) => {
      const revision = await uow.sources.revisions.get(revisionId);
      if (revision === null) return { kind: "INVISIBLE" as const };
      if (revision.state !== "INSPECTING" || revision.selectionHash !== selectionHash || revision.selectionManifestId !== selectionManifestId) return { kind: "SETTLED" as const };
      const manifest = await uow.sources.selections.get(revisionId, selectionManifestId);
      if (manifest === null) return { kind: "INVISIBLE" as const };
      const files: Array<SelectionEvaluationInput["files"][number]> = [];
      for (const entry of manifest.body.files) {
        if (entry.disposition !== "INCLUDE") continue;
        const file = await uow.sources.files.get(entry.fileId);
        if (file === null) return { kind: "INVISIBLE" as const };
        const object = await uow.sources.objects.get(file.storageRef);
        if (object === null) return { kind: "INVISIBLE" as const };
        const tables = await uow.sources.files.tables(file.fileId);
        const location = locationOf(object);
        files.push({ file, tables, open: () => this.deps.storage.read(location, object.objectName, file.providerGeneration) });
      }
      return { kind: "READ" as const, manifest, files, projectId: revision.projectId, startedAt: await uow.serverInstant() };
    });
    if (read.kind === "INVISIBLE") return { kind: "DEAD_LETTER", reason: "SUBJECT_NOT_VISIBLE" };
    if (read.kind === "SETTLED") return { kind: "DONE" };

    let outcome: SelectionEvaluationOutcome;
    try {
      outcome = await this.deps.evaluator.evaluate({ selection: read.manifest.body, files: read.files, limits: evaluationLimits(), pricingDefinition: PRICING_DEFINITION });
    } catch {
      outcome = { result: "ERROR", failures: [{ code: "EVALUATOR_FAILED" }] };
    }
    // B07-R2: the per-association edges the evaluator measured are recorded with their tables (the sealed subject's counts, D-CMD-8);
    // a complete outcome that does not measure exactly the declared associations states counts nobody measured: an ERROR
    let countedTables: ReadonlyArray<EvaluatedTable> = outcome.result === "ERROR" ? [] : outcome.tables;
    if (outcome.result === "COMPLETE") {
      const split = tablesWithAssociations(outcome.tables, read.manifest.body.associations, outcome.associations);
      if (split === null) outcome = { result: "ERROR", failures: [{ code: "ASSOCIATION_COUNTS_INCOMPLETE" }] };
      else countedTables = split;
    }

    return units.runSource(boundTo(item), async (uow): Promise<ConsumerOutcome> => {
      const revision = await uow.sources.revisions.lock(revisionId);
      if (revision === null || revision.state !== "INSPECTING" || revision.selectionHash !== selectionHash) return { kind: "DONE" };
      const completedAt = await uow.serverInstant();
      const evaluationId = uow.ids.next() as EvaluationId;
      const body: Omit<SelectionEvaluationRecord, "evaluationHash"> =
        outcome.result === "COMPLETE"
          ? {
              evaluationId,
              agencyId: item.agencyId,
              revisionId,
              selectionManifestId,
              selectionHash,
              result: "COMPLETE",
              populations: outcome.populations,
              fileCount: outcome.files.length,
              totalBytes: outcome.files.reduce((sum, f) => sum + f.bytes, 0),
              files: outcome.files,
              tables: countedTables,
              projections: outcome.projections,
              failures: [],
              pricingDefinition: PRICING_DEFINITION,
              evaluatorVersion: this.deps.evaluator.version,
              startedAt: read.startedAt,
              completedAt,
            }
          : {
              evaluationId,
              agencyId: item.agencyId,
              revisionId,
              selectionManifestId,
              selectionHash,
              result: outcome.result,
              files: outcome.result === "ADMISSION_FAILED" ? outcome.files : [],
              tables: outcome.result === "ADMISSION_FAILED" ? countedTables : [],
              projections: [],
              failures: outcome.failures.length > 0 ? outcome.failures : [{ code: "EVALUATION_FAILED" }],
              pricingDefinition: PRICING_DEFINITION,
              evaluatorVersion: this.deps.evaluator.version,
              startedAt: read.startedAt,
              completedAt,
            };
      const evaluationHash = evaluationHashOf(body);
      await uow.sources.evaluations.append({ ...body, evaluationHash });
      if (outcome.result === "ERROR") return { kind: "RETRY", afterSeconds: this.deps.retryAfterSeconds ?? 60, reason: "EVALUATION_ERROR" };
      if (outcome.result === "COMPLETE") {
        const ready = applied(await uow.sources.revisions.transition(revisionId, revision.version, { event: "all_selected_inputs_admitted", evaluationId, evaluationHash, populations: outcome.populations }), "all_selected_inputs_admitted");
        await publish(uow, item, "dataset_revision", revisionId, ready.version, "dataset_revision.ready_to_seal.v1", {
          revisionId,
          agencyId: item.agencyId,
          projectId: read.projectId,
          selectionHash,
          evaluationHash,
          physicalSourceRows: outcome.populations.physicalSourceRows,
          logicalSourceRecords: outcome.populations.logicalSourceRecords,
          billableSourceUnits: outcome.populations.billableSourceUnits,
          associationEdges: outcome.populations.associationEdges,
        });
        return { kind: "DONE" };
      }
      const rejected = applied(await uow.sources.revisions.transition(revisionId, revision.version, { event: "fatal_input_rejection", reason: SELECTED_INPUT_REJECTED }), "fatal_input_rejection");
      await publish(uow, item, "dataset_revision", revisionId, rejected.version, "dataset_revision.rejected.v1", {
        revisionId,
        agencyId: item.agencyId,
        projectId: read.projectId,
        selectionHash,
        evaluationHash,
        reasonCode: SELECTED_INPUT_REJECTED,
      });
      return { kind: "DONE" };
    });
  }
}

/**
 * The evaluated tables with the measured edges of each association the selection declares on them (B07-R2; D-CMD-8): every declared
 * association measured exactly once, on a counted table, and nothing measured that the selection does not declare — otherwise null
 * (the sealed subject never states a count nobody measured). A table without a declared association is left as the evaluator
 * reported it.
 */
export function tablesWithAssociations(
  tables: ReadonlyArray<EvaluatedTable>,
  declared: ReadonlyArray<AssociationDeclaration>,
  measured: ReadonlyArray<{ readonly associationKey: string; readonly edges: number }>,
): ReadonlyArray<EvaluatedTable> | null {
  const edges = new Map<string, number>();
  for (const a of measured) {
    if (edges.has(a.associationKey) || !Number.isSafeInteger(a.edges) || a.edges < 0) return null;
    edges.set(a.associationKey, a.edges);
  }
  if (edges.size !== declared.length || declared.some((a) => !edges.has(a.associationKey) || !tables.some((t) => t.tableId === a.tableId))) return null;
  return tables.map((t) => {
    const own = declared.filter((a) => a.tableId === t.tableId);
    return own.length === 0 ? t : { ...t, associations: own.map((a) => ({ associationKey: a.associationKey, edges: edges.get(a.associationKey) as number })) };
  });
}
