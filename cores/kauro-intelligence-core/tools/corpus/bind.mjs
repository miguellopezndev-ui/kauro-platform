// Binds a planted source to the real profile of the data plane (B04-FIXTURES; D4-CORP-2).
//
// The planted columns are written as a CSV bundle and profiled by the frozen Migration Core (`produceSourceProfile`,
// `buildCandidateSet`): the profile hash, the candidate-set hash and the field and evidence refs a run will see come
// from the profiler, not from IC. The target contract of the vendor modes is built from the planted target objects
// and hashed by the core (`hashTargetContract`). No IC resolver, compiler, planner or oracle runs here; the truth
// (decisions, destinations, alternatives) is still the template's and is untouched by this module.
//
// The profile read configuration is fixed: one CSV `source.csv`, one record whose id column and only mapped field is
// the FIRST planted column (custom:source_id, TEXT). Templates keep column 0 a plain, unique header.
// A fixture of several files (columns carrying `file`) is read file by file the same way: each file is one record, its first
// column the record id, of the object the project declares for the file; a column the host's read configuration reads (`read`)
// is a further mapped field of its record, and then the dry run Migration Core makes over the whole source is part of the candidate
// set (its duplicate clusters), as the audit's PROFILE step builds it. Single-file fixtures without `read` are unchanged.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCRATCH_BUDGET_BYTES, buildCandidateSet, createFilesystemScratchStore, getAdapter, hashTargetContract, loadConfig, produceSourceProfile, runMigration } from 'kauro-migration-core';
import { digestOf } from 'kauro-intelligence-core/benchmark';
import { ATTESTATION_INSTANT, AUTHORITY, attestationFor } from './attest.mjs';

export const DEFAULT_FILE = 'source.csv';
const csvCell = (text) => (/[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text);
// The naming of refs in the run's view of a profile (the adapter's own scheme, re-derived; the family test compares it with the adapter's).
const fieldRefFor = (locator) => `fld_${digestOf(`field:${locator}`).slice(0, 16)}`;
const evidenceRefFor = (evidence) => `ev_${digestOf(`evidence:${evidence}`).slice(0, 16)}`;

const SALESFORCE_OBJECT = { contact: 'Contact', company: 'Account', deal: 'Opportunity', lead: 'Lead' };
const CANONICAL_OBJECT = { contact: 'CONTACT', company: 'COMPANY', deal: 'DEAL', lead: 'LEAD' };
const HUBSPOT_TYPE = { EMAIL: 'string', PHONE: 'string', DATE: 'date', NUMBER: 'number', BOOLEAN: 'bool', ENUM: 'enumeration' };
const HUBSPOT_INTERNAL_OVERRIDES = { 'deal.stage': 'dealstage' };
const SALESFORCE_TYPE = { EMAIL: 'email', PHONE: 'phone', DATE: 'date', NUMBER: 'double', BOOLEAN: 'boolean', ENUM: 'picklist' };

/** The files a planted source is made of, in first-appearance order: path, id, record object, and the columns. A fixture without `file` is the one file `source.csv`. */
export function sourceFilesOf(planted) {
  const files = new Map();
  for (const column of planted.columns) {
    const path = column.file ?? DEFAULT_FILE;
    if (!files.has(path)) files.set(path, []);
    files.get(path).push(column);
  }
  const multi = planted.columns.some((column) => column.file !== undefined);
  return [...files].map(([path, columns]) => {
    const declared = planted.project?.files?.[path];
    return { path, id: path.replace(/\.csv$/u, ''), columns, object: multi ? (declared?.object ?? 'CONTACT') : 'CONTACT' };
  });
}

/** Writes the CSV of every planted file under `root`. */
export function writeSource(root, planted) {
  const files = sourceFilesOf(planted);
  for (const file of files) {
    const rows = Math.max(...file.columns.map((column) => column.values.length));
    writeFileSync(join(root, file.path), `${[file.columns.map((column) => csvCell(column.header)).join(','), ...Array.from({ length: rows }, (_, row) => file.columns.map((column) => csvCell(column.values[row] ?? '')).join(','))].join('\n')}\n`);
  }
  return files;
}

/** The read configuration the profile is produced under: per file one record keyed by its first column, plus the columns the host reads (`read`). */
export function readConfigOf(planted, files = sourceFilesOf(planted)) {
  return JSON.stringify({
    configVersion: '3.0.0', source: { system: 'fixture', namespace: 'corpus' }, target: { mode: planted.mode, importMode: 'CREATE_ONLY' },
    files: files.map((file) => ({ id: file.id, path: file.path, format: 'CSV' })),
    records: files.map((file) => ({
      id: file.id, fileId: file.id, object: file.object, sourceRecordIdColumn: { header: file.columns[0].header },
      fields: [{ column: { header: file.columns[0].header }, destinationField: 'custom:source_id', semanticType: 'TEXT' }, ...file.columns.slice(1).filter((column) => column.read !== undefined).map((column) => ({ column: { header: column.header }, destinationField: column.read.destination, semanticType: column.read.semanticType }))],
    })),
  });
}

/**
 * The source profiled and its candidate set built, under `root` (the CSVs written): the data plane's own profile of the planted files,
 * and — when the host reads a column (`read`) — with the dry run's truth, so Migration Core's duplicate clusters stand in the set.
 */
export function profileSource(root, planted) {
  const files = writeSource(root, planted);
  const loaded = loadConfig(readConfigOf(planted, files), join(root, 'config.json'));
  const scratch = createFilesystemScratchStore({ root: join(root, 'scratch-profile'), runId: 'profile', quotaBytes: SCRATCH_BUDGET_BYTES });
  try {
    const profile = produceSourceProfile({ inputRoot: root, config: loaded.config, scratch });
    // The dry run's scratch lives while the set reads the truth's duplicate clusters from it.
    const dry = planted.columns.some((column) => column.read !== undefined);
    let candidateSet;
    if (dry) {
      const dryScratch = createFilesystemScratchStore({ root: join(root, 'scratch-truth'), runId: 'truth', quotaBytes: SCRATCH_BUDGET_BYTES });
      try {
        // A vendor mode runs only on an attested contract: the planted one, signed by the corpus's own throwaway issuer.
        const contract = contractOf(planted, { dryRun: true });
        const run = runMigration({ inputRoot: root, config: loaded.config, configHash: loaded.configHash, scratch: dryScratch, sourceProfile: profile, ...(contract === null ? {} : { targetContract: contract, targetAttestation: attestationFor(contract), attestationAuthorities: [AUTHORITY], attestationInstant: ATTESTATION_INSTANT }) });
        candidateSet = buildCandidateSet({ profile, configHash: loaded.configHash, truth: run.truth });
      } finally { dryScratch.dispose(); }
    } else candidateSet = buildCandidateSet({ profile, configHash: loaded.configHash });
    return { files, loaded, profile, candidateSet };
  } finally { scratch.dispose(); }
}

/** The duplicate clusters Migration Core's dry run finds over a planted source (the count and the files each spans), from the data plane alone. */
export function duplicateClustersOf(planted) {
  const dir = mkdtempSync(join(tmpdir(), 'b04-dups-'));
  try {
    const { candidateSet, profile } = profileSource(dir, planted);
    const pathOf = new Map(profile.profile.files.map((file) => [file.fileId ?? file.id, file.path]));
    return candidateSet.candidateSet.candidates.filter((candidate) => candidate.candidateType === 'DUPLICATE_CLUSTER').map((candidate) => ({ rows: candidate.impactCounts.rows, files: [...new Set(candidate.sourceRefs.map((ref) => pathOf.get(ref.slice(0, ref.indexOf(':'))) ?? ref))].sort() }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const contractField = (apiName, label, type, extra = {}) => ({
  apiName, label, type, createable: 'TRUE', updateable: 'TRUE', nillable: 'TRUE', length: 255, precision: null, scale: null,
  unique: 'FALSE', externalId: 'FALSE', idLookup: 'FALSE', calculated: 'FALSE', autoNumber: 'FALSE', defaultedOnCreate: 'FALSE',
  restrictedPicklist: 'FALSE', picklistValues: [], referenceTo: [], relationshipName: null, evidence: 'ARTIFACT', ...extra,
});

/** The hashed target contract of a vendor-mode fixture, from the planted target objects; null for CLEAN_ONLY. */
export function contractOf(planted, { dryRun = false } = {}) {
  const mode = planted.mode;
  if (mode === 'CLEAN_ONLY') return null;
  const hubspot = mode === 'HUBSPOT';
  const adapter = getAdapter(mode);
  const objects = planted.objects.map((object) => {
    const key = object.name.toLowerCase();
    const spec = adapter.objects.find((entry) => entry.object === CANONICAL_OBJECT[key]);
    return {
      apiName: hubspot ? key : (SALESFORCE_OBJECT[key] ?? object.name),
      label: object.name,
      createable: 'TRUE', updateable: 'TRUE', recordTypes: [],
      fields: object.fields.map((field) => {
        const header = spec?.fields.find((entry) => entry.canonicalField === `${key}.${field.name}`)?.header;
        const type = (hubspot ? HUBSPOT_TYPE : SALESFORCE_TYPE)[field.valueClass] ?? 'string';
        const identity = field.externalId === true ? { unique: 'TRUE', externalId: 'TRUE', idLookup: 'TRUE' } : field.name === 'email' ? { unique: 'TRUE', idLookup: 'TRUE' } : {};
        // The dry run exists to read the truth's duplicate clusters from the source; Migration Core 3.0.0 also checks that every required
        // destination field is mapped, which the corpus's read configuration does not do (it reads only the columns the host reads).
        const required = field.required && !dryRun ? { nillable: 'FALSE' } : {};
        const options = field.options === undefined ? {} : { picklistValues: field.options.map((value) => ({ value, label: value, active: true, defaultValue: false })) };
        // HubSpot's internal name of the deal stage is not the lower-cased canonical name; Migration Core 3.0.0 looks a deal field up by it.
        const apiName = header === undefined ? field.name : (hubspot ? (HUBSPOT_INTERNAL_OVERRIDES[`${key}.${field.name}`] ?? field.name.toLowerCase()) : header);
        return contractField(apiName, field.label ?? header ?? field.name, type, { ...identity, ...required, ...options });
      }),
    };
  });
  return hashTargetContract({
    contractVersion: '1.0.0', parserVersion: '1.0.0', capturedAt: '2026-09-01T00:00:00Z',
    instance: { mode, instanceId: hubspot ? '00000001' : '00D000000000001', instanceLabel: `corpus ${mode}`, evidence: 'ARTIFACT' },
    artifacts: [{ path: 'export/schema.json', sha256: 'a'.repeat(64), byteLength: 4096, kind: 'DESCRIBE' }],
    objects, pipelines: [],
  });
}

/**
 * The full-data shapes the frozen data plane counts on each planted column, in the order a run reads them (most frequent first, then
 * by name): what a template's truth may stand on when it states that a column's values read as a type (B04 stage 2). The profiler
 * is Migration Core's; nothing of IC runs.
 */
export function shapesOf(columns, mode = 'CLEAN_ONLY') {
  const dir = mkdtempSync(join(tmpdir(), 'b04-shapes-'));
  try {
    const rows = Math.max(...columns.map((column) => column.values.length));
    writeFileSync(join(dir, 'source.csv'), `${[columns.map((column) => csvCell(column.header)).join(','), ...Array.from({ length: rows }, (_, row) => columns.map((column) => csvCell(column.values[row] ?? '')).join(','))].join('\n')}\n`);
    const first = columns[0];
    const config = JSON.stringify({ configVersion: '3.0.0', source: { system: 'fixture', namespace: 'corpus' }, target: { mode, importMode: 'CREATE_ONLY' }, files: [{ id: 'source', path: 'source.csv', format: 'CSV' }], records: [{ id: 'source', fileId: 'source', object: 'CONTACT', sourceRecordIdColumn: { header: first.header }, fields: [{ column: { header: first.header }, destinationField: 'custom:source_id', semanticType: 'TEXT' }] }] });
    const loaded = loadConfig(config, join(dir, 'config.json'));
    const scratch = createFilesystemScratchStore({ root: join(dir, 'scratch'), runId: 'shapes', quotaBytes: SCRATCH_BUDGET_BYTES });
    try {
      const profile = produceSourceProfile({ inputRoot: dir, config: loaded.config, scratch });
      return profile.profile.files[0].sheets[0].columns.map((column) => Object.entries(column.shapes).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([name]) => name));
    } finally { scratch.dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** The ProfileBinding of a planted source: profile hash, candidate-set hash, contract hash, revision hash, and the refs the profile gives each column. */
export function bindPlanted(planted) {
  const dir = mkdtempSync(join(tmpdir(), 'b04-bind-'));
  try {
    const { files, profile, candidateSet } = profileSource(dir, planted);
    const fieldRefs = {};
    const evidenceRefs = {};
    for (const file of files) {
      const read = profile.profile.files.find((entry) => entry.path === file.path);
      const columns = read?.sheets[0].columns ?? [];
      if (columns.length !== file.columns.length) throw new Error(`${file.path}: the profile read ${String(columns.length)} columns, ${String(file.columns.length)} were planted`);
      file.columns.forEach((column, index) => {
        const locator = columns[index].columnLocatorId;
        if (columns[index].headerRaw !== column.header) throw new Error(`${file.path}: column ${String(index)} read as ${String(columns[index].headerRaw)}, planted ${column.header}`);
        fieldRefs[column.fieldRef] = fieldRefFor(locator);
        evidenceRefs[column.fieldRef] = evidenceRefFor(`profile:${profile.profileHash}#${locator}`);
      });
    }
    const contract = contractOf(planted);
    return {
      inputHashes: { profileHash: profile.profileHash, candidateSetHash: candidateSet.candidateSetHash, targetContractHash: contract === null ? null : contract.contractHash, projectRevisionHash: digestOf(['rev-1', profile.profileHash]) },
      fieldRefs, evidenceRefs,
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
