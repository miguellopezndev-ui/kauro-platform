// The session routes of the browser edge (design D-AUTH-4), as the browser calls them: the generated operations of the api's own contract
// (openSession, getCurrentSession, revokeCurrentSession; D-GEN-1). W3 first declared them here as planned descriptors because W2 had not
// served them yet; the stage-1 integration replaced those with the generated ones (design §12 D-W3-1, D-INT1-5), so the reply of every
// call is checked against the schema the api validates it with. Every call goes through the same ApiClient as any other operation, so the
// request envelope, the no-store rule and the four-way answer classification are not repeated.
import type { getCurrentSessionResponse200 } from "../api/generated.ts";
import type { ApiAnswer } from "./answer.ts";
import type { ApiClient } from "./api-client.ts";
import type { IdentityCredential } from "./identity/port.ts";

/**
 * What `GET /api/v1/sessions/current` answers, and `POST /api/v1/sessions` too (D-AUTH-4; the generated SessionView of both replies).
 * The CSRF token is the only secret in it and never leaves the runtime.
 */
export type SessionView = getCurrentSessionResponse200;

/** The session as the rest of the page may see it: no token. */
export type SessionSummary = Omit<SessionView, "csrfToken">;

/** The two session calls the page makes. The runtime depends on this shape, so a test can stand in for the api without a network. */
export interface SessionApi {
  current(): Promise<ApiAnswer<SessionView>>;
  revoke(): Promise<ApiAnswer<undefined>>;
}

/**
 * Exchanges a provider credential for a session (D-AUTH-4): the credential's token is taken here, sent once, and not kept. A person
 * signs in on a page that is then replaced by a new document, so the runtime of the sign-in page reads no session back from this call.
 */
export function createSession(client: ApiClient, credential: IdentityCredential): Promise<ApiAnswer<SessionView>> {
  if (credential.purpose !== "SESSION") throw new RangeError("only a sign-in credential opens a session");
  return client.call("openSession", { body: { idToken: credential.takeToken() } });
}

export function sessionApi(client: ApiClient): SessionApi {
  return {
    current: () => client.call("getCurrentSession", {}),
    // the logout answers 204 without a body: nothing to read back
    revoke: () => client.call("revokeCurrentSession", {}) as Promise<ApiAnswer<undefined>>,
  };
}
