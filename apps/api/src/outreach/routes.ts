/**
 * The served handlers of lane L-SEND (package B12; plan docs/design/B12-outreach-plan.md §9): CMD063 SendAuthorizedOutreach and the three
 * sender-identity routes (companion §R rows B12-9..B12-11), bound over the same commerce runtime as every commercial command. The composition
 * spreads them over the K2 kit's NOT_BUILT stubs, so the route table and the admission specs stay the kit's. The sealer is the deployment's
 * (compliance configuration, opt-out key): until it is bound every CMD063 answers OUTREACH_COMPLIANCE_UNCONFIGURED (A13), never a send.
 */
import {
  recordSenderRevocationHandler,
  registerSenderIdentityHandler,
  sendHandler,
  verifySenderIdentityHandler,
  type AssuranceVerifier,
  type CommercialAuthorizer,
  type CommerceRequestRuntime,
  type OutreachSealer,
  type SendSealFacts,
} from "@kauro/application";
import { outreachSendOf, outreachSendersOf } from "@kauro/persistence";
import { buildOutreachMime, payloadHashOf, type OptOutKey, type OutreachCompliance } from "./mime.js";

/** The sealer of a deployment: the sha256 of the exact message the dispatcher will submit; null while the configuration is absent. */
export function outreachSealerOf(config: { readonly compliance: OutreachCompliance | null; readonly optOutKey: OptOutKey | null }): OutreachSealer {
  return {
    seal(facts: SendSealFacts): string | null {
      if (config.compliance === null || config.optOutKey === null) return null;
      return payloadHashOf(buildOutreachMime(facts, config.compliance, config.optOutKey));
    },
  };
}

export function createSendLaneHandlers(runtime: CommerceRequestRuntime, deps: { readonly authorizer: CommercialAuthorizer; readonly assurance: AssuranceVerifier; readonly sealer: OutreachSealer }) {
  const sends = { authorizer: deps.authorizer, sends: outreachSendOf, sealer: deps.sealer };
  const senders = { authorizer: deps.authorizer, senders: outreachSendersOf, assurance: deps.assurance };
  return {
    CMD063: sendHandler(runtime, sends),
    RegisterSenderIdentity: registerSenderIdentityHandler(runtime, senders),
    VerifySenderIdentity: verifySenderIdentityHandler(runtime, senders),
    RecordSenderRevocation: recordSenderRevocationHandler(runtime, senders),
  };
}
