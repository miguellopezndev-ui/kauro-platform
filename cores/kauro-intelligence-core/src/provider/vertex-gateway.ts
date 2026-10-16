/**
 * The model gateway over the Vertex transport (B04 D4-TX-2, D4-RCPT-2). It is
 * the transport gateway of B03 plus one rule: a response whose served model is
 * not the profile's, or that reports cache tokens under a request that sent no
 * cache control, is a terminal failure and breaks the run subject. Its usage
 * stays on the failure, so the grant is charged what the provider billed.
 */
import type { GatewayEvidenceClass, ModelGateway } from '../gateway/model-gateway.js';
import { transportGateway } from '../gateway/transport-gateway.js';
import type { Transport } from '../gateway/transport-gateway.js';
import { assessResponse } from './vertex-receipts.js';
import type { Assessment, ProtectedReceipt, ResponseReceipt } from './vertex-receipts.js';
import { vertexTransport } from './vertex-transport.js';
import type { VertexTransportOptions } from './vertex-transport.js';

export interface VertexGateway extends ModelGateway {
  /** True once any response broke the subject; the causes are closed words. */
  readonly subject: { readonly broken: boolean; readonly causes: readonly string[] };
}

/** `wrapTransport` lets the runner capture the ProviderRequest bytes the core hands over (the scorer's observed egress) without a second gateway. */
export function vertexGateway(options: VertexTransportOptions & { readonly evidenceClass?: GatewayEvidenceClass; readonly wrapTransport?: (inner: Transport) => Transport }): VertexGateway {
  const latest = new Map<string, ResponseReceipt>();
  const sink = (receipt: ProtectedReceipt): void => {
    if (receipt.kind === 'RESPONSE' && receipt.idempotencyRef !== null) latest.set(receipt.idempotencyRef, receipt);
    options.sink?.(receipt);
  };
  const wire = vertexTransport({ ...options, sink });
  const inner = transportGateway(options.wrapTransport === undefined ? wire : options.wrapTransport(wire), { evidenceClass: options.evidenceClass ?? 'SIMULATED' });
  const causes: string[] = [];
  return {
    name: 'vertex',
    evidenceClass: inner.evidenceClass,
    subject: { get broken(): boolean { return causes.length > 0; }, get causes(): readonly string[] { return causes; } },
    async analyze(request) {
      latest.delete(request.idempotencyRef);
      const result = await inner.analyze(request);
      const receipt = latest.get(request.idempotencyRef);
      const assessment: Assessment = receipt === undefined ? { verdict: 'OK', subjectBroken: false } : assessResponse(options.profile, receipt);
      if (assessment.subjectBroken) causes.push(assessment.verdict);
      if (assessment.verdict === 'CACHE_TOKENS' && result.kind === 'RESPONSE') return { kind: 'TERMINAL_FAILURE', reason: 'CACHE_TOKENS: the provider reported cache tokens to a request that sent no cache control', usage: result.usage };
      return result;
    },
  };
}
