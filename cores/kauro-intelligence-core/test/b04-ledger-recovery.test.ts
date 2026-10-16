import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import type { CampaignGrant } from '../src/provider/campaign-grant.js';

/**
 * B04 S10 (L3a): a grant ledger's lock left by a crashed holder is recovered only on proof of death (same host, and the boot id
 * differs or the pid is gone), with LOCK_RECOVERED written; everything else refuses as before. SIMULATED: files in a temp
 * directory, no network, no provider.
 */
interface Held { events: readonly { kind: string; [member: string]: unknown }[]; append: (event: unknown) => void; close: () => void }
interface Hooks { afterProof?: (lock: unknown) => void }
interface Lib {
  ledgerPathOf: (grantPath: string) => string;
  openGrantLedger: (path: string, grant: CampaignGrant, hooks?: Hooks) => Held;
  inspectGrantLedger: (path: string, grant: CampaignGrant) => { code: string; detail: string } | null;
  currentBootId: () => string | null;
}
const root = join(import.meta.dirname, '..', '..');
const lib = (await import(pathToFileURL(join(root, 'tools', 'campaign', 'grant-ledger.mjs')).href)) as Lib;
const grant: CampaignGrant = { grantId: 'grant-S10', stages: ['SMOKE', 'PILOT'], capMicros: 1_000, expiresAt: '2999-01-01T00:00:00.000Z', approvalRef: 'owner-approval-SIMULATED', candidates: ['SONNET_5_5_US'], maxRuns: null };
const dir = mkdtempSync(join(tmpdir(), 'b04-recovery-'));
after(() => { rmSync(dir, { recursive: true, force: true }); });

let counter = 0;
const freshPath = (): string => lib.ledgerPathOf(join(dir, `grant-${String(++counter)}.json`));
const codeOf = (run: () => unknown): string => { try { run(); } catch (error) { return String((error as { code?: unknown }).code); } return 'OPENED'; };
/** A pid whose process has ended: a child that ran to completion. */
const deadPid = (): number => { const child = spawnSync(process.execPath, ['-e', '0']); assert.ok(typeof child.pid === 'number' && child.pid > 0); return child.pid; };
const bootId = (): string => { const id = lib.currentBootId(); assert.ok(typeof id === 'string' && id !== '', 'this host can name its boot'); return id; };
const lockBody = (over: Record<string, unknown>): Record<string, unknown> => ({ pid: deadPid(), hostname: hostname(), bootId: bootId(), startedAt: '2026-10-06T00:00:00.000Z', at: '2026-10-06T00:00:00.000Z', ...over });
const plantLock = (path: string, body: unknown): void => { writeFileSync(`${path}.lock`, typeof body === 'string' ? body : `${JSON.stringify(body)}\n`); };
const readLock = (path: string): Record<string, unknown> => JSON.parse(readFileSync(`${path}.lock`, 'utf8')) as Record<string, unknown>;
const tombstones = (path: string): string[] => readdirSync(dir).filter((name) => name.startsWith(`${path.split(/[\\/]/u).pop() ?? ''}.lock.recovering.`));
const recoveredOf = (events: Held['events']): Held['events'] => events.filter((event) => event.kind === 'LOCK_RECOVERED');
const ledgerKinds = (path: string): string[] => readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').map((line) => (JSON.parse(line) as { kind: string }).kind);

describe('B04 S10: grant ledger lock recovery (IC-11, G40-G42)', () => {
  it('IC-11 lock: a lock is recovered only when pid, hostname and boot id prove its process died, with LOCK_RECOVERED written; a live pid, another host or a legacy lock refuses', () => {
    const path = freshPath();
    // The lock this process writes carries the proof a later invocation needs.
    const first = lib.openGrantLedger(path, grant);
    const own = readLock(path);
    assert.equal(own['pid'], process.pid);
    assert.equal(own['hostname'], hostname());
    assert.equal(own['bootId'], bootId());
    assert.ok(typeof own['startedAt'] === 'string' && !Number.isNaN(Date.parse(own['startedAt'])), 'startedAt is an instant');
    assert.ok(typeof own['at'] === 'string' && !Number.isNaN(Date.parse(own['at'])));
    // A live holder (this process, same boot): refused, and the lock is not touched.
    assert.equal(codeOf(() => lib.openGrantLedger(path, grant)), 'GRANT_LEDGER_LOCKED');
    assert.equal(lib.inspectGrantLedger(path, grant)?.code, 'GRANT_LEDGER_LOCKED');
    assert.deepEqual(readLock(path), own);
    first.close();

    // A crashed holder on this host and boot: its pid is gone. The lock is renamed, recovery is recorded, a new lock is taken.
    const dead = lockBody({});
    plantLock(path, dead);
    assert.equal(lib.inspectGrantLedger(path, grant), null, 'a provably dead holder does not block the preflight');
    const recovered = lib.openGrantLedger(path, grant);
    const recoveredEvents = readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { kind: string; oldLock?: unknown; provedBy?: string });
    const event = recoveredEvents.find((line) => line.kind === 'LOCK_RECOVERED');
    assert.ok(event !== undefined, 'LOCK_RECOVERED is in the ledger');
    assert.deepEqual(event.oldLock, dead);
    assert.equal(event.provedBy, 'PID_GONE');
    assert.equal(readLock(path)['pid'], process.pid, 'the new lock is this process');
    assert.deepEqual(tombstones(path), [], 'the renamed lock is removed once recovery is recorded');
    recovered.close();
    assert.equal(existsSync(`${path}.lock`), false);

    // Another boot: the pid may even be alive (reused), the boot id proves it is not the holder.
    plantLock(path, lockBody({ pid: process.pid, bootId: 'a-boot-before-the-last-restart' }));
    const rebooted = lib.openGrantLedger(path, grant);
    const byBoot = recoveredOf(rebooted.events.length === 0 ? [] : rebooted.events);
    assert.equal(byBoot.length, 1, 'the earlier recovery is part of the events this invocation reads');
    rebooted.close();
    const kinds = ledgerKinds(path);
    assert.equal(kinds.filter((kind) => kind === 'LOCK_RECOVERED').length, 2);
    const last = readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { kind: string; provedBy?: string }).filter((line) => line.kind === 'LOCK_RECOVERED').pop();
    assert.equal(last?.provedBy, 'BOOT_ID_DIFFERS');

    // Everything else refuses and leaves the lock where it is.
    const refused: [string, unknown][] = [
      ['a live pid on this boot', lockBody({ pid: process.pid })],
      ['another host', lockBody({ hostname: `${hostname()}-another-host` })],
      ['a legacy lock without a boot id', { pid: deadPid(), at: '2026-10-06T00:00:00.000Z' }],
      ['an empty legacy lock', '{}'],
      ['an unreadable lock', 'not json at all'],
      ['a lock with a pid that is not a number', lockBody({ pid: 'abc' })],
    ];
    for (const [name, body] of refused) {
      plantLock(path, body);
      const before = readFileSync(`${path}.lock`, 'utf8');
      assert.equal(codeOf(() => lib.openGrantLedger(path, grant)), 'GRANT_LEDGER_LOCKED', name);
      assert.equal(lib.inspectGrantLedger(path, grant)?.code, 'GRANT_LEDGER_LOCKED', name);
      assert.equal(readFileSync(`${path}.lock`, 'utf8'), before, `${name}: the lock is untouched`);
      assert.deepEqual(tombstones(path), [], `${name}: nothing was renamed`);
      rmSync(`${path}.lock`);
    }
    assert.equal(ledgerKinds(path).filter((kind) => kind === 'LOCK_RECOVERED').length, 2, 'a refusal writes no recovery');
  });

  it('RACE: two recoverers of one stale lock, both orders, one wins', () => {
    for (const order of ['the other recoverer finishes between proof and rename', 'the other recoverer finishes before proof is read twice'] as const) {
      const path = freshPath();
      plantLock(path, lockBody({}));
      let winner: Held | null = null;
      let loserCode = 'NOT_RUN';
      const outer = codeOf(() => {
        const held = lib.openGrantLedger(path, grant, {
          afterProof: () => {
            // The second recoverer read the same stale lock and runs its whole recovery now: it wins.
            winner = lib.openGrantLedger(path, grant);
            loserCode = order;
          },
        });
        held.close();
      });
      assert.equal(outer, 'GRANT_LEDGER_LOCKED', order);
      assert.equal(loserCode, order, 'the hook ran');
      assert.ok(winner !== null, 'the nested recoverer won');
      const live = winner as Held;
      assert.equal(readLock(path)['pid'], process.pid, 'the winner still holds its own lock: the loser did not rename it away');
      assert.deepEqual(tombstones(path), [], 'no tombstone of the winner lock');
      assert.equal(recoveredOf(live.events).length, 0, 'the winner read the ledger before its own recovery line');
      assert.equal(ledgerKinds(path).filter((kind) => kind === 'LOCK_RECOVERED').length, 1, 'exactly one recovery is recorded');
      live.close();
      assert.equal(existsSync(`${path}.lock`), false);
    }
    // The reverse order: the winner is the outer recoverer and the nested one is refused while the outer holds the lock.
    const path = freshPath();
    plantLock(path, lockBody({}));
    const outerHeld = lib.openGrantLedger(path, grant);
    assert.equal(codeOf(() => lib.openGrantLedger(path, grant)), 'GRANT_LEDGER_LOCKED');
    outerHeld.close();
    assert.equal(ledgerKinds(path).filter((kind) => kind === 'LOCK_RECOVERED').length, 1);
  });

  it('RACE (crash after LOCK_RECOVERED): the next open sees the event and the tombstone and recovers once', () => {
    const oldLock = lockBody({});
    const tombstoneName = (path: string): string => `${path}.lock.recovering.${String(deadPid())}`;
    // (a) The recoverer died after the rename and before its event: there is a tombstone and no lock. The next open records it once.
    const a = freshPath();
    lib.openGrantLedger(a, grant).close();
    const tombA = tombstoneName(a);
    writeFileSync(tombA, `${JSON.stringify(oldLock)}\n`);
    const reopenedA = lib.openGrantLedger(a, grant);
    reopenedA.close();
    const eventsA = readFileSync(a, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { kind: string; oldLock?: unknown });
    assert.equal(eventsA.filter((line) => line.kind === 'LOCK_RECOVERED').length, 1, 'the orphaned tombstone is recorded once');
    assert.deepEqual(eventsA.find((line) => line.kind === 'LOCK_RECOVERED')?.oldLock, oldLock);
    assert.equal(existsSync(tombA), false, 'and removed');
    lib.openGrantLedger(a, grant).close();
    assert.equal(ledgerKinds(a).filter((kind) => kind === 'LOCK_RECOVERED').length, 1, 'a further open adds nothing');

    // (b) The recoverer died after its event and before removing the tombstone: the event is there, the tombstone is too, the lock is stale.
    const b = freshPath();
    const first = lib.openGrantLedger(b, grant);
    first.append({ kind: 'LOCK_RECOVERED', oldLock, provedBy: 'PID_GONE' });
    first.close();
    const tombB = tombstoneName(b);
    writeFileSync(tombB, `${JSON.stringify(oldLock)}\n`);
    const newStale = lockBody({});
    plantLock(b, newStale);
    const reopenedB = lib.openGrantLedger(b, grant);
    reopenedB.close();
    const eventsB = readFileSync(b, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { kind: string; oldLock?: unknown });
    const recoveries = eventsB.filter((line) => line.kind === 'LOCK_RECOVERED');
    assert.equal(recoveries.length, 2, 'the old lock once (its event existed), the new stale lock once');
    assert.deepEqual(recoveries[0]?.oldLock, oldLock);
    assert.deepEqual(recoveries[1]?.oldLock, newStale);
    assert.equal(existsSync(tombB), false, 'the tombstone whose event exists is removed without a second event');
  });
});
