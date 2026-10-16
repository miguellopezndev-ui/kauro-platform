/**
 * A campaign, and what a producer records about the subject it measured.
 *
 * ---- what this replaces, and why ----
 *
 * MC-2 bound a measurement to a candidate in two different ways, and both were
 * defeated. Capacity evidence was bound by `tools/candidate-provenance.mjs
 * --stamp`, a tool that wrote the current code digest onto whatever files were
 * in a directory — so a measurement taken against different code became
 * "current" by running a program, which is the failure the whole front exists
 * to prevent. Vendor evidence was bound by `qualification/candidate-binding.mjs`,
 * which was better because the runner wrote it while it ran, but it bound to a
 * digest over `src`, `tools`, `spec` and the lockfile: a change to an expected
 * truth, a corpus or a fixture moved nothing, so a runner could change what it
 * expected and the binding would not notice.
 *
 * What a measurement is about is its **execution subject** — the runtime, the
 * harness, the oracle, the fixtures, the contracts, the dependency closure, the
 * declared versions and the workflow (see `tools/execution-subject.mjs`, and
 * `tools/invalidation-policy.mjs` for which paths are in it and which are
 * editorial). So a producer captures the subject when it starts and again when
 * it finishes:
 *
 *   - if the two disagree, the tree moved while the producer ran and the
 *     evidence is written `valid: false` rather than quietly describing a
 *     subject that no longer exists;
 *   - if the subject at start is not the candidate's subject, the gate refuses
 *     the evidence and says the only thing that fixes it: re-run the producer.
 *
 * ---- the campaign ----
 *
 * One campaign is one set of inputs sealed at one moment, and every producer of
 * that campaign records its id. That is what makes "the five vendor gates and
 * the three founding profiles were measured against the same thing" a checkable
 * statement rather than a sentence: evidence moved between campaigns, or mixed
 * from two, is refused on the campaign id before any hash is compared.
 *
 * The id is derived from the subject digest and the sealing instant, so it
 * cannot be chosen, and `qualification/candidate/campaign.json` records what the
 * campaign was for.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { environmentRecord, measureSubject } from '../tools/execution-subject.mjs';
import { PRODUCERS, measureProducers } from '../tools/producer-closure.mjs';
import { repoRoot } from '../tools/candidate-provenance.mjs';

// 2.0.0: a capture carries its producer's fingerprint and is bound by it. The
// 1.0.0 capture was bound by the whole-subject digest, and a gate reading it had
// no way to tell "the sabotage harness moved" from "the engine moved".
export const CAPTURE_VERSION = '2.0.0';
export const CAMPAIGN_VERSION = '2.0.0';
export const CAMPAIGN_PATH = 'qualification/candidate/campaign.json';

/** UTC, to the second. One call, so a start and the values derived from it agree. */
export function nowUtc() {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

export function campaignIdFor(subjectDigest, sealedAt) {
  return `c_${createHash('sha256').update(`${String(subjectDigest)}\u0000${String(sealedAt)}`, 'utf8').digest('hex').slice(0, 16)}`;
}

export function campaignPath() {
  return join(repoRoot, ...CAMPAIGN_PATH.split('/'));
}

/**
 * The campaign this tree is sealed under, or null where none has been sealed.
 *
 * A producer refuses to run without one: a measurement that belongs to no
 * campaign is a measurement nothing can group, and grouping is what makes the
 * five vendor gates and the capacity runs one body of evidence.
 */
export function readCampaign() {
  const path = campaignPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Seal a campaign over the subject this tree currently is.
 *
 * @param {{sealedAt?: string, note?: string, producers?: readonly string[]}} options
 */
export async function sealCampaign(options = {}) {
  const { subject, subjectDigest, problems } = await measureSubject();
  if (subject === null) throw new Error(`the execution subject could not be measured:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  // Every producer's closure, fingerprinted at the seal. This is what a
  // producer starting later compares itself against, and what a gate compares
  // evidence against: not the whole subject, but the files that producer reads.
  const producers = await measureProducers();
  if (producers.problems.length > 0) {
    throw new Error(`a producer's closure could not be fingerprinted, so the campaign cannot say what it measures:\n${producers.problems.map((problem) => `  - ${problem}`).join('\n')}`);
  }
  return Promise.resolve().then(() => {
    const sealedAt = options.sealedAt ?? nowUtc();
    const campaign = {
      campaignVersion: CAMPAIGN_VERSION,
      artifactKind: 'MIGRATION_CORE_CAMPAIGN',
      campaignId: campaignIdFor(subjectDigest, sealedAt),
      sealedAt,
      subjectDigest,
      subjectVersion: subject.subjectVersion,
      codeDigest: subject.codeDigest,
      versions: subject.versions,
      classes: Object.fromEntries(Object.entries(subject.classes).map(([name, entry]) => [name, { files: entry.files, digest: entry.digest, inSubject: entry.inSubject }])),
      dependencies: { lockfileVersion: subject.dependencies.lockfileVersion, packageCount: subject.dependencies.packageCount, closureDigest: subject.dependencies.closureDigest },
      // Producer → fingerprint over its own closure. The unit of invalidation.
      producers: Object.fromEntries(
        Object.keys(PRODUCERS).map((producer) => [producer, { fingerprint: producers.fingerprints[producer], files: producers.details[producer].files, kind: producers.details[producer].kind }]),
      ),
      note: options.note ?? 'Every producer of this campaign captures this subject digest at start and at end.',
    };
    const path = campaignPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(campaign, null, 2)}\n`);
    return campaign;
  });
}

/**
 * Begin a producer's capture.
 *
 * Throws rather than returning a half-built capture: a producer that carried on
 * would write evidence the gate rejects for the wrong reason, and whoever read
 * the rejection would go looking for a vendor problem that does not exist.
 *
 * @param {{producer: string, campaignId?: string|null}} input `producer` is this runner's repository path
 */
export async function captureStart({ producer, campaignId }) {
  if (typeof producer !== 'string' || producer === '') throw new Error('a capture names the producer that took it');
  if (PRODUCERS[producer] === undefined) {
    throw new Error(`${producer} is not a declared producer. Declare it in tools/producer-closure.mjs with the inputs it reads; an undeclared producer has no closure and so no binding.`);
  }
  const { subject, subjectDigest, problems } = await measureSubject();
  if (subject === null) {
    throw new Error(
      `the execution subject could not be measured, so nothing can honestly say what this measurement is about:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
    );
  }
  const campaign = readCampaign();
  const declared = campaignId ?? campaign?.campaignId ?? null;
  if (declared === null) {
    throw new Error(
      `no campaign is sealed (${CAMPAIGN_PATH} is absent) and none was passed. Seal one with "node tools/seal-campaign.mjs" before producing evidence: ` +
        'a measurement that belongs to no campaign is one nothing can group with the measurements it was taken beside.',
    );
  }
  // The binding is this producer's closure, not the whole subject.
  //
  // It used to be the whole subject, and a fix to the sabotage harness moved
  // the digest the capacity measurements were bound to, three times on one
  // front, over an engine that was byte for byte the same. What has to hold is
  // that the files *this* producer reads are the files the campaign sealed.
  const producers = await measureProducers();
  const fingerprint = producers.fingerprints[producer] ?? null;
  if (fingerprint === null) {
    throw new Error(`${producer}'s closure could not be fingerprinted: ${producers.problems.join('; ')}`);
  }
  const sealed = campaign?.producers?.[producer]?.fingerprint ?? null;
  if (campaign !== null && sealed === null) {
    throw new Error(
      `the sealed campaign ${String(campaign.campaignId)} records no fingerprint for ${producer}. It was sealed under an older rule; ` +
        're-seal it with "node tools/seal-campaign.mjs".',
    );
  }
  if (campaign !== null && sealed !== fingerprint) {
    throw new Error(
      `the sealed campaign ${String(campaign.campaignId)} fingerprints ${producer} as ${String(sealed).slice(0, 12)} and this tree's closure for it is ` +
        `${fingerprint.slice(0, 12)}. Something ${producer} reads has moved since the seal. Re-seal the campaign, or check out the sealed tree.`,
    );
  }
  return {
    captureVersion: CAPTURE_VERSION,
    producer,
    producerFingerprint: fingerprint,
    producerFiles: producers.details[producer].files,
    campaignId: declared,
    // Recorded for the reader, no longer the binding: a reader comparing two
    // captures wants to know whether the whole tree was the same, even when the
    // gate only asks whether this producer's inputs were.
    subjectDigestAtStart: subjectDigest,
    startedAt: nowUtc(),
    environment: environmentRecord(),
  };
}

/**
 * Finish a capture, re-measuring the subject.
 *
 * Never throws on a change: the evidence is written, marked invalid, and says
 * what moved. A producer that threw here would leave no record of a run that
 * did happen, and the record is what a reader needs in order to know why the
 * gate refuses it.
 */
export async function captureEnd(started, extra = {}) {
  const { subject, subjectDigest, problems } = await measureSubject();
  const producers = await measureProducers();
  const endedAt = nowUtc();
  const measured = subject === null ? null : subjectDigest;
  const fingerprint = producers.fingerprints[started.producer] ?? null;
  const changed = fingerprint !== null && fingerprint !== started.producerFingerprint;
  return {
    ...started,
    producerFingerprintAtEnd: fingerprint,
    subjectDigestAtEnd: measured,
    endedAt,
    valid: fingerprint !== null && !changed,
    invalidation:
      fingerprint === null
        ? `PRODUCER_UNMEASURABLE_AT_END: ${producers.problems.join('; ')}`
        : changed
          ? `PRODUCER_INPUTS_CHANGED_DURING_RUN: ${started.producer} started with closure ${started.producerFingerprint.slice(0, 12)} and ended with ${fingerprint.slice(0, 12)}`
          : null,
    ...extra,
  };
}

/**
 * The instance a producer observed, recorded beside the evidence.
 *
 * The raw identifier and its pseudonym together: the gate compares the pseudonym
 * against what the live credential answers, and the raw value is what a person
 * checking the account needs. `observedBy` says which call answered, so a reader
 * can repeat it.
 */
export function observedInstance({ vendor, instanceId, observedBy, detail = null }) {
  if (typeof instanceId !== 'string' || instanceId.trim() === '') throw new Error('an observed instance has an identifier');
  if (typeof observedBy !== 'string' || observedBy === '') throw new Error('an observed instance names the call that answered');
  return {
    vendor,
    instanceId,
    instancePseudonym: `i_${createHash('sha256').update(instanceId, 'utf8').digest('hex').slice(0, 16)}`,
    observedBy,
    detail,
  };
}

/**
 * The instances a qualification is permitted to write to, by live observation.
 *
 * The list is an allowlist, not an authority: what decides which instance was
 * touched is the observation, and what this decides is whether touching it was
 * permitted. A runner calls this before its first write.
 */
export function assertInstanceAuthorised(observed) {
  const path = join(repoRoot, 'qualification', 'authorized-instances.json');
  const allow = JSON.parse(readFileSync(path, 'utf8'));
  const excluded = (allow.excluded ?? []).find(
    (entry) => entry.portalId === observed.instanceId || entry.orgId === observed.instanceId,
  );
  if (excluded !== undefined) {
    throw new Error(
      `REFUSED: ${observed.vendor} instance ${observed.instanceId} is explicitly out of scope — ${String(excluded.reason)}. ` +
        'Nothing is written there.',
    );
  }
  const list = allow[observed.vendor] ?? [];
  const permitted = list.some((entry) => entry.portalId === observed.instanceId || entry.orgId === observed.instanceId);
  if (!permitted) {
    throw new Error(
      `REFUSED: the credential authenticates to ${observed.vendor} instance ${observed.instanceId}, which ${CAMPAIGN_PATH.replace(/[^/]+$/u, '')}` +
        `../authorized-instances.json does not authorise. Qualification writes only to the instances listed there.`,
    );
  }
  return observed;
}
