/**
 * Sabotage inventory — the compiler lot of the IC-1 correction, rounds 2 and
 * 3: evidence derived from facts and per-candidate primitives (IC-06),
 * identity proof needing an authoritative identifier (IC-07), targets
 * claimed per record mapping at the resolver and at assembly (IC-08), every
 * rationale code under a fact rule with AMBIGUOUS never PROPOSED (R2-PC-02),
 * the declared record id column reaching the resolver through run()
 * (R2-PC-04), and ENUM destinations carrying the contract's options
 * (R2-PC-05). Same shape as core.mjs; ids are unique across the directory.
 */
export const MUTATIONS = [
  { id: 'rationale-self-claim-trusted', file: 'src/compiler/compiler.ts', from: "if (holds === false) return { evidenceClass: 'INSUFFICIENT', unsupportedClaim: true };", to: '/* sabotage */', gate: 'a rationale code the facts contradict still earns an evidence class and a PROPOSED item' },
  { id: 'candidate-primitives-not-checked', file: 'src/compiler/compiler.ts', from: "if (candidate !== undefined && !candidate.allowedPrimitiveRefs.includes(item.transformPrimitive)) fail('PRIMITIVE_NOT_ALLOWED_FOR_CANDIDATE', 'FORBIDDEN_PROPOSAL');", to: '/* sabotage */', gate: 'a primitive the global catalogue supports is accepted for a candidate whose allowlist excludes it' },
  { id: 'email-uniqueness-proves-identity', file: 'src/resolver/deterministic-resolver.ts', from: 'const authoritative = (authority.declaredRecordId || authority.contractExternalId) && !signal;', to: 'const authoritative = authority.declaredRecordId || authority.contractExternalId || signal;', gate: 'a unique, well-formed email is classified PROVEN_UNIQUE_IDENTIFIER' },
  { id: 'claimed-map-global-again', file: 'src/resolver/deterministic-resolver.ts', from: 'const claimKey = (recordId: string | null, target: string): string => outputScopeOf(recordId, target);', to: 'const claimKey = (recordId: string | null, target: string): string => target;', gate: 'the second CONTACT file loses its Email mapping because the first file claimed contact.email for the whole run' },
  // Round 3.
  { id: 'ambiguous-evidence-proposed', file: 'src/compiler/compiler.ts', from: "fail('AMBIGUOUS_EVIDENCE_NEEDS_AGENCY', 'REQUIRES_AGENCY_DECISION');", to: '/* sabotage */', gate: 'an item whose claim holds but decides nothing (INSUFFICIENT_EVIDENCE, FOREIGN_KEY_COLUMN, ...) stays PROPOSED on AMBIGUOUS evidence and a status column is drafted as a last name' },
  { id: 'deferring-code-supports-authority', file: 'src/compiler/compiler.ts', from: "INSUFFICIENT_EVIDENCE: 'DEFERS',", to: "INSUFFICIENT_EVIDENCE: 'SUPPORTS',", gate: 'a claim of insufficient evidence that holds is taken as SUPPORTED evidence for the mapping' },
  { id: 'assembly-claims-global', file: 'src/api/intelligence-core.ts', from: 'const claimKey = (recordId: string, destinationField: string): string => outputScopeOf(recordId, destinationField);', to: 'const claimKey = (recordId: string, destinationField: string): string => destinationField;', gate: 'assembly claims a destination once per run: the second CONTACT file loses its Email, First Name, Last Name and Phone as DUPLICATE_TARGET' },
  { id: 'record-id-declaration-dropped', file: 'src/planner/candidate-accounting.ts', from: '{ recordIdColumns: input.projectRevision.recordIdColumns }', to: '{}', gate: 'the record id column the project declares never reaches the resolver: no column is PROVEN through run()' },
  { id: 'declared-email-proves-identity', file: 'src/resolver/deterministic-resolver.ts', from: 'const authoritative = (authority.declaredRecordId || authority.contractExternalId) && !signal;', to: 'const authoritative = authority.declaredRecordId || (authority.contractExternalId && !signal);', gate: 'an Email column declared as the record id column is PROVEN_UNIQUE_IDENTIFIER (the round-2 line)' },
  { id: 'enum-options-not-carried', file: 'src/api/intelligence-core.ts', from: '...(allowedValues === undefined ? {} : { allowedValues })', to: '...{}', gate: 'an ENUM destination reaches the host without allowedValues and the engine refuses the configuration: no picklist mapping is ever drafted' },
];
