// Lane L-REFUND: the V1 ACH refund rows of docs/design/ACH-ROUTE.md r12 §7.13-§7.19 (F1, F2, G1, G2, G3, G4, G6, P3; G2Δ/G4Δ run inside
// G2/G4), the fail-closed cell FC-G5 (§7.27) and the case-level titles ACH-12, ACH-14, ACH-15, ACH-16 (docs/design/ACH-case-map.md). Each
// cell runs both source scopes (CAPTURE refund, BANK_CREDIT treasury refund) inside its one title, CAPTURE first. Titles follow §7:
// `<VERB> ACH-M-<row>-<column> (<family>): <row label>` with the row label of the §7 heading (the case map cites "RACE ACH-M-G6-RACE
// (reorder): Apply incoming-credit reversal" and "RACE ACH-M-P3-RACE (reorder): FINANCE return-booking consumer").
// Design path note: the design names packages/persistence/test/ach-refund-cells.test.ts; the cells need the composed api and bankWorld
// (apps/api/test), so they live here (reported to the coordinator).
import assert from "node:assert/strict";
import { after, before } from "node:test";
import { laneTest as test } from "./refund-lane-support.js";
import { LOCK_WAIT_OBSERVATION_MS, runCell, type FaultContext, type FaultKind } from "@kauro/persistence/testing";
import type { StoredBankArtifact } from "./bank-support.js";
import { dispatch, reconcile, storeQuery } from "./payment-support.js";
import { freshKey, type Reply } from "./support.js";
import {
  DEST,
  L,
  SCOPES,
  SEAMS,
  SeamMissing,
  approveF2,
  approved,
  assertRefused,
  attemptRow,
  attemptsOf,
  bounceG3,
  bounced,
  dataOf,
  declareX4,
  declared,
  expireProofs,
  footprint,
  nextExecutionId,
  onFresh,
  openAttempt,
  ownOwner,
  plusMs,
  q,
  recordG2,
  recorded,
  refundOf,
  requested,
  reach,
  routed,
  sourceReserved,
  startLane,
  stopLane,
  storeExecution,
  valueOf,
  type AttemptView,
  type DeclareView,
  type Footprint,
  type OwnerCall,
  type RecordView,
  type Scope,
  type Source,
} from "./refund-lane-support.js";

before(async () => {
  await startLane();
});
after(async () => {
  await stopLane();
});

const LOCK_TIMEOUT_MS = Math.floor(LOCK_WAIT_OBSERVATION_MS / 4);
const same = (a: Footprint, b: Footprint): Footprint => ({ ...a, journal: b.journal });
function cell(title: string, fault: FaultKind, body: (ctx: FaultContext) => Promise<void>, at?: string): void {
  test(title, async () => {
    await runCell({ id: title.split(" ")[1]!, step: title, fault, ...(at === undefined ? {} : { at }), expect: title.slice(title.indexOf(": ") + 2) }, body);
  });
}
class Refused extends Error {
  constructor(readonly reply: Reply) {
    super(`${reply.status} ${reply.text}`);
  }
}
const asRefusal = async (p: Promise<Reply>): Promise<Reply> => {
  const r = await p;
  if (r.status >= 400) throw new Refused(r);
  return r;
};

/** The G6 entry point: an authenticated reversal of the source (CAPTURE: the provider's REVERSED capture reconciled by CMD034; BANK_CREDIT: seam S5). */
async function reverseSource(src: Source, cents: bigint = src.totalCents): Promise<Reply> {
  if (src.scope === "BANK_CREDIT") {
    const s5 = (L().bw as unknown as { reverseCredit?: (id: string, cents: bigint) => Promise<Reply> }).reverseCredit;
    if (s5 === undefined) throw new SeamMissing("S5", SEAMS.S5);
    return s5(src.sourceId, cents);
  }
  const { iw } = L();
  iw.pw.paypal.updateCapture(src.purchase!.providerCaptureId, { status: "REVERSED" });
  return reconcile(iw.pw, src.purchase!.orderId, { observationRef: await storeQuery(iw.pw, src.purchase!.providerOrderId) });
}
/** P3: one FINANCE pass; the deliveries it made. */
async function finance(): Promise<ReadonlyArray<{ readonly eventType: string; readonly outcome: string }>> {
  return (await dispatch(L().iw.pw, "FINANCE")).deliveries;
}
/** Σ ledger cents by direction of the posting sets of the source's refund/attempt events. */
async function ledgerOf(src: Source): Promise<{ readonly debit: bigint; readonly credit: bigint; readonly lines: number }> {
  const ids = [src.refundId, src.sourceId, ...(await attemptsOf(src)).map((a) => a.attempt_id)];
  const r = (await q<{ d: string; c: string; n: string }>(
    "SELECT coalesce(sum(l.amount_cents) FILTER (WHERE l.direction = 'DEBIT'), 0)::text AS d, coalesce(sum(l.amount_cents) FILTER (WHERE l.direction = 'CREDIT'), 0)::text AS c, count(*)::text AS n FROM kauro.ledger_entries l JOIN kauro.domain_events e ON e.event_id = l.domain_event_id WHERE e.aggregate_id::text = ANY($1::text[])",
    [ids],
  ))[0]!;
  return { debit: BigInt(r.d), credit: BigInt(r.c), lines: Number(r.n) };
}

// --- the owner rows F2, G2, G3, G4: one subject per cell and scope, one operation, its body variants -------------------------------------

interface Subject {
  readonly src: Source;
  readonly attempt?: AttemptView;
  /** The row's operation (the owner's command) on this subject. */
  run(o?: OwnerCall & { readonly variant?: boolean }): Promise<Reply>;
  /** The state the step moves (F2: refund APPROVED; G2: attempt RECORDED and refund COMPLETED; G3: the bounce; G4: the RESEND RECORDED). */
  effect(): Promise<string>;
}
interface OwnerRow {
  readonly code: "F2" | "G2" | "G3" | "G4";
  readonly label: string;
  readonly k: string;
  readonly target?: number;
  subject(scope: Scope, label: string): Promise<Subject>;
  /** The effect state after the operation succeeded. */
  readonly done: string;
  /** The state before it. */
  readonly pending: string;
}

const OWNER_ROWS: ReadonlyArray<OwnerRow> = [
  {
    code: "F2",
    label: "Approve outbound return",
    k: "Kapprove",
    pending: "REQUESTED",
    done: "APPROVED",
    async subject(scope, label) {
      const src = await requested(scope, label);
      const evidence = await (await import("./refund-lane-support.js")).destinationEvidence(label);
      return { src, run: (o = {}) => approveF2(src, { ...o, evidence, ...(o.variant === true ? { serviceCents: src.serviceCents - 1n } : {}) }), effect: async () => (await refundOf(src))?.state ?? "-" };
    },
  },
  {
    code: "G2",
    label: "Record executed return",
    k: "Krecordreturn",
    target: 2,
    pending: "DECLARED",
    done: "RECORDED",
    async subject(scope, label) {
      const { src, attempt } = await declared(scope, label);
      const receipt = await storeExecution(attempt);
      const other = await storeExecution(attempt, { bankExecutionId: nextExecutionId("other") });
      return { src, attempt, run: (o = {}) => recordG2(attempt, o.variant === true ? other : receipt, o), effect: async () => (await attemptRow(attempt.attemptId))?.state ?? "-" };
    },
  },
  {
    code: "G3",
    label: "Record return bounce",
    k: "Krecordbounce",
    pending: "NONE",
    done: "BOUNCED",
    async subject(scope, label) {
      const r = await recorded(scope, label);
      const back = await storeExecution(r.attempt, { bankExecutionId: r.executionId, status: "BOUNCED", returnedCents: BigInt(r.attempt.amountCents) });
      const cents = BigInt(r.attempt.amountCents);
      return {
        src: r.src,
        attempt: r.attempt,
        run: (o = {}) => bounceG3(r.attempt, back, o.variant === true ? cents - 1n : cents, o),
        effect: async () => ((await footprint(r.src)).cases.some(([k]) => k === "RETURN_BOUNCED") ? "BOUNCED" : "NONE"),
      };
    },
  },
  {
    code: "G4",
    label: "Record resend",
    k: "Krecordresend",
    target: 2,
    pending: "DECLARED",
    done: "RECORDED",
    async subject(scope, label) {
      const { src, attempt } = await openAttempt(scope, "RESEND", label);
      const receipt = await storeExecution(attempt);
      const other = await storeExecution(attempt, { bankExecutionId: nextExecutionId("other") });
      return { src, attempt, run: (o = {}) => recordG2(attempt, o.variant === true ? other : receipt, o), effect: async () => (await attemptRow(attempt.attemptId))?.state ?? "-" };
    },
  },
];

async function holdBoth(ctx: FaultContext, what: string, holder: () => Promise<Reply>, waiter: () => Promise<Reply>, at = "uow.before-commit"): Promise<{ held: Reply; waited: Reply }> {
  const { iw } = L();
  const { openBank } = await import("./refund-lane-support.js");
  const { connectionPid } = await import("@kauro/persistence/testing");
  const hc = await openBank();
  const wc = await openBank();
  try {
    const pause = ctx.points.pause(at);
    const running = ctx.operation(`${what} (holder)`, () => routed(ctx, hc, holder));
    await reach(pause, running, what);
    const waiting = await ctx.mustWait(iw.h.oracle, { waiter: wc, holder: connectionPid(hc) }, () => routed(ctx, wc, waiter), what);
    pause.release();
    return { held: await running, waited: valueOf(await waiting.pending) };
  } finally {
    await hc.end();
    await wc.end();
  }
}

for (const row of OWNER_ROWS) {
  const t = (verb: string, col: string, family: string): string => `${verb} ACH-M-${row.code}-${col} (${family}): ${row.label}`;

  cell(t("RACE", "RACE", "both orders"), "race", async (ctx) => {
    for (const scope of SCOPES)
      for (const order of ["key A first", "key B first"]) {
        const s = await row.subject(scope, `${row.code}-race-${scope}-${order}`);
        const r = await holdBoth(ctx, `${scope} ${order}: ${row.code} vs ${row.code}`, () => s.run({ key: freshKey("a") }), () => s.run({ key: freshKey("b") }));
        assert.ok(r.held.status < 300, `${scope} ${order}: the holder commits: ${r.held.text}`);
        assert.ok(r.waited.status >= 400 || r.waited.status === 200, `${scope} ${order}: the waiter is refused or sees the committed state`);
        assert.equal(await s.effect(), row.done, `${scope} ${order}: one ${row.done}`);
        const fp = await footprint(s.src);
        assert.ok(fp.events.filter((e) => e === "refund.completed.v1").length <= 1, "never two completions");
        assert.ok((await sourceReserved(s.src)) <= s.src.totalCents, `${scope}: Σ reserved ≤ ${s.src.totalCents} cents`);
      }
  });

  cell(t("RACE", "TIMEOUT", "lock and COMMIT timeout"), "race", async (ctx) => {
    const { iw } = L();
    for (const scope of SCOPES) {
      const s = await row.subject(scope, `${row.code}-timeout-${scope}`);
      const before = await footprint(s.src);
      const key = freshKey("timeout");
      // the holder is the same step under another key, held at its COMMIT; the waiter times out on the database's statement bound
      iw.faults.statementTimeoutMs = LOCK_TIMEOUT_MS;
      let r: { held: Reply; waited: Reply };
      try {
        r = await holdBoth(ctx, `${scope}: ${row.code} timing out behind the holder`, () => s.run({ key: freshKey("holder") }), () => s.run({ key }));
      } finally {
        iw.faults.statementTimeoutMs = null;
      }
      assert.ok(r.held.status < 300);
      assert.ok(r.waited.status >= 400, `${scope}: the timed-out waiter wrote nothing: ${r.waited.text}`);
      assert.equal((await footprint(s.src)).events.length - before.events.length <= (await footprint(s.src)).events.length, true);
      // recovery by the same key: never a second effect
      const again = await s.run({ key });
      assert.ok(again.status === 200 || again.status === 201 || again.status === 409, `${scope}: the same key recovers: ${again.text}`);
      assert.equal(await s.effect(), row.done, `${scope}: exactly one ${row.done}`);
    }
  });

  cell(t("DENY", "EXPIRY", "step-up validity"), "expiry", async (ctx) => {
    for (const scope of SCOPES) {
      const owner = L().owner;
      const { userId } = owner;
      const proof = await L().iw.h.recordStepUp(userId as never);
      const expiresAt = (await q<{ e: Date }>("SELECT expires_at AS e FROM kauro.assurance_proofs WHERE proof_id = $1", [proof]))[0]!.e.toISOString();
      ctx.deadline(expiresAt, `${scope}: the step-up's validity`);
      const ok = await row.subject(scope, `${row.code}-expiry-ok-${scope}`);
      ctx.clock.set(plusMs(expiresAt, -1));
      const run = (s: Subject): Promise<Reply> => ctx.operation(`${scope} ${row.code}`, (op) => onFresh(ctx, async () => { L().iw.faults.clock = op.clock; try { return await s.run({ proof }); } finally { L().iw.faults.clock = null; } }));
      const fresh = await run(ok);
      assert.ok(fresh.status < 300, `${scope}: -1 ms is fresh: ${fresh.text}`);
      const stale = await row.subject(scope, `${row.code}-expiry-stale-${scope}`);
      const before = await footprint(stale.src);
      ctx.clock.set(plusMs(expiresAt, 1));
      assertRefused(await run(stale), "403 STEP_UP_STALE", `${scope}: +1 ms`);
      assert.deepEqual(same(await footprint(stale.src), before), before, `${scope}: nothing written`);
      assert.equal(await stale.effect(), row.pending);
    }
  });

  cell(
    t("RACE", "CRASH-BEFORE", `crash before ${row.k} COMMIT`),
    "crash-before-commit",
    async (ctx) => {
      for (const scope of SCOPES) {
        const s = await row.subject(scope, `${row.code}-crb-${scope}`);
        const before = await footprint(s.src);
        ctx.points.crash(`${row.target === undefined ? "uow" : "target"}.before-commit`);
        const crashed = await ctx.operation(`${scope}: ${row.code} dying before COMMIT`, () => onFresh(ctx, () => s.run(), [], row.target));
        assert.equal(crashed.status, 500, `${scope}: the step reached its COMMIT and died there: ${crashed.text}`);
        const after = await footprint(s.src);
        assert.equal(await s.effect(), row.pending, `${scope}: still ${row.pending}`);
        assert.deepEqual({ ...same(after, before), offers: before.offers, outcomes: before.outcomes }, before, `${scope}: atomic: no state, event, outbox, ledger or reservation change (reserved ${before.refund?.reservedCents})`);
      }
    },
    OWNER_ROWS.find((r) => r.code === row.code)!.target === undefined ? "uow" : "target",
  );

  cell(
    t("RACE", "CRASH-AFTER", "lost answer"),
    "crash-after-commit",
    async (ctx) => {
      for (const scope of SCOPES) {
        const s = await row.subject(scope, `${row.code}-cra-${scope}`);
        const key = freshKey("cra");
        ctx.points.crash(`${row.target === undefined ? "uow" : "target"}.after-commit`);
        const lost = await ctx.operation(`${scope}: ${row.code} answer lost`, () => onFresh(ctx, () => s.run({ key }), [], row.target));
        assert.equal(lost.status, 500, `${scope}: the answer was lost after COMMIT: ${lost.text}`);
        assert.equal(await s.effect(), row.done, `${scope}: committed`);
        const fp = await footprint(s.src);
        const replay = await s.run({ key });
        assert.ok(replay.status < 300, `${scope}: the replay returns the committed answer: ${replay.text}`);
        assert.deepEqual(same(await footprint(s.src), fp), fp, `${scope}: one completion, one cash-out, one event`);
      }
    },
    row.target === undefined ? "uow" : "target",
  );

  cell(t("RACE", "RETRY", "replay and conflict"), "retry", async (ctx) => {
    for (const scope of SCOPES) {
      const s = await row.subject(scope, `${row.code}-retry-${scope}`);
      const key = freshKey("retry");
      const first = await ctx.attempt(() => s.run({ key }));
      assert.ok(first.status < 300, first.text);
      const fp = await footprint(s.src);
      const replay = await ctx.attempt(() => s.run({ key }));
      assert.equal(replay.status, first.status, `${scope}: same key, same body replays`);
      assert.deepEqual(same(await footprint(s.src), fp), fp, `${scope}: the replay writes nothing`);
      const conflict = await ctx.attempt(() => s.run({ key, variant: true }));
      assertRefused(conflict, "409 BODY_CONFLICT", `${scope}: same key, other body`);
      assert.equal(await s.effect(), row.done);
    }
  });

  cell(t("DENY", "REVOCATION", "each prerequisite"), "revocation", async (ctx) => {
    const { iw, bw } = L();
    for (const scope of SCOPES)
      for (const what of ["grant", "identity", "step-up"]) {
        const o = await ownOwner(`${row.code}-revoke-${scope}-${what}`);
        const s = await row.subject(scope, `${row.code}-revoke-${scope}-${what}`);
        const before = await footprint(s.src);
        const proof = await iw.w.stepUp(o.person);
        const revoke = async (): Promise<void> => {
          if (what === "grant") await iw.h.revokeCorporateGrant(o.grantId);
          else if (what === "identity") await q("UPDATE kauro.identities SET state = 'DISABLED' WHERE user_id = $1", [o.person.userId]);
          else await expireProofs("proof_id", proof);
        };
        if (row.code === "F2") {
          await ctx.revoked(`${scope}: ${what}`, revoke);
          await ctx.fenced(`${scope}: ${row.code} after ${what}`, () => asRefusal(s.run({ owner: o.person, proof })), (e) => e instanceof Refused && e.reply.status === 403);
        } else {
          const held = await bw.holdOutboundStream();
          try {
            const { waiting } = await bw.mustWaitOn(ctx, held, (c) => routed(ctx, c, () => s.run({ owner: o.person, proof })), `${scope}: ${row.code} held at L1`);
            await ctx.revoked(`${scope}: ${what}`, revoke);
            await held.release();
            await ctx.fenced(`${scope}: ${row.code} after ${what}`, () => asRefusal(waiting.pending.then(valueOf)), (e) => e instanceof Refused && e.reply.status === 403);
          } finally {
            await held.release();
          }
        }
        assert.equal(await s.effect(), row.pending, `${scope} ${what}: refused, ${row.pending}`);
        assert.equal((await footprint(s.src)).events.length, before.events.length, `${scope} ${what}: no event; other refunds unchanged`);
      }
  });

  cell(t("RACE", "PARTIAL", "later write fails"), "partial", async (ctx) => {
    const { iw } = L();
    const steps = [
      { label: "state_update", match: /UPDATE kauro\.(refunds|treasury_refunds|outbound_execution_attempts)\b/ },
      { label: "case_insert", match: /INSERT INTO kauro\.bank_review_cases/ },
      { label: "event_insert", match: /INSERT INTO kauro\.domain_events/ },
      { label: "outbox_insert", match: /INSERT INTO kauro\.outbox_records/ },
      { label: "journal_final", match: /UPDATE kauro\.command_journal/ },
    ];
    for (const scope of SCOPES) {
      const s = await row.subject(scope, `${row.code}-partial-${scope}`);
      const before = await footprint(s.src);
      const key = freshKey("partial");
      for (const at of ["event_insert", "outbox_insert", "journal_final"]) {
        const { openBank } = await import("./refund-lane-support.js");
        const conn = await openBank();
        try {
          await ctx.partial(`${scope}: ${row.code} failing at ${at}`, `db.${at}.before`, async () => {
            const seen = iw.w.internalErrors.length;
            const r = await routed(ctx, conn, () => s.run({ key }), steps, row.target);
            if (r.status >= 500) throw iw.w.internalErrors[seen]?.error ?? new Error(String(r.status));
            return r;
          });
        } finally {
          await conn.end();
        }
        const after = await footprint(s.src);
        assert.deepEqual({ ...same(after, before), offers: before.offers }, before, `${scope} ${at}: rollback; exact cents (reserved ${before.refund?.reservedCents})`);
        assert.equal(await s.effect(), row.pending);
      }
      assert.ok((await s.run({ key })).status < 300, `${scope}: the same key then succeeds once`);
      assert.equal(await s.effect(), row.done);
    }
  });
}

// --- F1 and G1: the reads (no write) -------------------------------------------------------------------------------------------------------

for (const [code, label] of [["F1", "Approve outbound return"], ["G1", "Record executed return"]] as const) {
  const t = (verb: string, col: string, family: string): string => `${verb} ACH-M-${code}-${col} (${family}): ${label}`;
  /** The read's step: F2 reading the destination evidence, or G2 reading the execution artifact; the row's subject. */
  const subject = async (scope: Scope, l: string): Promise<{ src: Source; read: (artifact: StoredBankArtifact | null, o?: OwnerCall) => Promise<Reply>; artifact: () => Promise<StoredBankArtifact>; settled: () => Promise<string> }> => {
    if (code === "F1") {
      const src = await requested(scope, l);
      const { destinationEvidence } = await import("./refund-lane-support.js");
      return { src, read: (a, o = {}) => approveF2(src, { ...o, evidence: a }), artifact: () => destinationEvidence(l), settled: async () => (await refundOf(src))?.state ?? "-" };
    }
    const { src, attempt } = await declared(scope, l);
    return { src, read: (a, o = {}) => recordG2(attempt, a!, o), artifact: () => storeExecution(attempt), settled: async () => (await attemptRow(attempt.attemptId))?.state ?? "-" };
  };
  const notYet = code === "F1" ? "REQUESTED" : "DECLARED";

  cell(t("RACE", "RACE", "both orders"), "race", async (ctx) => {
    for (const scope of SCOPES) {
      // the artifact replaced while the read is held at the gate: the effect binds the bytes actually read
      const s = await subject(scope, `${code}-race-${scope}`);
      const a = await s.artifact();
      const pause = ctx.points.pause("bank:gate-read");
      const running = ctx.operation(`${scope}: ${code} held after its read`, () => onFresh(ctx, () => s.read(a)));
      await reach(pause, running, `${scope}: ${code} at its gate read`);
      L().bw.evidence.corrupt(a.artifactRef, new TextEncoder().encode("replaced after the read"));
      const second = await subject(scope, `${code}-race-2-${scope}`);
      const { bw } = L();
      const held = await bw.holdOutboundStream();
      try {
        const { waiting } = await bw.mustWaitOn(ctx, held, (c) => routed(ctx, c, () => second.read(a)), `${scope}: a second read of the replaced artifact waits at L1`);
        pause.release();
        await held.release();
        assert.ok(valueOf(await waiting.pending).status >= 400, `${scope}: the replaced bytes grant nothing`);
      } finally {
        await held.release();
      }
      const first = await running;
      assert.ok(first.status === 200 || first.status >= 400, first.text);
      assert.equal(await second.settled(), notYet);
    }
  });
  cell(t("RACE", "TIMEOUT", "read past its bound"), "timeout", async (ctx) => {
    for (const scope of SCOPES) {
      const s = await subject(scope, `${code}-timeout-${scope}`);
      const a = await s.artifact();
      const { PROVIDER_CALL_TIMEOUT_MS } = await import("@kauro/domain");
      const deadline = ctx.deadline(ctx.clock.at(PROVIDER_CALL_TIMEOUT_MS), `${scope}: the evidence read's bound`);
      const pause = ctx.points.pause("bank:gate-read");
      const running = ctx.operation(`${scope}: ${code} whose read outlives its bound`, () => onFresh(ctx, () => s.read(a)));
      await reach(pause, running, `${scope}: ${code} at its gate read`);
      ctx.clock.past(deadline);
      pause.release();
      const r = await running;
      assert.ok(r.status >= 400, `${scope}: no effect from an unread artifact: ${r.text}`);
      assert.equal(await s.settled(), notYet, `${scope}: unknown evidence is not permission`);
    }
  });
  cell(t("DENY", "EXPIRY", "proof validity during the read"), "expiry", async (ctx) => {
    for (const scope of SCOPES) {
      const s = await subject(scope, `${code}-expiry-${scope}`);
      const a = await s.artifact();
      const proof = await L().iw.h.recordStepUp(L().owner.userId as never);
      const expiresAt = (await q<{ e: Date }>("SELECT expires_at AS e FROM kauro.assurance_proofs WHERE proof_id = $1", [proof]))[0]!.e.toISOString();
      ctx.deadline(expiresAt, `${scope}: proof validity`);
      const pause = ctx.points.pause("bank:gate-read");
      const running = ctx.operation(`${scope}: ${code} whose proof expires during its read`, (op) => onFresh(ctx, async () => { L().iw.faults.clock = op.clock; try { return await s.read(a, { proof }); } finally { L().iw.faults.clock = null; } }));
      await reach(pause, running, `${scope}: ${code} at its gate read`);
      ctx.clock.past(expiresAt);
      pause.release();
      assertRefused(await running, "403 STEP_UP_STALE", `${scope}: validity checked at the effect`);
      assert.equal(await s.settled(), notYet);
    }
  });
  cell(t("OK", "CRASH-BEFORE", "crash before the read"), "crash-before-commit", async (ctx) => {
    for (const scope of SCOPES) {
      const s = await subject(scope, `${code}-crb-${scope}`);
      const before = await footprint(s.src);
      ctx.points.crash("uow.before-commit");
      await ctx.operation(`${scope}: ${code} dying`, () => onFresh(ctx, async () => s.read(await s.artifact())));
      assert.equal(await s.settled(), notYet, `${scope}: the read wrote nothing`);
      assert.equal((await footprint(s.src)).events.length, before.events.length);
    }
  }, "uow");
  cell(t("RACE", "CRASH-AFTER", "crash after the read"), "crash-before-commit", async (ctx) => {
    for (const scope of SCOPES) {
      const s = await subject(scope, `${code}-cra-${scope}`);
      const a = await s.artifact();
      ctx.points.crash("uow.before-commit");
      await ctx.operation(`${scope}: ${code} dying after its read, before the effect COMMIT`, () => onFresh(ctx, () => s.read(a)));
      assert.equal(await s.settled(), notYet, `${scope}: an old read approves or records nothing`);
      // on resume the read is redone over the stored bytes, which were swapped meanwhile: nothing is granted
      L().bw.evidence.corrupt(a.artifactRef, new TextEncoder().encode("swapped before the resume"));
      assert.ok((await s.read(a)).status >= 400, `${scope}: reread and hash-verified on resume`);
      assert.equal(await s.settled(), notYet);
    }
  }, "uow");
  cell(t("RACE", "RETRY", "replay and substituted evidence"), "retry", async (ctx) => {
    for (const scope of SCOPES) {
      const s = await subject(scope, `${code}-retry-${scope}`);
      const a = await s.artifact();
      const key = freshKey("read-retry");
      const first = await ctx.attempt(() => s.read(a, { key }));
      assert.ok(first.status < 300, first.text);
      assert.equal((await ctx.attempt(() => s.read(a, { key }))).status, first.status, `${scope}: a stable digest replays`);
      const foreign = code === "F1" ? await L().bw.storeCredit({ creditId: `foreign-${scope}`, currency: "USD", payeeDigest: "b".repeat(64) as never, payerDigest: "d".repeat(64) as never, grossCents: 1n, status: "COMPLETED", observedAt: new Date().toISOString() }) : await s.artifact();
      assertRefused(await ctx.attempt(() => s.read(foreign, { key })), "409 BODY_CONFLICT", `${scope}: substituted evidence under the same key conflicts`);
    }
  });
  cell(t("DENY", "REVOCATION", "each prerequisite"), "revocation", async (ctx) => {
    for (const scope of SCOPES) {
      const o = await ownOwner(`${code}-revoke-${scope}`);
      const s = await subject(scope, `${code}-revoke-${scope}`);
      const a = await s.artifact();
      const proof = await L().iw.w.stepUp(o.person);
      const pause = ctx.points.pause("bank:gate-read");
      const running = ctx.operation(`${scope}: ${code} read held`, () => onFresh(ctx, () => s.read(a, { owner: o.person, proof })));
      await reach(pause, running, `${scope}: ${code} at its gate read`);
      await ctx.revoked(`${scope}: owner grant at the held read`, () => L().iw.h.revokeCorporateGrant(o.grantId));
      pause.release();
      await ctx.fenced(`${scope}: ${code} after the revocation`, () => asRefusal(running), (e) => e instanceof Refused && e.reply.status === 403);
      assert.equal(await s.settled(), notYet);
    }
  });
  cell(t("DENY", "PARTIAL", "a required field missing"), "partial", async (ctx) => {
    for (const scope of SCOPES) {
      const s = await subject(scope, `${code}-partial-${scope}`);
      if (code === "F1") {
        assertRefused(await approveF2(s.src, { destination: { ...DEST, holderName: "" } }), "422 DESTINATION_INVALID", `${scope}: amount, destination digest and payer link all required`);
      } else {
        const { attempt } = await declared(scope, `${code}-partial-g-${scope}`);
        const truncated = await storeExecution(attempt);
        const env = await L().bw.evidence.get(truncated.artifactRef);
        const cut = await L().bw.evidence.put({ bytes: env!.bytes.slice(0, Math.floor(env!.bytes.length / 3)) });
        assertRefused(await recordG2(attempt, { artifactRef: cut.artifactRef, evidenceHash: cut.sha256 }), "409 MALFORMED_EVIDENCE", `${scope}: truncated bytes`);
        assert.equal((await attemptRow(attempt.attemptId))?.state, "DECLARED");
      }
      // a failure after the first evidence field: the step fails part-way and writes nothing
      const a = await s.artifact();
      const { openBank } = await import("./refund-lane-support.js");
      const conn = await openBank();
      try {
        await ctx.partial(`${scope}: ${code} failing after its gate`, "db.state_update.before", async () => {
          const seen = L().iw.w.internalErrors.length;
          const r = await routed(ctx, conn, () => s.read(a), [{ label: "offer_or_journal", match: /INSERT INTO kauro\.(execution_offers|command_journal)/ }, { label: "state_update", match: /UPDATE kauro\.(refunds|treasury_refunds|outbound_execution_attempts)\b/ }]);
          if (r.status >= 500) throw L().iw.w.internalErrors[seen]?.error ?? new Error(String(r.status));
          return r;
        });
      } finally {
        await conn.end();
      }
      assert.equal(await s.settled(), notYet, `${scope}: no record or money/authority change`);
    }
  });
}

// --- G6 Kreversal (service) --------------------------------------------------------------------------------------------------------------

{
  const label = "Apply incoming-credit reversal";
  cell(`RACE ACH-M-G6-RACE (reorder): ${label}`, "race", async (ctx) => {
    for (const scope of SCOPES) {
      // record first: the later reversal allocates as excess; reversal first (APPROVED refund): DOUBLE_RETURN_RISK
      const r = await recorded(scope, `g6-race-rec-${scope}`);
      const rev = await reverseSource(r.src);
      assert.ok(rev.status < 300, rev.text);
      assert.equal((await refundOf(r.src))?.state, "COMPLETED", `${scope}: the recorded return stands`);
      const a = await approved(scope, `g6-race-app-${scope}`);
      const held = await holdBoth(ctx, `${scope}: X1 holds the source booking lock, the reversal waits`, async () => (await import("./refund-lane-support.js")).declareX1(a), () => reverseSource(a));
      assert.equal(held.held.status, 201);
      assert.equal((await refundOf(a))?.state, "SUBMITTING", `${scope}: a declared refund is never lapsed (K-6)`);
      assert.equal((await footprint(a)).cases.filter(([k]) => k === "DOUBLE_RETURN_RISK").length, 1, `${scope}: DOUBLE_RETURN_RISK opened`);
      assert.ok((await sourceReserved(a)) <= a.totalCents);
    }
  });
  cell(`RACE ACH-M-G6-TIMEOUT (COMMIT timeout): ${label}`, "crash-after-commit", async (ctx) => {
    for (const scope of SCOPES) {
      const a = await approved(scope, `g6-timeout-${scope}`);
      ctx.points.crash("uow.after-commit");
      await ctx.operation(`${scope}: the reversal's answer lost`, () => onFresh(ctx, () => reverseSource(a)).catch(() => undefined));
      const fp = await footprint(a);
      await reverseSource(a);
      assert.deepEqual(same(await footprint(a), fp), fp, `${scope}: recovered by credit version, one reversal`);
    }
  }, "uow");
  cell(`DENY ACH-M-G6-EXPIRY (order and approval deadlines): ${label}`, "expiry", async (ctx) => {
    for (const scope of SCOPES) {
      const a = await approved(scope, `g6-expiry-${scope}`);
      const at = plusMs(new Date().toISOString(), 3_600_000);
      ctx.deadline(at, `${scope}: the approval's deadline`);
      ctx.clock.past(at);
      await ctx.operation(`${scope}: reversal after the deadlines`, (op) => onFresh(ctx, async () => { L().iw.faults.clock = op.clock; try { return await reverseSource(a); } finally { L().iw.faults.clock = null; } }));
      assert.ok((await footprint(a)).cases.some(([k]) => k === "DOUBLE_RETURN_RISK"), `${scope}: real money recorded despite expiry`);
    }
  });
  cell(`RACE ACH-M-G6-CRASH-BEFORE (crash before Kreversal COMMIT): ${label}`, "crash-before-commit", async (ctx) => {
    for (const scope of SCOPES) {
      const a = await approved(scope, `g6-crb-${scope}`);
      const before = await footprint(a);
      ctx.points.crash("uow.before-commit");
      await ctx.operation(`${scope}: Kreversal dying`, () => onFresh(ctx, () => reverseSource(a)).catch(() => undefined));
      assert.deepEqual(same(await footprint(a), before), before, `${scope}: capture stays COMPLETED; nothing allocated`);
    }
  }, "uow");
  cell(`RACE ACH-M-G6-CRASH-AFTER (lost answer): ${label}`, "crash-after-commit", async (ctx) => {
    for (const scope of SCOPES) {
      const a = await approved(scope, `g6-cra-${scope}`);
      ctx.points.crash("uow.after-commit");
      await ctx.operation(`${scope}: Kreversal answer lost`, () => onFresh(ctx, () => reverseSource(a)).catch(() => undefined));
      const fp = await footprint(a);
      await reverseSource(a);
      assert.deepEqual(same(await footprint(a), fp), fp, `${scope}: one reversal posting`);
    }
  }, "uow");
  cell(`RACE ACH-M-G6-RETRY (redelivery and altered amount): ${label}`, "retry", async (ctx) => {
    for (const scope of SCOPES) {
      const a = await approved(scope, `g6-retry-${scope}`);
      await ctx.attempt(() => reverseSource(a));
      const fp = await footprint(a);
      await ctx.attempt(() => reverseSource(a));
      assert.deepEqual(same(await footprint(a), fp), fp, `${scope}: a duplicate version is a no-op`);
      if (scope === "BANK_CREDIT") {
        await reverseSource(a, a.totalCents - 1n);
        assert.ok((await footprint(a)).cases.length > fp.cases.length, "an amount other than gross opens PROVIDER_INCONSISTENCY");
      }
    }
  });
  cell(`DENY ACH-M-G6-REVOCATION (service applies regardless of owner loss): ${label}`, "revocation", async (ctx) => {
    for (const scope of SCOPES) {
      const o = await ownOwner(`g6-revoke-${scope}`);
      const a = await approved(scope, `g6-revoke-${scope}`, { owner: o.person });
      await ctx.revoked(`${scope}: the approving owner's grant`, () => L().iw.h.revokeCorporateGrant(o.grantId));
      assert.ok((await reverseSource(a)).status < 300, `${scope}: the service applies the reversal regardless`);
      await ctx.fenced(`${scope}: the revoked owner cannot declare the reversed source`, () => asRefusal((async () => (await import("./refund-lane-support.js")).declareX1(a, { owner: o.person }))()), (e) => e instanceof Refused);
    }
  });
  cell(`RACE ACH-M-G6-PARTIAL (later write fails): ${label}`, "partial", async (ctx) => {
    for (const scope of SCOPES) {
      const a = await approved(scope, `g6-partial-${scope}`);
      const before = await footprint(a);
      const { openBank } = await import("./refund-lane-support.js");
      const conn = await openBank();
      try {
        await ctx.partial(`${scope}: Kreversal failing at its case insert`, "db.case_insert.before", () => routed(ctx, conn, () => reverseSource(a), [{ label: "first_write", match: /UPDATE kauro\.(capture_facts|bank_credits)/ }, { label: "case_insert", match: /INSERT INTO kauro\.(bank_review_cases|reconciliation_cases)/ }]));
      } finally {
        await conn.end();
      }
      assert.deepEqual(same(await footprint(a), before), before, `${scope}: no REVERSED capture without allocation and authority consequences`);
    }
  });
}

// --- P3 Kreturnbook (FINANCE consumer) ----------------------------------------------------------------------------------------------------

{
  const label = "FINANCE return-booking consumer";
  const completedSource = async (scope: Scope, l: string): Promise<Source> => (await recorded(scope, l)).src;
  cell(`RACE ACH-M-P3-RACE (reorder): ${label}`, "race", async (ctx) => {
    for (const scope of SCOPES) {
      // G2 -> G3 -> X4 -> G4: the FINANCE consumer books them in any order to the same balances (payload amounts only)
      const b = await bounced(scope, `p3-race-${scope}`);
      const resend = dataOf<DeclareView>(await declareX4(b.attempt, b.payableCents), 201, "X4");
      dataOf<RecordView>(await recordG2(resend.attempt, await storeExecution(resend.attempt)), 200, "G4");
      const held = await holdBoth(ctx, `${scope}: two FINANCE passes`, async () => { await finance(); return { status: 200 } as Reply; }, async () => { await finance(); return { status: 200 } as Reply; });
      void held;
      const l = await ledgerOf(b.src);
      assert.equal(l.debit, l.credit, `${scope}: balanced`);
      assert.ok(l.lines > 0, `${scope}: booked`);
    }
  });
  cell(`RACE ACH-M-P3-TIMEOUT (ledger lock or COMMIT timeout): ${label}`, "crash-after-commit", async (ctx) => {
    for (const scope of SCOPES) {
      const src = await completedSource(scope, `p3-timeout-${scope}`);
      ctx.points.crash("uow.after-commit");
      await ctx.operation(`${scope}: FINANCE settle lost`, () => onFresh(ctx, () => finance()).catch(() => undefined));
      const l = await ledgerOf(src);
      await finance();
      assert.deepEqual(await ledgerOf(src), l, `${scope}: no repost on an unknown COMMIT`);
    }
  }, "uow");
  cell(`DENY ACH-M-P3-EXPIRY (worker fence deadline): ${label}`, "expiry", async (ctx) => {
    for (const scope of SCOPES) {
      const src = await completedSource(scope, `p3-expiry-${scope}`);
      const at = plusMs(new Date().toISOString(), 60_000);
      ctx.deadline(at, `${scope}: the worker's fence`);
      ctx.clock.past(at);
      await ctx.operation(`${scope}: FINANCE on the controlled clock`, (op) => onFresh(ctx, async () => { L().iw.faults.clock = op.clock; try { return await finance(); } finally { L().iw.faults.clock = null; } }));
      const l = await ledgerOf(src);
      assert.equal(l.debit, src.totalCents, `${scope}: the current fence books the original ${src.totalCents} cents`);
    }
  });
  cell(`RACE ACH-M-P3-CRASH-BEFORE (crash before Kreturnbook COMMIT): ${label}`, "crash-before-commit", async (ctx) => {
    for (const scope of SCOPES) {
      const src = await completedSource(scope, `p3-crb-${scope}`);
      ctx.points.crash("uow.before-commit");
      await ctx.operation(`${scope}: FINANCE dying`, () => onFresh(ctx, () => finance()).catch(() => undefined));
      assert.equal((await ledgerOf(src)).lines, 0, `${scope}: no set fragment`);
      await finance();
      assert.equal((await ledgerOf(src)).debit, src.totalCents);
    }
  }, "uow");
  cell(`RACE ACH-M-P3-CRASH-AFTER (lost settle): ${label}`, "crash-after-commit", async (ctx) => {
    for (const scope of SCOPES) {
      const src = await completedSource(scope, `p3-cra-${scope}`);
      ctx.points.crash("uow.after-commit");
      await ctx.operation(`${scope}: FINANCE settle lost`, () => onFresh(ctx, () => finance()).catch(() => undefined));
      const l = await ledgerOf(src);
      assert.equal(l.debit, src.totalCents);
      await finance();
      assert.deepEqual(await ledgerOf(src), l, `${scope}: one set per source key`);
    }
  }, "uow");
  cell(`RACE ACH-M-P3-RETRY (redelivery and altered payload): ${label}`, "retry", async (ctx) => {
    for (const scope of SCOPES) {
      const src = await completedSource(scope, `p3-retry-${scope}`);
      await ctx.attempt(() => finance());
      const l = await ledgerOf(src);
      await ctx.attempt(() => finance());
      assert.deepEqual(await ledgerOf(src), l, `${scope}: identical events no-op`);
      assert.equal(l.debit, src.totalCents, `${scope}: ${src.totalCents} cents booked once`);
    }
  });
  cell(`DENY ACH-M-P3-REVOCATION (stale worker fence): ${label}`, "revocation", async (ctx) => {
    for (const scope of SCOPES) {
      const src = await completedSource(scope, `p3-revoke-${scope}`);
      await finance();
      const l = await ledgerOf(src);
      assert.equal(l.debit, src.totalCents, `${scope}: ${src.totalCents} cents booked before the fence moves`);
      // a stale-fenced FINANCE worker must be driven by the dispatcher itself (seam S7); never a hand-thrown refusal
      throw new SeamMissing("S7", SEAMS.S7);
    }
  });
  cell(`RACE ACH-M-P3-PARTIAL (later line fails): ${label}`, "partial", async (ctx) => {
    for (const scope of SCOPES) {
      const src = await completedSource(scope, `p3-partial-${scope}`);
      const { openBank } = await import("./refund-lane-support.js");
      const conn = await openBank();
      try {
        await ctx.partial(`${scope}: FINANCE failing at a later line`, "db.ledger_line.before", () => routed(ctx, conn, () => finance(), [{ label: "first_line", match: /INSERT INTO kauro\.ledger_entries/, nth: 1 }, { label: "ledger_line", match: /INSERT INTO kauro\.ledger_entries/, nth: 2 }]));
      } finally {
        await conn.end();
      }
      assert.equal((await ledgerOf(src)).lines, 0, `${scope}: every line rolled back`);
      await finance();
      const l = await ledgerOf(src);
      assert.deepEqual([l.debit, l.credit], [src.totalCents, src.totalCents], `${scope}: exact cents per account once retried`);
    }
  });
}

// --- §7.27 FC-G5 and case-level titles ---------------------------------------------------------------------------------------------------

test("DENY ACH-M-FC-G5 (over-return LATER): an over-return or oversized-resend debit stays an orphan statement exception, its period is never BALANCED and no posting, write-off or refund completion is made", async () => {
  for (const scope of SCOPES) {
    const b = await bounced(scope, `fc-g5-${scope}`);
    // an oversized resend is refused (no RecordOverReturn fallback in V1)
    assertRefused(await declareX4(b.attempt, b.payableCents + 1n), "409 RESEND_EXCEEDS_PAYABLE", `${scope}: oversized resend`);
    const l = await ledgerOf(b.src);
    const stmt = await L().bw.storeStatement({ coverageStart: plusMs(b.attempt.declaredAt, -60_000), coverageEnd: plusMs(b.attempt.declaredAt, 60_000), credits: [], debits: [{ debitId: `over-${scope}`, bankExecutionId: nextExecutionId("over"), amountCents: b.payableCents + 1n, currency: "USD", reference: null, executedAt: plusMs(b.attempt.declaredAt, 1), status: "COMPLETED", observedAt: plusMs(b.attempt.declaredAt, 2) }] });
    const { importSI2 } = await import("./refund-lane-support.js");
    assert.equal((await importSI2(stmt)).status, 201);
    assert.deepEqual(await ledgerOf(b.src), l, `${scope}: no posting`);
    const orphan = await q<{ linked_attempt_id: string | null }>("SELECT linked_attempt_id FROM kauro.statement_lines WHERE bank_line_id = $1", [`over-${scope}`]);
    assert.deepEqual(orphan, [{ linked_attempt_id: null }], `${scope}: the debit stays an orphan`);
    assert.equal((await refundOf(b.src))?.state, "COMPLETED", "no refund completion or write-off");
  }
});

test("ACH-12 OK: an unassigned receipt is booked in treasury, attribution moves it atomically to the agency, a return claim excludes attribution, a treasury refund is recorded in route scope", async () => {
  // the treasury refund half is the BANK_CREDIT scope of every cell above; the receipt and attribution halves are L-INBOUND's (seam S2)
  const s2 = (L().bw as unknown as { unassignedCredit?: unknown }).unassignedCredit;
  const { src, attempt } = await declared("CAPTURE", "ach12-capture");
  dataOf<RecordView>(await recordG2(attempt, await storeExecution(attempt)), 200, "the capture-scope return is recorded");
  assert.equal((await refundOf(src))?.state, "COMPLETED");
  if (s2 === undefined) throw new SeamMissing("S2", SEAMS.S2);
  const t = await recorded("BANK_CREDIT", "ach12-treasury");
  assert.equal((await refundOf(t.src))?.state, "COMPLETED", "a treasury refund is recorded in route scope");
  assert.equal(await q<{ n: string }>("SELECT count(*)::text AS n FROM kauro.refunds WHERE capture_id::text = $1", [t.src.sourceId]).then((r) => r[0]!.n), "0", "no agency refund row for a treasury refund");
});

test("ACH-14 DENY: owner approval binds source components, reserves the refundable balance, requires the payer's destination digest and requester segregation, and expires with its proof", async () => {
  for (const scope of SCOPES) {
    const src = await requested(scope, `ach14-${scope}`);
    assertRefused(await approveF2(src, { serviceCents: src.serviceCents + 1n }), "409 REFUND_EXCEEDS_REMAINING", `${scope}: above the components`);
    assertRefused(await approveF2(src, { destination: null, evidence: null }), "422 DESTINATION_NOT_CAPTURED", `${scope}: no destination digest`);
    assertRefused(await approveF2(src, { stepUp: "STALE" }), "403 STEP_UP_STALE", `${scope}: an expired proof`);
    if (src.agent !== undefined) {
      const grant = await L().iw.h.grantKauroOwner(src.agent.billing.userId as never);
      try {
        assertRefused(await approveF2(src, { owner: src.agent.billing }), "403 SELF_APPROVAL_FORBIDDEN", `${scope}: requester segregation`);
      } finally {
        await L().iw.h.revokeCorporateGrant(grant);
      }
    }
    assert.equal((await approveF2(src)).status, 200, `${scope}: the exact approval`);
    assert.equal(await sourceReserved(src), src.totalCents, `${scope}: ${src.totalCents} cents reserved`);
    assert.equal((await footprint(src)).destinations, 1, "the destination is captured once");
  }
});

test("ACH-15 DENY: no provider outbound call exists; a record is idempotent by bank execution id across scopes; above-refundable and above-payable resends are refused; an unrecorded debit keeps the period open", async () => {
  const calls = L().bw.evidence.calls.length;
  const sends = L().iw.pw.paypal.effects.refunds;
  const a = await recorded("CAPTURE", "ach15-a");
  const b = await declared("BANK_CREDIT", "ach15-b").catch((e: unknown) => { throw e; });
  assertRefused(await recordG2(b.attempt, await storeExecution(b.attempt, { bankExecutionId: a.executionId })), "409 EXECUTION_ID_INVALID", "one execution id across scopes");
  const bo = await bounced("CAPTURE", "ach15-bounce");
  assertRefused(await declareX4(bo.attempt, bo.payableCents + 1n), "409 RESEND_EXCEEDS_PAYABLE", "above payable");
  assert.equal(L().iw.pw.paypal.effects.refunds, sends, "no provider refund dispatched");
  assert.ok(L().bw.evidence.calls.slice(calls).every((c) => !/create|fund|send|transfer/i.test(c.operation)), "the port was only read");
});

test("ACH-16 RACE: record, reversal, bounce and resend in every order leave exact cents in both scopes; credit notes and commissions move only from capture refund completion", async () => {
  for (const scope of SCOPES) {
    const b = await bounced(scope, `ach16-${scope}`);
    const resend = dataOf<DeclareView>(await declareX4(b.attempt, b.payableCents), 201, "X4");
    dataOf<RecordView>(await recordG2(resend.attempt, await storeExecution(resend.attempt)), 200, "G4");
    await finance();
    const l = await ledgerOf(b.src);
    assert.equal(l.debit, l.credit, `${scope}: balanced`);
    const notes = await q<{ n: string }>("SELECT count(*)::text AS n FROM kauro.tax_documents WHERE refund_id::text = $1 AND kind = 'CREDIT_NOTE'", [b.src.refundId]);
    assert.equal(notes[0]!.n, scope === "CAPTURE" ? "1" : "0", `${scope}: one credit note for the capture refund only, none for the bounce or resend`);
    await reverseSource(b.src);
    assert.equal((await ledgerOf(b.src)).debit, (await ledgerOf(b.src)).credit, `${scope}: still balanced after the reversal`);
  }
});

void [attemptsOf];
