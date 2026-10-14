/**
 * CONTRACT FAKE — evidence class SIMULATED. The labelled contract fake of `ObjectReadSigningPort` (ObjectStoragePort.signRead; package
 * B16 lane L5, CMD038). It is the only fake of this port (one owner, B16-L5), it lives only under the test-only subpath
 * `@kauro/application/testing`, no composition root binds it, and every URL it produces names the provider token
 * `contract-fake-signer` on the reserved `.invalid` host. The real S3 presign adapter is B15's (PARTIAL).
 *
 * What it models, because CMD038's correctness depends on it:
 * - A URL is a bearer credential bound to exactly one object generation, one requester, one authorization and one absolute expiry; the
 *   signature is an HMAC over all of them under the fake's own key, so it is deterministic (the same request signs the same URL: a re-sign
 *   of the same authorization is byte-identical) and unforgeable by changing any member.
 * - `verify(url, { userId, atMs })` answers what the provider would: VALID until the expiry for its requester, EXPIRED from the expiry on
 *   (no provider revocation exists: an issued URL keeps its lifetime), WRONG_REQUESTER for anyone else, FORGED for a URL it never signed.
 * - The object name never appears in a URL (only its digest), so a URL leaks nothing about another object.
 * - A call log (`calls`: the authorization, the requester's digest, the expiry; never the URL) and scripted faults: TIMEOUT rejects with
 *   ReadSigningTimeout (the answer was lost), UNAVAILABLE rejects with a plain Error (an internal error to the caller).
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { ReadSigningTimeout, type ObjectReadSigningPort, type SignReadRequest, type SignedRead } from "../ports/object-read-signing.js";

export const CONTRACT_FAKE_SIGNER_PROVIDER = "contract-fake-signer";
const HOST = "https://contract-fake-signer.invalid/read/";

export interface ReadSignerCall {
  readonly authorizationId: string;
  readonly requesterDigest: string;
  readonly objectDigest: string;
  readonly expiresAtMs: number;
}

export type ReadSignerFault = "TIMEOUT" | "UNAVAILABLE";
export type ReadSignerVerdict = "VALID" | "EXPIRED" | "WRONG_REQUESTER" | "FORGED";

const digest = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export class ContractFakeReadSigner implements ObjectReadSigningPort {
  readonly provider = CONTRACT_FAKE_SIGNER_PROVIDER;
  readonly evidenceClass = "SIMULATED" as const;
  readonly #key = randomBytes(32);
  readonly #calls: ReadSignerCall[] = [];
  #faults: ReadSignerFault[] = [];

  get calls(): ReadonlyArray<ReadSignerCall> {
    return [...this.#calls];
  }

  /** The next `times` calls fail with `fault` (in order, before any other script). */
  script(fault: ReadSignerFault, times = 1): void {
    for (let i = 0; i < times; i++) this.#faults.push(fault);
  }

  /** Clears the scripts (the call log and the key stay: URLs signed earlier remain verifiable). */
  reset(): void {
    this.#faults = [];
  }

  #signature(objectDigest: string, requesterDigest: string, authorizationId: string, expiresAtMs: number): string {
    return createHmac("sha256", this.#key).update(`${objectDigest}\n${requesterDigest}\n${authorizationId}\n${expiresAtMs}`, "utf8").digest("hex");
  }

  async signRead(request: SignReadRequest, _timeoutMs: number): Promise<SignedRead> {
    const fault = this.#faults.shift();
    if (fault === "TIMEOUT") throw new ReadSigningTimeout("contract-fake-signer: scripted TIMEOUT");
    if (fault === "UNAVAILABLE") throw new Error("contract-fake-signer: scripted UNAVAILABLE");
    const expiresAtMs = Date.parse(request.expiresAt);
    if (!Number.isFinite(expiresAtMs)) throw new Error("contract-fake-signer: expiresAt is not an instant");
    const objectDigest = digest(`${request.objectName}#${request.generation}`);
    const requesterDigest = digest(request.requester.userId);
    this.#calls.push({ authorizationId: request.requester.authorizationId, requesterDigest, objectDigest, expiresAtMs });
    const signature = this.#signature(objectDigest, requesterDigest, request.requester.authorizationId, expiresAtMs);
    const url = `${HOST}${objectDigest}?provider=${CONTRACT_FAKE_SIGNER_PROVIDER}&authorization=${request.requester.authorizationId}&requester=${requesterDigest}&expires=${expiresAtMs}&signature=${signature}`;
    return { url, expiresAt: request.expiresAt };
  }

  /** What the provider answers to `url` presented by `userId` at `atMs`. */
  verify(url: string, at: { readonly userId: string; readonly atMs: number }): ReadSignerVerdict {
    if (!url.startsWith(HOST)) return "FORGED";
    const parsed = new URL(url);
    const objectDigest = parsed.pathname.split("/").pop() ?? "";
    const authorizationId = parsed.searchParams.get("authorization") ?? "";
    const requesterDigest = parsed.searchParams.get("requester") ?? "";
    const expiresAtMs = Number(parsed.searchParams.get("expires"));
    if (parsed.searchParams.get("signature") !== this.#signature(objectDigest, requesterDigest, authorizationId, expiresAtMs)) return "FORGED";
    if (requesterDigest !== digest(at.userId)) return "WRONG_REQUESTER";
    return at.atMs < expiresAtMs ? "VALID" : "EXPIRED";
  }
}
