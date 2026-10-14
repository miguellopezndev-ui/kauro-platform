/**
 * The access decisions of the L-DRAFT commands (plan §L: L1 is the seller's or the owner's transition lock, taken by the authorizer before
 * the journal reservation L2). A person without an ACTIVE seller row may still be the corporate owner; any other refusal is the seller
 * check's own (the shape of CMD045).
 */
import type { SellerId, UserId } from "@kauro/domain";
import { CommerceAccessDenied } from "../../commerce/request/runtime.js";
import type { CommerceUnitOfWork, IdentityFacts } from "@kauro/domain";
import type { CommercialAuthorizer } from "../authorizer.js";
import type { ReadSpec } from "../../queries/reads.js";
import { COMMERCIAL_READ_ROUTES } from "../response-schemas.js";
import type { DraftActor } from "./draft-store.js";

export async function sellerOrOwner(authorizer: CommercialAuthorizer, uow: CommerceUnitOfWork, identity: IdentityFacts, what: string): Promise<DraftActor> {
  const asSeller = await authorizer.authorizeSeller(uow, { identity });
  if (asSeller.kind === "ALLOW") return { kind: "SELLER", userId: asSeller.userId as UserId, sellerId: asSeller.sellerId as SellerId };
  if (asSeller.reason !== "CORPORATE_ROLE_MISSING") throw CommerceAccessDenied.of(what, asSeller);
  const asOwner = await authorizer.authorizeCorporateOwner(uow, { identity });
  if (asOwner.kind === "DENY") throw CommerceAccessDenied.of(what, asOwner);
  return { kind: "OWNER", userId: asOwner.userId as UserId };
}

/** The read admission of an L-DRAFT read (the route's own path and action; the transport reads it before the handler runs). */
export function draftReadAdmission(id: "GetOutreachDraft" | "GetSalesResource"): ReadSpec<string> {
  const route = COMMERCIAL_READ_ROUTES[id];
  return Object.freeze({ operationId: id, method: "GET", path: route.path, action: route.action, scope: "NONE", paginated: false, summary: route.summary, authority: route.authority });
}
