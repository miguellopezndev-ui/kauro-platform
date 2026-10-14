/**
 * The §M harness of package B12's race cells (docs/design/B12-outreach-plan.md §M rev 4; rules 24, 24a, 24b, 24c of
 * docs/design/FAILURE-MATRIX-TEMPLATE.md; lane K1). One pattern for every writer pair:
 *
 * raceAtWrite: the first actor runs until it is paused once it holds its whole serializer set and has judged (at the `.before` point of
 * its FIRST WRITE, a SqlStep of fault-support.ts, or at the `.after` point of the write whose trigger takes a member); the second then
 * runs until the oracle sees it blocked by the first's backend (pg_blocking_pids, polled, never a throw) or it settles; the first is
 * released, then both are awaited. The outcome only REPORTS whether the second was blocked: a cell asserts its forbidden effect first
 * (provider calls the fake counted, rows, final states) and only then the outcome, so under a control the red is always the effect.
 * Unlike mustWait (interleave.ts) it never throws when the second settles, so a control (the serializer set removed) runs to its effect.
 *
 * Crediting the wait: runCell("race") requires ctx.observedWaits > 0, and only ctx.mustWait (never this oracle) increments it, so a race cell
 * built on raceAtWrite alone ended in FaultNotInjected even when green (found by L-DRAFT). With `credit` the second runs THROUGH
 * credit.mustWait on its own connection (`second.waiter` / `second.runOn`): the harness itself observes the wait and credits it; a second
 * that settles without waiting (a control) is not credited, keeps its own answer as the outcome, and the cell is red where it belongs
 * ("no lock wait of the operation on the intended holder was observed"). Self-test: outreach-race-credit.test.ts.
 *
 * tokenFromSentMime: the credential of an opt-out cell comes only from the MIME the Gmail fake recorded (rule 24b): the List-Unsubscribe
 * https URI of the intent's first message. An intent the fake never received has no token, and asking for it throws.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { Client } from "pg";
import { InterleavingNotObserved, type FaultContext, type HarnessConnection } from "@kauro/persistence/testing";
import type { ContractFakeGmailSend } from "@kauro/application/testing";

export type RaceOutcome = "blocked" | "settled";

export interface RaceResult<A, B> {
  /** "blocked": the second waited on a lock the first's backend held; "settled": it finished (either way) while the first was paused. */
  readonly outcome: RaceOutcome;
  readonly first: PromiseSettledResult<A>;
  readonly second: PromiseSettledResult<B>;
}

export interface RaceActor<T> {
  /** Starts the actor (an api call, a unit of work); called once. */
  run(): Promise<T>;
}

export interface PausedFirst<A> extends RaceActor<A> {
  /** Resolves once the first is at its pause point (a FaultPoints pause's reached / reachedBy). */
  readonly reached: Promise<unknown>;
  /** Lets the first continue past its pause. */
  release(): void;
  /** The first's backend pid, known once it reached its pause. */
  pid(): number | Promise<number>;
}

export interface Second<B> extends RaceActor<B> {
  /** The second's backend pid (its connection, opened before it runs, or known once it started). */
  pid(): number | Promise<number>;
  /** With `credit`: the connection the harness opened for the second (openConnection), the one mustWait observes. */
  readonly waiter?: HarnessConnection;
  /** With `credit`: the second's operation on the connection mustWait hands it (it replaces `run`, which is then not called). */
  runOn?(client: HarnessConnection): Promise<B>;
}

export interface RaceAtWrite<A, B> {
  /** A superuser connection that only observes (pg_stat_activity). */
  readonly oracle: Client;
  readonly first: PausedFirst<A>;
  readonly second: Second<B>;
  /** How long the second may neither block nor settle before the race is reported as broken (default 10 s). */
  readonly limitMs?: number;
  /** The cell's FaultContext: the second's wait is credited through ctx.mustWait (needs second.waiter and second.runOn). */
  readonly credit?: Pick<FaultContext, "mustWait">;
  /** What the credited wait is called in the harness's messages (default "the second waits on the first"). */
  readonly what?: string;
}

/** The race did not happen as staged (the first never paused, or the second neither waited nor settled): never an outcome. */
export class RaceNotObserved extends Error {}

export async function raceAtWrite<A, B>(race: RaceAtWrite<A, B>): Promise<RaceResult<A, B>> {
  const limitMs = race.limitMs ?? 10_000;
  // refused before the first actor starts: a credited race whose second cannot be handed to mustWait must not run half-staged
  if (race.credit !== undefined && (race.second.waiter === undefined || race.second.runOn === undefined)) {
    throw new TypeError("raceAtWrite with credit: the second names its waiter connection and runOn (the operation mustWait hands the connection to)");
  }
  const first = settle(race.first.run());
  const reached = await Promise.race([race.first.reached.then(() => "reached" as const), first.then(() => "ended" as const)]);
  if (reached === "ended") throw new RaceNotObserved(`the first actor ended before its pause point: ${describe(await first)}`);
  let outcome: RaceOutcome | null = null;
  let second: Promise<PromiseSettledResult<B>> | null = null;
  try {
    const firstPid = await race.first.pid();
    let secondDone = false;
    second = settle(startSecond(race, firstPid, limitMs)).then((r) => {
      secondDone = true;
      return r;
    });
    const deadline = Date.now() + limitMs;
    while (outcome === null) {
      if (secondDone) {
        outcome = "settled";
        break;
      }
      const secondPid = await race.second.pid();
      const seen = await race.oracle.query<{ blocked: boolean }>("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [firstPid, secondPid]);
      if (seen.rows[0]?.blocked === true) {
        outcome = "blocked";
        break;
      }
      if (secondDone) {
        outcome = "settled";
        break;
      }
      if (Date.now() > deadline) throw new RaceNotObserved(`the second actor neither waited on the first (pid ${firstPid}) nor settled within ${limitMs} ms`);
      await delay(5);
    }
  } finally {
    race.first.release();
  }
  const [a, b] = await Promise.all([first, second]);
  return { outcome, first: a, second: b };
}

/**
 * Starts the second actor. Without `credit` that is `second.run()`. With it the second runs through credit.mustWait: the harness observes
 * the wait on the first's backend (and counts it); if the second settles without waiting, mustWait throws InterleavingNotObserved, which is
 * swallowed here — the second's own answer is the outcome and nothing is credited, so the cell goes red at the harness's check, not here.
 */
async function startSecond<A, B>(race: RaceAtWrite<A, B>, firstPid: number, limitMs: number): Promise<B> {
  if (race.credit === undefined) return race.second.run();
  const { waiter, runOn } = race.second;
  if (waiter === undefined || runOn === undefined) throw new TypeError("raceAtWrite with credit: the second names its waiter connection and runOn (the operation mustWait hands the connection to)");
  let started: Promise<B> | undefined;
  const what = race.what ?? "the second waits on the first";
  try {
    const waiting = await race.credit.mustWait(race.oracle, { waiter, holder: firstPid }, (client) => (started = runOn.call(race.second, client)), what, limitMs);
    const settled = await waiting.pending;
    if (settled.status === "rejected") throw settled.reason;
    return settled.value;
  } catch (e) {
    if (e instanceof InterleavingNotObserved && started !== undefined) return await started;
    throw e;
  }
}

function settle<T>(p: Promise<T>): Promise<PromiseSettledResult<T>> {
  return p.then(
    (value): PromiseSettledResult<T> => ({ status: "fulfilled", value }),
    (reason: unknown): PromiseSettledResult<T> => ({ status: "rejected", reason }),
  );
}

function describe(r: PromiseSettledResult<unknown>): string {
  return r.status === "fulfilled" ? "fulfilled" : `rejected (${r.reason instanceof Error ? r.reason.message : String(r.reason)})`;
}

/** The opt-out path of a message's List-Unsubscribe URI (UI49: /api/v1/public/outreach/opt-out/{token}). */
const OPT_OUT_PATH = /\/api\/v1\/public\/outreach\/opt-out\/([A-Za-z0-9_-]+)(?=[?#]|$)/;

/** The header value of `name` in a MIME message (RFC 5322 unfolded), or undefined. Only the header block is read. */
export function mimeHeader(mime: string, name: string): string | undefined {
  const end = mime.search(/\r?\n\r?\n/);
  const head = (end < 0 ? mime : mime.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  const wanted = name.toLowerCase();
  for (const line of head.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === wanted) return line.slice(colon + 1).trim();
  }
  return undefined;
}

/**
 * The opt-out token of `intentId`'s first message, read from the MIME the Gmail fake recorded (rule 24b). Throws for an intent the fake
 * never received (DENY "support refuses an unsent token"), for a message without a List-Unsubscribe header, and for one whose https URI
 * is not the platform's opt-out path.
 */
export function tokenFromSentMime(fake: ContractFakeGmailSend, intentId: string): string {
  const mime = fake.sentMime(intentId);
  if (mime === undefined) throw new Error(`intent ${intentId} was never sent: the fake recorded no message for it, so it has no opt-out token`);
  const header = mimeHeader(mime, "List-Unsubscribe");
  if (header === undefined) throw new Error(`the message of intent ${intentId} carries no List-Unsubscribe header`);
  for (const m of header.matchAll(/<(https:\/\/[^>\s]+)>/g)) {
    const token = OPT_OUT_PATH.exec(m[1] ?? "")?.[1];
    if (token !== undefined) return token;
  }
  throw new Error(`the List-Unsubscribe header of intent ${intentId} names no https opt-out URI: ${header}`);
}
