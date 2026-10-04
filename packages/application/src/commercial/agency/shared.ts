/**
 * Helpers the agency lifecycle's handlers share: the resolved membership of an access decision, the stale-version answer of a
 * compare-and-swap miss and the version check on a locked row (10 "Concurrency and preconditions"), as B06's handlers answer them.
 */
import type { ResolvedMembership } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";

export { applied, checkExpectedVersion } from "../../commands/handlers/shared.js";

/** The membership an ALLOW decision of a tenant command resolved; never null for one (the authorizer reads it after its transition lock). */
export function requireMembershipOf(membership: ResolvedMembership | null): ResolvedMembership {
  if (membership === null) throw new DomainFailure("INTEGRITY_FAILURE", "a tenant command was authorized without a membership");
  return membership;
}
