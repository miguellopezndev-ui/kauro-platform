// Lane L-INBOUND: the V1 inbound rows of docs/design/ACH-ROUTE.md r12 — C5 (§7.5), C4/C6 (§7.6), M1/M2 (§7.9), P1 (§7.10), P2 (§7.11),
// E1 (§7.12), SI1/SI2 (§7.23), P1Δ (§7.24), FC-V/FC-API (§7.27), SI2-UNDECLARED (§7.28) — and the case titles ACH-04..11, 13, 20, 21, 22 of
// docs/design/ACH-case-map.md (ACH-12 is L-REFUND's file). Titles follow §7: `<VERB> ACH-M-<row>-<column> (<family>): <row label>`, the
// row label being the §7 heading less "command". Design path note: the design names packages/persistence/test/ach-inbound-cells.test.ts;
// the cells need the composed api and bankWorld (apps/api/test), so they live here, like L-ROUTE's and L-REFUND's.
// Written test-first: red on KIT a6e64be (no inbound command, consumer, sweep or table exists there; every cell needing an order also
// needs L-ROUTE's I2). The contract, the new closed reasons and the seams are in inbound-lane-support.ts.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PROVIDER_CALL_TIMEOUT_MS } from "@kauro/domain";
import { LOCK_WAIT_OBSERVATION_MS, openConnection, runCell, type FaultContext, type FaultKind, type HarnessConnection } from "@kauro/persistence/testing";
import { BANK_HOLD_POINTS } from "./bank-support.js";
import type { SqlStep } from "./fault-support.js";
import { agentOf } from "./integration-support.js";
import { call, freshKey, routes, type Reply } from "./support.js";
import {
  L,
  OWNER_PREREQUISITES,
  SEAMS,
  SeamMissing,
  applyService,
  attributeM2,
  awaitingOrder,
  code,
  confirmC6,
  confirmed,
  count,
  coverageOf,
  creditArtifact,
  creditRow,
  creditsOfTxn,
  dataOf,
  disableRoute,
  drafted,
  enterC5,
  exactFor,
  expirySweep,
  finance,
  footprint,
  holdAndWait,
  importSI2,
  importsOf,
  inboundRoutes,
  ledgerByAccount,
  matchService,
  nextTxn,
  onClock,
  onFresh,
  openPay,
  orderState,
  ownOwner,
  ownerGet,
  paid,
  plusMs,
  proofOf,
  q,
  reach,
  revokeOwner,
  routeFor,
  routed,
  settleCredit,
  startLane,
  statementArtifact,
  statementLines,
  stopLane,
  valueOf,
  type CreditFacts,
  type CreditView,
  type Footprint,
  type ImportView,
  type Order,
  type OwnerCall,
  type Route,
} from "./inbound-lane-support.js";

before(async () => {
  await startLane();
});
after(async () => {
  await stopLane();
});

const LOCK_TIMEOUT_MS = Math.floor(LOCK_WAIT_OBSERVATION_MS / 4);
const HOUR = 3_600_000;
function cell(title: string, fault: FaultKind, body: (ctx: FaultContext) => Promise<void>, at?: string): void {
  test(title, async () => {
    await runCell({ id: title.split(" ")[1]!, step: title, fault, ...(at === undefined ? {} : { at }), expect: title.slice(title.indexOf(": ") + 2) }, body);
  });
}
/** A refusal the harness's `fenced` accepts: the reply of a refused command. */
class Refused extends Error {
  constructor(readonly reply: Reply) {
    super(`${reply.status} ${reply.text}`);
  }
}
const refusedAs = (expected: string) => (e: unknown): boolean => e instanceof Refused && code(e.reply) === expected;
const asRefusal = async (p: Promise<Reply>): Promise<Reply> => {
  const r = await p;
  if (r.status >= 400) throw new Refused(r);
  return r;
};
/** A service step that recorded the money but issued no authority: the harness's refusal for P1's "deny authority" outcomes. */
class AuthorityDenied extends Error {}
const isAuthorityDenied = (e: unknown): boolean => e instanceof AuthorityDenied;
const sameButJournal = (a: Footprint, b: Footprint): Footprint => ({ ...a, journal: b.journal });
/** Standalone credit facts on a route (no order: the C/SI rows). */
const standalone = (label: string, over: Partial<CreditFacts> = {}): CreditFacts => ({ bankTransactionId: nextTxn(label), rail: "ACH", grossCents: 125_000n, feeCents: 0n, currency: "USD", reference: null, payerDigest: null, bookedAt: new Date(Date.now() - 10 * 60_000).toISOString(), status: "COMPLETED", ...over });
const anyRoute = async (label: string): Promise<Route> => routeFor(label, [L().iw.w.A.agencyId]);

// --- the owner command rows C5, C6, M2, SI2 ---------------------------------------------------------------------------------------------

interface Subject {
  readonly accountRef: string;
  readonly orderId?: string;
  run(o?: OwnerCall & { readonly variant?: boolean }): Promise<Reply>;
  effect(): Promise<string>;
}
interface OwnerRow {
  readonly code: "C5" | "C6" | "M2" | "SI2";
  readonly label: string;
  readonly k: string;
  readonly pending: string;
  readonly done: string;
  /** What a second actor that lost (another key, same subject) is answered. */
  readonly loser: string;
  /** The statements a PARTIAL cell instruments: its first write (completed), then the later writes it fails at. */
  readonly first: RegExp;
  readonly lock: "INBOUND" | "OUTBOUND";
  subject(label: string): Promise<Subject>;
}

const LATER_WRITES: ReadonlyArray<SqlStep> = [
  { label: "event_insert", match: /INSERT INTO kauro\.domain_events/ },
  { label: "outbox_insert", match: /INSERT INTO kauro\.outbox_records/ },
  { label: "journal_final", match: /UPDATE kauro\.command_journal/ },
];

const OWNER_ROWS: ReadonlyArray<OwnerRow> = [
  {
    code: "C5",
    label: "Enter manual credit",
    k: "Kdraft",
    pending: "NONE",
    done: "DRAFT_MANUAL",
    loser: "409 PRECONDITION_FAILED CREDIT_ALREADY_ENTERED",
    first: /INSERT INTO kauro\.bank_credits/,
    lock: "INBOUND",
    async subject(label) {
      const route = await anyRoute(label);
      const f = standalone(label);
      const artifact = await creditArtifact(route.accountRef, f);
      return {
        accountRef: route.accountRef,
        run: (o = {}) => enterC5(route.accountRef, f, artifact, o, o.variant === true ? { grossCents: f.grossCents + 1n } : {}),
        effect: async () => (await creditsOfTxn(route.accountRef, f.bankTransactionId)).map((c) => c.state).join(",") || "NONE",
      };
    },
  },
  {
    code: "C6",
    label: "Confirm manual credit",
    k: "Kconfirm",
    pending: "DRAFT_MANUAL",
    done: "OBSERVED",
    loser: "409 STALE_VERSION -",
    first: /UPDATE kauro\.bank_credits/,
    lock: "INBOUND",
    async subject(label) {
      const route = await anyRoute(label);
      const { credit } = await drafted(route.accountRef, standalone(label));
      return { accountRef: route.accountRef, run: (o = {}) => confirmC6(credit.creditId, o.variant === true ? 2 : 1, o), effect: async () => (await creditRow(credit.creditId))?.state ?? "-" };
    },
  },
  {
    code: "M2",
    label: "Match or review credit",
    k: "Kmatch",
    pending: "MATCH_REVIEW",
    done: "MATCHED",
    loser: "409 STALE_VERSION -",
    first: /UPDATE kauro\.bank_credits/,
    lock: "INBOUND",
    async subject(label) {
      const o = await awaitingOrder(label);
      // the reference is missing: the service cannot match it, the owner attributes it with billing evidence
      const c = await confirmed(o.route.accountRef, exactFor(o, { reference: null }));
      await matchService(c.creditId);
      const row = await creditRow(c.creditId);
      assert.equal(row?.state, "MATCH_REVIEW", "a credit without its reference waits for review");
      return { accountRef: o.route.accountRef, orderId: o.orderId, run: (x = {}) => attributeM2(c.creditId, o.orderId, x.variant === true ? Number(row!.version) + 1 : Number(row!.version), x), effect: async () => (await creditRow(c.creditId))?.state ?? "-" };
    },
  },
  {
    code: "SI2",
    label: "Import statement coverage",
    k: "Kstatement",
    pending: "NONE",
    done: "IMPORTED",
    loser: "409 PRECONDITION_FAILED STATEMENT_ALREADY_IMPORTED",
    first: /INSERT INTO kauro\.statement_imports/,
    lock: "OUTBOUND",
    async subject(label) {
      const route = await anyRoute(label);
      const now = Date.now();
      const s = { from: new Date(now - 3 * HOUR).toISOString(), to: new Date(now - 60_000).toISOString(), credits: [standalone(`${label}-1`), standalone(`${label}-2`)], debits: [] };
      const artifact = await statementArtifact(route.accountRef, s);
      const other = await statementArtifact(route.accountRef, { ...s, credits: [standalone(`${label}-3`)] });
      return { accountRef: route.accountRef, run: (o = {}) => importSI2(route.accountRef, o.variant === true ? other : artifact, o), effect: async () => ((await importsOf(route.accountRef)) > 0 ? "IMPORTED" : "NONE") };
    },
  },
];

for (const row of OWNER_ROWS) {
  const t = (verb: string, col: string, family: string): string => `${verb} ACH-M-${row.code}-${col} (${family}): ${row.label}`;
  const fpOf = (s: Subject): Promise<Footprint> => footprint({ accountRef: s.accountRef, ...(s.orderId === undefined ? {} : { orderId: s.orderId }) });

  cell(t("RACE", "RACE", "both orders"), "race", async (ctx) => {
    for (const first of ["owner A holds", "owner B holds"]) {
      const s = await row.subject(`${row.code}-race-${first}`);
      const a = await ownOwner(`${row.code}-a-${first}`);
      const b = await ownOwner(`${row.code}-b-${first}`);
      const [holder, waiter] = first === "owner A holds" ? [a, b] : [b, a];
      const r = await holdAndWait(ctx, `${first}: ${row.code} vs ${row.code}`, () => s.run({ owner: holder.person, key: freshKey("holder") }), () => s.run({ owner: waiter.person, key: freshKey("waiter") }));
      assert.ok(valueOf(r.held).status < 300, `${first}: the holder commits: ${valueOf(r.held).text}`);
      assert.equal(code(valueOf(r.waited)), row.loser, `${first}: the waiter sees the committed ${row.done} and is refused`);
      assert.equal(await s.effect(), row.done, `${first}: exactly one ${row.done}`);
    }
    if (row.code === "SI2") {
      // vs C6 at the credit identity lock: a statement credit line and a manual confirmation of the same bank transaction are one credit
      for (const first of ["import holds", "confirmation holds"]) {
        const route = await anyRoute(`si2-c6-${first}`);
        const f = standalone(`si2-c6-${first}`);
        const { credit } = await drafted(route.accountRef, f);
        const st = await statementArtifact(route.accountRef, { from: new Date(Date.now() - 3 * HOUR).toISOString(), to: new Date(Date.now() - 60_000).toISOString(), credits: [f], debits: [] });
        const imp = () => importSI2(route.accountRef, st);
        const conf = () => confirmC6(credit.creditId);
        const r = await holdAndWait(ctx, `${first}: SI2 vs C6`, first === "import holds" ? imp : conf, first === "import holds" ? conf : imp);
        assert.ok(valueOf(r.held).status < 300 && valueOf(r.waited).status < 300, `${first}: both commit: ${valueOf(r.held).text} / ${valueOf(r.waited).text}`);
        assert.equal((await creditsOfTxn(route.accountRef, f.bankTransactionId)).length, 1, `${first}: one credit identity for ${f.bankTransactionId}`);
        assert.deepEqual((await statementLines(route.accountRef)).map((l) => l[1]), [f.bankTransactionId], `${first}: one statement line`);
      }
    }
  });

  cell(t("RACE", "TIMEOUT", "lock and COMMIT timeout"), "race", async (ctx) => {
    const { iw } = L();
    const s = await row.subject(`${row.code}-timeout`);
    const key = freshKey("timeout");
    iw.faults.statementTimeoutMs = LOCK_TIMEOUT_MS;
    let r: Awaited<ReturnType<typeof holdAndWait<Reply, Reply>>>;
    try {
      r = await holdAndWait(ctx, `${row.code} timing out behind the holder`, () => s.run({ key: freshKey("holder") }), () => s.run({ key }));
    } finally {
      iw.faults.statementTimeoutMs = null;
    }
    assert.ok(valueOf(r.held).status < 300, valueOf(r.held).text);
    const timedOut = valueOf(r.waited);
    assert.ok(timedOut.status >= 500, `the waiter timed out and wrote nothing: ${timedOut.status} ${timedOut.text}`);
    const fp = await fpOf(s);
    // recovery by the same key: never a second effect
    assert.equal(code(await s.run({ key })), row.loser, "the same key, once the holder committed, is the loser's answer");
    assert.equal(await s.effect(), row.done, `exactly one ${row.done}`);
    assert.deepEqual(sameButJournal(await fpOf(s), fp), fp, "the recovery wrote nothing");
  });

  cell(t("DENY", "EXPIRY", row.code === "SI2" ? "coverage end and route version" : "step-up validity"), "expiry", async (ctx) => {
    const { proof, expiresAt } = await proofOf();
    ctx.deadline(expiresAt, "the owner's step-up validity");
    const ok = await row.subject(`${row.code}-expiry-ok`);
    ctx.clock.set(plusMs(expiresAt, -1));
    const fresh = await onClock(ctx, `${row.code} 1 ms before the proof expires`, () => ok.run({ proof }));
    assert.ok(fresh.status < 300, `-1 ms is fresh: ${fresh.text}`);
    assert.equal(await ok.effect(), row.done);
    const stale = await row.subject(`${row.code}-expiry-stale`);
    const before = await fpOf(stale);
    ctx.clock.set(plusMs(expiresAt, 1));
    assert.equal(code(await onClock(ctx, `${row.code} 1 ms after the proof expired`, () => stale.run({ proof }))), "403 ASSURANCE_REQUIRED STEP_UP_STALE", "+1 ms: judged at the effect clock");
    assert.deepEqual(sameButJournal(await fpOf(stale), before), before, "nothing written");
    assert.equal(await stale.effect(), row.pending);
    if (row.code === "SI2") {
      const route = await anyRoute("si2-expiry-cov");
      const future = await statementArtifact(route.accountRef, { from: new Date(Date.now() - HOUR).toISOString(), to: new Date(Date.now() + HOUR).toISOString(), credits: [standalone("si2-future")], debits: [] });
      assert.equal(code(await importSI2(route.accountRef, future)), "409 PRECONDITION_FAILED COVERAGE_END_IN_FUTURE", "to > effectNow");
      const ancient = await statementArtifact(route.accountRef, { from: "2020-01-01T00:00:00.000Z", to: "2020-01-31T00:00:00.000Z", credits: [standalone("si2-ancient")], debits: [] });
      assert.equal(code(await importSI2(route.accountRef, ancient)), "409 PRECONDITION_FAILED COVERAGE_OUTSIDE_ROUTE_VERSION", "before the account's route version");
      assert.equal(await importsOf(route.accountRef), 0, "no coverage, no line");
      assert.deepEqual(await statementLines(route.accountRef), []);
    }
  });

  cell(
    t("RACE", "CRASH-BEFORE", `crash before ${row.k} COMMIT`),
    "crash-before-commit",
    async (ctx) => {
      const s = await row.subject(`${row.code}-crb`);
      const before = await fpOf(s);
      ctx.points.crash("uow.before-commit");
      const crashed = await ctx.operation(`${row.code} dying before COMMIT`, () => onFresh(ctx, () => s.run()));
      assert.equal(crashed.status, 500, `the step reached its COMMIT and died there: ${crashed.text}`);
      assert.equal(await s.effect(), row.pending, `still ${row.pending}`);
      assert.deepEqual(await fpOf(s), before, "atomic: no credit, line, case, event, outbox, journal or ledger change");
    },
    "uow",
  );

  cell(
    t("RACE", "CRASH-AFTER", "lost answer"),
    "crash-after-commit",
    async (ctx) => {
      const s = await row.subject(`${row.code}-cra`);
      const key = freshKey("cra");
      ctx.points.crash("uow.after-commit");
      const lost = await ctx.operation(`${row.code} answer lost`, () => onFresh(ctx, () => s.run({ key })));
      assert.equal(lost.status, 500, `the answer was lost after COMMIT: ${lost.text}`);
      assert.equal(await s.effect(), row.done, "committed");
      const fp = await fpOf(s);
      const replay = await s.run({ key });
      assert.ok(replay.status < 300, `the same key returns the committed answer: ${replay.text}`);
      assert.deepEqual(sameButJournal(await fpOf(s), fp), fp, "one effect, one event, no capture");
      assert.equal(fp.captures.length, 0, "an owner command never captures");
    },
    "uow",
  );

  cell(t("RACE", "RETRY", "replay and conflict"), "retry", async (ctx) => {
    const s = await row.subject(`${row.code}-retry`);
    const key = freshKey("retry");
    const first = await ctx.attempt(() => s.run({ key }));
    assert.ok(first.status < 300, first.text);
    const fp = await fpOf(s);
    // (1) identical replay
    const replay = await ctx.attempt(() => s.run({ key }));
    assert.equal(replay.status, first.status, "same key, same body: the same answer");
    assert.equal(replay.text, first.text, "the same body");
    assert.deepEqual(sameButJournal(await fpOf(s), fp), fp, "the replay writes nothing");
    // (2) same key, other body
    assert.equal(code(await ctx.attempt(() => s.run({ key, variant: true }))), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
    // (3) a new key on the same subject
    assert.equal(code(await ctx.attempt(() => s.run({ key: freshKey("again") }))), row.loser, "a new key cannot make a second effect");
    assert.equal(await s.effect(), row.done);
    assert.deepEqual(sameButJournal(await fpOf(s), fp), fp);
    if (row.code === "SI2") {
      const route = await anyRoute("si2-changed-line");
      const f = standalone("si2-line");
      const span = { from: new Date(Date.now() - 3 * HOUR).toISOString(), to: new Date(Date.now() - 60_000).toISOString(), debits: [] };
      dataOf<{ import: ImportView }>(await importSI2(route.accountRef, await statementArtifact(route.accountRef, { ...span, credits: [f] })), 201, "the first import");
      const overlapping = dataOf<{ import: ImportView }>(await importSI2(route.accountRef, await statementArtifact(route.accountRef, { ...span, credits: [f, standalone("si2-line-2")] })), 201, "an overlapping import").import;
      assert.equal(overlapping.newLines, 1, "an identical overlapping line adds nothing");
      const changed = await statementArtifact(route.accountRef, { ...span, credits: [{ ...f, grossCents: f.grossCents + 100n }] });
      assert.equal(code(await importSI2(route.accountRef, changed)), "409 PRECONDITION_FAILED PROVIDER_INCONSISTENCY", "a changed immutable amount is never an overwrite");
      assert.deepEqual((await statementLines(route.accountRef)).filter((l) => l[1] === f.bankTransactionId).map((l) => l[2]), [f.grossCents.toString()], `the recorded ${f.grossCents} cents of ${f.bankTransactionId} are unchanged`);
    }
  });

  cell(t("DENY", "REVOCATION", "each prerequisite"), "revocation", async (ctx) => {
    const { bw } = L();
    for (const what of OWNER_PREREQUISITES) {
      const o = await ownOwner(`${row.code}-revoke-${what}`);
      const s = await row.subject(`${row.code}-revoke-${what}`);
      const before = await fpOf(s);
      const { proof } = await proofOf(o.person);
      const held = row.lock === "OUTBOUND" ? await bw.holdOutboundStream() : await bw.holdInboundStream();
      try {
        const { waiting } = await bw.mustWaitOn(ctx, held, (c) => routed(ctx, c, () => s.run({ owner: o.person, proof })), `${row.code} held at its first lock`);
        await ctx.revoked(`${what} while ${row.code} is held`, () => revokeOwner(what, o, proof));
        await held.release();
        const expected = what === "grant" ? "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING" : what === "identity" ? "403 NOT_AUTHORIZED IDENTITY_DISABLED" : "403 ASSURANCE_REQUIRED STEP_UP_STALE";
        await ctx.fenced(`${row.code} after the ${what} was withdrawn`, () => asRefusal(waiting.pending.then(valueOf)), refusedAs(expected));
      } finally {
        await held.release();
      }
      assert.equal(await s.effect(), row.pending, `${what}: refused, still ${row.pending}`);
      assert.deepEqual(sameButJournal(await fpOf(s), before), before, `${what}: nothing written`);
    }
    // an agency BILLING member is no corporate owner
    const a = await agentOf(L().iw, `${row.code}-billing`);
    const s = await row.subject(`${row.code}-revoke-billing`);
    assert.equal(code(await s.run({ owner: a.billing, agency: a.s.agency.agencyId })), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING", "agency billing is refused");
    assert.equal(await s.effect(), row.pending);
  });

  cell(t("RACE", "PARTIAL", "later write fails"), "partial", async (ctx) => {
    const { iw } = L();
    const s = await row.subject(`${row.code}-partial`);
    const before = await fpOf(s);
    const key = freshKey("partial");
    const steps: ReadonlyArray<SqlStep> = [{ label: "first_write", match: row.first }, ...LATER_WRITES];
    for (const at of ["event_insert", "outbox_insert", "journal_final"]) {
      const conn = await openPay();
      try {
        await ctx.partial(`${row.code} failing at ${at}`, `db.${at}.before`, async () => {
          const seen = iw.w.internalErrors.length;
          const r = await routed(ctx, conn, () => s.run({ key }), steps);
          if (r.status >= 500) throw iw.w.internalErrors[seen]?.error ?? new Error(String(r.status));
          return r;
        });
      } finally {
        await conn.end();
      }
      assert.deepEqual(sameButJournal(await fpOf(s), before), before, `${at}: the whole footprint rolled back`);
      assert.equal(await s.effect(), row.pending, `${at}: still ${row.pending}`);
    }
    assert.ok((await s.run({ key })).status < 300, "the same key then succeeds once");
    assert.equal(await s.effect(), row.done);
  });
}

// --- C4: the confirmation's outside-transaction evidence read ---------------------------------------------------------------------------

{
  const t = (verb: string, col: string, family: string): string => `${verb} ACH-M-C4-${col} (${family}): Confirm manual credit`;
  const draft = async (label: string) => {
    const route = await anyRoute(label);
    const f = standalone(label);
    const d = await drafted(route.accountRef, f);
    return { route, f, ...d, state: async () => (await creditRow(d.credit.creditId))?.state ?? "-" };
  };
  /** Runs `fn` with `hook` before every read of `artifactRef` from the store (pause, crash, delay); restored after. */
  async function withStoreHook<T>(artifactRef: string, hook: () => Promise<void>, fn: () => Promise<T>): Promise<T> {
    const store = L().bw.evidence as unknown as { get: (ref: string) => Promise<unknown> };
    const real = store.get;
    store.get = async (ref: string) => {
      if (ref === artifactRef) await hook();
      return real.call(L().bw.evidence, ref);
    };
    try {
      return await fn();
    } finally {
      store.get = real;
    }
  }

  cell(t("RACE", "RACE", "artifact replaced, both orders"), "race", async (ctx) => {
    const { bw } = L();
    // replaced before the read: the confirmation waits at the INBOUND lock, the bytes change, it reads them and refuses
    const a = await draft("c4-race-replaced-first");
    const held = await bw.holdInboundStream();
    try {
      const { waiting } = await bw.mustWaitOn(ctx, held, (c) => routed(ctx, c, () => confirmC6(a.credit.creditId)), "C6 waits before its read");
      bw.evidence.corrupt(a.artifact.artifactRef, new TextEncoder().encode("replaced"));
      await held.release();
      assert.equal(code(valueOf(await waiting.pending)), "422 INTEGRITY_FAILURE HASH_MISMATCH", "the replaced bytes grant nothing");
    } finally {
      await held.release();
    }
    assert.equal(await a.state(), "DRAFT_MANUAL");
    // read first: the verified bytes are bound; the replacement after the read changes nothing it confirmed
    const b = await draft("c4-race-read-first");
    const pause = ctx.points.pause(BANK_HOLD_POINTS.GATE_READ);
    const running = ctx.operation("C6 held after its read", () => onFresh(ctx, () => confirmC6(b.credit.creditId)));
    await reach(pause, running, "C6 at its gate read");
    bw.evidence.corrupt(b.artifact.artifactRef, new TextEncoder().encode("replaced after the read"));
    const held2 = await bw.holdInboundStream();
    try {
      pause.release();
      const conn = await openPay();
      try {
        await ctx.mustWait(L().iw.h.oracle, { waiter: conn, holder: held2.pid }, (c) => c.query("SELECT pg_advisory_xact_lock(kauro.bank_stream_lock_key($1, $2, 'INBOUND'))", [bw.environment, b.route.accountRef]), "a second actor waits behind the same lock");
      } finally {
        await conn.end().catch(() => undefined);
      }
      await held2.release();
    } finally {
      await held2.release();
    }
    const r = await running;
    assert.equal(r.status, 200, `the bytes verified at the read are confirmed: ${r.text}`);
    assert.equal(r.json<{ data: { credit: CreditView } }>().data.credit.grossCents, b.f.grossCents.toString(), "the confirmed gross is the verified artifact's");
  });

  cell(t("RACE", "TIMEOUT", "read past its bound"), "timeout", async (ctx) => {
    const a = await draft("c4-timeout");
    const deadline = ctx.deadline(ctx.clock.at(PROVIDER_CALL_TIMEOUT_MS), "the evidence read's bound");
    const r = await withStoreHook(a.artifact.artifactRef, async () => void ctx.clock.past(deadline), () => onClock(ctx, "C6 whose read outlives its bound", () => confirmC6(a.credit.creditId)));
    assert.equal(code(r), "503 CAPACITY_UNAVAILABLE EVIDENCE_UNAVAILABLE", "unread evidence cannot mint money");
    assert.equal(await a.state(), "DRAFT_MANUAL");
    assert.equal(await count("SELECT 1 FROM kauro.capture_facts WHERE provider_capture_id LIKE $1", [`%${a.f.bankTransactionId}%`]), 0);
  });

  cell(t("DENY", "EXPIRY", "proof validity during the read"), "expiry", async (ctx) => {
    const a = await draft("c4-expiry");
    const { proof, expiresAt } = await proofOf();
    ctx.deadline(expiresAt, "the proof's validity");
    ctx.clock.set(plusMs(expiresAt, -1));
    const r = await withStoreHook(a.artifact.artifactRef, async () => void ctx.clock.past(expiresAt), () => onClock(ctx, "C6 whose proof expires during its read", () => confirmC6(a.credit.creditId, 1, { proof })));
    assert.equal(code(r), "403 ASSURANCE_REQUIRED STEP_UP_STALE", "proof current at the effect");
    assert.equal(await a.state(), "DRAFT_MANUAL");
  });

  cell(
    t("OK", "CRASH-BEFORE", "crash before the comparison"),
    "crash-before-commit",
    async (ctx) => {
      const a = await draft("c4-crb");
      ctx.points.crash("uow.before-commit");
      const r = await ctx.operation("C6 dying after its read", () => onFresh(ctx, () => confirmC6(a.credit.creditId)));
      assert.equal(r.status, 500, r.text);
      assert.equal(await a.state(), "DRAFT_MANUAL", "a draft alone grants nothing");
      assert.equal(dataOf<{ credit: CreditView }>(await confirmC6(a.credit.creditId), 200, "the retry rereads and confirms").credit.state, "OBSERVED");
    },
    "uow",
  );

  cell(
    t("RACE", "CRASH-AFTER", "crash after the read"),
    "crash-before-commit",
    async (ctx) => {
      const a = await draft("c4-cra");
      const key = freshKey("c4-cra");
      ctx.points.crash("uow.before-commit");
      assert.equal((await ctx.operation("C6 dying after its read and classification", () => onFresh(ctx, () => confirmC6(a.credit.creditId, 1, { key })))).status, 500);
      // the artifact changes before the resume: an old read is no confirmation
      L().bw.evidence.corrupt(a.artifact.artifactRef, new TextEncoder().encode("changed before the resume"));
      assert.equal(code(await confirmC6(a.credit.creditId, 1, { key })), "422 INTEGRITY_FAILURE HASH_MISMATCH", "the resume rereads and reverifies the bytes");
      assert.equal(await a.state(), "DRAFT_MANUAL");
    },
    "uow",
  );

  cell(t("DENY", "RETRY", "replay and rejected evidence"), "retry", async (ctx) => {
    const { bw } = L();
    const ok = await draft("c4-retry-ok");
    const key = freshKey("c4-retry");
    const first = await ctx.attempt(() => confirmC6(ok.credit.creditId, 1, { key }));
    const again = await ctx.attempt(() => confirmC6(ok.credit.creditId, 1, { key }));
    assert.equal(again.text, first.text, "the same verified envelope classifies identically");
    const cases: ReadonlyArray<readonly [string, (accountRef: string, f: CreditFacts) => Promise<{ artifactRef: string; evidenceHash: string }>]> = [
      ["422 INTEGRITY_FAILURE UNKNOWN_EVIDENCE", async (acct) => { const p = await bw.evidence.put({ bytes: new TextEncoder().encode(JSON.stringify({ format: "other-bank/9", kind: "CREDIT" })), accountRef: acct as never }); return { artifactRef: p.artifactRef, evidenceHash: p.sha256 }; }],
      ["422 INTEGRITY_FAILURE MALFORMED_EVIDENCE", async (acct, f) => { const p = await bw.evidence.put({ bytes: new TextEncoder().encode(`{"format":"contract-fake-bank-evidence/1","kind":"CREDIT","accountRef":"${acct}","credit":{"creditId":"${f.bankTransactionId}"`), accountRef: acct as never }); return { artifactRef: p.artifactRef, evidenceHash: p.sha256 }; }],
      ["422 INTEGRITY_FAILURE UNAUTHENTICATED_EVIDENCE", async (acct, f) => { const { fakeCreditBytes } = await import("@kauro/application/testing"); const p = await bw.evidence.put({ bytes: fakeCreditBytes(acct, { creditId: f.bankTransactionId, currency: "USD", grossCents: f.grossCents, payeeDigest: "b".repeat(64) as never, observedAt: f.bookedAt, bookedAt: f.bookedAt, status: "COMPLETED", rail: "ACH" }), accountRef: acct as never, authenticatedBy: "OWNER_DECLARED" as never }); return { artifactRef: p.artifactRef, evidenceHash: p.sha256 }; }],
    ];
    for (const [expected, make] of cases) {
      const route = await anyRoute(`c4-retry-${expected}`);
      const f = standalone(`c4-retry-${expected}`);
      const artifact = await make(route.accountRef, f);
      const credit = dataOf<{ credit: CreditView }>(await enterC5(route.accountRef, f, artifact), 201, "the draft names the artifact").credit;
      const before = await footprint({ accountRef: route.accountRef });
      assert.equal(code(await ctx.attempt(() => confirmC6(credit.creditId))), expected);
      assert.deepEqual(sameButJournal(await footprint({ accountRef: route.accountRef }), before), before, `${expected}: nothing written`);
    }
    const sub = await draft("c4-retry-substituted");
    bw.evidence.corrupt(sub.artifact.artifactRef, new TextEncoder().encode("substituted"));
    assert.equal(code(await ctx.attempt(() => confirmC6(sub.credit.creditId))), "422 INTEGRITY_FAILURE HASH_MISMATCH");
    assert.equal(await sub.state(), "DRAFT_MANUAL");
  });

  cell(t("DENY", "REVOCATION", "each prerequisite at the held read"), "revocation", async (ctx) => {
    for (const what of OWNER_PREREQUISITES) {
      const a = await draft(`c4-revoke-${what}`);
      const o = await ownOwner(`c4-revoke-${what}`);
      const { proof } = await proofOf(o.person);
      const pause = ctx.points.pause(BANK_HOLD_POINTS.GATE_READ);
      const running = ctx.operation(`C6 held at its read (${what})`, () => onFresh(ctx, () => confirmC6(a.credit.creditId, 1, { owner: o.person, proof })));
      await reach(pause, running, `C6 at its gate read (${what})`);
      await ctx.revoked(`${what} at the held read`, () => revokeOwner(what, o, proof));
      pause.release();
      const expected = what === "grant" ? "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING" : what === "identity" ? "403 NOT_AUTHORIZED IDENTITY_DISABLED" : "403 ASSURANCE_REQUIRED STEP_UP_STALE";
      await ctx.fenced(`C6 after the ${what} was withdrawn`, () => asRefusal(running), refusedAs(expected));
      assert.equal(await a.state(), "DRAFT_MANUAL");
    }
  });

  cell(t("DENY", "PARTIAL", "the read fails after the draft read"), "partial", async (ctx) => {
    const a = await draft("c4-partial");
    const before = await footprint({ accountRef: a.route.accountRef });
    await ctx.partial("C6 failing at its gate read, after its draft read completed", BANK_HOLD_POINTS.GATE_READ, () =>
      onFresh(ctx, async () => {
        const r = await confirmC6(a.credit.creditId);
        if (r.status >= 500) throw L().iw.w.internalErrors.at(-1)?.error ?? new Error(String(r.status));
        return r;
      }, [{ label: "draft_read", match: /FROM kauro\.bank_credits/ }]),
    );
    assert.deepEqual(sameButJournal(await footprint({ accountRef: a.route.accountRef }), before), before, "no partial normalized credit");
    // truncated bytes are MALFORMED: rejected, nothing written
    const route = await anyRoute("c4-partial-truncated");
    const f = standalone("c4-partial-truncated");
    const whole = await creditArtifact(route.accountRef, f);
    const credit = dataOf<{ credit: CreditView }>(await enterC5(route.accountRef, f, whole), 201, "draft").credit;
    const stored = (await L().bw.evidence.get(whole.artifactRef))!;
    L().bw.evidence.corrupt(whole.artifactRef, stored.bytes.slice(0, Math.floor(stored.bytes.length / 2)));
    assert.equal(code(await confirmC6(credit.creditId)), "422 INTEGRITY_FAILURE HASH_MISMATCH", "truncated stored bytes never classify");
    assert.equal((await creditRow(credit.creditId))?.state, "DRAFT_MANUAL");
  });
}

// --- M1: the service's reference/account/payer lookup ------------------------------------------------------------------------------------

{
  const t = (verb: string, col: string, family: string): string => `${verb} ACH-M-M1-${col} (${family}): Match or review credit`;
  const observedFor = async (label: string, over: Partial<CreditFacts> = {}) => {
    const o = await awaitingOrder(label);
    const c = await confirmed(o.route.accountRef, exactFor(o, over));
    return { o, c, state: async () => (await creditRow(c.creditId))?.state ?? "-" };
  };

  cell(t("RACE", "RACE", "redelivered match, both orders"), "race", async (ctx) => {
    for (const first of ["first delivery holds", "redelivery holds"]) {
      const { o, c, state } = await observedFor(`m1-race-${first}`);
      const r = await holdAndWait(ctx, `${first}: Kmatch vs Kmatch`, () => matchService(c.creditId), () => matchService(c.creditId));
      assert.ok(r.held.status === "fulfilled" && r.waited.status === "fulfilled", `${first}: both deliveries settle`);
      assert.equal(await state(), "MATCHED");
      assert.equal((await creditRow(c.creditId))?.order_id, o.orderId, `${first}: bound to ${o.orderId} once`);
      assert.equal(await count("SELECT 1 FROM kauro.domain_events WHERE aggregate_id::text = $1 AND event_type = 'bank_credit.matched.v1'", [c.creditId]), 1, `${first}: one decision`);
    }
  });

  cell(t("RACE", "TIMEOUT", "lookup past its statement bound"), "race", async (ctx) => {
    const { iw } = L();
    const { o, c, state } = await observedFor("m1-timeout");
    iw.faults.statementTimeoutMs = LOCK_TIMEOUT_MS;
    let r: Awaited<ReturnType<typeof holdAndWait<string, string>>>;
    try {
      r = await holdAndWait(ctx, "Kmatch timing out behind a held delivery", () => matchService(c.creditId), () => matchService(c.creditId));
    } finally {
      iw.faults.statementTimeoutMs = null;
    }
    assert.equal(r.held.status, "fulfilled");
    assert.equal(await state(), "MATCHED", "the held delivery decides; the timed-out one guessed no agency");
    assert.equal((await creditRow(c.creditId))?.order_id, o.orderId);
  });

  cell(t("DENY", "EXPIRY", "deadline crossed during the lookup"), "expiry", async (ctx) => {
    const { o, c, state } = await observedFor("m1-expiry", { bookedAt: new Date(Date.now() - 60_000).toISOString() });
    ctx.deadline(o.transferExpiresAt, "the transfer deadline");
    ctx.clock.past(o.transferExpiresAt);
    await onClock(ctx, "Kmatch after the deadline", () => matchService(c.creditId));
    assert.equal(await state(), "MATCHED", "identity resolved, flagged late");
    const keys = dataOf<{ keys: { transferExpiresAt: string } }>(await ownerGet(inboundRoutes.matchKeys(o.orderId)), 200, "keys").keys;
    assert.equal(keys.transferExpiresAt, o.transferExpiresAt, "the lookup never extends the deadline");
    assert.equal(await count("SELECT 1 FROM kauro.commercial_authorizations WHERE order_id = $1", [o.orderId]), 0, "matching is not authority");
  });

  cell(
    t("RACE", "CRASH-BEFORE", "crash before Kmatch COMMIT"),
    "crash-before-commit",
    async (ctx) => {
      const { c, state } = await observedFor("m1-crb");
      ctx.points.crash("uow.before-commit");
      await ctx.operation("Kmatch dying before COMMIT", () => onFresh(ctx, () => matchService(c.creditId))).catch(() => undefined);
      assert.equal(await state(), "OBSERVED", "no binding written");
      assert.equal((await creditRow(c.creditId))?.order_id, null);
    },
    "uow",
  );

  cell(
    t("RACE", "CRASH-AFTER", "crash after the lookup"),
    "crash-before-commit",
    async (ctx) => {
      const { o, c, state } = await observedFor("m1-cra");
      ctx.points.crash("uow.before-commit");
      await ctx.operation("Kmatch dying after its lookup", () => onFresh(ctx, () => matchService(c.creditId))).catch(() => undefined);
      assert.equal(await state(), "OBSERVED", "a read alone binds no order");
      await matchService(c.creditId);
      assert.equal(await state(), "MATCHED", "the redelivery repeats the guarded lookup");
      assert.equal((await creditRow(c.creditId))?.order_id, o.orderId);
    },
    "uow",
  );

  cell(t("DENY", "RETRY", "stable lookup and altered reference"), "retry", async (ctx) => {
    const { o, c, state } = await observedFor("m1-retry");
    await ctx.attempt(() => matchService(c.creditId));
    await ctx.attempt(() => matchService(c.creditId));
    assert.equal(await state(), "MATCHED", "identical redelivery: one decision");
    const variants: ReadonlyArray<readonly [string, Partial<CreditFacts>]> = [
      ["truncated reference", { reference: o.reference.slice(0, -2) }],
      ["lower-cased reference", { reference: o.reference.toLowerCase() }],
      ["payer other than the accepted billing identity", { payerDigest: "e".repeat(64) }],
      ["missing payer", { payerDigest: null }],
    ];
    for (const [what, over] of variants) {
      const v = await observedFor(`m1-retry-${what}`, over);
      await ctx.attempt(() => matchService(v.c.creditId));
      assert.equal(await v.state(), "MATCH_REVIEW", `${what}: review`);
      assert.equal((await creditRow(v.c.creditId))?.order_id, null, `${what}: no agency guessed`);
    }
  });

  cell(t("DENY", "REVOCATION", "owner override withdrawn at the held lookup"), "revocation", async (ctx) => {
    const { bw } = L();
    const { o, c, state } = await observedFor("m1-revoke", { reference: null });
    await matchService(c.creditId);
    const own = await ownOwner("m1-revoke");
    const { proof } = await proofOf(own.person);
    const held = await bw.holdInboundStream();
    try {
      const version = Number((await creditRow(c.creditId))!.version);
      const { waiting } = await bw.mustWaitOn(ctx, held, (cc) => routed(ctx, cc, () => attributeM2(c.creditId, o.orderId, version, { owner: own.person, proof })), "the owner's override held");
      await ctx.revoked("the overriding owner's grant", () => L().iw.h.revokeCorporateGrant(own.grantId));
      await held.release();
      await ctx.fenced("the override after the revocation", () => asRefusal(waiting.pending.then(valueOf)), refusedAs("403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING"));
    } finally {
      await held.release();
    }
    assert.equal(await state(), "MATCH_REVIEW", "the trusted receipt stays, unattributed");
  });

  cell(t("DENY", "PARTIAL", "second lookup fails"), "partial", async (ctx) => {
    const { c, state } = await observedFor("m1-partial");
    const conn = await openPay();
    try {
      await ctx.partial("Kmatch failing at its order lookup after its reference lookup", "db.order_lookup.before", () =>
        routed(ctx, conn, () => matchService(c.creditId), [{ label: "reference_lookup", match: /FROM kauro\.bank_transfer_instructions/ }, { label: "order_lookup", match: /FROM kauro\.payment_orders/ }]),
      );
    } finally {
      await conn.end();
    }
    assert.equal(await state(), "OBSERVED", "no partial binding");
    assert.equal((await creditRow(c.creditId))?.order_id, null);
  });
}

// --- P1 Kapply, E1 Kexpiry, P2 Kbook: the service rows ---------------------------------------------------------------------------------

const matchedFor = async (label: string, over: Partial<CreditFacts> = {}, cfg: Parameters<typeof awaitingOrder>[1] = {}) => {
  const o = await awaitingOrder(label, cfg);
  const facts = exactFor(o, over);
  const c = await confirmed(o.route.accountRef, facts);
  await matchService(c.creditId);
  assert.equal((await creditRow(c.creditId))?.state, "MATCHED", `${label}: matched`);
  return { o, c, facts };
};
const fpOrder = (o: Order): Promise<Footprint> => footprint({ accountRef: o.route.accountRef, orderId: o.orderId });

{
  const t = (verb: string, col: string, family: string): string => `${verb} ACH-M-P1-${col} (${family}): Apply matched credit / order-paid transition`;

  cell(t("RACE", "RACE", "both orders"), "race", async (ctx) => {
    for (const first of ["A holds", "B holds"]) {
      // two distinct exact credits for one order: one authorization, all money, the second is excess
      const { o, c } = await matchedFor(`p1-race-${first}`);
      const c2 = await confirmed(o.route.accountRef, exactFor(o));
      await matchService(c2.creditId);
      const [h, w] = first === "A holds" ? [c, c2] : [c2, c];
      const r = await holdAndWait(ctx, `${first}: Kapply vs Kapply`, () => applyService(h.creditId), () => applyService(w.creditId));
      assert.ok(r.held.status === "fulfilled" && r.waited.status === "fulfilled", `${first}: both settle`);
      const fp = await fpOrder(o);
      assert.equal(fp.orderState, "CAPTURED");
      assert.equal(fp.authorizations, 1, `${first}: one authorization`);
      assert.deepEqual(fp.captures.map((x) => x[1]).sort(), [o.amountCents.toString(), o.amountCents.toString()], `${first}: both receipts recorded`);
      assert.equal(fp.allocatedCents, o.amountCents.toString(), `${first}: allocation capped at ${o.amountCents}`);
      assert.deepEqual(fp.captures.map((x) => x[3]).sort(), ["0", o.amountCents.toString()], `${first}: the second is ${o.amountCents} cents of excess`);
      assert.ok(fp.cases.includes("EXCESS_CAPTURE"));
      assert.deepEqual(fp.returns, [["EXCESS_CAPTURE", o.amountCents.toString()]], `${first}: the excess goes back`);
    }
  });

  cell(t("RACE", "TIMEOUT", "lock and COMMIT timeout"), "race", async (ctx) => {
    const { iw } = L();
    const { o, c } = await matchedFor("p1-timeout");
    iw.faults.statementTimeoutMs = LOCK_TIMEOUT_MS;
    try {
      await holdAndWait(ctx, "a redelivered Kapply timing out behind the holder", () => applyService(c.creditId), () => applyService(c.creditId));
    } finally {
      iw.faults.statementTimeoutMs = null;
    }
    await applyService(c.creditId);
    const fp = await fpOrder(o);
    assert.deepEqual([fp.orderState, fp.captures.length, fp.authorizations], ["CAPTURED", 1, 1], "recovered by credit id: never a second grant");
  });

  cell(t("DENY", "EXPIRY", "transfer deadline across the apply effect"), "expiry", async (ctx) => {
    // on time: applied 1 ms before the deadline
    const on = await matchedFor("p1-expiry-on");
    ctx.deadline(on.o.transferExpiresAt, "the transfer deadline");
    ctx.clock.set(plusMs(on.o.transferExpiresAt, -1));
    await onClock(ctx, "Kapply 1 ms before the deadline", () => applyService(on.c.creditId));
    assert.deepEqual([(await fpOrder(on.o)).orderState, (await fpOrder(on.o)).authorizations], ["CAPTURED", 1]);
    // booked after deadline + tolerance, applied after it: money recorded, no authority, a return
    const late = await awaitingOrder("p1-expiry-late");
    const n = plusMs(late.transferExpiresAt, late.route.toleranceMs);
    ctx.clock.set(plusMs(n, HOUR));
    const facts = exactFor(late, { bookedAt: plusMs(n, 1) });
    const c = await onClock(ctx, "C6 after the deadline", async () => confirmed(late.route.accountRef, facts));
    await onClock(ctx, "match and apply after the deadline", () => settleCredit(c.creditId));
    const fp = await fpOrder(late);
    assert.equal(fp.orderState, "EXPIRED", "an expired order never resurrects");
    assert.deepEqual(fp.captures.map((x) => x[1]), [late.amountCents.toString()], "the money is recorded");
    assert.equal(fp.authorizations, 0, "no authority");
    assert.ok(fp.cases.includes("CAPTURE_WITHOUT_VALID_SUBJECT"));
    assert.deepEqual(fp.returns, [["KAURO_REMEDY", late.amountCents.toString()]], "the whole receipt is returned");
  });

  cell(
    t("RACE", "CRASH-BEFORE", "crash before Kapply COMMIT"),
    "crash-before-commit",
    async (ctx) => {
      const { o, c } = await matchedFor("p1-crb");
      const before = await fpOrder(o);
      ctx.points.crash("uow.before-commit");
      await ctx.operation("Kapply dying before COMMIT", () => onFresh(ctx, () => applyService(c.creditId))).catch(() => undefined);
      assert.deepEqual(await fpOrder(o), before, "no capture without its consequences");
      assert.equal((await creditRow(c.creditId))?.state, "MATCHED");
    },
    "uow",
  );

  cell(
    t("RACE", "CRASH-AFTER", "lost answer"),
    "crash-after-commit",
    async (ctx) => {
      const { o, c } = await matchedFor("p1-cra");
      ctx.points.crash("uow.after-commit");
      await ctx.operation("Kapply answer lost", () => onFresh(ctx, () => applyService(c.creditId))).catch(() => undefined);
      const fp = await fpOrder(o);
      assert.deepEqual([fp.orderState, fp.captures.length, fp.authorizations, (await creditRow(c.creditId))?.state], ["CAPTURED", 1, 1, "APPLIED"], "committed");
      await applyService(c.creditId);
      assert.deepEqual(await fpOrder(o), fp, "the redelivery returns the committed outcome: no duplicate authorization or event");
    },
    "uow",
  );

  cell(t("RACE", "RETRY", "replay, redelivery and distinct credit"), "retry", async (ctx) => {
    const { o, c } = await matchedFor("p1-retry");
    await ctx.attempt(() => applyService(c.creditId));
    const fp = await fpOrder(o);
    // (1) identical redelivery of the matched event
    await ctx.attempt(() => applyService(c.creditId));
    assert.deepEqual(await fpOrder(o), fp, "redelivered Kapply adds nothing");
    // (2) redelivery of the received event (the matcher again)
    await ctx.attempt(() => matchService(c.creditId));
    assert.deepEqual(await fpOrder(o), fp, "redelivered Kmatch adds nothing");
    // (3) a distinct exact credit proves excess, never a second authorization
    const c2 = await confirmed(o.route.accountRef, exactFor(o));
    await settleCredit(c2.creditId);
    const after2 = await fpOrder(o);
    assert.equal(after2.authorizations, 1);
    assert.deepEqual(after2.captures.map((x) => x[3]).sort(), ["0", o.amountCents.toString()]);
  });

  cell(t("DENY", "REVOCATION", "subject guards at apply"), "revocation", async (ctx) => {
    for (const what of ["approval withdrawn", "route disabled"]) {
      const { o, c } = await matchedFor(`p1-revoke-${what}`);
      await ctx.revoked(what, async () => {
        if (what === "route disabled") await disableRoute(o.route);
        else {
          const [plan] = await q<{ version: string }>("SELECT version::text FROM kauro.plans WHERE plan_id::text = $1", [o.planId]);
          const r = await call(L().iw.w, { url: routes.withdrawApproval(o.planId), token: o.a.s.owner.token, agency: o.a.s.agency.agencyId, key: freshKey("withdraw"), body: { expectedVersion: Number(plan!.version), reasonCode: "OWNER_DECISION" } });
          assert.equal(r.status, 200, r.text);
        }
      });
      await ctx.fenced(`Kapply after ${what}`, async () => {
        await applyService(c.creditId);
        const fp = await fpOrder(o);
        assert.deepEqual(fp.captures.map((x) => x[1]), [o.amountCents.toString()], `${what}: the verified money is recorded`);
        assert.equal(fp.authorizations, 0, `${what}: no authority`);
        assert.ok(fp.cases.includes("CAPTURE_WITHOUT_VALID_SUBJECT"), `${what}: case opened`);
        assert.deepEqual(fp.returns, [["KAURO_REMEDY", o.amountCents.toString()]], `${what}: a reviewed return of the whole receipt`);
        throw new AuthorityDenied(what);
      }, isAuthorityDenied);
    }
  });

  cell(t("RACE", "PARTIAL", "later write fails"), "partial", async (ctx) => {
    const { iw } = L();
    const { o, c } = await matchedFor("p1-partial");
    const before = await fpOrder(o);
    const steps: ReadonlyArray<SqlStep> = [
      { label: "capture_insert", match: /INSERT INTO kauro\.capture_facts/ },
      { label: "order_update", match: /UPDATE kauro\.(payment_orders|bank_transfer_instructions)/ },
      { label: "authorization_insert", match: /INSERT INTO kauro\.commercial_authorizations/ },
      ...LATER_WRITES.slice(0, 2),
    ];
    for (const at of ["order_update", "authorization_insert", "event_insert", "outbox_insert"]) {
      const conn = await openPay();
      try {
        await ctx.partial(`Kapply failing at ${at}`, `db.${at}.before`, () => routed(ctx, conn, () => applyService(c.creditId), steps));
      } finally {
        await conn.end();
      }
      assert.deepEqual(await fpOrder(o), before, `${at}: every apply write rolled back (allocated ${before.allocatedCents} cents)`);
      void iw;
    }
    await applyService(c.creditId);
    const fp = await fpOrder(o);
    assert.deepEqual([fp.orderState, fp.captures.length, fp.authorizations, fp.allocatedCents], ["CAPTURED", 1, 1, o.amountCents.toString()], "then applied once");
  });
}

{
  const t = (verb: string, col: string, family: string): string => `${verb} ACH-M-E1-${col} (${family}): Expiry sweep / retire-checkout transition`;
  const pastDeadline = (ctx: FaultContext, o: Order): void => {
    ctx.deadline(o.transferExpiresAt, "the transfer deadline");
    ctx.clock.set(plusMs(o.transferExpiresAt, 1));
  };

  cell(t("RACE", "RACE", "partial credit, both orders"), "race", async (ctx) => {
    for (const first of ["apply holds", "sweep holds"]) {
      const o = await awaitingOrder(`e1-race-${first}`);
      const part = (o.amountCents * 2n) / 5n;
      const c = await confirmed(o.route.accountRef, exactFor(o, { grossCents: part, bookedAt: new Date(Date.now() - 60_000).toISOString() }));
      await matchService(c.creditId);
      ctx.clock.set(plusMs(o.transferExpiresAt, 1));
      const apply = (): Promise<unknown> => onClockRaw(ctx, () => applyService(c.creditId));
      const sweep = (): Promise<unknown> => onClockRaw(ctx, () => expirySweep());
      const r = await holdAndWait(ctx, `${first}: Kapply vs Kexpiry`, first === "apply holds" ? apply : sweep, first === "apply holds" ? sweep : apply);
      assert.ok(r.held.status === "fulfilled" && r.waited.status === "fulfilled", first);
      await onClockRaw(ctx, () => expirySweep());
      const fp = await fpOrder(o);
      assert.equal(fp.orderState, "EXPIRED", `${first}: a partial receipt never completes the order`);
      assert.deepEqual(fp.captures.map((x) => x[1]), [part.toString()], `${first}: the ${part} cents are recorded once`);
      assert.equal(fp.authorizations, 0);
      assert.deepEqual(fp.returns, [["KAURO_REMEDY", part.toString()]], `${first}: exactly the unreturned ${part} cents are returned`);
    }
  });

  cell(t("RACE", "TIMEOUT", "lock and COMMIT timeout"), "race", async (ctx) => {
    const { iw } = L();
    const o = await awaitingOrder("e1-timeout");
    ctx.clock.set(plusMs(o.transferExpiresAt, 1));
    iw.faults.statementTimeoutMs = LOCK_TIMEOUT_MS;
    try {
      await holdAndWait(ctx, "a second sweep timing out behind the holder", () => onClockRaw(ctx, () => expirySweep()), () => onClockRaw(ctx, () => expirySweep()));
    } finally {
      iw.faults.statementTimeoutMs = null;
    }
    const fp = await fpOrder(o);
    await onClockRaw(ctx, () => expirySweep());
    assert.equal(fp.orderState, "EXPIRED");
    assert.deepEqual(await fpOrder(o), fp, "the next pass changes nothing");
  });

  cell(t("DENY", "EXPIRY", "before, at and after the deadline"), "expiry", async (ctx) => {
    const o = await awaitingOrder("e1-expiry");
    ctx.deadline(o.transferExpiresAt, "the transfer deadline");
    ctx.clock.set(plusMs(o.transferExpiresAt, -1));
    await onClock(ctx, "Kexpiry 1 ms before", () => expirySweep());
    assert.equal(await orderState(o.orderId), "AWAITING_TRANSFER", "-1 ms: still awaiting");
    ctx.clock.set(o.transferExpiresAt);
    await onClock(ctx, "Kexpiry at the deadline", () => expirySweep());
    assert.equal(await orderState(o.orderId), "EXPIRED", "effectNow >= deadline expires");
    const quote = (await q<{ s: string }>("SELECT state AS s FROM kauro.quotes WHERE quote_id = $1", [o.quote.quote.quoteId]))[0]?.s;
    assert.notEqual(quote, "ISSUED", "the price clock is never extended by a reopened quote");
  });

  cell(
    t("RACE", "CRASH-BEFORE", "crash before Kexpiry COMMIT"),
    "crash-before-commit",
    async (ctx) => {
      const o = await awaitingOrder("e1-crb");
      pastDeadline(ctx, o);
      const before = await fpOrder(o);
      ctx.points.crash("uow.before-commit");
      await onClock(ctx, "Kexpiry dying before COMMIT", () => expirySweep()).catch(() => undefined);
      assert.deepEqual(await fpOrder(o), before, "no orphan expiry consequence");
    },
    "uow",
  );

  cell(
    t("RACE", "CRASH-AFTER", "lost settle"),
    "crash-after-commit",
    async (ctx) => {
      const o = await awaitingOrder("e1-cra");
      pastDeadline(ctx, o);
      ctx.points.crash("uow.after-commit");
      await onClock(ctx, "Kexpiry answer lost", () => expirySweep()).catch(() => undefined);
      const fp = await fpOrder(o);
      assert.equal(fp.orderState, "EXPIRED");
      await onClockRaw(ctx, () => expirySweep());
      assert.deepEqual(await fpOrder(o), fp, "replayed closure: nothing more");
      const keys = await ownerGet(inboundRoutes.matchKeys(o.orderId));
      assert.equal(keys.json<{ data: { keys: { reference: string } } }>().data.keys.reference, o.reference, "the old reference stays bound");
    },
    "uow",
  );

  cell(t("RACE", "RETRY", "repeated sweep and retirement"), "retry", async (ctx) => {
    const o = await awaitingOrder("e1-retry");
    const part = o.amountCents / 4n;
    await paid(o, { grossCents: part });
    ctx.clock.set(plusMs(o.transferExpiresAt, 1));
    await ctx.attempt(() => onClockRaw(ctx, () => expirySweep()));
    const fp = await fpOrder(o);
    await ctx.attempt(() => onClockRaw(ctx, () => expirySweep()));
    assert.deepEqual(await fpOrder(o), fp, "a repeated pass duplicates no return request");
    assert.deepEqual(fp.returns, [["KAURO_REMEDY", part.toString()]]);
    const o2 = await awaitingOrder("e1-retry-retire");
    const key = freshKey("retire");
    const first = await retire(o2, key);
    assert.equal(first.status, 200, first.text);
    assert.equal((await retire(o2, key)).text, first.text, "the same retirement key replays");
    assert.equal(code(await retire(o2, freshKey("retire-2"))), "409 PRECONDITION_FAILED ORDER_NOT_CAPTURABLE", "a retired checkout retires once");
  });

  cell(t("DENY", "REVOCATION", "retiring member withdrawn"), "revocation", async (ctx) => {
    const o = await awaitingOrder("e1-revoke");
    const holder = await openConnection(L().iw.h.pg.clientConfig("kauro_payment_test"));
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM kauro.payment_orders WHERE order_id = $1 FOR NO KEY UPDATE", [o.orderId]);
      const waiter = await openPay();
      const waiting = await ctx.mustWait(L().iw.h.oracle, { waiter, holder: (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid }, (cc) => routed(ctx, cc, () => retire(o, freshKey("retire"))), "the retirement waits at the order lock");
      await ctx.revoked("the billing member's identity", () => q("UPDATE kauro.identities SET state = 'DISABLED' WHERE user_id = $1", [o.a.billing.userId]));
      await holder.query("ROLLBACK");
      await ctx.fenced("the retirement after the revocation", () => asRefusal(waiting.pending.then(valueOf)), refusedAs("403 NOT_AUTHORIZED IDENTITY_DISABLED"));
      await waiter.end();
    } finally {
      await holder.end().catch(() => undefined);
    }
    assert.equal(await orderState(o.orderId), "AWAITING_TRANSFER", "the order stays open");
  });

  cell(t("RACE", "PARTIAL", "later write fails"), "partial", async (ctx) => {
    const o = await awaitingOrder("e1-partial");
    const part = o.amountCents / 2n;
    await paid(o, { grossCents: part });
    ctx.clock.set(plusMs(o.transferExpiresAt, 1));
    const before = await fpOrder(o);
    const steps: ReadonlyArray<SqlStep> = [{ label: "order_update", match: /UPDATE kauro\.(payment_orders|bank_transfer_instructions)/ }, { label: "refund_insert", match: /INSERT INTO kauro\.refunds/ }, ...LATER_WRITES.slice(0, 2)];
    for (const at of ["refund_insert", "event_insert"]) {
      const conn = await openPay();
      try {
        await ctx.partial(`Kexpiry failing at ${at}`, `db.${at}.before`, () => routed(ctx, conn, () => withClock(ctx, () => expirySweep()), steps));
      } finally {
        await conn.end();
      }
      assert.deepEqual(await fpOrder(o), before, `${at}: rollback; the ${part} received cents and their capture unchanged`);
    }
  });
}

{
  const t = (verb: string, col: string, family: string): string => `${verb} ACH-M-P2-${col} (${family}): FINANCE receipt and attribution consumer`;
  const net = (l: Record<string, bigint>, account: string): bigint => (l[`${account}:DEBIT`] ?? 0n) - (l[`${account}:CREDIT`] ?? 0n);
  const fee = 150n;
  /** The exact B09 capture arithmetic of a matched bank receipt (D-ACH-11): zero residual treasury receipt, no BANK_CASH. */
  const assertBooked = async (creditId: string, o: Order, what: string): Promise<void> => {
    const l = await ledgerByAccount(creditId);
    assert.equal(net(l, "PSP_RECEIVABLE"), o.amountCents - fee, `${what}: PSP_RECEIVABLE ${o.amountCents} gross less the ${fee} observed fee`);
    assert.equal(net(l, "CONTRACT_LIABILITY"), -o.serviceCents, `${what}: CONTRACT_LIABILITY ${o.serviceCents}`);
    assert.equal(net(l, "TAX_PAYABLE"), -o.taxCents, `${what}: TAX_PAYABLE ${o.taxCents}`);
    assert.equal(net(l, "PROCESSOR_EXPENSE"), fee, `${what}: the fee once`);
    assert.equal(net(l, "CUSTOMER_OVERPAYMENT"), 0n, `${what}: no residual treasury receipt`);
    assert.equal(l["BANK_CASH:DEBIT"] ?? 0n, 0n, `${what}: no incoming credit makes BANK_CASH`);
  };
  const appliedFor = async (label: string) => {
    const o = await awaitingOrder(label);
    const { credit } = await paid(o, { feeCents: fee });
    assert.equal(credit.state, "APPLIED");
    return { o, creditId: credit.bank_credit_id };
  };

  cell(t("RACE", "RACE", "two FINANCE passes, both orders"), "race", async (ctx) => {
    for (const first of ["pass A holds", "pass B holds"]) {
      const { o, creditId } = await appliedFor(`p2-race-${first}`);
      const r = await holdAndWait(ctx, `${first}: Kbook vs Kbook`, () => finance(), () => finance());
      assert.ok(r.held.status === "fulfilled" && r.waited.status === "fulfilled", first);
      await assertBooked(creditId, o, first);
    }
  });
  cell(t("RACE", "TIMEOUT", "ledger lock or COMMIT timeout"), "race", async (ctx) => {
    const { iw } = L();
    const { o, creditId } = await appliedFor("p2-timeout");
    iw.faults.statementTimeoutMs = LOCK_TIMEOUT_MS;
    try {
      await holdAndWait(ctx, "a FINANCE pass timing out behind the holder", () => finance(), () => finance());
    } finally {
      iw.faults.statementTimeoutMs = null;
    }
    await finance();
    await assertBooked(creditId, o, "recovered by source ids: never reposted");
  });
  cell(t("DENY", "EXPIRY", "historical booking after order expiry"), "expiry", async (ctx) => {
    const o = await awaitingOrder("p2-expiry");
    const n = plusMs(o.transferExpiresAt, o.route.toleranceMs);
    ctx.deadline(o.transferExpiresAt, "the transfer deadline");
    ctx.clock.set(plusMs(n, HOUR));
    const c = await onClock(ctx, "a late credit confirmed after the deadline", () => confirmed(o.route.accountRef, exactFor(o, { bookedAt: plusMs(n, 1), feeCents: 0n })));
    await onClock(ctx, "match and apply after it", () => settleCredit(c.creditId));
    await finance();
    const l = await ledgerByAccount(c.creditId);
    assert.equal(net(l, "PSP_RECEIVABLE"), o.amountCents, "the expired order's real receipt is booked with its event dates");
  });
  cell(
    t("RACE", "CRASH-BEFORE", "crash before Kbook COMMIT"),
    "crash-before-commit",
    async (ctx) => {
      const { o, creditId } = await appliedFor("p2-crb");
      ctx.points.crash("uow.before-commit");
      await ctx.operation("FINANCE dying before COMMIT", () => onFresh(ctx, () => finance())).catch(() => undefined);
      assert.deepEqual(await ledgerByAccount(creditId), {}, "no posting-group fragment");
      await finance();
      await assertBooked(creditId, o, "then booked once");
    },
    "uow",
  );
  cell(
    t("RACE", "CRASH-AFTER", "lost settle"),
    "crash-after-commit",
    async (ctx) => {
      const { o, creditId } = await appliedFor("p2-cra");
      ctx.points.crash("uow.after-commit");
      await ctx.operation("FINANCE settle lost", () => onFresh(ctx, () => finance())).catch(() => undefined);
      await finance();
      await assertBooked(creditId, o, "replayed as already posted");
    },
    "uow",
  );
  cell(t("RACE", "RETRY", "identical redelivery"), "retry", async (ctx) => {
    const { o, creditId } = await appliedFor("p2-retry");
    await ctx.attempt(() => finance());
    const lines = await count("SELECT 1 FROM kauro.ledger_entries");
    await q("UPDATE kauro.outbox_records SET delivered_at = NULL WHERE event_id IN (SELECT event_id FROM kauro.domain_events WHERE aggregate_id::text = $1)", [creditId]).catch(() => undefined);
    await ctx.attempt(() => finance());
    assert.equal(await count("SELECT 1 FROM kauro.ledger_entries"), lines, "a redelivered source posts nothing");
    await assertBooked(creditId, o, "once");
  });
  cell(t("DENY", "REVOCATION", "stale worker fenced"), "revocation", async () => {
    throw new SeamMissing("S7 (L-REFUND)", "a FINANCE dispatcher handle whose lease was taken over (createPaymentDispatcher with a superseded owner), its pass reported FENCED with no posting");
  });
  cell(t("RACE", "PARTIAL", "later line fails"), "partial", async (ctx) => {
    const { o, creditId } = await appliedFor("p2-partial");
    const conn = await openPay();
    try {
      await ctx.partial("FINANCE failing at a later line", "db.ledger_line.before", () => routed(ctx, conn, () => finance(), [{ label: "first_line", match: /INSERT INTO kauro\.ledger_entries/, nth: 1 }, { label: "ledger_line", match: /INSERT INTO kauro\.ledger_entries/, nth: 2 }]));
    } finally {
      await conn.end();
    }
    assert.deepEqual(await ledgerByAccount(creditId), {}, "no residual line");
    await finance();
    await assertBooked(creditId, o, "then exact");
  });
}

/** `fn` on a fresh routed connection with the controlled clock (no new operation scope: inside holdAndWait's own). */
async function onClockRaw<T>(ctx: FaultContext, fn: () => Promise<T>): Promise<T> {
  return withClock(ctx, fn);
}
async function withClock<T>(ctx: FaultContext, fn: () => Promise<T>): Promise<T> {
  return ctx.withClock("on the step clock", async (clock) => {
    L().iw.faults.clock = clock;
    try {
      return await fn();
    } finally {
      L().iw.faults.clock = null;
    }
  });
}
/** E1's retirement half: the agency's billing member retires its open bank checkout (contract of this lane). */
function retire(o: Order, key: string): Promise<Reply> {
  return call(L().iw.w, { url: `/api/v1/payment-orders/${o.orderId}/retirements`, token: o.a.billing.token, agency: o.a.s.agency.agencyId, key, body: { reasonCode: "Switching to another payment route" } });
}

// --- SI1: the statement artifact read ---------------------------------------------------------------------------------------------------

{
  const label = "Read and classify a statement artifact";
  const stmt = async (l: string) => {
    const route = await anyRoute(l);
    const a = await statementArtifact(route.accountRef, { from: new Date(Date.now() - 3 * HOUR).toISOString(), to: new Date(Date.now() - 60_000).toISOString(), credits: [standalone(`${l}-c`)], debits: [] });
    return { route, a };
  };
  cell(`OK ACH-M-SI1-RACE (concurrent reads): ${label}`, "race", async (ctx) => {
    const { route, a } = await stmt("si1-race");
    const held = await L().bw.holdOutboundStream();
    try {
      const w1 = await L().bw.mustWaitOn(ctx, held, (c) => routed(ctx, c, () => importSI2(route.accountRef, a, { key: freshKey("si1-a") })), "import A reads, then waits at L1");
      const w2 = await L().bw.mustWaitOn(ctx, held, (c) => routed(ctx, c, () => importSI2(route.accountRef, a, { key: freshKey("si1-b") })), "import B reads the same ref, then waits at L1");
      await held.release();
      const codes = [valueOf(await w1.waiting.pending), valueOf(await w2.waiting.pending)].map((r) => (r.status < 300 ? "201" : code(r))).sort();
      assert.deepEqual(codes, ["201", "409 PRECONDITION_FAILED STATEMENT_ALREADY_IMPORTED"], "identical classifications: one import, the other the same artifact");
    } finally {
      await held.release();
    }
    assert.equal(await importsOf(route.accountRef), 1);
  });
  cell(`RACE ACH-M-SI1-TIMEOUT (store timeout): ${label}`, "timeout", async (ctx) => {
    const { route, a } = await stmt("si1-timeout");
    const deadline = ctx.deadline(ctx.clock.at(PROVIDER_CALL_TIMEOUT_MS), "the statement read's bound");
    const store = L().bw.evidence as unknown as { get: (ref: string) => Promise<unknown> };
    const real = store.get;
    store.get = async (ref: string) => {
      if (ref === a.artifactRef) ctx.clock.past(deadline);
      return real.call(L().bw.evidence, ref);
    };
    try {
      assert.equal(code(await onClock(ctx, "SI2 whose statement read outlives its bound", () => importSI2(route.accountRef, a))), "503 CAPACITY_UNAVAILABLE EVIDENCE_UNAVAILABLE");
    } finally {
      store.get = real;
    }
    assert.deepEqual([await importsOf(route.accountRef), (await coverageOf(route.accountRef)).length], [0, 0], "nothing written, coverage unchanged");
  });
  cell(
    `RACE ACH-M-SI1-CRASH-AFTER (lost classification): ${label}`,
    "crash-before-commit",
    async (ctx) => {
      const { route, a } = await stmt("si1-cra");
      const key = freshKey("si1-cra");
      ctx.points.crash("uow.before-commit");
      assert.equal((await ctx.operation("SI2 dying after its classification", () => onFresh(ctx, () => importSI2(route.accountRef, a, { key })))).status, 500);
      L().bw.evidence.corrupt(a.artifactRef, new TextEncoder().encode("changed before recovery"));
      assert.equal(code(await importSI2(route.accountRef, a, { key })), "422 INTEGRITY_FAILURE HASH_MISMATCH", "recovery rereads and reverifies: no cached classification");
      assert.equal(await importsOf(route.accountRef), 0);
    },
    "uow",
  );
  cell(`DENY ACH-M-SI1-RETRY (replay and rejected evidence): ${label}`, "retry", async (ctx) => {
    const { bw } = L();
    const { route, a } = await stmt("si1-retry");
    const first = await ctx.attempt(() => importSI2(route.accountRef, a, { key: "si1-retry-key-1" }));
    const again = await ctx.attempt(() => importSI2(route.accountRef, a, { key: "si1-retry-key-1" }));
    assert.equal(again.text, first.text, "same digest, same result");
    for (const [expected, bytes, auth] of [
      ["422 INTEGRITY_FAILURE UNKNOWN_EVIDENCE", JSON.stringify({ format: "other-bank/9", kind: "STATEMENT" }), undefined],
      ["422 INTEGRITY_FAILURE MALFORMED_EVIDENCE", `{"format":"contract-fake-bank-evidence/1","kind":"STATEMENT","accountRef":"${route.accountRef}","credits":[`, undefined],
      ["422 INTEGRITY_FAILURE UNAUTHENTICATED_EVIDENCE", JSON.stringify({ format: "contract-fake-bank-evidence/1", kind: "STATEMENT", accountRef: route.accountRef, coverageStart: new Date(Date.now() - HOUR).toISOString(), coverageEnd: new Date(Date.now() - 1000).toISOString(), credits: [], debits: [] }), "OWNER_DECLARED"],
    ] as const) {
      const p = await bw.evidence.put({ bytes: new TextEncoder().encode(bytes), accountRef: route.accountRef as never, ...(auth === undefined ? {} : { authenticatedBy: auth as never }) });
      assert.equal(code(await ctx.attempt(() => importSI2(route.accountRef, { artifactRef: p.artifactRef, evidenceHash: p.sha256 }))), expected);
    }
    const { a: b } = await stmt("si1-retry-mismatch");
    bw.evidence.corrupt(b.artifactRef, new TextEncoder().encode("x"));
    assert.equal(code(await importSI2(route.accountRef, b)), "422 INTEGRITY_FAILURE HASH_MISMATCH");
    assert.equal(await importsOf(route.accountRef), 1, "only the valid statement was imported");
  });
}

// --- P1Δ (DV1-06): an on-time credit confirmed late ------------------------------------------------------------------------------------

{
  const label = "Apply an on-time credit confirmed late";
  cell(`RACE ACH-M-P1D-RACE (expiry sweep, both orders and unswept): ${label}`, "race", async (ctx) => {
    const outcomes: string[] = [];
    for (const first of ["sweep holds", "apply holds", "unswept"]) {
      const o = await awaitingOrder(`p1d-race-${first}`);
      const bookedAt = plusMs(o.transferExpiresAt, -60_000);
      ctx.clock.set(plusMs(o.transferExpiresAt, HOUR));
      const c = await withClock(ctx, () => confirmed(o.route.accountRef, exactFor(o, { bookedAt })));
      await withClock(ctx, () => matchService(c.creditId));
      if (first === "unswept") await withClock(ctx, () => applyService(c.creditId));
      else {
        const sweep = (): Promise<unknown> => withClock(ctx, () => expirySweep());
        const apply = (): Promise<unknown> => withClock(ctx, () => applyService(c.creditId));
        await holdAndWait(ctx, `${first}: E1 vs P1`, first === "sweep holds" ? sweep : apply, first === "sweep holds" ? apply : sweep);
      }
      await withClock(ctx, () => expirySweep());
      const fp = await fpOrder(o);
      outcomes.push(`${fp.orderState} captures=${fp.captures.length} authorizations=${fp.authorizations}`);
      assert.deepEqual(fp.captures.map((x) => x[1]), [o.amountCents.toString()], `${first}: one capture of ${o.amountCents}`);
    }
    assert.deepEqual(outcomes, Array(3).fill("CAPTURED captures=1 authorizations=1"), "the same outcome in all three: honored, E1 after P1 changes nothing");
  });

  cell(`RACE ACH-M-P1D-EXPIRY (deadline plus named tolerance): ${label}`, "expiry", async (ctx) => {
    for (const toleranceMs of [2 * HOUR, 86_400_000]) {
      for (const [offset, expected] of [[-1, "CAPTURED"], [0, "CAPTURED"], [1, "EXPIRED"]] as const) {
        const o = await awaitingOrder(`p1d-exp-${toleranceMs}-${offset}`, { toleranceMs });
        const n = plusMs(o.transferExpiresAt, toleranceMs);
        if (offset === -1) ctx.deadline(o.transferExpiresAt, `the transfer deadline (tolerance ${toleranceMs})`);
        ctx.clock.set(plusMs(n, 60_000));
        const c = await onClock(ctx, `C6 of a credit booked N${offset >= 0 ? "+" : ""}${offset} ms`, () => confirmed(o.route.accountRef, exactFor(o, { bookedAt: plusMs(n, offset) })));
        await onClock(ctx, `match and apply N${offset} ms`, () => settleCredit(c.creditId));
        const fp = await fpOrder(o);
        assert.equal(fp.orderState, expected, `tolerance ${toleranceMs}, booked N${offset} ms`);
        assert.equal(fp.authorizations, expected === "CAPTURED" ? 1 : 0);
        assert.deepEqual(fp.captures.map((x) => x[1]), [o.amountCents.toString()], "the money is recorded either way");
        if (expected === "EXPIRED") assert.deepEqual(fp.returns, [["KAURO_REMEDY", o.amountCents.toString()]], "N+1 ms is returned");
      }
    }
    // provider time not verifiable: booked after confirmation + tolerance, or before issuance - tolerance
    for (const [what, at] of [["after confirmation + tolerance", (o: Order) => plusMs(new Date().toISOString(), o.route.toleranceMs + HOUR)], ["before issuance - tolerance", (o: Order) => plusMs(o.transferExpiresAt, -40 * 86_400_000)]] as const) {
      const o = await awaitingOrder(`p1d-ptu-${what}`);
      const { credit } = await paid(o, { bookedAt: at(o) });
      const fp = await fpOrder(o);
      assert.notEqual(fp.orderState, "CAPTURED", `${what}: not honored`);
      assert.equal(fp.authorizations, 0);
      assert.ok(fp.bankCases.includes("PROVIDER_TIME_UNVERIFIED"), `${what}: PROVIDER_TIME_UNVERIFIED (${credit.state})`);
    }
    // a draft bookedAt differing from the evidence is never confirmed
    const o = await awaitingOrder("p1d-draft-differs");
    const f = exactFor(o);
    const artifact = await creditArtifact(o.route.accountRef, f);
    const draft = dataOf<{ credit: CreditView }>(await enterC5(o.route.accountRef, f, artifact, {}, { bookedAt: plusMs(f.bookedAt, -HOUR) }), 201, "draft").credit;
    assert.equal(code(await confirmC6(draft.creditId)), "422 INTEGRITY_FAILURE CREDIT_EVIDENCE_MISMATCH");
    assert.equal((await creditRow(draft.creditId))?.state, "DRAFT_MANUAL");
  });

  cell(`DENY ACH-M-P1D-REVOCATION (subject guards at late apply): ${label}`, "revocation", async (ctx) => {
    for (const what of ["approval withdrawn", "route revoked", "another purchase of the project"]) {
      const o = await awaitingOrder(`p1d-rev-${what}`);
      const bookedAt = plusMs(o.transferExpiresAt, -60_000);
      ctx.clock.set(plusMs(o.transferExpiresAt, HOUR));
      await withClock(ctx, () => expirySweep());
      const c = await withClock(ctx, () => confirmed(o.route.accountRef, exactFor(o, { bookedAt })));
      await withClock(ctx, () => matchService(c.creditId));
      await ctx.revoked(what, async () => {
        if (what === "route revoked") await disableRoute(o.route);
        else if (what === "approval withdrawn") {
          const [plan] = await q<{ version: string }>("SELECT version::text FROM kauro.plans WHERE plan_id::text = $1", [o.planId]);
          assert.equal((await call(L().iw.w, { url: routes.withdrawApproval(o.planId), token: o.a.s.owner.token, agency: o.a.s.agency.agencyId, key: freshKey("withdraw"), body: { expectedVersion: Number(plan!.version), reasonCode: "OWNER_DECISION" } })).status, 200);
        } else {
          // the expired checkout was followed by another order of the same project that was paid
          const again = await awaitingOrder("p1d-rev-again", { agent: o.a, route: o.route, plan: { planId: o.planId, projectId: o.projectId } });
          await paid(again);
        }
      });
      await ctx.fenced(`late apply after ${what}`, async () => {
        await withClock(ctx, () => applyService(c.creditId));
        const fp = await fpOrder(o);
        assert.equal(fp.orderState, "EXPIRED", `${what}: stays EXPIRED`);
        assert.equal(fp.authorizations, 0, `${what}: no authority`);
        assert.deepEqual(fp.captures.map((x) => x[1]), [o.amountCents.toString()], `${what}: capture recorded`);
        assert.ok(fp.cases.includes("CAPTURE_WITHOUT_VALID_SUBJECT"));
        assert.deepEqual(fp.returns, [["KAURO_REMEDY", o.amountCents.toString()]]);
        throw new AuthorityDenied(what);
      }, isAuthorityDenied);
    }
  });
}

// --- §7.28 SI2-UNDECLARED, §7.27 FC-V, FC-API -----------------------------------------------------------------------------------------

test("DENY ACH-M-SI2-UNDECLARED (debit executed before any declaration): Import statement coverage — UNDECLARED_OUTBOUND opened, open refunds of the source frozen, X1/X4 refused EXECUTION_FROZEN, authorization_lapsed skips them, period not BALANCED", async () => {
  const o = await awaitingOrder("si2-undeclared");
  const { credit } = await paid(o);
  const captureId = credit.capture_id!;
  // an open refund of the source (REQUESTED by the agency's billing member)
  const req = await call(L().iw.w, { url: `/api/v1/projects/${o.projectId}/refund-requests`, token: o.a.billing.token, agency: o.a.s.agency.agencyId, key: freshKey("si2u-req"), body: { reasonCode: "The client cancelled before execution", evidenceRef: "0190f0f0-0000-7000-8000-000000000001" } });
  assert.equal(req.status, 201, `CMD031 opens a refund of the source: ${req.text}`);
  const refundId = req.json<{ data: { refund: { refundId: string } } }>().data.refund.refundId;
  const now = Date.now();
  const st = await statementArtifact(o.route.accountRef, { from: new Date(now - 3 * HOUR).toISOString(), to: new Date(now - 60_000).toISOString(), credits: [], debits: [{ debitId: "debit-undeclared-1", bankExecutionId: "exec-undeclared-1", amountCents: o.amountCents, currency: "USD", reference: `kauro-refund-${refundId}-1`, executedAt: new Date(now - HOUR).toISOString(), status: "COMPLETED", observedAt: new Date(now - HOUR).toISOString() }] });
  const imp = dataOf<{ import: ImportView }>(await importSI2(o.route.accountRef, st), 201, "the statement is imported").import;
  assert.deepEqual([imp.orphans, imp.balanced], [1, false], "the undeclared debit is an orphan: not BALANCED");
  assert.ok((await footprint({ accountRef: o.route.accountRef })).bankCases.includes("UNDECLARED_OUTBOUND"));
  assert.equal(await count("SELECT 1 FROM kauro.bank_source_freezes WHERE source_id = $1 AND reason = 'UNDECLARED_OUTBOUND'", [captureId]), 1, "the source is frozen");
  const x1 = await call(L().iw.w, { url: `/api/v1/operations/refunds/${refundId}/execution-declarations`, token: L().owner.token, agency: null, key: freshKey("x1"), body: { expectedVersion: 2, amountCents: o.amountCents.toString(), authorizationRef: await L().iw.w.stepUp(L().owner) } });
  assert.match(code(x1), /EXECUTION_FROZEN$/, "X1 refused while frozen");
});

test("DENY ACH-M-FC-V (payer authorization LATER): a credit whose payer is not the order's accepted billing identity goes to MATCH_REVIEW and can only be returned; no payer-authorization command is served", async () => {
  const o = await awaitingOrder("fc-v");
  const { credit } = await paid(o, { payerDigest: "d".repeat(64) });
  assert.equal(credit.state, "MATCH_REVIEW", "another payer is reviewed, never matched");
  const fp = await fpOrder(o);
  assert.deepEqual([fp.orderState, fp.captures.length, fp.authorizations], ["AWAITING_TRANSFER", 0, 0]);
  assert.ok(fp.bankCases.includes("MATCH_REVIEW"));
  const attributed = await attributeM2(credit.bank_credit_id, o.orderId, Number(credit.version));
  assert.equal(code(attributed), "409 PRECONDITION_FAILED ATTRIBUTION_NOT_OVERRIDABLE", "the owner cannot attribute another payer in V1: return only");
  const served = await call(L().iw.w, { url: inboundRoutes.payerAuthorizations(o.a.s.agency.agencyId), token: L().owner.token, agency: null, key: freshKey("payer-auth"), body: { payerDigest: "d".repeat(64), authorizationRef: await L().iw.w.stepUp(L().owner) } });
  assert.equal(served.status, 404, "no payer-authorization command is served");
});

test("DENY ACH-M-FC-API (provider API LATER): with the route OWNER_MANUAL no credit or debit scanner is registered, no provider read is called and coverage comes only from imported statements", async () => {
  const { bw } = L();
  const o = await awaitingOrder("fc-api");
  const calls = bw.evidence.calls.length;
  await paid(o);
  await L().iw.pw.service.runSweepPass();
  await dispatch2();
  assert.deepEqual(bw.evidence.calls.slice(calls).map((c) => c.operation), [], "no listIncomingCredits, getCreditById or listStatementDebits call");
  assert.deepEqual(await coverageOf(o.route.accountRef), [], "no coverage without an imported statement");
  const st = await statementArtifact(o.route.accountRef, { from: new Date(Date.now() - 3 * HOUR).toISOString(), to: new Date(Date.now() - 60_000).toISOString(), credits: [], debits: [] });
  dataOf<{ import: ImportView }>(await importSI2(o.route.accountRef, st), 201, "an imported statement");
  assert.deepEqual((await coverageOf(o.route.accountRef)).map((c) => c[0]).sort(), ["INBOUND", "OUTBOUND"], "coverage per stream, only from the import");
});
async function dispatch2(): Promise<void> {
  const { dispatch } = await import("./payment-support.js");
  await dispatch(L().iw.pw, "PAYMENT_SERVICE");
}

// --- cases (docs/design/ACH-case-map.md) -------------------------------------------------------------------------------------------------

test("ACH-04 DENY: a manual draft is never confirmed money; confirmation rereads stored bytes under owner step-up; agency billing is refused; unknown, malformed or hash-mismatched evidence changes nothing", async () => {
  const o = await awaitingOrder("ach04");
  const f = exactFor(o);
  const { credit, artifact } = await drafted(o.route.accountRef, f);
  await finance();
  const fp = await fpOrder(o);
  assert.deepEqual([fp.orderState, fp.captures.length, fp.authorizations, fp.ledger], ["AWAITING_TRANSFER", 0, 0, 0], "a draft is not money");
  assert.equal(code(await confirmC6(credit.creditId, 1, { owner: o.a.billing, agency: o.a.s.agency.agencyId })), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  assert.equal(code(await confirmC6(credit.creditId, 1, { stepUp: "STALE" })), "403 ASSURANCE_REQUIRED STEP_UP_STALE");
  L().bw.evidence.corrupt(artifact.artifactRef, new TextEncoder().encode("tampered"));
  assert.equal(code(await confirmC6(credit.creditId)), "422 INTEGRITY_FAILURE HASH_MISMATCH");
  assert.deepEqual(await fpOrder(o), fp, "nothing changed");
  assert.equal((await creditRow(credit.creditId))?.state, "DRAFT_MANUAL");
});

test("ACH-05 RACE: duplicate manual entries and overlapping statement imports book each receipt once; an immutable conflict is PROVIDER_INCONSISTENCY; orphan debits persist before coverage", async () => {
  const route = await anyRoute("ach05");
  const f = standalone("ach05");
  const artifact = await creditArtifact(route.accountRef, f);
  const [a, b] = await Promise.all([enterC5(route.accountRef, f, artifact), enterC5(route.accountRef, f, artifact)]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409], "one draft");
  const c = (a.status === 201 ? a : b).json<{ data: { credit: CreditView } }>().data.credit;
  dataOf(await confirmC6(c.creditId), 200, "confirm");
  const span = { from: new Date(Date.now() - 3 * HOUR).toISOString(), to: new Date(Date.now() - 60_000).toISOString() };
  const debit = { debitId: "ach05-orphan", bankExecutionId: "exec-ach05", amountCents: 7_700n, currency: "USD", reference: null, executedAt: new Date(Date.now() - HOUR).toISOString(), status: "COMPLETED", observedAt: new Date(Date.now() - HOUR).toISOString() };
  dataOf(await importSI2(route.accountRef, await statementArtifact(route.accountRef, { ...span, credits: [f], debits: [debit] })), 201, "first import");
  dataOf(await importSI2(route.accountRef, await statementArtifact(route.accountRef, { ...span, credits: [f, standalone("ach05-2")], debits: [debit] })), 201, "overlapping import");
  assert.equal((await creditsOfTxn(route.accountRef, f.bankTransactionId)).length, 1, "the manual credit and its statement line are one receipt");
  assert.equal((await statementLines(route.accountRef)).filter((l) => l[1] === "ach05-orphan").length, 1, "the orphan debit is one durable line");
  assert.ok((await footprint({ accountRef: route.accountRef })).bankCases.includes("RECORD_REQUIRED"), "its exception is open");
  assert.equal(code(await importSI2(route.accountRef, await statementArtifact(route.accountRef, { ...span, credits: [{ ...f, grossCents: f.grossCents - 1n }], debits: [] }))), "409 PRECONDITION_FAILED PROVIDER_INCONSISTENCY");
});

test("ACH-06 DENY: a missing, foreign or truncated reference or a payer other than the accepted billing identity goes to MATCH_REVIEW; no agency is guessed", async () => {
  const o = await awaitingOrder("ach06");
  const foreign = await awaitingOrder("ach06-foreign");
  for (const [what, over] of [["missing", { reference: null }], ["foreign", { reference: foreign.reference }], ["truncated", { reference: o.reference.slice(0, 12) }], ["other payer", { payerDigest: "a".repeat(64) }]] as const) {
    const { credit } = await paid(o, over as Partial<CreditFacts>);
    assert.deepEqual([credit.state, credit.order_id], ["MATCH_REVIEW", null], `${what}: reviewed, unbound`);
  }
  const fp = await fpOrder(o);
  assert.deepEqual([fp.orderState, fp.captures.length, fp.authorizations], ["AWAITING_TRANSFER", 0, 0]);
  assert.deepEqual([await orderState(foreign.orderId), (await fpOrder(foreign)).captures.length], ["AWAITING_TRANSFER", 0], "a foreign account's reference never pays the other order");
});

test("ACH-07 OK: one exact USD credit applied while valid gives one capture, CAPTURED, one authorization, exact ledger, fee and funds", async () => {
  const o = await awaitingOrder("ach07");
  const { credit } = await paid(o, { feeCents: 250n });
  await finance();
  const fp = await fpOrder(o);
  assert.deepEqual([credit.state, fp.orderState, fp.authorizations, fp.allocatedCents], ["APPLIED", "CAPTURED", 1, o.amountCents.toString()]);
  assert.deepEqual(fp.captures, [["COMPLETED", o.amountCents.toString(), o.serviceCents.toString(), "0"]]);
  const [cap] = await q<{ f: string | null; fs: string }>("SELECT provider_fee_cents::text AS f, funds_state AS fs FROM kauro.capture_facts WHERE order_id = $1", [o.orderId]);
  assert.deepEqual([cap!.f, cap!.fs], ["250", "UNKNOWN"], "the observed fee; funds never coerced to available");
  const l = await ledgerByAccount(credit.bank_credit_id);
  assert.equal((l["PSP_RECEIVABLE:DEBIT"] ?? 0n) - (l["PSP_RECEIVABLE:CREDIT"] ?? 0n), o.amountCents - 250n);
  assert.equal((l["CONTRACT_LIABILITY:CREDIT"] ?? 0n) - (l["CONTRACT_LIABILITY:DEBIT"] ?? 0n), o.serviceCents);
});

test("ACH-08 DENY: 400 + 600 against 1,000 and 1,010 against 1,000 are recorded with exact allocations, reviewed, returned by the owner, and never authorize", async () => {
  const o = await awaitingOrder("ach08-partial");
  const p1 = (o.amountCents * 2n) / 5n;
  const p2 = o.amountCents - p1;
  await paid(o, { grossCents: p1 });
  assert.equal(await orderState(o.orderId), "PARTIALLY_RECEIVED");
  await paid(o, { grossCents: p2 });
  const fp = await fpOrder(o);
  assert.deepEqual(fp.captures.map((x) => x[1]).sort(), [p1.toString(), p2.toString()].sort(), "no fabricated aggregate capture");
  assert.equal(fp.authorizations, 0);
  assert.equal(fp.orderState, "RECEIVED_REVIEW");
  assert.ok(fp.cases.includes("AMOUNT_MISMATCH"));
  assert.equal(fp.returns.reduce((s, r) => s + BigInt(r[1]), 0n), o.amountCents, "the owner returns every received cent");
  const over = await awaitingOrder("ach08-over");
  await paid(over, { grossCents: over.amountCents + 10n });
  const fo = await fpOrder(over);
  assert.deepEqual(fo.captures.map((x) => [x[1], x[3]]), [[(over.amountCents + 10n).toString(), "10"]], "allocation capped, 10 cents excess");
  assert.equal(fo.authorizations, 0, "an inexact receipt never authorizes");
  assert.equal(fo.returns.reduce((s, r) => s + BigInt(r[1]), 0n), over.amountCents + 10n);
});

test("ACH-09 OK (R2-140): two distinct exact receipts give one authorization, all money recorded, the excess returned, the commission basis capped", async () => {
  const o = await awaitingOrder("ach09");
  await paid(o);
  await paid(o);
  const fp = await fpOrder(o);
  assert.equal(fp.authorizations, 1);
  assert.deepEqual(fp.captures.map((x) => x[1]), [o.amountCents.toString(), o.amountCents.toString()]);
  assert.equal(fp.captures.reduce((s, x) => s + BigInt(x[2]), 0n), o.serviceCents, "service basis capped at one obligation");
  assert.deepEqual(fp.returns, [["EXCESS_CAPTURE", o.amountCents.toString()]]);
});

test("ACH-10 RACE: before, at and after expiry with delayed observation and revoked source, approval or route, money is recorded, nothing is resurrected, the remedy is reviewed", async () => {
  // the instants before/at/after the deadline are crossed on the controlled clock in ACH-M-E1-EXPIRY, ACH-M-P1-EXPIRY and ACH-M-P1D-*;
  // this case asserts the end states of the valid path and of each revoked prerequisite on the server's clock
  const valid = await awaitingOrder("ach10-valid");
  await paid(valid);
  assert.deepEqual([(await fpOrder(valid)).orderState, (await fpOrder(valid)).authorizations], ["CAPTURED", 1], "applied while valid: one authorization");
  for (const what of ["route disabled", "approval withdrawn"]) {
    const o = await awaitingOrder(`ach10-${what}`);
    if (what === "route disabled") await disableRoute(o.route);
    else {
      const [plan] = await q<{ version: string }>("SELECT version::text FROM kauro.plans WHERE plan_id::text = $1", [o.planId]);
      assert.equal((await call(L().iw.w, { url: routes.withdrawApproval(o.planId), token: o.a.s.owner.token, agency: o.a.s.agency.agencyId, key: freshKey("withdraw"), body: { expectedVersion: Number(plan!.version), reasonCode: "OWNER_DECISION" } })).status, 200);
    }
    await paid(o);
    const fp = await fpOrder(o);
    assert.deepEqual([fp.orderState === "CAPTURED", fp.authorizations, fp.captures.map((x) => x[1])], [false, 0, [o.amountCents.toString()]], `${what}: the money is recorded and grants nothing`);
    assert.ok(fp.cases.includes("CAPTURE_WITHOUT_VALID_SUBJECT"), `${what}: reviewed`);
    assert.deepEqual(fp.returns, [["KAURO_REMEDY", o.amountCents.toString()]], `${what}: the remedy returns ${o.amountCents} cents`);
  }
});

test("ACH-11 DENY: an explicitly retired checkout keeps its reference bound and a later credit on it is return-only", async () => {
  const o = await awaitingOrder("ach11");
  assert.equal((await retire(o, freshKey("ach11"))).status, 200);
  assert.equal(await orderState(o.orderId), "EXPIRED");
  await paid(o);
  const fp = await fpOrder(o);
  assert.deepEqual([fp.orderState, fp.authorizations, fp.captures.length], ["EXPIRED", 0, 1], "no resurrection, money recorded");
  assert.deepEqual(fp.returns, [["KAURO_REMEDY", o.amountCents.toString()]], "return-only");
  assert.equal(await count("SELECT 1 FROM kauro.payment_orders WHERE project_id::text = $1", [o.projectId]), 1, "no automatic second charge");
});

test("ACH-13 OK: fees are versioned data with source and access date; null fee differs from observed zero; gross equals net plus fee; outbound fees are recorded", async () => {
  const zero = await awaitingOrder("ach13-zero");
  await paid(zero, { feeCents: 0n });
  const unknown = await awaitingOrder("ach13-null");
  await paid(unknown, { feeCents: null });
  const fee = async (o: Order) => (await q<{ f: string | null }>("SELECT provider_fee_cents::text AS f FROM kauro.capture_facts WHERE order_id = $1", [o.orderId]))[0]?.f ?? "absent";
  assert.deepEqual([await fee(zero), await fee(unknown)], ["0", null], "observed zero is 0, unknown is null");
  const route = await anyRoute("ach13-conflict");
  const bad = await L().bw.evidence.put({ bytes: (await import("@kauro/application/testing")).fakeCreditBytes(route.accountRef, { creditId: "ach13-bad", currency: "USD", grossCents: 1000n, netCents: 900n, feeCents: 50n, payeeDigest: "b".repeat(64) as never, observedAt: new Date().toISOString(), status: "COMPLETED", rail: "ACH" }), accountRef: route.accountRef as never });
  const draft = dataOf<{ credit: CreditView }>(await enterC5(route.accountRef, standalone("ach13-bad", { bankTransactionId: "ach13-bad", grossCents: 1000n }), { artifactRef: bad.artifactRef, evidenceHash: bad.sha256 }), 201, "draft").credit;
  assert.equal(code(await confirmC6(draft.creditId)), "422 INTEGRITY_FAILURE MALFORMED_EVIDENCE", "gross != net + fee is never repaired");
  // gross = net + fee on the applied credit; the fee is its own observed fact (outbound fees: L-REFUND's ACH-15/16)
  const row = await creditsOfTxn(zero.route.accountRef, (await q<{ t: string }>("SELECT bank_transaction_id AS t FROM kauro.bank_credits WHERE order_id = $1", [zero.orderId]))[0]!.t);
  assert.deepEqual([row[0]!.gross_cents, row[0]!.fee_cents], [zero.amountCents.toString(), "0"]);
});

test("ACH-20 OK: an imported statement covers its interval once by bank transaction id, links recorded debits, keeps orphans open and is BALANCED only with zero orphans", async () => {
  const route = await anyRoute("ach20");
  const t0 = Date.now() - 6 * HOUR;
  const iso = (ms: number) => new Date(t0 + ms).toISOString();
  const first = dataOf<{ import: ImportView }>(await importSI2(route.accountRef, await statementArtifact(route.accountRef, { from: iso(0), to: iso(2 * HOUR), credits: [standalone("ach20-a")], debits: [] })), 201, "a clean period").import;
  assert.deepEqual([first.orphans, first.balanced, first.lines], [0, true, 1], "zero orphans: BALANCED");
  assert.deepEqual(first.coverage.map((c) => c.stream).sort(), ["INBOUND", "OUTBOUND"]);
  const second = dataOf<{ import: ImportView }>(await importSI2(route.accountRef, await statementArtifact(route.accountRef, { from: iso(2 * HOUR), to: iso(4 * HOUR), credits: [], debits: [{ debitId: "ach20-orphan", amountCents: 500n, currency: "USD", status: "COMPLETED", observedAt: iso(3 * HOUR) }] })), 201, "a period with an unrecorded debit").import;
  assert.deepEqual([second.orphans, second.balanced], [1, false], "an orphan keeps the period open");
  assert.deepEqual((await coverageOf(route.accountRef)).length, 4, "two intervals per stream, each once");
});

test("ACH-21 OK (R2 15 expiry race): a credit booked by the deadline plus the route's provider-time tolerance and confirmed later is honored whether or not the expiry sweep ran, only with every subject guard valid and no other purchase; otherwise it is recorded and returned", async () => {
  // the instants are crossed in the matrix cells ACH-M-P1D-RACE / -EXPIRY / -REVOCATION; here the case's end state on the server's clock
  const o = await awaitingOrder("ach21", { lifetimeMs: 4 * 86_400_000 + 1000, windowMs: 4 * 86_400_000 });
  const { credit } = await paid(o, { bookedAt: plusMs(o.transferExpiresAt, -1) });
  assert.equal(credit.state, "APPLIED");
  assert.deepEqual([(await fpOrder(o)).orderState, (await fpOrder(o)).authorizations], ["CAPTURED", 1]);
});

test("ACH-22 OK: a domestic wire to the same details matches exactly like ACH on gross; its fee is observed separately; other rails go to review", async () => {
  const o = await awaitingOrder("ach22");
  const { credit } = await paid(o, { rail: "DOMESTIC_WIRE", feeCents: 1_500n });
  assert.equal(credit.state, "APPLIED", "DOMESTIC_WIRE is in the route version's acceptedRails");
  const fp = await fpOrder(o);
  assert.deepEqual([fp.orderState, fp.authorizations, fp.captures[0]![1]], ["CAPTURED", 1, o.amountCents.toString()], "gross matches the obligation; the fee never reduces the customer's payment");
  const other = await awaitingOrder("ach22-other");
  for (const rail of ["OTHER", "UNKNOWN"]) {
    const { credit: c } = await paid(other, { rail });
    assert.equal(c.state, "MATCH_REVIEW", `${rail}: review`);
  }
  assert.equal((await fpOrder(other)).captures.length, 0);
});

void SEAMS;
void ((): Promise<HarnessConnection> => openPay());
