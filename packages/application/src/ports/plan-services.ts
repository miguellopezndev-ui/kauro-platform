/**
 * Plan-side collaborators the B06 commands need but do not own:
 * - ArtifactResolver: resolves a decisionPatchArtifactRef (CMD023) to a typed decision patch stored in the agency's scope
 *   (artifacts belong to the data plane; a reference outside the agency is unknown, never revealed);
 * - PlanPatchCompiler (owner manual 06/07): applies a typed patch to a plan body under the candidate/field/effect permissions
 *   ("The typed patch names existing candidates/fields and permitted effects"); natural-language instructions are not patches;
 * - DisclosureComposer (owner manual 11/07): computes the disclosure set of a validated plan — effects, counts, risks,
 *   limitations, every CLEAR operation — and its disclosuresHash, the server-side truth CMD025 compares against.
 */
import type { Sha256Hex } from "@kauro/contracts";
import type { AgencyId, ArtifactRef, PlanBody, PlanRecord, UnitOfWork, ValidationReceiptRecord } from "@kauro/domain";

export interface DecisionPatch {
  readonly artifactRef: ArtifactRef;
  readonly patchHash: Sha256Hex;
  /** The closed patch document (registry DecisionEvidence references), opaque to B06. */
  readonly document: unknown;
}

export interface ArtifactResolver {
  resolveDecisionPatch(uow: UnitOfWork, agencyId: AgencyId, ref: ArtifactRef): Promise<DecisionPatch | null>;
}

export type PatchCompilation =
  | { readonly kind: "COMPILED"; readonly body: PlanBody; readonly bodyHash: Sha256Hex }
  | { readonly kind: "REJECTED"; readonly reason: "UNKNOWN_CANDIDATE" | "UNKNOWN_FIELD" | "EFFECT_NOT_PERMITTED" | "MALFORMED_PATCH" };

export interface PlanPatchCompiler {
  apply(current: PlanBody, patch: DecisionPatch): Promise<PatchCompilation>;
}

export interface DisclosureSet {
  readonly disclosuresHash: Sha256Hex;
  /** Safe tokens describing each disclosed effect class (e.g. CLEAR:Contact.Phone:120) — no customer values. */
  readonly items: ReadonlyArray<string>;
  readonly includesClear: boolean;
}

export interface DisclosureComposer {
  compose(uow: UnitOfWork, plan: PlanRecord, body: PlanBody, receipt: ValidationReceiptRecord): Promise<DisclosureSet>;
}
