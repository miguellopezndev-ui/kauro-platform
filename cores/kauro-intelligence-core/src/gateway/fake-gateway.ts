/**
 * Deterministic gateways for offline work.
 *
 * The scripted gateway answers from a script keyed by task type — a proposal
 * built from the request payload, a raw text, or a typed failure — and
 * records every request it saw, so a test can assert what left the
 * boundary. The replay gateway answers only from recorded responses keyed by
 * envelope hash and fails terminally for a hash it has no recording of: a
 * replay that improvises is not a replay. The oracle is a transport: it sees
 * the serialised provider request and nothing else, recovers run, task and
 * envelope from those bytes, and answers with a Messages-shaped body that
 * goes through the real parser. No fake here reads the GatewayRequest to
 * find the run id; a model could not, so neither may the thing standing in
 * for one. What these prove is the pipeline offline; acceptance by the real
 * endpoint is IC-2. Each of them declares the evidence class SIMULATED, and
 * a result produced through one says so in its provenance (D3-EVC-1).
 */
import { digestOf } from '../contracts/canonical.js';
import { cleanOnlyTargetRef } from '../contracts/envelope.js';
import type { IntelligenceEnvelopeV1, ProposalType } from '../contracts/envelope.js';
import type { IntelligenceProposalV1, ProposalItem, RationaleCode } from '../contracts/proposal.js';
import { MODEL_POLICY_VERSION, PROMPT_BUNDLE_VERSION, PROPOSAL_SCHEMA_VERSION } from '../contracts/versions.js';
import type { GatewayRequest, GatewayResult, ModelGateway } from './model-gateway.js';
import type { ProviderRequest, ProviderResponse, Transport } from './transport-gateway.js';
import { buildProviderRequest, parseProviderRequestPayload, transportGateway } from './transport-gateway.js';

/** The identity a script entry may know: what the request block carries, recovered from the serialised request. */
export interface ScriptPayload {
  readonly runId: string;
  readonly taskId: string;
  readonly envelopeHash: string;
}

export type ScriptEntry =
  | { readonly kind: 'proposal'; readonly build: (envelope: IntelligenceEnvelopeV1, payload: ScriptPayload) => IntelligenceProposalV1 | Record<string, unknown>; readonly usage?: { inputTokens: number; outputTokens: number } }
  | { readonly kind: 'text'; readonly text: string; readonly stopReason?: 'end_turn' | 'max_tokens' | 'refusal'; readonly usage?: { inputTokens: number; outputTokens: number } }
  | { readonly kind: 'retryable'; readonly reason: string; readonly times?: number }
  | { readonly kind: 'terminal'; readonly reason: string }
  | { readonly kind: 'ambiguous'; readonly reason: string }
  | { readonly kind: 'hang'; readonly reason: string };

export interface ScriptedGateway extends ModelGateway {
  readonly requests: readonly GatewayRequest[];
  readonly calls: number;
}

/** A script entry per task type, plus an optional default. A proposal entry is built from the serialised request, never from the GatewayRequest. */
export function scriptedGateway(script: Partial<Record<IntelligenceEnvelopeV1['taskType'] | 'default', ScriptEntry | readonly ScriptEntry[]>>): ScriptedGateway {
  const requests: GatewayRequest[] = [];
  const cursors = new Map<string, number>();
  const gateway: ScriptedGateway = {
    name: 'scripted',
    evidenceClass: 'SIMULATED',
    get requests() {
      return requests;
    },
    get calls() {
      return requests.length;
    },
    async analyze(request: GatewayRequest): Promise<GatewayResult> {
      requests.push(request);
      const key = request.envelope.taskType;
      const entries = script[key] ?? script.default;
      if (entries === undefined) return { kind: 'TERMINAL_FAILURE', reason: `the script has no entry for ${key}`, usage: null };
      const list = Array.isArray(entries) ? (entries as readonly ScriptEntry[]) : [entries as ScriptEntry];
      const cursor = cursors.get(key) ?? 0;
      const entry = list[Math.min(cursor, list.length - 1)] as ScriptEntry;
      cursors.set(key, cursor + 1);
      const usage = { inputTokens: Math.ceil(JSON.stringify(request.envelope).length / 4), outputTokens: 256 };
      switch (entry.kind) {
        case 'proposal': {
          const payload = parseProviderRequestPayload(buildProviderRequest(request));
          const proposal = entry.build(payload.envelope, { runId: payload.runId, taskId: payload.taskId, envelopeHash: payload.envelopeHash });
          return { kind: 'RESPONSE', content: JSON.stringify(proposal), usage: entry.usage ?? usage, stopReason: 'end_turn', providerMeta: { modelId: request.modelPolicy.primaryModel, requestId: `fake_${String(requests.length)}` } };
        }
        case 'text':
          return { kind: 'RESPONSE', content: entry.text, usage: entry.usage ?? usage, stopReason: entry.stopReason ?? 'end_turn', providerMeta: { modelId: request.modelPolicy.primaryModel, requestId: `fake_${String(requests.length)}` } };
        case 'retryable':
          return { kind: 'RETRYABLE_FAILURE', reason: entry.reason, usage: null, retryAfterMs: 1 };
        case 'terminal':
          return { kind: 'TERMINAL_FAILURE', reason: entry.reason, usage: null };
        case 'ambiguous':
          return { kind: 'AMBIGUOUS', reason: entry.reason };
        case 'hang':
          return { kind: 'AMBIGUOUS', reason: entry.reason };
        default:
          return { kind: 'TERMINAL_FAILURE', reason: 'unknown script entry', usage: null };
      }
    },
  };
  return gateway;
}

/** Replay: recorded content by envelope hash, nothing else. */
export function replayGateway(recordings: ReadonlyMap<string, { content: string; usage: { inputTokens: number; outputTokens: number } }>): ModelGateway {
  return {
    name: 'replay',
    evidenceClass: 'SIMULATED',
    async analyze(request: GatewayRequest): Promise<GatewayResult> {
      const recorded = recordings.get(request.envelopeHash);
      if (recorded === undefined) return { kind: 'TERMINAL_FAILURE', reason: `no recording for envelope ${request.envelopeHash.slice(0, 12)}`, usage: null };
      return { kind: 'RESPONSE', content: recorded.content, usage: recorded.usage, stopReason: 'end_turn', providerMeta: { modelId: request.modelPolicy.primaryModel, requestId: 'replay' } };
    },
  };
}

/**
 * The oracle: a proposal derived from the envelope by the simplest honest
 * rule — the first allowed target whose label or api name shares a token with
 * the header, else UNMAPPED_PRESERVE — with evidence refs the envelope
 * carries. It stands in for a model in end-to-end runs and is deliberately
 * unclever; it proves the pipeline, not the semantics. The versions it names
 * are the ones the request block declared, as a model reading it would.
 */
export function oracleProposal(envelope: IntelligenceEnvelopeV1, runId: string, refs: { readonly modelPolicyVersion: string; readonly promptBundleVersion: string } = { modelPolicyVersion: MODEL_POLICY_VERSION, promptBundleVersion: PROMPT_BUNDLE_VERSION }): IntelligenceProposalV1 {
  const fieldsByRef = new Map(envelope.sourceProfile.fields.map((field) => [field.fieldRef, field]));
  const targetText = new Map<string, string>();
  if (envelope.targetContract.mode === 'CLEAN_ONLY') {
    // A CLEAN_ONLY target is keyed by the ref the adapter derives from the full canonical name; the text it matches on is the field part of that name.
    for (const name of envelope.targetContract.canonicalFields) targetText.set(cleanOnlyTargetRef(name), name.split('.')[1] ?? name);
  } else {
    for (const field of envelope.targetContract.fields) targetText.set(field.targetRef, `${field.label} ${field.apiName}`);
  }
  const tokens = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length >= 3);
  const items: ProposalItem[] = envelope.deterministicCandidates.map((candidate) => {
    const field = fieldsByRef.get(candidate.sourceRefs[0] ?? '');
    const headerTokens = tokens(field?.header ?? '');
    let chosen: string | null = null;
    for (const targetRef of candidate.allowedTargetRefs) {
      const text = targetText.get(targetRef) ?? '';
      if (tokens(text).some((token) => headerTokens.includes(token))) {
        chosen = targetRef;
        break;
      }
    }
    const allowed = envelope.constraints.allowedProposalTypes;
    const mapType: ProposalType | null = allowed.includes('MAP_FIELD') ? 'MAP_FIELD' : allowed.includes('SELECT_SEMANTIC_TYPE') ? 'SELECT_SEMANTIC_TYPE' : null;
    const rationale: RationaleCode = chosen !== null ? 'HEADER_MATCHES_TARGET_LABEL' : 'NO_TARGET_IN_ENVELOPE';
    if (chosen !== null && mapType === 'MAP_FIELD') {
      return { candidateRef: candidate.candidateRef, proposalType: 'MAP_FIELD', targetRef: chosen, transformPrimitive: 'PRESERVE_AS_IS', typedTransformParams: null, evidenceRefs: [...candidate.evidenceRefs], requiresAgencyDecision: false, rationaleCode: rationale, shortRationale: 'The header names the target.', alternatives: [], abstainReason: null };
    }
    return { candidateRef: candidate.candidateRef, proposalType: allowed.includes('UNMAPPED_PRESERVE') ? 'UNMAPPED_PRESERVE' : 'ABSTAIN', targetRef: null, transformPrimitive: null, typedTransformParams: null, evidenceRefs: [...candidate.evidenceRefs], requiresAgencyDecision: false, rationaleCode: rationale, shortRationale: null, abstainReason: 'NO_VALID_TARGET', alternatives: [] };
  });
  const proposed = items.filter((item) => item.proposalType !== 'ABSTAIN' && item.proposalType !== 'UNMAPPED_PRESERVE').length;
  return {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    taskId: envelope.taskId,
    runId,
    modelPolicyVersion: refs.modelPolicyVersion,
    promptBundleVersion: refs.promptBundleVersion,
    envelopeHash: digestOf(envelope),
    items,
    overallOutcome: proposed === items.length ? 'PROPOSED' : proposed === 0 ? 'ABSTAINED' : 'MIXED',
  };
}

/**
 * The oracle as a transport. It is handed the ProviderRequest, serialises it
 * and answers from the resulting bytes alone — the run id it names is the
 * one in the request block, whatever any object outside those bytes says —
 * with a Messages-shaped body the real parser classifies.
 */
export function oracleTransport(): Transport {
  let answered = 0;
  return async (request: ProviderRequest): Promise<ProviderResponse> => {
    const bytes = JSON.stringify(request);
    const payload = parseProviderRequestPayload(bytes);
    const text = JSON.stringify(oracleProposal(payload.envelope, payload.runId, { modelPolicyVersion: payload.policyRef.modelPolicyVersion, promptBundleVersion: payload.promptRef.promptBundleVersion }));
    answered += 1;
    return {
      status: 200,
      body: { id: `msg_oracle_${String(answered)}`, type: 'message', role: 'assistant', model: payload.model, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text }], usage: { input_tokens: Math.ceil(bytes.length / 4), output_tokens: Math.ceil(text.length / 4) } },
    };
  };
}

/** The oracle transport behind the real transport gateway, recording requests the way the scripted gateway does. */
export function oracleGateway(): ScriptedGateway {
  const requests: GatewayRequest[] = [];
  const inner = transportGateway(oracleTransport());
  return {
    name: 'oracle',
    evidenceClass: 'SIMULATED',
    get requests() {
      return requests;
    },
    get calls() {
      return requests.length;
    },
    async analyze(request: GatewayRequest): Promise<GatewayResult> {
      requests.push(request);
      return inner.analyze(request);
    },
  };
}
