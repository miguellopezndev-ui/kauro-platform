/**
 * AttemptByteLedger — the one byte ledger of an attempt's scratch (B05 D5-2c).
 *
 * A map from a resolved path to the bytes charged to it; `live` is their sum. Every write is charged BEFORE it reaches the device
 * (a charge that would pass the budget throws an ENOSPC-coded error and charges nothing); every removal or replacement credits
 * exactly the charged bytes of the keys that ceased to exist, read from this map, never an lstat size (a directory's lstat size is
 * 4096 on ext4 and 0 on NTFS, unrelated to its content). Links and hard links are refused by the callers, so a file has one key.
 * Loaded inside the isolated child as well as in the parent: it imports only node built-ins.
 */
import { resolve, sep } from "node:path";

/** The ledger key of a path: path.resolve, lower-cased on win32. */
export function ledgerKeyOf(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export class ScratchBudgetExceeded extends Error {
  readonly code = "ENOSPC";
  constructor(detail: string) {
    super(`ENOSPC: the attempt's scratch budget would be passed (${detail})`);
    this.name = "ScratchBudgetExceeded";
  }
}

export class AttemptByteLedger {
  readonly #charged = new Map<string, number>();
  #budget: number;
  #live = 0;
  #peak = 0;

  constructor(budgetBytes: number) {
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) throw new TypeError("a ledger budget is a non-negative whole number of bytes");
    this.#budget = budgetBytes;
  }

  get budget(): number {
    return this.#budget;
  }

  get live(): number {
    return this.#live;
  }

  get peak(): number {
    return this.#peak;
  }

  chargedOf(path: string): number {
    return this.#charged.get(ledgerKeyOf(path)) ?? 0;
  }

  /** The charged map, by key (for the child's residual record). */
  entries(): ReadonlyMap<string, number> {
    return this.#charged;
  }

  /** Charges the path up to `end` bytes (a write reaching offset `end`): only the growth over what it already holds is charged. */
  chargeTo(path: string, end: number, extraLive = 0): void {
    const key = ledgerKeyOf(path);
    const held = this.#charged.get(key) ?? 0;
    const delta = Math.max(0, end - held);
    if (delta === 0) return;
    if (this.#live + extraLive + delta > this.#budget) throw new ScratchBudgetExceeded(`${delta} more bytes for one write, ${this.#live} live of ${this.#budget}`);
    this.#charged.set(key, held + delta);
    this.#live += delta;
    this.#peak = Math.max(this.#peak, this.#live);
  }

  /** Sets what the path holds (a whole-file write or a reset): the difference is charged or credited. */
  setCharged(path: string, bytes: number, extraLive = 0): void {
    const key = ledgerKeyOf(path);
    const held = this.#charged.get(key) ?? 0;
    if (bytes > held && this.#live + extraLive + (bytes - held) > this.#budget) throw new ScratchBudgetExceeded(`${bytes - held} more bytes, ${this.#live} live of ${this.#budget}`);
    this.#live += bytes - held;
    if (bytes === 0) this.#charged.delete(key);
    else this.#charged.set(key, bytes);
    this.#peak = Math.max(this.#peak, this.#live);
  }

  /** Lowers a charge after a write that wrote fewer bytes than were charged. */
  trimTo(path: string, bytes: number): void {
    const held = this.chargedOf(path);
    if (bytes < held) this.setCharged(path, bytes);
  }

  #under(path: string): string[] {
    const key = ledgerKeyOf(path);
    const prefix = key.endsWith(sep) ? key : key + sep;
    return [...this.#charged.keys()].filter((k) => k === key || k.startsWith(prefix));
  }

  /** Credits every key equal to the path or under it; returns the bytes credited. */
  creditTree(path: string): number {
    let credited = 0;
    for (const key of this.#under(path)) {
      const bytes = this.#charged.get(key) ?? 0;
      credited += bytes;
      this.#live -= bytes;
      this.#charged.delete(key);
    }
    return credited;
  }

  /** A rename: first the replaced destination's keys are credited, then the source's keys are re-keyed under the destination (no credit: the bytes still exist). */
  rename(from: string, to: string): void {
    this.creditTree(to);
    const fromKey = ledgerKeyOf(from);
    const toKey = ledgerKeyOf(to);
    for (const key of this.#under(from)) {
      const bytes = this.#charged.get(key) ?? 0;
      this.#charged.delete(key);
      this.#charged.set(toKey + key.slice(fromKey.length), bytes);
    }
  }

  /** After a call that threw midway: each charged key under the target is checked and credited only when it no longer exists. */
  reconcile(path: string, exists: (key: string) => boolean): number {
    let credited = 0;
    for (const key of this.#under(path)) {
      if (exists(key)) continue;
      const bytes = this.#charged.get(key) ?? 0;
      credited += bytes;
      this.#live -= bytes;
      this.#charged.delete(key);
    }
    return credited;
  }

  /** Adopts entries (the child's residual map: the staging package files): they become charged keys of this ledger. */
  adopt(entries: Iterable<readonly [string, number]>): void {
    for (const [path, bytes] of entries) this.setCharged(path, bytes);
  }
}
