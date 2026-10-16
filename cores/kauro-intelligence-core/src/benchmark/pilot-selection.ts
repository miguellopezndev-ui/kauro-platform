/**
 * The pilot selection (B04-design D4-CAMP-1): lexicographic over the admitted candidates the pilot ran under one grant.
 * Eligibility first, then zero critical (a complete run, no stop, no hard-gate violation, no scorer failure), then the quality
 * thresholds, then cost per accepted plan, then median latency; the profile id breaks an exact tie so the record is deterministic.
 * Every candidate appears in the ranking with the reason it stands where it does. The record never changes the pinned policy:
 * when the selected model is not the one the pinned policy names, `requiresPolicyBump` says the release must change it first.
 */
export interface PilotCandidateResult {
  readonly profileId: string;
  readonly modelId: string;
  /** Admission of the profile (D4-POL-3), taken before any cost. */
  readonly admitted: boolean;
  readonly complete: boolean;
  readonly stopped: string | null;
  readonly hardGateViolations: number;
  readonly scorerFailures: number;
  /** The supported and abstention thresholds held on every pass of the pilot (QUALITY_THRESHOLDS). */
  readonly supportedPass: boolean;
  readonly abstentionPass: boolean;
  /** Fixtures the candidate answered correctly, over all passes. */
  readonly accepted: number;
  readonly chargedMicros: number;
  readonly p50LatencyMs: number;
}

export type PilotRankStatus = 'SELECTED' | 'RANKED_LOWER' | 'ELIMINATED_INELIGIBLE' | 'ELIMINATED_CRITICAL' | 'ELIMINATED_THRESHOLDS' | 'ELIMINATED_NO_ACCEPTED_PLAN';

export interface PilotRankRow {
  readonly profileId: string;
  readonly modelId: string;
  readonly status: PilotRankStatus;
  readonly reasons: readonly string[];
  readonly costPerAcceptedMicros: number | null;
  readonly p50LatencyMs: number;
}

export interface PilotSelection {
  readonly rule: 'ELIGIBILITY, ZERO_CRITICAL, THRESHOLDS, COST_PER_ACCEPTED_PLAN, LATENCY';
  readonly selected: string | null;
  readonly selectedModel: string | null;
  readonly pinnedModel: string;
  readonly requiresPolicyBump: boolean;
  readonly ranking: readonly PilotRankRow[];
}

export function selectFromPilot(results: readonly PilotCandidateResult[], pinnedModel: string): PilotSelection {
  const eliminated: PilotRankRow[] = [];
  const survivors: PilotRankRow[] = [];
  for (const one of results) {
    const cost = one.accepted > 0 ? Math.ceil(one.chargedMicros / one.accepted) : null;
    const row = (status: PilotRankStatus, reasons: readonly string[]): PilotRankRow => ({ profileId: one.profileId, modelId: one.modelId, status, reasons, costPerAcceptedMicros: cost, p50LatencyMs: one.p50LatencyMs });
    if (!one.admitted) { eliminated.push(row('ELIMINATED_INELIGIBLE', ['admission refused the profile'])); continue; }
    const critical: string[] = [];
    if (!one.complete) critical.push('the run is not complete');
    if (one.stopped !== null) critical.push(`stopped: ${one.stopped}`);
    if (one.hardGateViolations > 0) critical.push(`${String(one.hardGateViolations)} hard-gate violation(s)`);
    if (one.scorerFailures > 0) critical.push(`${String(one.scorerFailures)} scorer failure(s)`);
    if (critical.length > 0) { eliminated.push(row('ELIMINATED_CRITICAL', critical)); continue; }
    const below: string[] = [];
    if (!one.supportedPass) below.push('supported correctness below its threshold');
    if (!one.abstentionPass) below.push('abstention correctness below its threshold');
    if (below.length > 0) { eliminated.push(row('ELIMINATED_THRESHOLDS', below)); continue; }
    if (cost === null) { eliminated.push(row('ELIMINATED_NO_ACCEPTED_PLAN', ['no accepted plan: a cost per accepted plan does not exist'])); continue; }
    survivors.push(row('RANKED_LOWER', ['higher cost per accepted plan, or equal and slower']));
  }
  survivors.sort((a, b) => (a.costPerAcceptedMicros as number) - (b.costPerAcceptedMicros as number) || a.p50LatencyMs - b.p50LatencyMs || (a.profileId < b.profileId ? -1 : 1));
  const ranked = survivors.map((entry, index): PilotRankRow => (index === 0 ? { ...entry, status: 'SELECTED', reasons: ['lowest cost per accepted plan among the eligible, clean, threshold-meeting candidates'] } : entry));
  const winner = ranked[0] ?? null;
  return { rule: 'ELIGIBILITY, ZERO_CRITICAL, THRESHOLDS, COST_PER_ACCEPTED_PLAN, LATENCY', selected: winner?.profileId ?? null, selectedModel: winner?.modelId ?? null, pinnedModel, requiresPolicyBump: winner !== null && winner.modelId !== pinnedModel, ranking: [...ranked, ...eliminated] };
}
