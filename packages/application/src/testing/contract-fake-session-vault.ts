/**
 * CONTRACT FAKE — evidence class SIMULATED. The labelled contract fake of `SessionVaultPort` (B07 mandate B07-PROVIDER-FAKES;
 * design D-SESSION-1, §15). The only fake of this port, reachable only through the test-only subpath `@kauro/application/testing`
 * and bound by no composition root; the real key service (a KMS-held key) is B15's.
 *
 * It seals a provider session reference with AES-256-GCM under a labelled TEST KEY (never key material of any deployment) and a
 * fresh 96-bit nonce, and binds the ciphertext to exactly one upload: the associated data is the canonical encoding of the key
 * identity and the binding — agency, upload, requester and issuance attempt (09 "Resumable session security": a bearer
 * credential stored encrypted in the temporary control record, bound to one destination). Opening under any other binding, key or
 * a tampered nonce or ciphertext fails authentication and returns no plaintext (the port: "never returns another upload's
 * plaintext"). The sealed form fits the registry row (`upload_session_secrets`: key_ref grammar, a 12-byte nonce, a ciphertext of
 * 17..8,192 bytes including the 16-byte tag).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { canonicalBytes } from "@kauro/contracts";
import { isUuid } from "@kauro/domain";
import type { ProviderEvidenceClass, SessionSecretBinding, SessionVaultPort } from "../ports/source-providers.js";

/** The provider token of the fake vault. */
export const CONTRACT_FAKE_VAULT_PROVIDER = "contract-fake-vault";
/** The key identity the fake records with every sealed secret (a name/version, never key material). */
export const CONTRACT_FAKE_VAULT_KEY_REF = "contract-fake-vault/aes-256-gcm/test-key-1";

const KEY_REF = /^[a-z][a-z0-9_.:/-]{2,127}$/;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** The registry bound of a sealed secret (ciphertext with its tag, 17..8,192 bytes): at most 8,176 plaintext bytes. */
const MAX_PLAINTEXT_BYTES = 8_192 - TAG_BYTES;

/** The `purpose` member of the associated data, so a sealed session secret can never authenticate as another kind of secret. */
export const CONTRACT_FAKE_VAULT_AAD_PURPOSE = "kauro upload session secret";

/** The labelled TEST KEY: SHA-256 of a public label, so it can never be mistaken for, or be, a deployment's key. */
function testKey(label: string): Uint8Array {
  return createHash("sha256").update(`Kauro contract-fake vault TEST KEY (SIMULATED, never a deployment key): ${label}`).digest();
}

/**
 * The labelled TEST KEY a fake vault holds under `keyRef` — public by construction (the digest of a public label), published so a
 * test can decrypt a sealed secret independently with AES-256-GCM and prove the algorithm and the associated data.
 */
export function contractFakeVaultTestKey(keyRef: string): Uint8Array {
  return new Uint8Array(testKey(keyRef));
}

export type ContractFakeVaultRefusalReason =
  /** The sealed secret names a key this vault does not hold. */
  | "UNKNOWN_KEY"
  /** A nonce or ciphertext of the wrong shape, or a binding that is not one. */
  | "MALFORMED"
  /** Authentication failed: another binding (agency, upload, requester, attempt), another key or a tampered secret. */
  | "AUTHENTICATION_FAILED"
  /** The session reference is empty or longer than the registry row can hold. */
  | "PLAINTEXT_OUT_OF_BOUNDS";

export class ContractFakeVaultRefusal extends Error {
  readonly reason: ContractFakeVaultRefusalReason;
  readonly provider = CONTRACT_FAKE_VAULT_PROVIDER;
  readonly evidenceClass: ProviderEvidenceClass = "SIMULATED";
  constructor(reason: ContractFakeVaultRefusalReason) {
    super(`${CONTRACT_FAKE_VAULT_PROVIDER} (SIMULATED): ${reason}`);
    this.name = "ContractFakeVaultRefusal";
    this.reason = reason;
  }
}

export interface ContractFakeSessionVaultOptions {
  /** The key identity (default CONTRACT_FAKE_VAULT_KEY_REF). A vault with another key ref holds another test key. */
  readonly keyRef?: string;
}

/** One vault operation as the fake recorded it (no plaintext, no ciphertext). */
export interface VaultCall {
  readonly sequence: number;
  readonly operation: "seal" | "open";
  readonly uploadId: string;
  readonly sessionAttempt: number;
  readonly outcome: "SEALED" | "OPENED" | ContractFakeVaultRefusalReason;
}

export class ContractFakeSessionVault implements SessionVaultPort {
  readonly provider = CONTRACT_FAKE_VAULT_PROVIDER;
  readonly evidenceClass: ProviderEvidenceClass = "SIMULATED";
  readonly contractFake = true;
  readonly keyRef: string;
  readonly #key: Uint8Array;
  readonly #calls: VaultCall[] = [];

  constructor(options: ContractFakeSessionVaultOptions = {}) {
    const keyRef = options.keyRef ?? CONTRACT_FAKE_VAULT_KEY_REF;
    if (!KEY_REF.test(keyRef) || !keyRef.startsWith(`${CONTRACT_FAKE_VAULT_PROVIDER}/`)) throw new RangeError(`${CONTRACT_FAKE_VAULT_PROVIDER}: a key ref of this fake starts with ${CONTRACT_FAKE_VAULT_PROVIDER}/`);
    this.keyRef = keyRef;
    this.#key = testKey(keyRef);
  }

  seal(sessionRef: string, binding: SessionSecretBinding): Promise<{ readonly keyRef: string; readonly nonce: Uint8Array; readonly ciphertext: Uint8Array }> {
    return this.#run("seal", binding, () => {
      const aad = this.#associatedData(binding);
      if (typeof sessionRef !== "string") throw new ContractFakeVaultRefusal("PLAINTEXT_OUT_OF_BOUNDS");
      const plaintext = new TextEncoder().encode(sessionRef);
      if (plaintext.length < 1 || plaintext.length > MAX_PLAINTEXT_BYTES) throw new ContractFakeVaultRefusal("PLAINTEXT_OUT_OF_BOUNDS");
      const nonce = new Uint8Array(randomBytes(NONCE_BYTES));
      const cipher = createCipheriv("aes-256-gcm", this.#key, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad);
      const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
      return { value: Object.freeze({ keyRef: this.keyRef, nonce, ciphertext: new Uint8Array(body) }), outcome: "SEALED" as const };
    });
  }

  open(sealed: { readonly keyRef: string; readonly nonce: Uint8Array; readonly ciphertext: Uint8Array }, binding: SessionSecretBinding): Promise<string> {
    return this.#run("open", binding, () => {
      const aad = this.#associatedData(binding);
      if (sealed.keyRef !== this.keyRef) throw new ContractFakeVaultRefusal("UNKNOWN_KEY");
      if (!(sealed.nonce instanceof Uint8Array) || sealed.nonce.length !== NONCE_BYTES) throw new ContractFakeVaultRefusal("MALFORMED");
      if (!(sealed.ciphertext instanceof Uint8Array) || sealed.ciphertext.length <= TAG_BYTES || sealed.ciphertext.length > MAX_PLAINTEXT_BYTES + TAG_BYTES) throw new ContractFakeVaultRefusal("MALFORMED");
      const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES);
      const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES);
      let plaintext: Buffer;
      try {
        const decipher = createDecipheriv("aes-256-gcm", this.#key, sealed.nonce, { authTagLength: TAG_BYTES });
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
      } catch {
        throw new ContractFakeVaultRefusal("AUTHENTICATION_FAILED");
      }
      return { value: plaintext.toString("utf8"), outcome: "OPENED" as const };
    });
  }

  /** The vault operations so far, in order (no plaintext, no ciphertext). */
  calls(): ReadonlyArray<VaultCall> {
    return this.#calls.map((c) => Object.freeze({ ...c }));
  }

  async #run<T>(operation: "seal" | "open", binding: SessionSecretBinding, effect: () => { readonly value: T; readonly outcome: "SEALED" | "OPENED" }): Promise<T> {
    const uploadId = typeof binding?.uploadId === "string" ? binding.uploadId : "";
    const sessionAttempt = typeof binding?.sessionAttempt === "number" ? binding.sessionAttempt : 0;
    try {
      const { value, outcome } = effect();
      this.#calls.push({ sequence: this.#calls.length + 1, operation, uploadId, sessionAttempt, outcome });
      return value;
    } catch (error) {
      if (error instanceof ContractFakeVaultRefusal) this.#calls.push({ sequence: this.#calls.length + 1, operation, uploadId, sessionAttempt, outcome: error.reason });
      throw error;
    }
  }

  /** The associated data: the canonical encoding of the key identity and the whole binding (a changed member fails authentication). */
  #associatedData(binding: SessionSecretBinding): Uint8Array {
    if (binding === null || typeof binding !== "object") throw new ContractFakeVaultRefusal("MALFORMED");
    const { agencyId, uploadId, requestedByUserId, sessionAttempt } = binding;
    if (!isUuid(agencyId) || !isUuid(uploadId) || !isUuid(requestedByUserId) || !Number.isSafeInteger(sessionAttempt) || sessionAttempt < 1) {
      throw new ContractFakeVaultRefusal("MALFORMED");
    }
    return canonicalBytes({ purpose: CONTRACT_FAKE_VAULT_AAD_PURPOSE, keyRef: this.keyRef, agencyId, uploadId, requestedByUserId, sessionAttempt });
  }
}
