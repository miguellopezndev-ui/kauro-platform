/**
 * The L-DRAFT handlers of package B12 as the composition binds them (lane L-DRAFT; plan docs/design/B12-outreach-plan.md section 9): the
 * five that replace the NOT_BUILT stubs of routes.ts. A deployment spreads them over `createOutreachStubCommandHandlers()` and
 * `createOutreachStubReadHandlers()`, so every other lane's route stays a stub until that lane lands.
 */
import type { CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import type { CommercialCommandHandler } from "../agency/runtime.js";
import type { CommercialReadHandler } from "../statements/get-statement.js";
import { getDraftHandler } from "./get-draft.js";
import { prepareDraftHandler } from "./prepare-draft.js";
import { publishResourceHandler } from "./publish-resource.js";
import { putContentHandler } from "./put-content.js";
import { getSalesResourceHandler } from "./resources.js";
import type { OutreachDraftCollaborators } from "./draft-store.js";

export function createOutreachDraftCommandHandlers(runtime: CommerceRequestRuntime, co: OutreachDraftCollaborators) {
  return {
    CMD061: prepareDraftHandler(runtime, co),
    PutOutreachContent: putContentHandler(runtime, co),
    PublishSalesResource: publishResourceHandler(runtime, co),
  } as unknown as {
    readonly CMD061: CommercialCommandHandler<unknown, unknown>;
    readonly PutOutreachContent: CommercialCommandHandler<unknown, unknown>;
    readonly PublishSalesResource: CommercialCommandHandler<unknown, unknown>;
  };
}

export function createOutreachDraftReadHandlers(runtime: CommerceRequestRuntime, co: OutreachDraftCollaborators) {
  return {
    GetOutreachDraft: getDraftHandler(runtime, co),
    GetSalesResource: getSalesResourceHandler(runtime, co),
  } as unknown as {
    readonly GetOutreachDraft: CommercialReadHandler<unknown>;
    readonly GetSalesResource: CommercialReadHandler<unknown>;
  };
}

export type { OutreachDraftCollaborators, OutreachDraftStore } from "./draft-store.js";
