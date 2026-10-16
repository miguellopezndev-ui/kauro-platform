// The independent reading of a grant's ledger (B04 L3b): what the ledger's own lines add up to, computed from the events alone and
// by a replay that shares no code with CampaignAdmission, so a summary's totals can be held against it. A rehearsal summary is
// accepted only when the totals the admission reports equal what the settlements in the ledger sum to.
//   charged   the sum, over reservations, of what a COMMITTED settlement consumed of its reservation (its charge, up to the hold)
//   liability what a COMMITTED settlement charged above its hold (never netted)
//   held      the sum of the maximum charge of every reservation still HELD or AMBIGUOUS (a crash or an unknown billing keeps it)
// The ledger is read as the admission reads it: a hold whose invocation died with no settlement is AMBIGUOUS, never released by time.
import { readGrantLedger } from './grant-ledger.mjs';

const keyOf = (event) => JSON.stringify([event.runId, event.reservationId]);

/** @param {readonly Record<string, any>[]} events the ledger's events after its GRANT line */
export function auditLedgerEvents(events) {
  const holds = new Map();
  for (const event of events) {
    if (event.kind === 'HOLD') holds.set(keyOf(event), { max: event.maxChargeMicros, state: 'HELD', charge: null });
    else if (event.kind === 'DROP') { if (holds.get(keyOf(event))?.state === 'HELD') holds.delete(keyOf(event)); }
    else if (event.kind === 'SETTLE') {
      const hold = holds.get(keyOf(event));
      if (hold === undefined) {
        // A settlement for a reservation this grant never admitted stands at the amount it names; a release is nothing.
        if (event.state !== 'RELEASED') holds.set(keyOf(event), { max: event.chargeMicros, state: event.state === 'COMMITTED' ? 'COMMITTED' : 'AMBIGUOUS', charge: event.state === 'COMMITTED' ? event.chargeMicros : null });
      } else if (hold.state === 'HELD' || (hold.state === 'AMBIGUOUS' && (event.state === 'COMMITTED' || (event.state === 'RELEASED' && event.reconciled === true)))) {
        hold.state = event.state;
        hold.charge = event.state === 'COMMITTED' ? event.chargeMicros : event.state === 'RELEASED' ? 0 : null;
      }
    }
  }
  let chargedMicros = 0;
  let liabilityMicros = 0;
  let heldMicros = 0;
  let settledMicros = 0;
  const count = { COMMITTED: 0, RELEASED: 0, AMBIGUOUS: 0, HELD: 0 };
  for (const hold of holds.values()) {
    // A hold the replay finds still HELD had its invocation die with it: the admission reads it as AMBIGUOUS.
    const state = hold.state === 'HELD' ? 'AMBIGUOUS' : hold.state;
    count[state] += 1;
    if (state === 'AMBIGUOUS') heldMicros += hold.max;
    if (state === 'COMMITTED') { settledMicros += hold.charge; chargedMicros += Math.min(hold.charge, hold.max); liabilityMicros += Math.max(0, hold.charge - hold.max); }
  }
  return { reservations: holds.size, committed: count.COMMITTED, released: count.RELEASED, ambiguous: count.AMBIGUOUS, settledMicros, chargedMicros, liabilityMicros, heldMicros };
}

/**
 * The ledger of `grant` at `ledgerPath` held against the totals a summary reports. `equal` is true only when the grant's charged,
 * held and liability totals are exactly what the ledger's settlements sum to.
 */
export function auditGrantLedger(ledgerPath, grant, reported) {
  const { events } = readGrantLedger(ledgerPath, grant);
  const sums = auditLedgerEvents(events);
  const problems = [];
  if (sums.chargedMicros !== reported.grantChargedMicros) problems.push(`charged: the summary says ${String(reported.grantChargedMicros)}, the settlements sum to ${String(sums.chargedMicros)}`);
  if (sums.heldMicros !== reported.grantHeldMicros) problems.push(`held: the summary says ${String(reported.grantHeldMicros)}, the open holds sum to ${String(sums.heldMicros)}`);
  if (sums.liabilityMicros !== reported.grantLiabilityMicros) problems.push(`liability: the summary says ${String(reported.grantLiabilityMicros)}, the settlements put ${String(sums.liabilityMicros)} above their holds`);
  if (sums.chargedMicros + sums.liabilityMicros !== sums.settledMicros) problems.push(`settled: ${String(sums.settledMicros)} is not charged ${String(sums.chargedMicros)} plus liability ${String(sums.liabilityMicros)}`);
  return { ...sums, summaryChargedMicros: reported.grantChargedMicros, summaryHeldMicros: reported.grantHeldMicros, summaryLiabilityMicros: reported.grantLiabilityMicros, lockRecoveries: events.filter((event) => event.kind === 'LOCK_RECOVERED').length, runs: events.filter((event) => event.kind === 'RUN').length, stops: events.filter((event) => event.kind === 'STOP').map((event) => event.reason), equal: problems.length === 0, problems };
}
