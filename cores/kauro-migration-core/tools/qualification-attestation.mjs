/**
 * A genuine attestation for an offline harness.
 *
 * Making attestation REQUIRED by default for the CRM modes has a blast radius,
 * and this is it: every HUBSPOT or SALESFORCE run in this repository — the
 * architecture gate's derivations, the capacity profiles, the acceptance
 * builders — now has to present a target contract and somebody's signature over
 * it. That is the correct consequence rather than an inconvenience to work
 * around. A default that every internal caller bypasses is not a default.
 *
 * So the harnesses attest for real. The key pair is generated here, the
 * signature is a real Ed25519 signature over the canonical bytes of everything
 * the attestation asserts, and the run verifies it exactly as it would verify an
 * agency's. Nothing here weakens the check; what it does is stop the harnesses
 * being the reason to weaken it.
 *
 * What this is NOT, said plainly because the distinction is the entire subject
 * of the seam: this contract describes no real instance. Its instance id says so
 * in words, and the vendor gates build their contracts from captured artifacts
 * against a real portal or org. An offline harness proving the engine refuses an
 * unattested run is a different claim from a capture proving which instance a
 * property export came from, and neither may be presented as the other.
 */
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';

const { hashTargetContract } = await import(new URL('../dist/src/target/contract.js', import.meta.url).href);
const { ATTESTATION_ALGORITHM, ATTESTATION_CONTRACT_VERSION, attestationSigningBytes } = await import(
  new URL('../dist/src/target/attestation.js', import.meta.url).href
);
const { fixtureObjects } = await import(new URL('../dist/tools/attestation-fixture.js', import.meta.url).href);

/**
 * The instance facts the harness contract describes, since MC-04 made
 * destination validation read them: every adapter object and field of the
 * mode, writeable, plus the custom properties the capacity profiles deliver
 * (`custom:Custom0` … up to the widest profile). A contract with no objects
 * would refuse every CRM run at validation, which is the point of MC-04 and
 * not a fact about the harness.
 */
const HARNESS_CUSTOM_FIELDS = 128;
function harnessObjects(mode) {
  const customs = Array.from({ length: HARNESS_CUSTOM_FIELDS }, (unused, index) => ({ label: `Custom${String(index)}`, type: 'string' }));
  const perObject = Object.fromEntries(['CONTACT', 'COMPANY', 'DEAL', 'LEAD'].map((object) => [object, customs]));
  return fixtureObjects(mode, perObject);
}

/**
 * The instance a harness contract is about.
 *
 * Deliberately unmistakable. If one of these ever turned up in a provenance
 * record or an evidence file, the id itself would say what it is, rather than
 * looking like a portal number somebody would have to go and check.
 */
const HARNESS_INSTANCE = {
  HUBSPOT: { instanceId: 'harness-not-a-real-portal', instanceLabel: 'offline harness, no HubSpot portal' },
  SALESFORCE: { instanceId: 'harness-not-a-real-org', instanceLabel: 'offline harness, no Salesforce org' },
};

const ARTIFACT = { path: 'harness/contract.json', sha256: '0'.repeat(64), byteLength: 0, kind: 'DESCRIBE' };

/**
 * A contract, an attestation over it, and the authority that verifies it.
 *
 * `capturedAt` and `expiresAt` are fixed rather than taken from the clock. A
 * harness whose evidence expires overnight is a harness that fails on a Tuesday
 * for a reason nobody can reproduce, and freshness is judged against an instant
 * the caller passes in — which is why `attestationInstant` is returned beside
 * the rest rather than left to `Date.now()`.
 */
export function harnessAttestation(mode, options = {}) {
  const instance = HARNESS_INSTANCE[mode];
  if (instance === undefined) {
    throw new Error(`${String(mode)} addresses no destination instance, so it takes no attestation`);
  }
  const issuer = generateKeyPairSync('ed25519');
  const capturedAt = '2026-09-01T00:00:00Z';
  const expiresAt = '2027-09-01T00:00:00Z';
  const instant = '2026-09-04T00:00:00Z';

  const contract = hashTargetContract({
    contractVersion: '1.0.0',
    parserVersion: '1.0.0',
    capturedAt,
    instance: { mode, instanceId: instance.instanceId, instanceLabel: instance.instanceLabel, evidence: 'ARTIFACT' },
    artifacts: [ARTIFACT],
    objects: options.objects ?? harnessObjects(mode),
    pipelines: options.pipelines ?? [],
  });

  const body = {
    attestationVersion: ATTESTATION_CONTRACT_VERSION,
    issuer: { id: 'kauro:offline-harness', name: 'Kauro offline harness', keyId: 'harness-1' },
    subject: { mode, instanceId: instance.instanceId, instanceLabel: instance.instanceLabel },
    artifacts: [{ path: ARTIFACT.path, sha256: ARTIFACT.sha256, byteLength: ARTIFACT.byteLength }],
    contractHash: contract.contractHash,
    schemaVersion: '1.0.0',
    toolVersion: 'kauro-harness/1.0.0',
    capturedAt,
    expiresAt,
    nonce: null,
  };
  const unsigned = { ...body, signature: { algorithm: ATTESTATION_ALGORITHM, value: '' } };
  const value = signBytes(null, Buffer.from(attestationSigningBytes(unsigned), 'utf8'), issuer.privateKey).toString('base64');

  return {
    targetContract: contract,
    targetAttestation: { ...body, signature: { algorithm: ATTESTATION_ALGORITHM, value } },
    attestationAuthorities: [
      {
        issuerId: body.issuer.id,
        keyId: body.issuer.keyId,
        algorithm: ATTESTATION_ALGORITHM,
        publicKeyPem: issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      },
    ],
    attestationInstant: instant,
  };
}

/**
 * What a run of this mode needs added to its input, and nothing more.
 *
 * CLEAN_ONLY gets an empty object rather than a policy override: its policy is
 * NOT_APPLICABLE and stating it would be refused, which is the behaviour the
 * seam is meant to have.
 */
export function attestationInputFor(mode, options = {}) {
  if (mode === 'CLEAN_ONLY') return {};
  return harnessAttestation(mode, options);
}

/**
 * An attestation over a contract somebody else already built.
 *
 * The architecture gate builds its own contract inline, shaped for the fixture
 * it is about to run, and it should go on doing so — the contract is part of
 * what that derivation is testing. What it needs from here is only the
 * signature, the key and the instant, which is the part a host supplies rather
 * than a plan.
 */
export function attestExistingContract(contract) {
  const issuer = generateKeyPairSync('ed25519');
  const instance = contract.contract.instance;
  const body = {
    attestationVersion: ATTESTATION_CONTRACT_VERSION,
    issuer: { id: 'kauro:offline-harness', name: 'Kauro offline harness', keyId: 'harness-1' },
    subject: { mode: instance.mode, instanceId: instance.instanceId, instanceLabel: instance.instanceLabel },
    artifacts: contract.contract.artifacts.map((artifact) => ({
      path: artifact.path,
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
    })),
    contractHash: contract.contractHash,
    schemaVersion: '1.0.0',
    toolVersion: 'kauro-harness/1.0.0',
    capturedAt: contract.contract.capturedAt,
    expiresAt: '2027-09-01T00:00:00Z',
    nonce: null,
  };
  const unsigned = { ...body, signature: { algorithm: ATTESTATION_ALGORITHM, value: '' } };
  const value = signBytes(null, Buffer.from(attestationSigningBytes(unsigned), 'utf8'), issuer.privateKey).toString('base64');
  return {
    targetAttestation: { ...body, signature: { algorithm: ATTESTATION_ALGORITHM, value } },
    attestationAuthorities: [
      {
        issuerId: body.issuer.id,
        keyId: body.issuer.keyId,
        algorithm: ATTESTATION_ALGORITHM,
        publicKeyPem: issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      },
    ],
    attestationInstant: '2026-09-04T00:00:00Z',
  };
}
