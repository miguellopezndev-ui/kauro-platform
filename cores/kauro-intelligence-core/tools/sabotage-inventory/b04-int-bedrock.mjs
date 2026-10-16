/**
 * Sabotage inventory — B04 integrate, the Bedrock lot (L4, owner decision A9): the `us.` geography profile only (D4-BR-1), usage
 * confirmed by the token-count headers (D4-BR-2), the session token redacted in the receipt (G14), and qualification bound to the
 * InvokeModel endpoint in a US source region (R2-040). Each mutation sits in the code it guards; the tests named in each gate kill
 * it. Same shape as core.mjs; ids are unique across the directory.
 */
export const MUTATIONS = [
  { id: 'b04int-candidate-global-profile', file: 'src/gateway/candidates.ts', from: String.raw`const US_GEOGRAPHY_PROFILE = /^us\.anthropic\.[a-z0-9]/u;`, to: String.raw`const US_GEOGRAPHY_PROFILE = /^(?:us|global)\.anthropic\.[a-z0-9]/u;`, gate: 'D4-BR-1: a global. inference profile is admitted as a candidate (test/b04-bedrock-policy.test.ts)' },
  { id: 'b04int-wire-global-profile', file: 'src/provider/bedrock-wire.ts', from: String.raw`export const BEDROCK_PROFILE = /^us\.anthropic\.`, to: String.raw`export const BEDROCK_PROFILE = /^(?:us|global)\.anthropic\.`, gate: 'D4-BR-1: the wire builds an InvokeModel URL for a global. profile (test/b04-bedrock-wire.test.ts D4-BR-1)' },
  { id: 'b04int-usage-header-unchecked', file: 'src/provider/bedrock-gateway.ts', from: 'if (witnessed !== null && witnessed.inputTokens === usage.inputTokens && witnessed.outputTokens === usage.outputTokens) return', to: 'if (usage !== null) return', gate: 'D4-BR-2: body usage the token-count headers do not confirm is counted, instead of usage unknown with the full hold (test/b04-bedrock-transport.test.ts D4-BR-2)' },
  { id: 'b04int-session-token-in-receipt', file: 'src/provider/bedrock-transport.ts', from: "'x-amz-security-token': redactedSecret(credentials.sessionToken)", to: "'x-amz-security-token': credentials.sessionToken", gate: 'G14: the request receipt carries the session token in clear (test/b04-bedrock-transport.test.ts SigV4)' },
  { id: 'b04int-qualify-any-region', file: 'src/benchmark/qualification.ts', from: "(?:${BEDROCK_REGIONS.map(escaped).join('|')})", to: '[a-z0-9-]+', gate: 'R2-040: receipts at an InvokeModel endpoint outside the US source regions qualify (test/b04-bedrock-qualify.test.ts)' },
];
