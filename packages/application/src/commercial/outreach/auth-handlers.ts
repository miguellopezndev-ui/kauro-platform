/**
 * The handlers of lane L-AUTH (plan docs/design/B12-outreach-plan.md §9): CMD062, PrepareOutreachReview, RevokeOutreachAuthorization and
 * WithdrawOutreachChannelPolicy, and the read GetOutreachReview. The api composition replaces the NOT_BUILT stubs of these five ids by
 * these handlers (createOutreachStubCommandHandlers / createOutreachStubReadHandlers keep every other B12 id).
 */
import type { AuthorizeOutreachBody, PrepareOutreachReviewBody, RevokeOutreachAuthorizationBody, WithdrawOutreachChannelPolicyBody } from "../contracts.js";
import type { CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import type { CommercialCommandHandler } from "../agency/runtime.js";
import type { CommercialReadHandler } from "../statements/get-statement.js";
import type { OutreachAuthorizationView, OutreachChannelPolicyView, OutreachReviewView } from "../views.js";
import type { OutreachAuthCollaborators } from "./auth-store.js";
import { authorizeHandler } from "./authorize.js";
import { getReviewHandler } from "./get-review.js";
import { prepareReviewHandler } from "./prepare-review.js";
import { revokeAuthorizationHandler } from "./revoke-authorization.js";
import { withdrawPolicyHandler } from "./withdraw-policy.js";

export interface OutreachAuthCommandHandlers {
  readonly CMD062: CommercialCommandHandler<AuthorizeOutreachBody, OutreachAuthorizationView>;
  readonly PrepareOutreachReview: CommercialCommandHandler<PrepareOutreachReviewBody, OutreachReviewView>;
  readonly RevokeOutreachAuthorization: CommercialCommandHandler<RevokeOutreachAuthorizationBody, OutreachAuthorizationView>;
  readonly WithdrawOutreachChannelPolicy: CommercialCommandHandler<WithdrawOutreachChannelPolicyBody, OutreachChannelPolicyView>;
}

export function createOutreachAuthCommandHandlers(runtime: CommerceRequestRuntime, co: OutreachAuthCollaborators): OutreachAuthCommandHandlers {
  return Object.freeze({
    CMD062: authorizeHandler(runtime, co),
    PrepareOutreachReview: prepareReviewHandler(runtime, co),
    RevokeOutreachAuthorization: revokeAuthorizationHandler(runtime, co),
    WithdrawOutreachChannelPolicy: withdrawPolicyHandler(runtime, co),
  });
}

export function createOutreachAuthReadHandlers(runtime: CommerceRequestRuntime, co: OutreachAuthCollaborators): { readonly GetOutreachReview: CommercialReadHandler<OutreachReviewView> } {
  return Object.freeze({ GetOutreachReview: getReviewHandler(runtime, co) });
}
