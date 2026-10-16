/**
 * Sabotage inventory — B04 integrate, the ledger lot (L3a): lock recovery only on proof of death (S10, G40-G42), the grant's
 * candidates and run count on the ledger (G60-G62), and the restart that rebuilds a pending STOP from scores.jsonl (G50). Each
 * mutation sits in the code it guards; the tests named in each gate kill it. Same shape as core.mjs; ids are unique across the
 * directory.
 */
export const MUTATIONS = [
  { id: 'b04int-lock-live-pid-recovered', file: 'tools/campaign/grant-ledger.mjs', from: "  if (!pidExists(body.pid)) return { state: 'DEAD', provedBy: 'PID_GONE', body, text };", to: "  return { state: 'DEAD', provedBy: 'PID_GONE', body, text };", gate: 'S10/G41: a lock whose process is alive on this boot is recovered: time or absence of proof stands in for death (test/b04-ledger-recovery.test.ts)' },
  { id: 'b04int-lock-foreign-host-recovered', file: 'tools/campaign/grant-ledger.mjs', from: '  if (body.hostname !== hostname()) return {', to: '  if (body.hostname === null) return {', gate: 'S10/G41: a lock taken on another host, whose process cannot be checked from here, is recovered (test/b04-ledger-recovery.test.ts)' },
  { id: 'b04int-candidate-not-granted-allowed', file: 'src/provider/campaign-grant.ts', from: 'if (!this.grant.candidates.includes(run.candidate)) return', to: 'if (this.grant.candidates.length < 0) return', gate: 'G60: a run of a candidate the grant does not fund starts (CANDIDATE_NOT_GRANTED; test/b04-qualification.test.ts, test/b04-ledger-recovery.test.ts)' },
  { id: 'b04int-run-no-reused', file: 'src/provider/campaign-grant.ts', from: 'if (runNo !== null && this.runs.some((earlier) => earlier.stage === this.stage && earlier.runNo === runNo)) return', to: 'if (runNo === -1) return', gate: 'G61: a run number already used on the ledger (a crashed run counts) is used again (RUN_NO_ALREADY_USED; test/b04-chaos.test.ts qualification shape)' },
  { id: 'b04int-max-runs-ignored', file: 'src/provider/campaign-grant.ts', from: 'if (this.grant.maxRuns !== null && this.runs.length >= this.grant.maxRuns) return', to: 'if (this.grant.maxRuns === -1) return', gate: 'G62: a grant whose runs are all spent starts another (MAX_RUNS_REACHED)' },
  { id: 'b04int-pending-stop-not-rebuilt', file: 'tools/campaign/stage-child.mjs', from: 'const pending = admission.halted() === null ? pendingStopIn(config.priorScoreJournals) : null;', to: 'const pending = null;', gate: 'G50: a violation scored and fsync\'d before a crash, whose STOP never reached the ledger, is not stopped for on restart (test/b04-campaign.test.ts RACE crash before STOP)' },
];
