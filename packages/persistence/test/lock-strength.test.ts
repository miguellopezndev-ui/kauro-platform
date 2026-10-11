// Rule 11a (FAILURE-MATRIX-TEMPLATE) on real PostgreSQL 17: a row lock a writer takes before the transition's exclusive half must not block the
// KEY SHARE that an inserter takes through its foreign key AFTER it took the subject's shared half, or the two close a 40P01 cycle for one
// order. One RACE cell per locked subject, both orders, observed with the fault harness (mustWait: the second actor is seen waiting on the
// first one's lock, never a sleep):
//   - READER FIRST: the reader holds the shared half (kauro.await_transition); the writer row-locks the subject through the REAL repository
//     method and asks for the exclusive half (the state change's trigger takes it) and is seen waiting on the reader; the reader then takes
//     the KEY SHARE its insert takes on the subject's row. Under FOR UPDATE that KEY SHARE waits for the writer: deadlock.
//   - WRITER FIRST: the writer holds the row lock and the exclusive half; the reader's shared half is seen waiting; the writer commits and
//     the reader proceeds (no cycle exists, and the cell proves the reader is not left behind).
// The actors run as the superuser (the lock SQL is the subject, not the policies).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import type { AgencyId, CapabilityId, CaptureId, CommercialAuthorizationId, MembershipId, ProjectId, QuoteId, TargetContractId, UserId } from "@kauro/domain";
import { PgAgencyRepository, PgCapabilityGovernanceRepository, PgCaptureFactRepository, PgCommercialAuthorizationRepository, PgMembershipRepository, PgProjectRepository, PgQuoteRepository, PgTargetContractRepository } from "../src/index.js";
import type { CommerceWriteContext } from "../src/repositories/commerce-shared.js";
import { PgExecutionStore, type ExecutionWriteContext } from "../src/execution/store.js";
import { start, type AgencyFixture, type Harness } from "../src/testing/harness.js";
import { connectionPid, mustWait, openConnection } from "../src/testing/index.js";
import { activateAgency, approvedSubject, createdOrder, fiscalProfile, grantKauroOwner, issuedQuote, observedCapture, qualifiedRoutes } from "./commerce-support.js";
import { project, sqlState } from "./support.js";

let h: Harness;
let A: AgencyFixture;
let hubspotCapability: string;
let quoteId: string;
let captureId: string;
let authorizationId: string;
let projectId: string;
let contractId: string;

before(async () => {
  h = await start();
  const app = await h.pg.connect("kauro_app_test");
  const control = await h.pg.connect("kauro_control_test");
  const assurance = await h.pg.connect("kauro_assurance_test");
  const validator = await h.pg.connect("kauro_validator_test");
  const payment = await h.pg.connect("kauro_payment_test");
  try {
    const alice = (await h.person("alice-lock-strength")) as UserId;
    const kora = (await h.person("kora-lock-strength")) as UserId;
    A = await h.createAgency(alice, "Lock strength A");
    await activateAgency(app, A);
    const client = await h.endClient(A, await h.processingAuthority(A), "Client A");
    hubspotCapability = await h.offeredCapability("HUBSPOT");
    const routes = await qualifiedRoutes(control);
    await grantKauroOwner(control, kora);
    const profile = await fiscalProfile(app, kora, A, routes.issuerRef, "EXEMPT_EXPORT");
    const made = await project(app, A, client, hubspotCapability, "HUBSPOT");
    const subject = await approvedSubject({ app, control }, validator, assurance, A, made.projectId, "lock-strength");
    const quote = await issuedQuote(app, A, subject, profile, routes.issuerRef);
    const order = await createdOrder(app, A, quote, routes, { payment });
    const paid = await observedCapture(payment, A, order, routes, { amountCents: quote.totalCents, serviceCents: quote.serviceCents, taxCents: quote.taxCents, excessCents: 0 }, hubspotCapability);
    quoteId = quote.quoteId;
    captureId = paid.captureId;
    authorizationId = paid.authorizationId as string;
    projectId = made.projectId;
    contractId = subject.contractId;
  } finally {
    for (const c of [app, control, assurance, validator, payment]) await c.end();
  }
});
after(async () => {
  await h.stop();
});

interface Site {
  readonly name: string;
  /** The transition subject the reader takes the shared half of and the writer the exclusive half of. */
  readonly kind: string;
  readonly key: () => string;
  /** The subject's row and primary key, on which the reader takes the KEY SHARE its insert takes through the foreign key. */
  readonly table: string;
  readonly pk: string;
  readonly rowId: () => string;
  /** The repository's own row lock, as the writer takes it. */
  readonly lock: (c: Client) => Promise<unknown>;
}

const ctx = (c: Client) => ({ db: c }) as unknown as CommerceWriteContext;
const executionStore = (c: Client) => new PgExecutionStore({ db: c } as unknown as ExecutionWriteContext);

const SITES: readonly Site[] = [
  { name: "quote (CMD027 / CMD028)", kind: "kauro.quotes", key: () => quoteId, table: "quotes", pk: "quote_id", rowId: () => quoteId, lock: (c) => new PgQuoteRepository(ctx(c)).lock(quoteId as QuoteId) },
  { name: "capture fact", kind: "kauro.capture_facts", key: () => captureId, table: "capture_facts", pk: "capture_id", rowId: () => captureId, lock: (c) => new PgCaptureFactRepository(ctx(c)).lock(captureId as CaptureId) },
  { name: "commercial authorization", kind: "kauro.commercial_authorizations", key: () => authorizationId, table: "commercial_authorizations", pk: "authorization_id", rowId: () => authorizationId, lock: (c) => new PgCommercialAuthorizationRepository(ctx(c)).lock(authorizationId as CommercialAuthorizationId) },
  { name: "commercial authorization (publication edge, execution store)", kind: "kauro.commercial_authorizations", key: () => authorizationId, table: "commercial_authorizations", pk: "authorization_id", rowId: () => authorizationId, lock: (c) => executionStore(c).lockAuthorizationRow(authorizationId as CommercialAuthorizationId) },
  { name: "commercial authorization (tryLockAuthorization, execution store)", kind: "kauro.commercial_authorizations", key: () => authorizationId, table: "commercial_authorizations", pk: "authorization_id", rowId: () => authorizationId, lock: (c) => executionStore(c).tryLockAuthorization(authorizationId as CommercialAuthorizationId) },
  { name: "agency", kind: "kauro.agencies", key: () => A.agencyId, table: "agencies", pk: "agency_id", rowId: () => A.agencyId, lock: (c) => new PgAgencyRepository(c).lock(A.agencyId as AgencyId) },
  { name: "membership", kind: "kauro.memberships", key: () => `${A.agencyId}:${A.ownerUserId}`, table: "memberships", pk: "membership_id", rowId: () => A.ownerMembershipId, lock: (c) => new PgMembershipRepository(c).lock(A.ownerMembershipId as MembershipId) },
  { name: "project", kind: "kauro.projects", key: () => projectId, table: "projects", pk: "project_id", rowId: () => projectId, lock: (c) => new PgProjectRepository(c).lock(projectId as ProjectId) },
  { name: "target contract", kind: "kauro.target_contracts", key: () => contractId, table: "target_contracts", pk: "contract_id", rowId: () => contractId, lock: (c) => new PgTargetContractRepository(c).lockLifecycle(contractId as TargetContractId) },
  { name: "capability", kind: "kauro.capabilities", key: () => "HUBSPOT", table: "capabilities", pk: "capability_id", rowId: () => hubspotCapability, lock: (c) => new PgCapabilityGovernanceRepository(c).lockCapability(hubspotCapability as CapabilityId) },
];

async function cell(s: Site, readerFirst: boolean): Promise<void> {
  const reader = await openConnection(h.pg.clientConfig("postgres"));
  const writer = await openConnection(h.pg.clientConfig("postgres"));
  const keyShare = `SELECT 1 FROM kauro.${s.table} WHERE ${s.pk} = $1 FOR KEY SHARE`;
  try {
    await reader.query("BEGIN");
    await writer.query("BEGIN");
    if (readerFirst) {
      await reader.query("SELECT kauro.await_transition($1, $2)", [s.kind, s.key()]);
      await s.lock(writer);
      const waiting = await mustWait(h.oracle, { waiter: writer, holder: connectionPid(reader) }, (c) => c.query("SELECT pg_advisory_xact_lock(kauro.transition_key($1, $2))", [s.kind, s.key()]), `${s.name}: the exclusive half behind the reader's shared half`);
      // the reader's insert now takes its KEY SHARE through the foreign key
      const read = await reader.query(keyShare, [s.rowId()]).then(
        () => "ok",
        (e: unknown) => `refused ${String(sqlState(e))}`,
      );
      assert.equal(read, "ok", `${s.name}: the reader's KEY SHARE is not refused (a deadlock victim is 40P01)`);
      await reader.query("COMMIT");
      const writerEnd = await waiting.pending;
      assert.equal(writerEnd.status, "fulfilled", `${s.name}: the writer takes the exclusive half once the reader committed`);
      await writer.query("COMMIT");
    } else {
      await s.lock(writer);
      await writer.query("SELECT pg_advisory_xact_lock(kauro.transition_key($1, $2))", [s.kind, s.key()]);
      const waiting = await mustWait(h.oracle, { waiter: reader, holder: connectionPid(writer) }, (c) => c.query("SELECT kauro.await_transition($1, $2)", [s.kind, s.key()]), `${s.name}: the shared half behind the writer's exclusive half`);
      await writer.query("COMMIT");
      const readerEnd = await waiting.pending;
      assert.equal(readerEnd.status, "fulfilled", `${s.name}: the reader proceeds after the writer committed`);
      await reader.query(keyShare, [s.rowId()]);
      await reader.query("COMMIT");
    }
  } finally {
    for (const c of [reader, writer]) await c.query("ROLLBACK").catch(() => undefined);
    await reader.end();
    await writer.end();
  }
}

for (const s of SITES) {
  test(`RACE 11a reader first: ${s.name}: the shared half then the insert's KEY SHARE against the writer's row lock then exclusive half does not deadlock`, async () => {
    await cell(s, true);
  });
  test(`RACE 11a writer first: ${s.name}: the writer's row lock and exclusive half first, the reader's shared half waits and proceeds`, async () => {
    await cell(s, false);
  });
}

// --- the FOR UPDATE rows that stay: no reader of theirs takes a shared half, so no cycle can close on them ---------------------------------
// A row lock keeps FOR UPDATE only where the matrix shows no inserter takes the subject's shared half before its KEY SHARE (rule 11a's
// exception: CLOSE_HOLD_RACE, a hold inserted on a commission line takes no transition half). This cell fails the day a migration or a
// repository starts awaiting one of these subjects, which then needs its own cell above and a NO KEY lock.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..", "src");

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourcesUnder(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

test("RACE 11a (no defect): the row locks that stay FOR UPDATE — commission pools, periods, statements, claims, founding reservations, upload sessions, jobs — are the subject of no shared half; commission lines are awaited only by the payout intent, which references no line", async () => {
  const awaited = new Set<string>();
  const sql = readdirSync(join(HERE, "..", "..", "migrations")).filter((f) => f.endsWith(".sql"));
  for (const f of sql) {
    const text = readFileSync(join(HERE, "..", "..", "migrations", f), "utf8");
    for (const m of text.matchAll(/(?:try_)?await_transition\(\s*'([a-z_.]+)'/g)) awaited.add(m[1] as string);
  }
  for (const f of sourcesUnder(SRC)) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/(?:try_)?await_transition\(\s*'(kauro\.[a-z_]+)'/g)) awaited.add(m[1] as string);
    for (const m of text.matchAll(/(?:awaitTransition|await)\((?:uow, |this\.db, |db, )?"(kauro\.[a-z_]+)"/g)) awaited.add(m[1] as string);
  }
  for (const subject of ["commission_pools", "commission_periods", "commission_statements", "attribution_claims", "founding_slot_reservations", "upload_sessions", "processing_jobs", "refunds", "payment_orders", "payment_attempts", "tax_documents"]) {
    assert.ok(!awaited.has(`kauro.${subject}`), `kauro.${subject} is awaited by a shared half: it needs a RACE cell and FOR NO KEY UPDATE`);
  }
  // the one reader of a commission line's shared half is the payout intent's insert (payout_lines_unpayable), which has no line to key-share
  const refs = await h.oracle.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND conrelid = 'kauro.payout_intents'::regclass AND confrelid = 'kauro.commission_lines'::regclass");
  assert.equal(refs.rows[0]?.n, 0, "payout_intents references no commission line");
  const callers = await h.oracle.query<{ relation: string }>(
    `SELECT DISTINCT c.relname AS relation FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND p.prokind = 'f' AND p.prosrc LIKE '%payout_lines_unpayable%' ORDER BY 1`,
  );
  assert.deepEqual(callers.rows, [{ relation: "payout_intents" }], "only the payout intent's insert awaits commission lines");
});
