/**
 * B04 L3b: the chaos layer (mandate 4.4), SIMULATED end to end. A seam over the recorded Amazon Bedrock shapes plays the fault script
 * against the campaign's funded path (grant, ledger, admission, retries, stop rule, restart) with an injected sleep and clock.
 * No provider, no network, no money; nothing here is evidence of a model's quality, and every summary says SIMULATED.
 *
 * Script: 429 with and without Retry-After, a burst of six 429s, 503, 529, 408 after the body, a reset mid-body, a credential refresh
 * failure, a refusal stop_reason, a plausible wrong answer, a served-model change, and a kill -9 of the stage child at fixture k followed
 * by a restart (lock recovery, scores.jsonl replay). Shapes: pilot (Sonnet first, two passes, stop rule) and qualification (run
 * accounting, grant arithmetic).
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const toolUrl = (name: string): string => pathToFileURL(join(root, 'tools', 'campaign', name)).href;
const SEAM = join(root, 'tools', 'campaign', 'chaos-seam.mjs');
const work = mkdtempSync(join(tmpdir(), 'b04-chaos-test-'));
after(() => { rmSync(work, { recursive: true, force: true }); });

interface Entry { candidate?: string; pass?: number; fixture: number; fault: string }
type Summary = Record<string, any>;
interface Ran { stage: string; ok: boolean; refusals: readonly { code: string; detail: string }[]; outDir: string | null; summary: Summary | null }
const runModule = (await import(toolUrl('run.mjs'))) as { runCampaign: (options: Record<string, unknown>) => Promise<Ran>; CHAOS_SHAPES: Record<string, { stages: string[]; capMicros: number; candidates: string[]; maxRuns: number | null }> };
const seamModule = (await import(pathToFileURL(SEAM).href)) as { chaosScript: (shape: string) => Entry[]; RETRY_AFTER_SECONDS: number };
const auditModule = (await import(toolUrl('ledger-audit.mjs'))) as {
  auditLedgerEvents: (events: readonly object[]) => Record<string, number>;
  auditGrantLedger: (path: string, grant: Record<string, unknown>, reported: Record<string, number>) => { equal: boolean; problems: string[]; runs: number; lockRecoveries: number; ambiguous: number; released: number; heldMicros: number; chargedMicros: number; stops: string[] };
};
const ledgerModule = (await import(toolUrl('grant-ledger.mjs'))) as { ledgerPathOf: (path: string) => string };

const rehearse = (options: Record<string, unknown>): Promise<Ran> => runModule.runCampaign({ stage: 'rehearse', seamModule: SEAM, ...options });
interface SeamEvent { readonly wrote?: boolean; readonly send?: number; readonly model?: string; readonly fault?: string; readonly candidate?: string; readonly fixtureIndex?: number; readonly wrongApplied?: boolean; readonly ms?: number }
interface LedgerLine { readonly kind: string; readonly state?: string; readonly stage?: string; readonly runNo?: number | null; readonly candidate?: string; readonly provedBy?: string }
interface ScoreLine { readonly hardGateViolations: readonly string[]; readonly correct?: boolean }
const jsonl = <T>(path: string): T[] => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as T) : []);
const SONNET = { candidate: 'SONNET_5_5_US', pass: 1 };
const grantPathOf = (outRoot: string, shape: string): string => join(outRoot, `CHAOS-REHEARSAL-grant-no-money-${shape}.json`);
const grantOf = (outRoot: string, shape: string): Record<string, unknown> => JSON.parse(readFileSync(grantPathOf(outRoot, shape), 'utf8')) as Record<string, unknown>;
/** Everything the seam recorded for a run directory: the sends it saw (with the model) and the faults it injected. */
const seamRecord = (outDir: string): { wrote: SeamEvent[]; injected: SeamEvent[]; sleeps: SeamEvent[] } => {
  const events = jsonl<SeamEvent>(join(outDir, 'chaos-events.jsonl'));
  return { wrote: events.filter((event) => event.wrote === true), injected: events.filter((event) => event.wrote !== true), sleeps: jsonl<SeamEvent>(join(outDir, 'chaos-sleeps.jsonl')) };
};
const ledgerOf = (outRoot: string, shape: string): LedgerLine[] => jsonl<LedgerLine>(ledgerModule.ledgerPathOf(grantPathOf(outRoot, shape)));

describe('B04 chaos layer: the script and the label', () => {
  it('the script names every fault of the mandate, the pilot adds the served-model change on Opus, and a shape the runner does not know is refused before anything runs', async () => {
    const pilot = seamModule.chaosScript('pilot').map((entry) => entry.fault);
    const qualification = seamModule.chaosScript('qualification').map((entry) => entry.fault);
    for (const fault of ['429-retry-after', '429', '429-burst', '503', '529', '408-after-body', 'reset-mid-body', 'credential-failure', 'refusal', 'plausible-wrong']) {
      assert.ok(pilot.includes(fault) && qualification.includes(fault), fault);
    }
    assert.equal(pilot.filter((fault) => fault === '429-burst').length, 6, 'a burst of six');
    assert.deepEqual(pilot.filter((fault) => !qualification.includes(fault)), ['served-model-change']);
    assert.equal(seamModule.RETRY_AFTER_SECONDS, 7);
    // The shapes: the pilot funds both candidates on grant A's stage, qualification Sonnet alone on grant B's, four runs at most.
    assert.deepEqual([runModule.CHAOS_SHAPES['pilot']?.stages, runModule.CHAOS_SHAPES['pilot']?.candidates], [['PILOT'], ['SONNET_5_5_US', 'OPUS_5_5_US']]);
    assert.deepEqual([runModule.CHAOS_SHAPES['qualification']?.stages, runModule.CHAOS_SHAPES['qualification']?.candidates, runModule.CHAOS_SHAPES['qualification']?.maxRuns, runModule.CHAOS_SHAPES['qualification']?.capMicros], [['QUALIFICATION'], ['SONNET_5_5_US'], 4, 120_000_000]);
    const unknown = await rehearse({ shape: 'smoke', outRoot: join(work, 'unknown-shape') });
    assert.deepEqual(unknown.refusals.map((refusal) => refusal.code), ['UNKNOWN_SHAPE']);
    assert.equal(unknown.outDir, null);
  });

  it('the AWS reads are skipped only over a seam: a funded stage without one, and a command line that names a seam outside the rehearse stage, still need their grant', async () => {
    const noSeam = await runModule.runCampaign({ stage: 'pilot', simulatedPreflight: true, grantPath: null, outRoot: join(work, 'no-seam') });
    assert.ok(noSeam.refusals.some((refusal) => refusal.code === 'SIMULATED_PREFLIGHT_NEEDS_SEAM'), JSON.stringify(noSeam.refusals));
    assert.equal(noSeam.outDir, null);
    const cli = spawnSync(process.execPath, [join(root, 'tools', 'campaign', 'run.mjs'), '--stage', 'pilot', '--seam', SEAM, '--out', join(work, 'cli-pilot')], { encoding: 'utf8' });
    assert.equal(cli.status, 2, cli.stderr);
    assert.match(cli.stderr, /REFUSED NO_GRANT/u, 'the seam named outside the rehearse stage is ignored: the funded stage asks for its grant');
    assert.equal(existsSync(join(work, 'cli-pilot')), false);
  });

  it('the command line runs the rehearsal as the mandate says and prints a summary labelled SIMULATED, never qualification', { timeout: 600_000 }, () => {
    const out = join(work, 'cli-rehearse');
    const cli = spawnSync(process.execPath, [join(root, 'tools', 'campaign', 'run.mjs'), '--stage', 'rehearse', '--seam', SEAM, '--shape', 'qualification', '--limit', '2', '--run', '1', '--out', out], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(cli.status, 0, cli.stderr);
    const printed = JSON.parse(cli.stdout) as { stage: string; ok: boolean; summary: Summary };
    assert.equal(printed.stage, 'qualify');
    assert.equal(printed.summary['evidence'], 'SIMULATED');
    assert.match(String(printed.summary['rehearsal'].label), /^SIMULATED/u);
    assert.equal(printed.summary['rehearsal'].countsAsQualification, false);
    assert.equal(printed.summary['rehearsal'].ledgerAudit.equal, true);
  });
});

describe('B04 chaos layer: pilot shape (Sonnet first, two passes, stop rule), SIMULATED', () => {
  const outRoot = join(work, 'pilot');
  // The script of the mandate that leaves the grant usable: documented throttling, a credential failure, a refusal, a plausible wrong answer, and the served-model change on Opus.
  const script: Entry[] = [
    { ...SONNET, fixture: 0, fault: '429-retry-after' }, { ...SONNET, fixture: 1, fault: '429' },
    ...Array.from({ length: 6 }, () => ({ ...SONNET, fixture: 2, fault: '429-burst' })),
    { ...SONNET, fixture: 4, fault: 'credential-failure' }, { ...SONNET, fixture: 5, fault: 'refusal' }, { ...SONNET, fixture: 6, fault: 'plausible-wrong' },
    { candidate: 'OPUS_5_5_US', pass: 1, fixture: 2, fault: 'served-model-change' },
  ];
  const options = { shape: 'pilot', limit: 8, outRoot, seamOptions: { script, killAtFixture: 3 } };
  let killed: Ran;
  let restarted: Ran;

  it('kill -9 of the stage child at fixture 3 leaves its lock and its scores; the restart recovers the lock on proof of death and replays scores.jsonl before any hold', { timeout: 900_000 }, async () => {
    killed = await rehearse(options);
    assert.equal(killed.ok, false);
    assert.equal(killed.summary, null, 'a killed stage writes no summary');
    assert.deepEqual(killed.refusals.map((refusal) => refusal.code), ['STAGE_FAILED']);
    assert.ok(killed.outDir !== null);
    assert.equal(existsSync(join(outRoot, 'pilot', 'chaos-killed.marker')), true, 'the seam killed the process once');
    const journal = jsonl<ScoreLine>(join(killed.outDir, 'scores.jsonl'));
    assert.equal(journal.length, 3, 'the three fixtures scored before the kill are on disk, one fsync\'d line each');
    assert.ok(journal.every((line) => line.hardGateViolations.length === 0));
    const ledgerPath = ledgerModule.ledgerPathOf(grantPathOf(outRoot, 'pilot'));
    assert.equal(existsSync(`${ledgerPath}.lock`), true, 'the killed stage left its lock: nobody deletes it');
    assert.equal(ledgerOf(outRoot, 'pilot').filter((event) => event.kind === 'STOP').length, 0);

    restarted = await rehearse(options);
    assert.deepEqual(restarted.refusals, []);
    assert.ok(restarted.summary !== null && restarted.outDir !== null);
    const recovered = ledgerOf(outRoot, 'pilot').filter((event) => event.kind === 'LOCK_RECOVERED');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.provedBy, 'PID_GONE', 'time never proves death: the pid is gone');
    assert.equal(existsSync(`${ledgerPath}.lock`), false, 'the restart released its own lock');
  });

  it('the summary is labelled SIMULATED and asserts that the ledger totals equal the sum of its settlements, across the killed run and the restart', () => {
    const summary = restarted.summary as Summary;
    assert.equal(summary['evidence'], 'SIMULATED');
    assert.match(String(summary['rehearsal'].label), /^SIMULATED/u);
    assert.equal(summary['rehearsal'].countsAsQualification, false);
    for (const candidate of Object.values(summary['candidates']) as { evidence: string }[]) assert.equal(candidate.evidence, 'SIMULATED');
    const audit = summary['rehearsal'].ledgerAudit;
    assert.equal(audit.equal, true, JSON.stringify(audit.problems));
    assert.deepEqual([audit.summaryChargedMicros, audit.summaryHeldMicros, audit.summaryLiabilityMicros], [audit.chargedMicros, audit.heldMicros, audit.liabilityMicros]);
    assert.equal(audit.settledMicros, audit.chargedMicros + audit.liabilityMicros);
    assert.equal(audit.liabilityMicros, 0);
    assert.ok(audit.chargedMicros > 0, 'something was charged: the sum is not trivially zero');
    // The independent reading agrees with the summary's own totals and with the ledger file as it stands after the run.
    const again = auditModule.auditGrantLedger(ledgerModule.ledgerPathOf(grantPathOf(outRoot, 'pilot')), grantOf(outRoot, 'pilot'), summary as Record<string, number>);
    assert.equal(again.equal, true, JSON.stringify(again.problems));
    assert.equal(again.lockRecoveries, 1);
    assert.equal(summary['grantChargedMicros'], again.chargedMicros);
    // Four runs began on the ledger: the killed one, Sonnet's two passes and Opus's first (a crashed run still counts).
    assert.equal(again.runs, 4);
  });

  it('Sonnet is measured first and completes both passes; the served-model change stops Opus and the stage, and Sonnet\'s measurement stays', () => {
    const summary = restarted.summary as Summary;
    const outDir = restarted.outDir as string;
    const order = seamRecord(outDir).wrote.map((event) => event.model);
    const firstOpus = order.indexOf('claude-opus-5-5');
    assert.ok(firstOpus > 0, 'Opus was measured after Sonnet');
    assert.ok(order.slice(0, firstOpus).every((model) => model === 'claude-sonnet-5-5') && order.slice(firstOpus).every((model) => model === 'claude-opus-5-5'));
    const sonnet = summary['candidates'].SONNET_5_5_US;
    const opus = summary['candidates'].OPUS_5_5_US;
    assert.equal(sonnet.complete, true);
    assert.equal(sonnet.runs.length, 2, 'two passes');
    assert.equal(opus.complete, false);
    assert.equal(opus.stopped, 'SERVED_MODEL_CHANGE');
    assert.deepEqual(opus.subjectBroken, ['WRONG_MODEL']);
    assert.equal(summary['stopped'], 'SERVED_MODEL_CHANGE');
    assert.ok(existsSync(join(outDir, 'SONNET_5_5_US', 'pass-2', 'report.json')), 'Sonnet\'s measured pass is on disk');
    assert.deepEqual(auditModule.auditGrantLedger(ledgerModule.ledgerPathOf(grantPathOf(outRoot, 'pilot')), grantOf(outRoot, 'pilot'), summary as Record<string, number>).stops, ['SERVED_MODEL_CHANGE']);
  });

  it('every scripted fault was played: Retry-After is waited for on the injected sleep, a burst of six is six 429s, a credential failure sends nothing, and the plausible wrong answer is scored wrong without a hard gate', () => {
    const outDir = restarted.outDir as string;
    const { wrote, injected, sleeps } = seamRecord(outDir);
    const count = (fault: string): number => injected.filter((event) => event.fault === fault).length;
    assert.deepEqual(['429-retry-after', '429', '429-burst', 'credential-failure', 'refusal', 'plausible-wrong', 'served-model-change'].map(count), [1, 1, 6, 1, 1, 1, 1]);
    assert.deepEqual((restarted.summary as Summary)['rehearsal'].seam.notReached, [], 'the whole script was reached');
    // The restart replays the script from the start, as its seam is a new process; the first invocation's events are in its own run directory.
    const before = seamRecord(killed.outDir as string);
    assert.ok(before.injected.some((event) => event.fault === '429-retry-after') && before.injected.some((event) => event.fault === 'kill-9'));
    // Retry-After: 7 s is waited at least, on the injected sleep (virtual time; the test took no 7 s).
    const waited = sleeps.filter((sleep) => sleep.fixtureIndex === 0 && sleep.candidate === 'SONNET_5_5_US').map((sleep) => sleep.ms ?? 0);
    assert.ok(waited.some((ms) => ms >= seamModule.RETRY_AFTER_SECONDS * 1000), JSON.stringify(waited));
    // A 429 with no Retry-After is backed off by the core's own schedule (2 s, jittered), never zero.
    const backoff = sleeps.filter((sleep) => sleep.fixtureIndex === 1 && sleep.candidate === 'SONNET_5_5_US').map((sleep) => sleep.ms ?? 0);
    assert.ok(backoff.length > 0 && backoff.every((ms) => ms >= 2000 && ms < 7000), JSON.stringify(backoff));
    // The credential failure is a send that never left: its ordinal has a fault line and no written request.
    const failedSend = injected.find((event) => event.fault === 'credential-failure');
    assert.ok(failedSend !== undefined && !wrote.some((event) => event.send === failedSend.send), 'nothing was written for the failed credential');
    // The plausible wrong answer was applied to a real column and scored wrong, with no hard gate and no stop of its own.
    const wrong = injected.find((event) => event.fault === 'plausible-wrong');
    assert.equal(wrong?.wrongApplied, true);
    const scores = JSON.parse(readFileSync(join(outDir, 'SONNET_5_5_US', 'pass-1', 'scores.json'), 'utf8')) as ScoreLine[];
    assert.ok(scores.every((score) => score.hardGateViolations.length === 0), 'none of these faults is a hard gate');
    assert.ok(scores[wrong?.fixtureIndex ?? -1]?.correct !== true, 'the plausible wrong answer is not scored correct');
  });

  it('the throttled holds are RELEASED (documented non-acceptance), none is left AMBIGUOUS, and the ledger the stage left is read back whole by the independent audit', () => {
    const events = ledgerOf(outRoot, 'pilot');
    const released = events.filter((event) => event.kind === 'SETTLE' && event.state === 'RELEASED');
    assert.ok(released.length >= 9, `the 429s of both invocations and the failed credential were released: ${String(released.length)}`);
    assert.equal(events.filter((event) => event.kind === 'SETTLE' && event.state === 'AMBIGUOUS').length, 0);
    const audit = auditModule.auditLedgerEvents(events.filter((event) => event.kind !== 'GRANT'));
    assert.equal(audit['ambiguous'], 0);
    assert.equal(audit['heldMicros'], 0);
  });
});

describe('B04 chaos layer: qualification shape (run accounting, grant arithmetic), SIMULATED', () => {
  const outRoot = join(work, 'qualification');
  // The qualification script is the pilot's without the Opus change: documented throttling, a credential failure, a refusal, a plausible wrong answer.
  const script: Entry[] = [
    { ...SONNET, fixture: 0, fault: '429-retry-after' }, { ...SONNET, fixture: 1, fault: '429' },
    { ...SONNET, fixture: 3, fault: 'credential-failure' }, { ...SONNET, fixture: 4, fault: 'refusal' }, { ...SONNET, fixture: 5, fault: 'plausible-wrong' },
  ];
  const options = { shape: 'qualification', limit: 8, outRoot, seamOptions: { script, killAtFixture: 3 } };
  const runs: Ran[] = [];

  it('a run killed at fixture 3 still counts: its number cannot be used again, the next number runs, and three runs are on the ledger of a grant that allows four', { timeout: 900_000 }, async () => {
    const first = await rehearse({ ...options, runNo: 1 });
    assert.deepEqual(first.refusals.map((refusal) => refusal.code), ['STAGE_FAILED']);
    assert.equal(first.summary, null);
    // The restart under the same number is refused by the ledger, after the dead lock was recovered; the refused start writes no run.
    const again = await rehearse({ ...options, runNo: 1 });
    assert.deepEqual(again.refusals.map((refusal) => refusal.code), ['RUN_NOT_STARTED']);
    assert.match(again.refusals[0]?.detail ?? '', /RUN_NO_ALREADY_USED/u);
    assert.equal(ledgerOf(outRoot, 'qualification').filter((event) => event.kind === 'LOCK_RECOVERED').length, 1);
    assert.equal(ledgerOf(outRoot, 'qualification').filter((event) => event.kind === 'RUN').length, 1, 'one run is on the ledger: the killed one');
    runs.push(await rehearse({ ...options, runNo: 2 }), await rehearse({ ...options, runNo: 3 }));
    for (const ran of runs) {
      assert.deepEqual(ran.refusals, []);
      assert.equal((ran.summary as Summary)['complete'], true);
      assert.equal((ran.summary as Summary)['evidence'], 'SIMULATED');
    }
    const events = ledgerOf(outRoot, 'qualification');
    assert.deepEqual(events.filter((event) => event.kind === 'RUN').map((event) => [event.stage, event.runNo, event.candidate]), [['QUALIFICATION', 1, 'SONNET_5_5_US'], ['QUALIFICATION', 2, 'SONNET_5_5_US'], ['QUALIFICATION', 3, 'SONNET_5_5_US']]);
    assert.deepEqual(events.filter((event) => event.kind === 'STOP'), []);
  });

  it('each completed run reads SIMULATED all the way down and asserts the ledger totals equal the sum of its settlements; the totals only grow across runs', () => {
    let before = 0;
    for (const ran of runs) {
      const summary = ran.summary as Summary;
      const audit = summary['rehearsal'].ledgerAudit;
      assert.equal(audit.equal, true, JSON.stringify(audit.problems));
      assert.ok(summary['grantChargedMicros'] > before, 'each run charged the grant further');
      before = summary['grantChargedMicros'];
      const run = JSON.parse(readFileSync(join(ran.outDir as string, 'run.json'), 'utf8')) as { evidence: string; reportMode: string; candidate: string };
      assert.deepEqual([run.evidence, run.candidate], ['SIMULATED', 'SONNET_5_5_US']);
      const record = JSON.parse(readFileSync(join(ran.outDir as string, 'run-record.json'), 'utf8')) as { evidence: string };
      assert.equal(record.evidence, 'SIMULATED', 'a rehearsal run record is never EXECUTED_PROVIDER');
      const sent = seamRecord(ran.outDir as string).wrote;
      assert.ok(sent.length > 0 && sent.every((event) => event.model === 'claude-sonnet-5-5'), 'Sonnet alone is called under grant B');
    }
    assert.equal((runs[1]?.summary as Summary)['rehearsal'].ledgerAudit.runs, 3);
  });

  it('the grant arithmetic is the full stage\'s: per-fixture x 600 x 1.15 against the 120 USD cap and four runs, whatever the limit the rehearsal ran with', () => {
    const arithmetic = (runs[0]?.summary as Summary)['rehearsal'].grantArithmetic;
    assert.equal(arithmetic.capMicros, 120_000_000);
    assert.equal(arithmetic.maxRuns, 4);
    assert.equal(arithmetic.stageFixtures, 600, 'the FINAL partition, not the limited selection');
    assert.ok(Number.isSafeInteger(arithmetic.perFixtureMicros) && arithmetic.perFixtureMicros > 0);
    assert.equal(arithmetic.projectedFullRunMicros, Math.ceil((arithmetic.perFixtureMicros * 600 * 115) / 100));
    assert.equal(arithmetic.fullRunsThatFitFresh, Math.floor(120_000_000 / arithmetic.projectedFullRunMicros));
  });

  it('a run whose projected cost does not fit the notional cap does not start: no request is sent and nothing is held', async () => {
    const small = join(work, 'qualification-small');
    const refused = await rehearse({ shape: 'qualification', limit: 8, outRoot: small, runNo: 1, capMicros: 100_000, seamOptions: { script } });
    assert.deepEqual(refused.refusals.map((refusal) => refusal.code), ['RUN_NOT_STARTED']);
    assert.match(refused.refusals[0]?.detail ?? '', /PROJECTED_COST_DOES_NOT_FIT/u);
    assert.ok(refused.outDir !== null);
    assert.equal(seamRecord(refused.outDir).wrote.length, 0, 'no request left');
    assert.deepEqual(ledgerOf(small, 'qualification').filter((event) => event.kind === 'HOLD' || event.kind === 'RUN'), []);
  });
});

describe('B04 chaos layer: failures that leave the billing unknown (503, 529, 408 after the body, reset mid-body), SIMULATED', () => {
  const episode = async (fault: string, suffix = ''): Promise<{ ran: Ran; seen: ReturnType<typeof seamRecord>; audit: ReturnType<typeof auditModule.auditGrantLedger> }> => {
    const outRoot = join(work, `unknown-${fault}${suffix}`);
    const ran = await rehearse({ shape: 'pilot', limit: 3, outRoot, seamOptions: { script: [{ ...SONNET, fixture: 0, fault }] } });
    assert.ok(ran.summary !== null && ran.outDir !== null, JSON.stringify(ran.refusals));
    const audit = auditModule.auditGrantLedger(ledgerModule.ledgerPathOf(grantPathOf(outRoot, 'pilot')), grantOf(outRoot, 'pilot'), ran.summary);
    return { ran, seen: seamRecord(ran.outDir), audit };
  };

  for (const fault of ['408-after-body', 'reset-mid-body']) {
    it(`${fault}: the request is never sent again, its hold stays AMBIGUOUS at the maximum charge (billing unknown), and the ledger totals equal its settlements`, { timeout: 600_000 }, async () => {
      const { seen, audit } = await episode(fault);
      assert.equal(seen.injected.filter((event) => event.fault === fault).length, 1);
      assert.equal(seen.sleeps.filter((sleep) => sleep.fixtureIndex === 0 && sleep.candidate === 'SONNET_5_5_US').length, 0, 'no retry backoff: an ambiguous send is not repeated');
      assert.ok(audit.ambiguous >= 1 && audit.heldMicros > 0, `the hold is kept: ${JSON.stringify(audit)}`);
      assert.equal(audit.equal, true, JSON.stringify(audit.problems));
    });
  }

  for (const fault of ['503', '529']) {
    it(`${fault}: the request is retried after the core's backoff, the failed attempt's hold is kept (no usage is no proof of non-billing), and the ledger totals equal its settlements`, { timeout: 600_000 }, async () => {
      const { seen, audit } = await episode(fault);
      assert.equal(seen.injected.filter((event) => event.fault === fault).length, 1);
      const waited = seen.sleeps.filter((sleep) => sleep.fixtureIndex === 0 && sleep.candidate === 'SONNET_5_5_US').map((sleep) => sleep.ms ?? 0);
      assert.ok(waited.length > 0 && waited.every((ms) => ms >= 2000), JSON.stringify(waited));
      assert.ok(audit.ambiguous >= 1 && audit.heldMicros > 0, `the hold is kept: ${JSON.stringify(audit)}`);
      assert.equal(audit.equal, true, JSON.stringify(audit.problems));
    });
  }

  // D4-CHAOS-1 (coordinator ruling on the chaos finding): an attempt whose billing is unknown keeps the reservation's maximum on the
  // grant ledger (money safety unchanged), but the scorer's budget ceiling reads observed output only, so the unknown-billing request
  // is a transport failure and never a ceiling violation; and the stage stops durably only on a member of HARD_GATES.
  it('D4-CHAOS-1: a transient 503 that was retried and answered does not stop the stage or the grant, while its unknown-billing hold stays at the maximum', { timeout: 600_000 }, async () => {
    const { ran, audit } = await episode('503', '-finding');
    assert.equal((ran.summary as Summary)['stopped'], null, 'the stage went on');
    assert.deepEqual(ledgerOf(join(work, 'unknown-503-finding'), 'pilot').filter((event) => event.kind === 'STOP'), [], 'no durable stop');
    assert.ok(audit.ambiguous >= 1 && audit.heldMicros > 0, `the hold is kept: ${JSON.stringify(audit)}`);
    assert.equal(audit.equal, true, JSON.stringify(audit.problems));
    const scores = jsonl<ScoreLine>(join(ran.outDir ?? '', 'scores.jsonl'));
    assert.ok(scores.length > 0);
    assert.ok(scores.every((score) => !score.hardGateViolations.includes('budget_ceiling_exceeded')), JSON.stringify(scores.map((score) => score.hardGateViolations)));
  });
});

describe('B04 chaos layer: the stop rule is HARD_GATES only (D4-CHAOS-1), SIMULATED', () => {
  const planted = async (name: string, violation: string): Promise<{ ran: Ran; stops: LedgerLine[] }> => {
    const outRoot = join(work, `stop-rule-${name}`);
    const ran = await rehearse({ shape: 'pilot', limit: 3, outRoot, seamOptions: { script: [], violationAtFirstScore: violation } });
    assert.ok(ran.summary !== null && ran.outDir !== null, JSON.stringify(ran.refusals));
    return { ran, stops: ledgerOf(outRoot, 'pilot').filter((event) => event.kind === 'STOP') };
  };

  it('a violation outside HARD_GATES (budget_ceiling_exceeded) on a scored fixture is reported but does not stop the stage or the grant', { timeout: 600_000 }, async () => {
    const { ran, stops } = await planted('other', 'budget_ceiling_exceeded');
    assert.equal((ran.summary as Summary)['stopped'], null);
    assert.deepEqual(stops, []);
    const scores = jsonl<ScoreLine>(join(ran.outDir ?? '', 'scores.jsonl'));
    assert.equal(scores.filter((score) => score.hardGateViolations.includes('budget_ceiling_exceeded')).length, 1, 'the violation is still on the score');
  });

  it('a registered hard gate (secret_or_forbidden_data_egress) on a scored fixture still stops the stage, durably on the grant ledger', { timeout: 600_000 }, async () => {
    const { ran, stops } = await planted('gate', 'secret_or_forbidden_data_egress');
    assert.equal((ran.summary as Summary)['stopped'], 'HARD_GATE_VIOLATION');
    assert.deepEqual(stops.map((stop) => (stop as unknown as Record<string, unknown>)['reason']), ['HARD_GATE_VIOLATION']);
  });
});

describe('B04 chaos layer: the independent ledger audit', () => {
  const hold = (n: number, max: number): Record<string, unknown> => ({ kind: 'HOLD', runId: 'r', reservationId: `res_${String(n)}`, maxChargeMicros: max });
  const settle = (n: number, state: string, charge: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ kind: 'SETTLE', runId: 'r', reservationId: `res_${String(n)}`, state, chargeMicros: charge, ...extra });

  it('sums committed charges up to their holds, keeps open and ambiguous holds as held, reads a death between hold and settlement as ambiguous, and puts a charge above its hold as liability', () => {
    const events = [hold(1, 100), settle(1, 'COMMITTED', 60), hold(2, 100), settle(2, 'RELEASED', 0), hold(3, 100), settle(3, 'AMBIGUOUS', 100), hold(4, 100), hold(5, 50), settle(5, 'COMMITTED', 80), hold(6, 70), { kind: 'DROP', runId: 'r', reservationId: 'res_6' }];
    assert.deepEqual(auditModule.auditLedgerEvents(events), { reservations: 5, committed: 2, released: 1, ambiguous: 2, settledMicros: 140, chargedMicros: 110, liabilityMicros: 30, heldMicros: 200 });
    // An ambiguous hold reconciled to a charge, and one released on proof, leave the held sum.
    const reconciled = [...events, settle(3, 'COMMITTED', 40), settle(4, 'RELEASED', 0, { reconciled: true, reason: 'documented', requestKey: 'k' })];
    assert.deepEqual(auditModule.auditLedgerEvents(reconciled), { reservations: 5, committed: 3, released: 2, ambiguous: 0, settledMicros: 180, chargedMicros: 150, liabilityMicros: 30, heldMicros: 0 });
  });

  it('a summary that says other totals than the settlements sum to is found, whichever total it misreports', async () => {
    const path = join(work, 'audit.ledger.jsonl');
    const grant = { grantId: 'g', stages: ['PILOT'], capMicros: 1_000, expiresAt: '2027-01-01T00:00:00Z', approvalRef: 'x', candidates: ['SONNET_5_5_US'], maxRuns: null };
    // The ledger binds to the whole grant: the digest is the one the ledger tool computes.
    const ledger = (await import(toolUrl('grant-ledger.mjs'))) as { grantDigestOf: (grant: Record<string, unknown>) => string };
    const lines = [{ kind: 'GRANT', grantId: 'g', grantDigest: ledger.grantDigestOf(grant) }, hold(1, 100), settle(1, 'COMMITTED', 60), hold(2, 100)];
    writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
    const right = { grantChargedMicros: 60, grantHeldMicros: 100, grantLiabilityMicros: 0 };
    assert.equal(auditModule.auditGrantLedger(path, grant, right).equal, true);
    for (const [member, wrong, word] of [['grantChargedMicros', 61, 'charged'], ['grantHeldMicros', 0, 'held'], ['grantLiabilityMicros', 1, 'liability']] as const) {
      const audit = auditModule.auditGrantLedger(path, grant, { ...right, [member]: wrong });
      assert.equal(audit.equal, false, member);
      assert.ok(audit.problems.some((problem) => problem.startsWith(word)), member + ': ' + JSON.stringify(audit.problems));
    }
  });
});
