/**
 * The identity verifier a deployment binds (O23A): the provider selection of @kauro/identity decides which IdentityTokenVerifier the
 * session boundary receives. The default and every SANDBOX/LIVE selection is the served Identity Platform verifier, exactly as
 * sessionAssemblyOf builds it; the Cognito candidate is reachable only in LOCAL with KAURO_IDENTITY_COGNITO_CANDIDATE=on and its offline
 * pool configuration (O23B owns the live selection, the pool, the MFA claim and the migration of existing subjects).
 */
import type { IdentityTokenVerifier } from "@kauro/application";
import type { Clock } from "@kauro/domain";
import { IDENTITY_PROVIDERS, assertProviderSelection, createCognitoTokenVerifier, type JsonWebKeySet, type ProviderSelection } from "@kauro/identity";

/** The offline Cognito pool a LOCAL candidate run names. */
export interface CognitoCandidatePool {
  readonly region: string;
  readonly userPoolId: string;
  readonly clientId: string;
  readonly jwks: JsonWebKeySet;
  readonly secondFactorClaim: string | null;
}

export function selectedIdentityVerifier(selection: ProviderSelection, served: () => IdentityTokenVerifier, pool: CognitoCandidatePool | null, clock: Clock): IdentityTokenVerifier {
  assertProviderSelection(selection);
  if (selection.kind === "IDENTITY_PLATFORM") return served();
  if (pool === null) throw new Error(`the ${selection.kind} identity provider needs its offline pool configuration`);
  const provider = selection.kind === "COGNITO" ? IDENTITY_PROVIDERS.COGNITO.provider : IDENTITY_PROVIDERS.SIMULATOR.provider;
  return createCognitoTokenVerifier({ ...pool, provider, clock });
}
