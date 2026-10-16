/**
 * B03 post-acceptance engine fixes found by the B04 corpus work. Every case
 * runs the public run() with the real Migration Core in the host's validation
 * port and the labelled scripted gateway (evidence class SIMULATED).
 */
import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { classifyValue } from '../src/index.js';
import { adaptContracts } from '../src/adapter/contract-adapter.js';
import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import type { IntelligenceResult } from '../src/api/intelligence-core.js';
import type { DeterministicCandidate, IntelligenceEnvelopeV1, TaskType } from '../src/contracts/envelope.js';
import type { ProposalItem } from '../src/contracts/proposal.js';
import { cleanOnlyTargetRef } from '../src/contracts/envelope.js';
import { MODEL_POLICY_VERSION, PROMPT_BUNDLE_VERSION, PROPOSAL_SCHEMA_VERSION } from '../src/contracts/versions.js';
import { scriptedGateway } from '../src/gateway/fake-gateway.js';
import type { ScriptEntry, ScriptPayload, ScriptedGateway } from '../src/gateway/fake-gateway.js';
import { VirtualClock } from '../src/kernel/ledger.js';
import type { FullDatasetValidationResult, IntelligenceInput, ProjectRevision } from '../src/ports/ports.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort } from './support/fixtures.js';
import type { Bundle, FixtureValidationPort } from './support/fixtures.js';

const TIMEOUT = { timeout: 180_000 };
type Answer = (candidate: DeterministicCandidate, envelope: IntelligenceEnvelopeV1) => Partial<ProposalItem> | null;
type Script = Partial<Record<TaskType | 'default', ScriptEntry | readonly ScriptEntry[]>>;

const abstention = (candidate: DeterministicCandidate): ProposalItem => ({ candidateRef: candidate.candidateRef, proposalType: 'ABSTAIN', targetRef: null, transformPrimitive: null, typedTransformParams: null, evidenceRefs: candidate.evidenceRefs.slice(0, 32), requiresAgencyDecision: false, rationaleCode: 'INSUFFICIENT_EVIDENCE', shortRationale: null, alternatives: [], abstainReason: 'INSUFFICIENT_EVIDENCE' });

const answering = (answer: Answer): ScriptEntry => ({
  kind: 'proposal',
  build: (envelope: IntelligenceEnvelopeV1, payload: ScriptPayload) => ({
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    taskId: payload.taskId,
    runId: payload.runId,
    modelPolicyVersion: MODEL_POLICY_VERSION,
    promptBundleVersion: PROMPT_BUNDLE_VERSION,
    envelopeHash: payload.envelopeHash,
    items: envelope.deterministicCandidates.map((candidate) => ({ ...abstention(candidate), ...(answer(candidate, envelope) ?? {}) })),
    overallOutcome: 'MIXED',
  }),
});

interface Ran {
  readonly result: IntelligenceResult;
  readonly port: FixtureValidationPort;
  readonly gateway: ScriptedGateway;
  readonly field: (file: string, header: string) => string;
  readonly target: (destination: string) => string;
}

/** One CLEAN_ONLY run over a two-file bundle whose record id columns are Email and Name. */
async function cleanOnlyRun(name: string, contacts: string, script: (ran: Pick<Ran, 'field' | 'target'>) => Script, check: (ran: Ran) => void | Promise<void>, companies = 'Name\nAnalytical Engines\nCOBOL Works\n', tamper?: (receipt: FullDatasetValidationResult) => FullDatasetValidationResult): Promise<void> {
  const made = makeBundle(name, { contacts, companies });
  const bundle = { ...made, files: made.files.map((file) => ({ ...file, idHeader: file.object === 'CONTACT' ? (contacts.startsWith('Email') ? 'Email' : 'Contact ID') : 'Name' })) };
  try {
    const profiled = profileBundle(bundle, 'CLEAN_ONLY');
    const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
    const field = (file: string, header: string): string => {
      const found = [...contracts.refs.fieldByRef.entries()].find(([, entry]) => entry.filePath === file && entry.header === header)?.[0];
      assert.ok(found !== undefined, `${file} has a column ${header}`);
      return found;
    };
    const target = (destination: string): string => {
      const found = [...contracts.refs.targetByRef.entries()].find(([, info]) => info.destinationField === destination)?.[0];
      assert.ok(found !== undefined, `the canonical fields carry ${destination}`);
      return found;
    };
    const clock = new VirtualClock();
    const port = realValidationPort(bundle, profiled.profile, null, { clock });
    if (tamper !== undefined) {
      const honest = port.validate.bind(port);
      port.validate = async (configuration) => tamper(await honest(configuration));
    }
    const gateway = scriptedGateway({ default: answering(() => null), ...script({ field, target }) });
    const base = inputFor('CLEAN_ONLY', profiled, null);
    const projectRevision = { ...base.projectRevision, declaredObjects: { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' } } as ProjectRevision;
    const input: IntelligenceInput = { ...base, projectRevision };
    const result = await createIntelligenceCore(depsFor(gateway, port, clock)).run(input, CONTEXT);
    await check({ result, port, gateway, field, target });
  } finally {
    bundle.dispose();
  }
}

describe('B03 post-acceptance engine fixes', () => {
  it('FIX1: a CLEAN_ONLY column the model maps is typed from its full-data shape, so the typed transform the candidate offered applies and the run is not lost', TIMEOUT, async () => {
    await cleanOnlyRun(
      'fix1',
      'Contact ID,Correo\n1,ADA@Kauro-Fixture.test\n2,Grace@Kauro-Fixture.test\n',
      ({ field, target }) => ({
        FIELD_MAPPING: answering((candidate) => (candidate.sourceRefs.includes(field('contacts.csv', 'Correo')) && candidate.allowedPrimitiveRefs.includes('NORMALISE_EMAIL_CASE') ? { proposalType: 'MAP_FIELD', targetRef: target('contact.email'), transformPrimitive: 'NORMALISE_EMAIL_CASE', typedTransformParams: null, rationaleCode: 'SHAPE_MATCHES_TARGET_TYPE', abstainReason: null } : null)),
      }),
      ({ result, port }) => {
        assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
        const loaded = ((port.lastLoaded?.normalizedJson as { records: { fields: { destinationField: string; semanticType: string }[] }[] }).records).flatMap((record) => record.fields).find((entry) => entry.destinationField === 'contact.email');
        assert.equal(loaded?.semanticType, 'EMAIL');
      },
    );
  });
});

describe('B03 post-acceptance engine fixes: empty lines', () => {
  it('FIX2: a fully empty CSV line is the profile rejected row, so the validation coverage still holds and the run reaches a draft', TIMEOUT, async () => {
    await cleanOnlyRun('fix2', 'Email,Phone\nada@kauro-fixture.test,612-345-678\n\ngrace@kauro-fixture.test,622-334-455\n', () => ({}), ({ result, port }) => {
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.equal(result.draft.fullValidation?.ok, true);
      // The empty line is counted where the profile counted it: rejected, not delivered and not hidden.
      assert.equal(port.calls, 1);
    });
  });
  it('FIX2 negative control: with an empty line in the file, a validation that covered one data row fewer than the file holds is still refused', TIMEOUT, async () => {
    await cleanOnlyRun(
      'fix2-short',
      'Email,Phone\nada@kauro-fixture.test,612-345-678\n\ngrace@kauro-fixture.test,622-334-455\n',
      () => ({}),
      ({ result }) => {
        assert.notEqual(result.state, 'PROPOSAL_READY');
        assert.ok(result.unresolvedItems.some((item) => item.codes.includes('VALIDATION_COVERAGE_INCOMPLETE')), JSON.stringify(result.unresolvedItems));
      },
      undefined,
      (receipt) => ({ ...receipt, rowsValidated: receipt.rowsValidated - 1 }),
    );
  });
});

const valueIn = (header: string, value: string): string => classifyValue(value, { header, distinctCount: 4, rowCount: 40, shapeCandidates: [] }).dataClass;

describe('B03 post-acceptance engine fixes: person-name headers', () => {
  it('FIX3: a header naming an object or a label (StageName, Account Name, Company Name, Product Name) is not person data, so its values can reach the value-map question', () => {
    for (const header of ['StageName', 'Stage Name', 'Account Name', 'AccountName', 'Company Name', 'Product Name', 'Deal Name', 'Pipeline Name']) {
      assert.equal(valueIn(header, 'Won'), 'SAFE_LOW_CARDINALITY_SEMANTICS', header);
    }
  });

  it('FIX3 negative control: a person-name column, or an ambiguous bare name, still masks its values', () => {
    for (const header of ['FirstName', 'First Name', 'LastName', 'Full Name', 'Contact Name', 'Name', 'Surname', 'Customer Name', 'Account Owner Name', 'Company Contact Name', 'Nombre', 'Apellido']) {
      assert.equal(valueIn(header, 'Won'), 'POTENTIAL_PII', header);
    }
  });
});

describe('B03 post-acceptance engine fixes: invisible characters in headers', () => {
  /** The headers the FIELD_MAPPING request shows for the file's columns, as the envelope carries them. */
  async function shownHeaders(header: string): Promise<readonly string[]> {
    let shown: readonly string[] = [];
    await cleanOnlyRun(
      'fix4',
      'Contact ID,' + header + '\n1,ADA@Kauro-Fixture.test\n2,Grace@Kauro-Fixture.test\n',
      () => ({
        FIELD_MAPPING: answering((candidate, envelope) => {
          shown = envelope.sourceProfile.fields.map((entry) => entry.header);
          return null;
        }),
      }),
      ({ gateway }) => {
        assert.ok(gateway.requests.some((request) => request.envelope.taskType === 'FIELD_MAPPING'));
      },
    );
    return shown;
  }

  it('FIX4: a BOM or a zero-width space in a header is dropped from the identity the facts carry, so the header is shown and can support a mapping', TIMEOUT, async () => {
    for (const [name, header] of [['zero-width space', 'Corr\u200beo'], ['byte-order mark', '\ufeffCorreo']] as const) {
      const shown = await shownHeaders(header);
      assert.ok(shown.includes('Correo'), name + ': ' + JSON.stringify(shown));
    }
  });

  it('FIX4 negative control: normalising hides nothing — a bidirectional control stays masked, and an email address split by a zero-width space is classified as the email it is and masked', TIMEOUT, async () => {
    for (const header of ['Correo\u202e', 'ada\u200b@kauro-fixture.test']) {
      const shown = await shownHeaders(header);
      assert.ok(shown.some((entry) => entry.startsWith('hdr_')) && shown.every((entry) => !entry.includes('Correo') && !entry.includes('kauro-fixture')), JSON.stringify([header, shown]));
    }
  });
});

describe('B03 post-acceptance engine fixes: a consistency preserve of an association', () => {
  const CONTACTS = 'Contact ID,Email,Company Name\n1,ada@kauro-fixture.test,C1\n2,grace@kauro-fixture.test,C2\n';
  const COMPANIES = 'Company ID,Industry\nC1,Software\nC2,Banking\n';
  const DEALS = 'Deal ID,Name,Company ID\nD1,Engine Sale,C1\nD2,Loom Sale,C2\n';

  /** One CLEAN_ONLY run over contacts, companies and deals: the model links both Company ID columns (two associations), maps the contacts one as a field too, and the review answers by `choose`. */
  async function associationRun(name: string, choose: (claims: readonly { candidateRef: string; decisionRef: string; kind: string }[], associationRefs: ReadonlyMap<string, string>, key: string) => string | null, check: (ran: { locatorOf: (fieldRef: string) => string; result: IntelligenceResult; port: FixtureValidationPort; associationRefs: ReadonlyMap<string, string>; contactsKey: string; dealsKey: string; reviewed: boolean }) => void): Promise<void> {
    const base = makeBundle(name, { contacts: CONTACTS, companies: COMPANIES });
    writeFileSync(join(base.root, 'deals.csv'), DEALS);
    const bundle: Bundle = { ...base, files: [...base.files, { id: 'deals', path: 'deals.csv', idHeader: 'Deal ID', object: 'COMPANY' }] };
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
      const fieldOf = (file: string, header: string): string => {
        const found = [...contracts.refs.fieldByRef.entries()].find(([, entry]) => entry.filePath === file && entry.header === header)?.[0];
        assert.ok(found !== undefined, `${file} has a column ${header}`);
        return found;
      };
      const contactsKey = fieldOf('contacts.csv', 'Company Name');
      const dealsKey = fieldOf('deals.csv', 'Company ID');
      const associationRefs = new Map<string, string>();
      let reviewed = false;
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const gateway = scriptedGateway({
        default: answering(() => null),
        ASSOCIATION_MAPPING: answering((candidate) => {
          if (candidate.allowedTargetRefs.length !== 1) return null;
          associationRefs.set(candidate.sourceRefs[0] as string, candidate.candidateRef);
          return { proposalType: 'MAP_ASSOCIATION', targetRef: candidate.allowedTargetRefs[0] as string, rationaleCode: 'FOREIGN_KEY_COLUMN', abstainReason: null };
        }),
        CONSISTENCY_REVIEW: {
          kind: 'proposal',
          build: (envelope: IntelligenceEnvelopeV1, payload: ScriptPayload) => {
            reviewed = true;
            const claims = (envelope as unknown as { reviewClaims?: { candidateRef: string; decisionRef: string; kind: string }[] }).reviewClaims ?? [];
            const dropped = choose(claims, associationRefs, contactsKey);
            return {
              schemaVersion: PROPOSAL_SCHEMA_VERSION,
              taskId: payload.taskId,
              runId: payload.runId,
              modelPolicyVersion: MODEL_POLICY_VERSION,
              promptBundleVersion: PROMPT_BUNDLE_VERSION,
              envelopeHash: payload.envelopeHash,
              items: envelope.deterministicCandidates.map((candidate) => ({ ...abstention(candidate), ...(dropped === null ? {} : { proposalType: 'UNMAPPED_PRESERVE', targetRef: dropped, rationaleCode: 'INSUFFICIENT_EVIDENCE', abstainReason: null }) })),
              overallOutcome: 'MIXED',
            };
          },
        },
      });
      const base2 = inputFor('CLEAN_ONLY', profiled, null);
      const projectRevision = { ...base2.projectRevision, declaredObjects: { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY', 'deals.csv': 'DEAL' }, recordIdColumns: { 'contacts.csv': 'Contact ID', 'companies.csv': 'Company ID', 'deals.csv': 'Deal ID' } } as ProjectRevision;
      const result = await createIntelligenceCore(depsFor(gateway, port, clock)).run({ ...base2, projectRevision }, CONTEXT);
      check({ locatorOf: (fieldRef) => contracts.refs.fieldByRef.get(fieldRef)?.locator ?? '', result, port, associationRefs, contactsKey, dealsKey, reviewed });
    } finally {
      bundle.dispose();
    }
  }

  it('FIX5: an association the consistency review preserves is not delivered, the claim is recorded as preserved by the review, and the association the review did not touch stays (B03 design D3-CAP-11, evidence-ranked preserve)', TIMEOUT, async () => {
    await associationRun(
      'fix5',
      (claims, refs, key) => claims.find((claim) => claim.decisionRef === refs.get(key))?.decisionRef ?? null,
      ({ result, port, associationRefs, contactsKey, dealsKey, reviewed }) => {
        assert.ok(reviewed, 'a review ran: ' + JSON.stringify([result.state, result.tasks.map((task) => [task.taskType, task.outcome]), result.draft.decisionsRequired]));
        const configuration = result.draft.configuration;
        assert.ok(configuration !== null);
        const touched = associationRefs.get(contactsKey) as string;
        const kept = associationRefs.get(dealsKey) as string;
        assert.deepEqual(configuration.associations.map((association) => association.decisionRef), [kept], 'only the association the review did not touch is delivered');
        assert.equal((port.lastLoaded?.normalizedJson as { associations?: unknown[] }).associations?.length, 1, 'Migration Core received one association');
        const disposition = ((result as unknown as { candidateAccounting?: { dispositions: { candidateRef: string; disposition: string; code: string }[] } }).candidateAccounting?.dispositions ?? []).find((entry) => entry.candidateRef === touched);
        assert.deepEqual([disposition?.disposition, disposition?.code], ['PRESERVED', 'CONSISTENCY_REVIEW'], JSON.stringify(disposition));
      },
    );
  });

  it('FIX5 negative control: when the review preserves nothing, both associations are delivered', TIMEOUT, async () => {
    await associationRun(
      'fix5-control',
      () => null,
      ({ result, port, associationRefs, contactsKey, dealsKey, reviewed }) => {
        assert.ok(reviewed, 'the review ran');
        const delivered = (result.draft.configuration?.associations ?? []).map((association) => association.decisionRef).sort();
        assert.deepEqual(delivered, [associationRefs.get(contactsKey) as string, associationRefs.get(dealsKey) as string].sort());
        assert.equal((port.lastLoaded?.normalizedJson as { associations?: unknown[] }).associations?.length, 2);
      },
    );
  });
});
