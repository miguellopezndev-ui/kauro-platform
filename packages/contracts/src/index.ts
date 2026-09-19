/**
 * @kauro/contracts — the contract authority of the Kauro platform.
 *
 * - generated/types: one TypeScript interface per R2 contract, the command catalogue and the state machines (generated from the
 *   vendored registry, provenance-checked at build time);
 * - schemas.json: the JSON Schema 2020-12 bundle (urn:kauro:r2:contracts) for runtime admission of untrusted objects;
 * - canonical / digest: the canonical JSON profile and the domain-separated digests every producer and consumer share;
 * - registry: verified access to the vendored registry files (gates, screens, policy).
 */
export * from "./generated/types.js";
export { canonicalize, canonicalBytes, parseCanonical, compareCodePoints, CanonicalError } from "./canonical.js";
export type { CanonicalValue } from "./canonical.js";
export { DOMAINS, R2_DOMAIN_ALIASES, structuredDigest, structuredPreimage, rawDigest, digestEquals, isSha256Hex } from "./digest.js";
export type { DigestDomain } from "./digest.js";
export { provenance, registryBytes, registryJson, gates, screens, policy, RegistryIntegrityError } from "./registry.js";
export type { Provenance, RegistryGate } from "./registry.js";
