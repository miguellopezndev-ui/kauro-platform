import { verify as verifySignature } from 'node:crypto';
import { canonicalJsonText, compareCodeUnits, parseJson } from '../util/json.js';
import type { JsonObject, JsonValue } from '../util/json.js';
import { validateAgainstSchema } from '../mapping/schema-validator.js';
import type { Schema } from '../mapping/schema-validator.js';
import { MigrationError } from '../domain/errors.js';
import type { TargetMode } from '../domain/config.js';

/**
 * Who says this target contract describes that instance.
 *
 * A property export proves what properties exist. It does not prove which
 * portal it came from — this repository already attributed one export to the
 * wrong portal, and nothing in the artifact would ever have revealed it,
 * because the fact was not in the bytes. The instance a contract belongs to is
 * therefore a separate claim, made by somebody who can make it, and signed.
 *
 * The word that matters is *external*. A signature the run produced, verified
 * with a key that travelled beside the artifact it signs, proves that a file
 * was not corrupted in transit and nothing else at all — the same party wrote
 * the claim, wrote the key and checked the result. So this module never reads a
 * key out of an attestation, a package or a contract. Key material arrives as a
 * separate argument, from the host, and an issuer the host did not name is
 * refused however well-formed its signature.
 *
 * Everything here is offline and free of the clock. Freshness is judged against
 * an instant the caller passes in, because a core whose decisions depend on when
 * it happened to run is not deterministic and cannot be replayed.
 */

export const ATTESTATION_CONTRACT_VERSION = '1.0.0';

/** The only algorithm V1 accepts. Named so a future one is a versioned change rather than a surprise. */
export const ATTESTATION_ALGORITHM = 'ed25519';

export interface AttestationArtifactRef {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface TargetAttestation {
  readonly attestationVersion: string;
  readonly issuer: {
    /** Stable identity of the party making the claim, as the host knows them. */
    readonly id: string;
    readonly name: string;
    /** Which of that issuer's keys signed this. An issuer may hold more than one. */
    readonly keyId: string;
  };
  readonly subject: {
    readonly mode: TargetMode;
    readonly instanceId: string;
    readonly instanceLabel: string;
  };
  /** The captured artifacts this attestation covers, by digest. */
  readonly artifacts: readonly AttestationArtifactRef[];
  /** The contract those artifacts were parsed into. */
  readonly contractHash: string;
  readonly schemaVersion: string;
  readonly toolVersion: string;
  readonly capturedAt: string;
  readonly expiresAt: string;
  /** Binds the attestation to one run where the host asks for that. */
  readonly nonce: string | null;
  readonly signature: {
    readonly algorithm: string;
    /** Base64 over the canonical bytes of everything above. */
    readonly value: string;
  };
}

/**
 * An issuer the host is willing to believe, and the key material to check them
 * with.
 *
 * Supplied by the host, never by the package. This is the whole difference
 * between an attestation and a decorated assertion.
 */
export interface AttestationAuthority {
  readonly issuerId: string;
  readonly keyId: string;
  readonly algorithm: string;
  /** PEM-encoded public key. The core holds no private key and signs nothing. */
  readonly publicKeyPem: string;
}

export interface AttestationExpectation {
  readonly mode: TargetMode;
  readonly instanceId: string;
  readonly contractHash: string;
  readonly artifacts: readonly { readonly path: string; readonly sha256: string }[];
  /**
   * The instant freshness is judged against, in ISO 8601. Passed in rather than
   * read from the clock, so that verifying the same package twice gives the same
   * answer and a replay can be checked.
   */
  readonly at: string;
  readonly nonce?: string | null;
}

export interface AttestationVerification {
  readonly ok: boolean;
  /** Every reason it failed, not the first. A caller fixing one should see them all. */
  readonly reasons: readonly string[];
  readonly issuerId: string | null;
  readonly keyId: string | null;
}

export interface VerifyAttestationInput {
  readonly attestation: TargetAttestation | null;
  readonly publicKeys: readonly AttestationAuthority[];
  readonly expect?: AttestationExpectation | null;
}

/**
 * The bytes an issuer signs.
 *
 * Everything the attestation asserts, in canonical form, with the signature
 * itself removed — a signature cannot cover itself. Artifacts are ordered by
 * path so that two issuers listing the same artifacts in a different order
 * produce the same bytes and the same signature.
 */
export function attestationSigningBytes(attestation: TargetAttestation): string {
  const payload: JsonObject = {
    attestationVersion: attestation.attestationVersion,
    issuer: {
      id: attestation.issuer.id,
      name: attestation.issuer.name,
      keyId: attestation.issuer.keyId,
    },
    subject: {
      mode: attestation.subject.mode,
      instanceId: attestation.subject.instanceId,
      instanceLabel: attestation.subject.instanceLabel,
    },
    artifacts: [...attestation.artifacts]
      .sort((a, b) => compareCodeUnits(a.path, b.path))
      .map((artifact) => ({
        path: artifact.path,
        sha256: artifact.sha256,
        byteLength: artifact.byteLength,
      })),
    contractHash: attestation.contractHash,
    schemaVersion: attestation.schemaVersion,
    toolVersion: attestation.toolVersion,
    capturedAt: attestation.capturedAt,
    expiresAt: attestation.expiresAt,
    nonce: attestation.nonce,
  };
  return canonicalJsonText(payload);
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u.test(value);
}

/**
 * Verify an attestation, offline, against key material the host supplied.
 *
 * Fails closed on every path. There is no "probably fine": an attestation that
 * is absent, malformed, unsigned, signed by an issuer nobody named, signed with
 * a key that does not verify, about another instance, about another contract,
 * about artifacts that are not the ones in hand, expired, or carrying the wrong
 * nonce, is refused. Nothing here returns a warning.
 */
export function verifyAttestation(input: VerifyAttestationInput): AttestationVerification {
  const reasons: string[] = [];
  const attestation = input.attestation;

  if (attestation === null || typeof attestation !== 'object') {
    return {
      ok: false,
      reasons: ['no attestation was supplied, and an unattested target instance is not an attested one'],
      issuerId: null,
      keyId: null,
    };
  }

  if (attestation.attestationVersion !== ATTESTATION_CONTRACT_VERSION) {
    reasons.push(
      `the attestation declares version ${String(attestation.attestationVersion)} and this core verifies ${ATTESTATION_CONTRACT_VERSION}`,
    );
  }

  const issuerId = attestation.issuer?.id ?? null;
  const keyId = attestation.issuer?.keyId ?? null;
  if (typeof issuerId !== 'string' || issuerId.length === 0) {
    reasons.push('the attestation names no issuer');
  }
  if (typeof keyId !== 'string' || keyId.length === 0) {
    reasons.push('the attestation names no signing key');
  }

  const signature = attestation.signature;
  if (signature === undefined || signature === null || typeof signature.value !== 'string') {
    reasons.push('the attestation carries no signature');
  } else if (signature.algorithm !== ATTESTATION_ALGORITHM) {
    reasons.push(
      `the attestation is signed with ${String(signature.algorithm)} and this core verifies ${ATTESTATION_ALGORITHM}`,
    );
  }

  // The authority list is the host's, and an issuer that is not on it is not an
  // authority however well-formed its signature. This is the check that makes
  // the attestation external rather than self-issued.
  const authority =
    input.publicKeys.find(
      (candidate) => candidate.issuerId === issuerId && candidate.keyId === keyId,
    ) ?? null;
  if (authority === null) {
    reasons.push(
      `no key material was supplied for issuer "${String(issuerId)}" key "${String(keyId)}", so nothing here is authorised to make this claim`,
    );
  } else if (authority.algorithm !== ATTESTATION_ALGORITHM) {
    reasons.push(`the supplied key for "${String(issuerId)}" is not an ${ATTESTATION_ALGORITHM} key`);
  }

  if (authority !== null && signature !== undefined && signature !== null && typeof signature.value === 'string') {
    let verified = false;
    try {
      verified = verifySignature(
        null,
        Buffer.from(attestationSigningBytes(attestation), 'utf8'),
        authority.publicKeyPem,
        Buffer.from(signature.value, 'base64'),
      );
    } catch (error) {
      reasons.push(`the signature could not be checked: ${String((error as Error).message)}`);
    }
    if (!verified && reasons.every((reason) => !reason.startsWith('the signature could not be checked'))) {
      reasons.push('the signature does not verify against the key the host supplied for this issuer');
    }
  }

  if (!isIsoInstant(attestation.capturedAt)) reasons.push('the attestation does not say when it was captured');
  if (!isIsoInstant(attestation.expiresAt)) reasons.push('the attestation does not say when it expires');

  const expect = input.expect ?? null;
  if (expect !== null) {
    if (!isIsoInstant(expect.at)) {
      reasons.push('freshness was not given an instant to judge against');
    } else if (isIsoInstant(attestation.expiresAt) && attestation.expiresAt <= expect.at) {
      reasons.push(`the attestation expired at ${attestation.expiresAt}, before ${expect.at}`);
    }

    if (attestation.subject?.mode !== expect.mode || attestation.subject?.instanceId !== expect.instanceId) {
      reasons.push(
        `the attestation is about ${String(attestation.subject?.mode)} instance ${String(attestation.subject?.instanceId)}, and this run addresses ${expect.mode} instance ${expect.instanceId}`,
      );
    }

    if (attestation.contractHash !== expect.contractHash) {
      reasons.push('the attestation covers a different target contract than the one this run was given');
    }

    // Every artifact in hand must be covered, and by the same digest. An
    // attestation that covers a subset is an attestation about something else.
    const covered = new Map(attestation.artifacts?.map((artifact) => [artifact.path, artifact.sha256]) ?? []);
    for (const artifact of expect.artifacts) {
      const attested = covered.get(artifact.path);
      if (attested === undefined) {
        reasons.push(`the attestation does not cover the captured artifact "${artifact.path}"`);
      } else if (attested !== artifact.sha256) {
        reasons.push(`the attestation covers a different "${artifact.path}" than the one in hand`);
      }
    }

    const wantedNonce = expect.nonce ?? null;
    if (wantedNonce !== null && attestation.nonce !== wantedNonce) {
      reasons.push('the attestation is not bound to this run');
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    issuerId: typeof issuerId === 'string' ? issuerId : null,
    keyId: typeof keyId === 'string' ? keyId : null,
  };
}

// ---------------------------------------------------------------------------
// Reading an attestation, and reading the issuers a deployment accepts
// ---------------------------------------------------------------------------
//
// These did not exist until an attestation became something an operator has to
// supply. MC-1 built the verifier and the tests constructed attestations in
// memory, so nothing ever had to read one off disk — which was fine while the
// policy defaulted to NOT_REQUIRED and no real run needed one. Making the CRM
// modes REQUIRED without a way to hand the evidence over would have made every
// HubSpot and Salesforce migration impossible to run rather than safe to run.
//
// Both are closed schemas and both fail closed. A key is read from the issuer
// file the host names and never from the attestation, which is the separation
// the whole module exists to enforce: an attestation that carried its own key
// would prove that whoever wrote the claim also wrote the key.

const ISO_INSTANT = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$';
const SHA256_HEX = '^[0-9a-f]{64}$';

export const TARGET_ATTESTATION_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'attestationVersion',
    'issuer',
    'subject',
    'artifacts',
    'contractHash',
    'schemaVersion',
    'toolVersion',
    'capturedAt',
    'expiresAt',
    'nonce',
    'signature',
  ],
  properties: {
    attestationVersion: {
      type: 'string',
      enum: [ATTESTATION_CONTRACT_VERSION],
      description: 'The shape this reader understands. A later one is refused rather than partly read.',
    },
    issuer: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'name', 'keyId'],
      properties: {
        id: { type: 'string', minLength: 1, description: 'Stable identity of the party making the claim, as the host knows them.' },
        name: { type: 'string', minLength: 1 },
        keyId: { type: 'string', minLength: 1, description: 'Which of that issuer’s keys signed this. An issuer may hold more than one.' },
      },
    },
    subject: {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'instanceId', 'instanceLabel'],
      properties: {
        mode: { type: 'string', enum: ['HUBSPOT', 'SALESFORCE'], description: 'CLEAN_ONLY addresses no instance, so no attestation names it.' },
        instanceId: { type: 'string', minLength: 1 },
        instanceLabel: { type: 'string', minLength: 1 },
      },
    },
    artifacts: {
      type: 'array',
      description: 'The captured artifacts this attestation covers, by digest.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'sha256', 'byteLength'],
        properties: {
          path: { type: 'string', minLength: 1 },
          sha256: { type: 'string', pattern: SHA256_HEX },
          byteLength: { type: 'integer', minimum: 0 },
        },
      },
    },
    contractHash: { type: 'string', minLength: 1, description: 'The contract those artifacts were parsed into.' },
    schemaVersion: { type: 'string', minLength: 1 },
    toolVersion: { type: 'string', minLength: 1 },
    capturedAt: { type: 'string', pattern: ISO_INSTANT },
    expiresAt: { type: 'string', pattern: ISO_INSTANT },
    // Written as a branch rather than a nullable type because the validator has
    // no nullable: a value is one shape or another, and saying so explicitly
    // also says that an absent nonce is `null` and not a missing key.
    nonce: {
      anyOf: [
        { type: 'string', minLength: 1, description: 'Binds the attestation to one run where the host asks for that.' },
        { type: 'null', description: 'No nonce. The attestation is about the instance, not about one run.' },
      ],
    },
    signature: {
      type: 'object',
      additionalProperties: false,
      required: ['algorithm', 'value'],
      properties: {
        algorithm: { type: 'string', enum: [ATTESTATION_ALGORITHM] },
        value: { type: 'string', minLength: 1, description: 'Base64 over the canonical bytes of everything above.' },
      },
    },
  },
};

export const ATTESTATION_AUTHORITIES_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['authorities'],
  properties: {
    authorities: {
      type: 'array',
      minItems: 1,
      description: 'The issuers this deployment is willing to believe. An empty list would accept nobody, which is a configuration mistake rather than a policy.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issuerId', 'keyId', 'algorithm', 'publicKeyPem'],
        properties: {
          issuerId: { type: 'string', minLength: 1 },
          keyId: { type: 'string', minLength: 1 },
          algorithm: { type: 'string', enum: [ATTESTATION_ALGORITHM] },
          publicKeyPem: {
            type: 'string',
            pattern: '^-----BEGIN PUBLIC KEY-----',
            description: 'A public key, and only ever a public key. The core holds no private key and signs nothing.',
          },
        },
      },
    },
  },
};

function readJsonDocument(text: string, origin: string, what: string): JsonValue {
  try {
    return parseJson(text);
  } catch (error) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `${origin} is not well-formed JSON: ${error instanceof Error ? error.message : String(error)}`,
      `Correct the file. Nothing is read from ${what} that does not parse.`,
      { origin },
    );
  }
}

function refuseViolations(violations: readonly { pointer: string; message: string }[], origin: string, what: string): void {
  if (violations.length === 0) return;
  throw new MigrationError(
    'CONFIG_INVALID',
    `${origin} does not match the ${what} schema`,
    'Correct each listed pointer. The schema is closed, so an unknown key is rejected rather than ignored.',
    {
      origin,
      violations: violations.map((violation) => ({
        pointer: violation.pointer === '' ? '/' : violation.pointer,
        message: violation.message,
      })),
    },
  );
}

/** Reads an attestation off disk. Refuses anything it cannot read completely. */
export function parseTargetAttestation(text: string, origin = 'attestation.json'): TargetAttestation {
  const parsed = readJsonDocument(text, origin, 'an attestation');
  refuseViolations(validateAgainstSchema(parsed, TARGET_ATTESTATION_SCHEMA), origin, 'target attestation');
  // The schema is closed and every field is required, so the shape is settled by
  // the time this returns. Nothing is defaulted: an attestation with a field
  // missing is not an attestation with that field empty.
  return parsed as unknown as TargetAttestation;
}

/**
 * Reads the issuers a deployment accepts.
 *
 * Separate from the attestation on purpose, and worth saying once more here
 * because this is the file an operator will open: if these keys travelled with
 * the attestation, verifying the signature would establish only that one party
 * wrote both. The deployment says who it trusts. The attestation says only who
 * it claims to be.
 */
export function parseAttestationAuthorities(text: string, origin = 'issuers.json'): readonly AttestationAuthority[] {
  const parsed = readJsonDocument(text, origin, 'an issuer list');
  refuseViolations(validateAgainstSchema(parsed, ATTESTATION_AUTHORITIES_SCHEMA), origin, 'attestation issuer');
  return (parsed as unknown as { authorities: readonly AttestationAuthority[] }).authorities;
}
