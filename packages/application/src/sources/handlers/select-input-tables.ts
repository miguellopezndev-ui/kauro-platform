/**
 * CMD016 SelectInputTables — POST /api/v1/revisions/{revisionId}/selection — AGENCY_OPERATOR (design §11 CMD016; D-INTAKE-1, D-SEL-1,
 * D-SEL-2, D-SEL-3, D-SEL-4, D-LOCK-1; catalogue "Persists explicit selected/excluded tables and parser choices in the mutable
 * revision"; failure "Missing or newly changed tables invalidate previous selection; no hidden-sheet silent inclusion").
 *
 * Order: authorize → reserve → the revision row (NOT_FOUND; D-LOCK-1: every settle point of its uploads — a cancellation, the
 * deadline sweeper, an inspection outcome — takes the same row first, so the selection always reads a settled result) → its version
 * (STALE_VERSION) → DRAFT, UPLOADING, INSPECTING or READY_TO_SEAL (REVISION_NOT_SELECTABLE) → no upload RESERVED, UPLOADING or
 * VERIFYING (UPLOADS_UNRESOLVED) → the manifest one of this revision's (UNKNOWN_REFERENCE) → the revision's current inventory hash is
 * the manifest's (SELECTION_STALE) → the manifest against the inventory (selection-rules) → bind the manifest, its selection hash (the
 * body's KAURO_SOURCE_SELECTION_V1 digest, recomputed) and the inventory hash at the server's instant, version + 1:
 * UPLOADING → INSPECTING is all_uploads_completed (the agency's explicit closing of the intake, D-INTAKE-1), DRAFT → INSPECTING
 * previously_admitted_inputs_selected, READY_TO_SEAL → INSPECTING selection_changes (the counts cleared), INSPECTING stays —
 * dataset_revision.selection_changed.v1 with the previous state (→ SELECTION_EVALUATION); the database repeats the file-and-table
 * comparison row by row (D-SEL-4) → journal 200 SelectInputTablesView.
 */
import type { Id } from "@kauro/contracts";
import type { RevisionId, RevisionTransition, SelectionManifestId, UserId } from "@kauro/domain";
import { DomainFailure, REVISION_SELECTABLE_STATES, UPLOAD_LIVE_STATES, inventoryHashOf, selectionHashOf } from "@kauro/domain";
import { applied, checkExpectedVersion, requireMembership } from "../../commands/handlers/shared.js";
import { SELECT_INPUT_TABLES, type SelectInputTablesBody, type SelectInputTablesHandler, type SelectInputTablesView } from "../contracts.js";
import { readRevisionView } from "./projections.js";
import { checkAgainstInventory } from "./selection-rules.js";
import { runSourceCommand, versionAt, type SourceRuntime } from "./shared.js";

/** The registry edge a binding takes from each selectable state (INSPECTING rebinds in place). */
function edgeFrom(state: string): RevisionTransition["event"] {
  switch (state) {
    case "UPLOADING":
      return "all_uploads_completed";
    case "DRAFT":
      return "previously_admitted_inputs_selected";
    case "READY_TO_SEAL":
      return "selection_changes";
    default:
      return "selection_rebound";
  }
}

export function selectInputTablesHandler(runtime: SourceRuntime): SelectInputTablesHandler {
  return {
    spec: SELECT_INPUT_TABLES,
    execute: (envelope) =>
      runSourceCommand<SelectInputTablesBody, SelectInputTablesView>(
        SELECT_INPUT_TABLES,
        runtime,
        envelope,
        async (uow, ctx) => {
          const membership = requireMembership(ctx);
          const revisionId = envelope.path["revisionId"] as RevisionId;
          const revision = await uow.sources.revisions.lock(revisionId);
          if (!revision || revision.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "revision not visible");
          checkExpectedVersion(revision, envelope.body.expectedVersion);
          const current = { currentVersion: revision.version, currentState: revision.state };
          if (!REVISION_SELECTABLE_STATES.has(revision.state)) {
            throw new DomainFailure("PRECONDITION_FAILED", "the revision takes no new selection", { reason: "REVISION_NOT_SELECTABLE", ...current });
          }
          const live = await uow.sources.uploads.inStates(revisionId, [...UPLOAD_LIVE_STATES] as ReadonlyArray<"RESERVED" | "UPLOADING" | "VERIFYING">);
          if (live.length > 0) throw new DomainFailure("PRECONDITION_FAILED", "a reservation, session or verification of the revision is still open", { reason: "UPLOADS_UNRESOLVED", ...current });
          const manifest = await uow.sources.selections.get(revisionId, envelope.body.selectionManifestRef as SelectionManifestId);
          if (!manifest) {
            throw new DomainFailure("INVALID_REQUEST", "selectionManifestRef is not a selection manifest of this revision", {
              reason: "UNKNOWN_REFERENCE",
              fields: [{ field: "selectionManifestRef", code: "UNKNOWN_REFERENCE" }],
            });
          }
          const inventoryHash = inventoryHashOf(await uow.sources.revisions.inventory(revisionId));
          if (manifest.body.inventoryHash !== inventoryHash) {
            throw new DomainFailure("PRECONDITION_FAILED", "the manifest was made against another inventory", { reason: "SELECTION_STALE", ...current });
          }
          const summary = await checkAgainstInventory(uow, revision, manifest.body);
          // the selection hash is the digest of the stored body, recomputed here, never taken from a column alone
          const selectionHash = selectionHashOf(manifest.body);
          if (selectionHash !== manifest.bodyHash) throw new DomainFailure("INTEGRITY_FAILURE", "the stored manifest is not the body its hash names");
          const selection = { selectionManifestId: manifest.selectionManifestId, selectionHash, inventoryHash };
          const bound = applied(await uow.sources.revisions.transition(revisionId, revision.version, { event: edgeFrom(revision.state), selection } as RevisionTransition));
          await uow.events.publish({
            aggregateKind: "dataset_revision",
            aggregateId: revisionId,
            aggregateVersion: bound.version,
            agencyId: bound.agencyId,
            eventType: "dataset_revision.selection_changed.v1",
            actor: { kind: "USER", userId: envelope.userId as UserId },
            causationId: ctx.causationId,
            correlationId: envelope.correlationId,
            payload: {
              revisionId,
              agencyId: bound.agencyId,
              projectId: bound.projectId,
              selectionManifestId: manifest.selectionManifestId,
              selectionHash,
              inventoryHash,
              previousState: revision.state,
              state: bound.state,
              includedFileCount: summary.includedFileCount,
              includedTableCount: summary.includedTableCount,
              reusedFileIds: summary.reusedFileIds,
            },
          });
          const view: SelectInputTablesView = {
            revision: await readRevisionView(uow, bound, membership.role),
            selection: { selectionManifestId: manifest.selectionManifestId, selectionHash, includedFileCount: summary.includedFileCount, includedTableCount: summary.includedTableCount, reusedFileIds: summary.reusedFileIds },
          };
          return { status: 200, view, version: bound.version, resourceKind: "dataset_revision", resourceId: revisionId as Id };
        },
        versionAt("revision"),
      ),
  };
}
