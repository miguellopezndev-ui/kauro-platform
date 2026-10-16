// The run side of scorer validity (B04-SCORER): materialises a sealed corpus fixture as the input a real run takes
// (the planted source profiled by the frozen data plane, the planted target contract, the planted memory), runs the public
// core over it behind a SIMULATED scripted transport, and hands back the result and the egress record taken at the
// transport. No network and no paid inference. Run `npm run build` first: this reads the compiled framework from dist/.
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATTESTATION_ALGORITHM, ATTESTATION_CONTRACT_VERSION, CORE_VERSION, SCRATCH_BUDGET_BYTES, attestationSigningBytes, buildCandidateSet,
  createFilesystemScratchStore, loadConfig, produceSourceProfile, runMigration, verifyPackage, writePackage,
} from 'kauro-migration-core';
import { MODEL_POLICY_VERSION, MemoryDispatchAdmission, MemoryLedgerStore, PROMPT_BUNDLE_VERSION, VirtualClock, capturingTransport, cleanOnlyTargetRef, createIntelligenceCore, digestOf, effectsFromMigrationRun, observeEgress, parseProviderRequestPayload, scorerDigestOf, toMigrationConfig, transportGateway, vendorTargetRefFor } from 'kauro-intelligence-core/benchmark';
import { fileURLToPath } from 'node:url';
import { contractOf, profileSource } from '../corpus/bind.mjs';
import { ATTESTATION_INSTANT, AUTHORITY, attestationFor } from '../corpus/attest.mjs';

const repo = join(fileURLToPath(new URL('../..', import.meta.url)));
/** The scorer and its controls, as source: what a change to either must invalidate. */
export const SCORER_FILES = ['src/benchmark/scorer.ts', 'src/benchmark/fixture.ts', 'src/benchmark/report.ts', 'src/benchmark/validity.ts', 'src/benchmark/truth-answer.ts'];
export const currentScorerDigest = () => scorerDigestOf(SCORER_FILES.map((path) => ({ path, text: readFileSync(join(repo, path), 'utf8') })));

const csvCell = (text) => (/[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text);
/** The corpus a directory holds: its manifest and every fixture file, read as the sealed bytes they are. */
export function loadCorpus(dir) {
  const manifestBytes = readFileSync(join(dir, 'MANIFEST.json'), 'utf8');
  const fixturesDir = join(dir, 'fixtures');
  const fixtures = readdirSync(fixturesDir).filter((name) => name.endsWith('.json')).sort().map((name) => JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')));
  return { manifest: JSON.parse(manifestBytes), manifestBytes, fixtures };
}

const TENANT = { agencyId: 'agency-a', clientId: 'client-1' };
/**
 * The target ref a stored memory convention names in this run's target: an agency's memory holds the ref of the instance it was
 * verified on, so a planted canonical field is stored as the ref the run's contract gives that field (CLEAN_ONLY: the canonical ref).
 * A ref the planted entry gives verbatim (another instance's, a foreign one) is kept as it is.
 */
function targetRefsOf(planted, contract) {
  const refs = new Map();
  if (planted.mode === 'CLEAN_ONLY') {
    for (const object of planted.objects) for (const field of object.fields) refs.set(`${object.name}.${field.name}`, cleanOnlyTargetRef(`${object.name}.${field.name}`));
    return refs;
  }
  planted.objects.forEach((object, i) => object.fields.forEach((field, j) => {
    const vendor = contract.contract.objects[i];
    const view = vendor?.fields[j];
    if (vendor !== undefined && view !== undefined) refs.set(`${object.name}.${field.name}`, vendorTargetRefFor(planted.mode, vendor.apiName, view.apiName));
  }));
  return refs;
}

const memoryEntry = (planted, refs = new Map()) => {
  const owner = planted.owner;
  const tenant = owner === 'OTHER_CLIENT' ? { agencyId: TENANT.agencyId, clientId: 'client-other' } : owner === 'OTHER_AGENCY' ? { agencyId: 'agency-other', clientId: 'client-other' }
    : planted.scope === 'GLOBAL' ? { agencyId: null, clientId: null } : planted.scope === 'AGENCY' ? { agencyId: TENANT.agencyId, clientId: null } : { agencyId: TENANT.agencyId, clientId: TENANT.clientId };
  return {
    memoryId: planted.memoryId, scope: planted.scope, tenant, knowledgeType: 'FIELD_MAPPING_CONVENTION',
    ruleOrPattern: { sourceHeaderPattern: planted.sourceHeaderPattern, targetRef: planted.targetField === null ? null : (refs.get(planted.targetField) ?? planted.targetField), semanticType: null },
    sourceProjectRef: 'proj-corpus', sourcePlanVersion: '1', targetInstanceRef: null, targetSchemaVersion: null, approvedBy: 'agency-a:operator',
    verificationOutcome: 'IMPORT_VERIFIED', provenance: 'corpus', createdAt: '2026-08-01T00:00:00Z', lastUsedAt: null, status: planted.state, version: 1,
  };
};

/** The input a fixture's planted facts stand for, with the bundle it is validated against; the profile must be the one the fixture sealed. */
export function materialise(corpusFixture, options = {}) {
  const planted = corpusFixture.structure;
  const root = mkdtempSync(join(tmpdir(), 'b04-validity-'));
  try {
    // The planted files, profiled by the frozen data plane exactly as the generator bound them (bind.mjs).
    const { files, profile, candidateSet } = profileSource(root, planted);
    const contract = contractOf(planted);
    // The project's declarations (planted beside the source): the file's object, unless the fixture asks for it, the locale and the record id column.
    const project = planted.project;
    const declaredObject = options.declaredObject !== undefined ? options.declaredObject : (project?.object ?? null);
    // A fixture of several files declares the object and the record id column of each by its path (planted beside the source).
    const declaredObjects = project?.files === undefined
      ? (declaredObject === null ? {} : { 'source.csv': declaredObject })
      : Object.fromEntries(Object.entries(project.files).filter(([, declared]) => declared.object !== null).map(([path, declared]) => [path, declared.object]));
    const recordIdColumns = project?.files === undefined
      ? (project?.recordIdColumn === undefined ? {} : { 'source.csv': project.recordIdColumn })
      : Object.fromEntries(Object.entries(project.files).filter(([, declared]) => declared.recordIdColumn !== undefined).map(([path, declared]) => [path, declared.recordIdColumn]));
    // The host's categorical summaries: the distinct values of every column the template planted as categorical (ENUM), by the column's locator.
    const summaries = new Map(files.flatMap((file) => {
      const columns = profile.profile.files.find((entry) => entry.path === file.path)?.sheets[0].columns ?? [];
      return file.columns.flatMap((column, index) => (column.valueClass === 'ENUM' && columns[index] !== undefined ? [[columns[index].columnLocatorId, [...new Set(column.values.filter((value) => value !== ''))]]] : []));
    }));
    const input = {
      projectRevision: {
        projectRevisionId: 'rev-1', projectRevisionHash: digestOf(['rev-1', profile.profileHash]), mode: planted.mode, supportEnvelopeVersion: '2.0.1',
        ...(Object.keys(declaredObjects).length === 0 ? {} : { declaredObjects }),
        ...(project?.locale === undefined ? {} : { localeEvidence: { ...project.locale } }),
        ...(Object.keys(recordIdColumns).length === 0 ? {} : { recordIdColumns }),
      },
      sourceProfile: profile, candidateSet, targetContract: contract, ...(summaries.size === 0 ? {} : { categoricalSummaries: summaries }),
      scopedMemorySnapshot: (planted.memory ?? []).map((entry) => memoryEntry(entry, targetRefsOf(planted, contract))),
      policyBundle: { modelPolicyVersion: MODEL_POLICY_VERSION, promptBundleVersion: PROMPT_BUNDLE_VERSION }, resourceProfile: {},
    };
    return { root, input, profile, contract, targets: targetRefsOf(planted, contract), dispose: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

/** The host's validation adapter over the materialised bundle: the real frozen engine, as the product's own test host does. */
function validationPort(bundle, clock) {
  const { root, profile, contract } = bundle;
  const port = { calls: 0, clock };
  port.validate = async (configuration) => {
    port.calls += 1;
    const bound = { configurationRef: configuration.configurationRef, configurationDigest: digestOf(configuration), profileHash: profile.profileHash, candidateSetHash: configuration.candidateSetHash, targetContractHash: contract?.contractHash ?? null, rowsInProfile: profile.profile.totals.dataRowCount, validatedAt: clock.now(), coreVersion: CORE_VERSION };
    const translation = toMigrationConfig(configuration, profile);
    if (translation.document === null) return { ...bound, ok: false, rowsValidated: 0, reconciliationHolds: false, packageVerified: false, problems: translation.problems, evidence: { packageDigest: null, reportDigest: null, coreConfigHash: null }, effects: null };
    const loaded = loadConfig(JSON.stringify(translation.document), join(root, 'candidate-config.json'));
    const runStore = createFilesystemScratchStore({ root: join(root, `scratch-run-${String(port.calls)}`), runId: `run${String(port.calls)}`, quotaBytes: SCRATCH_BUDGET_BYTES });
    const verifyStore = createFilesystemScratchStore({ root: join(root, `scratch-verify-${String(port.calls)}`), runId: `verify${String(port.calls)}`, quotaBytes: SCRATCH_BUDGET_BYTES });
    try {
      const result = runMigration({ inputRoot: root, config: loaded.config, configHash: loaded.configHash, scratch: runStore, sourceProfile: profile, ...(contract === null ? {} : { targetContract: contract, targetAttestation: attestationFor(contract), attestationAuthorities: [AUTHORITY], attestationInstant: ATTESTATION_INSTANT }) });
      const effects = effectsFromMigrationRun({ loaded, run: result });
      const written = writePackage({ result, config: loaded.config, normalizedConfig: loaded.normalizedJson, outputDir: join(root, `package-${String(port.calls)}`), force: true });
      const report = verifyPackage(written.stagingDir, { scratch: verifyStore });
      const holds = result.reconciliation.sourceRows.equationHolds;
      const problems = [...(holds ? [] : ['RECONCILIATION_EQUATION_FAILED']), ...(report.passed ? [] : report.problems.map((problem) => problem.check))];
      return { ...bound, ok: problems.length === 0, rowsValidated: result.reconciliation.sourceRows.total, reconciliationHolds: holds, packageVerified: report.passed, problems, evidence: { packageDigest: written.manifestSha256, reportDigest: digestOf({ passed: report.passed, checks: report.checks, problems: report.problems, artifactCount: report.artifactCount, sourceRows: report.sourceRows }), coreConfigHash: loaded.configHash }, effects };
    } finally { runStore.dispose(); verifyStore.dispose(); }
  };
  return port;
}

const TARIFF = Object.freeze({ tariffRef: 'VALIDITY_TARIFF_SIMULATED_NOT_A_PRICE', inputMicrosPerToken: 1, outputMicrosPerToken: 5, allowanceMicros: 200_000 });
const EGRESS_KEY = Object.freeze({ keyId: 'egress-key-validity', secret: Buffer.alloc(32, 7) });

/**
 * One public run of the core over a materialised fixture behind the gateway and the admission the caller hands in (the funded stages
 * hand the Vertex gateway and the campaign admission; the controls hand the SIMULATED one). The clock is the caller's.
 */
export async function runThroughCore(bundle, { gateway, dispatchAdmission, tariff, clock, sleep, attempt, candidatePolicy, tenant = TENANT, egressKey = EGRESS_KEY }) {
  const port = validationPort(bundle, clock);
  const core = createIntelligenceCore({ gateway, validationPort: port, ledgerStore: new MemoryLedgerStore(), clock, egressKey, tariff, dispatchAdmission, sleep, ...(candidatePolicy === undefined ? {} : { candidatePolicy }) });
  return core.run(bundle.input, { tenant, actor: 'campaign', auditAttemptId: attempt });
}

/**
 * One public run of the core over a materialised fixture, behind `answer(envelope, payload)`: a SIMULATED scripted
 * transport that builds the model's reply from the request bytes alone. Returns the result and the egress record.
 */
export async function runThroughPublicCore(bundle, answer, attempt, onRequestBytes) {
  let answered = 0;
  const transport = async (request) => {
    const bytes = JSON.stringify(request);
    if (onRequestBytes !== undefined) onRequestBytes(request, bytes);
    const payload = parseProviderRequestPayload(bytes);
    const text = JSON.stringify(answer(payload.envelope, { runId: payload.runId, taskId: payload.taskId, envelopeHash: payload.envelopeHash }));
    answered += 1;
    return { status: 200, body: { id: `msg_validity_${String(answered)}`, type: 'message', role: 'assistant', model: payload.model, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text }], usage: { input_tokens: Math.ceil(bytes.length / 4), output_tokens: Math.ceil(text.length / 4) } } };
  };
  const captured = capturingTransport(transport);
  const clock = new VirtualClock();
  const port = validationPort(bundle, clock);
  const core = createIntelligenceCore({
    gateway: transportGateway(captured.transport, { evidenceClass: 'SIMULATED' }), validationPort: port, ledgerStore: new MemoryLedgerStore(), clock, egressKey: EGRESS_KEY, tariff: TARIFF,
    dispatchAdmission: new MemoryDispatchAdmission({ fundedMicros: 1_000_000_000_000 }), sleep: async (ms) => { clock.advance(ms); },
  });
  const result = await core.run(bundle.input, { tenant: TENANT, actor: 'validity', auditAttemptId: attempt });
  return { result, observed: observeEgress(result.runId, captured.bodies) };
}

/**
 * The public-run controls over a corpus: per fixture, the truth-following answer and the always-abstaining candidate (three runs)
 * through the real core behind the SIMULATED scripted transport, each scored by the scorer under test.
 *
 * The host declares what the project planted beside the source: the file's object (null for a fixture that tests the object choice), the
 * locale and the record id column; the engine will not map a column to a field of an object nobody stated or decided.
 * A fixture whose truth the engine cannot reach is reported as such, with the checks that failed and the codes the run ended with.
 */
export async function runPublicControls(corpusFixtures, options = {}) {
  const { truthFollowingAnswer, alwaysAbstainAnswer, sealedObject } = await import('kauro-intelligence-core/benchmark');
  const { scoreFixture } = await import('kauro-intelligence-core/benchmark');
  const abstainRuns = options.abstainRuns ?? 3;
  const publicRun = [];
  const alwaysAbstainRuns = Array.from({ length: abstainRuns }, () => []);
  const scoresOfTruth = [];
  /** The truth-following run of each fixture (result and egress record): the positive control and the base its sabotage mutates. */
  const truthRuns = new Map();
  /** The repair controls (D3-CAP-12): a first answer that is not a proposal, then the truth-following answer to the repair round. */
  const repairControls = [];
  for (const corpusFixture of corpusFixtures) {
    const fixture = corpusFixture.fixture;
    // The project declares the file's object (planted); a fixture planted before the project member existed falls back to the object of its truth.
    const declaredObject = corpusFixture.structure.project !== undefined ? corpusFixture.structure.project.object : fixture.expectedTaskTypes.includes('OBJECT_MAPPING') ? null : sealedObject(fixture);
    const bundle = materialise(corpusFixture, { declaredObject });
    try {
      let truth;
      try {
        truth = await runThroughPublicCore(bundle, (envelope, identity) => truthFollowingAnswer(fixture, envelope, identity, bundle.targets), `attempt-truth-${fixture.fixtureId}`);
      } catch (error) {
        // A run that throws reached nothing: it is reported with its code, never taken for a scorer verdict.
        publicRun.push({ fixtureId: fixture.fixtureId, family: fixture.family, capability: corpusFixture.structure.capability, correct: false, scorerFailure: null, failedChecks: ['RUN_THREW'], engineCodes: [`THREW:${error instanceof Error ? error.message.slice(0, 160) : String(error)}`] });
        continue;
      }
      truthRuns.set(fixture.fixtureId, truth);
      const score = scoreFixture(fixture, truth.result, truth.observed);
      scoresOfTruth.push(score);
      const codes = [...new Set([...truth.result.tasks.flatMap((task) => [task.outcome, ...task.codes]), ...truth.result.unresolvedItems.flatMap((item) => [item.outcome, ...item.codes])])];
      publicRun.push({ fixtureId: fixture.fixtureId, family: fixture.family, capability: corpusFixture.structure.capability, correct: score.correct, scorerFailure: score.scorerFailure, failedChecks: score.checks.filter((check) => !check.pass).map((check) => check.check), engineCodes: codes });
      if (corpusFixture.structure.capability === 'CAP12' && options.repair !== false) {
        let first = true;
        let repairRounds = 0;
        const repaired = await runThroughPublicCore(bundle, (envelope, identity) => {
          if (envelope.taskType === 'SEMANTIC_REPAIR') repairRounds += 1;
          const proposal = truthFollowingAnswer(fixture, envelope, identity, bundle.targets);
          if (!first) return proposal;
          first = false;
          // The first answer names a candidate the task does not carry: no proposal, one repair.
          return { ...proposal, items: proposal.items.map((item) => ({ ...item, candidateRef: 'cand_0000000000000000' })) };
        }, `attempt-repair-${fixture.fixtureId}`);
        repairControls.push({ fixtureId: fixture.fixtureId, correct: scoreFixture(fixture, repaired.result, repaired.observed).correct, repairRounds });
      }
      for (let index = 0; index < abstainRuns; index += 1) {
        const abstained = await runThroughPublicCore(bundle, (envelope, identity) => alwaysAbstainAnswer(envelope, identity), `attempt-abstain-${String(index + 1)}-${fixture.fixtureId}`);
        alwaysAbstainRuns[index].push(scoreFixture(fixture, abstained.result, abstained.observed));
      }
    } finally {
      bundle.dispose();
      if (options.onProgress !== undefined) options.onProgress(publicRun.length, corpusFixtures.length);
    }
  }
  return { publicRun, alwaysAbstainRuns, scoresOfTruth, truthRuns, repairControls };
}
