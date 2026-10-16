/**
 * B03-CAP-REVIEW — the consistency review and the semantic repair (closure
 * plan D3-CAP-11 and D3-CAP-12; review finding B03-R9; cases CAP11 and CAP12).
 *
 * Every case goes through the public run() with the real Migration Core in
 * the host's validation port (the vendored release, through its public
 * entry). The model is a labelled fake: a transport that answers from the
 * serialised request with the oracle's proposal, rewritten per case as a
 * model would answer it (evidence class SIMULATED). No provider is called.
 *
 * CAP11 runs on a CLEAN_ONLY Contacts file with two e-mail columns that the
 * planner asks in two tasks: Alternate Mail, whose claim to contact.email
 * stands on its full-data shape alone (SUPPORTED), and Work Email, whose
 * header names the target as well (STRONG). Each claim is valid on its own;
 * together they claim one output scope, which only the last phase — the
 * consistency review over every compiled decision — may settle. CAP12 runs
 * on a SALESFORCE file whose questions travel in one task, so every request
 * of the run is that task's first answer or its one repair.
 *
 * The review channel of the envelope and the repair context are read through
 * loose views, so a build without them reads as empty and the assertions say
 * what is missing.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { HashedSourceProfile } from 'kauro-migration-core';

import { fieldRefFor } from '../src/adapter/contract-adapter.js';
import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import type { IntelligenceResult } from '../src/api/intelligence-core.js';
import { cleanOnlyTargetRef } from '../src/contracts/envelope.js';
import type { DeterministicCandidate, IntelligenceEnvelopeV1, ProposalType } from '../src/contracts/envelope.js';
import { EVIDENCE_CLASSES } from '../src/contracts/proposal.js';
import type { IntelligenceProposalV1, ProposalItem } from '../src/contracts/proposal.js';
import { HEX64_PATTERN, REF_PATTERN } from '../src/contracts/schema.js';
import { adaptContracts, planTasks, resolveDeterministically } from '../src/index.js';
import { oracleProposal } from '../src/gateway/fake-gateway.js';
import type { GatewayRequest, GatewayResult, ModelGateway } from '../src/gateway/model-gateway.js';
import { parseProviderRequestPayload, transportGateway } from '../src/gateway/transport-gateway.js';
import type { ProviderRequest, Transport } from '../src/gateway/transport-gateway.js';
import { VirtualClock } from '../src/kernel/ledger.js';
import type { CandidateConfiguration, FullDatasetValidationPort, IntelligenceInput } from '../src/ports/ports.js';
import type { FixtureValidationPort } from './support/fixtures.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort, vendorContract } from './support/fixtures.js';

// ------------------------------------------------------------------------------------------------ loose views of the contract

/** One claim of a review candidate, as the review channel of the envelope carries it (D3-CAP-11). */
interface ReviewClaimView {
  readonly candidateRef: string;
  readonly kind: string;
  readonly decisionRef: string;
  readonly origin: string;
  readonly evidenceClass: string;
  readonly fieldRef: string;
  readonly targetRef: string | null;
}
/** The review claims an envelope carries; empty for a build that has no review channel. */
const reviewClaimsOf = (envelope: IntelligenceEnvelopeV1): readonly ReviewClaimView[] => (envelope as unknown as { readonly reviewClaims?: readonly ReviewClaimView[] }).reviewClaims ?? [];
/** One disposition of the result's candidate accounting (D3-ACC-1). */
interface Disposition {
  readonly candidateRef: string;
  readonly disposition: string;
  readonly code: string;
}
const dispositionsOf = (result: IntelligenceResult): readonly Disposition[] => (result as unknown as { readonly candidateAccounting?: { readonly dispositions: readonly Disposition[] } | null }).candidateAccounting?.dispositions ?? [];

/** The answer types a consistency review may carry: a preserve of one named decision, the agency, an abstention — never a mapping (D3-CAP-11). */
const REVIEW_TYPES: readonly ProposalType[] = ['ABSTAIN', 'NEEDS_AGENCY_DECISION', 'UNMAPPED_PRESERVE'];
const CLAIM_KEYS = ['candidateRef', 'decisionRef', 'evidenceClass', 'fieldRef', 'kind', 'origin', 'targetRef'];
const CLAIM_KINDS = ['SAME_SCOPE_TARGET', 'TYPE_AGAINST_TRANSFORM', 'ASSOCIATION_KEY_REUSED', 'REQUIRED_TARGET_PRESERVED'];
/** A closed reason code as a repair context may carry it: the compiler's vocabulary, or an opaque reference the builder minted for a code that echoed text. */
const CLOSED_CODE = /^(?:[A-Z][A-Z0-9_]*|code_[g-v]{12})$/u;

// ------------------------------------------------------------------------------------------------------------ fixtures

const TIMEOUT = { timeout: 240_000 };
const DECLARED = { 'contacts.csv': 'CONTACT' as const, 'companies.csv': 'COMPANY' as const };
const EMAIL = cleanOnlyTargetRef('contact.email');
/** A candidate ref no envelope carries: the ref grammar, and nothing any task was given. */
const UNKNOWN_REF = 'cand_0123456789abcdef';
/** A decision ref no review candidate names and no decision of the run has. */
const UNKNOWN_DECISION = 'dec_0123456789abcdef';

/** Every file under a directory, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}
/** What the last Migration Core package delivered for import, as text, read before the bundle is disposed; empty when Migration Core wrote no package. */
function delivered(port: FixtureValidationPort): string {
  if (port.lastPackage === null) return '';
  return filesUnder(join(port.lastPackage.stagingDir, '01_IMPORT')).map((path) => readFileSync(path, 'utf8')).join('\n');
}
/** The host's validation port over the real Migration Core, recording every configuration it was handed. */
function recordingPort(real: FixtureValidationPort): FullDatasetValidationPort & { readonly configurations: CandidateConfiguration[]; readonly real: FixtureValidationPort } {
  const configurations: CandidateConfiguration[] = [];
  return {
    configurations,
    real,
    async validate(configuration: CandidateConfiguration) {
      configurations.push(configuration);
      return real.validate(configuration);
    },
  };
}
/** The locator of a profiled column, by its header. */
function locatorOf(profile: HashedSourceProfile, header: string): string {
  for (const file of profile.profile.files) for (const sheet of file.sheets) for (const column of sheet.columns) if (column.headerRaw === header) return column.columnLocatorId;
  throw new Error(`no column ${header}`);
}

/** One request that left for the provider: its serialised bytes and the envelope parsed back out of them. */
interface Sent {
  readonly bytes: string;
  readonly envelope: IntelligenceEnvelopeV1;
}
/** How a case answers one request: the proposal to send back, built from the envelope and the oracle's proposal for it. */
type Answer = (envelope: IntelligenceEnvelopeV1, oracle: IntelligenceProposalV1, count: number) => IntelligenceProposalV1 | Record<string, unknown>;

/** A transport that answers every request with the case's proposal and records what left. */
function answeringTransport(answer: Answer, sent: Sent[]): Transport {
  return async (request: ProviderRequest) => {
    const bytes = JSON.stringify(request);
    const payload = parseProviderRequestPayload(bytes);
    sent.push({ bytes, envelope: payload.envelope });
    const oracle = oracleProposal(payload.envelope, payload.runId, { modelPolicyVersion: payload.policyRef.modelPolicyVersion, promptBundleVersion: payload.promptRef.promptBundleVersion });
    const text = JSON.stringify(answer(payload.envelope, oracle, sent.length));
    return { status: 200, body: { id: `msg_b03_cap_review_${String(sent.length)}`, type: 'message', role: 'assistant', model: payload.model, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text }], usage: { input_tokens: Math.ceil(bytes.length / 4), output_tokens: Math.ceil(text.length / 4) } } };
  };
}
/** A gateway over a transport, recording every request it was handed. */
function recordingGateway(transport: Transport): ModelGateway & { readonly requests: GatewayRequest[] } {
  const inner = transportGateway(transport);
  const requests: GatewayRequest[] = [];
  return {
    name: 'b03-cap-review-recording',
    evidenceClass: inner.evidenceClass,
    requests,
    async analyze(request: GatewayRequest): Promise<GatewayResult> {
      requests.push(request);
      return inner.analyze(request);
    },
  };
}

/** The oracle's proposal with its items rewritten one by one; an item rewritten to null is left out. */
function rewritten(oracle: IntelligenceProposalV1, rewrite: (item: ProposalItem) => ProposalItem | null): IntelligenceProposalV1 {
  const items = oracle.items.flatMap((item) => {
    const next = rewrite(item);
    return next === null ? [] : [next];
  });
  const proposed = items.filter((item) => item.proposalType !== 'ABSTAIN' && item.proposalType !== 'UNMAPPED_PRESERVE').length;
  return { ...oracle, items, overallOutcome: proposed === items.length ? 'PROPOSED' : proposed === 0 ? 'ABSTAINED' : 'MIXED' };
}
/** An answer that maps the item to a target on the claim the case names, nothing else changed. */
const mapTo = (item: ProposalItem, targetRef: string, rationaleCode: ProposalItem['rationaleCode'], shortRationale: string | null = null): ProposalItem => ({ ...item, proposalType: 'MAP_FIELD', targetRef, transformPrimitive: 'PRESERVE_AS_IS', typedTransformParams: null, requiresAgencyDecision: false, rationaleCode, shortRationale, abstainReason: null, alternatives: [] });
/** A review answer for one review candidate: a preserve of the named decision, an abstention or the agency. */
function reviewItem(candidate: DeterministicCandidate, proposalType: 'UNMAPPED_PRESERVE' | 'ABSTAIN' | 'NEEDS_AGENCY_DECISION', decisionRef: string | null, shortRationale: string | null = null): ProposalItem {
  return { candidateRef: candidate.candidateRef, proposalType, targetRef: decisionRef, transformPrimitive: null, typedTransformParams: null, evidenceRefs: [...candidate.evidenceRefs], requiresAgencyDecision: proposalType === 'NEEDS_AGENCY_DECISION', rationaleCode: 'INSUFFICIENT_EVIDENCE', shortRationale, alternatives: [], abstainReason: proposalType === 'ABSTAIN' ? 'AMBIGUOUS' : null };
}
/** Whether an envelope is a review task's (its first request or its repair): its candidates are the review channel's. */
const isReview = (envelope: IntelligenceEnvelopeV1): boolean => envelope.taskType === 'CONSISTENCY_REVIEW' || (envelope.repairContext !== null && reviewClaimsOf(envelope).length > 0);

// --------------------------------------------------------------------------------------------------- the CAP11 scenario

const ALTERNATE = ['ada.alternate@kauro-fixture.test', 'grace.alternate@kauro-fixture.test'];
const WORK = ['ada.work@kauro-fixture.test', 'grace.work@kauro-fixture.test'];
const RECORD_IDS = { 'contacts.csv': 'Contact ID', 'companies.csv': 'Company ID' };
const REVIEW_CONTACTS = (alternate: readonly string[], firstId: number): string => `Contact ID,First Name,Last Name,Alternate Mail,Work Email\n${String(firstId)},Ada,Lovelace,${alternate[0] ?? ''},${WORK[0] ?? ''}\n${String(firstId + 1)},Grace,Hopper,${alternate[1] ?? ''},${WORK[1] ?? ''}\n`;

/**
 * The Contacts file of the scenario, chosen through the public planning API
 * so that the planner asks Alternate Mail in an earlier task than Work Email:
 * Migration Core's column locators digest the file's bytes, and the planner
 * orders a record mapping's questions by their refs, so only the record ids
 * vary between the files tried. Nothing of the run is decided here; the run
 * asserts the same premise on the requests that actually left.
 */
function splittingContacts(alternate: readonly string[]): string {
  for (let variant = 0; variant < 64; variant += 1) {
    const contacts = REVIEW_CONTACTS(alternate, 1 + variant * 10);
    const bundle = makeBundle(`b03-cap-review-plan-${String(variant)}`, { contacts });
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
      const resolution = resolveDeterministically(contracts, { declaredObjects: DECLARED, recordIdColumns: RECORD_IDS });
      const planned = planTasks(inputFor('CLEAN_ONLY', profiled, null).projectRevision.projectRevisionHash, resolution.openQuestions);
      const taskOf = (header: string): number => {
        const fieldRef = fieldRefFor(locatorOf(profiled.profile, header));
        return planned.tasks.findIndex((task) => task.candidateRefs.some((ref) => resolution.derivedCandidates.find((candidate) => candidate.candidateRef === ref)?.sourceRefs[0] === fieldRef));
      };
      const [alternateTask, workTask] = [taskOf('Alternate Mail'), taskOf('Work Email')];
      if (alternateTask >= 0 && workTask > alternateTask) return contacts;
    } finally {
      bundle.dispose();
    }
  }
  throw new Error('no Contacts file of the search lets the planner ask Alternate Mail and Work Email in two tasks, Alternate Mail first');
}

/** How a case answers the review: from the review candidate and its claims, the weaker (Alternate Mail) and the stronger (Work Email). */
type ReviewAnswer = (candidate: DeterministicCandidate, claims: { readonly weaker: ReviewClaimView | undefined; readonly stronger: ReviewClaimView | undefined; readonly all: readonly ReviewClaimView[] }, repair: boolean) => ProposalItem;

interface ReviewRun {
  readonly result: IntelligenceResult;
  readonly port: ReturnType<typeof recordingPort>;
  readonly sent: readonly Sent[];
  readonly alternate: string;
  readonly work: string;
  readonly alternateLocator: string;
  readonly profile: HashedSourceProfile;
  /** What the Migration Core package delivered for import, as text. */
  readonly text: string;
}

/**
 * One public run of the CAP11 scenario. The first tasks are answered by the
 * oracle, except that Alternate Mail is mapped to contact.email on its shape
 * and Work Email on its header; the review, when one comes, by `review`.
 */
async function runReview(name: string, review: ReviewAnswer, options: { readonly alternate?: readonly string[]; readonly rationale?: string | null; readonly summaries?: boolean } = {}): Promise<ReviewRun> {
  const alternateValues = options.alternate ?? ALTERNATE;
  const bundle = makeBundle(name, { contacts: splittingContacts(alternateValues) });
  try {
    const profiled = profileBundle(bundle, 'CLEAN_ONLY');
    const alternateLocator = locatorOf(profiled.profile, 'Alternate Mail');
    const alternate = fieldRefFor(alternateLocator);
    const work = fieldRefFor(locatorOf(profiled.profile, 'Work Email'));
    const base = inputFor('CLEAN_ONLY', profiled, null, options.summaries === true ? { categoricalSummaries: new Map([[alternateLocator, [...alternateValues]]]) } : {});
    const input: IntelligenceInput = { ...base, projectRevision: { ...base.projectRevision, declaredObjects: DECLARED, recordIdColumns: RECORD_IDS } };
    const clock = new VirtualClock();
    const port = recordingPort(realValidationPort(bundle, profiled.profile, null, { clock }));
    const sent: Sent[] = [];
    const answer: Answer = (envelope, oracle) => {
      if (isReview(envelope)) {
        const items = envelope.deterministicCandidates.map((candidate) => {
          const all = reviewClaimsOf(envelope).filter((claim) => claim.candidateRef === candidate.candidateRef);
          return review(candidate, { weaker: all.find((claim) => claim.fieldRef === alternate), stronger: all.find((claim) => claim.fieldRef === work), all }, envelope.repairContext !== null);
        });
        return { ...oracle, items, overallOutcome: 'MIXED' };
      }
      const rationale = options.rationale ?? null;
      return rewritten(oracle, (item) => {
        const candidate = envelope.deterministicCandidates.find((entry) => entry.candidateRef === item.candidateRef);
        if (candidate?.sourceRefs[0] === alternate) return mapTo(item, EMAIL, 'SHAPE_MATCHES_TARGET_TYPE', rationale);
        if (candidate?.sourceRefs[0] === work) return mapTo(item, EMAIL, 'HEADER_MATCHES_TARGET_LABEL', rationale);
        return item;
      });
    };
    const gateway = recordingGateway(answeringTransport(answer, sent));
    const result = await createIntelligenceCore(depsFor(gateway, port, clock)).run(input, { ...CONTEXT, auditAttemptId: name });
    // The scenario's premise, asserted: the two claims were asked in two tasks, so each is valid on its own and only the review can see both.
    const first = sent.filter((entry) => !isReview(entry.envelope));
    const carries = (entry: Sent, fieldRef: string): boolean => entry.envelope.deterministicCandidates.some((candidate) => candidate.sourceRefs[0] === fieldRef);
    assert.ok(first.some((entry) => carries(entry, alternate)) && first.some((entry) => carries(entry, work)), 'both e-mail columns were asked');
    assert.ok(!first.some((entry) => carries(entry, alternate) && carries(entry, work)), 'the two e-mail columns travel in two tasks, never in one envelope');
    return { result, port, sent, alternate, work, alternateLocator, profile: profiled.profile, text: delivered(port.real) };
  } finally {
    bundle.dispose();
  }
}

/** The requests of a run that are review tasks' (first requests and repairs). */
const reviewRequests = (run: ReviewRun): readonly Sent[] => run.sent.filter((entry) => isReview(entry.envelope));
/** The field fragments of the configuration Migration Core received, by destination and column header. */
const loadedFields = (run: ReviewRun): readonly string[] => (run.port.configurations[0]?.fields ?? []).map((field) => `${field.destinationField}<-${field.columnHeader}`).sort();
/** The column whose claim the run met first: the one asked in the earlier task. */
function earlierColumn(run: ReviewRun): 'Alternate Mail' | 'Work Email' {
  const at = (fieldRef: string): number => run.sent.findIndex((entry) => !isReview(entry.envelope) && entry.envelope.deterministicCandidates.some((candidate) => candidate.sourceRefs[0] === fieldRef));
  return at(run.alternate) < at(run.work) ? 'Alternate Mail' : 'Work Email';
}

// ------------------------------------------------------------------------------------------------------------------ CAP11

describe('B03-CAP-REVIEW — CAP11: CONSISTENCY_REVIEW over every compiled decision (D3-CAP-11)', () => {
  it('CAP11: two individually valid decisions that compete for contact.email in one record mapping raise a CONSISTENCY_REVIEW task; its evidenced preserve of the weaker claim leaves one mapping in Migration Core and the other column in its leftover accounting', TIMEOUT, async () => {
    const run = await runReview('b03-cap11-preserve', (candidate, claims) => reviewItem(candidate, 'UNMAPPED_PRESERVE', claims.weaker?.decisionRef ?? null));
    const { result } = run;

    // The review task: the last phase, one candidate naming both claims, and nothing it may answer with maps.
    const reviewTasks = result.tasks.filter((task) => task.taskType === 'CONSISTENCY_REVIEW');
    assert.equal(reviewTasks.length, 1, `one CONSISTENCY_REVIEW task ran after the other families: ${JSON.stringify(result.tasks.map((task) => [task.taskType, task.outcome]))}; decisions required ${JSON.stringify(result.draft.decisionsRequired)}`);
    assert.equal(result.tasks[result.tasks.length - 1]?.taskType, 'CONSISTENCY_REVIEW', 'the review is the last task of the run');
    assert.deepEqual([reviewTasks[0]?.outcome, reviewTasks[0]?.attempts], ['PROPOSED', 1]);
    const reviews = reviewRequests(run);
    assert.equal(reviews.length, 1, 'one review request');
    const envelope = reviews[0]?.envelope as IntelligenceEnvelopeV1;
    assert.deepEqual([...envelope.constraints.allowedProposalTypes].sort(), REVIEW_TYPES, 'a review may preserve one named decision, ask the agency or abstain; it never maps');
    assert.equal(envelope.deterministicCandidates.length, 1, 'one review candidate for the one contradiction');
    const candidate = envelope.deterministicCandidates[0] as DeterministicCandidate;
    const claims = reviewClaimsOf(envelope);
    assert.equal(claims.length, 2, `the candidate names both claims: ${JSON.stringify(claims)}`);
    assert.deepEqual(claims.map((claim) => claim.fieldRef).sort(), [run.alternate, run.work].sort());
    assert.ok(claims.every((claim) => claim.candidateRef === candidate.candidateRef && claim.kind === 'SAME_SCOPE_TARGET' && claim.targetRef === EMAIL && claim.origin === 'PROPOSED'), JSON.stringify(claims));
    const weaker = claims.find((claim) => claim.fieldRef === run.alternate);
    const stronger = claims.find((claim) => claim.fieldRef === run.work);
    assert.deepEqual([weaker?.evidenceClass, stronger?.evidenceClass], ['SUPPORTED', 'STRONG'], 'the evidence class of each claim is the one the compiler computed from the facts');
    assert.deepEqual([...candidate.allowedTargetRefs].sort(), [weaker?.decisionRef, stronger?.decisionRef].sort(), 'the decisions a preserve may name are the two claims');

    // Migration Core: one mapping of contact.email, the stronger claim; the weaker column is a preserved column, decided by the review.
    assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
    assert.equal(result.draft.status, 'SYSTEM_DRAFT');
    assert.equal(run.port.configurations.length, 1, 'Migration Core validated one configuration');
    const loaded = run.port.configurations[0] as CandidateConfiguration;
    assert.deepEqual(loaded.fields.filter((field) => field.destinationField === 'contact.email').map((field) => field.columnHeader), ['Work Email'], 'one mapping of contact.email reaches Migration Core: the stronger claim');
    const preserved = loaded.preservedColumns.find((column) => column.columnLocator === run.alternateLocator);
    assert.ok(preserved !== undefined, 'the weaker column is a preserved column of the configuration');
    assert.equal(preserved.decisionRef, candidate.candidateRef, "the preserved column names the review's decision");
    const { text } = run;
    assert.ok(text !== '', 'Migration Core wrote a package');
    for (const value of WORK) assert.ok(text.includes(value), `Migration Core delivers ${value} as contact.email`);
    for (const value of ALTERNATE) assert.ok(!text.includes(value), `Migration Core does not deliver ${value}`);
    // The leftover accounting: Migration Core counts every populated cell of the weaker column as an unmapped leftover, met on the fragment's hash.
    const leftover = result.draft.fullValidation?.effects?.unmapped.find((cell) => cell.columnLocator === run.alternateLocator);
    assert.ok(leftover !== undefined, 'Migration Core accounts the weaker column as unmapped leftovers');
    assert.equal(leftover.cells, ALTERNATE.length);
    assert.equal(result.draft.fragmentCoverage?.complete, true, 'every fragment, the review preserve among them, is observed in the effects');
    const manifest = result.draft.fragmentCoverage?.entries.find((entry) => entry.decisionRef === candidate.candidateRef);
    assert.deepEqual([manifest?.fragmentKind, manifest?.origin, manifest?.observed], ['PRESERVED_COLUMN', 'PROPOSED', true]);

    // Nothing is left for the agency, and the accounting says what became of each claim.
    assert.ok(!result.draft.decisionsRequired.some((entry) => entry.reason.startsWith('DUPLICATE_TARGET')), JSON.stringify(result.draft.decisionsRequired));
    const of = (fieldRef: string): Disposition | undefined => dispositionsOf(result).find((entry) => entry.candidateRef === (fieldRef === run.alternate ? weaker?.decisionRef : stronger?.decisionRef));
    assert.deepEqual([of(run.alternate)?.disposition, of(run.alternate)?.code], ['PRESERVED', 'CONSISTENCY_REVIEW'], 'the weaker claim is preserved by the review');
    assert.equal(of(run.work)?.disposition, 'PROPOSED', 'the stronger claim is the mapping');
  });

  it('CAP11: a consistency answer that keeps both, preserves the stronger claim or overrides a deterministic decision grants itself nothing; it is an agency decision and Migration Core receives the earlier claim only', TIMEOUT, async () => {
    // Keeps both: the review abstains, leaving both claims standing.
    const both = await runReview('b03-cap11-both', (candidate) => reviewItem(candidate, 'ABSTAIN', null));
    // Preserves the stronger claim.
    const stronger = await runReview('b03-cap11-stronger', (candidate, claims) => reviewItem(candidate, 'UNMAPPED_PRESERVE', claims.stronger?.decisionRef ?? null));
    // Overrides a deterministic decision: the resolver mapped First Name on facts; the review names that decision to preserve.
    const firstName = both.result.draft.evidence.find((entry) => entry.origin === 'DETERMINISTIC' && entry.destinationField === 'contact.firstName')?.candidateRef;
    assert.ok(firstName !== undefined, 'the resolver decided First Name deterministically');
    const deterministic = await runReview('b03-cap11-deterministic', (candidate) => reviewItem(candidate, 'UNMAPPED_PRESERVE', firstName));

    const cases: readonly (readonly [string, ReviewRun, string])[] = [
      ['keeps both', both, 'CONSISTENCY_BOTH_CLAIMS_STAND'],
      ['preserves the stronger claim', stronger, 'CONSISTENCY_PRESERVE_NOT_OF_WEAKER_CLAIM'],
      ['overrides a deterministic decision', deterministic, 'CONSISTENCY_DETERMINISTIC_DECISION_KEPT'],
    ];
    const configurations: string[][] = [];
    for (const [label, run, code] of cases) {
      const { result } = run;
      const review = result.tasks.find((task) => task.taskType === 'CONSISTENCY_REVIEW');
      assert.ok(review !== undefined, `${label}: the contradiction raised a CONSISTENCY_REVIEW task: ${JSON.stringify(result.tasks.map((task) => [task.taskType, task.outcome]))}`);
      // An agency decision, by its closed code, answered once: nothing to repair and nothing granted.
      assert.deepEqual([review.outcome, review.attempts], ['REQUIRES_AGENCY_DECISION', 1], `${label}: ${JSON.stringify(review)}`);
      assert.ok(review.codes.includes(code), `${label}: the review's answer is refused as ${code}: ${JSON.stringify(review.codes)}`);
      assert.equal(reviewRequests(run).length, 1, `${label}: one review request, no repair`);
      const candidateRef = reviewRequests(run)[0]?.envelope.deterministicCandidates[0]?.candidateRef;
      assert.ok(result.draft.decisionsRequired.some((entry) => entry.candidateRef === candidateRef && entry.reason === code), `${label}: the draft leaves the contradiction to the agency: ${JSON.stringify(result.draft.decisionsRequired)}`);
      // Migration Core receives the earlier claim only, and every deterministic decision stands.
      assert.equal(result.state, 'PROPOSAL_READY', `${label}: ${JSON.stringify(result.unresolvedItems)}`);
      const earlier = earlierColumn(run);
      const loaded = run.port.configurations[0] as CandidateConfiguration;
      assert.deepEqual(loaded.fields.filter((field) => field.destinationField === 'contact.email').map((field) => field.columnHeader), [earlier], `${label}: Migration Core receives the earlier claim only`);
      assert.ok(loaded.fields.some((field) => field.destinationField === 'contact.firstName' && field.columnHeader === 'First Name'), `${label}: the deterministic decision stands`);
      assert.ok(!loaded.preservedColumns.some((column) => column.decisionRef === candidateRef), `${label}: the review put nothing into the configuration`);
      const { text } = run;
      assert.ok(text !== '', `${label}: Migration Core wrote a package`);
      const [kept, other] = earlier === 'Alternate Mail' ? [ALTERNATE, WORK] : [WORK, ALTERNATE];
      for (const value of kept) assert.ok(text.includes(value), `${label}: the earlier claim is delivered: ${value}`);
      for (const value of other) assert.ok(!text.includes(value), `${label}: the later claim is not delivered: ${value}`);
      configurations.push([...loadedFields(run)]);
    }
    assert.deepEqual(configurations[1], configurations[0], 'preserving the stronger claim changes nothing Migration Core receives');
    assert.deepEqual(configurations[2], configurations[0], 'naming a deterministic decision changes nothing Migration Core receives');
  });
});

// --------------------------------------------------------------------------------------------------- the CAP12 scenario

const HOME = ['ada.home@kauro-fixture.test', 'grace.home@kauro-fixture.test'];
const REPAIR_CONTACTS = `Contact ID,First Name,Last Name,Home Email\n1,Ada,Lovelace,${HOME[0] ?? ''}\n2,Grace,Hopper,${HOME[1] ?? ''}\n`;

interface RepairRun {
  readonly result: IntelligenceResult;
  readonly port: ReturnType<typeof recordingPort>;
  readonly sent: readonly Sent[];
  readonly home: string;
  /** What the Migration Core package delivered for import, as text. */
  readonly text: string;
}

/**
 * One public run of the CAP12 scenario. The first answer is the oracle's —
 * Home Email mapped to the contract's Email on its header — except that the
 * Home Email item names a candidate ref the envelope never carried; the
 * repair round is answered by `repair`.
 */
async function runRepair(name: string, repair: (item: ProposalItem, home: boolean) => ProposalItem): Promise<RepairRun> {
  const contract = vendorContract('SALESFORCE');
  const bundle = makeBundle(name, { contacts: REPAIR_CONTACTS });
  try {
    const profiled = profileBundle(bundle, 'SALESFORCE');
    const home = fieldRefFor(locatorOf(profiled.profile, 'Home Email'));
    const base = inputFor('SALESFORCE', profiled, contract);
    const input: IntelligenceInput = { ...base, projectRevision: { ...base.projectRevision, declaredObjects: DECLARED } };
    const clock = new VirtualClock();
    const port = recordingPort(realValidationPort(bundle, profiled.profile, contract, { clock }));
    const sent: Sent[] = [];
    const answer: Answer = (envelope, oracle) =>
      rewritten(oracle, (item) => {
        const isHome = envelope.deterministicCandidates.find((entry) => entry.candidateRef === item.candidateRef)?.sourceRefs[0] === home;
        if (envelope.repairContext !== null) return repair(item, isHome);
        return isHome ? { ...item, candidateRef: UNKNOWN_REF } : item;
      });
    const gateway = recordingGateway(answeringTransport(answer, sent));
    const result = await createIntelligenceCore(depsFor(gateway, port, clock)).run(input, { ...CONTEXT, auditAttemptId: name });
    // Since B03-CAP-STRUCTURE the columns of this fixture that no target can hold are an UNMAPPED_HANDLING question of their own (D3-CAP-09): the requests about Home Email are the one FIELD_MAPPING task's alone (its first round and its repair), and no other task asks about it.
    const homeAsked = (entry: Sent): boolean => entry.envelope.deterministicCandidates.some((candidate) => candidate.sourceRefs[0] === home);
    const homeTask = sent.find(homeAsked)?.envelope.taskId;
    assert.ok(homeTask !== undefined, 'Home Email is asked');
    assert.ok(sent.every((entry) => entry.envelope.taskId === homeTask || !homeAsked(entry)), 'every request about Home Email is the one task');
    const ofHome = sent.filter((entry) => entry.envelope.taskId === homeTask);
    assert.ok(ofHome[0]?.envelope.taskType === 'FIELD_MAPPING', 'Home Email is asked in a FIELD_MAPPING task');
    return { result, port, sent: ofHome, home, text: delivered(port.real) };
  } finally {
    bundle.dispose();
  }
}

/** The repair round as it left: its envelope, beside the first request's. */
function repairOf(run: RepairRun): { readonly first: IntelligenceEnvelopeV1; readonly repair: IntelligenceEnvelopeV1 } {
  assert.equal(run.sent.length, 2, `exactly two requests: the first answer and its one repair, never a third (${String(run.sent.length)})`);
  const first = run.sent[0]?.envelope as IntelligenceEnvelopeV1;
  const repair = run.sent[1]?.envelope as IntelligenceEnvelopeV1;
  assert.equal(first.repairContext, null);
  assert.ok(repair.repairContext !== null, 'the second request is the repair round');
  return { first, repair };
}

// ------------------------------------------------------------------------------------------------------------------ CAP12

describe('B03-CAP-REVIEW — CAP12: SEMANTIC_REPAIR keeps the original task and its permissions (D3-CAP-12)', () => {
  it('CAP12: an invalid first answer naming an unknown candidate ref is repaired once from minimized reason codes; the repaired mapping reaches Migration Core after exactly two requests', TIMEOUT, async () => {
    const run = await runRepair('b03-cap12-repaired', (item) => item);
    const { first, repair } = repairOf(run);
    // The repair envelope: the same task, the original task's permissions exactly, the same candidates and targets.
    assert.equal(repair.taskId, first.taskId);
    assert.equal(first.taskType, 'FIELD_MAPPING');
    assert.deepEqual(repair.constraints.allowedProposalTypes, first.constraints.allowedProposalTypes, "the repair round carries exactly the original task's permissions, never a wider set");
    assert.deepEqual(repair.constraints.allowedTargetIds, first.constraints.allowedTargetIds);
    assert.deepEqual(repair.deterministicCandidates, first.deterministicCandidates);
    // Minimized reason codes: closed codes of the refusal and the refs the task allowed; nothing the first answer wrote.
    const context = repair.repairContext;
    assert.ok(context !== null);
    assert.ok(context.validationCodes.includes('UNKNOWN_CANDIDATE_REF') && context.validationCodes.includes('CANDIDATE_NOT_ANSWERED'), JSON.stringify(context.validationCodes));
    assert.ok(context.validationCodes.every((code) => CLOSED_CODE.test(code)), `every repair code is closed: ${JSON.stringify(context.validationCodes)}`);
    assert.ok(context.allowedTargetRefs.every((ref) => first.constraints.allowedTargetIds.includes(ref)), 'the repair offers only refs the task allowed');
    assert.ok(HEX64_PATTERN.test(context.previousProposalDigest), 'the previous answer travels by its digest');
    assert.ok(!(run.sent[1]?.bytes ?? '').includes(UNKNOWN_REF), 'the unknown ref the first answer wrote does not travel back');

    // The repaired mapping: compiled, drafted and delivered by Migration Core.
    const task = run.result.tasks[0];
    assert.deepEqual([task?.outcome, task?.attempts], ['PROPOSED', 2], JSON.stringify(run.result.tasks));
    assert.equal(run.result.state, 'PROPOSAL_READY', JSON.stringify(run.result.unresolvedItems));
    assert.equal(run.sent.length, 2, 'two requests answered for the task');
    assert.equal(run.result.resourceEvidence.modelCalls, run.result.tasks.reduce((total, entry) => total + entry.attempts, 0), 'one model call on the ledger per attempt of every task (the unmapped columns of the fixture are a task of their own, D3-CAP-09)');
    const loaded = run.port.configurations[0];
    assert.ok(loaded !== undefined && loaded.fields.some((field) => field.columnHeader === 'Home Email' && field.destinationField === 'contact.email'), 'the repaired mapping reaches Migration Core');
    const { text } = run;
    assert.ok(text !== '', 'Migration Core wrote a package');
    for (const value of HOME) assert.ok(text.includes(value), `Migration Core delivers ${value} as contact.email`);
  });

  it("CAP12: a repair answer that uses a proposal type outside the original task's set is FORBIDDEN, a second invalid answer is final, and no third request is made", TIMEOUT, async () => {
    // A: the repair answers Home Email with SELECT_SEMANTIC_TYPE, a type the FIELD_MAPPING task was never offered.
    const outside = await runRepair('b03-cap12-outside', (item, home) => (home ? { ...item, proposalType: 'SELECT_SEMANTIC_TYPE', targetRef: null, transformPrimitive: null, typedTransformParams: { semanticType: 'EMAIL' }, rationaleCode: 'SHAPE_MATCHES_TARGET_TYPE', alternatives: [], abstainReason: null } : item));
    const a = repairOf(outside);
    assert.ok(!a.first.constraints.allowedProposalTypes.includes('SELECT_SEMANTIC_TYPE'), 'the original task was never offered the type');
    assert.ok(!a.repair.constraints.allowedProposalTypes.includes('SELECT_SEMANTIC_TYPE'), 'nor is its repair round');
    const taskA = outside.result.tasks[0];
    assert.deepEqual([taskA?.outcome, taskA?.attempts], ['FORBIDDEN_PROPOSAL', 2], JSON.stringify(outside.result.tasks));
    assert.ok(taskA?.codes.includes('PROPOSAL_TYPE_NOT_ALLOWED_FOR_TASK'), JSON.stringify(taskA?.codes));
    assert.equal(outside.result.state, 'FAILED_COMPILER');
    assert.equal(outside.result.draft.status, 'NOT_DRAFTABLE');
    assert.equal(outside.port.configurations.length, 0, 'Migration Core receives nothing from a forbidden repair');

    // B: the repair names an unknown candidate ref again: the second invalid answer is final.
    const again = await runRepair('b03-cap12-again', (item, home) => (home ? { ...item, candidateRef: UNKNOWN_REF } : item));
    repairOf(again);
    const taskB = again.result.tasks[0];
    assert.deepEqual([taskB?.outcome, taskB?.attempts], ['INVALID_SEMANTICS', 2], JSON.stringify(again.result.tasks));
    assert.ok(taskB?.codes.includes('UNKNOWN_CANDIDATE_REF'), JSON.stringify(taskB?.codes));
    const attempts = (again.result.runLedger as unknown as readonly { readonly kind: string; readonly taskId?: string; readonly attempt?: number }[]).filter((event) => event.kind === 'TASK_OUTCOME' && event.taskId === taskB?.taskId).map((event) => event.attempt);
    assert.deepEqual(attempts, [1, 2], 'two semantic attempts on the record, never a third');
    assert.equal(again.sent.length, 2);
    assert.equal(again.result.resourceEvidence.modelCalls, again.result.tasks.reduce((total, entry) => total + entry.attempts, 0));
    assert.equal(again.result.state, 'FAILED_COMPILER');
    assert.equal(again.port.configurations.length, 0);
  });
});

// ------------------------------------------------------------------------------------------ the review and repair channels

describe('B03-CAP-REVIEW — the review and repair feedback channels carry closed codes and refs only', () => {
  it('a sentinel in the answers, in the values of a contested column and behind a review ref never leaves: the review names the claims of its contradiction by refs and closed codes, over the contested columns alone, and its repair carries closed codes and the refs the review allowed', TIMEOUT, async () => {
    const PERSON = 'Pelsira Quontay';
    const PARTNER = 'Ondriel Vaskemar';
    const values = ['pelsira.quontay@kauro-fixture.test', 'ondriel.vaskemar@kauro-fixture.test'];
    const run = await runReview(
      'b03-cap-review-sentinel',
      // The review first names a decision nothing carries, with a rationale naming a person; its repair preserves the weaker claim.
      (candidate, claims, repair) => (repair ? reviewItem(candidate, 'UNMAPPED_PRESERVE', claims.weaker?.decisionRef ?? null) : reviewItem(candidate, 'UNMAPPED_PRESERVE', UNKNOWN_DECISION, `${PARTNER} prefers the work address.`)),
      { alternate: values, rationale: `${PERSON} approved this mapping.`, summaries: true },
    );
    const { result } = run;

    // Nothing of the sentinels left, in any encoding, and nothing of them is in the public result.
    const denied = [PERSON, PARTNER, 'Pelsira', 'Quontay', 'Ondriel', 'Vaskemar', ...values];
    const forms = (text: string): readonly string[] => [text, text.toLowerCase(), Buffer.from(text).toString('base64'), Buffer.from(text).toString('hex'), encodeURIComponent(text)];
    for (const entry of run.sent) for (const token of denied) for (const form of forms(token)) assert.ok(!entry.bytes.includes(form), `a request carries ${JSON.stringify(token)} as ${JSON.stringify(form)}`);
    const published = JSON.stringify({ ...result, draft: { ...result.draft, configuration: null } });
    for (const token of denied) assert.ok(!published.includes(token), `the public result carries ${JSON.stringify(token)}`);

    // The review channel: refs and closed codes, over the contested columns alone.
    const reviews = reviewRequests(run);
    assert.equal(reviews.length, 2, 'the review and its one repair');
    const [review, repair] = reviews.map((entry) => entry.envelope) as [IntelligenceEnvelopeV1, IntelligenceEnvelopeV1];
    const claims = reviewClaimsOf(review);
    assert.equal(claims.length, 2, JSON.stringify(claims));
    for (const claim of claims) {
      assert.deepEqual(Object.keys(claim).sort(), CLAIM_KEYS, 'a review claim carries refs and closed codes only');
      assert.ok(CLAIM_KINDS.includes(claim.kind) && ['DETERMINISTIC', 'PROPOSED'].includes(claim.origin) && (EVIDENCE_CLASSES as readonly string[]).includes(claim.evidenceClass), JSON.stringify(claim));
      for (const ref of [claim.candidateRef, claim.decisionRef, claim.fieldRef, claim.targetRef ?? 'tgt_00000000']) assert.ok(REF_PATTERN.test(ref), `a review claim names ${ref} by ref`);
    }
    assert.deepEqual(review.sourceProfile.fields.map((field) => field.fieldRef).sort(), [run.alternate, run.work].sort(), 'the review carries the contested columns and no other');
    assert.deepEqual(review.exemplars, [], 'no value of a contested column travels: their values are personal');

    // The repair of the review: its permissions, its claims, closed codes and the decision refs the review allowed.
    assert.equal(repair.taskId, review.taskId);
    assert.deepEqual([...repair.constraints.allowedProposalTypes].sort(), REVIEW_TYPES, "the review's repair keeps the review's permissions");
    assert.deepEqual(reviewClaimsOf(repair), claims, 'the repair carries the same claims');
    const context = repair.repairContext;
    assert.ok(context !== null);
    assert.ok(context.validationCodes.length > 0 && context.validationCodes.every((code) => CLOSED_CODE.test(code)), JSON.stringify(context.validationCodes));
    assert.ok(context.allowedTargetRefs.length > 0 && context.allowedTargetRefs.every((ref) => review.constraints.allowedTargetIds.includes(ref)), `the repair offers the decisions the review named and nothing else: ${JSON.stringify(context.allowedTargetRefs)}`);
    assert.ok(!context.allowedTargetRefs.includes(UNKNOWN_DECISION) && !(reviews[1]?.bytes ?? '').includes(UNKNOWN_DECISION), 'the ref the review invented does not travel back');

    // And the repaired review settled the contradiction on its evidence.
    const task = result.tasks.find((entry) => entry.taskType === 'CONSISTENCY_REVIEW');
    assert.deepEqual([task?.outcome, task?.attempts], ['PROPOSED', 2], JSON.stringify(result.tasks));
    assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
    assert.deepEqual((run.port.configurations[0]?.fields ?? []).filter((field) => field.destinationField === 'contact.email').map((field) => field.columnHeader), ['Work Email']);
  });
});
