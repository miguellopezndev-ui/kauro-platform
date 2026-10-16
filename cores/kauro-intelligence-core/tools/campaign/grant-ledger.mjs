// The durable ledger of one campaign grant (B04 D4-CAMP-6; Codex B04-R1). Every runner invocation that spends a grant loads this
// ledger into its CampaignAdmission (the `journal` option), so the cap is spent once across invocations and processes:
//   - the file sits beside the grant file (`<grant>.ledger.jsonl`), its first line binds it to the grant (id and digest of the
//     whole grant: a raised cap or another approval is another grant and is refused);
//   - every event is appended and fsync'd before the change it records takes effect (CampaignAdmission writes ahead);
//   - an exclusive lock file (`<ledger>.lock`, created with O_EXCL) is held while an invocation is open: a second invocation
//     over the same grant is refused, never interleaved. Its body is {pid, hostname, bootId, startedAt, at};
//   - a lock left by a process that died is recovered (S10) only on proof of death: the same hostname, and a boot id that differs
//     from this boot's or a pid that no longer exists (ESRCH). Time never proves death (no lease). The lock is renamed atomically to
//     `<lock>.recovering.<pid>`, the new lock is created with O_EXCL, and LOCK_RECOVERED{oldLock, provedBy} is appended (once per
//     old lock, also when the recoverer died between the rename and the event). A live pid, another host, a legacy lock without a
//     boot id and an unreadable lock all refuse, and the owner removes them after checking;
//   - a torn or unreadable ledger is refused, never repaired: a lost line could be money.
// Pure Node; nothing here imports the package.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

const KINDS = new Set(['HOLD', 'DROP', 'SETTLE', 'STOP', 'RUN', 'LOCK_RECOVERED']);
const SETTLED = new Set(['COMMITTED', 'AMBIGUOUS', 'RELEASED']);
const isMicros = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isLabel = (value) => typeof value === 'string' && value !== '';

/** Where the ledger of a grant file lives. */
export const ledgerPathOf = (grantPath) => `${resolve(grantPath)}.ledger.jsonl`;

/** The digest that binds a ledger to the whole grant, key order aside. */
export function grantDigestOf(grant) {
  const ordered = Object.fromEntries(Object.keys(grant).sort().map((key) => [key, grant[key]]));
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

const refusal = (code, message) => Object.assign(new Error(message), { code });

let bootIdCache;
/** This boot's identity: /proc boot_id (Linux, WSL) or the Windows last boot time; null when the host cannot say. */
export function currentBootId() {
  if (bootIdCache !== undefined) return bootIdCache;
  let id = null;
  try {
    if (process.platform === 'linux') id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    else if (process.platform === 'win32') id = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')"], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }).trim();
  } catch { id = null; }
  bootIdCache = id === null || id === '' ? null : id;
  return bootIdCache;
}

function eventProblem(event) {
  if (event === null || typeof event !== 'object' || !KINDS.has(event.kind)) return 'not a ledger event';
  if (event.kind === 'STOP') return isLabel(event.reason) ? null : 'a stop without a reason';
  if (event.kind === 'LOCK_RECOVERED') return event.oldLock !== null && typeof event.oldLock === 'object' && isLabel(event.provedBy) ? null : 'a lock recovery without the old lock and its proof';
  if (event.kind === 'RUN') {
    if (!isLabel(event.runId) || !isLabel(event.candidate) || !isLabel(event.stage)) return 'a run start without its run, stage and candidate';
    return event.runNo === null || (Number.isSafeInteger(event.runNo) && event.runNo >= 0) ? null : 'a run start whose number is neither null nor a whole number';
  }
  if (!isLabel(event.runId) || !isLabel(event.reservationId)) return 'an event without its run and reservation';
  if (event.kind === 'HOLD' && !isMicros(event.maxChargeMicros)) return 'a hold without a whole maximum charge';
  if (event.kind === 'HOLD' && event.requestKey !== undefined && !isLabel(event.requestKey)) return 'a hold whose request key is not a label';
  if (event.kind === 'SETTLE' && (!SETTLED.has(event.state) || !isMicros(event.chargeMicros))) return 'a settlement without a state and a whole charge';
  if (event.kind === 'SETTLE' && event.reconciled !== undefined && (event.reconciled !== true || event.state !== 'RELEASED' || !isLabel(event.reason) || !isLabel(event.requestKey))) return 'a reconciled settlement that is not a release with its reason and request key';
  return null;
}

/** Reads a ledger without locking it: its events, or the refusal that opening it would raise. */
export function readGrantLedger(path, grant) {
  if (!existsSync(path)) return { events: [], exists: false };
  const text = readFileSync(path, 'utf8');
  if (text !== '' && !text.endsWith('\n')) throw refusal('GRANT_LEDGER_CORRUPT', `${path} ends inside a line: a write was torn; the owner inspects it before anything is spent on ${String(grant.grantId)}`);
  const lines = text.split('\n').slice(0, -1);
  const parsed = lines.map((line, index) => { try { return JSON.parse(line); } catch { throw refusal('GRANT_LEDGER_CORRUPT', `${path} line ${String(index + 1)} is not JSON`); } });
  const head = parsed[0];
  if (head === undefined || head.kind !== 'GRANT') throw refusal('GRANT_LEDGER_CORRUPT', `${path} does not start with its grant`);
  if (head.grantId !== grant.grantId || head.grantDigest !== grantDigestOf(grant)) throw refusal('GRANT_LEDGER_MISMATCH', `${path} is the ledger of grant ${String(head.grantId)} (${String(head.grantDigest).slice(0, 12)}…), not of this grant ${String(grant.grantId)} (${grantDigestOf(grant).slice(0, 12)}…)`);
  const events = parsed.slice(1);
  events.forEach((event, index) => { const problem = eventProblem(event); if (problem !== null) throw refusal('GRANT_LEDGER_CORRUPT', `${path} line ${String(index + 2)}: ${problem}`); });
  return { events, exists: true };
}

/** Whether a process exists on this host: false only when the system says there is none (ESRCH). */
function pidExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

/**
 * What a lock file proves. DEAD only when the holder provably ended: same hostname, a boot id of another boot or a pid that is gone.
 * Anything unreadable, legacy, foreign or alive is not proof (the owner decides).
 */
function lockProof(lockPath) {
  let text;
  try { text = readFileSync(lockPath, 'utf8'); } catch (error) { return error.code === 'ENOENT' ? { state: 'ABSENT' } : { state: 'UNPROVEN', why: `the lock cannot be read (${String(error.code)})` }; }
  let body;
  try { body = JSON.parse(text); } catch { return { state: 'UNPROVEN', why: 'the lock is not readable JSON' }; }
  if (body === null || typeof body !== 'object' || !Number.isSafeInteger(body.pid) || body.pid < 1 || !isLabel(body.hostname) || !isLabel(body.bootId)) return { state: 'UNPROVEN', why: 'a legacy lock without pid, hostname and boot id proves nothing' };
  if (body.hostname !== hostname()) return { state: 'UNPROVEN', why: `the lock was taken on another host (${body.hostname}): its process cannot be checked from here` };
  const boot = currentBootId();
  if (boot === null) return { state: 'UNPROVEN', why: 'this host cannot name its boot, so a holder from an earlier boot cannot be told from a live one' };
  if (body.bootId !== boot) return { state: 'DEAD', provedBy: 'BOOT_ID_DIFFERS', body, text };
  if (!pidExists(body.pid)) return { state: 'DEAD', provedBy: 'PID_GONE', body, text };
  return { state: 'LIVE', why: `pid ${String(body.pid)} on this host and boot is alive` };
}

/** What a funded stage learns from the ledger before anything is installed: a lock held, a refusal to open, a stop recorded. */
export function inspectGrantLedger(path, grant) {
  const lockPath = `${path}.lock`;
  if (existsSync(lockPath)) {
    const proof = lockProof(lockPath);
    if (proof.state !== 'ABSENT' && proof.state !== 'DEAD') return { code: 'GRANT_LEDGER_LOCKED', detail: `${lockPath} is held: another invocation is spending ${String(grant.grantId)}, or one ended without releasing it and its death is not proven (${proof.why}); the owner removes the lock after checking` };
  }
  let read;
  try { read = readGrantLedger(path, grant); } catch (error) { return { code: error.code ?? 'GRANT_LEDGER_CORRUPT', detail: error.message }; }
  const stop = read.events.find((event) => event.kind === 'STOP');
  if (stop !== undefined) return { code: 'GRANT_STOPPED', detail: `${String(grant.grantId)} was stopped (${stop.reason}): nothing more is spent on it; a new grant needs a new owner approval` };
  return null;
}

const writeLockBody = (lockPath) => {
  const lock = openSync(lockPath, 'wx');
  try {
    const now = new Date().toISOString();
    writeSync(lock, `${JSON.stringify({ pid: process.pid, hostname: hostname(), bootId: currentBootId(), startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(), at: now })}\n`);
    fsyncSync(lock);
  } finally { closeSync(lock); }
};

/**
 * Takes the lock: O_EXCL, or the recovery of a lock whose holder provably died. Returns the recoveries this call made (their old
 * locks and proofs; the ledger records them once the lock is held).
 */
function acquireLock(lockPath, grant, hooks) {
  const held = (why) => refusal('GRANT_LEDGER_LOCKED', `${lockPath} is held: another invocation is spending ${String(grant.grantId)}, or one ended without releasing it (${why})`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { writeLockBody(lockPath); return []; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const proof = lockProof(lockPath);
    if (proof.state === 'ABSENT') continue;
    if (proof.state !== 'DEAD') throw held(proof.why);
    hooks.afterProof?.(proof.body);
    const tombstone = `${lockPath}.recovering.${String(process.pid)}`;
    try { renameSync(lockPath, tombstone); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    // Another recoverer may have replaced the lock between the proof and the rename: what was renamed must be the lock that was proven.
    if (readFileSync(tombstone, 'utf8') !== proof.text) {
      try { linkSync(tombstone, lockPath); unlinkSync(tombstone); } catch { throw refusal('GRANT_LEDGER_LOCKED', `${lockPath} was replaced during recovery and could not be put back: the owner checks ${tombstone} and the lock before anything is spent`); }
      throw held('another invocation recovered it first');
    }
    try { writeLockBody(lockPath); } catch (error) {
      if (error.code === 'EEXIST') throw held('another invocation took it during recovery; the recovered lock stays recorded in its tombstone');
      throw error;
    }
    return [{ oldLock: proof.body, provedBy: proof.provedBy }];
  }
  throw held('the lock kept changing under recovery');
}

/**
 * Opens the ledger for one invocation: takes the exclusive lock (recovering a dead holder's), reads and checks what is there, writes
 * the grant line of a new ledger and one LOCK_RECOVERED line per recovered lock. Returns the journal CampaignAdmission takes, and
 * close(), which releases the lock. `hooks.afterProof` is a test seam between the proof of death and the rename.
 */
export function openGrantLedger(path, grant, hooks = {}) {
  const lockPath = `${path}.lock`;
  const recovered = acquireLock(lockPath, grant, hooks);
  let fd = null;
  try {
    const { events, exists } = readGrantLedger(path, grant);
    fd = openSync(path, 'a');
    const write = (record) => { writeSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd); };
    if (!exists) write({ kind: 'GRANT' , grantId: grant.grantId, grantDigest: grantDigestOf(grant) });
    // A recoverer that died between its rename and its event leaves a tombstone: it is recorded here, once, then removed.
    const known = new Set(events.filter((event) => event.kind === 'LOCK_RECOVERED').map((event) => JSON.stringify(event.oldLock)));
    const directory = dirname(lockPath);
    const prefix = `${basename(lockPath)}.recovering.`;
    for (const name of readdirSync(directory).filter((entry) => entry.startsWith(prefix)).sort()) {
      const tombstone = resolve(directory, name);
      let oldLock;
      try { oldLock = JSON.parse(readFileSync(tombstone, 'utf8')); } catch { throw refusal('GRANT_LEDGER_CORRUPT', `${tombstone} is not a readable recovered lock: the owner inspects it`); }
      const key = JSON.stringify(oldLock);
      if (!known.has(key)) {
        const mine = recovered.find((one) => JSON.stringify(one.oldLock) === key);
        const event = { kind: 'LOCK_RECOVERED', oldLock, provedBy: mine?.provedBy ?? 'RECOVERER_DIED_BEFORE_RECORD' };
        write(event);
        known.add(key);
      }
      unlinkSync(tombstone);
    }
    let open = true;
    return {
      events,
      append(event) {
        if (!open) throw refusal('GRANT_LEDGER_CLOSED', 'the grant ledger is closed: nothing more is spent through it');
        const problem = eventProblem(event);
        if (problem !== null) throw refusal('GRANT_LEDGER_CORRUPT', `refused to write ${problem}`);
        write(event);
      },
      close() {
        if (!open) return;
        open = false;
        closeSync(fd);
        unlinkSync(lockPath);
      },
    };
  } catch (error) {
    if (fd !== null) closeSync(fd);
    unlinkSync(lockPath);
    throw error;
  }
}
