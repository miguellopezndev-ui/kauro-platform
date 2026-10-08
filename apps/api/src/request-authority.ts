/**
 * The transport's RequestAuthority (FAILURE-MATRIX-TEMPLATE rule 16; Codex r3 PV1R-02, PV1R-07): an effect a request's credential
 * authorizes judges it under the lock its revocation conflicts with. `hold` locks the cookie session's row (the authenticator's
 * holdRequest: SELECT ... FOR UPDATE, then the instant, then the touch) and keeps the lock until `release`, which the route calls once the
 * request's work returned (its view built, its unit committed or rolled back). A bearer credential has no row: it is verified again as it
 * stands. Nothing is held until an effect asks for it.
 */
import type { CredentialHold, RequestAuthority } from "@kauro/application";
import { authenticationOf, type AuthenticationRequest, type Authenticator } from "./authenticator.js";

export interface RequestAuthorityHandle {
  readonly authority: RequestAuthority;
  /** Ends every hold this request took (a failure to end one is reported to `sink`: the row lock ends with its transaction anyway). */
  release(): Promise<void>;
}

export function requestAuthorityOf(authenticator: Authenticator, request: AuthenticationRequest, userId: string, sink: (error: unknown) => void): RequestAuthorityHandle {
  const releases: Array<() => Promise<void>> = [];
  const authority: RequestAuthority = {
    async hold(): Promise<CredentialHold | null> {
      if (authenticator.holdRequest !== undefined) {
        const held = await authenticator.holdRequest(request);
        if (held === null) return null;
        releases.push(held.release);
        return held.userId === userId ? { liveAt: (nowMs) => held.liveAt(nowMs) } : null;
      }
      const again = await authenticationOf(authenticator, request);
      return again.kind === "SUBJECT" && again.subject.identity.userId === userId ? { liveAt: () => true } : null;
    },
  };
  return {
    authority,
    async release() {
      for (const release of releases.splice(0)) {
        try {
          await release();
        } catch (error) {
          sink(error);
        }
      }
    },
  };
}
