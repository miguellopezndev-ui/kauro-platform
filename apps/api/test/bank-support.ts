// `bankWorld`: the test world of the Payments V1 bank-transfer route (docs/design/ACH-ROUTE.md r12; lane KIT). One IntegrationWorld (the real
// B09/B10 stack on PostgreSQL), the CONTRACT_FAKE bank evidence port and store bound to a fixed account, helpers that put classified
// evidence in the store the way an owner's artifact would arrive, and the HOLD POINTS the lanes' failure cells race against: the lock
// holders of ACH-ROUTE §7.28 (L1 account outbound stream, the inbound stream, an attempt or refund row at L3), each a connection of the
// common fault harness inside an open transaction that the cell releases at the point it names, with the waiter observed in
// pg_stat_activity (`mustWaitOn`). No business logic lives here and no lane's command is imported: the lanes bring their own commands and
// call these helpers; the failure-matrix template rules 1, 4 and 10 apply to every cell that uses them (both orders, observed waits, DB clock).
import type { Sha256Hex } from "@kauro/contracts";
import type { BankAccountRef, PaymentEnvironment } from "@kauro/domain";
import { fakeCreditBytes, fakeOutboundBytes, fakeStatementBytes, type BankEvidenceFake, type FakeCreditFields, type FakeOutboundFields, type FakeStatementFields } from "@kauro/application/testing";
import { connectionPid, openConnection, type FaultContext, type HarnessConnection, type Waiting } from "@kauro/persistence/testing";
import { BANK_ACCOUNT, BANK_ENVIRONMENT, BANK_PAYEE_DIGEST, ROUTE_TIMING, bankEvidenceFake, testDestinationFingerprinter } from "./bank-constants-support.js";
import { BankFixtures, integrationBankPurchase, staleFinanceWorker, type CreditVersion, type StaleWorker } from "./bank-fixtures-support.js";
import { integrationWorld, type Agent, type IntegrationWorld } from "./integration-support.js";
import type { Purchase } from "./commission-support.js";
import type { Reply } from "./support.js";

export { BANK_ACCOUNT, BANK_ENVIRONMENT, BANK_PAYEE_DIGEST };
export type { CreditVersion, StaleWorker };

/** The names a lane uses for `ctx.points.pause(...)` where its production code calls a registered hold; fixed here so the lanes agree. */
export const BANK_HOLD_POINTS = {
  /** After `Koffer` COMMITs and before the evidence read (DV1-11 step 1 -> 2). */
  OFFER_COMMITTED: "bank:offer-committed",
  /** After the gate read and classification, before the outcome transaction (step 2 -> 3). */
  GATE_READ: "bank:gate-read",
  /** Inside the outcome transaction with L1 -> L4 taken. */
  OUTCOME_LOCKED: "bank:outcome-locked",
  /** Inside X1/X4 with L1 -> L3 taken, before the attempt row is written. */
  DECLARE_LOCKED: "bank:declare-locked",
  /** Inside SI2 with L1 and the identity locks taken, before the lines are written. */
  STATEMENT_LOCKED: "bank:statement-locked",
  /** Inside CMD215 with L1, INBOUND and the payout cash lock taken, before the owner's re-judgement and the settlement row (PV1-SETTLE). */
  SETTLEMENT_LOCKED: "bank:settlement-locked",
} as const;

export type HeldLockKind = "L1_OUTBOUND_STREAM" | "INBOUND_STREAM" | "L3_ATTEMPT_ROW" | "PAYOUT_CASH";

/** A lock a cell holds, in an open transaction, until it releases it. */
export interface HeldLock {
  readonly kind: HeldLockKind;
  /** The backend of the holder: the `holder` of `mustWait` and of pg_blocking_pids. */
  readonly pid: number;
  readonly connection: HarnessConnection;
  /** Ends the holding transaction (ROLLBACK: nothing was written) and closes the connection. Idempotent. */
  release(): Promise<void>;
}

export type BankLogin = "kauro_payment_test" | "kauro_app_test" | "kauro_control_test";

export interface StoredBankArtifact {
  readonly artifactRef: string;
  readonly evidenceHash: Sha256Hex;
}

export interface BankWorld {
  readonly iw: IntegrationWorld;
  /** The CONTRACT_FAKE evidence port and its restricted store (SIMULATED: never provider evidence). */
  readonly evidence: BankEvidenceFake;
  readonly accountRef: BankAccountRef;
  readonly environment: PaymentEnvironment;
  /** Puts a credit artifact in the store, as an owner's stored bank artifact would arrive, and returns its locator. */
  storeCredit(fields: FakeCreditFields): Promise<StoredBankArtifact>;
  /** Puts an execution artifact (a send receipt) in the store. */
  storeOutbound(fields: FakeOutboundFields): Promise<StoredBankArtifact>;
  /** Puts an owner-imported statement artifact in the store. */
  storeStatement(fields: FakeStatementFields): Promise<StoredBankArtifact>;
  /** Takes L1 (`pg_advisory_xact_lock(kauro.bank_stream_lock_key(env, account, 'OUTBOUND'))`) on a fresh connection and holds it. */
  holdOutboundStream(login?: BankLogin): Promise<HeldLock>;
  /** The inbound stream's twin (the credit-side serialization of statement coverage). */
  holdInboundStream(login?: BankLogin): Promise<HeldLock>;
  /** Locks an attempt row `FOR NO KEY UPDATE` (L3) and holds it. */
  holdAttemptRow(attemptId: string, login?: BankLogin): Promise<HeldLock>;
  /** Runs `operation` on a fresh connection and proves, in pg_stat_activity, that it waits on `held` (template rule 1: never a sleep). */
  mustWaitOn<T>(ctx: Pick<FaultContext, "mustWait">, held: HeldLock, operation: (connection: HarnessConnection) => Promise<T>, what: string, login?: BankLogin): Promise<{ readonly waiting: Waiting<T>; readonly waiter: HarnessConnection }>;
  // --- Payments V1 seams of the red-first lanes (KIT-2; apps/api/test/bank-fixtures-support.ts) ----------------------------------------
  /** The fixtures the seams below are made of (the lane route, the credit/capture writers, the consumer hooks). */
  readonly fixtures: BankFixtures;
  /** S1: a purchase whose order was issued by CMD028 with routeKind BANK_TRANSFER and whose capture COMPLETED from one applied exact credit. */
  paidByBankTransfer(agent: Agent, label: string): Promise<Purchase>;
  /** S2: a credit in RETURN_REVIEW and a REQUESTED treasury refund of its whole gross (migration 0054 bank_credits / treasury_refunds). */
  unassignedCredit(cents: bigint, label: string): Promise<{ readonly bankCreditId: string; readonly treasuryRefundId: string }>;
  /** S4: a recipient-record artifact (kind RECIPIENT of the CONTRACT_FAKE store) for DP-RECIPIENT. */
  storeRecipientRecord(record: { readonly recipientRef: string; readonly recipientVersion: string; readonly full: { readonly routingNumber: string; readonly accountNumber: string; readonly holderName: string } }): Promise<StoredBankArtifact>;
  /** S5: stores an authenticated reversal version of a credit (by credit id or capture id) and hands it to `fixtures.creditVersionConsumer` (L-INBOUND binds it). */
  reverseCredit(creditOrCaptureId: string, cents: bigint): Promise<Reply | void>;
  /** S6: the manual execution window and coverage lag of the route version in force (the columns of bank_route_versions, migration 0054). */
  routeTiming(): { readonly manualExecutionWindowMs: number; readonly coverageLagMs: number };
  /** S7: a FINANCE dispatcher superseded by a rival at the lease: its pass can only report FENCED. */
  staleFinanceWorker(): Promise<StaleWorker>;
  /** Releases every lock the world still holds and stops it. */
  stop(): Promise<void>;
}

export async function bankWorld(options: { readonly world?: IntegrationWorld; readonly sessions?: boolean } = {}): Promise<BankWorld> {
  // sessions: opt-in (PV1 L-ROUTE r1, RR-4), the B11 session boundary of the world built here; absent, unchanged
  const iw = options.world ?? (await integrationWorld(options.sessions === true ? { sessions: true } : {}));
  // a world built with integrationWorld({ bankEvidence: true }) already carries (and has bound) its store: one store per world
  const evidence = iw.bankEvidence?.evidence ?? bankEvidenceFake();
  // the api reads the bank route's details artifacts from this store (lane L-ROUTE; ApiAssembly.bank, bound at call time)
  iw.w.bank.evidence = evidence;
  // lane L-REFUND: the test destination fingerprinter (S3) and the fake's credit classifier of the payer evidence
  iw.w.bank.fingerprinter = testDestinationFingerprinter;
  iw.w.bank.creditClassifier = evidence;
  const open = (login: BankLogin): Promise<HarnessConnection> => openConnection(iw.h.pg.clientConfig(login));
  const held = new Set<HeldLock>();
  const fixtures = new BankFixtures({ cw: iw, w: iw.w, owner: iw.owner, evidence, accountRef: BANK_ACCOUNT, environment: BANK_ENVIRONMENT, payeeDigest: BANK_PAYEE_DIGEST, buyers: iw.buyers });

  async function hold(kind: HeldLockKind, login: BankLogin, take: (c: HarnessConnection) => Promise<unknown>): Promise<HeldLock> {
    const connection = await open(login);
    let ended = false;
    const lock: HeldLock = {
      kind,
      pid: connectionPid(connection),
      connection,
      async release() {
        if (ended) return;
        ended = true;
        held.delete(lock);
        try {
          await connection.query("ROLLBACK");
        } finally {
          await connection.end();
        }
      },
    };
    held.add(lock);
    try {
      await connection.query("BEGIN");
      await take(connection);
    } catch (e) {
      await lock.release();
      throw e;
    }
    return lock;
  }

  const store = async (bytes: Uint8Array): Promise<StoredBankArtifact> => {
    const { artifactRef, sha256 } = await evidence.put({ bytes });
    return { artifactRef, evidenceHash: sha256 };
  };

  return {
    iw,
    evidence,
    accountRef: BANK_ACCOUNT,
    environment: BANK_ENVIRONMENT,
    storeCredit: (fields) => store(fakeCreditBytes(BANK_ACCOUNT, fields)),
    storeOutbound: (fields) => store(fakeOutboundBytes(BANK_ACCOUNT, fields)),
    storeStatement: (fields) => store(fakeStatementBytes(BANK_ACCOUNT, fields)),
    fixtures,
    paidByBankTransfer: (agent, label) => integrationBankPurchase(fixtures, iw, agent, label),
    unassignedCredit: (cents, label) => fixtures.unassignedCredit(cents, label),
    storeRecipientRecord: async (record) => {
      const r = await fixtures.storeRecipientRecord(record);
      return { artifactRef: r.artifactRef, evidenceHash: r.evidenceHash };
    },
    reverseCredit: (id, cents) => fixtures.reverseCredit(id, cents),
    routeTiming: () => ROUTE_TIMING,
    staleFinanceWorker: () => staleFinanceWorker(iw),
    holdOutboundStream: (login = "kauro_payment_test") =>
      hold("L1_OUTBOUND_STREAM", login, (c) => c.query("SELECT pg_advisory_xact_lock(kauro.bank_stream_lock_key($1, $2, 'OUTBOUND'))", [BANK_ENVIRONMENT, BANK_ACCOUNT])),
    holdInboundStream: (login = "kauro_payment_test") =>
      hold("INBOUND_STREAM", login, (c) => c.query("SELECT pg_advisory_xact_lock(kauro.bank_stream_lock_key($1, $2, 'INBOUND'))", [BANK_ENVIRONMENT, BANK_ACCOUNT])),
    holdAttemptRow: (attemptId, login = "kauro_payment_test") =>
      hold("L3_ATTEMPT_ROW", login, async (c) => {
        const r = await c.query("SELECT 1 FROM kauro.outbound_execution_attempts WHERE attempt_id = $1 FOR NO KEY UPDATE", [attemptId]);
        if (r.rowCount !== 1) throw new Error(`no attempt ${attemptId} to hold`);
      }),
    async mustWaitOn(ctx, lock, operation, what, login = "kauro_payment_test") {
      const waiter = await open(login);
      try {
        const waiting = await ctx.mustWait(iw.h.oracle, { waiter, holder: lock.pid }, operation, what);
        // the caller releases the holder and awaits `waiting.pending`; the waiter connection is closed once that settles
        void waiting.pending.finally(() => waiter.end().catch(() => undefined));
        return { waiting, waiter };
      } catch (e) {
        await waiter.end().catch(() => undefined);
        throw e;
      }
    },
    async stop() {
      for (const lock of [...held]) await lock.release();
      if (options.world === undefined) await iw.stop();
    },
  };
}
