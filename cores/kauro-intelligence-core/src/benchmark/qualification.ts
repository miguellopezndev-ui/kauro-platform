/**
 * Subject and independence of the three funded runs (B04 D4-CAMP-2, D4-CAMP-3; manual 06 §Qualification).
 *
 * A report says how a run scored. It says nothing about what was evaluated or
 * whether the run happened: a run record binds a report to the subject it was
 * run on (the nine fields of D4-CAMP-2), to the identity of the receipts that
 * back it (provider message ids, request digests, the digest of the whole set)
 * and to the evidence class of the run. `qualifyThreeRuns` here is the public
 * qualification: the report arithmetic of OPUS-Q1 (report.ts, unchanged and
 * under the scorer digest) over the three reports, plus
 *   - one subject for all three, every field of it, and no served-model change
 *     among the receipts of any run (a run that shows one is invalid, never averaged);
 *   - receipt sets pairwise disjoint in provider message ids and in request digests,
 *     each equal to the receipts presented for it (a copied run shares receipts);
 *   - evidence EXECUTED_PROVIDER only: SIMULATED and REPLAY runs are never runs of
 *     the qualification. A replay re-scores stored responses; it carries the label
 *     REPLAY and never creates a run;
 *   - provenance (D4-CAMP-8, Codex B04-R3): the receipts presented are whole (their
 *     bytes digest to what they claim, an answer's id and model are its body's),
 *     belong to the report's own run ids, were sent to the subject's model and
 *     location at the rawPredict endpoint, pair every answer with its request, and
 *     hold at least one successful exchange with a provider message id. An empty
 *     set of ids or served models never passes vacuously;
 *   - every evaluated run is substantiated (Codex re-check of B04-R3): each run id
 *     of the report has its own paired successful exchange whose request parses as
 *     a provider request of this build carrying that run id, the subject's prompt
 *     bundle hash, policy hash and model; no answer is counted for two runs. A run
 *     the core decided without the model (it sent nothing) is declared offline in
 *     the record, with its fixture, carries no exchange, and the three runs declare
 *     the same offline fixtures (determinism); any other run without its exchange
 *     makes the report invalid. Offline is proven, never taken on the record's word:
 *     the record binds every run id to its fixture under its digest, and the caller
 *     hands the replay of the fixtures through the same core with a transport that
 *     refuses every send (tools/campaign/offline-replay.mjs); a declared offline
 *     fixture the replay did not cover or saw send is refused, and so is a fixture
 *     the replay decided without a request that carries exchanges.
 * Pure and offline; the receipts are the transport's protected receipts.
 */
import { digestOf, sha256Hex } from '../contracts/canonical.js';
import { responseReceipt } from '../provider/vertex-receipts.js';
import type { ProtectedReceipt } from '../provider/vertex-receipts.js';
import { BEDROCK_ANTHROPIC_VERSION, BEDROCK_REGIONS } from '../provider/bedrock-wire.js';
import { OPUS_5_5_US, SONNET_5_5_US } from '../gateway/candidates.js';
import { parseProviderRequestPayload } from '../gateway/transport-gateway.js';
import type { ProviderRequestPayload } from '../gateway/transport-gateway.js';
import { qualifyThreeRuns as qualifyReportArithmetic } from './report.js';
import type { BenchmarkReport, Qualification } from './report.js';

/** The nine fields of D4-CAMP-2; every report of a campaign run binds exactly these. */
export const SUBJECT_FIELDS = Object.freeze(['servedModel', 'location', 'modelPolicyHash', 'promptBundleHash', 'compilerContractVersion', 'migrationCoreVersion', 'icPackageDigest', 'scorerDigest', 'corpusDigest'] as const);

export interface QualificationSubject {
  readonly servedModel: string;
  readonly location: string;
  readonly modelPolicyHash: string;
  readonly promptBundleHash: string;
  readonly compilerContractVersion: string;
  readonly migrationCoreVersion: string;
  readonly icPackageDigest: string;
  readonly scorerDigest: string;
  readonly corpusDigest: string;
}

const HASH_FIELDS: readonly (typeof SUBJECT_FIELDS)[number][] = ['modelPolicyHash', 'promptBundleHash', 'icPackageDigest', 'scorerDigest', 'corpusDigest'];
const SHA256 = /^[0-9a-f]{64}$/u;
const MODEL_ID = /^[a-z][a-z0-9.-]{0,63}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/u;

/** Why a value is not a subject; empty when it is. */
export function subjectProblems(subject: unknown): readonly string[] {
  if (subject === null || typeof subject !== 'object' || Array.isArray(subject)) return ['the subject is not a record'];
  const record = subject as Record<string, unknown>;
  const problems: string[] = [];
  for (const field of SUBJECT_FIELDS) {
    const value = record[field];
    if (typeof value !== 'string' || value === '') problems.push(`${field} is missing`);
    else if (HASH_FIELDS.includes(field) && !SHA256.test(value)) problems.push(`${field} is not a sha-256 digest`);
    else if (field === 'servedModel' && !MODEL_ID.test(value)) problems.push('servedModel is not a model id');
    else if (!HASH_FIELDS.includes(field) && field !== 'servedModel' && !TOKEN.test(value)) problems.push(`${field} is not a short token`);
  }
  for (const key of Object.keys(record)) if (!(SUBJECT_FIELDS as readonly string[]).includes(key)) problems.push(`${key} is not a subject field`);
  return problems;
}

/** What a run is: a funded run of the provider, a run over scripted answers, or stored responses scored again. */
export type RunEvidence = 'EXECUTED_PROVIDER' | 'SIMULATED' | 'REPLAY';

/** The identity of the receipts behind a run: digests and ids only, never a byte of a prompt or a provider body. */
export interface ReceiptSetSummary {
  readonly requests: number;
  readonly responses: number;
  /** Provider message ids of the answers (200), sorted and unique. */
  readonly providerMessageIds: readonly string[];
  /** SHA-256 of every request body, sorted and unique. */
  readonly requestDigests: readonly string[];
  /** The served model of every answer, sorted and unique; UNREPORTED where a 200 named none. */
  readonly servedModels: readonly string[];
  readonly receiptSetDigest: string;
}

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();

export function summarizeReceipts(receipts: readonly ProtectedReceipt[]): ReceiptSetSummary {
  const ids: string[] = [];
  const digests: string[] = [];
  const models: string[] = [];
  let requests = 0;
  let responses = 0;
  const identities: string[] = [];
  for (const receipt of receipts) {
    if (receipt.kind === 'REQUEST') {
      requests += 1;
      digests.push(receipt.bodySha256);
      identities.push(JSON.stringify(['REQUEST', receipt.bodySha256, receipt.idempotencyRef]));
    } else {
      responses += 1;
      if (receipt.status === 200) {
        if (receipt.providerMessageId !== null) ids.push(receipt.providerMessageId);
        models.push(receipt.servedModel ?? 'UNREPORTED');
      }
      identities.push(JSON.stringify(['RESPONSE', receipt.status, receipt.providerMessageId, receipt.bodyDigest]));
    }
  }
  return { requests, responses, providerMessageIds: sortedUnique(ids), requestDigests: sortedUnique(digests), servedModels: sortedUnique(models), receiptSetDigest: digestOf(identities.sort()) };
}

export interface RunRecord {
  readonly report: BenchmarkReport;
  readonly subject: QualificationSubject;
  readonly evidence: RunEvidence;
  readonly receipts: ReceiptSetSummary;
  /** The runs the core decided without the model (no request left), with their fixtures, sorted by run id. */
  readonly offline: readonly OfflineRun[];
  /** Every run of the report with the fixture it evaluated (from the scores), sorted by run id. */
  readonly runFixtures: readonly OfflineRun[];
  /** Over the report's digest, the subject, the evidence, the receipts' identity and the offline runs: an edited record no longer matches. */
  readonly runDigest: string;
}

/** A run of the report that sent no provider request: the deterministic core decided it. */
export interface OfflineRun {
  readonly runId: string;
  readonly fixtureId: string;
}

const runDigestOf = (run: Pick<RunRecord, 'report' | 'subject' | 'evidence' | 'receipts' | 'offline' | 'runFixtures'>): string => digestOf({ reportDigest: run.report.reportDigest, subject: run.subject, evidence: run.evidence, receipts: run.receipts, offline: run.offline, runFixtures: run.runFixtures });

/** What the replay of fixtures through the core, with a transport that refuses every send, showed: the fixtures replayed, and those decided with zero requests. */
export interface OfflineReplay {
  readonly replayed: readonly string[];
  readonly offline: readonly string[];
}

/** Binds a report to its subject, its evidence class, the receipts that back it and the runs that sent nothing. */
export function bindRun(report: BenchmarkReport, binding: { readonly subject: QualificationSubject; readonly evidence: RunEvidence; readonly receipts: readonly ProtectedReceipt[]; readonly offline?: readonly OfflineRun[]; readonly runFixtures?: readonly OfflineRun[] }): RunRecord {
  const sorted = (pairs: readonly OfflineRun[]): OfflineRun[] => [...pairs].map((one) => ({ runId: one.runId, fixtureId: one.fixtureId })).sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  const offline = sorted(binding.offline ?? []);
  const body = { report, subject: binding.subject, evidence: binding.evidence, receipts: summarizeReceipts(binding.receipts), offline, runFixtures: sorted(binding.runFixtures ?? []) };
  return { ...body, runDigest: runDigestOf(body) };
}

/** The provider request a Bedrock InvokeModel request body carries, read by this build's own payload guard; null when it is none or of another wire. */
function payloadOf(bytes: string, servedModel: string, expectedVersion: string): ProviderRequestPayload | null {
  try {
    const body: unknown = JSON.parse(bytes);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
    const { anthropic_version: version, ...rest } = body as Record<string, unknown>;
    if (version !== expectedVersion || 'model' in rest) return null;
    return parseProviderRequestPayload(JSON.stringify({ model: servedModel, ...rest }));
  } catch {
    return null;
  }
}

const shortList = (values: readonly string[]): string => `${values.slice(0, 5).join(',')}${values.length > 5 ? ',…' : ''}`;

/** What is wrong with one run record on its own; empty when nothing is. */
function runProblems(run: RunRecord, label: string): readonly string[] {
  if (run === null || typeof run !== 'object' || run.report === undefined || run.subject === undefined || run.receipts === undefined || run.evidence === undefined) return [`${label}_NO_SUBJECT_OR_RECEIPTS`];
  const problems: string[] = [];
  if (runDigestOf(run) !== run.runDigest) problems.push(`${label}_RECORD_DIGEST_MISMATCH:${String(run.runDigest)}`);
  const subject = subjectProblems(run.subject);
  if (subject.length > 0) problems.push(`${label}_SUBJECT_INVALID:${subject.join(',')}`);
  const changed = run.receipts.servedModels.filter((model) => model !== run.subject.servedModel);
  if (changed.length > 0) problems.push(`${label}_SERVED_MODEL_CHANGED_MID_RUN:${changed.join(',')}`);
  if (run.evidence === 'REPLAY') problems.push(`${label}_REPLAY_IS_NOT_A_RUN`);
  else if (run.evidence !== 'EXECUTED_PROVIDER') problems.push(`${label}_NOT_EXECUTED_PROVIDER_EVIDENCE:${String(run.evidence)}`);
  if (run.receipts.requests === 0 || run.receipts.responses === 0) problems.push(`${label}_NO_RECEIPTS`);
  // Nothing passes vacuously: a run with no answer carrying a provider message id, or no served model, had no successful exchange.
  if (!Array.isArray(run.receipts.providerMessageIds) || run.receipts.providerMessageIds.length === 0 || !Array.isArray(run.receipts.servedModels) || run.receipts.servedModels.length === 0) problems.push(`${label}_NO_SUCCESSFUL_EXCHANGE`);
  return problems;
}

/** The us. geography inference profile of a shipped candidate's model (D4-BR-1); null for any other model. */
const inferenceProfileOf = (servedModel: string): string | null => [SONNET_5_5_US, OPUS_5_5_US].find((profile) => profile.modelId === servedModel)?.inferenceProfileId ?? null;
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * What ties the receipts presented for one run to that run: whole receipts, of the report's run ids, at the subject's endpoint,
 * every answer paired with its request, and at least one successful exchange. Empty when they do.
 */
function provenanceProblems(run: RunRecord, receipts: readonly ProtectedReceipt[], label: string, replay: OfflineReplay | undefined): readonly string[] {
  if (run?.report === undefined || run.subject === undefined) return [];
  const problems: string[] = [];
  const runIds = new Set(Array.isArray(run.report.runIds) ? run.report.runIds : []);
  // Amazon Bedrock (A9): InvokeModel of the served model's us. profile from a US source region, location us, with a bedrock-2023-05-31
  // body. The retired Vertex rawPredict endpoint is not accepted: a request there is no request to the subject's endpoint.
  const profileId = run.subject.location === 'us' ? inferenceProfileOf(run.subject.servedModel) : null;
  const endpoint = profileId === null ? { test: (): boolean => false } : new RegExp(`^https://bedrock-runtime\\.(?:${BEDROCK_REGIONS.map(escaped).join('|')})\\.amazonaws\\.com/model/${escaped(encodeURIComponent(profileId))}/invoke$`, 'u');
  const foreign = new Set<string>();
  const elsewhere = new Set<string>();
  let bodiless = 0;
  let notTheirs = 0;
  const asked = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.runId === null || !runIds.has(receipt.runId)) foreign.add(String(receipt.runId));
    if (receipt.kind === 'REQUEST') {
      if (!endpoint.test(receipt.url)) elsewhere.add(sha256Hex(receipt.url).slice(0, 12));
      if (receipt.bodyBytes === '') bodiless += 1;
      else if (sha256Hex(receipt.bodyBytes) !== receipt.bodySha256) notTheirs += 1;
      if (receipt.idempotencyRef !== null) asked.add(JSON.stringify([receipt.runId, receipt.idempotencyRef]));
    } else if (receipt.bodyText === '') bodiless += 1;
    else {
      const again = responseReceipt({ status: receipt.status, headers: receipt.headers, bodyText: receipt.bodyText, bodyLength: receipt.bodyLength, truncated: receipt.truncated, latencyMs: receipt.latencyMs, idempotencyRef: receipt.idempotencyRef, runId: receipt.runId });
      if (again.bodyDigest !== receipt.bodyDigest || again.providerMessageId !== receipt.providerMessageId || again.servedModel !== receipt.servedModel) notTheirs += 1;
    }
  }
  // Every request is read as a provider request: of its own run, under the subject's bundle, policy and model.
  const boundRequest = new Set<string>();
  let unparsable = 0;
  let otherRun = 0;
  let otherSubject = 0;
  for (const receipt of receipts) {
    if (receipt.kind !== 'REQUEST' || receipt.bodyBytes === '') continue;
    const payload = payloadOf(receipt.bodyBytes, run.subject.servedModel, BEDROCK_ANTHROPIC_VERSION);
    if (payload === null) unparsable += 1;
    else if (payload.runId !== receipt.runId) otherRun += 1;
    else if (payload.promptRef.promptBundleHash !== run.subject.promptBundleHash || payload.policyRef.modelPolicyHash !== run.subject.modelPolicyHash || payload.model !== run.subject.servedModel) otherSubject += 1;
    else if (receipt.idempotencyRef !== null) boundRequest.add(JSON.stringify([receipt.runId, receipt.idempotencyRef]));
  }
  let successful = 0;
  let unpaired = 0;
  let idless = 0;
  const substantiated = new Set<string>();
  const answeredBy = new Map<string, string>();
  const countedTwice = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.kind !== 'RESPONSE') continue;
    const pairKey = JSON.stringify([receipt.runId, receipt.idempotencyRef]);
    const paired = receipt.idempotencyRef !== null && asked.has(pairKey);
    if (!paired) unpaired += 1;
    if (receipt.status === 200 && receipt.providerMessageId === null) idless += 1;
    if (receipt.status === 200 && receipt.providerMessageId !== null) {
      // One provider answer is one exchange: it backs one request of one run, never two.
      const first = answeredBy.get(receipt.providerMessageId);
      if (first !== undefined && first !== pairKey) countedTwice.add(receipt.providerMessageId);
      answeredBy.set(receipt.providerMessageId, pairKey);
    }
    if (paired && receipt.status === 200 && receipt.providerMessageId !== null) {
      successful += 1;
      if (boundRequest.has(pairKey) && receipt.runId !== null) substantiated.add(receipt.runId);
    }
  }
  // Every evaluated run: substantiated by its own exchange, or declared offline with none.
  const offline = Array.isArray(run.offline) ? run.offline : [];
  const offlineIds = new Set(offline.map((one) => one.runId));
  const sentBy = new Set(receipts.map((receipt) => receipt.runId));
  const offlineForeign = offline.filter((one) => !runIds.has(one.runId)).map((one) => one.runId);
  const offlineSent = offline.filter((one) => sentBy.has(one.runId)).map((one) => one.runId);
  const unsubstantiated = [...runIds].filter((id) => !substantiated.has(id) && !offlineIds.has(id)).sort();
  if (unparsable > 0) problems.push(`${label}_REQUEST_NOT_A_PROVIDER_REQUEST:${String(unparsable)}`);
  if (otherRun > 0) problems.push(`${label}_REQUEST_NOT_OF_ITS_RUN:${String(otherRun)}`);
  if (otherSubject > 0) problems.push(`${label}_REQUEST_NOT_OF_THE_SUBJECT:${String(otherSubject)} request(s) under another prompt bundle, policy or model`);
  if (countedTwice.size > 0) problems.push(`${label}_EXCHANGE_COUNTED_TWICE:${shortList([...countedTwice].sort())}`);
  if (offlineForeign.length > 0) problems.push(`${label}_OFFLINE_RUN_NOT_OF_REPORT:${shortList(offlineForeign)}`);
  if (offlineSent.length > 0) problems.push(`${label}_OFFLINE_RUN_WITH_EXCHANGES:${shortList(offlineSent)}`);
  // Every run names its fixture, and the mapping is the report's runs one to one.
  const runFixtures = Array.isArray(run.runFixtures) ? run.runFixtures : [];
  const fixtureOf = new Map(runFixtures.map((one) => [one.runId, one.fixtureId]));
  const mapped = fixtureOf.size === runFixtures.length && runFixtures.length === runIds.size && [...runIds].every((id) => fixtureOf.has(id)) && new Set(runFixtures.map((one) => one.fixtureId)).size === runFixtures.length;
  if (!mapped) problems.push(`${label}_RUN_FIXTURES_NOT_BOUND:${String(runFixtures.length)} run-to-fixture pairs for ${String(runIds.size)} runs`);
  if (offline.some((one) => fixtureOf.get(one.runId) !== one.fixtureId)) problems.push(`${label}_OFFLINE_FIXTURE_NOT_ITS_RUN`);
  // Offline is proven by the replay, never declared: covered, decided with zero requests, and no replay-offline fixture carries exchanges.
  if (offline.length > 0 && replay === undefined) problems.push(`${label}_OFFLINE_NOT_PROVEN:${String(offline.length)} declared offline run(s) and no replay`);
  if (replay !== undefined) {
    const replayed = new Set(replay.replayed);
    const replayOffline = new Set(replay.offline);
    const unproven = offline.filter((one) => !replayed.has(one.fixtureId)).map((one) => one.fixtureId);
    const wouldSend = offline.filter((one) => replayed.has(one.fixtureId) && !replayOffline.has(one.fixtureId)).map((one) => one.fixtureId);
    const sentAnyway = runFixtures.filter((one) => replayOffline.has(one.fixtureId) && sentBy.has(one.runId)).map((one) => one.fixtureId);
    if (unproven.length > 0) problems.push(`${label}_OFFLINE_NOT_PROVEN:${shortList(unproven.sort())}`);
    if (wouldSend.length > 0) problems.push(`${label}_DECLARED_OFFLINE_WOULD_SEND:${shortList(wouldSend.sort())}`);
    if (sentAnyway.length > 0) problems.push(`${label}_REPLAY_OFFLINE_FIXTURE_WITH_EXCHANGES:${shortList(sentAnyway.sort())}`);
  }
  if (unsubstantiated.length > 0) problems.push(`${label}_RUNS_NOT_SUBSTANTIATED:${String(unsubstantiated.length)} of ${String(runIds.size)}: ${shortList(unsubstantiated)}`);
  if (foreign.size > 0) problems.push(`${label}_RECEIPTS_NOT_OF_REPORT_RUNS:${shortList([...foreign].sort())}`);
  if (elsewhere.size > 0) problems.push(`${label}_RECEIPTS_NOT_FOR_SUBJECT_ENDPOINT:${String(elsewhere.size)} endpoint(s) other than ${run.subject.servedModel} in ${run.subject.location}`);
  if (bodiless > 0) problems.push(`${label}_RECEIPT_BODIES_NOT_PRESENTED:${String(bodiless)}`);
  if (notTheirs > 0) problems.push(`${label}_RECEIPT_NOT_ITS_BODY:${String(notTheirs)}`);
  if (unpaired > 0) problems.push(`${label}_UNPAIRED_EXCHANGE:${String(unpaired)} answer(s) to no request of the run`);
  if (idless > 0) problems.push(`${label}_ANSWER_WITHOUT_PROVIDER_MESSAGE_ID:${String(idless)}`);
  if (successful === 0) problems.push(`${label}_NO_SUCCESSFUL_EXCHANGE`);
  return problems;
}

/**
 * OPUS-Q1 over three funded runs: the report arithmetic, one subject, receipts of their own, evidence of the provider.
 * `onDisk` are the receipts as the host's store holds them, one set per run in the same order; each must be the set its
 * run's digest says. Nothing is qualified without them.
 */
export function qualifyThreeRuns(runs: readonly RunRecord[], onDisk?: readonly (readonly ProtectedReceipt[])[], replay?: OfflineReplay): Qualification {
  const reasons: string[] = [];
  let invalid = false;
  const complete = runs.every((run) => run !== null && typeof run === 'object' && run.report !== undefined);
  const base = qualifyReportArithmetic(complete ? runs.map((run) => run.report) : []);
  reasons.push(...(complete ? base.reasons : [`THREE_RUNS_REQUIRED:${String(runs.length)}`]));

  runs.forEach((run, index) => {
    const found = runProblems(run, `RUN_${String(index + 1)}`);
    if (found.length > 0) invalid = true;
    reasons.push(...found);
  });

  const usable = runs.filter((run) => run?.subject !== undefined && run.receipts !== undefined);
  // One subject, field by field.
  const differing = SUBJECT_FIELDS.filter((field) => new Set(usable.map((run) => (run.subject as unknown as Record<string, unknown>)[field])).size > 1);
  if (differing.length > 0) {
    invalid = true;
    reasons.push(`SUBJECTS_DIFFER:${differing.join(',')}`);
  }

  // Receipt identity: no provider message id and no request body is in two runs.
  const sharedOf = (pick: (run: RunRecord) => readonly string[]): string[] => {
    const owner = new Map<string, number>();
    const shared = new Set<string>();
    usable.forEach((run, index) => {
      for (const value of pick(run)) {
        const seen = owner.get(value);
        if (seen !== undefined && seen !== index) shared.add(value);
        owner.set(value, index);
      }
    });
    return [...shared].sort();
  };
  const sharedIds = sharedOf((run) => run.receipts.providerMessageIds);
  const sharedDigests = sharedOf((run) => run.receipts.requestDigests);
  const sharing: string[] = [];
  if (sharedIds.length > 0) sharing.push(`provider message ids shared: ${shortList(sharedIds)}`);
  if (sharedDigests.length > 0) sharing.push(`request digests shared: ${shortList(sharedDigests)}`);
  if (sharing.length > 0) {
    invalid = true;
    reasons.push(`RUNS_NOT_INDEPENDENT:${sharing.join('; ')}`);
  }

  // A run the core decides without the model is decided so in every run: the three records declare the same offline fixtures.
  const offlineSets = usable.map((run) => JSON.stringify((Array.isArray(run.offline) ? run.offline : []).map((one) => one.fixtureId).sort()));
  if (new Set(offlineSets).size > 1) {
    invalid = true;
    reasons.push(`OFFLINE_FIXTURES_DIFFER:${usable.map((run) => String((Array.isArray(run.offline) ? run.offline : []).length)).join('/')}`);
  }

  // The receipts on disk are the ones each report bound.
  if (onDisk === undefined || onDisk.length !== runs.length) {
    invalid = true;
    reasons.push('RECEIPTS_NOT_PRESENTED');
  } else {
    runs.forEach((run, index) => {
      const presented = summarizeReceipts(onDisk[index] ?? []);
      if (run?.receipts === undefined || presented.receiptSetDigest !== run.receipts.receiptSetDigest) {
        invalid = true;
        reasons.push(`RUN_${String(index + 1)}_RECEIPTS_DO_NOT_MATCH_DIGEST:${presented.receiptSetDigest}`);
      }
      const unproven = provenanceProblems(run, onDisk[index] ?? [], `RUN_${String(index + 1)}`, replay);
      if (unproven.length > 0) {
        invalid = true;
        reasons.push(...unproven);
      }
    });
  }

  const unique = [...new Set(reasons)];
  return { qualified: unique.length === 0, reasons: unique, meanSupportedCorrectness: invalid || !complete ? null : base.meanSupportedCorrectness };
}
