/**
 * The egress harness of the privacy acceptance tests (gate G-IC-PRIVACY).
 *
 * One whole run of the public API — `createIntelligenceCore(...).run` from the
 * package index — through the transport gateway, in CLEAN_ONLY, HUBSPOT or
 * SALESFORCE, with real Migration Core validation of the drafted
 * configuration, and every channel a run writes to captured: the serialised
 * provider requests, the envelopes parsed back out of those bytes by the
 * public payload parser, the transport metadata (deadline and correlation),
 * the telemetry events, the process's stdout and stderr, the run ledger and
 * the returned result. A sentinel is looked for in every one of them, raw and
 * in the encodings a serialiser could turn it into.
 *
 * The contracts are the fixture's, edited here: the peer package is loaded by
 * the name package.json gives it, so nothing in this file spells it.
 */
import { readFileSync } from 'node:fs';

import { MemoryLedgerStore, VirtualClock, cleanOnlyTargetRef, createIntelligenceCore, digestOf, oracleProposal, oracleTransport, parseProviderRequestPayload, transportGateway } from '../../src/index.js';
import type { IntelligenceEnvelopeV1, IntelligenceResult, LedgerEvent, MemoryEntry, ProviderRequest, ProviderResponse, Transport } from '../../src/index.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort, vendorContract } from './fixtures.js';
import type { Bundle } from './fixtures.js';

export type Mode = 'CLEAN_ONLY' | 'HUBSPOT' | 'SALESFORCE';
export type VendorMode = Exclude<Mode, 'CLEAN_ONLY'>;
export const MODES: readonly Mode[] = ['CLEAN_ONLY', 'HUBSPOT', 'SALESFORCE'];

type HashedContract = ReturnType<typeof vendorContract>;
type ContractBody = HashedContract['contract'];
type ContractField = ContractBody['objects'][number]['fields'][number];
type Profiled = ReturnType<typeof profileBundle>;

const manifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { readonly peerDependencies: Readonly<Record<string, string>> };
const peer = (await import(Object.keys(manifest.peerDependencies)[0] ?? '')) as { hashTargetContract(body: ContractBody): HashedContract };

/**
 * One scenario. `options` are the picklist options of the vendor target and,
 * in every mode, the values of the source Status column (the host's
 * categorical summary of it). `denied` are the texts that must never leave;
 * `header` adds a source column with that header and a memory entry whose
 * pattern is that header; `apiName` adds a vendor field Migration Core
 * delivers (contact.mobilePhone, by its label) whose api name is that text.
 */
export interface Vector {
  readonly id: string;
  readonly label: string;
  readonly options: readonly string[];
  readonly safe: boolean;
  readonly denied: readonly string[];
  readonly header?: string;
  readonly apiName?: string;
  /** The value channel alone reads these values as text — one word no vocabulary knows, in one case — so where no target lists them (CLEAN_ONLY) a pure mask of them may travel as L2; every other unsafe vector is withheld whole in every mode. */
  readonly text?: true;
}

/** What a run's opaque references are scoped to: the tenant, the attempt, the project revision and the egress key. */
export interface Scope {
  readonly agencyId?: string;
  readonly clientId?: string;
  readonly attemptId?: string;
  readonly revision?: string;
  readonly key?: number;
}

/** The object and api name of the vendor picklist target in each vendor mode. */
export const PICKLIST_TARGET: Readonly<Record<VendorMode, { readonly object: string; readonly apiName: string }>> = { HUBSPOT: { object: 'contact', apiName: 'lifecyclestage' }, SALESFORCE: { object: 'Contact', apiName: 'Title' } };

/** A label Migration Core's adapter delivers through (contact.mobilePhone), for the field whose api name the vector names. */
const DELIVERABLE_LABEL: Readonly<Record<VendorMode, string>> = { HUBSPOT: 'Mobile phone number', SALESFORCE: 'MobilePhone' };

const stringField = (apiName: string, label: string): ContractField => ({
  apiName,
  label,
  type: 'string',
  createable: 'TRUE',
  updateable: 'TRUE',
  nillable: 'TRUE',
  length: 255,
  precision: null,
  scale: null,
  unique: 'FALSE',
  externalId: 'FALSE',
  idLookup: 'FALSE',
  calculated: 'FALSE',
  autoNumber: 'FALSE',
  defaultedOnCreate: 'FALSE',
  restrictedPicklist: 'FALSE',
  picklistValues: [],
  referenceTo: [],
  relationshipName: null,
  evidence: 'ARTIFACT',
});

/** The fixture contract of a vendor mode with the picklist target relabelled and its options replaced, plus — when asked — a deliverable field under the given api name. */
export function contractFor(mode: VendorMode, label: string, options: readonly string[], apiName?: string): HashedContract {
  const base = vendorContract(mode, { withStatusPicklist: true });
  const target = PICKLIST_TARGET[mode];
  const body: ContractBody = {
    ...base.contract,
    objects: base.contract.objects.map((object) => {
      if (object.apiName !== target.object) return object;
      const fields = object.fields.map((entry) => (entry.apiName === target.apiName ? { ...entry, label, type: mode === 'HUBSPOT' ? 'enumeration' : 'picklist', picklistValues: options.map((value) => ({ value, label: value, active: true, defaultValue: false })) } : entry));
      return { ...object, fields: apiName === undefined ? fields : [...fields, stringField(apiName, DELIVERABLE_LABEL[mode])] };
    }),
  };
  return peer.hashTargetContract(body);
}

/** The contacts file of a vector: four people, a Status column holding the options, and the extra column when the vector has one. */
export function contactsFor(vector: Pick<Vector, 'options' | 'header'>): string {
  const people = ['Ada,Lovelace', 'Grace,Hopper', 'Alan,Turing', 'Edsger,Dijkstra'];
  const values = vector.options.length === 0 ? ['Active'] : vector.options;
  const count = Math.max(people.length, values.length);
  const header = `Contact ID,First Name,Last Name,Email,Phone,Status${vector.header === undefined ? '' : `,${vector.header}`}`;
  const lines = Array.from({ length: count }, (unused, index) => `${String(index + 1)},${people[index % people.length] ?? 'Ada,Lovelace'},person${String(index)}@example.test,,${values[index % values.length] ?? ''}${vector.header === undefined ? '' : `,${index % 2 === 0 ? 'x' : 'y'}`}`);
  return `${header}\n${lines.join('\n')}\n`;
}

/** What a run wrote, everywhere it wrote. */
export interface Observed {
  readonly mode: Mode;
  readonly result: IntelligenceResult;
  readonly requests: readonly string[];
  readonly envelopes: readonly IntelligenceEnvelopeV1[];
  readonly metadata: readonly string[];
  readonly telemetry: readonly unknown[];
  readonly logs: readonly string[];
  readonly portCalls: number;
  readonly packageVerified: boolean;
  /** The fieldRef of the Status column and of the extra column; the targetRef of the picklist target and of the api-name field (null where there is none). */
  readonly refs: { readonly status: string; readonly extra: string | null; readonly picklist: string | null; readonly apiField: string | null };
}

/** An answer a test puts behind the capture instead of the oracle's; null lets the oracle answer. */
export type Answer = (request: ProviderRequest, deadlineAt: string, count: number) => Promise<ProviderResponse | null> | ProviderResponse | null;

export interface RunOptions {
  readonly scope?: Scope;
  readonly answer?: Answer;
  /** A transport failure to throw instead of answering, by request count; null answers. */
  readonly fail?: (request: ProviderRequest, count: number) => Error | null;
  /** Memory entries beside the vector's own. */
  readonly memory?: readonly MemoryEntry[];
  /** A bundle to run on instead of the vector's own contacts file; the caller disposes it. */
  readonly bundle?: Bundle;
}

/** A CLIENT memory entry of the tenant whose pattern is a source header. */
export function memoryFor(pattern: string, tenant: { readonly agencyId: string; readonly clientId: string }, memoryId = 'mem_0a0b0c0d0e0f1011', targetRef: string | null = null, scope: MemoryEntry['scope'] = 'CLIENT'): MemoryEntry {
  return { memoryId, scope, tenant: scope === 'AGENCY' ? { agencyId: tenant.agencyId, clientId: null } : tenant, knowledgeType: targetRef === null ? 'SEMANTIC_TYPE_CONVENTION' : 'FIELD_MAPPING_CONVENTION', ruleOrPattern: { sourceHeaderPattern: pattern, targetRef, semanticType: targetRef === null ? 'TEXT' : null }, sourceProjectRef: 'project-0', sourcePlanVersion: '1.0.0', targetInstanceRef: null, targetSchemaVersion: null, approvedBy: 'human:qa', verificationOutcome: 'AGENCY_APPROVED', provenance: 'run r task t', createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null, status: 'ACTIVE', version: 1 };
}

/** The adapter's refs, recomputed from what they are derived from, so a test names a column or a target without reading the envelope. */
export const fieldRefOf = (locator: string): string => `fld_${digestOf(`field:${locator}`).slice(0, 16)}`;
export const targetRefOf = (mode: VendorMode, object: string, apiName: string): string => `tgt_${digestOf(`${mode}:${object}:${apiName}`).slice(0, 16)}`;
export const canonicalRef = (name: string): string => cleanOnlyTargetRef(name);

/** The locator of a column by its header, from the profile Migration Core produced. */
export function locatorOf(profiled: Profiled, header: string): string {
  for (const file of profiled.profile.profile.files) for (const sheet of file.sheets) for (const column of sheet.columns) if ((column.headerRaw ?? '') === header) return column.columnLocatorId;
  throw new Error(`no column ${header} in the profile`);
}

/** One whole run of the vector in a mode, every channel captured. */
export async function runVector(mode: Mode, vector: Vector, options: RunOptions = {}): Promise<Observed> {
  const scope = options.scope ?? {};
  const bundle = options.bundle ?? makeBundle(`egress-${mode.toLowerCase()}-${vector.id}`, { contacts: contactsFor(vector) });
  const logs: string[] = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  // Every byte the process writes while the run is in flight is recorded, and still written.
  const recording = (write: typeof process.stdout.write, stream: NodeJS.WriteStream): typeof process.stdout.write =>
    ((chunk: unknown, ...rest: unknown[]): boolean => {
      logs.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return (write as (this: NodeJS.WriteStream, chunk: unknown, ...more: unknown[]) => boolean).call(stream, chunk, ...rest);
    }) as typeof process.stdout.write;
  try {
    const profiled = profileBundle(bundle, mode);
    const contract = mode === 'CLEAN_ONLY' ? null : contractFor(mode, vector.label, vector.options, vector.apiName);
    const clock = new VirtualClock();
    const port = realValidationPort(bundle, profiled.profile, contract, { clock });
    const requests: string[] = [];
    const envelopes: IntelligenceEnvelopeV1[] = [];
    const metadata: string[] = [];
    const telemetry: unknown[] = [];
    const inner = oracleTransport();
    const transport: Transport = async (request, deadlineAt, correlation) => {
      const wire = JSON.stringify(request);
      requests.push(wire);
      metadata.push(JSON.stringify({ deadlineAt, correlation: correlation ?? null }));
      envelopes.push(parseProviderRequestPayload(wire).envelope);
      const failure = options.fail?.(request, requests.length) ?? null;
      if (failure !== null) throw failure;
      const answered = options.answer === undefined ? null : await options.answer(request, deadlineAt, requests.length);
      return answered ?? inner(request, deadlineAt, correlation);
    };
    const deps = { ...depsFor(transportGateway(transport), port, clock), ledgerStore: new MemoryLedgerStore(), egressKey: { keyId: `egress-key-${String(scope.key ?? 7)}`, secret: Buffer.alloc(32, scope.key ?? 7) }, telemetry: (event: unknown): void => { telemetry.push(structuredClone(event)); } };
    const tenant = { agencyId: scope.agencyId ?? CONTEXT.tenant.agencyId, clientId: scope.clientId ?? CONTEXT.tenant.clientId };
    const memory = [...(vector.header === undefined ? [] : [memoryFor(vector.header, tenant)]), ...(options.memory ?? [])];
    const status = locatorOf(profiled, 'Status');
    const extra = vector.header === undefined ? null : locatorOf(profiled, vector.header);
    const summaries = new Map<string, readonly string[]>([[status, vector.options.length === 0 ? ['Active'] : vector.options]]);
    if (extra !== null) summaries.set(extra, ['x', 'y']);
    const base = inputFor(mode, profiled, contract, { categoricalSummaries: summaries, scopedMemorySnapshot: memory });
    const revision = scope.revision ?? 'rev-egress-a';
    // The files are declared, as a project declares them: which object a file holds is the agency's fact, not a question for the model.
    const declaredObjects = Object.fromEntries(bundle.files.map((file) => [file.path, file.object])) as Readonly<Record<string, 'CONTACT' | 'COMPANY' | 'DEAL' | 'LEAD'>>;
    const input = { ...base, projectRevision: { ...base.projectRevision, projectRevisionId: revision, projectRevisionHash: digestOf(['revision', revision, profiled.profile.profileHash]), declaredObjects } };
    process.stdout.write = recording(out, process.stdout);
    process.stderr.write = recording(err, process.stderr);
    let result: IntelligenceResult;
    try {
      result = await createIntelligenceCore(deps).run(input, { ...CONTEXT, tenant, auditAttemptId: scope.attemptId ?? CONTEXT.auditAttemptId });
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
    const vendor = mode === 'CLEAN_ONLY' ? null : mode;
    return {
      mode,
      result,
      requests,
      envelopes,
      metadata,
      telemetry,
      logs,
      portCalls: port.calls,
      packageVerified: result.draft.fullValidation?.packageVerified === true,
      refs: {
        status: fieldRefOf(status),
        extra: extra === null ? null : fieldRefOf(extra),
        picklist: vendor === null ? null : targetRefOf(vendor, PICKLIST_TARGET[vendor].object, PICKLIST_TARGET[vendor].apiName),
        apiField: vendor === null || vector.apiName === undefined ? null : targetRefOf(vendor, PICKLIST_TARGET[vendor].object, vector.apiName),
      },
    };
  } finally {
    if (options.bundle === undefined) bundle.dispose();
  }
}

/** The encodings a serialiser could turn a text into: raw, JSON \u escapes (by code unit and by code point), base64, hex, percent-encoding. */
export function forms(text: string): readonly string[] {
  const units = text.split('').map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  return [...new Set([text, units, Buffer.from(text).toString('base64'), Buffer.from(text).toString('hex'), encodeURIComponent(text)])];
}

/** The outbound channels: what left the process towards the provider, and what the process emitted about it. */
export const OUTBOUND = ['provider request bytes', 'parsed envelopes', 'transport metadata', 'telemetry', 'process logs'] as const;

/**
 * A result without its configuration: the configuration is the handover to
 * Migration Core, which must name the real columns it maps by their real
 * headers, and stays with the host. Everything else a result carries — tasks,
 * codes, unresolved items, provenance, the validation receipt — is read.
 */
function withoutHandover(result: unknown): unknown {
  if (result === null || typeof result !== 'object') return result;
  const record = result as { readonly draft?: { readonly configuration?: unknown } };
  return record.draft === undefined ? result : { ...record, draft: { ...record.draft, configuration: null } };
}

/**
 * Every channel of an observed run, by name, as the text a reader of that
 * channel sees. The run ledger is read whole, as the result carries it: the
 * public projection (D3-PRIV-1), in which a stored response is its digest,
 * size, usage and stop reason. The provider's own answer, kept byte for byte
 * so a recovery never buys it twice, is in the host's protected store under
 * its own retention class and is not a channel of the result; everything the
 * result's ledger records — notes, reasons, outcomes, codes, the projected
 * responses — is read.
 */
export function channels(observed: Observed): Readonly<Record<string, string>> {
  const { runLedger, ...rest } = observed.result;
  return {
    'provider request bytes': observed.requests.join('\n'),
    'parsed envelopes': JSON.stringify(observed.envelopes),
    'transport metadata': observed.metadata.join('\n'),
    telemetry: JSON.stringify(observed.telemetry),
    'process logs': observed.logs.join(''),
    'run ledger': JSON.stringify(runLedger.map((event) => (event.kind === 'RESULT' ? { ...event, result: withoutHandover(event.result) } : event))),
    'returned result': JSON.stringify(withoutHandover(rest)),
  };
}

/** Which denied texts appear on which channel, in which encoding: empty when nothing leaked. */
export function leaks(observed: Observed, denied: readonly string[], only?: readonly string[]): readonly string[] {
  const found: string[] = [];
  for (const [name, text] of Object.entries(channels(observed))) {
    if (only !== undefined && !only.includes(name)) continue;
    for (const token of denied) for (const form of forms(token)) if (text.includes(form)) found.push(`${name} carries ${JSON.stringify(token)}${form === token ? '' : ` as ${JSON.stringify(form)}`}`);
  }
  return found;
}

type VendorView = Extract<IntelligenceEnvelopeV1['targetContract'], { readonly fields: unknown }>;

/** The target field views of an envelope, none in CLEAN_ONLY. */
export function targetFields(envelope: IntelligenceEnvelopeV1): VendorView['fields'] {
  return envelope.targetContract.mode === 'CLEAN_ONLY' ? [] : (envelope.targetContract as VendorView).fields;
}

/** The usefulness of a run: the provider was reached, Migration Core validated the whole draft, email and first name are mapped, telemetry was emitted. Returns what failed. */
export function usefulness(observed: Observed): readonly string[] {
  const failed: string[] = [];
  if (observed.requests.length === 0) failed.push('transport-used');
  if (observed.portCalls === 0 || !observed.packageVerified) failed.push('real-validation');
  if (observed.result.draft.status !== 'SYSTEM_DRAFT') failed.push(`draft:${observed.result.draft.status}:${observed.result.state}`);
  const fields = observed.result.draft.configuration?.fields ?? [];
  if (!fields.some((entry) => entry.destinationField === 'contact.email')) failed.push('useful-email');
  if (!fields.some((entry) => entry.destinationField === 'contact.firstName')) failed.push('useful-name');
  if (observed.telemetry.length === 0) failed.push('telemetry-observed');
  return failed;
}

/** An opaque reference the envelope builder mints: a short channel prefix and twelve letters g–v. */
export const opaque = (prefix: string): RegExp => new RegExp(`^${prefix}_[g-v]{12}$`, 'u');

/** A 200 response carrying a text, as a provider sends it, under the request's model or another. */
export const respond = (request: ProviderRequest, text: string, model = request.model): ProviderResponse => ({ status: 200, body: { model, stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 200 } }, requestId: 'req_synthetic' });

/** The oracle's own proposal for a request with one parameter the primitive does not take: a repairable proposal whose compiler code echoes the parameter's name, so the task gets a repair round. */
export function proposalWithParam(request: ProviderRequest, name: string): string {
  const payload = parseProviderRequestPayload(JSON.stringify(request));
  const proposal = oracleProposal(payload.envelope, payload.runId);
  const [first, ...rest] = proposal.items;
  if (first === undefined) return JSON.stringify(proposal);
  return JSON.stringify({ ...proposal, items: [{ ...first, proposalType: 'UNMAPPED_PRESERVE', targetRef: null, transformPrimitive: 'TRIM_WHITESPACE', typedTransformParams: { [name]: 'x' } }, ...rest] });
}

/** An answer that sends every task through one repair round: the first attempt of a task is answered with a repairable proposal, the repair round by the oracle. */
export const throughRepair: Answer = (request) => (parseProviderRequestPayload(JSON.stringify(request)).envelope.repairContext === null ? respond(request, proposalWithParam(request, 'Tolveno')) : null);
