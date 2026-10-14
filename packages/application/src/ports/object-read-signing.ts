/**
 * ObjectStoragePort.signRead (package B16 lane L5, CMD038 AuthorizeDownload; .kauro plan B16-REST-PLAN "CMD038"): the one provider call
 * that turns a committed download authorization into short-lived read URLs. It is the read-signing half of the object storage port, a
 * port of its own so that the upload/hold/inventory half (source-providers.ts, B07) and its implementers are unchanged; B15's S3 adapter
 * implements both halves on one object (S3 presigned GetObject, PARTIAL(B15)).
 *
 * Rules the caller (the CMD038 handler) relies on:
 *   - it is called only AFTER the authorization's COMMIT, never inside a transaction; the committed authorization fixes the scope (the
 *     exact object generations) and the expiry, and a re-sign of the same authorization passes exactly the same request, so a retry can
 *     never broaden what was granted;
 *   - the URL is bound to the requester (`requester.userId`) and to the authorization: two people never receive the same URL for the
 *     same object, so a shared cache cannot hand one person's URL to another;
 *   - `expiresAt` is an absolute instant the provider enforces; a signed URL cannot be revoked at the provider before it (R2-048: new
 *     grants stop immediately, an issued URL keeps its disclosed residual lifetime);
 *   - a call that does not answer within `timeoutMs` rejects with ReadSigningTimeout: the caller records the authorization
 *     ISSUE_UNCERTAIN and a retry with the same key re-signs; any other rejection is an internal error.
 */
import type { ProviderEvidenceClass } from "./source-providers.js";

/** One object generation to sign for reading. */
export interface SignReadRequest {
  /** The registered DELIVERY object name and its exact generation (registry stored_objects). */
  readonly objectName: string;
  readonly generation: string;
  /** The absolute expiry of the URL, an exact ISO-8601 UTC instant (the authorization's stored expires_at). */
  readonly expiresAt: string;
  /** Who the URL is for: the person and the committed authorization (the URL is bound to both). */
  readonly requester: { readonly userId: string; readonly authorizationId: string };
}

export interface SignedRead {
  /** The bearer URL; a secret, never journaled, never logged. */
  readonly url: string;
  /** The provider-enforced expiry (equal to the request's). */
  readonly expiresAt: string;
}

export interface ObjectReadSigningPort {
  readonly provider: string;
  readonly evidenceClass: ProviderEvidenceClass;
  signRead(request: SignReadRequest, timeoutMs: number): Promise<SignedRead>;
}

/** The signer did not answer within its bound: whether a URL was produced is unknown (the authorization is ISSUE_UNCERTAIN). */
export class ReadSigningTimeout extends Error {
  constructor(message = "the read signer did not answer within its bound") {
    super(message);
    this.name = "ReadSigningTimeout";
  }
}

/** The bound on one signRead call (ms): a presign is a local computation for S3; the bound covers a remote signer. */
export const READ_SIGNING_TIMEOUT_MS = 5_000;

/** The longest lifetime of one download authorization and of its URLs (seconds; registry CMD038 "short-lived"). */
export const DOWNLOAD_URL_MAX_LIFETIME_SECONDS = 900;
