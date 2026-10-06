// The family runner's templates 5.1-5.7 RUN here (docs/design/B10-KIT-SUITES.md section 5; adversary ADV-1): one honest member per template
// against the real CMD052 route over a real PostgreSQL 17 world must pass, and one forged member per refusal duty of the runner must be
// refused with the runner's OWN message (assert.rejects with the message, so a member refused for another reason, or the guard deleted and
// the member passing, fails this file). The duties: 5.1 first conflicting statement is the one that timed out with 57014 (and is never
// answered); 5.2 no application bound is RED and a path that calls another binding is refused; 5.3 the target unit carries its witness with
// the member's identity (another phase); 5.4 the completed step answered in the target unit with the identity params; 5.5 B's last statement
// is the declared `blocks` receipt; 5.6 the act waits on the uncommitted revocation and is refused as declared; 5.7 the act waits while its
// proof runs out, and the instant past the expiry is consumed by the PRODUCT's own judgment (the step-up verifier CMD052 calls, bound
// through an instrumented proxy: no sink the member feeds itself); the target unit is the declared ordinal; the footprint is EXACTLY the
// rows the earlier units committed, in both directions (a claimed row missing, an unclaimed row left behind). Titles say the duty.
import { crashedAt, invariantsAfterEach, instrumentPort, runCell, type FaultContext, type HarnessConnection } from "@kauro/persistence/testing";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openConnection } from "@kauro/persistence/testing";
import { bindFamily, memberCell, portHooks, Refused, runMember, type Member, type Receipt } from "./b10-cells-support.js";
import { approvePayout, bankCash, claimedCents, closeMonth, eligibleLines, rows, seller, statementsOfSeller, statementsWorld, type StatementsWorld } from "./statements-support.js";
import { completed, ids, outcome, type Person, type Reply } from "./support.js";
import type { UserId } from "@kauro/domain";
import type { AssuranceVerifier } from "@kauro/application";
import { createAssuranceVerifier } from "@kauro/authorization";

let sw: StatementsWorld;
/**
 * CMD052's step-up verifier: the platform's own, reached through `stepUpPort`, which a 5.7 member points at an instrumented proxy of the
 * same verifier for its act, so the instants the product judges the proof at are the cell's evidence (ADV-13).
 */
const platformStepUp = createAssuranceVerifier();
let stepUpPort: AssuranceVerifier = platformStepUp;
const stepUp: AssuranceVerifier = { verifyStepUp: (...args) => stepUpPort.verifyStepUp(...args) };
// the B10 state oracle after every test of this file (B10-KIT-SUITES section 2)
invariantsAfterEach(() => sw.h.oracle);
before(async () => {
  sw = await statementsWorld({ commercial: { assurance: stepUp } });
  bindFamily({ oracle: sw.h.oracle, faults: sw.faults, open: (login) => openConnection(sw.h.pg.clientConfig(login)) });
});
after(async () => {
  await sw.stop();
});

// --- the world: issued statements, each approved through the real CMD052 route -------------------------------------------------------
const WHOLE = { firstBps: 10_000, repeatBps: 10_000 } as const;
const PAYABLE = 5_000n;
interface Fix {
  readonly statementId: string;
  readonly person: Person;
  readonly grantId: string | null;
  readonly body: { readonly expectedVersion: number; readonly payeeRef: string; readonly authorizationRef: unknown };
  /** One idempotency key for every act on this fixture (a `twice` member sends the same command twice). */
  readonly key: string;
  readonly expiresAt: string | null;
}
const supply: Array<{ readonly statementId: string; readonly version: number; readonly destinationId: string }> = [];
let month = 0;
async function takeIssued(): Promise<{ readonly statementId: string; readonly version: number; readonly destinationId: string }> {
  while (supply.length === 0) {
    const m = `2026-${String(++month).padStart(2, "0")}`;
    const sellers = [];
    for (let i = 0; i < 6; i++) {
      const s = await seller(sw, `tpl-${m}-${i}`, WHOLE);
      await eligibleLines(sw, `tpl-${m}-${i} ${m}`, s, WHOLE, [{ basisCents: PAYABLE, poolCents: PAYABLE }]);
      sellers.push(s);
    }
    const { periodId, reply } = await closeMonth(sw, m);
    completed(reply, 200);
    for (const s of sellers) {
      const st = (await statementsOfSeller(sw, s.sellerId)).find((x) => x.period_id === periodId);
      assert.ok(st !== undefined, "the close issued the seller's statement");
      supply.push({ statementId: st.statement_id, version: Number(st.version), destinationId: s.destinationId });
    }
  }
  return supply.shift()!;
}
let keys = 0;
const REVOKE_GRANT = "UPDATE kauro.corporate_roles SET state = 'REVOKED', revoked_at = now() WHERE grant_id = $1 AND state = 'ACTIVE'";
/** An issued statement, the cash to cover it and an owner with a fresh step-up proof (`own`: a KAURO_OWNER grant of its own, revocable). */
async function fixture(label: string, options: { readonly own?: boolean; readonly proofIssuedMinutesAgo?: number; readonly person?: Person; readonly grantId?: string | null } = {}): Promise<Fix> {
  const st = await takeIssued();
  await bankCash(sw, (await claimedCents(sw)) + PAYABLE);
  let person = options.person ?? sw.owner;
  let grantId = options.grantId ?? null;
  if (options.own === true && options.person === undefined) {
    person = await sw.w.person(`tpl-${label}-${++keys}`);
    grantId = await sw.h.grantKauroOwner(person.userId as UserId);
  }
  let authorizationRef: unknown;
  let expiresAt: string | null = null;
  if (options.proofIssuedMinutesAgo !== undefined) {
    const proof = await sw.h.recordStepUp(person.userId as UserId, { issuedAt: new Date(sw.w.processClock.nowMs() - options.proofIssuedMinutesAgo * 60_000).toISOString() as never });
    authorizationRef = proof;
    expiresAt = (await rows<{ expires_at: Date }>(sw, "SELECT expires_at FROM kauro.assurance_proofs WHERE proof_id = $1", [proof]))[0]!.expires_at.toISOString();
  } else authorizationRef = await sw.w.stepUp(person);
  return { statementId: st.statementId, person, grantId, body: { expectedVersion: st.version, payeeRef: st.destinationId, authorizationRef }, key: `tpl-${label}-${++keys}-${process.pid}`, expiresAt };
}
/** The act: CMD052 for the fixture's statement; a non-2xx answer is a Refused(status, code). */
async function approve(f: Fix, key: string): Promise<Reply> {
  const hidden = sw.w.internalErrors.length;
  const reply = await approvePayout(sw, f.statementId, f.body, { token: f.person.token, key });
  // the route answers 500 and reports the failure it hid (a crash or a database error is not a DomainFailure): the cell sees the failure itself
  if (reply.status >= 500 && sw.w.internalErrors.length > hidden) throw sw.w.internalErrors[hidden]!.error;
  if (reply.status !== 200) {
    const [status, code] = outcome(sw.w, reply).split(" ");
    throw new Refused(Number(status), code ?? "-", outcome(sw.w, reply));
  }
  return reply;
}
const intentCount = async (statementId: string): Promise<number> => Number((await rows<{ n: string }>(sw, "SELECT count(*)::text AS n FROM kauro.payout_intents WHERE statement_id = $1", [statementId]))[0]!.n);
const statementState = async (statementId: string): Promise<string> => (await rows<{ state: string }>(sw, "SELECT state FROM kauro.commission_statements WHERE statement_id = $1", [statementId]))[0]!.state;
const nothingApproved = async (f: Fix): Promise<void> => {
  assert.deepEqual([await intentCount(f.statementId), await statementState(f.statementId)], [0, "ISSUED"], "no intent, the statement still ISSUED");
};
const approvedOnce = async (f: Fix): Promise<void> => {
  assert.deepEqual([await intentCount(f.statementId), await statementState(f.statementId)], [1, "APPROVED"], "exactly one intent, the statement APPROVED");
};

// --- the receipts of the act (statements of its one unit of work, with the fixture's identity) ---------------------------------------
const receipt = (label: string, match: RegExp, identity: (f: Fix) => (params: ReadonlyArray<unknown>) => boolean): Receipt<Fix> => ({ label, match, identity });
const STMT_LOCK = receipt("stmt_lock", /FROM kauro\.commission_statements WHERE statement_id = \$1 FOR UPDATE/, (f) => (p) => p[0] === f.statementId);
const INTENT_INSERT = receipt("intent_insert", /INSERT INTO kauro\.payout_intents/, (f) => (p) => p[1] === f.statementId);
const STMT_UPDATE = receipt("stmt_update", /UPDATE kauro\.commission_statements s SET state/, (f) => (p) => p[0] === f.statementId);
const JOURNAL = receipt("journal", /INSERT INTO kauro\.command_journal/, (f) => (p) => p[6] === f.key);
const CASH_LOCK = receipt("cash_lock", /pg_advisory_xact_lock\(hashtextextended\('kauro\.payout-cash'/, () => () => true);
const unit1 = (witness: Receipt<Fix>, phase = "APPROVE") => ({ ordinal: 1, phase, witness, identity: witness.identity });
/** The cash lock every approval takes (a payout-wide advisory lock, no row policy in the way): what a holder holds to make an approval wait. */
const CASH_LOCK_QUERY = "SELECT pg_advisory_xact_lock(hashtextextended('kauro.payout-cash', 0))";

// --- members --------------------------------------------------------------------------------------------------------------------------
type M = Member<Fix, Reply>;
const ROLES = { kauro_app: "kauro_app_test" } as const;
const TABLES = ["payout_intents", "commission_statements"];
/** A member of the CMD052 act; `over` replaces what a member is about. */
const member = (over: Partial<M> & Pick<M, "code" | "tag" | "point">): M => ({
  cell: { table: "CMD052 ApproveCommissionPayout", row: "APPROVE", column: "TEMPLATE" },
  roles: ROLES,
  fixture: (label) => fixture(label),
  act: async (_ctx, f, key) => approve(f, key),
  tables: TABLES,
  earlier: async () => ({}),
  failed: async (f) => nothingApproved(f),
  recover: async (_ctx, f, key) => approve(f, key),
  recovered: async (f) => approvedOnce(f),
  expect: "the approval refused writes nothing; the recovery approves once",
  ...over,
});
const asRun = (m: M): ((ctx: FaultContext) => Promise<void>) => (ctx) => runMember(ctx, m as unknown as Member<unknown, unknown>);
const run = (m: M): Promise<unknown> => runCell(memberCell(m as unknown as Member<never, never>), asRun(m));

// 5.1 lock-timeout ------------------------------------------------------------------------------------------------------------------
const lockTimeout = (code: string, tag: string, waits: Receipt<Fix>): M =>
  member({
    code,
    tag,
    point: { kind: "lock-timeout", hold: async (holder) => void (await holder.query(CASH_LOCK_QUERY)), waits },
    failed: async (f, failure) => {
      assert.deepEqual([(failure as Refused).status, (failure as Refused).code], [503, "CAPACITY_UNAVAILABLE"], `the act that timed out on the lock is answered unavailable (${String(failure)})`);
      await nothingApproved(f);
    },
  });
test("5.1 lock-timeout: an honest member passes (the cash lock is the first conflicting statement, 57014, never answered)", async () => {
  await run(lockTimeout("TPL_LOCK", "[tpllock]", CASH_LOCK));
});
test("5.1 forged: a `waits` receipt naming a statement that ANSWERED before the lock is refused (the waited statement must be the one that failed with 57014)", async () => {
  await assert.rejects(run(lockTimeout("TPL_LOCK_ANSWERED", "[tpllocka]", receipt("journal_any", /INSERT INTO kauro.command_journal/, () => () => true))), /is the statement that timed out on the holder's lock/);
});
test("5.1 forged: a `waits` receipt naming a later statement is refused (the act never dispatched it: the FIRST conflicting statement is the lock)", async () => {
  await assert.rejects(run(lockTimeout("TPL_LOCK_LATER", "[tpllockl]", STMT_LOCK)), /dispatched stmt_lock once with the member's identity params/);
});

// 5.2 port-timeout ------------------------------------------------------------------------------------------------------------------
const reader = portHooks.hook("BuyerTypeReader", { async typeOf(id: string): Promise<string> { return `ORG:${id}`; } });
const PORT_BOUND_MS = 40;
/** An act that is bounded by its own deadline: past it the call is abandoned and the cell clock's instant is judged (an instrumented sink of the operation). */
const boundedAct = async (ctx: FaultContext): Promise<string> => {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Refused(504, "PORT_BOUND")), PORT_BOUND_MS);
  });
  bound.catch(() => undefined);
  try {
    return await Promise.race([reader.typeOf("buyer"), bound]);
  } catch (e) {
    await instrumentPort({ async abandoned(_at: string): Promise<void> {} }, ctx.points, "port-bound").abandoned(ctx.clock.now());
    throw e;
  } finally {
    clearTimeout(timer);
  }
};
const portTimeout = (code: string, tag: string, act: M["act"]): M =>
  member({
    code,
    tag,
    point: { kind: "port-timeout", port: "BuyerTypeReader", boundMs: PORT_BOUND_MS },
    fixture: async () => ({}) as Fix,
    act,
    tables: ["commission_statements"],
    failed: async (_f, failure) => assert.deepEqual([failure instanceof Refused, (failure as Refused).code], [true, "PORT_BOUND"], "the application's own bound ended the operation"),
    recover: async () => reader.typeOf("buyer"),
    recovered: async (_f, recovery) => assert.equal(recovery, "ORG:buyer", "the unarmed port answers"),
  });
test("5.2 port-timeout: an honest member passes (the held call is ended by the application's own bound, past the declared deadline)", async () => {
  await run(portTimeout("TPL_PORT", "[tplport]", async (ctx) => boundedAct(ctx) as never));
});
test("5.2 forged: an act with NO application bound is RED (it still waits on the held call past its bound)", async () => {
  await assert.rejects(run(portTimeout("TPL_PORT_NOBOUND", "[tplportn]", async () => reader.typeOf("buyer") as never)), /no application bound on BuyerTypeReader/);
});
test("5.2 forged: a path that never calls the named port is refused (classify the port by the binding the path calls)", async () => {
  await assert.rejects(run(portTimeout("TPL_PORT_OTHER", "[tplporto]", async () => "never calls the port" as never)), /settled \(fulfilled\) without calling BuyerTypeReader/);
});

// 5.3 crash-before / crash-after ---------------------------------------------------------------------------------------------------
const crash = (code: string, tag: string, kind: "crash-before" | "crash-after", witness: Receipt<Fix>, over: Partial<M> = {}): M =>
  member({
    code,
    tag,
    point: { kind, unit: unit1(witness) },
    ...(kind === "crash-after"
      ? {
          committed: async (f: Fix, outcome: { readonly lost: unknown }) => {
            assert.ok(crashedAt("target.after-commit")(outcome.lost), `the answer was lost to the crash after the target's COMMIT (${String(outcome.lost)})`);
            await approvedOnce(f);
          },
        }
      : {}),
    ...over,
  });
test("5.3 crash-before: an honest member passes (the crash at the target unit's COMMIT leaves nothing; the same key approves once)", async () => {
  await run(crash("TPL_CRB", "[tplcrb]", "crash-before", INTENT_INSERT));
});
test("5.3 crash-after: an honest member passes (the committed unit's answer is lost; the same key replays it, one intent)", async () => {
  await run(crash("TPL_CRA", "[tplcra]", "crash-after", INTENT_INSERT));
});
test("5.3 forged: a target unit that does not carry its witness is refused as another phase", async () => {
  await assert.rejects(run(crash("TPL_CRB_PHASE", "[tplcrbp]", "crash-before", receipt("reconciliation_insert", /INSERT INTO kauro\.payout_reconciliations/, () => () => true))), /target unit is another phase/);
});
test("5.3 forged: a witness whose identity params are not the member's is refused as another phase", async () => {
  await assert.rejects(run(crash("TPL_CRB_IDENTITY", "[tplcrbi]", "crash-before", receipt("intent_insert", /INSERT INTO kauro\.payout_intents/, () => (p) => p[1] === "not-this-statement"))), /target unit is another phase/);
});
test("the footprint is EXACT: a member claiming a row no earlier unit committed is refused", async () => {
  await assert.rejects(run(crash("TPL_FOOTPRINT", "[tplfoot]", "crash-before", INTENT_INSERT, { earlier: async () => ({ commission_statements: [{ not: "a row of the act" }] }) })), /gained exactly the rows the units before the target committed/);
});
test("the footprint is EXACT the other way: a crash-before that leaves a row no earlier unit claims (a residue in a footprint table) is refused", async () => {
  // the forged act commits a change of its own statement's row in a unit of its own before the crashing approval: a residue no
  // `earlier` claims (written as the superuser with triggers off, so the version the recovery expects is untouched)
  const residue: M["act"] = async (ctx, f, key) => {
    await sw.h.oracle.query("BEGIN");
    try {
      await sw.h.oracle.query("SET LOCAL session_replication_role = replica");
      await sw.h.oracle.query("UPDATE kauro.commission_statements SET updated_at = updated_at + interval '1 second' WHERE statement_id = $1", [f.statementId]);
      await sw.h.oracle.query("COMMIT");
    } catch (e) {
      await sw.h.oracle.query("ROLLBACK");
      throw e;
    }
    return approve(f, key);
  };
  await assert.rejects(run(crash("TPL_RESIDUE", "[tplresidue]", "crash-before", INTENT_INSERT, { act: residue })), /kauro\.commission_statements gained exactly the rows the units before the target committed/);
});
test("the footprint's identity match passes a declared UPDATE: the removed row is the previous version (same key) of the row an earlier unit updated", async () => {
  const update: M["act"] = async (_ctx, f, key) => {
    await sw.h.oracle.query("BEGIN");
    try {
      await sw.h.oracle.query("SET LOCAL session_replication_role = replica");
      await sw.h.oracle.query("UPDATE kauro.commission_statements SET updated_at = updated_at + interval '1 second' WHERE statement_id = $1", [f.statementId]);
      await sw.h.oracle.query("COMMIT");
    } catch (e) {
      await sw.h.oracle.query("ROLLBACK");
      throw e;
    }
    return approve(f, key);
  };
  const earlier: M["earlier"] = async (f) => ({ commission_statements: (await rows<{ j: Record<string, unknown> }>(sw, "SELECT row_to_json(x) AS j FROM kauro.commission_statements x WHERE statement_id = $1", [f.statementId])).map((x) => x.j) });
  await run(crash("TPL_FOOT_UPDATE", "[tplfootupd]", "crash-before", INTENT_INSERT, { act: update, earlier }));
});
test("the footprint matches removed rows by IDENTITY: an unrelated deletion hidden behind a legitimate, declared insertion of the same table is refused (B10-KIT-PR1-01)", async () => {
  // the forged act's earlier unit (committed as the superuser, triggers off) deletes a pre-existing outbox record A no earlier unit updates,
  // and inserts a new record B that `earlier` declares exactly: one row gained as declared, one row lost; the count check alone passed it
  const victim = (await rows<{ outbox_id: string; j: Record<string, unknown> }>(sw, "SELECT outbox_id, row_to_json(x) AS j FROM kauro.outbox_records x ORDER BY created_at, outbox_id LIMIT 1"))[0];
  assert.ok(victim !== undefined, "the world has an outbox record before the act");
  const inserted = ids.next() as string;
  const forged: M["act"] = async (_ctx, f, key) => {
    await sw.h.oracle.query("BEGIN");
    try {
      await sw.h.oracle.query("SET LOCAL session_replication_role = replica");
      await sw.h.oracle.query("DELETE FROM kauro.outbox_records WHERE outbox_id = $1", [victim.outbox_id]);
      await sw.h.oracle.query("INSERT INTO kauro.outbox_records SELECT (json_populate_record(NULL::kauro.outbox_records, $1::json)).*", [JSON.stringify({ ...victim.j, outbox_id: inserted })]);
      await sw.h.oracle.query("COMMIT");
    } catch (e) {
      await sw.h.oracle.query("ROLLBACK");
      throw e;
    }
    return approve(f, key);
  };
  const earlier: M["earlier"] = async () => ({ outbox_records: (await rows<{ j: Record<string, unknown> }>(sw, "SELECT row_to_json(x) AS j FROM kauro.outbox_records x WHERE outbox_id = $1", [inserted])).map((x) => x.j) });
  try {
    await assert.rejects(run(crash("TPL_FOOT_DELETE", "[tplfootdel]", "crash-before", INTENT_INSERT, { act: forged, earlier })), /kauro\.outbox_records lost a row that is not the previous version of a row an earlier unit updated/);
  } finally {
    // the world as it was: the victim back, the forged copy gone
    await sw.h.oracle.query("BEGIN");
    await sw.h.oracle.query("SET LOCAL session_replication_role = replica");
    await sw.h.oracle.query("DELETE FROM kauro.outbox_records WHERE outbox_id = $1", [inserted]);
    await sw.h.oracle.query("INSERT INTO kauro.outbox_records SELECT (json_populate_record(NULL::kauro.outbox_records, $1::json)).* ON CONFLICT DO NOTHING", [JSON.stringify(victim.j)]);
    await sw.h.oracle.query("COMMIT");
  }
});
test("5.3 forged: a target ordinal no unit of the act has is refused as another phase, even though unit 1 carries the witness (the target is found by its ordinal, never by its witness)", async () => {
  await assert.rejects(run(member({ code: "TPL_CRB_ORDINAL", tag: "[tplcrbo]", point: { kind: "crash-before", unit: { ...unit1(INTENT_INSERT), ordinal: 2 } } })), /target unit is another phase — unit 2/);
});

// 5.4 partial -----------------------------------------------------------------------------------------------------------------------
const partial = (code: string, tag: string, completedAt: Receipt<Fix>, failing: Receipt<Fix>): M => member({ code, tag, point: { kind: "partial", unit: unit1(INTENT_INSERT), completed: completedAt, failing } });
test("5.4 partial: an honest member passes (the intent insert answered in the target unit before the statement update failed; all rolled back)", async () => {
  await run(partial("TPL_PAR", "[tplpar]", INTENT_INSERT, STMT_UPDATE));
});
test("5.4 forged: a `completed` receipt whose identity params are not the member's is refused", async () => {
  await assert.rejects(run(partial("TPL_PAR_IDENTITY", "[tplpari]", receipt("intent_insert", /INSERT INTO kauro\.payout_intents/, () => (p) => p[1] === "not-this-statement"), STMT_UPDATE)), /answered in the target unit with the identity params/);
});

// 5.5 twice -------------------------------------------------------------------------------------------------------------------------
const twice = (code: string, tag: string, blocks: Receipt<Fix>): M =>
  member({
    code,
    tag,
    // the same command twice (one key): A holds the statement lock after the journal insert, B waits on A's journal row
    act: async (_ctx, f) => approve(f, f.key),
    reverseNa: "both actors are the same command under one key: swapping which one holds changes nothing",
    point: { kind: "twice", holder: { unit: unit1(JOURNAL), holdAfter: STMT_LOCK }, waiter: { unit: unit1(JOURNAL), blocks } },
    recovered: async (f, both) => {
      const { a, b } = both as { a: PromiseSettledResult<Reply>; b: PromiseSettledResult<Reply> };
      assert.deepEqual([a.status, b.status], ["fulfilled", "fulfilled"], "both requests answered");
      await approvedOnce(f);
    },
  });
test("5.5 twice: an honest member passes (B waits on A's journal row, its last statement the journal insert; one durable effect)", async () => {
  await run(twice("TPL_TWICE", "[tpltwice]", JOURNAL));
});
test("5.5 forged: a `blocks` receipt that is not B's last dispatched statement is refused", async () => {
  await assert.rejects(run(twice("TPL_TWICE_BLOCKS", "[tpltwiceb]", CASH_LOCK)), /B's last dispatched statement in its target unit is cash_lock/);
});

test("5.5 forged: a `holdAfter` receipt whose identity params are not the member's is refused (the paused statement must carry the identity; B10-KIT-PR1-02)", async () => {
  const m = twice("TPL_TWICE_HOLDID", "[tpltwicehi]", JOURNAL);
  const p = m.point as Extract<M["point"], { kind: "twice" }>;
  await assert.rejects(run({ ...m, point: { ...p, holder: { ...p.holder, holdAfter: { ...STMT_LOCK, identity: () => () => false } } } }), /TPL_TWICE_HOLDID: A paused after stmt_lock in its target unit 1 with the member's identity params/);
});
test("5.5 forged: a holder paused at the right label in ANOTHER unit than its declared target is refused (B10-KIT-PR1-02)", async () => {
  // A approves another statement first (unit 1, the declared target: it carries the cash-lock witness), then the member's (unit 2), where it
  // pauses after the member's statement lock (`when`: the first approval's lock is not instrumented); B approves the member's only
  let other: Fix | null = null;
  let mine: Fix | null = null;
  let first = true;
  const m = twice("TPL_TWICE_HOLDUNIT", "[tpltwicehu]", JOURNAL);
  const p = m.point as Extract<M["point"], { kind: "twice" }>;
  const forged: M = {
    ...m,
    fixture: async (label) => {
      other = await fixture(`${label}-other`);
      const f = await fixture(label);
      mine = f;
      // cash for both approvals
      await bankCash(sw, (await claimedCents(sw)) + 2n * PAYABLE);
      return f;
    },
    act: async (_ctx, f) => {
      if (first) {
        first = false;
        await approve(other!, other!.key);
      }
      return approve(f, f.key);
    },
    point: { ...p, holder: { unit: unit1(CASH_LOCK), holdAfter: { ...STMT_LOCK, when: (params) => params[0] === mine?.statementId } } },
  };
  await assert.rejects(run(forged), /TPL_TWICE_HOLDUNIT: A paused after stmt_lock in its target unit 1 with the member's identity params/);
});

// 5.6 membership --------------------------------------------------------------------------------------------------------------------
test("5.6 membership: an honest member passes (the revocation first refuses and writes nothing; the act holding the grant commits first; every act after is refused)", async () => {
  const m = member({
    code: "TPL_REV",
    tag: "[tplrev]",
    roles: ROLES,
    // the principal of phases 1 and 2 is its own revocable owner; phase 3 acts as the principal revoked in phase 2 (`after`)
    fixture: async (label, after?: Fix) => {
      return after === undefined ? fixture(label, { own: true }) : fixture(label, { person: after.person, grantId: after.grantId });
    },
    point: {
      kind: "membership",
      holdAfter: STMT_LOCK,
      revoke: async (c: HarnessConnection, f: Fix) => void (await c.query(REVOKE_GRANT, [f.grantId])),
      refusal: (e) => e instanceof Refused && e.code === "NOT_AUTHORIZED",
    },
  });
  await run(m);
});

const membershipMember = (code: string, tag: string, over: Partial<Extract<M["point"], { kind: "membership" }>> = {}): M =>
  member({
    code,
    tag,
    roles: ROLES,
    fixture: async (label, after?: Fix) => (after === undefined ? fixture(label, { own: true }) : fixture(label, { person: after.person, grantId: after.grantId })),
    point: {
      kind: "membership",
      holdAfter: STMT_LOCK,
      revoke: async (c: HarnessConnection, f: Fix) => void (await c.query(REVOKE_GRANT, [f.grantId])),
      refusal: (e) => e instanceof Refused && e.code === "NOT_AUTHORIZED",
      ...over,
    },
  });
test("5.6 forged: a revocation that never blocks the act (it locks nothing the act reads) is refused: the act must be OBSERVED waiting on the uncommitted revocation", async () => {
  await assert.rejects(run(membershipMember("TPL_REV_NOBLOCK", "[tplrevn]", { revoke: async (c: HarnessConnection) => void (await c.query("SELECT 1")) })), /TPL_REV_NOBLOCK: the act while the revocation is uncommitted (finished|failed).*without waiting/);
});
test("5.6 forged: a member whose declared refusal is not the act's is refused (the act that waited must be refused as the member declares)", async () => {
  await assert.rejects(run(membershipMember("TPL_REV_REFUSAL", "[tplrevr]", { refusal: (e) => e instanceof Refused && e.code === "NOT_THE_REFUSAL" })), /TPL_REV_REFUSAL: the act that waited is refused as the member declares/);
});
test("5.6 forged: a `holdAfter` receipt whose identity params are not the member's is refused (the paused statement must carry the identity; B10-KIT-PR1-02)", async () => {
  await assert.rejects(run(membershipMember("TPL_REV_HOLDID", "[tplrevhi]", { holdAfter: { ...STMT_LOCK, identity: () => () => false } })), /TPL_REV_HOLDID: the act paused after stmt_lock with the member's identity params/);
});
test("5.6 forged: phase three refuses as declared but leaves an unrelated durable write: its footprint (zero change) is refused (B10-KIT-PR1-03)", async () => {
  const phase3 = new Set<string>();
  const honest = membershipMember("TPL_REV_RESIDUE", "[tplrevres]");
  const m: M = {
    ...honest,
    fixture: async (label, after?: Fix) => {
      const f = await honest.fixture(label, after);
      if (after !== undefined) phase3.add(f.statementId);
      return f;
    },
    // the act after the revocation commits a change of its statement's row (superuser, triggers off) before it is refused NOT_AUTHORIZED
    act: async (_ctx, f, key) => {
      if (phase3.has(f.statementId)) {
        await sw.h.oracle.query("BEGIN");
        try {
          await sw.h.oracle.query("SET LOCAL session_replication_role = replica");
          await sw.h.oracle.query("UPDATE kauro.commission_statements SET updated_at = updated_at + interval '1 second' WHERE statement_id = $1", [f.statementId]);
          await sw.h.oracle.query("COMMIT");
        } catch (e) {
          await sw.h.oracle.query("ROLLBACK");
          throw e;
        }
      }
      return approve(f, key);
    },
  };
  await assert.rejects(run(m), /TPL_REV_RESIDUE refused after the revocation \(every act after it\): kauro\.commission_statements gained exactly the rows/);
});

// 5.7 step-up expiry (last: it moves the api's process clock past a proof's expiry) -----------------------------------------------
test("5.7 step-up expiry: an honest member passes (the proof runs out while the act waits on the cash lock; refused, nothing written)", async () => {
  const api = sw.w.processClock as unknown as { now: () => unknown; nowMs: () => number };
  const real = { now: api.now, nowMs: api.nowMs };
  const m = member({
    code: "TPL_STEPUP",
    tag: "[tplstepup]",
    fixture: (label) => fixture(label, { proofIssuedMinutesAgo: 14 }),
    // the api's process clock follows the cell's controlled clock while the act runs: crossing the deadline there crosses it in the
    // application; CMD052's step-up verifier is the platform's, instrumented, so the instant it judges the proof at after the wait (approve-
    // payout.ts, the judgment at the effect) is what consumes the deadline. Nothing here feeds the evidence itself.
    act: async (ctx, f, key) => {
      api.nowMs = () => Math.max(real.nowMs(), ctx.clock.nowMs());
      api.now = () => new Date(api.nowMs()).toISOString();
      stepUpPort = instrumentPort(platformStepUp, ctx.points, "stepup");
      try {
        return await approve(f, key);
      } finally {
        stepUpPort = platformStepUp;
        api.nowMs = real.nowMs;
        api.now = real.now;
      }
    },
    point: {
      kind: "step-up-expiry",
      waitOn: async (holder: HarnessConnection) => void (await holder.query(CASH_LOCK_QUERY)),
      proofExpiresAt: (f: Fix) => f.expiresAt!,
    },
    failed: async (f, failure) => {
      assert.ok(failure instanceof Refused && failure.status === 403 && failure.code === "ASSURANCE_REQUIRED", `a proof that expired during the wait authorizes nothing (${String(failure)})`);
      await nothingApproved(f);
    },
    // the proof is spent: the recovery is a fresh approval of the same statement with a fresh proof
    recover: async (_ctx, f, key) => approve({ ...f, body: { ...f.body, authorizationRef: await sw.w.stepUp(f.person) } }, key),
  });
  await run(m);
});

test("5.7 forged: a holder that blocks nothing the act needs (the act never waits while its proof runs out) is refused", async () => {
  const m = member({
    code: "TPL_STEPUP_NOWAIT",
    tag: "[tplstepupn]",
    fixture: (label) => fixture(label, { proofIssuedMinutesAgo: 14 }),
    point: { kind: "step-up-expiry", waitOn: async (holder: HarnessConnection) => void (await holder.query("SELECT 1")), proofExpiresAt: (f: Fix) => f.expiresAt! },
  });
  await assert.rejects(run(m), /TPL_STEPUP_NOWAIT: the act while its step-up proof runs out (finished|failed).*without waiting/);
});
