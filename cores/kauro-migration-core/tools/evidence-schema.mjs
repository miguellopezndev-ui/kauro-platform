/**
 * Typed validation of every record a gate consumes.
 *
 * The release-candidate gate, the architecture gate and the provenance tool
 * used to read evidence by reaching into it: a regex over a field name to guess
 * a unit (MC-2 item 6), a prose pattern over a `detail` string to decide whether
 * a case really passed (item 12), a `.filter(x => x.value === false)` over an
 * object whose values were booleans (item 17), `problems.push()` with nothing
 * in it (item 5). Each of those is a way a record can be accepted without
 * carrying what the acceptance claims it carries. This module is the one place
 * the shape of each record is stated, and every consumer validates before it
 * reads.
 *
 * Every function returns a list of problems. An empty list means the record has
 * the shape claimed; it says nothing about whether the values are good — that
 * is the gate's job, after the shape is settled.
 */
import { UNIVERSE_STEP_IDS, universeReportProblems } from './universe-inventory.mjs';

export const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
export const HEX64 = /^[0-9a-f]{64}$/u;
export const CAMPAIGN_ID = /^c_[0-9a-f]{16}$/u;

/** How far ahead of `now` an instant may be before it is a future date. Clock skew between machines, not a grace period. */
export const FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Field names that name a display unit. A capacity record is denominated in
 * bytes and milliseconds; a field called `peakMb`, `peak_mib` or `sizeGB` is
 * refused whatever it holds, because the one thing that must never happen is a
 * mebibyte compared against a byte budget (it did: `peakMb` was bytes divided
 * by 1024 twice, compared against a budget written the other way).
 */
const UNIT_SUFFIX = /(?:^|[^A-Za-z])(?:[kmgt]i?b)$/iu;
const UNIT_CAMEL = /(?:[a-z0-9])(?:Kb|Kib|KB|KiB|Mb|Mib|MB|MiB|Gb|Gib|GB|GiB|Tb|Tib|TB|TiB)$/u;

export function unitFieldProblems(value, path = '') {
  const problems = [];
  if (Array.isArray(value)) {
    value.forEach((entry, index) => problems.push(...unitFieldProblems(entry, `${path}[${String(index)}]`)));
    return problems;
  }
  if (value === null || typeof value !== 'object') return problems;
  for (const [key, entry] of Object.entries(value)) {
    const here = path === '' ? key : `${path}.${key}`;
    if (UNIT_SUFFIX.test(key) || UNIT_CAMEL.test(key)) problems.push(`${here} is denominated in a display unit rather than bytes`);
    problems.push(...unitFieldProblems(entry, here));
  }
  return problems;
}

/**
 * An ISO-8601 UTC instant to the second, not in the future.
 *
 * @param {unknown} value
 * @param {{now?: string, label: string}} options `now` is passed in by the gate so the same evidence gets the same verdict on replay
 */
export function instantProblems(value, { now, label }) {
  if (typeof value !== 'string' || !UTC_INSTANT.test(value)) return [`${label} ${String(value)} is not an ISO-8601 UTC instant to the second`];
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return [`${label} ${value} does not parse as an instant`];
  if (now !== undefined) {
    const reference = Date.parse(now);
    if (Number.isFinite(reference) && at > reference + FUTURE_SKEW_MS) return [`${label} ${value} is in the future relative to ${now}`];
  }
  return [];
}

export function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isPositiveInteger(value) {
  return isNonNegativeInteger(value) && value > 0;
}

// ---------------------------------------------------------------------------
// The producer capture
// ---------------------------------------------------------------------------

export const CAPTURE_VERSION = '2.0.0';

/**
 * What a producer records about the subject it measured.
 *
 * @param {unknown} capture
 * @param {{campaignId?: string|null, subjectDigest?: string|null, now?: string, label: string}} expect
 */
export function captureProblems(capture, { campaignId, producerFingerprints, now, label }) {
  const problems = [];
  if (capture === null || typeof capture !== 'object') return [`${label} carries no producer capture`];
  if (capture.captureVersion !== CAPTURE_VERSION) problems.push(`${label} capture is version ${String(capture.captureVersion)}, and this reader validates ${CAPTURE_VERSION}`);
  if (typeof capture.producer !== 'string' || capture.producer === '') problems.push(`${label} capture names no producer`);
  // The binding: this producer's closure, as fingerprinted when the evidence
  // was produced, against the same producer's closure over the tree being
  // judged. Whole-subject digests are recorded on the capture for a reader
  // and are deliberately not compared here — see tools/producer-closure.mjs.
  if (typeof capture.producerFingerprint !== 'string' || !HEX64.test(capture.producerFingerprint)) {
    problems.push(`${label} capture carries no producer fingerprint; it was produced under a binding that could not say what it depended on`);
  } else if (producerFingerprints !== undefined && producerFingerprints !== null && typeof capture.producer === 'string') {
    const current = producerFingerprints[capture.producer] ?? null;
    if (current === null) {
      problems.push(`${label} was produced by ${capture.producer}, whose closure this tree cannot fingerprint`);
    } else if (current !== capture.producerFingerprint) {
      problems.push(
        `${label} was produced when ${capture.producer} read files fingerprinting ${capture.producerFingerprint.slice(0, 12)}, and the same files in this ` +
          `tree fingerprint ${current.slice(0, 12)}; something the measurement depended on has moved. Re-run the producer, do not re-stamp`,
      );
    }
  }
  if (typeof capture.campaignId !== 'string' || !CAMPAIGN_ID.test(capture.campaignId)) {
    problems.push(`${label} capture names campaign ${String(capture.campaignId)}, which is not a campaign id`);
  } else if (campaignId !== undefined && campaignId !== null && capture.campaignId !== campaignId) {
    problems.push(`${label} was produced in campaign ${capture.campaignId} and this candidate's campaign is ${campaignId}`);
  }
  for (const field of ['subjectDigestAtStart', 'subjectDigestAtEnd']) {
    if (typeof capture[field] !== 'string' || !HEX64.test(capture[field])) problems.push(`${label} capture ${field} is not a digest`);
  }
  if (HEX64.test(String(capture.producerFingerprint)) && HEX64.test(String(capture.producerFingerprintAtEnd)) && capture.producerFingerprint !== capture.producerFingerprintAtEnd) {
    problems.push(`${label} saw its producer's inputs change while it ran: ${capture.producerFingerprint.slice(0, 12)} at start, ${capture.producerFingerprintAtEnd.slice(0, 12)} at end`);
  }
  problems.push(...instantProblems(capture.startedAt, { now, label: `${label} capture startedAt` }));
  problems.push(...instantProblems(capture.endedAt, { now, label: `${label} capture endedAt` }));
  if (UTC_INSTANT.test(String(capture.startedAt)) && UTC_INSTANT.test(String(capture.endedAt)) && capture.endedAt < capture.startedAt) {
    problems.push(`${label} capture ended (${capture.endedAt}) before it started (${capture.startedAt})`);
  }
  if (capture.valid !== true) problems.push(`${label} capture is marked invalid: ${String(capture.invalidation ?? 'no reason recorded')}`);
  if (capture.environment === null || typeof capture.environment !== 'object') problems.push(`${label} capture records no environment`);
  return problems;
}

// ---------------------------------------------------------------------------
// Vendor evidence
// ---------------------------------------------------------------------------

/**
 * One case of a vendor gate: an id from the oracle, a boolean, and the two
 * typed values that decided it. `detail` is for a reader and decides nothing.
 */
export function caseProblems(entry, label) {
  const problems = [];
  if (entry === null || typeof entry !== 'object') return [`${label} is not a case record`];
  if (typeof entry.id !== 'string' || entry.id === '') problems.push(`${label} has no id`);
  if (typeof entry.ok !== 'boolean') problems.push(`${label} ${String(entry.id)} has no boolean ok`);
  if (!('expected' in entry)) problems.push(`${label} ${String(entry.id)} records no expected value`);
  if (!('observed' in entry)) problems.push(`${label} ${String(entry.id)} records no observed value`);
  if (entry.detail !== undefined && entry.detail !== null && typeof entry.detail !== 'string') problems.push(`${label} ${String(entry.id)} has a non-text detail`);
  return problems;
}

/**
 * A vendor evidence file against the oracle that names its cases.
 *
 * @param {unknown} evidence
 * @param {{oracleIds: readonly string[], gate: string, now?: string, label: string, casesField?: 'cases'|'checks'}} expect
 */
export function vendorEvidenceProblems(evidence, { oracleIds, gate, now, label, casesField = 'cases' }) {
  const problems = [];
  if (evidence === null || typeof evidence !== 'object') return [`${label} is not an evidence record`];
  if (typeof evidence.gate !== 'string' || !evidence.gate.startsWith(gate)) problems.push(`${label} records gate ${String(evidence.gate)}, expected ${gate}`);
  const cases = Array.isArray(evidence[casesField]) ? evidence[casesField] : null;
  if (cases === null || cases.length === 0) {
    problems.push(`${label} records no ${casesField}; a gate with nothing in it decided nothing`);
  } else {
    const seen = new Map();
    for (const [index, entry] of cases.entries()) {
      problems.push(...caseProblems(entry, `${label} ${casesField}[${String(index)}]`));
      if (entry && typeof entry.id === 'string') seen.set(entry.id, (seen.get(entry.id) ?? 0) + 1);
    }
    for (const [id, count] of seen) if (count > 1) problems.push(`${label} records case ${id} ${String(count)} times`);
    const missing = oracleIds.filter((id) => !seen.has(id));
    const extra = [...seen.keys()].filter((id) => !oracleIds.includes(id));
    if (missing.length > 0) problems.push(`${label} is missing the oracle's cases ${missing.join(', ')}`);
    if (extra.length > 0) problems.push(`${label} records cases the oracle does not declare: ${extra.join(', ')}`);
    const failed = cases.filter((entry) => entry && entry.ok === false).map((entry) => entry.id);
    const declaredFailures = Array.isArray(evidence.failures) ? evidence.failures : null;
    if (declaredFailures === null) problems.push(`${label} carries no failures array`);
    else if (declaredFailures.length !== failed.length) problems.push(`${label} declares ${String(declaredFailures.length)} failures and ${String(failed.length)} cases are not ok`);
    const expectedResult = failed.length === 0 && (declaredFailures === null || declaredFailures.length === 0) ? 'PASS' : 'FAIL';
    if (evidence.result !== expectedResult) problems.push(`${label} records result ${String(evidence.result)} and its cases say ${expectedResult}`);
    if (casesField === 'checks' && evidence.checksRun !== cases.length) problems.push(`${label} says checksRun ${String(evidence.checksRun)} and records ${String(cases.length)} checks`);
  }
  problems.push(...instantProblems(evidence.observedAt, { now, label: `${label} observedAt` }));
  if (typeof evidence.observedInstance !== 'object' || evidence.observedInstance === null) {
    problems.push(`${label} records no observedInstance (the identity the vendor answered with before anything was written)`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Capacity evidence
// ---------------------------------------------------------------------------

export { CAPACITY_STAGES } from './capacity-stages.mjs';
import { CAPACITY_STAGES } from './capacity-stages.mjs';

const MEASURED_BYTE_FIELDS = ['peakRssBytes', 'peakScratchBytes', 'scratchPeakLiveBytes', 'scratchBytesWritten', 'sourceBytes', 'packageBytes'];
const MEASURED_MS_FIELDS = ['wallClockMs'];

/**
 * One stage record: wall clock, resources, and null (never zero) where a metric
 * was not measured.
 */
export function stageProblems(stage, label) {
  const problems = [];
  if (stage === null || typeof stage !== 'object') return [`${label} is not a stage record`];
  if (!CAPACITY_STAGES.includes(stage.stage)) problems.push(`${label} names stage ${String(stage.stage)}`);
  if (!isNonNegativeInteger(stage.wallMs)) problems.push(`${label} ${String(stage.stage)} wallMs is not a whole number of milliseconds`);
  for (const field of ['peakRssBytes', 'maxRssDeltaBytes', 'scratchLiveBytesAtEnd', 'scratchPeakLiveBytesSoFar', 'scratchSampledBytesAtEnd']) {
    const value = stage[field];
    if (value === undefined) problems.push(`${label} ${String(stage.stage)} does not record ${field} (absent must be null, with a reason)`);
    else if (value !== null && !isNonNegativeInteger(value)) problems.push(`${label} ${String(stage.stage)} ${field} is neither null nor a byte count`);
    if (value === null && typeof stage[`${field}Reason`] !== 'string') problems.push(`${label} ${String(stage.stage)} ${field} is null without a reason`);
  }
  return problems;
}

/**
 * A founding capacity evidence file (schema 3.0.0).
 *
 * @param {unknown} evidence
 * @param {{schemaVersion: string, now?: string, label: string, minimumReproductions?: number}} expect
 */
export function capacityEvidenceProblems(evidence, { schemaVersion, now, label, minimumReproductions = 2 }) {
  const problems = [];
  if (evidence === null || typeof evidence !== 'object') return [`${label} is not an evidence record`];
  if (evidence.evidenceSchemaVersion !== schemaVersion) problems.push(`${label} is evidence schema ${String(evidence.evidenceSchemaVersion)} and the tree declares ${schemaVersion}`);
  problems.push(...unitFieldProblems(evidence));
  if (typeof evidence.mode !== 'string') problems.push(`${label} names no mode`);
  if (typeof evidence.profile !== 'string') problems.push(`${label} names no profile`);
  if (!isPositiveInteger(evidence.sourceRows)) problems.push(`${label} sourceRows is not a positive whole number`);
  if (evidence.result !== 'PASS' && evidence.result !== 'FAIL') problems.push(`${label} result is ${String(evidence.result)}`);
  const measured = evidence.measured;
  if (measured === null || typeof measured !== 'object') {
    problems.push(`${label} carries no measured block`);
  } else {
    for (const field of MEASURED_BYTE_FIELDS) if (!isNonNegativeInteger(measured[field])) problems.push(`${label} measured.${field} is not a byte count`);
    for (const field of MEASURED_MS_FIELDS) if (!isNonNegativeInteger(measured[field])) problems.push(`${label} measured.${field} is not a millisecond count`);
    if (measured.maxRssUnit === undefined) problems.push(`${label} does not record how maxRSS was converted (maxRssUnit)`);
  }
  const stages = Array.isArray(evidence.stages) ? evidence.stages : null;
  if (stages === null) problems.push(`${label} records no per-stage resources`);
  else {
    stages.forEach((stage, index) => problems.push(...stageProblems(stage, `${label} stages[${String(index)}]`)));
    const names = stages.map((stage) => stage && stage.stage);
    for (const stage of CAPACITY_STAGES) if (!names.includes(stage)) problems.push(`${label} records no ${stage} stage`);
  }
  const reproductions = Array.isArray(evidence.reproductions) ? evidence.reproductions : null;
  if (reproductions === null || reproductions.length < minimumReproductions) {
    problems.push(`${label} records ${String(reproductions ? reproductions.length : 0)} reproductions; ${String(minimumReproductions)} are required`);
  } else {
    reproductions.forEach((entry, index) => {
      if (entry === null || typeof entry !== 'object') problems.push(`${label} reproductions[${String(index)}] is not a record`);
      else {
        if (typeof entry.packageDigest !== 'string' || !HEX64.test(entry.packageDigest)) problems.push(`${label} reproductions[${String(index)}] has no package digest`);
        if (!isNonNegativeInteger(entry.wallClockMs)) problems.push(`${label} reproductions[${String(index)}] has no wall clock`);
        if (!Array.isArray(entry.stages)) problems.push(`${label} reproductions[${String(index)}] records no stages`);
      }
    });
  }
  const reconciliation = evidence.reconciliation;
  if (reconciliation === null || typeof reconciliation !== 'object') problems.push(`${label} carries no reconciliation`);
  else {
    if (reconciliation.equationHolds !== true) problems.push(`${label} row equation does not hold`);
    if (!isNonNegativeInteger(reconciliation.rowsIngested)) problems.push(`${label} reconciliation.rowsIngested is not a count`);
  }
  const verification = evidence.verification;
  if (verification === null || typeof verification !== 'object') problems.push(`${label} carries no verification`);
  else {
    if (verification.ok !== true) problems.push(`${label} verification.ok is ${String(verification.ok)}`);
    if (!isPositiveInteger(verification.checksRun)) problems.push(`${label} verification ran no checks`);
    if (verification.problems !== 0 && !(Array.isArray(verification.problems) && verification.problems.length === 0)) problems.push(`${label} verification reports problems`);
    if (verification.attestationOk !== true) problems.push(`${label} attestationOk is ${String(verification.attestationOk)}`);
  }
  if (evidence.environment === null || typeof evidence.environment !== 'object') problems.push(`${label} records no environment`);
  else {
    for (const field of ['node', 'platform', 'arch', 'cpuCount', 'totalMemoryBytes', 'samplingIntervalMs', 'maxRssCalibration']) {
      if (evidence.environment[field] === undefined) problems.push(`${label} environment does not record ${field}`);
    }
  }
  problems.push(...instantProblems(evidence.observedAt, { now, label: `${label} observedAt` }));
  if (evidence.candidate !== undefined) {
    // MC-2's stamped block. Its presence is the defect (item 1): a measurement
    // is bound by its producer's capture, never by a tool that wrote a digest
    // onto it afterwards.
    problems.push(`${label} carries a candidate block written by ${String(evidence.candidate.writtenBy)}; capacity evidence is bound by its producer capture, not by a stamp`);
  }
  return problems;
}

/**
 * The declared scale of a matrix profile, from the profiles manifest, against
 * what the run produced. Never `x >= x` (MC-2 item 9).
 *
 * @param {{profileId: string, planned: {sourceRows: number}|null, produced: {sourceRows: number, result: string}|undefined, rung: number}} input
 */
export function matrixEntryProblems({ profileId, planned, produced, rung }) {
  const problems = [];
  if (planned === null) return [`${profileId}: the profiles manifest yields no plan at rung ${String(rung)}, so nothing states the expected scale`];
  if (produced === undefined) return [`${profileId} was not run`];
  if (produced.result !== 'PASS') problems.push(`${profileId} ${String(produced.result)}`);
  if (!isPositiveInteger(produced.sourceRows)) problems.push(`${profileId} records no source row count`);
  else if (produced.sourceRows !== planned.sourceRows) {
    problems.push(`${profileId} produced ${String(produced.sourceRows)} source rows and the declared profile at rung ${String(rung)} yields ${String(planned.sourceRows)}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Gate facts
// ---------------------------------------------------------------------------

/**
 * A facts record, in the one shape every gate emits: name → {value: boolean, by, observed}.
 *
 * @param {unknown} facts
 * @returns {{problems: string[], entries: Array<{name: string, value: boolean, by: string|null, observed: string|null}>}}
 */
export function factsProblems(facts, label) {
  const problems = [];
  const entries = [];
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) return { problems: [`${label} facts is not an object keyed by fact name`], entries };
  for (const [name, entry] of Object.entries(facts)) {
    if (entry === null || typeof entry !== 'object') {
      problems.push(`${label} fact ${name} is ${JSON.stringify(entry)} rather than {value, by, observed}`);
      continue;
    }
    if (typeof entry.by !== 'string') problems.push(`${label} fact ${name} names no derivation`);
    // Three kinds of value, and the third is the point of validating the
    // envelope rather than the type: a boolean for a fact this gate decided, a
    // string for a fact whose answer is a version, and `null` for a fact
    // decided elsewhere — which reads as "not answered here" and never as
    // false. A gate that flattened the third into `false` would report a
    // product flag as negative because it did not own it.
    if (entry.by === 'DECIDED_ELSEWHERE') {
      if (entry.value !== null) problems.push(`${label} fact ${name} is decided elsewhere and still carries the value ${JSON.stringify(entry.value)}`);
    } else if (typeof entry.value !== 'boolean' && typeof entry.value !== 'string') {
      problems.push(`${label} fact ${name} has value ${JSON.stringify(entry.value)}, which is neither a boolean nor a version`);
    }
    entries.push({
      name,
      value: entry.value === true,
      decidedElsewhere: entry.by === 'DECIDED_ELSEWHERE',
      by: typeof entry.by === 'string' ? entry.by : null,
      observed: typeof entry.observed === 'string' ? entry.observed : null,
    });
  }
  return { problems, entries };
}

export { UNIVERSE_STEP_IDS, universeReportProblems };
