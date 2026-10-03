/**
 * The controlled clock of the common fault harness (docs/design/FAULT-HARNESS.md): one instant per test that drives both the
 * application's Clock port and the labelled TEST CLOCK of the temporary cluster (kauro.server_now(), TEST_CLOCK_FUNCTION), and
 * moves only when the test moves it. A test places two steps on either side of an expiry, a lease's time to live or a
 * provider-call timeout by moving the clock between them; nothing sleeps and the wall clock decides nothing.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { Clock } from "@kauro/domain";
import { toUtcInstant } from "@kauro/domain";
import type { SqlSession } from "../source-lifecycle.js";
import { TEST_CLOCK_OFFSET_SETTING } from "../temporary-postgres.js";

export type InstantLike = Date | number | string;

export interface ControlledClock extends Clock {
  /** The current instant as a Date (a copy). */
  date(): Date;
  /** The instant `offsetMs` from the current one, without moving the clock (the steps' own instant parameters). */
  at(offsetMs: number): UtcInstant;
  /** Moves the clock forward by `ms` (> 0); a clock never moves backwards. */
  advance(ms: number): UtcInstant;
  /** Moves the clock to `instant`, which must not be earlier than the current one. */
  set(instant: InstantLike): UtcInstant;
  /** Moves the clock just past `boundary` (by `marginMs`, default 1 ms): the first instant at which an expiry has happened. */
  past(boundary: InstantLike, marginMs?: number): UtcInstant;
  /** Moves the clock to just before `boundary` (by `marginMs`, default 1 ms): the last instant at which it has not. */
  before(boundary: InstantLike, marginMs?: number): UtcInstant;
  /**
   * Positions kauro.server_now() of the session's open transaction exactly at the clock's instant (the transaction-local offset
   * of the TEST CLOCK, computed by the server against its own transaction_timestamp()) and returns the server's instant.
   */
  onServer(session: SqlSession): Promise<string>;
  /** How many times the test moved the clock forward (moving it to the instant it already reads is not a move). */
  readonly moves: number;
  /** Every forward move, in order: from and to (epoch ms) and its sequence number. */
  readonly moveLog: ReadonlyArray<ClockMove>;
  /**
   * Every use of the clock by a step: the application read its instant (now, nowMs, date — the Clock port, or an instant a step
   * takes as its parameter) or a transaction's server clock was positioned on it (onServer); with the instant used and its sequence.
   */
  readonly useLog: ReadonlyArray<ClockUse>;
}

export interface ClockMove {
  readonly from: number;
  readonly to: number;
  readonly seq: number;
}

export interface ClockUse {
  readonly kind: "APPLICATION" | "SERVER";
  readonly at: number;
  readonly seq: number;
}

export function epochMs(instant: InstantLike): number {
  const ms = instant instanceof Date ? instant.getTime() : typeof instant === "number" ? instant : Date.parse(instant);
  if (!Number.isFinite(ms)) throw new RangeError(`not an instant: ${String(instant)}`);
  return ms;
}

/** A clock frozen at `start` (default: now) that moves only when the test moves it. */
export function controlledClock(start: InstantLike = Date.now()): ControlledClock {
  let current = Math.trunc(epochMs(start));
  let seq = 0;
  const moveLog: ClockMove[] = [];
  const useLog: ClockUse[] = [];
  const moveTo = (ms: number, what: string): UtcInstant => {
    const target = Math.trunc(ms);
    if (target < current) throw new RangeError(`the controlled clock never moves backwards (${what}: ${toUtcInstant(target)} is before ${toUtcInstant(current)})`);
    // the clock already reads this instant: nothing moved, nothing is recorded
    if (target > current) moveLog.push({ from: current, to: target, seq: ++seq });
    current = target;
    return toUtcInstant(current);
  };
  const used = (kind: ClockUse["kind"]): number => {
    useLog.push({ kind, at: current, seq: ++seq });
    return current;
  };
  return {
    now: () => toUtcInstant(used("APPLICATION")),
    nowMs: () => used("APPLICATION"),
    date: () => new Date(used("APPLICATION")),
    at: (offsetMs) => toUtcInstant(current + offsetMs),
    advance(ms) {
      if (!(ms > 0)) throw new RangeError("advance moves the clock forward by a positive number of milliseconds");
      return moveTo(current + ms, "advance");
    },
    set: (instant) => moveTo(epochMs(instant), "set"),
    past: (boundary, marginMs = 1) => moveTo(epochMs(boundary) + marginMs, "past"),
    before: (boundary, marginMs = 1) => moveTo(epochMs(boundary) - marginMs, "before"),
    async onServer(session) {
      const instant = current;
      await session.query("SELECT set_config($1, extract(epoch FROM ($2::timestamptz - transaction_timestamp()))::text, true)", [TEST_CLOCK_OFFSET_SETTING, toUtcInstant(instant)]);
      const r = await session.query<{ now: string }>(`SELECT to_char(kauro.server_now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`);
      const now = r.rows[0]?.now;
      if (now === undefined) throw new Error("the server clock answered nothing");
      if (Date.parse(now) !== instant) throw new Error(`the server clock reads ${now}, not the controlled ${toUtcInstant(instant)}`);
      // recorded only once the transaction's server clock demonstrably stands at the instant
      useLog.push({ kind: "SERVER", at: instant, seq: ++seq });
      return now;
    },
    get moves() {
      return moveLog.length;
    },
    get moveLog() {
      return [...moveLog];
    },
    get useLog() {
      return [...useLog];
    },
  };
}
