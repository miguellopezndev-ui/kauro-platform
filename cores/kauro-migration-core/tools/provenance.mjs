#!/usr/bin/env node
/**
 * The release provenance record, built from the evidence on disk.
 *
 * Written by a generator rather than by hand for the same reason the
 * specification files are: a hand-written provenance drifts from the thing it
 * describes, and a provenance that disagrees with the repository is worse than
 * none, because it is believed.
 *
 * ---- what this record used to assert, and could not have known ----
 *
 * Four things, each of which the MC-2 ledger names:
 *
 *   Three gates carried `state: 'PASS'` as a string literal — CORE-CONSTITUTION-01,
 *   TARGET-CONTRACT-01 and sabotage — beside sentences like "26 checks, in CI"
 *   and "all killed, 0 survived". None of those was read from anything. The
 *   record asserted that three gates had passed whether or not either had ever
 *   been run, and asserted a check count nobody had counted. Those three gates
 *   now write their own evidence (`--evidence`), and this reads it.
 *
 *   The evidence inventory ended in `.filter((entry) => entry !== null)`, so a
 *   file the record names and the tree does not hold was silently dropped: the
 *   record then vouched for fourteen artifacts, listed twelve, and said nothing
 *   about the two. A named file that is absent invalidates the record.
 *
 *   The capacity section read `qualification/evidence/capacity-500000.json` and
 *   `capacity-1000000.json` — MC-1 measurements denominated in `peakMb`, taken
 *   before the engine spilled to a scratch store — and compared them against
 *   `BUDGET_MB` and `CEILING_MB`, two numbers written into this file. It read
 *   them beside the founding evidence that superseded them, and mixed a failed
 *   old measurement into the same table. The legacy files are gone; the budgets
 *   are imported from `src/domain/resource-profile.ts`, in bytes.
 *
 *   The "What this release does not claim" section was prose, and it was wrong
 *   in the way prose goes wrong: it said the HubSpot qualification ran against a
 *   standard account holding the owner's records, which had been true and was
 *   not any more, and it said a million rows did not fit the budget, which the
 *   founding evidence contradicts. What a release does not claim is a function
 *   of what evidence it holds, so it is derived from the inventory.
 *
 * ---- the preflight is an input of this record and is computed after it ----
 *
 *   The candidate preflight lists this record's check among the facts it
 *   answers (the universe's "provenance" step, and the drift fact), so the plain
 *   check, which requires qualification/candidate/preflight.json, can never pass
 *   while the preflight is being written. The 2.0.3 release stuck there.
 *   `--before-preflight` is the check for that window: it accepts exactly one
 *   absence, the preflight, and nothing else. Every other required artifact and
 *   every byte of the record are still checked, and the mode is printed. It is
 *   never the final check: plain `--check` still requires the preflight, and a
 *   record generated while the preflight was absent differs from one generated
 *   after it, so the sequence is provenance, preflight, provenance (D76).
 *
 *   Usage:
 *     node tools/provenance.mjs [--check [--before-preflight]]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UNIVERSE_STEP_IDS } from './universe-inventory.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const check = process.argv.includes('--check');
const beforePreflight = process.argv.includes('--before-preflight');
/** The one artifact the pre-preflight mode may find absent. */
const PREFLIGHT_PATH = 'qualification/candidate/preflight.json';
if (beforePreflight && !check) {
  process.stderr.write('--before-preflight is a mode of --check; it never writes the record\n');
  process.exit(2);
}

/** A measured figure inside its budget. A figure that was not measured is neither. */
const withinBudget = (value, budget) => typeof value === 'number' && Number.isFinite(value) && value <= budget;

const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const exists = (relative) => existsSync(join(repoRoot, relative));

// Imported, never restated. Two of these were literals here — `BUDGET_MB 5734`
// and `CEILING_MB 8192` — which is the same constant living in two files, in two
// units, with nothing comparing them.
const { MEMORY_BUDGET_BYTES, HARD_MEMORY_LIMIT_BYTES, SCRATCH_BUDGET_BYTES, WALL_CLOCK_LIMIT_MS } = await import(
  new URL('../dist/src/domain/resource-profile.js', import.meta.url).href
);
const { CORE_VERSION, PACKAGE_FORMAT_VERSION, SOURCE_REGISTRY_VERSION } = await import(
  new URL('../dist/src/version.js', import.meta.url).href
);
const { readCampaign } = await import(new URL('../qualification/campaign.mjs', import.meta.url).href);

const packageVersion = readJson('package.json').version;

// ---------------------------------------------------------------------------
// The evidence inventory
// ---------------------------------------------------------------------------

/**
 * Every file this record vouches for, and whether each is required.
 *
 * A required file that is absent invalidates the record rather than shrinking
 * it. An optional one is listed as absent, with what its absence means — which
 * is the honest form of "this release does not claim".
 */
const INVENTORY = [
  { path: 'qualification/evidence/final-adversarial.json', required: true, claim: 'the bounded adversarial pass over the final head' },
  { path: 'qualification/evidence/hs-target-contract.json', required: true, claim: 'the HubSpot target contract, captured from a real portal' },
  { path: 'qualification/evidence/hs-import.json', required: true, claim: 'HubSpot imports through the CRM Imports API, read back record by record' },
  { path: 'qualification/evidence/sf-target-contract.json', required: true, claim: 'the Salesforce target contract, built from a real describe' },
  { path: 'qualification/evidence/sf-dataloader.json', required: true, claim: 'Salesforce loads through the official Data Loader, read back record by record' },
  { path: 'qualification/evidence/sf-ocr.json', required: true, claim: 'OpportunityContactRole is outside the envelope, and the adapter says so' },
  { path: 'qualification/capacity/clean-only.json', required: true, claim: 'a million representative source rows in CLEAN_ONLY, inside the founding budgets' },
  { path: 'qualification/capacity/hubspot.json', required: true, claim: 'a million representative source rows in HUBSPOT, inside the founding budgets' },
  { path: 'qualification/capacity/salesforce.json', required: true, claim: 'a million representative source rows in SALESFORCE, inside the founding budgets' },
  { path: 'qualification/capacity/matrix.json', required: true, claim: 'every declared complementary profile at the founding rung' },
  { path: 'qualification/candidate/manifest.json', required: true, claim: 'what the candidate is, file by file' },
  { path: 'qualification/candidate/provenance.json', required: true, claim: 'the candidate record the manifest belongs to' },
  { path: 'qualification/candidate/preflight.json', required: true, claim: 'every fact the tree can answer about itself' },
  { path: 'qualification/candidate/universe.json', required: true, claim: `the offline universe, ${String(UNIVERSE_STEP_IDS.length)} steps` },
  { path: 'qualification/candidate/campaign.json', required: true, claim: 'the campaign every measurement here belongs to' },
  { path: 'qualification/evidence/HUBSPOT_SCOPE_BLOCKER.md', required: true, claim: 'which HubSpot portal is which, and what was once done to the other one' },
  { path: 'qualification/evidence/SF_DATALOADER_AUTH.md', required: true, claim: 'how Data Loader authenticates, and how it does not' },
  { path: 'qualification/evidence/TENANT_SAFETY.md', required: true, claim: 'why writing to these two tenants is safe' },
  { path: 'docs/work/GATES.md', required: true, claim: 'the gate table and the capacity figures' },
  {
    path: 'qualification/evidence/hs-custom-property.json',
    required: false,
    claim: 'that a property Kauro creates behaves as one HubSpot ships',
    absence:
      'A property Kauro creates is qualified nowhere in this release. It was established once, on 2026-09-02, in portal 51050101 — a standard account holding real customer records, which is out of scope from MC-3 on — and that evidence is historical and is not counted here. The developer-test portal the qualification uses carries no crm.schemas.*.write scope; qualification/evidence/HUBSPOT_SCOPE_BLOCKER.md names the one action that would close it.',
  },
];

function inventory() {
  const entries = [];
  const problems = [];
  for (const item of INVENTORY) {
    if (!exists(item.path)) {
      if (item.required) problems.push(`${item.path} is named by this record and is not in the tree`);
      entries.push({ ...item, present: false, sha256: null });
      continue;
    }
    entries.push({ ...item, present: true, sha256: sha256(read(item.path)) });
  }
  return { entries, problems };
}

// ---------------------------------------------------------------------------
// The gates, read rather than asserted
// ---------------------------------------------------------------------------

/**
 * One gate's state, from the evidence that gate wrote.
 *
 * `UNKNOWN` where there is no evidence, and `UNKNOWN` is not `PASS`: a release
 * record that cannot see a gate's result says so.
 */
function gateFrom(path, gate, describe) {
  if (!exists(path)) return { gate, state: 'UNKNOWN', establishedBy: `no evidence at ${path}` };
  let evidence;
  try {
    evidence = readJson(path);
  } catch (error) {
    return { gate, state: 'UNKNOWN', establishedBy: `${path} is not readable: ${String(error && error.message ? error.message : error)}` };
  }
  const state = evidence.result === 'PASS' ? 'PASS' : evidence.result === 'FAIL' ? 'FAIL' : 'UNKNOWN';
  return { gate, state, establishedBy: describe(evidence), observedAt: evidence.observedAt ?? null, evidence: path };
}

const campaign = readCampaign();

/**
 * The offline gates, read from the universe report rather than from a literal.
 *
 * `CORE-CONSTITUTION-01`, `TARGET-CONTRACT-01`, `EVIDENCE-RULES-01` and the
 * sabotage corpus all run as steps of the offline universe, which records each
 * one's exit status, the digest of its whole output and the log holding it, and
 * which is itself bound to the candidate's code digest. Reading the report is
 * therefore reading a result that a run produced against this engine — which is
 * what `state: 'PASS'` in this file was pretending to be.
 *
 * It also avoids a fixed point rather than working around one. A gate that
 * wrote its evidence into `qualification/evidence/` during the universe would
 * change the tree after the universe had measured it, so the report's own
 * candidate digest would name a tree that no longer existed by the time the
 * report was written.
 */
const universe = exists('qualification/candidate/universe.json') ? readJson('qualification/candidate/universe.json') : null;

function gateFromUniverse(stepId, gate, describe) {
  if (universe === null) return { gate, state: 'UNKNOWN', establishedBy: 'there is no offline universe report' };
  const step = (universe.steps ?? []).find((entry) => entry.id === stepId);
  if (step === undefined) return { gate, state: 'UNKNOWN', establishedBy: `the universe report records no ${stepId} step` };
  return {
    gate,
    state: step.ok === true ? 'PASS' : 'FAIL',
    establishedBy: describe(step),
    observedAt: null,
    evidence: `qualification/candidate/universe.json#${stepId}`,
  };
}

const gates = [
  gateFromUniverse('constitution', 'CORE-CONSTITUTION-01', (step) => `the offline universe ran it (exit ${String(step.exitStatus)}); ${String(step.detail)}`),
  gateFromUniverse('target-contract', 'TARGET-CONTRACT-01', (step) => `the offline universe ran it (exit ${String(step.exitStatus)}); ${String(step.detail)}`),
  gateFromUniverse('evidence-rules', 'EVIDENCE-RULES-01', (step) => `the offline universe ran it (exit ${String(step.exitStatus)}); ${String(step.detail)}`),
  gateFromUniverse('sabotage', 'SABOTAGE', (step) => `the offline universe ran the whole corpus (exit ${String(step.exitStatus)}); ${String(step.detail)}`),
  gateFromUniverse('sabotage-left-no-trace', 'SABOTAGE-LEFT-NO-TRACE', (step) => String(step.detail)),
  gateFrom('qualification/evidence/final-adversarial.json', 'FINAL-ADV-01', (evidence) => `${String((evidence.attacks ?? []).length)} attacks`),
  gateFrom(
    'qualification/evidence/hs-target-contract.json',
    'HSP-TARGET-01 (target contract)',
    (evidence) => `${String(evidence.checksRun)} checks against ${String(evidence.observedInstance?.instanceId ?? evidence.portalId)}`,
  ),
  gateFrom(
    'qualification/evidence/hs-import.json',
    'HSP-TARGET-01 (import)',
    (evidence) => `${String((evidence.cases ?? []).length)} expectations against ${String(evidence.observedInstance?.instanceId ?? evidence.portalId)}`,
  ),
  gateFrom(
    'qualification/evidence/sf-target-contract.json',
    'SF-TARGET-01 (target contract)',
    (evidence) => `${String(evidence.checksRun)} checks against ${String(evidence.observedInstance?.instanceId ?? evidence.orgId)}`,
  ),
  gateFrom(
    'qualification/evidence/sf-dataloader.json',
    'SF-TARGET-01 (Data Loader)',
    (evidence) => `${String((evidence.cases ?? []).length)} expectations against ${String(evidence.observedInstance?.instanceId ?? evidence.orgId)}`,
  ),
  gateFrom('qualification/evidence/sf-ocr.json', 'SF-OCR-01', (evidence) => `${String((evidence.cases ?? []).length)} expectations, real org, real Data Loader`),
];

// ---------------------------------------------------------------------------
// Capacity, from the founding evidence and nothing else
// ---------------------------------------------------------------------------

const FOUNDING_MODES = ['CLEAN_ONLY', 'HUBSPOT', 'SALESFORCE'];

function foundingCapacity() {
  const byMode = new Map();
  const root = join(repoRoot, 'qualification', 'capacity');
  if (!existsSync(root)) return byMode;
  for (const name of readdirSync(root)) {
    if (!name.endsWith('.json') || name === 'profiles.json' || name === 'matrix.json') continue;
    let evidence;
    try {
      evidence = readJson(`qualification/capacity/${name}`);
    } catch {
      continue;
    }
    if (typeof evidence.mode === 'string') byMode.set(evidence.mode, { ...evidence, path: `qualification/capacity/${name}` });
  }
  return byMode;
}

const founding = foundingCapacity();
const capacityRows = FOUNDING_MODES.map((mode) => {
  const evidence = founding.get(mode);
  if (evidence === undefined) return { mode, present: false };
  return {
    mode,
    present: true,
    path: evidence.path,
    sourceRows: evidence.sourceRows,
    result: evidence.result,
    peakRssBytes: evidence.measured?.peakRssBytes ?? null,
    peakScratchBytes: evidence.measured?.peakScratchBytes ?? null,
    packageBytes: evidence.measured?.packageBytes ?? null,
    wallClockMs: evidence.measured?.wallClockMs ?? null,
    // `Number(null)` is 0, and 0 is inside every budget.
    //
    // tools/evidence-schema.mjs says in as many words that a metric which was
    // not taken is null beside a reason. Read through `Number(...) <= budget`,
    // every unmeasured figure reported as comfortably inside its budget, and the
    // published table rendered "not recorded" in the same row as PASS.
    insideMemoryBudget: withinBudget(evidence.measured?.peakRssBytes, MEMORY_BUDGET_BYTES),
    insideScratchBudget: withinBudget(evidence.measured?.peakScratchBytes, SCRATCH_BUDGET_BYTES),
    insideWallClock: withinBudget(evidence.measured?.wallClockMs, WALL_CLOCK_LIMIT_MS),
  };
});

const capacityState =
  capacityRows.every((row) => row.present && row.result === 'PASS' && row.insideMemoryBudget && row.insideScratchBudget && row.insideWallClock)
    ? 'PASS'
    : capacityRows.some((row) => row.present)
      ? 'FAIL'
      : 'UNKNOWN';
gates.push({
  gate: 'CAPACITY-FOUNDING',
  state: capacityState,
  establishedBy:
    capacityState === 'PASS'
      ? `a million representative source rows in each of ${FOUNDING_MODES.join(', ')}, inside the founding budgets in bytes`
      : `modes with evidence: ${capacityRows.filter((row) => row.present).map((row) => row.mode).join(', ') || 'none'}`,
});

// ---------------------------------------------------------------------------
// What this release does not claim, derived
// ---------------------------------------------------------------------------

/**
 * Absence, listed from the inventory rather than remembered in prose.
 *
 * Every entry here is either an optional artifact the tree does not hold, or a
 * boundary the evidence itself records. Nothing is typed twice: change what the
 * repository holds and this section changes with it.
 */
function doesNotClaim(entries) {
  const claims = [];
  for (const entry of entries) {
    if (!entry.present && entry.absence !== undefined) claims.push(entry.absence);
  }
  claims.push(
    'That the committed acceptance packages have been imported anywhere. They are reproducibility evidence. What was imported was built ' +
      'from the qualification corpora, into the developer-test portal and the Developer Edition org named in the vendor evidence.',
  );
  claims.push(
    'That either qualification tenant is a production account. Neither is: one is an isolated HubSpot developer test account, the other a ' +
      'disposable Salesforce Developer Edition org, and qualification/evidence/TENANT_SAFETY.md records how each was established before anything was written.',
  );
  claims.push(
    'That an attestation issued from outside this repository has ever been verified here. Every attestation this engine has verified is a ' +
      'genuine Ed25519 signature over a contract naming an instance nobody owns; the seam is real and the external issuer is not yet.',
  );
  const machines = new Set(capacityRows.filter((row) => row.present).map((row) => String(founding.get(row.mode)?.environment?.platform ?? 'unknown')));
  claims.push(
    `That the capacity figures hold on a smaller machine. They are one host's measurements — ${[...machines].join(', ') || 'no host recorded'} — ` +
      'and every capacity record carries the environment it was taken on.',
  );
  if (!exists('qualification/candidate/ci-receipt.json')) {
    claims.push(
      'That this record establishes which commit it describes. It cannot: a file inside a tree cannot name the tree that contains it. The commit, ' +
        'the git tree and the cross-platform result are the external CI receipt’s, and tools/receipt-verify.mjs is what checks them.',
    );
  }
  return claims;
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

const { entries, problems: inventoryProblems } = inventory();
const notClaimed = doesNotClaim(entries);

const provenance = {
  artifactKind: 'MIGRATION_CORE_PROVENANCE',
  provenanceVersion: '2',
  coreVersion: CORE_VERSION,
  packageVersion,
  packageFormatVersion: PACKAGE_FORMAT_VERSION,
  sourceRegistryVersion: SOURCE_REGISTRY_VERSION,
  campaign: campaign === null ? null : { campaignId: campaign.campaignId, sealedAt: campaign.sealedAt, subjectDigest: campaign.subjectDigest },
  // Deliberately no commit hash and no working-tree flag: a record cannot name
  // the commit that contains it, and naming its parent reads as the release's
  // identity and is not.
  //
  // And deliberately no freeze flag. `frozen: false` stood here and the
  // architecture gate read it back as a fact; the freeze is decided outside the
  // tree by tools/freeze-verdict.mjs.
  freezeDecision: { decidedBy: 'tools/freeze-verdict.mjs', outsideTree: true },
  gatesAllPass: gates.every((entry) => entry.state === 'PASS'),
  supportEnvelope: {
    modes: ['HUBSPOT', 'SALESFORCE', 'CLEAN_ONLY'],
    hubspotObjects: ['CONTACT', 'COMPANY', 'DEAL'],
    salesforceObjects: ['ACCOUNT', 'CONTACT', 'LEAD', 'OPPORTUNITY'],
    activities: 'OUT',
  },
  resourceContract: {
    hardMemoryLimitBytes: HARD_MEMORY_LIMIT_BYTES,
    memoryBudgetBytes: MEMORY_BUDGET_BYTES,
    scratchBudgetBytes: SCRATCH_BUDGET_BYTES,
    wallClockLimitMs: WALL_CLOCK_LIMIT_MS,
  },
  capacity: capacityRows,
  gates,
  evidence: entries.map((entry) => ({ path: entry.path, required: entry.required, present: entry.present, sha256: entry.sha256, claim: entry.claim })),
  inventoryProblems,
  doesNotClaim: notClaimed,
};

const json = `${JSON.stringify(provenance, null, 2)}\n`;

const bytes = (value) => (value === null || value === undefined ? 'not recorded' : Number(value).toLocaleString('en-US'));

const markdown = `# Migration Core — provenance

What this release is, what established it, and what it does not claim. Generated
by \`node tools/provenance.mjs\` from the evidence on disk, so it cannot drift
from the repository it describes. Every gate state below is read from the
evidence that gate wrote; none is asserted here.

- Core version \`${provenance.coreVersion}\`, package \`${provenance.packageVersion}\`, package format \`${provenance.packageFormatVersion}\`
- Source registry reviewed \`${provenance.sourceRegistryVersion}\`
- Campaign ${campaign === null ? '**none sealed**' : `\`${campaign.campaignId}\`, sealed ${campaign.sealedAt}, over subject \`${String(campaign.subjectDigest).slice(0, 16)}\``}
- \`MIGRATION_CORE_IMPLEMENTATION_FROZEN\` is decided by \`tools/freeze-verdict.mjs\`, outside this tree

## Support envelope

Three commercial modes and nothing else: \`HUBSPOT\`, \`SALESFORCE\`,
\`CLEAN_ONLY\`. HubSpot carries Contact, Company and Deal. Salesforce carries
Account, Contact, Lead and Opportunity, with Lead first-class rather than a
renamed Contact. **Activities are out of the envelope and are refused**, before
a file is written, rather than attempted and lost.

## Gates

| Gate | State | Established by |
| --- | --- | --- |
${gates.map((entry) => `| \`${entry.gate}\` | **${entry.state}** | ${entry.establishedBy} |`).join('\n')}

## Capacity

The resource contract, in bytes: memory budget ${bytes(MEMORY_BUDGET_BYTES)}
against a hard ceiling of ${bytes(HARD_MEMORY_LIMIT_BYTES)}, scratch budget
${bytes(SCRATCH_BUDGET_BYTES)}, wall clock ${bytes(WALL_CLOCK_LIMIT_MS)} ms.

| Mode | Source rows | Peak RSS | Peak scratch | Package | Wall clock | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
${capacityRows
  .map((row) =>
    row.present
      ? `| \`${row.mode}\` | ${bytes(row.sourceRows)} | ${bytes(row.peakRssBytes)} | ${bytes(row.peakScratchBytes)} | ${bytes(row.packageBytes)} | ${bytes(row.wallClockMs)} ms | ${row.result} |`
      : `| \`${row.mode}\` | — | — | — | — | — | **no evidence** |`,
  )
  .join('\n')}

Every figure is an integer count of bytes or milliseconds, read from the
founding evidence. There is no mebibyte in this record and none in the files it
reads: the evidence that shipped with V1 computed a field called \`peakMb\` as
bytes divided by 1024 twice and compared it against a budget written the other
way.

## Evidence

| Artifact | Required | Present | SHA-256 |
| --- | --- | --- | --- |
${entries
  .map((entry) => `| \`${entry.path}\` | ${entry.required ? 'yes' : 'no'} | ${entry.present ? 'yes' : '**no**'} | \`${entry.present ? String(entry.sha256).slice(0, 16) : '—'}\` |`)
  .join('\n')}
${inventoryProblems.length === 0 ? '' : `\n**This record is invalid.** ${inventoryProblems.join('; ')}\n`}
## What this release does not claim

${notClaimed.map((claim) => `- ${claim}`).join('\n')}
`;

const jsonPath = 'migration-core-provenance.json';
const markdownPath = 'docs/release/MIGRATION_CORE_PROVENANCE.md';

if (check) {
  const same =
    exists(jsonPath) && exists(markdownPath) && read(jsonPath) === json && read(markdownPath) === markdown;
  // The record's bytes are the same in both modes (it states its own problems,
  // the absent preflight included); only the verdict excuses the preflight.
  const blocking = beforePreflight ? inventoryProblems.filter((problem) => !problem.startsWith(`${PREFLIGHT_PATH} `)) : inventoryProblems;
  if (blocking.length > 0) {
    process.stderr.write(`the provenance record is invalid:\n${blocking.map((problem) => `  - ${problem}`).join('\n')}\n`);
    process.exitCode = 1;
  } else if (!same) {
    process.stdout.write('provenance is out of date; run "npm run provenance"\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(
      beforePreflight
        ? 'provenance is current (mode: before-preflight; the preflight is the one artifact not required, NOT a final check)\n'
        : 'provenance is current (mode: final)\n',
    );
  }
} else {
  mkdirSync(join(repoRoot, 'docs', 'release'), { recursive: true });
  writeFileSync(join(repoRoot, jsonPath), json);
  writeFileSync(join(repoRoot, markdownPath), markdown);
  process.stdout.write(`wrote ${jsonPath} and ${markdownPath}\n`);
  if (inventoryProblems.length > 0) {
    process.stderr.write(
      `the record is written and is invalid: ${inventoryProblems.join('; ')}\n` +
        'A named artifact that is absent is not an artifact this record may quietly drop.\n',
    );
    process.exitCode = 1;
  }
}
