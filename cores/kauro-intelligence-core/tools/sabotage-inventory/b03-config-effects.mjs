/**
 * Sabotage inventory — the B03-CONFIG-EFFECTS lot: the receipt names the
 * loader hash of the document the core produced (B03-R11, D3-CFG-3), the
 * product translation expresses every fragment (D3-CFG-2), the finalizer
 * meets every fragment with its effect in Migration Core's run (D3-CFG-3),
 * the effects block carries nothing of the bundle, and a labelled fake never
 * presents itself as a live provider (D3-EVC-1). Each mutation sits in the
 * code it guards; the tests of test/b03-config-effects.test.ts kill them.
 * Same shape as core.mjs; ids are unique across the directory.
 */
export const MUTATIONS = [
  { id: 'core-config-hash-null-accepted', file: 'src/api/intelligence-core.ts', from: "if ((result.ok || result.packageVerified) && result.evidence.coreConfigHash === null) problems.push('VALIDATION_CORE_CONFIG_HASH_MISSING');", to: '/* sabotage */', gate: 'an ok receipt whose evidence.coreConfigHash is null makes a SYSTEM_DRAFT (B03-R11)' },
  { id: 'core-config-hash-not-compared', file: 'src/api/intelligence-core.ts', from: "if (result.evidence.coreConfigHash !== null && result.evidence.coreConfigHash !== expectedCoreConfigHash) problems.push('VALIDATION_CORE_CONFIG_HASH_MISMATCH');", to: '/* sabotage */', gate: 'a receipt naming the loader hash of another document, with effects that agree with it, makes a SYSTEM_DRAFT' },
  { id: 'effects-missing-accepted', file: 'src/api/intelligence-core.ts', from: "if ((result.ok || result.packageVerified) && result.effects === null) problems.push('VALIDATION_EFFECTS_MISSING');", to: '/* sabotage */', gate: 'a verified receipt with no effects block is not refused by name' },
  { id: 'effects-of-another-document-accepted', file: 'src/api/intelligence-core.ts', from: "if (result.effects !== null && result.evidence.coreConfigHash !== null && result.effects.configHash !== result.evidence.coreConfigHash) problems.push('VALIDATION_EFFECTS_FOR_ANOTHER_CONFIGURATION');", to: '/* sabotage */', gate: 'effects read off a run of another document than the receipt names are accepted as this configuration\'s' },
  { id: 'fragment-dropped-by-translation', file: 'src/adapter/migration-config.ts', from: 'for (const [index, field] of configuration.fields.entries()) {', to: 'for (const [index, field] of configuration.fields.slice(1).entries()) {', gate: 'toMigrationConfig leaves a field fragment out of the document Migration Core loads' },
  { id: 'effect-gap-drafts', file: 'src/api/intelligence-core.ts', from: 'if (gaps.length > 0) {', to: 'if (gaps.length < 0) {', gate: 'a fragment the receipt does not report consumed still makes a SYSTEM_DRAFT: the finalizer no longer checks candidate -> decision -> fragment -> effect' },
  { id: 'effects-carry-file-path', file: 'src/adapter/migration-effects.ts', from: 'const entry = unmapped.get(cell.columnLocatorId) ?? { fileId: cell.address.fileId, columnIndex: cell.columnIndex, cells: 0 };', to: 'const entry = unmapped.get(cell.columnLocatorId) ?? { fileId: cell.address.filePath, columnIndex: cell.columnIndex, cells: 0 };', gate: 'the effects block carries the bundle\'s file path into the receipt and the result' },
  { id: 'oracle-claims-executed-provider', file: 'src/gateway/fake-gateway.ts', from: "    name: 'oracle',\n    evidenceClass: 'SIMULATED',", to: "    name: 'oracle',\n    evidenceClass: 'EXECUTED_PROVIDER',", gate: 'a labelled fake reports EXECUTED_PROVIDER: a simulated run presents itself as live evidence' },
  { id: 'provenance-claims-executed-provider', file: 'src/api/intelligence-core.ts', from: 'gatewayEvidenceClass: deps.gateway.evidenceClass };', to: "gatewayEvidenceClass: 'EXECUTED_PROVIDER' as const };", gate: 'a result names EXECUTED_PROVIDER whatever the gateway it ran on declared' },
  { id: 'undeclared-gateway-accepted', file: 'src/api/intelligence-core.ts', from: "if (!(GATEWAY_EVIDENCE_CLASSES as readonly unknown[]).includes(gatewayEvidenceClass)) throw new IntelligenceError('CONTRACT_VIOLATION', `the model gateway declares no evidence class of ${GATEWAY_EVIDENCE_CLASSES.join(' or ')}; nothing is run through it`);", to: '/* sabotage */', gate: 'a gateway that declares no evidence class is run, and the result names none' },
];
