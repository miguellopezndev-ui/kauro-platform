import { strict as assert } from 'node:assert';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  ATTESTATION_ALGORITHM,
  ATTESTATION_CONTRACT_VERSION,
  attestationSigningBytes,
  verifyAttestation,
} from '../../src/target/attestation.js';
import type {
  AttestationAuthority,
  AttestationExpectation,
  TargetAttestation,
} from '../../src/target/attestation.js';

/**
 * Who says this contract describes that instance.
 *
 * The cases below are each a way the claim could be believed when it should not
 * be. The one that matters most is the last kind: a perfectly valid signature,
 * made by a key nobody named. That is what a self-issued attestation looks like
 * — the same party writes the claim, writes the key and checks the result — and
 * it is indistinguishable from a real one unless the key material comes from
 * somewhere else.
 */

const issuer = generateKeyPairSync('ed25519');
const impostor = generateKeyPairSync('ed25519');

const AUTHORITY: AttestationAuthority = {
  issuerId: 'agency:acme',
  keyId: 'k1',
  algorithm: ATTESTATION_ALGORITHM,
  publicKeyPem: issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
};

function unsigned(overrides: Partial<TargetAttestation> = {}): Omit<TargetAttestation, 'signature'> {
  return {
    attestationVersion: ATTESTATION_CONTRACT_VERSION,
    issuer: { id: 'agency:acme', name: 'Acme Partners', keyId: 'k1' },
    subject: { mode: 'HUBSPOT', instanceId: '00000001', instanceLabel: 'Acme production portal' },
    artifacts: [
      { path: 'export/properties.csv', sha256: 'a'.repeat(64), byteLength: 4096 },
      { path: 'export/pipelines.json', sha256: 'b'.repeat(64), byteLength: 512 },
    ],
    contractHash: 'c'.repeat(64),
    schemaVersion: '1.0.0',
    toolVersion: 'kauro-capture/1.0.0',
    capturedAt: '2026-09-01T00:00:00Z',
    expiresAt: '2026-10-01T00:00:00Z',
    nonce: null,
    ...overrides,
  };
}

function signWith(key: Parameters<typeof signBytes>[2], body = unsigned()): TargetAttestation {
  const candidate = { ...body, signature: { algorithm: ATTESTATION_ALGORITHM, value: '' } };
  const value = signBytes(null, Buffer.from(attestationSigningBytes(candidate), 'utf8'), key).toString('base64');
  return { ...body, signature: { algorithm: ATTESTATION_ALGORITHM, value } };
}

const EXPECT: AttestationExpectation = {
  mode: 'HUBSPOT',
  instanceId: '00000001',
  contractHash: 'c'.repeat(64),
  artifacts: [
    { path: 'export/properties.csv', sha256: 'a'.repeat(64) },
    { path: 'export/pipelines.json', sha256: 'b'.repeat(64) },
  ],
  at: '2026-09-15T00:00:00Z',
};

describe('an attestation is believed only when somebody else made it', () => {
  it('accepts one signed by an issuer the host named', () => {
    const result = verifyAttestation({
      attestation: signWith(issuer.privateKey),
      publicKeys: [AUTHORITY],
      expect: EXPECT,
    });
    assert.deepEqual(result.reasons, []);
    assert.equal(result.ok, true);
    assert.equal(result.issuerId, 'agency:acme');
    assert.equal(result.keyId, 'k1');
  });

  it('refuses a perfectly valid signature from a key nobody named', () => {
    // This is what a self-issued attestation looks like. The signature is real,
    // the payload is intact, and it establishes nothing, because the party
    // asserting the claim also chose the key that checks it.
    const forged = signWith(impostor.privateKey);
    const result = verifyAttestation({ attestation: forged, publicKeys: [AUTHORITY], expect: EXPECT });
    assert.equal(result.ok, false);
    assert.ok(
      result.reasons.some((reason) => reason.includes('does not verify')),
      result.reasons.join('; '),
    );
  });

  it('refuses an issuer the host did not supply key material for', () => {
    const other = signWith(issuer.privateKey, unsigned({ issuer: { id: 'agency:someone-else', name: 'Someone', keyId: 'k1' } }));
    const result = verifyAttestation({ attestation: other, publicKeys: [AUTHORITY], expect: EXPECT });
    assert.equal(result.ok, false);
    assert.ok(
      result.reasons.some((reason) => reason.includes('no key material was supplied')),
      result.reasons.join('; '),
    );
  });

  it('refuses the right issuer with the wrong key id', () => {
    const rotated = signWith(issuer.privateKey, unsigned({ issuer: { id: 'agency:acme', name: 'Acme Partners', keyId: 'k2' } }));
    const result = verifyAttestation({ attestation: rotated, publicKeys: [AUTHORITY], expect: EXPECT });
    assert.equal(result.ok, false);
  });

  it('refuses an absent attestation rather than passing over it', () => {
    const result = verifyAttestation({ attestation: null, publicKeys: [AUTHORITY], expect: EXPECT });
    assert.equal(result.ok, false);
    assert.equal(result.reasons.length, 1);
    assert.ok(result.reasons[0]?.includes('unattested'));
  });

  it('refuses one with no signature at all', () => {
    const bare = { ...unsigned(), signature: { algorithm: ATTESTATION_ALGORITHM, value: undefined } };
    const result = verifyAttestation({
      attestation: bare as unknown as TargetAttestation,
      publicKeys: [AUTHORITY],
      expect: EXPECT,
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) => reason.includes('carries no signature')));
  });
});

describe('the signature covers what the attestation asserts', () => {
  const cases: { what: string; mutate: (body: TargetAttestation) => TargetAttestation }[] = [
    {
      what: 'the instance it is about',
      mutate: (body) => ({ ...body, subject: { ...body.subject, instanceId: '00000002' } }),
    },
    {
      what: 'the contract it covers',
      mutate: (body) => ({ ...body, contractHash: 'd'.repeat(64) }),
    },
    {
      what: 'the digest of an artifact',
      mutate: (body) => ({
        ...body,
        artifacts: [{ ...(body.artifacts[0] as TargetAttestation['artifacts'][number]), sha256: 'e'.repeat(64) }, body.artifacts[1] as TargetAttestation['artifacts'][number]],
      }),
    },
    {
      what: 'when it expires',
      mutate: (body) => ({ ...body, expiresAt: '2099-01-01T00:00:00Z' }),
    },
    {
      what: 'the nonce binding it to a run',
      mutate: (body) => ({ ...body, nonce: 'someone-elses-run' }),
    },
    {
      what: 'the tool that captured it',
      mutate: (body) => ({ ...body, toolVersion: 'something-else/9.9.9' }),
    },
  ];

  for (const item of cases) {
    it(`notices a change to ${item.what}`, () => {
      const tampered = item.mutate(signWith(issuer.privateKey));
      const result = verifyAttestation({ attestation: tampered, publicKeys: [AUTHORITY], expect: EXPECT });
      assert.equal(result.ok, false, `changing ${item.what} was not noticed`);
      assert.ok(
        result.reasons.some((reason) => reason.includes('does not verify')),
        `changing ${item.what} should break the signature: ${result.reasons.join('; ')}`,
      );
    });
  }

  it('does not depend on the order artifacts were listed in', () => {
    // Two issuers listing the same artifacts differently must produce the same
    // bytes, or a signature would depend on a detail that carries no meaning.
    const forward = unsigned();
    const reversed = unsigned({ artifacts: [...forward.artifacts].reverse() });
    assert.equal(
      attestationSigningBytes({ ...forward, signature: { algorithm: ATTESTATION_ALGORITHM, value: '' } }),
      attestationSigningBytes({ ...reversed, signature: { algorithm: ATTESTATION_ALGORITHM, value: '' } }),
    );
  });

  it('does not sign its own signature', () => {
    const signed = signWith(issuer.privateKey);
    const withOther = { ...signed, signature: { algorithm: ATTESTATION_ALGORITHM, value: 'ZGlmZmVyZW50' } };
    assert.equal(attestationSigningBytes(signed), attestationSigningBytes(withOther));
  });
});

describe('an attestation is about this instance, these artifacts, and is still fresh', () => {
  it('refuses one about another target instance', () => {
    const result = verifyAttestation({
      attestation: signWith(issuer.privateKey),
      publicKeys: [AUTHORITY],
      expect: { ...EXPECT, instanceId: '00000002' },
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) => reason.includes('this run addresses')));
  });

  it('refuses one about another target contract', () => {
    const result = verifyAttestation({
      attestation: signWith(issuer.privateKey),
      publicKeys: [AUTHORITY],
      expect: { ...EXPECT, contractHash: 'f'.repeat(64) },
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) => reason.includes('different target contract')));
  });

  it('refuses one that does not cover an artifact in hand', () => {
    const result = verifyAttestation({
      attestation: signWith(issuer.privateKey),
      publicKeys: [AUTHORITY],
      expect: {
        ...EXPECT,
        artifacts: [...EXPECT.artifacts, { path: 'export/owners.csv', sha256: '9'.repeat(64) }],
      },
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) => reason.includes('does not cover')));
  });

  it('refuses one that covers a different version of an artifact in hand', () => {
    const result = verifyAttestation({
      attestation: signWith(issuer.privateKey),
      publicKeys: [AUTHORITY],
      expect: {
        ...EXPECT,
        artifacts: [{ path: 'export/properties.csv', sha256: '7'.repeat(64) }],
      },
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) => reason.includes('a different')));
  });

  it('refuses one that has expired', () => {
    const result = verifyAttestation({
      attestation: signWith(issuer.privateKey),
      publicKeys: [AUTHORITY],
      expect: { ...EXPECT, at: '2026-12-01T00:00:00Z' },
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) => reason.includes('expired')));
  });

  it('judges freshness against an instant it was given, never the clock', () => {
    // The same attestation, verified twice against the same instant, gives the
    // same answer however long apart the two runs happen. A core that consulted
    // the clock could not be replayed.
    const attestation = signWith(issuer.privateKey);
    const first = verifyAttestation({ attestation, publicKeys: [AUTHORITY], expect: EXPECT });
    const second = verifyAttestation({ attestation, publicKeys: [AUTHORITY], expect: EXPECT });
    assert.deepEqual(first, second);
    assert.equal(first.ok, true);
  });

  it('refuses one bound to a different run when a nonce is required', () => {
    const bound = signWith(issuer.privateKey, unsigned({ nonce: 'run-a' }));
    const result = verifyAttestation({
      attestation: bound,
      publicKeys: [AUTHORITY],
      expect: { ...EXPECT, nonce: 'run-b' },
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) => reason.includes('not bound to this run')));
  });

  it('accepts one bound to the run that asked for it', () => {
    const bound = signWith(issuer.privateKey, unsigned({ nonce: 'run-a' }));
    const result = verifyAttestation({
      attestation: bound,
      publicKeys: [AUTHORITY],
      expect: { ...EXPECT, nonce: 'run-a' },
    });
    assert.deepEqual(result.reasons, []);
    assert.equal(result.ok, true);
  });

  it('reports every reason it refused, not the first', () => {
    const wrong = signWith(impostor.privateKey, unsigned({ subject: { mode: 'SALESFORCE', instanceId: 'x', instanceLabel: 'y' } }));
    const result = verifyAttestation({
      attestation: wrong,
      publicKeys: [AUTHORITY],
      expect: { ...EXPECT, at: '2026-12-01T00:00:00Z' },
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.length >= 3, `expected several reasons, got: ${result.reasons.join('; ')}`);
  });

  it('refuses a version it does not know how to check', () => {
    const future = signWith(issuer.privateKey, unsigned({ attestationVersion: '2.0.0' }));
    const result = verifyAttestation({ attestation: future, publicKeys: [AUTHORITY], expect: EXPECT });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) => reason.includes('verifies 1.0.0')));
  });

  it('refuses an algorithm it does not verify', () => {
    const signed = signWith(issuer.privateKey);
    const swapped = { ...signed, signature: { algorithm: 'rsa-sha1', value: signed.signature.value } };
    const result = verifyAttestation({ attestation: swapped, publicKeys: [AUTHORITY], expect: EXPECT });
    assert.equal(result.ok, false);
  });

  it('never takes key material from the attestation itself', () => {
    // The refusal has to survive the attestation carrying a key of its own, in
    // any shape, because that is exactly how a self-issued one would try to be
    // accepted.
    const smuggled = {
      ...signWith(impostor.privateKey),
      publicKeyPem: impostor.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      keys: [{ issuerId: 'agency:acme', keyId: 'k1', algorithm: ATTESTATION_ALGORITHM, publicKeyPem: impostor.publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
    };
    const result = verifyAttestation({
      attestation: smuggled as unknown as TargetAttestation,
      publicKeys: [AUTHORITY],
      expect: EXPECT,
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) => reason.includes('does not verify')));
  });
});

