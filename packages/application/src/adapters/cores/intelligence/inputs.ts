/**
 * The inputs of one Intelligence core attempt, read from the stored core documents and checked by the core's own loaders (B05 D5-3,
 * D5-14; cases I10, I14): the source profile and, outside CLEAN_ONLY, the target contract, each stored under the hash its core names it by.
 * A missing document, or one the core's loader does not read back to that same hash, is PROFILE_EVIDENCE_MISSING before any reservation.
 */
import type { Sha256Hex } from "@kauro/contracts";
import type { AgencyId } from "@kauro/domain";
import type { HashedCandidateSet, HashedSourceProfile, HashedTargetContract } from "@kauro/migration-core";
import { canonicalJson, sha256Hex } from "@kauro/intelligence-core";
import { buildCandidateSet, loadSourceProfile, loadTargetContract, syntheticConfig } from "@kauro/migration-core";
import type { CoreDocumentStore } from "../../../ports/index.js";

export class ProfileEvidenceMissing extends Error {
  readonly code = "PROFILE_EVIDENCE_MISSING";
  constructor(readonly what: "SOURCE_PROFILE" | "TARGET_CONTRACT" | "CANDIDATE_SET", detail: string) {
    super(`PROFILE_EVIDENCE_MISSING (${what}): ${detail}`);
    this.name = "ProfileEvidenceMissing";
  }
}

export interface LoadedInputs {
  readonly sourceProfile: HashedSourceProfile;
  readonly targetContract: HashedTargetContract | null;
  /** The candidate set of the profile alone, bound to the profile's synthetic reading (what Migration Core's own inspection builds). */
  readonly candidateSet: HashedCandidateSet;
}

/** The profile the PROFILE step stored, as the core's loader reads it back; its hash must be the one asked for. */
export function profileOf(document: unknown, wanted: Sha256Hex): HashedSourceProfile {
  try {
    const hashed = loadSourceProfile(JSON.stringify({ profile: document, profileHash: wanted }), "stored source profile");
    if (hashed.profileHash !== wanted) throw new Error("the stored profile hashes to another value");
    return hashed;
  } catch (e) {
    throw new ProfileEvidenceMissing("SOURCE_PROFILE", e instanceof Error ? e.message : "unreadable");
  }
}

export function targetOf(document: unknown, wanted: Sha256Hex): HashedTargetContract {
  try {
    const hashed = loadTargetContract(JSON.stringify({ contract: document, contractHash: wanted }), "stored target contract");
    if (hashed.contractHash !== wanted) throw new Error("the stored target contract hashes to another value");
    return hashed;
  } catch (e) {
    throw new ProfileEvidenceMissing("TARGET_CONTRACT", e instanceof Error ? e.message : "unreadable");
  }
}

/**
 * The candidate set of the profile alone: deterministic, so a re-derivation by a later step has the same hash. It is bound to the
 * profile's synthetic reading (Migration Core's own inspection does the same: the synthetic reading maps no record, so it is hashed, not
 * loaded); a run under a plan produces its own set against that plan's configuration.
 */
export function candidateSetOf(profile: HashedSourceProfile): HashedCandidateSet {
  try {
    const config = syntheticConfig(profile.profile.files.map((f) => ({ path: f.path, format: f.format === "XLSX" ? ("XLSX" as const) : ("CSV" as const) })));
    return buildCandidateSet({ profile, configHash: sha256Hex(canonicalJson(JSON.parse(JSON.stringify(config)))) });
  } catch (e) {
    throw new ProfileEvidenceMissing("CANDIDATE_SET", e instanceof Error ? e.message : "not buildable");
  }
}

export async function loadInputs(documents: CoreDocumentStore, agencyId: AgencyId, sourceProfileHash: Sha256Hex, targetContractHash: Sha256Hex | null): Promise<LoadedInputs> {
  const profileDocument = await documents.document(agencyId, "SOURCE_PROFILE", sourceProfileHash);
  if (profileDocument === null) throw new ProfileEvidenceMissing("SOURCE_PROFILE", "no stored profile for this hash");
  const sourceProfile = profileOf(profileDocument, sourceProfileHash);
  let targetContract: HashedTargetContract | null = null;
  if (targetContractHash !== null) {
    const targetDocument = await documents.document(agencyId, "TARGET_CONTRACT", targetContractHash);
    if (targetDocument === null) throw new ProfileEvidenceMissing("TARGET_CONTRACT", "no stored target contract for this hash");
    targetContract = targetOf(targetDocument, targetContractHash);
  }
  return { sourceProfile, targetContract, candidateSet: candidateSetOf(sourceProfile) };
}
