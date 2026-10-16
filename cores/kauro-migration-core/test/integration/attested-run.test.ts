import { strict as assert } from 'node:assert';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/mapping/load-config.js';
import { runMigration } from '../../src/run/run-migration.js';
import { hashTargetContract } from '../../src/target/contract.js';
import { isMigrationError } from '../../src/domain/errors.js';
import {
  ATTESTATION_ALGORITHM,
  ATTESTATION_CONTRACT_VERSION,
  attestationSigningBytes,
  verifyAttestation,
} from '../../src/target/attestation.js';
import type { AttestationAuthority, TargetAttestation } from '../../src/target/attestation.js';
import { buildSourceProfile } from '../../src/profile/source-profile.js';
import { writeAndPromotePackage } from '../../src/artifacts/write-package.js';
import { packageDigest } from '../../src/artifacts/package-digest.js';
import { verifyPackage } from '../../src/verify/verify-package.js';
import { sha256Hex } from '../../src/util/hash.js';
import { CORE_VERSION } from '../../src/version.js';
import { caseScratch, repoRoot, scratchDir, verifyScratch } from '../support/harness.js';

/**
 * The seam is only worth having if the run consults it.
 *
 * A module that verifies attestations correctly and is never called is a
 * library, not a control. These cases drive `runMigration` itself, and every
 * refusal happens before a byte of the source is read: whether the destination
 * may be touched at all is a property of the plan and the evidence, so finding
 * out that it may not should not cost a full ingest first.
 *
 * What is being defended is a mistake this repository has already made. A
 * property export was attributed to the wrong portal, and nothing in the file
 * would ever have revealed it, because the fact was not in the bytes. Which
 * instance a capture came from is a claim somebody has to make.
 *
 * MC-1 built the seam and left it switched off: `attestationPolicy` defaulted
 * to NOT_REQUIRED, so every caller that had not thought about attestation got
 * the permissive answer. It is now derived from the mode instead — REQUIRED for
 * HUBSPOT and SALESFORCE, NOT_APPLICABLE for CLEAN_ONLY — and the cases below
 * are written the way a caller writes a run: they say nothing about the policy
 * and get the one their mode implies. The handful that do state it are there to
 * show that stating it cannot change it.
 */

const issuer = generateKeyPairSync('ed25519');
const impostor = generateKeyPairSync('ed25519');

const AUTHORITY: AttestationAuthority = {
  issuerId: 'agency:acme',
  keyId: 'k1',
  algorithm: ATTESTATION_ALGORITHM,
  publicKeyPem: issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
};

const FIXTURES = join(repoRoot(), 'test', 'fixtures', 'value-intent');

const contract = hashTargetContract({
  contractVersion: '1.0.0',
  parserVersion: '1.0.0',
  capturedAt: '2026-09-01T00:00:00Z',
  instance: { mode: 'HUBSPOT', instanceId: '00000001', instanceLabel: 'Acme portal', evidence: 'ARTIFACT' },
  artifacts: [{ path: 'export/properties.csv', sha256: 'a'.repeat(64), byteLength: 4096, kind: 'DESCRIBE' }],
  objects: [
    {
      apiName: 'Contact',
      label: 'Contact',
      createable: 'TRUE',
      updateable: 'TRUE',
      recordTypes: [],
      fields: [
        {
          apiName: 'email', label: 'Email', type: 'string', createable: 'TRUE', updateable: 'TRUE',
          nillable: 'TRUE', length: 255, precision: null, scale: null, unique: 'TRUE', externalId: 'FALSE',
          idLookup: 'TRUE', calculated: 'FALSE', autoNumber: 'FALSE', defaultedOnCreate: 'FALSE',
          restrictedPicklist: 'FALSE', picklistValues: [], referenceTo: [], relationshipName: null,
          evidence: 'ARTIFACT',
        },
        // The plan delivers four fields and destination validation reads this
        // contract (MC-04); the three below are the rest of what it writes.
        ...[['firstname', 'First name'], ['lastname', 'Last name'], ['jobtitle', 'Job title']].map(([apiName, label]) => ({
          apiName: apiName ?? '', label: label ?? '', type: 'string', createable: 'TRUE' as const, updateable: 'TRUE' as const,
          nillable: 'TRUE' as const, length: null, precision: null, scale: null, unique: 'FALSE' as const, externalId: 'FALSE' as const,
          idLookup: 'FALSE' as const, calculated: 'FALSE' as const, autoNumber: 'FALSE' as const, defaultedOnCreate: 'FALSE' as const,
          restrictedPicklist: 'FALSE' as const, picklistValues: [], referenceTo: [], relationshipName: null,
          evidence: 'ARTIFACT' as const,
        })),
      ],
    },
  ],
  pipelines: [],
});

function attestation(
  key: Parameters<typeof signBytes>[2],
  overrides: Partial<Omit<TargetAttestation, 'signature'>> = {},
): TargetAttestation {
  const body: Omit<TargetAttestation, 'signature'> = {
    attestationVersion: ATTESTATION_CONTRACT_VERSION,
    issuer: { id: 'agency:acme', name: 'Acme Partners', keyId: 'k1' },
    subject: { mode: 'HUBSPOT', instanceId: '00000001', instanceLabel: 'Acme portal' },
    artifacts: [{ path: 'export/properties.csv', sha256: 'a'.repeat(64), byteLength: 4096 }],
    contractHash: contract.contractHash,
    schemaVersion: '1.0.0',
    toolVersion: 'kauro-capture/1.0.0',
    capturedAt: '2026-09-01T00:00:00Z',
    expiresAt: '2026-10-01T00:00:00Z',
    nonce: null,
    ...overrides,
  };
  const candidate = { ...body, signature: { algorithm: ATTESTATION_ALGORITHM, value: '' } };
  const value = signBytes(null, Buffer.from(attestationSigningBytes(candidate), 'utf8'), key).toString('base64');
  return { ...body, signature: { algorithm: ATTESTATION_ALGORITHM, value } };
}

function loadAt(name: string): { config: ReturnType<typeof loadConfig>['config']; configHash: string } {
  const path = join(FIXTURES, `${name}.json`);
  const loaded = loadConfig(readFileSync(path, 'utf8'), path);
  return { config: loaded.config, configHash: loaded.configHash };
}

const inputRoot = join(FIXTURES, 'input');
const hubspot = loadAt('hubspot-update');
const base = {
  inputRoot,
  config: hubspot.config,
  configHash: hubspot.configHash,
  targetContract: contract,
  attestationInstant: '2026-09-15T00:00:00Z',
  // No attestationPolicy. HUBSPOT derives REQUIRED, and a run that says nothing
  // about the policy is the shape every caller actually writes, so it is the
  // shape these cases are written in.
  //
  // Every case here refuses before a byte is read, so nothing is ever spilled
  // into this. It is present because the contract requires the host to say
  // where scratch goes, not because these runs need it.
  scratch: caseScratch('attestedrunbase'),
};

function refuses(input: Parameters<typeof runMigration>[0], fragment?: string): void {
  assert.throws(
    () => runMigration(input),
    (error: unknown) =>
      isMigrationError(error) &&
      error.code === 'TARGET_CONTRACT_INVALID' &&
      (fragment === undefined || error.message.includes(fragment)),
  );
}

/**
 * A refusal that is about the plan rather than about the evidence.
 *
 * A stated policy that contradicts the mode, and a contract or an attestation
 * handed to a run that addresses no instance, are not failures to establish an
 * instance — they are descriptions of a run that does not exist. They carry
 * CONFIG_INVALID for that reason, and the distinction is asserted here so that
 * collapsing the two codes would show up as a failing case rather than as a
 * slightly less precise error.
 */
function refusesConfiguration(input: Parameters<typeof runMigration>[0], fragment: string): void {
  assert.throws(
    () => runMigration(input),
    (error: unknown) =>
      isMigrationError(error) && error.code === 'CONFIG_INVALID' && error.message.includes(fragment),
  );
}

describe('a run refuses a target instance nobody vouched for', () => {
  it('runs when the attestation checks out', () => {
    const run = runMigration({
      ...base,
      targetAttestation: attestation(issuer.privateKey),
      attestationAuthorities: [AUTHORITY],
    });
    assert.equal(run.reconciliation.sourceRows.equationHolds, true);
  });

  it('refuses when there is no attestation at all', () => {
    refuses({ ...base, attestationAuthorities: [AUTHORITY] }, 'not attested');
  });

  it('refuses when the host supplied nothing to check it with', () => {
    // An empty authority list is not permission. The core holds no keys of its
    // own, so with none supplied there is nobody it is entitled to believe.
    refuses(
      { ...base, targetAttestation: attestation(issuer.privateKey), attestationAuthorities: [] },
      'no issuer key material',
    );
  });

  it('refuses a valid signature from a key nobody named', () => {
    refuses({
      ...base,
      targetAttestation: attestation(impostor.privateKey),
      attestationAuthorities: [AUTHORITY],
    });
  });

  it('refuses a well-formed attestation from an issuer this deployment never named', () => {
    // Signed with the key the deployment does hold, but claiming to come from
    // somebody it never named. The signature is beside the point: the authority
    // list is the host's statement of who is entitled to make this claim, and an
    // issuer that is not on it is not an authority however good its cryptography.
    refuses(
      {
        ...base,
        targetAttestation: attestation(issuer.privateKey, {
          issuer: { id: 'agency:nobody', name: 'Nobody In Particular', keyId: 'k1' },
        }),
        attestationAuthorities: [AUTHORITY],
      },
      'no key material was supplied for issuer',
    );
  });

  it('refuses one whose payload was altered after it was signed', () => {
    // The label is changed, and nothing else. It is not compared against
    // anything — the run checks the mode, the instance, the contract hash and
    // the artifact digests, and the label is none of them — so the only thing
    // standing between an edited attestation and an accepted one is that the
    // signature covers what the attestation asserts. If it ever stops covering
    // the whole payload, this is the case that says so.
    const signed = attestation(issuer.privateKey);
    const altered: TargetAttestation = {
      ...signed,
      subject: { ...signed.subject, instanceLabel: 'Some other portal entirely' },
    };
    refuses({ ...base, targetAttestation: altered, attestationAuthorities: [AUTHORITY] }, 'does not verify');
  });

  it('refuses an attestation about a different portal', () => {
    refuses({
      ...base,
      targetAttestation: attestation(issuer.privateKey, {
        subject: { mode: 'HUBSPOT', instanceId: '99999999', instanceLabel: 'Someone else' },
      }),
      attestationAuthorities: [AUTHORITY],
    });
  });

  it('refuses one that covers a different capture than the contract in hand', () => {
    refuses({
      ...base,
      targetAttestation: attestation(issuer.privateKey, {
        artifacts: [{ path: 'export/properties.csv', sha256: '9'.repeat(64), byteLength: 4096 }],
      }),
      attestationAuthorities: [AUTHORITY],
    });
  });

  it('refuses one that has expired, judged against the instant it was given', () => {
    refuses({
      ...base,
      targetAttestation: attestation(issuer.privateKey),
      attestationAuthorities: [AUTHORITY],
      attestationInstant: '2027-01-01T00:00:00Z',
    });
  });

  it('refuses when the host did not say what instant freshness is judged against', () => {
    // Freshness is judged against an instant the host passes in, never against
    // the clock, so that the same inputs give the same answer whenever the run
    // happens. A host that supplies none has not made an attestation fresh; it
    // has removed the question, and the run treats that as a refusal rather than
    // reaching for the clock to answer it itself.
    refuses(
      {
        ...base,
        attestationInstant: null,
        targetAttestation: attestation(issuer.privateKey),
        attestationAuthorities: [AUTHORITY],
      },
      'not given an instant',
    );
  });

  it('refuses one bound to another run, at the seam the run reads through', () => {
    // Replay is the one negative on MC-2's list that cannot be driven through
    // `runMigration` today: the expectation the run builds carries the instant
    // but no nonce, so an attestation bound to another run is not compared
    // against anything here. Binding one needs a nonce on `RunInput`, which is a
    // change to the input contract and not this one.
    //
    // So the property is stated against the same expectation the run builds,
    // with the nonce the run does not yet supply. When the nonce is plumbed
    // through, this case moves onto `runMigration` unchanged rather than being
    // written from scratch, and until then it is honest about where the check
    // lives.
    const verification = verifyAttestation({
      attestation: attestation(issuer.privateKey, { nonce: 'run-a' }),
      publicKeys: [AUTHORITY],
      expect: {
        mode: contract.contract.instance.mode,
        instanceId: contract.contract.instance.instanceId,
        contractHash: contract.contractHash,
        artifacts: contract.contract.artifacts.map((artifact) => ({
          path: artifact.path,
          sha256: artifact.sha256,
        })),
        at: '2026-09-15T00:00:00Z',
        nonce: 'run-b',
      },
    });
    assert.equal(verification.ok, false);
    assert.ok(
      verification.reasons.some((reason) => reason.includes('not bound to this run')),
      `an attestation issued for another run was not noticed: ${verification.reasons.join('; ')}`,
    );
  });

  it('refuses a CRM run that was given no target contract at all', () => {
    refuses(
      {
        inputRoot,
        config: hubspot.config,
        configHash: hubspot.configHash,
        attestationAuthorities: [AUTHORITY],
        attestationInstant: '2026-09-15T00:00:00Z',
        scratch: caseScratch('attestedrunnocontract'),
      },
      'no target contract',
    );
  });

  it('refuses a SALESFORCE run on the same terms, because the policy follows the mode', () => {
    // The second CRM mode is not a special case anywhere in the guard, and this
    // is what says so. Both modes address somebody's real org or portal, so both
    // derive REQUIRED, and neither has to be listed by a host to get it.
    const salesforce = loadAt('salesforce-update');
    refuses(
      {
        inputRoot,
        config: salesforce.config,
        configHash: salesforce.configHash,
        attestationAuthorities: [AUTHORITY],
        attestationInstant: '2026-09-15T00:00:00Z',
        scratch: caseScratch('attestedrunsalesforce'),
      },
      'no target contract',
    );
  });

  it('refuses before reading the source, not after', () => {
    // Pointed at a directory that holds nothing readable. A run that got as far
    // as ingest would fail with an input error; this one must fail on the
    // evidence, because the evidence is settled first.
    refuses({
      ...base,
      inputRoot: join(FIXTURES, 'no-such-directory'),
      attestationAuthorities: [AUTHORITY],
    }, 'not attested');
  });
});

/**
 * The policy is read off the mode, and configuration may not replace it.
 *
 * These are the cases MC-2 added. The ones above ask whether the evidence
 * establishes the instance; these ask whether the run was allowed to pose the
 * question that way at all. A run that states a policy contradicting its mode is
 * not a run with weaker evidence, it is a description of something that does not
 * exist, so it is refused as a configuration error before any evidence is
 * considered.
 */
describe('the attestation policy follows the mode rather than the configuration', () => {
  const cleanOnly = loadAt('clean-only');

  it('refuses a CRM run whose configuration asks for NOT_REQUIRED', () => {
    // With a perfectly good attestation in hand, so that the refusal cannot be
    // mistaken for a failure of the evidence. The run is refused because of what
    // it asked for, not because of what it could not prove: turning this check
    // off is the one thing configuration must never be able to do, and a silent
    // downgrade is exactly the failure the seam was built to prevent.
    refusesConfiguration(
      {
        ...base,
        attestationPolicy: 'NOT_REQUIRED',
        targetAttestation: attestation(issuer.privateKey),
        attestationAuthorities: [AUTHORITY],
        scratch: caseScratch('attestedrunnotrequired'),
      },
      'the configuration asked for NOT_REQUIRED',
    );
  });

  it('refuses a CRM run whose configuration asks for NOT_APPLICABLE', () => {
    // The other way of saying the same thing. A HubSpot run addresses a portal
    // whether or not the configuration would prefer that it did not.
    refusesConfiguration(
      {
        ...base,
        attestationPolicy: 'NOT_APPLICABLE',
        targetAttestation: attestation(issuer.privateKey),
        attestationAuthorities: [AUTHORITY],
        scratch: caseScratch('attestedrunnotapplicable'),
      },
      'the configuration asked for NOT_APPLICABLE',
    );
  });

  it('accepts the restatement of the policy the mode already derives', () => {
    // Saying REQUIRED out loud is allowed, because it agrees. It buys nothing —
    // the run was already under it — and a host that writes it down is entitled
    // to have its own configuration read back to it rather than rejected.
    const run = runMigration({
      ...base,
      attestationPolicy: 'REQUIRED',
      targetAttestation: attestation(issuer.privateKey),
      attestationAuthorities: [AUTHORITY],
      scratch: caseScratch('attestedrunrestated'),
    });
    assert.equal(run.reconciliation.sourceRows.equationHolds, true);
  });

  it('runs CLEAN_ONLY with no CRM dependency of any kind', () => {
    // No contract, no attestation, no issuer key material, no instant. CLEAN_ONLY
    // has no portal and no org behind it, nothing to pre-create and no import
    // wizard reading the result, so none of those things is missing here — there
    // is nothing for them to be about. A CLEAN_ONLY run that needed a CRM
    // artifact to proceed would mean the mode had quietly acquired a destination.
    const run = runMigration({
      scratch: caseScratch('attestedruncleanonly'),
      inputRoot,
      config: cleanOnly.config,
      configHash: cleanOnly.configHash,
    });
    assert.equal(run.reconciliation.records.deliveredTotal, 3);
  });

  it('refuses a CLEAN_ONLY run that was handed a target contract', () => {
    // The likeliest way to get here is a plan written for a portal, executed
    // with its mode switched to CLEAN_ONLY. Ignoring the contract would produce
    // a package that looks deliberate; the run stops instead, and names the
    // instance the contract is about so the operator can see which of the two
    // he meant.
    refusesConfiguration(
      {
        scratch: caseScratch('attestedrpcleancontract'),
        inputRoot,
        config: cleanOnly.config,
        configHash: cleanOnly.configHash,
        targetContract: contract,
      },
      'given a target contract describing HUBSPOT instance 00000001',
    );
  });

  it('refuses a CLEAN_ONLY run that was handed an attestation', () => {
    refusesConfiguration(
      {
        scratch: caseScratch('attestedrpcleanattested'),
        inputRoot,
        config: cleanOnly.config,
        configHash: cleanOnly.configHash,
        targetAttestation: attestation(issuer.privateKey),
        attestationAuthorities: [AUTHORITY],
        attestationInstant: '2026-09-15T00:00:00Z',
      },
      'given an attestation from "agency:acme"',
    );
  });

  it('refuses a CLEAN_ONLY run whose configuration asks for REQUIRED', () => {
    // Not a stricter clean-only run. There is no instance, so requiring one to be
    // attested asks for evidence about something that does not exist, and the
    // only way to satisfy it would be to invent an instance. That is a
    // contradiction in the plan and is named as one.
    refusesConfiguration(
      {
        scratch: caseScratch('attestedrpcleanrequired'),
        inputRoot,
        config: cleanOnly.config,
        configHash: cleanOnly.configHash,
        attestationPolicy: 'REQUIRED',
        attestationAuthorities: [AUTHORITY],
        attestationInstant: '2026-09-15T00:00:00Z',
      },
      'the configuration asked for REQUIRED',
    );
  });

  it('refuses a CLEAN_ONLY run whose configuration asks for NOT_REQUIRED', () => {
    // Refused for the same reason as REQUIRED, and it is worth being explicit
    // about why, because this one looks harmless. NOT_REQUIRED says there is an
    // instance whose identity nobody is being asked to vouch for. CLEAN_ONLY says
    // there is no instance. A run cannot be both, and the difference is not
    // cosmetic: a host that writes NOT_REQUIRED here believes it is addressing a
    // destination, and it is not.
    refusesConfiguration(
      {
        scratch: caseScratch('attestedrpcleannotreq'),
        inputRoot,
        config: cleanOnly.config,
        configHash: cleanOnly.configHash,
        attestationPolicy: 'NOT_REQUIRED',
      },
      'the configuration asked for NOT_REQUIRED',
    );
  });
});

/**
 * CMD024, the half the engine owns (CONTRACT section 17a).
 *
 * The product operation (endpoint, persisted receipt, idempotency, denials) is
 * B08 on B06/B05. What the engine owes it is a deterministic composition: the
 * same subject gives the same evidence hashes, and a change to one bound body
 * moves the hash of that body and of nothing it is independent of.
 */
interface ReceiptEvidence {
  readonly profile: string;
  readonly configuration: string;
  readonly contract: string;
  readonly attestation: string;
  readonly packageDigest: string;
  readonly coreVersion: string;
}

function validateSubject(
  name: string,
  variant: { readonly attestation?: TargetAttestation; readonly configOverride?: (config: Record<string, unknown>) => void; readonly packageDirOut?: { value: string } } = {},
): ReceiptEvidence {
  const path = join(FIXTURES, 'hubspot-update.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  variant.configOverride?.(parsed);
  const loaded = loadConfig(JSON.stringify(parsed), path);
  const profile = buildSourceProfile({ inputRoot, config: loaded.config, scratch: caseScratch(`${name}-profile`) });
  const signed = variant.attestation ?? attestation(issuer.privateKey);
  const run = runMigration({
    ...base,
    scratch: caseScratch(`${name}-run`),
    config: loaded.config,
    configHash: loaded.configHash,
    sourceProfile: profile,
    targetAttestation: signed,
    attestationAuthorities: [AUTHORITY],
  });
  const packageDir = join(scratchDir('cmd024', name), 'package');
  writeAndPromotePackage({
    result: run,
    config: loaded.config,
    normalizedConfig: loaded.normalizedJson,
    outputDir: packageDir,
    force: true,
  });
  if (variant.packageDirOut !== undefined) variant.packageDirOut.value = packageDir;
  const verification = verifyPackage(packageDir, { scratch: verifyScratch(packageDir) });
  assert.deepEqual(verification.problems, []);
  return {
    profile: profile.profileHash,
    configuration: loaded.configHash,
    contract: contract.contractHash,
    attestation: sha256Hex(attestationSigningBytes(signed)),
    packageDigest: packageDigest(packageDir).digest,
    coreVersion: CORE_VERSION,
  };
}

describe('CMD024, the engine half', () => {
  it('[CMD024-engine] one subject validated twice yields identical evidence hashes; changing one bound body changes exactly its hash', () => {
    const first = validateSubject('cmd024-a');
    const second = validateSubject('cmd024-b');
    assert.deepEqual(second, first, 'the same subject, validated twice, gives the same evidence');
    for (const [name, value] of Object.entries(first)) assert.ok(value.length > 0, `${name} is present`);

    // A different attestation body (a later expiry, signed again): its own hash moves; the package does not embed it.
    const reissued = validateSubject('cmd024-attestation', {
      attestation: attestation(issuer.privateKey, { expiresAt: '2026-10-02T00:00:00Z' }),
    });
    assert.notEqual(reissued.attestation, first.attestation);
    assert.deepEqual({ ...reissued, attestation: '' }, { ...first, attestation: '' }, 'nothing else moved');

    // A different configuration body: its hash moves, and so does the package that carries config.normalized.json.
    const reconfigured = validateSubject('cmd024-config', {
      configOverride: (config) => {
        config['policies'] = { ...((config['policies'] ?? {}) as Record<string, unknown>), formulaCachedValues: 'ACCEPT_WITH_PROVENANCE' };
      },
    });
    assert.notEqual(reconfigured.configuration, first.configuration);
    assert.notEqual(reconfigured.packageDigest, first.packageDigest);
    assert.equal(reconfigured.attestation, first.attestation);
    assert.equal(reconfigured.contract, first.contract);
    assert.equal(reconfigured.coreVersion, first.coreVersion);
  });

  it('[CMD024-engine] a subject that was altered after validation never verifies: an invalid receipt is never VALID', () => {
    // Under A5 the engine's half of "invalid receipts never VALID" is that the
    // verdict the receipt would carry (VerificationReport.passed) is false for
    // every package that is not the one the evidence names, and that its
    // evidence no longer matches.
    const where = { value: '' };
    const evidence = validateSubject('cmd024-tamper', { packageDirOut: where });
    const packageDir = where.value;
    const imports = readdirSync(packageDir, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.csv') && name.includes('01_IMPORT'))
      .sort();
    assert.ok(imports.length > 0, 'the package has an import file to alter');
    const target = join(packageDir, imports[0] ?? '');
    writeFileSync(target, `${readFileSync(target, 'utf8')}forged,row
`, 'utf8');
    const verdict = verifyPackage(packageDir, { scratch: verifyScratch(packageDir) });
    assert.equal(verdict.passed, false);
    assert.ok(verdict.problems.length > 0, 'the refusal says why');
    assert.notEqual(packageDigest(packageDir).digest, evidence.packageDigest, 'and the evidence no longer names it');
  });
});
