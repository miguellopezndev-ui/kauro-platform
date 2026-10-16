/**
 * B03-KERNEL-BOUNDARY — the kernel's boundary after the rejected review of
 * v0.4.0 (findings B03-R2, B03-R3, B03-R7, B03-R12; decisions D3-PARSE-1,
 * D3-PARSE-2, D3-TIME-1, D3-ID-1, D3-PRIV-1 of docs/design/B03-closure-plan.md).
 *
 * Every case runs the public `run()` through the transport gateway (the
 * labelled oracle transport stands in for the model; no paid inference) and,
 * where a draft is made, the real Migration Core validation port over the
 * whole fixture:
 *
 * - IC-02: two windows — the semantic window gates dispatch, the absolute
 *   window gates promotion, and a resource profile can only shorten the first;
 * - IC-04: every member of the input and of the host context binds the
 *   attempt, changed one at a time over a full fixture;
 * - R2-028 and S036: the result, readRun and the telemetry carry a public
 *   projection — digests and closed codes — while the host's protected store
 *   keeps the provider's answer;
 * - R2-038 and S040: one strict reader refuses a repeated member name before
 *   any value is read, and a raw body is decoded by a fatal streaming UTF-8
 *   decoder under a byte bound.
 *
 * Every name, handle and credential below is synthetic and written for this
 * file; no credential here was ever issued by anyone.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { IntelligenceError, RunLedger, VirtualClock, createIntelligenceCore, digestOf, oracleTransport, parseProposal, parseProviderRequestPayload, transportGateway } from '../src/index.js';
import type { HostContext, IntelligenceInput, IntelligenceResult, LedgerEvent, ProviderRequest, ProviderResponse, Transport } from '../src/index.js';
import { forms, memoryFor } from './support/egress-harness.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort, vendorContract } from './support/fixtures.js';
import type { Bundle } from './support/fixtures.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SEMANTIC_WINDOW_MS = 20 * MINUTE;
const ABSOLUTE_WINDOW_MS = 24 * HOUR;
const START = '2026-09-11T00:00:00.000Z';
const at = (offsetMs: number): string => new Date(Date.parse(START) + offsetMs).toISOString();

/** A contacts file whose Work Email the oracle maps to contact.email by MAP_FIELD: a model decision that reaches the draft. */
const CONTACTS = 'Contact ID,First Name,Work Email,Status\n1,Ada,ada@x.test,Active\n2,Grace,grace@x.test,Inactive\n3,Alan,alan@x.test,Active\n';
const DECLARED = { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' } as const;

type Mode = 'CLEAN_ONLY' | 'HUBSPOT';
type Core = ReturnType<typeof createIntelligenceCore>;
type Deps = ReturnType<typeof depsFor>;

/** One request as the transport saw it: the virtual clock, the task, whether it was the repair round. */
interface Sent {
  readonly atMs: number;
  readonly taskId: string;
  readonly repair: boolean;
}

/** What a test answers instead of the oracle: a whole provider response, a proposal text the harness wraps in a 200 body, or null for the oracle's own answer. */
type Answer = (context: { readonly request: ProviderRequest; readonly oracleText: string; readonly taskId: string; readonly count: number; readonly taskCount: number; readonly clock: VirtualClock }) => ProviderResponse | string | null;

interface Harnessed {
  readonly result: IntelligenceResult;
  readonly core: Core;
  readonly deps: Deps;
  readonly clock: VirtualClock;
  readonly sent: readonly Sent[];
  readonly telemetry: readonly unknown[];
  readonly validations: number;
  /** The virtual clock when each validation began. */
  readonly validationStarts: readonly number[];
}

interface RunOptions {
  readonly mode?: Mode;
  readonly bundle?: Bundle;
  readonly input?: (base: IntelligenceInput) => IntelligenceInput;
  readonly context?: HostContext;
  readonly answer?: Answer;
  /** Runs inside the host's validation, before Migration Core runs: the time the host takes. */
  readonly during?: (clock: VirtualClock) => void;
  /** A core over this store instead of a fresh one (a redelivery). */
  readonly reuse?: { readonly deps: Deps; readonly clock: VirtualClock };
}

/** A 200 Messages body around a text, as the oracle shapes it. */
function bodyFor(request: ProviderRequest, text: string): Record<string, unknown> {
  return { id: 'msg_b03_boundary', type: 'message', role: 'assistant', model: request.model, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text }], usage: { input_tokens: 1_000, output_tokens: 200 } };
}

/** The body as the raw bytes a provider sends, handed over in the chunks given (D3-PARSE-2). The cast keeps the member readable to a build that does not know it. */
function chunked(chunks: readonly Uint8Array[] | AsyncIterable<Uint8Array>): ProviderResponse {
  return { status: 200, bodyChunks: chunks } as unknown as ProviderResponse;
}

const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'));

/** The fixture's input: files declared, and whatever the test changes. */
function fixtureInput(mode: Mode, profiled: ReturnType<typeof profileBundle>, contract: ReturnType<typeof vendorContract> | null): IntelligenceInput {
  const base = inputFor(mode, profiled, contract);
  return { ...base, projectRevision: { ...base.projectRevision, declaredObjects: DECLARED } };
}

async function runOnce(name: string, options: RunOptions = {}): Promise<Harnessed> {
  const mode = options.mode ?? 'CLEAN_ONLY';
  const bundle = options.bundle ?? makeBundle(`b03-boundary-${name}`, { contacts: CONTACTS });
  try {
    const profiled = profileBundle(bundle, mode);
    const contract = mode === 'CLEAN_ONLY' ? null : vendorContract(mode, { withStatusPicklist: true });
    const clock = options.reuse?.clock ?? new VirtualClock(START);
    const real = realValidationPort(bundle, profiled.profile, contract, { clock });
    const validationStarts: number[] = [];
    const port = { calls: 0, lastPackage: null, clock, async validate(configuration: Parameters<typeof real.validate>[0]) { validationStarts.push(clock.nowMs()); options.during?.(clock); return real.validate(configuration); } };
    const sent: Sent[] = [];
    const perTask = new Map<string, number>();
    const inner = oracleTransport();
    const transport: Transport = async (request, deadlineAt, correlation) => {
      const payload = parseProviderRequestPayload(JSON.stringify(request));
      const taskCount = (perTask.get(payload.taskId) ?? 0) + 1;
      perTask.set(payload.taskId, taskCount);
      sent.push({ atMs: clock.nowMs(), taskId: payload.taskId, repair: payload.envelope.repairContext !== null });
      const oracle = await inner(request, deadlineAt, correlation);
      const oracleText = ((oracle.body as { content: { text: string }[] }).content[0] ?? { text: '' }).text;
      const answered = options.answer?.({ request, oracleText, taskId: payload.taskId, count: sent.length, taskCount, clock }) ?? null;
      if (answered === null) return oracle;
      return typeof answered === 'string' ? { status: 200, body: bodyFor(request, answered) } : answered;
    };
    const telemetry: unknown[] = [];
    const deps = options.reuse?.deps ?? { ...depsFor(transportGateway(transport), port, clock), telemetry: (event: unknown): void => void telemetry.push(structuredClone(event)) };
    const core = createIntelligenceCore(options.reuse === undefined ? deps : { ...deps, gateway: transportGateway(transport), validationPort: port, telemetry: (event: unknown): void => void telemetry.push(structuredClone(event)) });
    const baseInput = fixtureInput(mode, profiled, contract);
    const input = options.input?.(baseInput) ?? baseInput;
    const result = await core.run(input, options.context ?? CONTEXT);
    return { result, core, deps, clock, sent, telemetry, validations: validationStarts.length, validationStarts };
  } finally {
    if (options.bundle === undefined) bundle.dispose();
  }
}

/** A member of an event read by name, whatever the build's event type says. */
const member = (event: unknown, name: string): unknown => (event !== null && typeof event === 'object' ? (event as Record<string, unknown>)[name] : undefined);
const eventsOf = (events: readonly unknown[], kind: string): readonly Record<string, unknown>[] => events.filter((event) => member(event, 'kind') === kind) as Record<string, unknown>[];
const createdOf = (result: IntelligenceResult): Record<string, unknown> => eventsOf(result.runLedger, 'RUN_CREATED')[0] ?? {};
const codesOf = (result: IntelligenceResult): string[] => [...result.tasks.flatMap((task) => [...task.codes]), ...result.unresolvedItems.flatMap((item) => [...item.codes])];
const outcomeCodes = (events: readonly unknown[]): string[] => eventsOf(events, 'TASK_OUTCOME').flatMap((event) => [...((member(event, 'codes') as readonly string[] | undefined) ?? [])]);
const storeOf = (harnessed: Harnessed): readonly LedgerEvent[] => harnessed.deps.store.read(harnessed.result.runId);

/** Which sentinels appear, in any encoding a serialiser could produce, in which channel. */
function sentinelsIn(channels: Readonly<Record<string, string>>, sentinels: readonly string[]): string[] {
  const found: string[] = [];
  for (const [name, text] of Object.entries(channels)) for (const sentinel of sentinels) for (const form of forms(sentinel)) if (text.includes(form)) found.push(`${name} carries ${JSON.stringify(sentinel)}${form === sentinel ? '' : ` as ${JSON.stringify(form)}`}`);
  return found;
}

/** Every public channel of a run: the whole result (its public ledger included), readRun, and the telemetry. */
function publicChannels(harnessed: Harnessed): Readonly<Record<string, string>> {
  return { result: JSON.stringify(harnessed.result), readRun: JSON.stringify(harnessed.core.readRun(harnessed.result.runId)), telemetry: JSON.stringify(harnessed.telemetry) };
}

/** The oracle's text with its first `"requiresAgencyDecision":false` after the named proposal type repeated, true first: the review's reproduction of R2-038. */
function withDuplicateAuthority(text: string, after = '"proposalType":"MAP_FIELD"'): string {
  const from = text.indexOf(after);
  const start = text.indexOf('"requiresAgencyDecision":false', from < 0 ? 0 : from);
  if (start < 0) return text;
  return `${text.slice(0, start)}"requiresAgencyDecision":true,"requiresAgencyDecision":false${text.slice(start + '"requiresAgencyDecision":false'.length)}`;
}

// ---------------------------------------------------------------------------------------------------------------- IC-02

describe('IC-02 (B03-KERNEL-BOUNDARY): the semantic window gates dispatch, the absolute window gates promotion', () => {
  const HOST_CONTEXT = { ...CONTEXT, interpretationDeadlineAt: at(SEMANTIC_WINDOW_MS), absoluteDeadlineAt: at(ABSOLUTE_WINDOW_MS) } as HostContext;

  it('IC-02: Migration Core validation that returns after the twenty-minute semantic window and inside the absolute window reaches PROPOSAL_READY with no provider request after the semantic deadline', { timeout: 120_000 }, async () => {
    // Migration Core's full-data validation takes eight hours of the audit's twenty-four: past the interpretation clock, inside the audit clock.
    const run = await runOnce('ic02-late-validation', { context: HOST_CONTEXT, during: (clock) => clock.advance(8 * HOUR) });
    assert.equal(run.result.state, 'PROPOSAL_READY', JSON.stringify(codesOf(run.result)));
    const created = createdOf(run.result);
    assert.equal(created['semanticDeadlineAt'], at(SEMANTIC_WINDOW_MS), 'RUN_CREATED records the semantic deadline');
    assert.equal(created['absoluteDeadlineAt'], at(ABSOLUTE_WINDOW_MS), 'RUN_CREATED records the absolute deadline');
    assert.ok(run.sent.length >= 1, 'the model was asked');
    const semantic = Date.parse(at(SEMANTIC_WINDOW_MS));
    assert.ok(run.sent.every((request) => request.atMs < semantic), `every request before the semantic deadline: ${JSON.stringify(run.sent.map((request) => request.atMs - Date.parse(START)))}`);
    assert.equal(run.validations, 1);
    const validatedAt = Date.parse(run.result.draft.fullValidation?.validatedAt ?? START);
    assert.ok(validatedAt > semantic && validatedAt < Date.parse(at(ABSOLUTE_WINDOW_MS)), 'the validation returned after the semantic window and inside the absolute one');
    assert.ok(run.sent.every((request) => request.atMs <= (run.validationStarts[0] ?? 0)), 'no request after the validation began');
    assert.equal(run.result.draft.status, 'SYSTEM_DRAFT');
    assert.equal(run.result.draft.fullValidation?.packageVerified, true, 'Migration Core validated the draft');
    assert.ok((run.result.draft.configuration?.fields ?? []).some((field) => field.columnHeader === 'Work Email' && field.destinationField === 'contact.email'), 'the model decision is in the validated draft');
  });

  it('IC-02: validation that returns after the absolute deadline ends DEADLINE_EXCEEDED with no draft, and a resource profile beyond the twenty-minute policy is FAILED_CONTRACT before any request', { timeout: 120_000 }, async () => {
    // The review's reproduction: a resource profile of twenty-five hours and a validation that returns after twenty-four. The profile cannot extend the semantic window; it is refused before anything is spent.
    const refused = await runOnce('ic02-profile-above-policy', { input: (base) => ({ ...base, resourceProfile: { wallClockMs: 25 * HOUR } }), during: (clock) => clock.advance(ABSOLUTE_WINDOW_MS + 1) });
    assert.equal(refused.result.state, 'FAILED_CONTRACT', JSON.stringify(codesOf(refused.result)));
    assert.equal(refused.result.draft.status, 'NOT_DRAFTABLE');
    assert.equal(refused.sent.length, 0, 'no request for a refused profile');
    assert.equal(refused.validations, 0, 'nothing validated');
    assert.equal(eventsOf(refused.result.runLedger, 'RESERVED').length, 0, 'nothing reserved');
    assert.ok(codesOf(refused.result).includes('RESOURCE_PROFILE_ABOVE_POLICY'), JSON.stringify(codesOf(refused.result)));
    assert.equal(createdOf(refused.result)['semanticDeadlineAt'], at(SEMANTIC_WINDOW_MS), 'wallClockMs only shortens: the recorded semantic window is the policy\'s');
    assert.equal(createdOf(refused.result)['absoluteDeadlineAt'], at(ABSOLUTE_WINDOW_MS));
    // The audit clock runs out while Migration Core validates: never promoted.
    const late = await runOnce('ic02-absolute-expiry', { context: HOST_CONTEXT, during: (clock) => clock.advance(ABSOLUTE_WINDOW_MS + 1) });
    assert.equal(late.result.state, 'DEADLINE_EXCEEDED', JSON.stringify(codesOf(late.result)));
    assert.equal(late.result.draft.status, 'NOT_DRAFTABLE');
    assert.equal(late.result.draft.configuration, null);
    assert.ok(codesOf(late.result).includes('DEADLINE_EXCEEDED'), JSON.stringify(codesOf(late.result)));
    assert.equal(late.result.memoryCandidates.length, 0);
    assert.equal(eventsOf(late.result.runLedger, 'STATE').filter((event) => event['to'] === 'PROPOSAL_READY').length, 0, 'never PROPOSAL_READY');
    assert.equal(eventsOf(late.result.runLedger, 'STATE').filter((event) => event['to'] === 'DEADLINE_EXCEEDED').length, 1);
    // The host's deadlines are the audit's: earlier than the policy's windows from the run's start, they are the ones that hold.
    const hostEarlier = await runOnce('ic02-host-absolute', { context: { ...HOST_CONTEXT, interpretationDeadlineAt: at(5 * MINUTE), absoluteDeadlineAt: at(2 * HOUR) } as HostContext, during: (clock) => clock.advance(3 * HOUR) });
    assert.equal(createdOf(hostEarlier.result)['semanticDeadlineAt'], at(5 * MINUTE));
    assert.equal(createdOf(hostEarlier.result)['absoluteDeadlineAt'], at(2 * HOUR));
    assert.equal(hostEarlier.result.state, 'DEADLINE_EXCEEDED');
    assert.equal(hostEarlier.result.draft.status, 'NOT_DRAFTABLE');
    // An audit whose absolute deadline has already passed when the run opens: no work at all, DEADLINE_EXCEEDED.
    const expired = await runOnce('ic02-host-expired', { context: { ...CONTEXT, absoluteDeadlineAt: at(-MINUTE) } as HostContext });
    assert.equal(expired.result.state, 'DEADLINE_EXCEEDED', JSON.stringify(codesOf(expired.result)));
    assert.equal(expired.sent.length, 0);
    assert.equal(expired.validations, 0);
    assert.equal(expired.result.draft.status, 'NOT_DRAFTABLE');
    // A shorter profile shortens: ten minutes is the semantic window, and a validation after it still promotes.
    const shorter = await runOnce('ic02-profile-shorter', { input: (base) => ({ ...base, resourceProfile: { wallClockMs: 10 * MINUTE } }), during: (clock) => clock.advance(30 * MINUTE) });
    assert.equal(createdOf(shorter.result)['semanticDeadlineAt'], at(10 * MINUTE));
    assert.equal(shorter.result.state, 'PROPOSAL_READY', JSON.stringify(codesOf(shorter.result)));
  });
});

// ---------------------------------------------------------------------------------------------------------------- IC-04

/** An instant as the host writes it. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

/** The same member with other content: a string another string (an instant another instant), a number another number, a list one entry longer, a record one member richer, a map one entry richer. */
function changedValue(value: unknown): unknown {
  if (value instanceof Map) return new Map([...(value as Map<string, unknown>).entries(), ['col_identity_probe', ['changed']]]);
  if (Array.isArray(value)) return [...value, value.length > 0 ? structuredClone(value[value.length - 1]) : 'changed'];
  if (typeof value === 'string') return INSTANT.test(value) ? new Date(Date.parse(value) + 1_000).toISOString() : `${value}-changed`;
  if (typeof value === 'number') return value > 1 ? value - 1 : value + 1;
  if (typeof value === 'boolean') return !value;
  if (value === null) return 'changed';
  if (typeof value === 'object') return { ...(value as Record<string, unknown>), identityProbe: 'changed' };
  return 'changed';
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Map);

/** Every member of a value, one level into each member that is itself a record: the paths a structural change walks. */
function memberPaths(value: Record<string, unknown>): readonly (readonly string[])[] {
  const paths: string[][] = [];
  for (const [name, inner] of Object.entries(value)) {
    if (inner === undefined) continue;
    if (!isRecord(inner)) {
      paths.push([name]);
      continue;
    }
    for (const [nested, deeper] of Object.entries(inner)) if (deeper !== undefined) paths.push([name, nested]);
  }
  return paths;
}

/** A copy with the member at `path` changed. */
function withChanged<T extends Record<string, unknown>>(value: T, path: readonly string[]): T {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  const current = value[head];
  return { ...value, [head]: rest.length === 0 ? changedValue(current) : withChanged(current as Record<string, unknown>, rest) };
}

describe('IC-04 (B03-KERNEL-BOUNDARY): every member of the input and of the host context binds the attempt', () => {
  it('IC-04: a finished attempt redelivered with any one member of its input or host context changed, recordIdColumns among them, is IDENTITY_CONFLICT before the stored result and before any request; the unchanged input is answered from the stored result', { timeout: 180_000 }, async () => {
    const bundle = makeBundle('b03-boundary-ic04', { contacts: CONTACTS });
    try {
      const profiled = profileBundle(bundle, 'HUBSPOT');
      const contract = vendorContract('HUBSPOT', { withStatusPicklist: true });
      const status = profiled.profile.profile.files.flatMap((file) => file.sheets.flatMap((sheet) => sheet.columns)).find((column) => column.headerRaw === 'Status')?.columnLocatorId ?? '';
      // The full fixture: every optional member of the input and of the host context is present.
      const full = (base: IntelligenceInput): IntelligenceInput => ({
        ...base,
        projectRevision: { ...base.projectRevision, declaredObjects: DECLARED, recordIdColumns: { 'contacts.csv': 'Contact ID', 'companies.csv': 'Company ID' }, localeEvidence: { defaultRegion: 'ES', dateFormat: 'DD/MM/YYYY' } },
        scopedMemorySnapshot: [memoryFor('Work Email', CONTEXT.tenant)],
        categoricalSummaries: new Map([[status, ['Active', 'Inactive']]]),
        resourceProfile: { wallClockMs: 15 * MINUTE },
      });
      const context = { ...CONTEXT, auditAttemptId: 'attempt-ic04-full', interpretationDeadlineAt: at(SEMANTIC_WINDOW_MS), absoluteDeadlineAt: at(ABSOLUTE_WINDOW_MS) } as HostContext;
      const first = await runOnce('ic04-full', { mode: 'HUBSPOT', bundle, input: full, context });
      assert.equal(first.result.state, 'PROPOSAL_READY', JSON.stringify(codesOf(first.result)));
      const input = full(fixtureInput('HUBSPOT', profiled, contract));
      assert.ok(input.projectRevision.recordIdColumns !== undefined && input.projectRevision.declaredObjects !== undefined && input.projectRevision.localeEvidence !== undefined && input.categoricalSummaries !== undefined && input.resourceProfile.wallClockMs !== undefined && input.targetContract !== null && input.scopedMemorySnapshot.length > 0, 'the fixture is full');
      const requests = first.sent.length;
      const events = storeOf(first).length;
      // The unchanged input, redelivered: the stored result, nothing bought.
      const same = await runOnce('ic04-same', { mode: 'HUBSPOT', bundle, input: full, context, reuse: { deps: first.deps, clock: first.clock } });
      assert.equal(same.result.proposalDigest, first.result.proposalDigest);
      assert.equal(same.sent.length, 0);
      const runId = first.result.runId;
      const runKey = (candidate: HostContext): string => RunLedger.runIdFor(candidate.auditAttemptId, candidate.tenant);
      const conflicts: string[] = [];
      const answered: string[] = [];
      const keyed: string[] = [];
      const core = createIntelligenceCore({ ...first.deps, gateway: { name: 'refusing', evidenceClass: 'SIMULATED', analyze: async () => { throw new Error('a changed member reached the provider'); } }, validationPort: { validate: async () => { throw new Error('a changed member reached validation'); } } });
      const inputPaths = memberPaths(input as unknown as Record<string, unknown>);
      const contextPaths = memberPaths(context as unknown as Record<string, unknown>);
      assert.ok(inputPaths.some((path) => path.join('.') === 'projectRevision.recordIdColumns'), 'recordIdColumns is among the members walked');
      for (const [scope, paths] of [['input', inputPaths], ['context', contextPaths]] as const) {
        for (const path of paths) {
          const name = `${scope}.${path.join('.')}`;
          const changedInput = scope === 'input' ? withChanged(input as unknown as Record<string, unknown>, path) as unknown as IntelligenceInput : input;
          const changedContext = scope === 'context' ? withChanged(context as unknown as Record<string, unknown>, path) as unknown as HostContext : context;
          // The members that name the run — the tenant and the attempt — make another attempt, not a conflicting one.
          if (runKey(changedContext) !== runId) {
            keyed.push(name);
            continue;
          }
          try {
            const result = await core.run(changedInput, changedContext);
            answered.push(`${name} → ${result.state}`);
          } catch (error) {
            // A conflict about the member that changed: the record names it.
            const differing = error instanceof IntelligenceError ? ((error.details['differing'] as readonly string[] | undefined) ?? []) : [];
            if (error instanceof IntelligenceError && error.code === 'IDENTITY_CONFLICT' && differing.includes(`hashes.${name}`)) conflicts.push(name);
            else answered.push(`${name} → ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      assert.deepEqual(answered, [], 'every changed member is a conflict, never the stored answer');
      assert.ok(conflicts.includes('input.projectRevision.recordIdColumns'), JSON.stringify(conflicts));
      assert.ok(conflicts.length >= 15, `one conflict per member: ${JSON.stringify(conflicts)}`);
      assert.deepEqual([...keyed].sort(), ['context.auditAttemptId', 'context.tenant.agencyId', 'context.tenant.clientId'], 'only the run key names another run');
      assert.equal(storeOf(first).length, events, 'no conflict wrote to the attempt');
      assert.equal(first.sent.length, requests, 'no conflict reached the provider');
      // The review's reproduction: an attempt finished without the declaration, redelivered with it.
      const bare = { ...context, auditAttemptId: 'attempt-ic04-bare' } as HostContext;
      const undeclared = (base: IntelligenceInput): IntelligenceInput => { const { recordIdColumns, ...revision } = full(base).projectRevision; void recordIdColumns; return { ...full(base), projectRevision: revision }; };
      const withoutDeclaration = await runOnce('ic04-bare', { mode: 'HUBSPOT', bundle, input: undeclared, context: bare, reuse: { deps: first.deps, clock: first.clock } });
      assert.equal(withoutDeclaration.result.state, 'PROPOSAL_READY');
      await assert.rejects(core.run(full(fixtureInput('HUBSPOT', profiled, contract)), bare), (error: unknown) => error instanceof IntelligenceError && error.code === 'IDENTITY_CONFLICT', 'recordIdColumns declared on a redelivery is a conflict');
    } finally {
      bundle.dispose();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------- R2-028

const CREDENTIAL = 'sk-ant-api03-SyntheticBoundaryQv7Lm3Nx9Rt2Wp5';
const ECHO = 'ECHO-OF-THE-SUBMITTED-BODY-B03';

describe('R2-028 (B03-KERNEL-BOUNDARY): the provider\'s answer stays in the protected record', () => {
  it('R2-028: a provider answer echoing a synthetic credential is kept only in the protected response record; the public result, readRun and the telemetry carry its digest and never its text', { timeout: 120_000 }, async () => {
    const run = await runOnce('r2-028', { answer: ({ request }) => `upstream said ${ECHO}: x-api-key: ${CREDENTIAL} | ${JSON.stringify(request).slice(0, 160)}` });
    assert.notEqual(run.result.draft.status, 'SYSTEM_DRAFT');
    // The protected record — the host's store — keeps the answer byte for byte, for reconciliation under its retention class.
    const stored = eventsOf(storeOf(run), 'RESPONSE_STORED');
    assert.ok(stored.length >= 1, 'the answers are in the protected record');
    assert.ok(stored.every((event) => JSON.stringify(event['response']).includes(CREDENTIAL)), 'the protected record holds the answer as it came');
    // The public projection: every stored answer by its digest, its size, its usage and its stop reason; never its text.
    for (const events of [run.result.runLedger, run.core.readRun(run.result.runId)]) {
      const projected = eventsOf(events, 'RESPONSE_STORED');
      assert.equal(projected.length, stored.length, 'one public entry per stored answer');
      projected.forEach((event, index) => {
        const protectedEvent = stored[index] ?? {};
        assert.ok(!('response' in event), 'no response member in the public projection');
        assert.equal(event['responseDigest'], protectedEvent['responseDigest'], 'the digest of the stored answer');
        assert.equal(event['responseDigest'], digestOf(protectedEvent['response']));
        assert.equal(event['idempotencyKey'], protectedEvent['idempotencyKey']);
        assert.equal(event['envelopeHash'], protectedEvent['envelopeHash']);
        assert.equal(event['byteLength'], Buffer.byteLength(String(member(protectedEvent['response'], 'content')), 'utf8'));
        assert.equal(event['stopReason'], 'end_turn');
        assert.deepEqual(event['usage'], { inputTokens: 1_000, outputTokens: 200 });
      });
    }
    assert.deepEqual(sentinelsIn(publicChannels(run), [CREDENTIAL, ECHO, 'sk-ant-api03', 'x-api-key']), [], 'the answer\'s text reached a public channel');
  });
});

// ---------------------------------------------------------------------------------------------------------------- S036

describe('S036 (B03-KERNEL-BOUNDARY): what the model wrote is recorded as closed codes', () => {
  it('S036: a model answer whose unknown member names and values carry sentinels is recorded as closed codes only; no text the model wrote reaches the result, the public ledger, readRun or the telemetry', { timeout: 120_000 }, async () => {
    const SENTINELS = ['Vorquellian Brastide', 'Mirenthal Oswindre', 'Tessivar', 'Ulbrecht Nowamy', 'Quelbrant', 'Drasmolin', 'Wexhaldo', 'Grauvenholt', 'Hexavindra'];
    const order: string[] = [];
    const run = await runOnce('s036', {
      answer: ({ oracleText, taskId, taskCount }) => {
        if (!order.includes(taskId)) order.push(taskId);
        const task = order.indexOf(taskId);
        const proposal = JSON.parse(oracleText) as { items: Record<string, unknown>[] } & Record<string, unknown>;
        const [head, ...rest] = proposal.items;
        if (task === 0 && taskCount === 1) {
          // Unknown member names and a value outside an enumeration, each a sentinel.
          return JSON.stringify({ ...proposal, 'Vorquellian Brastide': 'Mirenthal Oswindre', items: [{ ...head, proposalType: 'Quelbrant', Tessivar: 'Ulbrecht Nowamy' }, ...rest] });
        }
        if (task === 0) {
          // A parameter the primitive does not take, named and valued by the model.
          return JSON.stringify({ ...proposal, items: [{ ...head, proposalType: 'UNMAPPED_PRESERVE', targetRef: null, transformPrimitive: 'TRIM_WHITESPACE', typedTransformParams: { Drasmolin: 'Wexhaldo' } }, ...rest] });
        }
        // Text that is not JSON, then a repeated member the schema does not know.
        return taskCount === 1 ? 'Grauvenholt answers in prose' : '{"Hexavindra":1,"Hexavindra":2}';
      },
    });
    assert.ok(order.length >= 2, 'two tasks were answered');
    // The answers really carried the sentinels: the protected record has every one.
    const protectedText = JSON.stringify(storeOf(run));
    for (const sentinel of SENTINELS) assert.ok(protectedText.includes(sentinel), `the protected record holds ${sentinel}`);
    assert.deepEqual(sentinelsIn(publicChannels(run), [...SENTINELS, 'QUELBRANT', 'DRASMOLIN', 'TESSIVAR', 'HEXAVINDRA']), [], 'a text the model wrote reached a public channel');
    // What is recorded is closed: a code, and a pointer whose model-written segments are replaced.
    const recorded = [...outcomeCodes(run.result.runLedger), ...codesOf(run.result)];
    for (const expected of ['UNKNOWN_MEMBER@/*', 'ENUM@/items/0/proposalType', 'UNKNOWN_MEMBER@/items/0/*', 'UNKNOWN_PARAM', 'NOT_JSON', 'DUPLICATE_KEY@/*']) assert.ok(recorded.includes(expected), `${expected} in ${JSON.stringify(recorded)}`);
    const closed = /^[A-Z][A-Z0-9_]*(?:@(?:\/(?:[A-Za-z]+|\d+|\*))+)?$/u;
    const schemaAndSemantic = eventsOf(run.result.runLedger, 'TASK_OUTCOME').filter((event) => event['outcome'] === 'INVALID_SCHEMA' || event['outcome'] === 'INVALID_SEMANTICS' || event['outcome'] === 'FORBIDDEN_PROPOSAL');
    assert.ok(schemaAndSemantic.length >= 4, 'both attempts of both tasks are on the record');
    for (const event of schemaAndSemantic) for (const code of (event['codes'] as readonly string[])) assert.match(code, closed);
  });
});

// ---------------------------------------------------------------------------------------------------------------- S040

describe('S040 (B03-KERNEL-BOUNDARY): malformed, incomplete and split provider bytes', () => {
  it('S040: duplicate keys at any depth, a truncated document and a body that ends mid-stream are INVALID_SCHEMA or a typed transport failure through a public run, and no partial plan is drafted', { timeout: 180_000 }, async () => {
    const bundle = makeBundle('b03-boundary-s040', { contacts: CONTACTS });
    try {
      /** The oracle's proposal with one change at a depth. */
      const edit = (text: string, change: (proposal: Record<string, unknown> & { items: Record<string, unknown>[] }) => string): string => change(JSON.parse(text) as Record<string, unknown> & { items: Record<string, unknown>[] });
      const cases: readonly { readonly name: string; readonly answer: Answer; readonly outcome: string; readonly code: string }[] = [
        { name: 'a repeated member at the top', answer: ({ oracleText }) => oracleText.replace('"taskId":', '"taskId":"task_0000000000000000","taskId":'), outcome: 'INVALID_SCHEMA', code: 'DUPLICATE_KEY@/taskId' },
        { name: 'a repeated member inside an item', answer: ({ oracleText }) => withDuplicateAuthority(oracleText, '"proposalType":'), outcome: 'INVALID_SCHEMA', code: 'DUPLICATE_KEY@/items/0/requiresAgencyDecision' },
        { name: 'a repeated parameter name in a record', answer: ({ oracleText }) => edit(oracleText, (proposal) => JSON.stringify(proposal).replace('"typedTransformParams":null', '"typedTransformParams":{"decimalSeparator":".","decimalSeparator":","}')), outcome: 'INVALID_SCHEMA', code: 'DUPLICATE_KEY@/items/0/typedTransformParams/*' },
        { name: 'a repeated member four levels down', answer: ({ oracleText }) => edit(oracleText, (proposal) => JSON.stringify(proposal).replace('"alternatives":[]', '"alternatives":[{"targetRef":"tgt_0000000000000000","rationaleCode":"HEADER_MATCHES_TARGET_LABEL","rationaleCode":"NO_TARGET_IN_ENVELOPE"}]')), outcome: 'INVALID_SCHEMA', code: 'DUPLICATE_KEY@/items/0/alternatives/0/rationaleCode' },
        { name: 'a truncated proposal document', answer: ({ oracleText }) => oracleText.slice(0, Math.floor(oracleText.length / 2)), outcome: 'INVALID_SCHEMA', code: 'TRUNCATED' },
        { name: 'a raw body that repeats a member', answer: ({ request, oracleText }) => chunked([utf8(JSON.stringify(bodyFor(request, oracleText)).replace('"stop_reason":"end_turn"', '"stop_reason":"refusal","stop_reason":"end_turn"'))]), outcome: 'PROVIDER_TERMINAL_FAILURE', code: 'the provider body repeats a member name' },
        { name: 'a raw body cut before its end', answer: ({ request, oracleText }) => { const bytes = utf8(JSON.stringify(bodyFor(request, oracleText))); return chunked([bytes.slice(0, Math.floor(bytes.length * 0.6))]); }, outcome: 'PROVIDER_RETRYABLE_FAILURE', code: 'the provider body ended before it was complete; billing is unknown' },
        {
          name: 'a body stream that fails mid-way',
          answer: ({ request, oracleText }) => {
            const bytes = utf8(JSON.stringify(bodyFor(request, oracleText)));
            return chunked((async function* stream(): AsyncGenerator<Uint8Array> { yield bytes.slice(0, 64); throw new Error('the connection dropped'); })());
          },
          outcome: 'PROVIDER_RETRYABLE_FAILURE',
          code: 'the provider body ended before it was complete; billing is unknown',
        },
        { name: 'a body that ends inside a character', answer: ({ request, oracleText }) => chunked([utf8(JSON.stringify(bodyFor(request, oracleText))), new Uint8Array([0xe2, 0x82])]), outcome: 'PROVIDER_RETRYABLE_FAILURE', code: 'the provider body ended before it was complete; billing is unknown' },
      ];
      const observed: string[] = [];
      for (const entry of cases) {
        // Every answer of the task that carries the Work Email decision is the defective one; the other task is the oracle's.
        let target: string | null = null;
        const run = await runOnce(`s040-${entry.name}`, {
          bundle,
          answer: (context) => {
            if (target === null && context.oracleText.includes('"proposalType":"MAP_FIELD"')) target = context.taskId;
            return context.taskId === target ? entry.answer(context) : null;
          },
        });
        const task = run.result.tasks.find((candidate) => candidate.taskId === target);
        const recorded = outcomeCodes(run.result.runLedger);
        observed.push(`${entry.name}: ${String(task?.outcome)} ${run.result.state} ${run.result.draft.status}`);
        assert.equal(task?.outcome, entry.outcome, `${entry.name}: ${JSON.stringify(recorded)}`);
        assert.ok(recorded.includes(entry.code), `${entry.name}: ${entry.code} in ${JSON.stringify(recorded)}`);
        assert.equal(run.result.draft.status, 'NOT_DRAFTABLE', `${entry.name}: no partial plan`);
        assert.equal(run.result.draft.configuration, null, `${entry.name}: no configuration`);
        assert.notEqual(run.result.state, 'PROPOSAL_READY', entry.name);
        assert.equal(run.validations, 0, `${entry.name}: nothing reached Migration Core`);
        assert.ok(run.sent.filter((request) => request.taskId === target).length <= 2 * 3, `${entry.name}: bounded`);
      }
      assert.equal(observed.length, cases.length);
    } finally {
      bundle.dispose();
    }
  });

  it('S040: a UTF-8 character split across two body chunks decodes to the same text and the same draft as the unsplit body; an invalid sequence is a typed transport failure, never a replacement character', { timeout: 180_000 }, async () => {
    const bundle = makeBundle('b03-boundary-s040-utf8', { contacts: CONTACTS });
    try {
      const RATIONALE = 'Le libellé nommé correspond: €';
      /** The oracle's answer with a rationale of multi-byte characters on the model's decision, as raw bytes in the chunks `split` makes of them. */
      const answering = (split: (bytes: Uint8Array) => readonly Uint8Array[]): Answer => ({ request, oracleText }) => {
        const text = oracleText.includes('"proposalType":"MAP_FIELD"') ? oracleText.replace('"shortRationale":"The header names the target."', `"shortRationale":${JSON.stringify(RATIONALE)}`) : oracleText;
        return chunked(split(utf8(JSON.stringify(bodyFor(request, text)))));
      };
      const accentAt = (bytes: Uint8Array): number => Buffer.from(bytes).indexOf(Buffer.from('é', 'utf8'));
      const whole = await runOnce('s040-whole', { bundle, answer: answering((bytes) => [bytes]) });
      const split = await runOnce('s040-split', {
        bundle,
        answer: answering((bytes) => {
          const cut = accentAt(bytes);
          if (cut < 0) return [bytes];
          // Between the two bytes of é.
          return [bytes.slice(0, cut + 1), bytes.slice(cut + 1)];
        }),
      });
      const storedText = (run: Harnessed): string => eventsOf(storeOf(run), 'RESPONSE_STORED').map((event) => String(member(event['response'], 'content'))).join('\n');
      assert.equal(whole.result.state, 'PROPOSAL_READY', JSON.stringify(codesOf(whole.result)));
      assert.equal(split.result.state, 'PROPOSAL_READY', JSON.stringify(codesOf(split.result)));
      assert.ok(storedText(whole).includes(RATIONALE), 'the rationale came through whole');
      assert.equal(storedText(split), storedText(whole), 'the split body decodes to the same text');
      assert.equal(digestOf(split.result.draft.configuration), digestOf(whole.result.draft.configuration), 'the same draft');
      assert.equal(split.result.proposalDigest, whole.result.proposalDigest);
      assert.ok((split.result.draft.configuration?.fields ?? []).some((field) => field.columnHeader === 'Work Email' && field.destinationField === 'contact.email'));
      // An invalid sequence in the middle of the body: C3 followed by a byte that cannot continue it.
      const invalid = await runOnce('s040-invalid', {
        bundle,
        answer: answering((bytes) => {
          const cut = accentAt(bytes);
          if (cut < 0) return [bytes];
          const broken = new Uint8Array(bytes);
          broken[cut + 1] = 0x28;
          return [broken.slice(0, cut + 1), broken.slice(cut + 1)];
        }),
      });
      const task = invalid.result.tasks.find((candidate) => candidate.outcome !== 'ABSTAINED');
      assert.equal(task?.outcome, 'PROVIDER_TERMINAL_FAILURE', JSON.stringify(invalid.result.tasks));
      assert.ok(outcomeCodes(invalid.result.runLedger).includes('the provider body is not valid UTF-8'), JSON.stringify(outcomeCodes(invalid.result.runLedger)));
      assert.equal(invalid.result.draft.status, 'NOT_DRAFTABLE');
      for (const run of [whole, split, invalid]) {
        assert.ok(!JSON.stringify(storeOf(run)).includes('�'), 'no replacement character in the protected record');
        assert.ok(!JSON.stringify(run.result).includes('�'), 'no replacement character in the result');
      }
    } finally {
      bundle.dispose();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------- R2-038

describe('R2-038 (B03-KERNEL-BOUNDARY): a repeated member grants no authority', () => {
  it('R2-038: a provider answer that repeats requiresAgencyDecision, true then false, is INVALID_SCHEMA DUPLICATE_KEY before any member is read, is repaired at most once and never drafts the item', { timeout: 120_000 }, async () => {
    let target: string | null = null;
    const answers: string[] = [];
    const run = await runOnce('r2-038', {
      answer: ({ oracleText, taskId }) => {
        if (target === null && oracleText.includes('"proposalType":"MAP_FIELD"')) target = taskId;
        if (taskId !== target) return null;
        // Every answer of the task repeats the member, true then false: last-key-wins would read false and grant the mapping.
        const text = withDuplicateAuthority(oracleText, oracleText.includes('"proposalType":"MAP_FIELD"') ? '"proposalType":"MAP_FIELD"' : '"proposalType":');
        answers.push(text);
        return text;
      },
    });
    assert.ok(target !== null && answers.length >= 1, 'the model decision was answered');
    const first = answers[0] ?? '';
    assert.ok(first.includes('"requiresAgencyDecision":true,"requiresAgencyDecision":false'), 'the answer repeats the member');
    // The parser: the repeated member is the only problem, found before any member is read — even beside a member the schema would refuse.
    const parsed = parseProposal(first);
    assert.equal(parsed.ok, false, 'the repeated member is refused');
    if (!parsed.ok) assert.deepEqual(parsed.problems.map((problem) => [problem.pointer, (problem as { code?: string }).code]), [['/items/0/requiresAgencyDecision', 'DUPLICATE_KEY']]);
    const alsoInvalid = parseProposal(first.replace('"overallOutcome":', '"unknownMember":1,"overallOutcome":'));
    assert.equal(alsoInvalid.ok, false);
    if (!alsoInvalid.ok) assert.deepEqual(alsoInvalid.problems.map((problem) => (problem as { code?: string }).code), ['DUPLICATE_KEY'], 'no value was read: the schema never ran');
    // The run: the task is INVALID_SCHEMA DUPLICATE_KEY, repaired once, and the item is never drafted.
    const task = run.result.tasks.find((candidate) => candidate.taskId === target);
    assert.equal(task?.outcome, 'INVALID_SCHEMA', JSON.stringify(run.result.tasks));
    assert.ok(outcomeCodes(run.result.runLedger).includes('DUPLICATE_KEY@/items/0/requiresAgencyDecision'), JSON.stringify(outcomeCodes(run.result.runLedger)));
    const sentForTask = run.sent.filter((request) => request.taskId === target);
    assert.equal(sentForTask.length, 2, 'the answer and one repair, no third');
    assert.deepEqual(sentForTask.map((request) => request.repair), [false, true], 'the second request is the repair round');
    assert.equal(run.result.draft.status, 'NOT_DRAFTABLE');
    assert.ok(!(run.result.draft.configuration?.fields ?? []).some((field) => field.columnHeader === 'Work Email'), 'the item is not in any configuration');
    assert.ok(!run.result.draft.evidence.some((entry) => entry.destinationField === 'contact.email' && entry.origin === 'PROPOSED'), 'no evidence of the item');
    assert.equal(run.validations, 0, 'Migration Core never received it');
  });
});
