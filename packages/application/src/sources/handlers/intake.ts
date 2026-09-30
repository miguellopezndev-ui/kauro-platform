/**
 * The selection manifest intake — POST /api/v1/revisions/{revisionId}/selection-manifests — AGENCY_OPERATOR (design §9.1, D-SEL-1,
 * D-SEL-2; catalogue CMD016 fields: `selectionManifestRef: id`; open question Q-B07-10). Not a catalogue command: it changes no
 * aggregate, so it takes no command journal entry and no version; it is content-idempotent instead — the same document again answers
 * the stored manifest with created false (200), whatever id the first request minted.
 *
 * Order (manual 10, as for every route): the document's admission (content type, size, strict JSON, the closed document schema,
 * path ids, the agency selector) → the authenticated subject → the access decision of the reads (ACTIVE live membership after its
 * transition lock) and the command's own role (AGENCY_OPERATOR: ROLE_INSUFFICIENT, a recorded denial) → the revision (NOT_FOUND) →
 * selectable (REVISION_NOT_SELECTABLE) → the document names this revision (SELECTION_MANIFEST_MISMATCH) → its internal consistency
 * (selection-rules checkDocument) → stored once per (revision, body hash) at the server's instant by the caller's own membership.
 * What the manifest means against the inventory is CMD016's to decide when the agency binds it.
 */
import type { AgencyId, MembershipId, RevisionId, SelectionManifestDocument, SelectionManifestId, SourceUnitOfWork } from "@kauro/domain";
import { DomainFailure, REVISION_SELECTABLE_STATES, roleSatisfies, selectionHashOf } from "@kauro/domain";
import type { AuthenticatedSubject } from "../../api/envelope.js";
import { problemOf, type Problem } from "../../api/problems.js";
import type { IntakeOperationId } from "../../api/response-schemas.js";
import type { SourceIntakeId } from "../outcomes.js";
import type { KnownSchemaId } from "../../ports/schema-validator.js";
import { runReadIn, type AccessSpec } from "../../queries/reads.js";
import type { CorrelationId } from "@kauro/domain";
import { SOURCE_ROUTES, type SelectionManifestIntakeView } from "../contracts.js";
import { SELECTION_MANIFEST_SCHEMA_ID } from "../request-schemas.js";
import { checkDocument } from "./selection-rules.js";
import type { SourceReadRuntime } from "./reads.js";

/** A document intake route: what its admission, its access decision and its facts are keyed by. */
export interface IntakeSpec extends AccessSpec {
  readonly operationId: IntakeOperationId;
  readonly method: "POST";
  readonly path: string;
  readonly scope: "AGENCY_HEADER";
  readonly schemaId: KnownSchemaId;
  readonly summary: string;
  readonly authority: string;
}

export const SOURCE_INTAKE_ROUTES: Readonly<Record<SourceIntakeId, IntakeSpec>> = Object.freeze({
  SubmitSelectionManifest: Object.freeze({
    operationId: "SubmitSelectionManifest",
    method: "POST",
    path: SOURCE_ROUTES.SubmitSelectionManifest.path,
    action: "SUBMIT_SELECTION_MANIFEST",
    scope: "AGENCY_HEADER",
    schemaId: SELECTION_MANIFEST_SCHEMA_ID,
    summary: "Stores a selection manifest of a revision (content-idempotent; CMD016 binds it by reference)",
    authority: SOURCE_ROUTES.SubmitSelectionManifest.authority,
  }),
});

export interface IntakeRequest {
  readonly correlationId: CorrelationId;
  readonly subject: AuthenticatedSubject;
  readonly agencyId: AgencyId;
  readonly path: Readonly<Record<string, string>>;
  /** The document after its closed schema admitted it. */
  readonly body: unknown;
}

export type IntakeResult<View> = { readonly kind: "STORED"; readonly created: boolean; readonly view: View } | { readonly kind: "PROBLEM"; readonly problem: Problem };

export interface IntakeHandler<View> {
  readonly spec: IntakeSpec;
  execute(request: IntakeRequest): Promise<IntakeResult<View>>;
}

export interface SourceIntakeHandlers {
  readonly SubmitSelectionManifest: IntakeHandler<SelectionManifestIntakeView>;
}

export function createSourceIntakeHandlers(runtime: SourceReadRuntime): SourceIntakeHandlers {
  const spec = SOURCE_INTAKE_ROUTES.SubmitSelectionManifest;
  const submit: IntakeHandler<SelectionManifestIntakeView> = {
    spec,
    async execute(request) {
      const run = <T>(context: Parameters<SourceReadRuntime["unitOfWork"]["runSource"]>[0], work: (uow: SourceUnitOfWork) => Promise<T>): Promise<T> => runtime.unitOfWork.runSource(context, work);
      const result = await runReadIn<{ readonly created: boolean; readonly view: SelectionManifestIntakeView }, SourceUnitOfWork>(spec, runtime, { ...request, agencyId: request.agencyId }, run, async (uow, ctx) => {
        if (ctx.membership === null) throw new DomainFailure("INTEGRITY_FAILURE", "an agency intake was authorized without a membership");
        const membership = ctx.membership;
        if (!roleSatisfies(SOURCE_ROUTES.SubmitSelectionManifest.role, membership.role)) throw new DomainFailure("NOT_AUTHORIZED", "the intake needs an operating role", { reason: "ROLE_INSUFFICIENT" });
        const revisionId = request.path["revisionId"] as RevisionId;
        const revision = await uow.sources.revisions.get(revisionId);
        if (!revision || revision.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "revision not visible");
        if (!REVISION_SELECTABLE_STATES.has(revision.state)) {
          throw new DomainFailure("PRECONDITION_FAILED", "the revision takes no new selection", { reason: "REVISION_NOT_SELECTABLE", currentVersion: revision.version, currentState: revision.state });
        }
        const document = request.body as SelectionManifestDocument;
        if (document.revisionId !== revisionId) throw new DomainFailure("INVALID_REQUEST", "the document names another revision than the path", { reason: "SELECTION_MANIFEST_MISMATCH" });
        checkDocument(document);
        const stored = await uow.sources.selections.put({
          selectionManifestId: uow.ids.next() as SelectionManifestId,
          agencyId: membership.agencyId,
          projectId: revision.projectId,
          revisionId,
          body: document,
          bodyHash: selectionHashOf(document),
          createdByMembershipId: membership.membershipId as MembershipId,
          createdAt: runtime.clock.now(),
        });
        return {
          created: stored.created,
          view: { selectionManifestId: stored.record.selectionManifestId, revisionId, bodyHash: stored.record.bodyHash, created: stored.created },
        };
      });
      if (result.kind === "PROBLEM") return result;
      return { kind: "STORED", created: result.view.created, view: result.view.view };
    },
  };
  return Object.freeze({ SubmitSelectionManifest: submit });
}

/** The problem of an intake refused before its handler (kept for symmetry with the reads' admission). */
export function intakeProblem(failure: DomainFailure, correlationId: CorrelationId): Problem {
  return problemOf(failure, correlationId);
}
