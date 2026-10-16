/**
 * Sabotage inventory — the B03 stage-1 integration lot: the seams where the
 * four stage-1 mandates meet (B03-KERNEL-BOUNDARY, B03-KERNEL-JOURNAL,
 * B03-ACCOUNTING, B03-CONFIG-EFFECTS). Each mutation breaks, inside the
 * merged code, one rule the closure plan states at a seam: the public
 * projection of a PREPARED request and of a result published under a state
 * recorded from outside (D3-PRIV-1), the attempt's tariff and egress key
 * bound on RUN_CREATED beside the declared identity (D3-ID-1, D3-KEY-1,
 * D3-GRANT-1), and the recovery of a stored answer before an expired run
 * ends (D3-TIME-1, D3-JRN-1). test/b03-stage-1.test.ts (and, for the key,
 * test/b03-kernel-journal.test.ts) must kill each. Same shape as core.mjs;
 * ids are unique across the directory.
 */
export const MUTATIONS = [
  // D3-PRIV-1 at BOUNDARY x JOURNAL: a prepared request is public by its digests only.
  { id: 'seam-prepared-envelope-published', file: 'src/kernel/ledger.ts', from: '    const { envelope: prepared, ...digests } = event;\n    void prepared;\n    return digests;', to: '    return event;', gate: 'every PREPARED envelope is in result.runLedger and readRun, beside the digests the public projection keeps (D3-PRIV-1)' },
  // D3-PRIV-1 at BOUNDARY x ACCOUNTING: the accounting branch's publish() still returned the raw log.
  { id: 'seam-published-cancel-raw-ledger', file: 'src/api/intelligence-core.ts', from: 'state: recorded, draft, unresolvedItems: unresolved, memoryCandidates: [], runLedger: ledger.publicExport() };', to: 'state: recorded, draft, unresolvedItems: unresolved, memoryCandidates: [], runLedger: ledger.export() as unknown as readonly PublicLedgerEvent[] };', gate: 'a result published under a state recorded from outside (a cancellation under the closing transition) carries the raw log: stored answers and prepared envelopes (D3-PRIV-1)' },
  // D3-ID-1 / D3-GRANT-1 at BOUNDARY x JOURNAL: the tariff comes with the dependencies and is bound beside the declared identity.
  { id: 'seam-tariff-unbound', file: 'src/api/intelligence-core.ts', from: '...declared, tariff: digestOf(deps.tariff) }', to: '...declared }', gate: 'a finished attempt redelivered under another tariff is answered from its stored result instead of IDENTITY_CONFLICT (D3-ID-1, D3-GRANT-1)' },
  // D3-KEY-1 at BOUNDARY x JOURNAL: the attempt key is recorded by the merged RUN_CREATED.
  { id: 'seam-attempt-key-not-recorded', file: 'src/api/intelligence-core.ts', from: 'tenant: context.tenant, egressKey: attemptKey, ', to: 'tenant: context.tenant, ', gate: 'RUN_CREATED records no egress key id, so the same attempt reopened under another key is no conflict and every request is masked and bought again (D3-KEY-1)' },
  // D3-TIME-1 x D3-JRN-1: an expired run still reconciles what a dead process left.
  { id: 'seam-expired-run-skips-recovery', file: 'src/api/intelligence-core.ts', from: '    if (opened.events > 1) {', to: '    if (opened.events > 1 && !ledger.absoluteDeadlinePassed()) {', gate: 'a run reopened after its absolute deadline ends DEADLINE_EXCEEDED with a stored answer never billed and its maximum charge still held on the grant (D3-TIME-1, D3-JRN-1, D3-GRANT-1)' },
];
