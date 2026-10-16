#!/usr/bin/env node
/**
 * The freeze, computed rather than declared.
 *
 * ---- why this exists at all ----
 *
 * `MIGRATION_CORE_IMPLEMENTATION_FROZEN` was a boolean in
 * `qualification/candidate/provenance.json`, a file the tree generates, and
 * `tools/architecture-gate.mjs` read it back and reported it as a fact with
 * derivation `EVIDENCE_READ`. Nothing was verified by that: a sentence was
 * written, read and printed beside facts that had been executed and measured.
 * A flag a tree writes about itself is the thing under dispute, and a gate that
 * reads it is a gate that can be satisfied with a text editor.
 *
 * So the four flags are derived here, outside the tree, from things the tree
 * cannot write:
 *
 *   the commit `main` actually points at, as GitHub reports it;
 *   a clean checkout of that commit reproducing the digests it claims;
 *   the external CI receipt for that commit, verified against the API;
 *   the branch protection actually in force on `main`, with the required checks
 *     equal to the mandatory legs and no bypass actors;
 *   the annotated tag, pointing at that commit;
 *   the release, and its assets as downloaded and hashed.
 *
 * Every one of those is a fact about the remote. A tree can claim any of them
 * and change none of them.
 *
 * ---- what a verdict is not ----
 *
 * It is not a rerun of the gates. RELEASE-CANDIDATE-01 decides whether the
 * candidate is one, and its verdict reaches here through the CI receipt: the
 * `candidate preflight` and `release receipt` legs are among the checks that
 * must be green on the merged commit. This asks the question the gates cannot:
 * did the thing that was qualified become the thing that is published?
 *
 *   node tools/freeze-verdict.mjs --sha <merged sha> [--tag v2.0.1] [--out <path>]
 *                                 [--receipt <path>] [--expect-check <full check name>]...
 *
 * `--expect-check` adds a required check to the ones derived from the workflow;
 * it is given once per name, whole, and it can only add. No option removes a
 * normative check.
 *
 * Exit 0 when every flag is TRUE, 1 otherwise. The verdict is printed as JSON
 * on stdout and is meant to be published as a release asset beside the things
 * it is about.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DIGEST_SERIALISATION_VERSION, EXCLUSION_RULE_VERSION, measureTree, repoRoot, versions } from './candidate-provenance.mjs';
import { measureProducers } from './producer-closure.mjs';
import { DOSSIER_INVENTORY_VERSION, githubTransport, reconstructCandidate, verifyPublishedRelease } from './release-dossier.mjs';
import { githubToken, liveCandidate, normaliseRepository, observeRun, readWorkflow, receiptCheckIdentity, receiptProblems, requiredJobLegs } from './receipt-verify.mjs';
import { measureSubject } from './execution-subject.mjs';
import { readCampaign } from '../qualification/campaign.mjs';
import { readVersions } from './versions.mjs';
import { versionFloorProblems } from './version-floors.mjs';

const API_TIMEOUT_MS = 30_000;

const args = process.argv.slice(2);
const KNOWN = ['--sha', '--tag', '--out', '--receipt', '--repository', '--expect-check'];
const flags = new Map();
const usage = [];
/**
 * Extra required checks, one option per name.
 *
 * This was `--expect-checks a,b,c`, split on commas — and a matrix leg is
 * named "gate (ubuntu-latest, node 22)", comma inside. A name that cannot be
 * written is a name that cannot be required, and a list that was trimmed or
 * left empty looked like a shorter list rather than a mistake. Each name is
 * now one whole option value; an empty value or one with surrounding
 * whitespace is refused rather than tidied; a repeated name is refused. The
 * names are added to the ones derived from the workflow, never substituted
 * for them.
 */
const extraChecks = [];
for (let index = 0; index < args.length; index += 1) {
  const token = args[index];
  if (!KNOWN.includes(token)) {
    usage.push(`unknown option ${token}`);
    continue;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    usage.push(`${token} needs a value`);
    continue;
  }
  index += 1;
  if (token === '--expect-check') {
    if (value === '' || value !== value.trim()) usage.push(`--expect-check needs a whole check name, got "${value}"`);
    else if (extraChecks.includes(value)) usage.push(`--expect-check ${value} is given more than once`);
    else extraChecks.push(value);
    continue;
  }
  if (flags.has(token)) usage.push(`${token} is given more than once`);
  flags.set(token, value);
}

async function api(path, token, accept = 'application/vnd.github+json') {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'kauro-freeze-verdict',
      ...(token === null || token === '' ? {} : { authorization: `Bearer ${token}` }),
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GET ${path} returned ${String(response.status)} ${response.statusText}`);
  return response;
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * One condition of the freeze, with what was observed and where it came from.
 *
 * `by` is how the answer was obtained, in the vocabulary the gates use, and
 * there is deliberately no `EVIDENCE_READ`: reading a claim this repository
 * makes about itself is what this tool exists to replace.
 */
function condition(name, value, by, observed, source) {
  return { name, value, by, observed, source };
}

async function verdict() {
  const conditions = [];
  const token = githubToken();
  const live = liveCandidate();
  const repository = flags.get('--repository') ?? live.repository ?? normaliseRepository(process.env.GITHUB_REPOSITORY ?? '');
  const expectedSha = flags.get('--sha') ?? null;
  const tagName = flags.get('--tag') ?? `v${versions.coreVersion}`;

  if (token === null) {
    conditions.push(condition('github_readable', false, 'OBSERVED', 'no GitHub token is available, so nothing about the remote could be read', 'api.github.com'));
    return { conditions, repository, expectedSha, tagName };
  }
  if (repository === null || expectedSha === null) {
    conditions.push(
      condition('inputs_named', false, 'EXECUTED', `repository ${String(repository)} and --sha ${String(expectedSha)}; both are required`, 'the command line'),
    );
    return { conditions, repository, expectedSha, tagName };
  }

  // 1. What main actually points at.
  let head = null;
  try {
    const response = await api(`/repos/${repository}/branches/main`, token);
    const branch = await response.json();
    head = branch.commit?.sha ?? null;
    conditions.push(
      condition(
        'main_is_the_expected_commit',
        head === expectedSha,
        'OBSERVED',
        `GitHub reports main at ${String(head)} and this verdict is about ${expectedSha}`,
        `GET /repos/${repository}/branches/main`,
      ),
    );
  } catch (error) {
    conditions.push(condition('main_is_the_expected_commit', false, 'OBSERVED', `main could not be read: ${String(error.message)}`, 'api.github.com'));
  }

  // 2. This checkout is that commit, and reproduces the digests it claims.
  const measured = measureTree();
  const subject = await measureSubject();
  const campaign = readCampaign();
  let declaredVersions = {};
  try {
    declaredVersions = await readVersions();
  } catch {
    declaredVersions = {};
  }
  const manifest = existsSync(join(repoRoot, 'qualification', 'candidate', 'manifest.json'))
    ? JSON.parse(readFileSync(join(repoRoot, 'qualification', 'candidate', 'manifest.json'), 'utf8'))
    : null;
  const preflight = existsSync(join(repoRoot, 'qualification', 'candidate', 'preflight.json'))
    ? JSON.parse(readFileSync(join(repoRoot, 'qualification', 'candidate', 'preflight.json'), 'utf8'))
    : null;
  conditions.push(
    condition(
      'checkout_is_the_merged_commit',
      live.sha === expectedSha && live.treeClean === true,
      'EXECUTED',
      `this checkout is at ${String(live.sha)}, clean=${String(live.treeClean)}`,
      'git',
    ),
  );
  conditions.push(
    condition(
      'candidate_digests_reproduce',
      manifest !== null && measured.manifestDigest === manifest.manifestDigest && measured.codeDigest === manifest.codeDigest,
      'MEASURED',
      manifest === null
        ? 'there is no candidate manifest'
        : `the tree serialises to ${String(measured.manifestDigest).slice(0, 16)} against a recorded ${String(manifest.manifestDigest).slice(0, 16)} ` +
          `under digest serialisation ${DIGEST_SERIALISATION_VERSION} and exclusion rule ${EXCLUSION_RULE_VERSION}`,
      'qualification/candidate/manifest.json',
    ),
  );
  const preflightFacts = Object.entries(preflight?.facts ?? {});
  const falsePreflight = preflightFacts.filter(([, entry]) => entry?.value !== true).map(([name]) => name);
  conditions.push(
    condition(
      'preflight_facts_all_true',
      preflight !== null && preflight.MIGRATION_CORE_CANDIDATE_PREFLIGHT === 'TRUE' && falsePreflight.length === 0,
      'EVIDENCE_VERIFIED',
      preflight === null ? 'there is no preflight' : `${String(preflightFacts.length)} facts; false: ${falsePreflight.join(', ') || 'none'}`,
      'qualification/candidate/preflight.json',
    ),
  );
  // Coverage per producer: every producer the campaign sealed a fingerprint
  // for still fingerprints the same over this tree. A whole-subject digest was
  // the previous rule, and it refused a campaign whenever any file in any
  // harness moved, whether or not a producer read it.
  //
  // The universe's entry in the seal is not part of this comparison. It takes
  // no capture; its binding is the manifest and code digest its report
  // records, compared in `candidate_digests_reproduce` here and in
  // `offline_release_universe_passed` in the gate whose verdict reaches here
  // through the receipt. Comparing its whole-subject fingerprint against the
  // seal would refuse every campaign whose tools changed after sealing, which
  // is the whole-subject binding this condition was moved away from.
  const producers = await measureProducers();
  const sealedProducers = campaign?.producers ?? null;
  const moved = [];
  if (sealedProducers !== null && typeof sealedProducers === 'object') {
    for (const [producer, sealed] of Object.entries(sealedProducers)) {
      if (sealed?.kind === 'UNIVERSE') continue;
      if (producers.fingerprints[producer] !== sealed?.fingerprint) moved.push(producer);
    }
  }
  conditions.push(
    condition(
      'campaign_covers_this_subject',
      campaign !== null && sealedProducers !== null && producers.problems.length === 0 && moved.length === 0,
      'MEASURED',
      campaign === null
        ? 'no campaign is sealed'
        : sealedProducers === null
          ? `campaign ${String(campaign.campaignId)} records no producer fingerprints and must be re-sealed`
          : moved.length === 0
            ? `campaign ${String(campaign.campaignId)}: every sealed producer fingerprints the same over this tree (${String(Object.keys(sealedProducers).length)} producers)`
            : `campaign ${String(campaign.campaignId)}: inputs moved for ${moved.join(', ')}`,
      'qualification/candidate/campaign.json',
    ),
  );
  const floorProblems = versionFloorProblems(declaredVersions);
  conditions.push(
    condition(
      'versions_at_or_above_floor',
      floorProblems.length === 0,
      'EXECUTED',
      floorProblems.length === 0
        ? `core ${String(declaredVersions.coreVersion)}, package format ${String(declaredVersions.packageFormatVersion)}`
        : floorProblems.join('; '),
      'tools/version-floors.mjs',
    ),
  );

  // 3. The external CI receipt for that commit.
  const receiptPath = flags.get('--receipt') ?? process.env.KAURO_RECEIPT_PATH ?? null;
  // Section 6 compares the release's ci-receipt.json byte for byte with this
  // file, so the path is the same one.
  if (receiptPath === null || !existsSync(receiptPath)) {
    conditions.push(
      condition('external_receipt_verified', false, 'EVIDENCE_VERIFIED', `no receipt at ${String(receiptPath)}; the receipt is a CI artifact and is downloaded, not written here`, 'tools/receipt-verify.mjs'),
    );
  } else {
    let receipt = null;
    try {
      receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    } catch (error) {
      receipt = null;
      conditions.push(condition('external_receipt_verified', false, 'EVIDENCE_VERIFIED', `${receiptPath} is not readable JSON: ${String(error.message)}`, receiptPath));
    }
    if (receipt !== null) {
      const observation = await observeRun({ repository: receipt.repository, sha: receipt.sha, runId: receipt.runId, token });
      // Outside the run and after it: the run and the receipt job must have concluded success (D77, MCD-R1).
      const problems = receiptProblems(receipt, live, readWorkflow(), observation, { requireFinished: true });
      conditions.push(
        condition(
          'external_receipt_verified',
          // The repository, as well as the commit.
          //
          // The run is fetched with `receipt.repository`, and receiptProblems
          // then compares that field against the run it just fetched with it —
          // against itself. Nothing compared it to the repository this verdict
          // is about. So a genuine receipt from a mirror of this tree, whose
          // Actions are green and whose branch has no protection at all,
          // satisfied the condition, and the repository was never printed.
          problems.length === 0 && receipt.sha === expectedSha && receipt.repository === repository,
          'EVIDENCE_VERIFIED',
          problems.length === 0
            ? `run ${String(receipt.runId)} on ${String(receipt.sha).slice(0, 12)}, ${String((observation.jobs ?? []).length)} jobs read with every attempt`
            : problems.join('; '),
          receiptPath,
        ),
      );
    }
  }

  // 4. The protection actually in force, and the checks it actually requires.
  const workflow = readWorkflow();
  const declaredLegs = requiredJobLegs(workflow).map((leg) => leg.name);
  // The declared legs, not a string that was joined and split again.
  //
  // This read `(flags.get(...) ?? declaredLegs.join(',')).split(',')`, and a
  // matrix leg is named "gate (ubuntu-latest, node 22)" — the comma is inside
  // the name. Joining ten names with commas and splitting on commas turned the
  // four matrix legs into eight fragments, none of which any ruleset could
  // contain, so `main_protection_in_force` reported main as not requiring
  // exactly the four checks it did require. The round trip only ever existed to
  // parse the flag, so only the flag is parsed.
  //
  // And only ever added to. An option that replaced the list could drop a
  // normative check by omission; `--expect-check` appends one whole name per
  // occurrence to the legs the workflow declares.
  const expectedChecks = [...declaredLegs, ...extraChecks.filter((name) => !declaredLegs.includes(name))];
  try {
    const response = await api(`/repos/${repository}/rules/branches/main`, token);
    const rules = await response.json();
    const kinds = new Set(rules.map((rule) => rule.type));
    const requiredChecks = rules
      .filter((rule) => rule.type === 'required_status_checks')
      .flatMap((rule) => (rule.parameters?.required_status_checks ?? []).map((entry) => entry.context));
    const missing = expectedChecks.filter((name) => !requiredChecks.includes(name));
    const pullRequest = rules.find((rule) => rule.type === 'pull_request');
    const protectionProblems = [];
    if (missing.length > 0) protectionProblems.push(`main does not require ${missing.join(', ')}`);
    for (const kind of ['pull_request', 'required_linear_history', 'deletion', 'non_fast_forward']) {
      if (!kinds.has(kind)) protectionProblems.push(`main carries no ${kind} rule`);
    }
    if (pullRequest !== undefined && pullRequest.parameters?.required_review_thread_resolution !== true) {
      protectionProblems.push('main does not require conversation resolution');
    }
    conditions.push(
      condition(
        'main_protection_in_force',
        protectionProblems.length === 0,
        'OBSERVED',
        protectionProblems.length === 0
          ? `${String(requiredChecks.length)} required checks, pull request, linear history, no deletion, no force push`
          : protectionProblems.join('; '),
        `GET /repos/${repository}/rules/branches/main`,
      ),
    );
  } catch (error) {
    conditions.push(condition('main_protection_in_force', false, 'OBSERVED', `the branch rules could not be read: ${String(error.message)}`, 'api.github.com'));
  }

  // A ruleset with a bypass actor is a protection anyone on that list can step
  // around, which is a different protection from the one its rules describe.
  try {
    const response = await api(`/repos/${repository}/rulesets`, token);
    const rulesets = await response.json();
    const bypass = [];
    for (const summary of rulesets) {
      const detail = await (await api(`/repos/${repository}/rulesets/${String(summary.id)}`, token)).json();
      if ((detail.bypass_actors ?? []).length > 0) bypass.push(`${String(detail.name)} allows ${String((detail.bypass_actors ?? []).length)} bypass actors`);
    }
    conditions.push(
      condition('no_bypass_actors', bypass.length === 0, 'OBSERVED', bypass.length === 0 ? 'no ruleset on this repository allows a bypass' : bypass.join('; '), `GET /repos/${repository}/rulesets`),
    );
  } catch (error) {
    conditions.push(condition('no_bypass_actors', false, 'OBSERVED', `the rulesets could not be read: ${String(error.message)}`, 'api.github.com'));
  }

  // 5. The tag, and that it points at this commit.
  try {
    const ref = await (await api(`/repos/${repository}/git/ref/tags/${tagName}`, token)).json();
    let target = ref.object?.sha ?? null;
    let annotated = ref.object?.type === 'tag';
    if (annotated) {
      const tag = await (await api(`/repos/${repository}/git/tags/${String(ref.object.sha)}`, token)).json();
      target = tag.object?.sha ?? null;
    }
    conditions.push(
      condition(
        'annotated_tag_on_this_commit',
        annotated && target === expectedSha,
        'OBSERVED',
        `${tagName} is ${annotated ? 'annotated' : 'lightweight'} and points at ${String(target)}`,
        `GET /repos/${repository}/git/ref/tags/${tagName}`,
      ),
    );
  } catch (error) {
    conditions.push(condition('annotated_tag_on_this_commit', false, 'OBSERVED', `${tagName} could not be read: ${String(error.message)}`, 'api.github.com'));
  }

  // 6. The release: published, immutable, on this tag, carrying exactly the
  // dossier of this candidate — downloaded, hashed, and bound.
  //
  // Two conditions, not one. The old block accepted `unrelated.txt` beside a
  // matching SHA256SUMS because it verified sums against files and nothing
  // against the candidate, and it never read `immutable`. The inventory and
  // the bindings live in tools/release-dossier.mjs, where the dossier is also
  // built; the verdict only supplies what it measured in this checkout and the
  // receipt it was handed, and compares.
  const receiptBytes = receiptPath !== null && existsSync(receiptPath) ? readFileSync(receiptPath) : null;
  // A verdict computed under CONTROL_FLOW_TEST_ONLY — the chain's rehearsal,
  // against a GitHub served from a file — says so in its own report and
  // accepts only a dossier that says the same; outside it, that dossier is
  // refused. Neither can be mistaken for the other.
  const controlFlowTestOnly = process.env.KAURO_CONTROL_FLOW_TEST_ONLY === '1';
  // The commit, rebuilt from git alone (MC-07): the package, source and
  // evidence archives are compared entry by entry with what the commit
  // builds and contains, never only with the sums uploaded beside them. A
  // reconstruction that fails is handed over as a failure, which the verifier
  // refuses; it is never skipped.
  let reconstruction;
  try {
    reconstruction = await reconstructCandidate({ sha: expectedSha, coreVersion: versions.coreVersion });
  } catch (error) {
    reconstruction = { sha: expectedSha, package: null, source: null, evidence: null, problems: [`the commit could not be reconstructed: ${String(error.message)}`], notes: [] };
  }
  const releaseFacts = {
    controlFlowTestOnly,
    repository,
    gitTree: live.gitTree,
    coreVersion: versions.coreVersion,
    packageFormatVersion: versions.packageFormatVersion,
    codeDigest: measured.codeDigest,
    manifestDigest: measured.manifestDigest,
    subjectDigest: subject?.subjectDigest ?? null,
    campaignId: campaign?.campaignId ?? null,
    producers: producers.fingerprints,
    ...receiptCheckIdentity(readWorkflow()),
    reconstruction,
  };
  const release = await verifyPublishedRelease({
    api: githubTransport(token),
    repository,
    tagName,
    expectedSha,
    facts: releaseFacts,
    receiptSha256: receiptBytes === null ? null : sha256(receiptBytes),
    allowDraft: false,
  });
  conditions.push(condition('release_published_immutable', release.published.value, 'OBSERVED', release.published.observed, `GET /repos/${repository}/releases/tags/${tagName}`));
  conditions.push(
    condition(
      'release_assets_verified',
      release.assets.value,
      'MEASURED',
      `${release.assets.observed} (inventory ${DOSSIER_INVENTORY_VERSION})`,
      `GET /repos/${repository}/releases/tags/${tagName}`,
    ),
  );

  return { conditions, repository, expectedSha, tagName, campaign, subject, controlFlowTestOnly };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (usage.length > 0) {
    process.stderr.write(
      `${usage.map((problem) => `  ${problem}\n`).join('')}\n` +
        'usage: node tools/freeze-verdict.mjs --sha <merged sha> [--tag <tag>] [--receipt <path>] [--out <path>] [--repository <owner/name>] [--expect-check <full check name>]...\n',
    );
    process.exit(64);
  }

  const { conditions, repository, expectedSha, tagName, campaign, subject, controlFlowTestOnly } = await verdict();
  const all = conditions.every((entry) => entry.value === true);

  // The four flags, and which conditions each rests on. Written out rather than
  // folded into one boolean so a reader can see what a FALSE is about — and so
  // that a flag cannot become true by a condition being removed.
  const ARCHITECTURE_CLOSED_ON = [
    'checkout_is_the_merged_commit',
    'candidate_digests_reproduce',
    'preflight_facts_all_true',
    'versions_at_or_above_floor',
  ];
  const RELEASE_CANDIDATE_ON = [
    ...ARCHITECTURE_CLOSED_ON,
    'external_receipt_verified',
    'campaign_covers_this_subject',
    'main_is_the_expected_commit',
  ];

  /**
   * A flag is TRUE when every condition it rests on is present and true.
   *
   * Present matters as much as true. This was `conditions.filter(…).every(…)`,
   * and `[].every(…)` is `true` — so when the GitHub read failed and none of
   * the named conditions was produced at all, the filter returned an empty array
   * and both ARCHITECTURE_CLOSED and RELEASE_CANDIDATE came out TRUE. The
   * verdict printed two terminal flags as true beside a single condition saying
   * that nothing about the remote could be read. A flag that is true because
   * nothing was measured is the exact failure this tool exists to make
   * impossible.
   *
   * @param {readonly string[]} names the conditions the flag rests on
   * @returns {{value: boolean, missing: string[], failed: string[]}}
   */
  const restingOn = (names) => {
    const byName = new Map(conditions.map((entry) => [entry.name, entry]));
    const missing = names.filter((name) => !byName.has(name));
    const failed = names.filter((name) => byName.get(name)?.value !== true);
    return { value: missing.length === 0 && failed.length === 0, missing, failed: failed.filter((name) => !missing.includes(name)) };
  };

  const architectureClosed = restingOn(ARCHITECTURE_CLOSED_ON);
  const releaseCandidate = restingOn(RELEASE_CANDIDATE_ON);
  const frozen = {
    value: conditions.length > 0 && conditions.every((entry) => entry.value === true),
    missing: conditions.length === 0 ? ['every condition; nothing was measured'] : [],
    failed: conditions.filter((entry) => entry.value !== true).map((entry) => entry.name),
  };

  const report = {
    artifactKind: 'MIGRATION_CORE_FREEZE_VERDICT',
    verdictVersion: '1.1.0',
    ...(controlFlowTestOnly === true ? { controlFlowTestOnly: true, note: 'computed in a rehearsal against an injected transport; not a freeze' } : {}),
    decidedBy: 'tools/freeze-verdict.mjs',
    decidedAt: `${new Date().toISOString().slice(0, 19)}Z`,
    repository,
    sha: expectedSha,
    tag: tagName,
    campaignId: campaign?.campaignId ?? null,
    subjectDigest: subject?.subjectDigest ?? null,
    versions: { ...versions },
    conditions,
    // What each flag rests on, and what is missing or failed under it, beside the
    // flag itself. A FALSE that does not say which condition produced it sends
    // whoever reads it back through every one of them.
    restsOn: {
      MIGRATION_CORE_ARCHITECTURE_CLOSED: { conditions: ARCHITECTURE_CLOSED_ON, missing: architectureClosed.missing, failed: architectureClosed.failed },
      MIGRATION_CORE_RELEASE_CANDIDATE: { conditions: RELEASE_CANDIDATE_ON, missing: releaseCandidate.missing, failed: releaseCandidate.failed },
      MIGRATION_CORE_IMPLEMENTATION_FROZEN: { conditions: conditions.map((entry) => entry.name), missing: frozen.missing, failed: frozen.failed },
    },
    MIGRATION_CORE_ARCHITECTURE_CLOSED: architectureClosed.value ? 'TRUE' : 'FALSE',
    MIGRATION_CORE_RELEASE_CANDIDATE: releaseCandidate.value ? 'TRUE' : 'FALSE',
    MIGRATION_CORE_IMPLEMENTATION_FROZEN: frozen.value ? 'TRUE' : 'FALSE',
    MIGRATION_CORE_V1_FROZEN: frozen.value ? 'TRUE' : 'FALSE',
  };

  const out = flags.get('--out');
  if (out !== undefined) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  }

  const width = Math.max(...conditions.map((entry) => entry.name.length));
  process.stderr.write('\nFREEZE VERDICT\n\n');
  for (const entry of conditions) {
    process.stderr.write(`  ${entry.name.padEnd(width)}  ${String(entry.value).padEnd(6)} [${entry.by}] ${entry.observed}\n`);
  }
  process.stderr.write(
    `\nMIGRATION_CORE_ARCHITECTURE_CLOSED=${report.MIGRATION_CORE_ARCHITECTURE_CLOSED}\n` +
      `MIGRATION_CORE_RELEASE_CANDIDATE=${report.MIGRATION_CORE_RELEASE_CANDIDATE}\n` +
      `MIGRATION_CORE_IMPLEMENTATION_FROZEN=${report.MIGRATION_CORE_IMPLEMENTATION_FROZEN}\n` +
      `MIGRATION_CORE_V1_FROZEN=${report.MIGRATION_CORE_V1_FROZEN}\n\n`,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(all ? 0 : 1);
}

export { verdict };
