/**
 * The platform's PlanCompilerPort over the Intelligence core's draft (B05 L3; D5-16; cases B01-B03, I09, I10).
 *
 * `candidateDecisions` is exactly what IntelligenceCoreAdapter.interpret handed over (a validated SYSTEM_DRAFT). The compiler (1) refuses
 * anything else as MALFORMED_PATCH, (2) rebuilds the Migration Core configuration document of the draft's configuration with the stored
 * profile and requires Migration Core's own loader to hash it to the coreConfigHash the full-dataset validation named (a mismatch is
 * INTEGRITY_FAILURE: an identity of one class is never reinterpreted as another, D5-3), (3) derives the PlanBody and its structured
 * digest (recomputed by the platform, never taken from the core), and (4) stores the binding planHash -> (configuration document,
 * coreConfigHash) before answering COMPILED: execute and validate translate a plan only through that binding, so a draft without its
 * binding does not exist. A compile that fails to store the binding answers nothing (the error reaches the caller; no draft).
 */
import { DOMAINS, structuredDigest } from "@kauro/contracts";
import type { Sha256Hex } from "@kauro/contracts";
import { CLEAN_ONLY_TARGET_HASH, DomainFailure, type AgencyId, type PlanBody } from "@kauro/domain";
import { CanonicalAgreementError, MODEL_POLICY_HASH, PROMPT_BUNDLE_HASH, assertCanonicalAgreement, toMigrationConfig } from "@kauro/intelligence-core";
import { loadConfig, MigrationError } from "@kauro/migration-core";
import type { CoreDocumentStore, PlanCompilerPort } from "../../../ports/index.js";
import type { PatchCompilation } from "../../../ports/plan-services.js";
import { INTELLIGENCE_DRAFT_KIND, type IntelligenceDraftDecisions } from "./intelligence-adapter.js";
import { profileOf } from "./inputs.js";
import { MalformedDraft, planBodyOf, policyHashOf } from "./plan-body.js";

export interface IntelligencePlanCompilerDeps {
  readonly documents: CoreDocumentStore;
}


function isDecisions(value: unknown): value is IntelligenceDraftDecisions {
  const v = value as Partial<IntelligenceDraftDecisions> | null;
  return typeof v === "object" && v !== null && v.kind === INTELLIGENCE_DRAFT_KIND && typeof v.agencyId === "string" && typeof v.revisionHash === "string" && typeof v.profileHash === "string" && typeof v.draft === "object" && v.draft !== null;
}

export class IntelligencePlanCompiler implements PlanCompilerPort {
  readonly #documents: CoreDocumentStore;

  constructor(deps: IntelligencePlanCompilerDeps) {
    this.#documents = deps.documents;
  }

  /** `current` is the plan being revised, if any: a revision's patch is the PlanPatchCompiler's (CMD023), not this port's. */
  async compile(candidateDecisions: unknown, current: PlanBody | null): Promise<PatchCompilation> {
    const malformed = { kind: "REJECTED", reason: "MALFORMED_PATCH" } as const;
    if (current !== null || !isDecisions(candidateDecisions)) return malformed;
    const { draft } = candidateDecisions;
    const configuration = draft.configuration;
    const bound = draft.fullValidation?.evidence.coreConfigHash ?? null;
    if (draft.status !== "SYSTEM_DRAFT" || configuration === null || bound === null || draft.validation.status !== "VALIDATED") return malformed;

    const agencyId = candidateDecisions.agencyId as AgencyId;
    const profileDocument = await this.#documents.document(agencyId, "SOURCE_PROFILE", candidateDecisions.profileHash as Sha256Hex);
    if (profileDocument === null) return malformed;
    let profile;
    try {
      profile = profileOf(profileDocument, candidateDecisions.profileHash as Sha256Hex);
    } catch {
      return malformed;
    }

    const translation = toMigrationConfig(configuration, profile);
    if (translation.document === null) return malformed;
    let coreConfigHash: string;
    try {
      coreConfigHash = loadConfig(JSON.stringify(translation.document), "plan binding").configHash;
    } catch (e) {
      if (e instanceof MigrationError) return malformed;
      throw e;
    }
    if (coreConfigHash !== bound) throw new DomainFailure("INTEGRITY_FAILURE", "the configuration document does not load to the core configuration hash its validation named");

    let body: PlanBody;
    try {
      body = planBodyOf({
        draft,
        configuration,
        revisionHash: candidateDecisions.revisionHash as Sha256Hex,
        // a CLEAN_ONLY draft has no target contract: it carries the canonical CLEAN hash (registry Plan.targetContractHash is required)
        targetContractHash: (candidateDecisions.targetContractHash ?? CLEAN_ONLY_TARGET_HASH) as Sha256Hex,
        policyHash: policyHashOf(draft, { modelPolicyHash: MODEL_POLICY_HASH, promptBundleHash: PROMPT_BUNDLE_HASH }),
      });
      assertCanonicalAgreement(body);
    } catch (e) {
      if (e instanceof MalformedDraft) return malformed;
      if (e instanceof CanonicalAgreementError) throw new DomainFailure("INTEGRITY_FAILURE", e.message);
      throw e;
    }
    const bodyHash = structuredDigest(DOMAINS.PLAN_BODY, 1, body) as Sha256Hex;
    await this.#documents.putPlanBinding(agencyId, bodyHash, { configDocument: translation.document, coreConfigHash: coreConfigHash as Sha256Hex });
    return { kind: "COMPILED", body, bodyHash };
  }
}
