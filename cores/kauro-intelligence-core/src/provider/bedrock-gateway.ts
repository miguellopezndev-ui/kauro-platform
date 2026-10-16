/**
 * The model gateway over the Bedrock transport (B04 §4.1, D4-TX-2, D4-RCPT-2).
 * It is the transport gateway of B03 plus three rules read from the protected
 * receipt of the answer: a served model that is not the profile's, or cache
 * tokens under a request that sent no cache control, is a terminal failure
 * that breaks the run subject; and a body usage that the x-amzn-bedrock token
 * count headers do not confirm is usage unknown, so the core holds the whole
 * reservation (D4-BR-2). Usage that stays on a failure is charged as billed.
 */
import type { CandidateProfile } from '../gateway/candidates.js';
import type { GatewayEvidenceClass, GatewayResult, ModelGateway } from '../gateway/model-gateway.js';
import { transportGateway } from '../gateway/transport-gateway.js';
import type { Transport } from '../gateway/transport-gateway.js';
import { headerUsage } from './bedrock-receipts.js';
import { bedrockTransport } from './bedrock-transport.js';
import type { BedrockTransportOptions } from './bedrock-transport.js';
import { assessResponse } from './vertex-receipts.js';
import type { ProtectedReceipt, ResponseReceipt } from './vertex-receipts.js';

export type BedrockVerdict = 'OK' | 'WRONG_MODEL' | 'CACHE_TOKENS' | 'USAGE_MISMATCH';

export interface BedrockAssessment {
  readonly result: GatewayResult;
  readonly verdict: BedrockVerdict;
  readonly subjectBroken: boolean;
}

/** The usage a result carries, or null when it carries none. */
function usageOf(result: GatewayResult): { readonly inputTokens: number; readonly outputTokens: number } | null {
  if (result.kind === 'AMBIGUOUS') return null;
  const usage = (result as { readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } | null }).usage;
  return usage === undefined || usage === null ? null : usage;
}

/**
 * The receipt of a 200 against the profile and against the token count headers. Served model and cache tokens come first (they
 * break the subject); then a usage the headers do not confirm, both counts, becomes unknown on the result. Only a 200 is assessed.
 */
export function bedrockAssessment(profile: CandidateProfile, result: GatewayResult, receipt: ResponseReceipt): BedrockAssessment {
  if (receipt.status !== 200) return { result, verdict: 'OK', subjectBroken: false };
  const base = assessResponse(profile, receipt);
  if (base.verdict === 'CACHE_TOKENS' && result.kind === 'RESPONSE') return { result: { kind: 'TERMINAL_FAILURE', reason: 'CACHE_TOKENS: the provider reported cache tokens to a request that sent no cache control', usage: result.usage }, verdict: 'CACHE_TOKENS', subjectBroken: true };
  if (base.subjectBroken) return { result, verdict: base.verdict, subjectBroken: true };
  const usage = usageOf(result);
  if (usage === null) return { result, verdict: 'OK', subjectBroken: false };
  const witnessed = headerUsage(receipt.headers);
  if (witnessed !== null && witnessed.inputTokens === usage.inputTokens && witnessed.outputTokens === usage.outputTokens) return { result, verdict: 'OK', subjectBroken: false };
  // Two witnesses that disagree, or one missing: the usage is unknown, never the smaller of them.
  return { result: { ...result, usage: null } as GatewayResult, verdict: 'USAGE_MISMATCH', subjectBroken: false };
}

export interface BedrockGateway extends ModelGateway {
  /** True once any response broke the subject; the causes are closed words. */
  readonly subject: { readonly broken: boolean; readonly causes: readonly string[] };
}

/** `wrapTransport` lets the runner capture the ProviderRequest bytes the core hands over (the scorer's observed egress) without a second gateway. */
export function bedrockGateway(options: BedrockTransportOptions & { readonly evidenceClass?: GatewayEvidenceClass; readonly wrapTransport?: (inner: Transport) => Transport }): BedrockGateway {
  const latest = new Map<string, ResponseReceipt>();
  const sink = (receipt: ProtectedReceipt): void => {
    if (receipt.kind === 'RESPONSE' && receipt.idempotencyRef !== null) latest.set(receipt.idempotencyRef, receipt);
    options.sink?.(receipt);
  };
  const wire = bedrockTransport({ ...options, sink });
  const inner = transportGateway(options.wrapTransport === undefined ? wire : options.wrapTransport(wire), { evidenceClass: options.evidenceClass ?? 'SIMULATED' });
  const causes: string[] = [];
  return {
    name: 'bedrock',
    evidenceClass: inner.evidenceClass,
    subject: { get broken(): boolean { return causes.length > 0; }, get causes(): readonly string[] { return causes; } },
    async analyze(request) {
      latest.delete(request.idempotencyRef);
      const result = await inner.analyze(request);
      const receipt = latest.get(request.idempotencyRef);
      if (receipt === undefined) return result;
      const assessment = bedrockAssessment(options.profile, result, receipt);
      if (assessment.subjectBroken) causes.push(assessment.verdict);
      return assessment.result;
    },
  };
}
