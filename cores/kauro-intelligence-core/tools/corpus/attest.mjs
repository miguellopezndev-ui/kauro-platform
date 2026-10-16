// The attestation a vendor-mode dry run and the validity runs sign their planted target contract with: a throwaway issuer, never a
// real key. The data plane requires an attested contract for a HubSpot or Salesforce run; the corpus plants the contract, so it also
// signs it (SIMULATED, synthetic).
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { ATTESTATION_ALGORITHM, ATTESTATION_CONTRACT_VERSION, attestationSigningBytes } from 'kauro-migration-core';

const issuer = generateKeyPairSync('ed25519');
export const AUTHORITY = { issuerId: 'validity:issuer', keyId: 'k1', algorithm: ATTESTATION_ALGORITHM, publicKeyPem: issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
export const ATTESTATION_INSTANT = '2026-09-15T00:00:00Z';
export const attestationFor = (contract) => {
  const body = {
    attestationVersion: ATTESTATION_CONTRACT_VERSION, issuer: { id: 'validity:issuer', name: 'Validity Issuer', keyId: 'k1' },
    subject: { mode: contract.contract.instance.mode, instanceId: contract.contract.instance.instanceId, instanceLabel: contract.contract.instance.instanceLabel },
    artifacts: [{ path: 'export/schema.json', sha256: 'a'.repeat(64), byteLength: 4096 }], contractHash: contract.contractHash, schemaVersion: '1.0.0', toolVersion: 'validity/1.0.0',
    capturedAt: '2026-09-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', nonce: null,
  };
  const candidate = { ...body, signature: { algorithm: ATTESTATION_ALGORITHM, value: '' } };
  return { ...body, signature: { algorithm: ATTESTATION_ALGORITHM, value: signBytes(null, Buffer.from(attestationSigningBytes(candidate), 'utf8'), issuer.privateKey).toString('base64') } };
};
