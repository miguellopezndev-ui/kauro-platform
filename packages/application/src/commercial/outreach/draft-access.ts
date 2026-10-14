/**
 * The access decisions of the L-DRAFT commands (plan §L: L1 is the seller's or the owner's transition lock, taken by the authorizer before
 * the journal reservation L2). A person without an ACTIVE seller row may still be the corporate owner; any other refusal is the seller
 * check's own (the shape of CMD045).
 */
import type { SellerId, UserId } from "@kauro/domain";
import { CommerceAccessDenied } from "../../commerce/request/runtime.js";
import type { CommerceUnitOfWork, IdentityFacts } from "@kauro/domain";
import type { CommercialAuthorizer } from "../authorizer.js";
import type { DraftActor } from "./draft-store.js";

export async function sellerOrOwner(authorizer: CommercialAuthorizer, uow: CommerceUnitOfWork, identity: IdentityFacts, what: string): Promise<DraftActor> {
  const asSeller = await authorizer.authorizeSeller(uow, { identity });
  if (asSeller.kind === "ALLOW") return { kind: "SELLER", userId: asSeller.userId as UserId, sellerId: asSeller.sellerId as SellerId };
  if (asSeller.reason !== "CORPORATE_ROLE_MISSING") throw CommerceAccessDenied.of(what, asSeller);
  const asOwner = await authorizer.authorizeCorporateOwner(uow, { identity });
  if (asOwner.kind === "DENY") throw CommerceAccessDenied.of(what, asOwner);
  return { kind: "OWNER", userId: asOwner.userId as UserId };
}
