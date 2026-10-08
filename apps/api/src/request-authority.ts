/**
 * The transport's RequestAuthority (FAILURE-MATRIX-TEMPLATE rule 16; Codex r4 PV1R-07, docs/review/pv1-route-pv1r07-design.md): an effect a
 * request's credential authorizes judges it under the lock its revocation conflicts with. `hold(uow)` locks the cookie session's row FOR SHARE
 * inside the unit of work that commits the effect (or builds the view) and returns the row as the locking statement returned it; that unit's
 * COMMIT is the release, so there is nothing to release, no sink and no per-request cache (a second hold in one unit re-locks in the same
 * transaction: PostgreSQL never makes a transaction wait on its own lock). A bearer credential has no row: it is verified again as it stands.
 */
import type { CredentialHold, RequestAuthority } from "@kauro/application";
import { authenticationOf, type AuthenticationRequest, type Authenticator } from "./authenticator.js";

export function requestAuthorityOf(authenticator: Authenticator, request: AuthenticationRequest, userId: string): RequestAuthority {
  return {
    async hold(uow): Promise<CredentialHold | null> {
      if (authenticator.holdRequest !== undefined) {
        const held = await authenticator.holdRequest(request, uow, userId);
        if (held === null) return null;
        return held.userId === userId ? { liveAt: (nowMs) => held.liveAt(nowMs) } : null;
      }
      const again = await authenticationOf(authenticator, request);
      return again.kind === "SUBJECT" && again.subject.identity.userId === userId ? { liveAt: () => true } : null;
    },
  };
}
