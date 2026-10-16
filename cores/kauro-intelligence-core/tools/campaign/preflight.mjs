// What a funded stage needs before the first byte leaves (B04-CAMPAIGN, D4-CAMP-4, D4-POL-3):
//   1. a campaign grant that is a grant, is not expired and funds this stage;
//   2. the scorer-validity record for the CURRENT scorer and corpus digests that opens the funded stage;
//   3. the free Bedrock probes P1-P8 (aws-probes.mjs, owner decision A9): caller account, us. profile and member regions, model,
//      model invocation logging OFF in the source region (the one recognised shape; anything else is UNKNOWN and refused),
//      Price List equal to the tariff, quotas at least the plan, and the recorded retention page;
//   and, read from disk before any network: the grant's ledger is neither locked, stopped nor another grant's (D4-CAMP-6), and
//   the sealed corpus carries no contamination latch (D4-CAMP-7).
// The checks run in this order and the network is asked only when 1 and 2 stand. The result lists every refusal found.
// Validity v4 (mandate 4.5, S044): the record must also name this tree's prompt bundle, model policy and Migration Core release here, and
// rerunValidity() reruns scorer-validity.mjs inside the clean install a funded stage runs from (run.mjs calls it after the install,
// once per stage): a release binding that differs refuses VALIDITY_STALE before any control is run; a rerun whose record differs from
// the committed one in any member refuses VALIDITY_STALE too.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BEDROCK_DEFAULT_REGION, BEDROCK_REGIONS, MODEL_POLICY_HASH, PROMPT_BUNDLE_HASH, VERTEX_HOST, VERTEX_LOCATION, campaignGrantProblems, validityRecordProblems } from 'kauro-intelligence-core/benchmark';
import { packAndInstall } from './clean-install.mjs';
import { PROFILES, readRetentionEvidence, runProbes } from './aws-probes.mjs';
import { latchedCorpus } from './contamination.mjs';
import { inspectGrantLedger, ledgerPathOf } from './grant-ledger.mjs';
import { currentScorerDigest, loadCorpus } from './validity-run.mjs';

export const STAGE_OF = Object.freeze({ smoke: 'SMOKE', pilot: 'PILOT', qualify: 'QUALIFICATION' });
const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
/** Where the contamination latch of the sealed corpus is kept unless a test names another file (gitignored campaign state). */
export const DEFAULT_LATCH_PATH = join(repo, 'campaign', 'state', 'contamination-latch.json');

const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

/** GET of the publisher model's logging configuration; readBack is null with the reason when it cannot be read back. */
export async function readBackLogging({ project, modelId, token, fetchImpl }) {
  const url = `https://${VERTEX_HOST}/v1/projects/${encodeURIComponent(project)}/locations/${VERTEX_LOCATION}/publishers/anthropic/models/${encodeURIComponent(modelId)}:fetchPublisherModelConfig`;
  let response;
  try { response = await fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } }); } catch (error) { return { readBack: null, reason: `the request failed (${error instanceof Error ? error.name : 'error'})`, url }; }
  const text = await response.text();
  if (response.status !== 200) return { readBack: null, reason: `status ${String(response.status)}`, url };
  let body;
  try { body = JSON.parse(text); } catch { return { readBack: null, reason: 'the answer is not JSON', url }; }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { readBack: null, reason: 'the answer is not a record', url };
  const logging = loggingOf(body);
  return { readBack: { evidenceClass: 'EXECUTED_PROVIDER', url, modelId, requestResponseLogging: logging.state, bodyDigest: createHash('sha256').update(text).digest('hex') }, reason: logging.reason, url };
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** The members of a PublisherModelConfig and of its LoggingConfig this runner recognises (Vertex v1); any other member is unknown. */
const CONFIG_MEMBERS = Object.freeze(['loggingConfig']);
const LOGGING_MEMBERS = Object.freeze(['enabled', 'samplingRate', 'bigqueryDestination', 'enableOtelLogging']);

/**
 * OFF only in the one recognised shape: a config of known members whose loggingConfig is a record of known members with enabled
 * the boolean false. ON when enabled is the boolean true. Anything else (no loggingConfig, an empty one, a string, an unknown
 * member) is UNKNOWN, and a stage is never admitted on UNKNOWN (Codex B04-R5, D4-POL-3).
 */
export function loggingOf(body) {
  const unknown = (why) => ({ state: 'UNKNOWN', reason: `the logging configuration is not a recognised shape: ${why}` });
  const extra = Object.keys(body).filter((key) => !CONFIG_MEMBERS.includes(key));
  if (extra.length > 0) return unknown(`unknown member ${extra.sort().join(',')}`);
  const config = body.loggingConfig;
  if (!isRecord(config)) return unknown('no loggingConfig record');
  const extraLogging = Object.keys(config).filter((key) => !LOGGING_MEMBERS.includes(key));
  if (extraLogging.length > 0) return unknown(`unknown loggingConfig member ${extraLogging.sort().join(',')}`);
  if (config.enabled === true) return { state: 'ON', reason: null };
  if (config.enabled === false) return { state: 'OFF', reason: null };
  return unknown('loggingConfig.enabled is not a boolean');
}

/**
 * @param {{ stage: string, region?: string, candidate?: string, awsAccountId?: string, grantPath?: string | null, validityPath?: string | null, corpusDir?: string, latchPath?: string, credentialProvider?: Function, fetchImpl?: Function, now?: () => number, plan?: { requestsPerMinute: number, tokensPerMinute: number }, retentionEvidencePath?: string, stageStartedAt?: number }} options
 */
export async function preflight(options) {
  const refusals = [];
  const refuse = (code, detail) => { refusals.push({ code, detail }); };
  const stage = STAGE_OF[options.stage];
  if (stage === undefined) { refuse('UNKNOWN_STAGE', String(options.stage)); return { ok: false, refusals, loggingReadBack: null, probes: null, grant: null }; }
  const now = (options.now ?? Date.now)();

  let grant = null;
  if (options.grantPath === undefined || options.grantPath === null) refuse('NO_GRANT', "no --grant file: a funded stage needs the owner's campaign grant");
  else {
    grant = readJson(resolve(options.grantPath));
    if (grant === null) refuse('NO_GRANT', `${String(options.grantPath)} is not a readable grant file`);
    else {
      const problems = campaignGrantProblems(grant);
      if (problems.length > 0) refuse('GRANT_INVALID', problems.join('; '));
      else {
        if (now >= Date.parse(grant.expiresAt)) refuse('GRANT_EXPIRED', `expired at ${grant.expiresAt}`);
        if (!grant.stages.includes(stage)) refuse('GRANT_DOES_NOT_FUND_STAGE', `${grant.grantId} funds ${grant.stages.join(',')}, not ${stage}`);
        const ledger = inspectGrantLedger(ledgerPathOf(options.grantPath), grant);
        if (ledger !== null) refuse(ledger.code, ledger.detail);
      }
    }
  }

  const corpusDir = resolve(repo, options.corpusDir ?? 'corpus');
  let sealedDigest = null;
  try { sealedDigest = loadCorpus(corpusDir).manifest.corpusDigest; } catch { /* refused below with the validity record */ }
  if (sealedDigest !== null) {
    const latch = latchedCorpus(options.latchPath ?? DEFAULT_LATCH_PATH, sealedDigest);
    if (latch !== null) refuse(latch.code, latch.detail);
  }
  const record = options.validityPath === undefined || options.validityPath === null ? null : readJson(resolve(options.validityPath));
  if (record === null) refuse('NO_VALIDITY_RECORD', 'no scorer-validity record: run tools/campaign/scorer-validity.mjs (no model, no network) first');
  else {
    let corpusDigest = null;
    try { corpusDigest = loadCorpus(corpusDir).manifest.corpusDigest; } catch { refuse('NO_CORPUS', `no sealed corpus in ${corpusDir}`); }
    if (corpusDigest !== null) {
      const vendor = readJson(join(repo, 'vendor', 'MANIFEST.json'));
      const release = { promptBundleHash: PROMPT_BUNDLE_HASH, modelPolicyHash: MODEL_POLICY_HASH, migrationCoreVersion: vendor?.version, migrationCoreTarballSha256: vendor?.sha256 };
      const problems = validityRecordProblems(record, { scorerDigest: currentScorerDigest(), corpusDigest, release });
      if (problems.length > 0) refuse('VALIDITY_RECORD_REFUSED', problems.join('; '));
      else if (record.opensFundedStage !== true) refuse('VALIDITY_RECORD_REFUSED', 'the record does not open the funded stage');
    }
  }

  if (refusals.length > 0) return { ok: false, refusals, loggingReadBack: null, probes: null, grant };
  // A rehearsal over a stand-in seam (plan rehearsal, chaos layer): the grant, ledger, latch and validity record above were checked as
  // for a funded stage; the AWS reads (probes P1-P6) are not made, because no AWS account is behind a seam. The read-back is synthetic
  // and says so; the stage labels every run over a seam SIMULATED, so this never opens a funded stage on a provider.
  if (options.simulated === true) return { ok: true, refusals, loggingReadBack: { evidenceClass: 'SIMULATED', requestResponseLogging: 'OFF', synthetic: true }, probes: null, grant };
  // Amazon Bedrock only (owner decision A9): the Vertex read-back below stays in the file for the retired wire and is not asked.
  const region = options.region ?? BEDROCK_DEFAULT_REGION;
  if (!BEDROCK_REGIONS.includes(region)) refuse('REGION_NOT_US', `${String(region)}: the campaign calls a us. geography profile from ${BEDROCK_REGIONS.join(' or ')}`);
  if (PROFILES[options.candidate] === undefined) refuse('UNKNOWN_CANDIDATE', String(options.candidate));
  if (typeof options.awsAccountId !== 'string' || !/^[0-9]{12}$/u.test(options.awsAccountId)) refuse('NO_AWS_ACCOUNT', 'the AWS account the grant is for (--aws-account, 12 digits) is required: probe P1 compares the caller with it');
  if (refusals.length > 0) return { ok: false, refusals, loggingReadBack: null, probes: null, grant };
  let credentials;
  try { credentials = await options.credentialProvider(); } catch { refuse('NO_CREDENTIAL', 'the AWS credential source failed; its text is withheld (aws sso login, then aws configure export-credentials)'); return { ok: false, refusals, loggingReadBack: null, probes: null, grant }; }
  const probed = await runProbes({ region, candidate: options.candidate, awsAccountId: options.awsAccountId, credentials, fetchImpl: options.fetchImpl ?? globalThis.fetch, now: options.now ?? Date.now, ...(options.plan === undefined ? {} : { plan: options.plan }), retentionEvidence: readRetentionEvidence(options.retentionEvidencePath), ...(options.stageStartedAt === undefined ? {} : { stageStartedAt: options.stageStartedAt }) });
  for (const one of probed.refusals) refuse(one.code, one.detail);
  return { ok: refusals.length === 0, refusals, loggingReadBack: probed.loggingReadBack, probes: probed.probes, grant };
}

const RELEASE_MEMBERS = Object.freeze(['icPackageDigest', 'migrationCoreVersion', 'migrationCoreTarballSha256', 'promptBundleHash', 'modelPolicyHash']);
const short = (value) => (typeof value === 'string' && value.length > 16 ? value.slice(0, 12) : String(value));

/**
 * Validity v4: reruns tools/campaign/scorer-validity.mjs inside a clean install of `icTarball` (the one given in `project`, or a new one)
 * against the committed `record`. First the release binding of what is installed (package content digest, Migration Core version and
 * tarball, prompt bundle, model policy): any member that differs refuses VALIDITY_STALE and no control is run. Then (unless
 * `bindingOnly`) every control over the corpus: a fresh record that differs from the committed one in any member refuses
 * VALIDITY_STALE. A rerun that cannot run refuses VALIDITY_RERUN_FAILED. No model, no network.
 * @param {{ record: Record<string, unknown> | null, corpusDir?: string, icTarball: string, project?: string | null, outPath?: string | null, bindingOnly?: boolean }} options
 */
export function rerunValidity({ record, corpusDir = 'corpus', icTarball, project = null, outPath = null, bindingOnly = false }) {
  const work = project === null ? mkdtempSync(join(tmpdir(), 'kauro-ic-validity-rerun-')) : null;
  const failed = (detail) => ({ stale: true, refusals: [{ code: 'VALIDITY_RERUN_FAILED', detail }], binding: null, fresh: null });
  try {
    const where = project ?? packAndInstall({ work, tarball: resolve(icTarball) }).project;
    const vendor = readJson(join(repo, 'vendor', 'MANIFEST.json'));
    if (vendor === null) return failed('vendor/MANIFEST.json is not readable');
    const tool = (extra) => spawnSync(process.execPath, [join('tools', 'campaign', 'scorer-validity.mjs'), '--ic-tarball', resolve(icTarball), '--mc-tarball', join(repo, vendor.file), '--scorer-digest', currentScorerDigest(), '--corpus', resolve(repo, corpusDir), ...extra], { cwd: where, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const bound = tool(['--binding-only']);
    let binding;
    try { binding = JSON.parse(bound.stdout); } catch { return failed(`the binding of the clean install could not be read (exit ${String(bound.status)}): ${String(bound.stderr).slice(-300)}`); }
    const differing = RELEASE_MEMBERS.filter((member) => record?.[member] !== binding[member]);
    if (differing.length > 0) return { stale: true, refusals: [{ code: 'VALIDITY_STALE', detail: `the record binds another release than the clean install: ${differing.map((member) => `${member} record ${short(record?.[member])} installed ${short(binding[member])}`).join('; ')}` }], binding, fresh: null };
    if (bindingOnly) return { stale: false, refusals: [], binding, fresh: null };
    const out = outPath ?? join(work ?? where, 'validity-rerun.json');
    const ran = tool(['--out', out]);
    if (!existsSync(out)) return failed(`scorer-validity.mjs wrote no record in the clean install (exit ${String(ran.status)}): ${String(ran.stderr).slice(-300)}`);
    const fresh = readJson(out);
    if (fresh === null) return failed('the rerun record is not JSON');
    const members = [...new Set([...Object.keys(record ?? {}), ...Object.keys(fresh)])].sort();
    const changed = members.filter((member) => JSON.stringify(record?.[member]) !== JSON.stringify(fresh[member]));
    if (changed.length > 0) return { stale: true, refusals: [{ code: 'VALIDITY_STALE', detail: `the scorer-validity rerun in the clean install differs from the committed record in ${changed.join(', ')}` }], binding, fresh };
    return { stale: false, refusals: [], binding, fresh };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  } finally {
    if (work !== null) rmSync(work, { recursive: true, force: true });
  }
}
