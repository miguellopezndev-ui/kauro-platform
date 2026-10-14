// Payments V1 bank-transfer route, lane KIT (migration 0045; docs/design/ACH-ROUTE.md r12): the tables and the vocabulary exist as the
// design fixes them, mirror the domain lists exactly, name no provider (DV1-01), hold no plaintext destination number (DV1-10) and carry
// the two structural fences the lanes build on (NEVER-RESEND: one open attempt per source; L4: one execution identity). The guards and
// behaviour are the lanes'; nothing here exercises a guard trigger because the KIT has none.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import {
  BANK_CASE_KINDS,
  BANK_CASE_SOURCE_KINDS,
  BANK_CREDIT_SOURCES,
  BANK_CREDIT_STATES,
  BANK_CREDIT_STATUSES,
  BANK_ORDER_EXTENSION,
  BANK_ORDER_STATES,
  BANK_RAILS,
  BANK_STATE_MACHINES,
  COVERAGE_STREAMS,
  DEBIT_CORRELATIONS,
  DESTINATION_PROOFS,
  EXECUTION_ATTEMPT_KINDS,
  EXECUTION_ATTEMPT_STATES,
  EXECUTION_GATE_OUTCOMES,
  EXECUTION_OFFER_COMMANDS,
  EXECUTION_SOURCE_KINDS,
  STATEMENT_LINE_KINDS,
} from "@kauro/domain";
import { startTemporaryPostgres, type TemporaryPostgres } from "../src/testing/index.js";
import { constraintOf, event, sqlState } from "./support.js";

let pg: TemporaryPostgres;
let oracle: Client;
let payment: Client;
let app: Client;

before(async () => {
  pg = await startTemporaryPostgres();
  oracle = await pg.connect("postgres");
  payment = await pg.connect("kauro_payment_test");
  app = await pg.connect("kauro_app_test");
});
after(async () => {
  await app.end();
  await payment.end();
  await oracle.end();
  await pg.stop();
});

const NEW_TABLES = [
  "bank_vocabulary",
  "bank_machine_edges",
  "outbound_execution_attempts",
  "refund_destinations",
  "execution_offers",
  "execution_offer_outcomes",
  "statement_imports",
  "statement_coverage",
  "statement_lines",
  "execution_correlations",
  "bank_source_freezes",
  "bank_review_cases",
];

// uuidv7-shaped ids that differ per call; the tables only check the version nibble
let seq = 0;
const id = (): string => `01920000-0000-7000-8000-${(0x4b1700000000 + ++seq).toString(16).padStart(12, "0")}`;
const SHA = "a".repeat(64);
const REF = (n: number): string => `kauro-refund-01920000-0000-7000-8000-000000000001-${n}`;

/** An attempt over a BANK_CREDIT source (route scope), overridable column by column. */
async function attempt(c: Client, o: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    attempt_id: id(),
    environment: "SANDBOX",
    account_ref: "acct-kit-1",
    kind: "RETURN",
    source_kind: "BANK_CREDIT",
    bank_credit_id: id(),
    treasury_refund_id: id(),
    attempt_number: 1,
    reference: REF(++seq),
    amount_cents: 10000,
    currency: "USD",
    declared_by: id(),
    destination_fingerprint: SHA,
    fingerprint_key_id: "key-1",
    fingerprint_key_version: 1,
    fingerprint_norm_version: "destination-norm-v1",
    ...o,
  };
  const cols = Object.keys(row);
  await c.query(`INSERT INTO kauro.outbound_execution_attempts (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((k) => row[k]));
  return row["attempt_id"] as string;
}

test("the vocabulary table mirrors every closed domain list exactly (BANK_RAILS ... COVERAGE_STREAMS)", async () => {
  const mirrored: Record<string, ReadonlyArray<string>> = {
    BANK_RAIL: BANK_RAILS,
    BANK_ORDER_STATE: BANK_ORDER_STATES,
    BANK_CREDIT_STATE: BANK_CREDIT_STATES,
    BANK_CREDIT_SOURCE: BANK_CREDIT_SOURCES,
    BANK_CREDIT_STATUS: BANK_CREDIT_STATUSES,
    EXECUTION_ATTEMPT_KIND: EXECUTION_ATTEMPT_KINDS,
    EXECUTION_ATTEMPT_STATE: EXECUTION_ATTEMPT_STATES,
    EXECUTION_SOURCE_KIND: EXECUTION_SOURCE_KINDS,
    DESTINATION_PROOF: DESTINATION_PROOFS,
    EXECUTION_OFFER_COMMAND: EXECUTION_OFFER_COMMANDS,
    EXECUTION_GATE_OUTCOME: EXECUTION_GATE_OUTCOMES,
    DEBIT_CORRELATION: DEBIT_CORRELATIONS,
    BANK_CASE_KIND: BANK_CASE_KINDS,
    BANK_CASE_SOURCE_KIND: BANK_CASE_SOURCE_KINDS,
    STATEMENT_LINE_KIND: STATEMENT_LINE_KINDS,
    COVERAGE_STREAM: COVERAGE_STREAMS,
  };
  const rows = await oracle.query<{ vocabulary: string; code: string }>("SELECT vocabulary, code FROM kauro.bank_vocabulary ORDER BY 1, 2");
  const expected = Object.entries(mirrored).flatMap(([vocabulary, codes]) => codes.map((code) => ({ vocabulary, code })));
  expected.sort((a, b) => (a.vocabulary === b.vocabulary ? (a.code < b.code ? -1 : 1) : a.vocabulary < b.vocabulary ? -1 : 1));
  assert.deepEqual(rows.rows, expected);
});

// PV1R-04 (Codex r1 on db5f0e3): the conformance is per COLUMN and EXACT. Every single-column enumerated CHECK (`col IN (...)`, rendered
// by pg_get_constraintdef as `col = ANY (ARRAY[...])`) of the KIT tables is parsed on its own and its permitted set compared with the
// column's intended set (a domain list, or the explicitly limited subset the design fixes); an enumerated CHECK of a column not mapped
// here, or a mapped column without exactly one, is a gap too. The mutation self-test proves the comparison sees an added foreign token
// and a removed legitimate token whose literal still occurs in another table's CHECK (the blindness of the former global token search).
const ENVIRONMENTS = ["SANDBOX", "LIVE"] as const;
/** The source-freeze reasons: the two BANK_CASE_KINDS a freeze is opened for (a limited subset, not the whole list). */
const FREEZE_REASONS = ["UNDECLARED_OUTBOUND", "REFUND_TERMINAL_CONTRADICTED"] as const;
/** An execution offer opens a route-money case, never a settlement refusal (SETTLEMENT_REFUSED is the settlement intent's, 0079). */
const OFFER_REVIEW_CASE_KINDS = BANK_CASE_KINDS.filter((k) => k !== "SETTLEMENT_REFUSED");
const ENUM_COLUMNS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "outbound_execution_attempts.environment": ENVIRONMENTS,
  "outbound_execution_attempts.kind": EXECUTION_ATTEMPT_KINDS,
  "outbound_execution_attempts.state": EXECUTION_ATTEMPT_STATES,
  "outbound_execution_attempts.source_kind": EXECUTION_SOURCE_KINDS,
  "outbound_execution_attempts.destination_proof": DESTINATION_PROOFS,
  "outbound_execution_attempts.currency": ["USD"],
  "refund_destinations.environment": ENVIRONMENTS,
  "refund_destinations.source_kind": EXECUTION_SOURCE_KINDS,
  "execution_offers.command": EXECUTION_OFFER_COMMANDS,
  "execution_offer_outcomes.gate_outcome": EXECUTION_GATE_OUTCOMES,
  "execution_offer_outcomes.footprint": ["RECORDED", "REVIEW"],
  "execution_offer_outcomes.review_case_kind": OFFER_REVIEW_CASE_KINDS,
  "statement_imports.environment": ENVIRONMENTS,
  "statement_coverage.stream": COVERAGE_STREAMS,
  "statement_lines.environment": ENVIRONMENTS,
  "statement_lines.line_kind": STATEMENT_LINE_KINDS,
  "execution_correlations.correlation": DEBIT_CORRELATIONS,
  "bank_source_freezes.environment": ENVIRONMENTS,
  "bank_source_freezes.source_kind": EXECUTION_SOURCE_KINDS,
  "bank_source_freezes.reason": FREEZE_REASONS,
  "bank_review_cases.kind": BANK_CASE_KINDS,
  "bank_review_cases.state": ["OPEN", "RESOLVED"],
  "bank_review_cases.environment": ENVIRONMENTS,
  "bank_review_cases.source_kind": BANK_CASE_SOURCE_KINDS,
};

interface EnumCheck {
  readonly table: string;
  readonly column: string;
  readonly name: string;
  readonly values: ReadonlyArray<string>;
}
const ENUM_DEF = /^CHECK \(\(\(?([a-z_]+)\)? = ANY \(\(?ARRAY\[(.*)\]\)?(?:::text\[\])?\)\)\)$/;
/** A one-value enumeration (`col IN ('USD')`) is rendered as an equality. */
const SINGLE_DEF = /^CHECK \(\(\(?([a-z_]+)\)? = ('(?:[^']|'')*'::text)\)\)$/;
/** Each single-column enumerated CHECK of `schema`'s KIT tables, parsed on its own (no concatenation across constraints). */
async function enumChecks(client: Client, schema: string): Promise<EnumCheck[]> {
  const rows = await client.query<{ table: string; column: string; name: string; def: string }>(
    `SELECT t.relname AS table, a.attname AS column, c.conname AS name, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
      WHERE n.nspname = $1 AND t.relname = ANY($2) AND c.contype = 'c' AND cardinality(c.conkey) = 1 ORDER BY 1, 2, 3`,
    [schema, NEW_TABLES],
  );
  const out: EnumCheck[] = [];
  for (const r of rows.rows) {
    const m = ENUM_DEF.exec(r.def) ?? SINGLE_DEF.exec(r.def);
    if (m === null) {
      // a single-column CHECK that is not an enumeration (a pattern, a range) is not vocabulary; an unparsed one naming literals is a gap
      if (/= ANY|= '/.test(r.def)) out.push({ table: r.table, column: r.column, name: r.name, values: [`UNPARSED:${r.def}`] });
      continue;
    }
    assert.equal(m[1], r.column, `${r.table}.${r.name} constrains its own column`);
    out.push({ table: r.table, column: r.column, name: r.name, values: [...m[2]!.matchAll(/'((?:[^']|'')*)'::text/g)].map((x) => x[1]!.replace(/''/g, "'")) });
  }
  return out;
}
/** Every difference between `schema`'s enumerated CHECKs and ENUM_COLUMNS: per column, exact set, duplicates, unmapped and missing columns. */
async function vocabularyGaps(client: Client, schema: string): Promise<string[]> {
  const gaps: string[] = [];
  const seen = new Map<string, number>();
  for (const c of await enumChecks(client, schema)) {
    const key = `${c.table}.${c.column}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    const intended = ENUM_COLUMNS[key];
    if (intended === undefined) {
      gaps.push(`${key}: an enumerated CHECK (${c.name}) of a column with no intended set`);
      continue;
    }
    const got = new Set(c.values);
    const extra = [...got].filter((v) => !intended.includes(v)).sort();
    const missing = intended.filter((v) => !got.has(v)).sort();
    if (extra.length > 0) gaps.push(`${key}: permits foreign ${JSON.stringify(extra)}`);
    if (missing.length > 0) gaps.push(`${key}: omits ${JSON.stringify(missing)}`);
    if (got.size !== c.values.length) gaps.push(`${key}: lists a value twice`);
  }
  for (const key of Object.keys(ENUM_COLUMNS)) if (seen.get(key) !== 1) gaps.push(`${key}: ${seen.get(key) ?? 0} enumerated CHECKs (exactly 1 expected)`);
  return gaps;
}

test("PV1R-04 the CHECK lists of the tables are the same vocabulary, column by column and exactly (attempt kinds, states, offer commands, gate outcomes, case kinds, correlations, the freeze-reason subset)", async () => {
  assert.ok(FREEZE_REASONS.every((r) => (BANK_CASE_KINDS as ReadonlyArray<string>).includes(r)), "the freeze reasons are case kinds");
  assert.deepEqual(await vocabularyGaps(oracle, "kauro"), [], "every enumerated column permits exactly its intended set");
});

test("PV1R-04 mutation self-test: an added foreign token or a removed legitimate token in any one enumerated CHECK is detected, even when the removed token still occurs in another table's CHECK", async () => {
  const scratch = "pv1r04_scratch";
  await oracle.query(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`);
  await oracle.query(`CREATE SCHEMA ${scratch}`);
  try {
    for (const t of NEW_TABLES) await oracle.query(`CREATE TABLE ${scratch}.${t} (LIKE kauro.${t} INCLUDING CONSTRAINTS)`);
    assert.deepEqual(await vocabularyGaps(oracle, scratch), [], "the scratch copy conforms before any mutation");
    const checks = await enumChecks(oracle, scratch);
    assert.equal(checks.length, Object.keys(ENUM_COLUMNS).length, "every mapped column has its CHECK in the copy");
    const rewrite = async (c: EnumCheck, values: ReadonlyArray<string>): Promise<string[]> => {
      await oracle.query("BEGIN");
      try {
        await oracle.query(`ALTER TABLE ${scratch}.${c.table} DROP CONSTRAINT ${c.name}`);
        await oracle.query(`ALTER TABLE ${scratch}.${c.table} ADD CONSTRAINT ${c.name} CHECK (${c.column} IN (${values.map((v) => `'${v}'`).join(", ")}))`);
        return await vocabularyGaps(oracle, scratch);
      } finally {
        await oracle.query("ROLLBACK");
      }
    };
    let maskedRemovals = 0;
    for (const c of checks) {
      const key = `${c.table}.${c.column}`;
      assert.deepEqual(await rewrite(c, [...c.values, "BOGUS"]), [`${key}: permits foreign ["BOGUS"]`], `${key}: an added foreign token is detected`);
      for (const removed of c.values) {
        const kept = c.values.filter((v) => v !== removed);
        if (kept.length === 0) continue;
        const elsewhere = checks.some((o) => o !== c && o.values.includes(removed));
        if (elsewhere) maskedRemovals += 1;
        assert.deepEqual(await rewrite(c, kept), [`${key}: omits ${JSON.stringify([removed])}`], `${key}: removing ${removed} is detected${elsewhere ? " although it still occurs in another CHECK" : ""}`);
      }
    }
    assert.ok(maskedRemovals > 0, "at least one removal was of a token another CHECK still lists (the masked case)");
  } finally {
    await oracle.query(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`);
  }
});

test("the machine edges table equals the domain machines (OutboundExecutionAttempt, BankCredit) and the PaymentOrder extension as PaymentOrderBank", async () => {
  const rows = await oracle.query<{ edge: string }>("SELECT machine || ':' || from_state || '>' || to_state AS edge FROM kauro.bank_machine_edges ORDER BY 1");
  const expected = [
    ...BANK_STATE_MACHINES.flatMap((m) => m.transitions.map((t) => `${m.contract}:${t.from}>${t.to}`)),
    ...BANK_ORDER_EXTENSION.map((t) => `PaymentOrderBank:${t.from}>${t.to}`),
  ];
  assert.deepEqual(rows.rows.map((r) => r.edge), [...new Set(expected)].sort());
  // each bank machine's initial state is a state its edges leave (no orphan machine)
  for (const m of BANK_STATE_MACHINES) assert.ok(m.transitions.some((t) => t.from === m.initial), `${m.contract} starts somewhere`);
  // these machines are NOT registry or platform machines: the pinned list of kauro.state_machines is untouched
  const seeded = await oracle.query("SELECT 1 FROM kauro.state_machines WHERE machine IN ('OutboundExecutionAttempt', 'BankCredit', 'PaymentOrderBank')");
  assert.equal(seeded.rowCount, 0);
});

test("DENY DV1-01 (tables): no table, column, constraint or index of the KIT names a provider; no destination number column exists (DV1-10)", async () => {
  const names = await oracle.query<{ name: string }>(
    `SELECT t.relname AS name FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'kauro' AND t.relname = ANY($1)
     UNION SELECT a.attname FROM pg_attribute a JOIN pg_class t ON t.oid = a.attrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'kauro' AND t.relname = ANY($1) AND a.attnum > 0
     UNION SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'kauro' AND t.relname = ANY($1)
     UNION SELECT i.indexrelid::regclass::text FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'kauro' AND t.relname = ANY($1)
     UNION SELECT vocabulary FROM kauro.bank_vocabulary UNION SELECT code FROM kauro.bank_vocabulary UNION SELECT machine FROM kauro.bank_machine_edges`,
    [NEW_TABLES],
  );
  for (const { name } of names.rows) {
    assert.doesNotMatch(name, /wise|paypal/i, `${name} names a provider`);
    assert.doesNotMatch(name, /(^|_)(routing|account)_number$/i, `${name} would hold a plaintext destination number`);
  }
  assert.ok(names.rows.length > 100, "the probe saw the schema");
});

test("RACE NEVER-RESEND fence: a second DECLARED or UNCERTAIN attempt of one source is refused by the database; it is admitted after NOT_EXECUTED or RECORDED", async () => {
  const bankCredit = id();
  const treasury = id();
  const first = await attempt(oracle, { bank_credit_id: bankCredit, treasury_refund_id: treasury });
  await assert.rejects(attempt(oracle, { bank_credit_id: bankCredit, treasury_refund_id: treasury, attempt_number: 2 }), (e: unknown) => constraintOf(e) === "outbound_execution_attempts_one_open");
  await oracle.query("UPDATE kauro.outbound_execution_attempts SET state = 'UNCERTAIN' WHERE attempt_id = $1", [first]);
  await assert.rejects(attempt(oracle, { bank_credit_id: bankCredit, treasury_refund_id: treasury, attempt_number: 2 }), (e: unknown) => constraintOf(e) === "outbound_execution_attempts_one_open");
  await oracle.query("UPDATE kauro.outbound_execution_attempts SET state = 'NOT_EXECUTED' WHERE attempt_id = $1", [first]);
  await attempt(oracle, { bank_credit_id: bankCredit, treasury_refund_id: treasury, attempt_number: 2 });
  // attempt numbers are unique per source
  await assert.rejects(attempt(oracle, { bank_credit_id: bankCredit, treasury_refund_id: treasury, attempt_number: 2, state: "NOT_EXECUTED" }), (e: unknown) => constraintOf(e) === "outbound_execution_attempts_number");
});

test("L4 execution identity: one bank execution id per account and environment across attempts; a RECORDED attempt carries its whole footprint and nothing else does", async () => {
  const recorded = { state: "RECORDED", bank_execution_id: "exec-1", destination_proof: "DP_FULL", evidence_hash: SHA, recorded_at: new Date().toISOString() };
  await attempt(oracle, recorded);
  await assert.rejects(attempt(oracle, recorded), (e: unknown) => constraintOf(e) === "outbound_execution_attempts_identity");
  // the same id in another account or environment is another identity
  await attempt(oracle, { ...recorded, account_ref: "acct-kit-2" });
  await attempt(oracle, { ...recorded, environment: "LIVE" });
  // a RECORDED row without proof, and a DECLARED row carrying an execution id, are both refused
  await assert.rejects(attempt(oracle, { state: "RECORDED", bank_execution_id: "exec-2", evidence_hash: SHA, recorded_at: new Date().toISOString() }), (e: unknown) => constraintOf(e) === "outbound_attempts_recorded_footprint");
  await assert.rejects(attempt(oracle, { bank_execution_id: "exec-3" }), (e: unknown) => constraintOf(e) === "outbound_attempts_recorded_footprint");
});

test("the source union is closed: a CAPTURE source names agency, capture and refund; a BANK_CREDIT source names none of them; a RESEND names its bounce and a RETURN none", async () => {
  await assert.rejects(attempt(oracle, { refund_id: id() }), (e: unknown) => constraintOf(e) === "outbound_attempts_source_union");
  await assert.rejects(attempt(oracle, { source_kind: "CAPTURE", bank_credit_id: null, treasury_refund_id: null }), (e: unknown) => sqlState(e) === "23502" || constraintOf(e) === "outbound_attempts_source_union");
  await assert.rejects(attempt(oracle, { kind: "RESEND" }), (e: unknown) => constraintOf(e) === "outbound_attempts_kind_parent");
  await assert.rejects(attempt(oracle, { parent_bounce_id: id() }), (e: unknown) => constraintOf(e) === "outbound_attempts_kind_parent");
  // a RESEND names a bounce that exists and never exceeds it (0071): a stranger id is refused, a real bounce admits up to its cents
  await assert.rejects(attempt(oracle, { kind: "RESEND", parent_bounce_id: id() }), (e: unknown) => sqlState(e) === "23514");
  const creditId = id();
  const treasuryId = id();
  const sent = await attempt(oracle, { bank_credit_id: creditId, treasury_refund_id: treasuryId, state: "RECORDED", bank_execution_id: "exec-bounce-1", destination_proof: "DP_FULL", evidence_hash: SHA, recorded_at: new Date().toISOString() });
  const bounceId = id();
  await oracle.query("INSERT INTO kauro.outbound_return_bounces (bounce_id, attempt_id, environment, account_ref, source_kind, source_id, bounced_cents, evidence_hash, recorded_by) SELECT $1, attempt_id, environment, account_ref, source_kind, source_id, 10000, $3, $4 FROM kauro.outbound_execution_attempts WHERE attempt_id = $2", [bounceId, sent, SHA, id()]);
  await assert.rejects(attempt(oracle, { kind: "RESEND", parent_bounce_id: bounceId, attempt_number: 2, bank_credit_id: creditId, treasury_refund_id: treasuryId, amount_cents: 10001 }), (e: unknown) => sqlState(e) === "23514");
  await attempt(oracle, { kind: "RESEND", parent_bounce_id: bounceId, attempt_number: 2, bank_credit_id: creditId, treasury_refund_id: treasuryId });
  // a recipient version without its recipient is nothing (DP-RECIPIENT needs both)
  await assert.rejects(attempt(oracle, { recipient_version: "v1" }), (e: unknown) => constraintOf(e) === "outbound_attempts_recipient_version");
  // the reference is the platform's own format and unique
  await assert.rejects(attempt(oracle, { reference: "send-it-again" }), (e: unknown) => sqlState(e) === "23514");
});

test("execution offers are unique per (attempt, command, key) and append-only for the payment service; outcomes keep their footprint rules", async () => {
  const a = await attempt(oracle);
  const offer = async (c: Client, key: string, command = "RECORD_RETURN"): Promise<string> => {
    const offerId = id();
    await c.query("INSERT INTO kauro.execution_offers (offer_id, attempt_id, command, idempotency_key, requested_artifact_ref, expected_evidence_hash, actor_user_id) VALUES ($1, $2, $3, $4, 'artifact-1', $5, $6)", [offerId, a, command, key, SHA, id()]);
    return offerId;
  };
  const o1 = await offer(payment, "key-00000001");
  await assert.rejects(offer(payment, "key-00000001"), (e: unknown) => sqlState(e) === "23505");
  await offer(payment, "key-00000001", "RECORD_RESEND");
  await offer(payment, "key-00000002");
  // append-only by privilege: neither UPDATE nor DELETE is granted to the payment service (or to the app role: it has no grant at all)
  await assert.rejects(payment.query("UPDATE kauro.execution_offers SET command = 'RESOLVE_EXECUTED' WHERE offer_id = $1", [o1]), (e: unknown) => sqlState(e) === "42501");
  await assert.rejects(payment.query("DELETE FROM kauro.execution_offers WHERE offer_id = $1", [o1]), (e: unknown) => sqlState(e) === "42501");
  await assert.rejects(app.query("SELECT 1 FROM kauro.execution_offers"), (e: unknown) => sqlState(e) === "42501");
  const outcome = (gate: string, footprint: string, caseKind: string | null, executionId: string | null): Promise<unknown> =>
    payment.query("INSERT INTO kauro.execution_offer_outcomes (outcome_id, offer_id, gate_outcome, bank_execution_id, outcome_code, footprint, review_case_kind) VALUES ($1, $2, $3, $4, 'OUTCOME_CODE', $5, $6)", [id(), o1, gate, executionId, footprint, caseKind]);
  // a rejected gate carries no execution id; REVIEW names its case kind; RECORDED needs a classified gate and an id
  await assert.rejects(outcome("HASH_MISMATCH", "REVIEW", "RECORD_REQUIRED", "exec-9"), (e: unknown) => constraintOf(e) === "execution_offer_outcomes_execution_id_classified");
  await assert.rejects(outcome("CLASSIFIED", "REVIEW", null, "exec-9"), (e: unknown) => constraintOf(e) === "execution_offer_outcomes_footprint");
  await assert.rejects(outcome("HASH_MISMATCH", "RECORDED", null, null), (e: unknown) => constraintOf(e) === "execution_offer_outcomes_recorded_classified");
  await outcome("CLASSIFIED", "RECORDED", null, "exec-9");
  // one outcome per offer
  await assert.rejects(outcome("HASH_MISMATCH", "REVIEW", "RECORD_REQUIRED", null), (e: unknown) => sqlState(e) === "23505");
});

test("a statement line is unique by the bank's own identity and a credit never carries an execution id or a link; a debit always has an amount", async () => {
  const imp = id();
  // an import is an aggregate with an event per version (0060): it is born with its statement_import.recorded.v1 in one transaction
  await oracle.query("BEGIN");
  await oracle.query("INSERT INTO kauro.statement_imports (import_id, environment, account_ref, artifact_ref, evidence_hash, normalizer_version, idempotency_key, imported_by) VALUES ($1, 'SANDBOX', 'acct-kit-1', 'artifact-s1', $2, 'norm-1', 'import-key-1', $3)", [imp, SHA, id()]);
  await event(oracle, { aggregateKind: "statement_import", aggregateId: imp, aggregateVersion: 1, agencyId: null, eventType: "statement_import.recorded.v1", actorUserId: null });
  await oracle.query("COMMIT");
  await assert.rejects(oracle.query("INSERT INTO kauro.statement_imports (import_id, environment, account_ref, artifact_ref, evidence_hash, normalizer_version, idempotency_key, imported_by) VALUES ($1, 'SANDBOX', 'acct-kit-1', 'artifact-s1', $2, 'norm-1', 'import-key-2', $3)", [id(), SHA, id()]), (e: unknown) => constraintOf(e) === "statement_imports_one_per_artifact");
  await oracle.query("INSERT INTO kauro.statement_coverage (import_id, stream, covered_from, covered_to) VALUES ($1, 'INBOUND', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'), ($1, 'OUTBOUND', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z')", [imp]);
  await assert.rejects(oracle.query("INSERT INTO kauro.statement_coverage (import_id, stream, covered_from, covered_to) VALUES ($1, 'INBOUND', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z')", [imp]), (e: unknown) => sqlState(e) === "23505" || sqlState(e) === "23514");
  const line = (o: Record<string, unknown>): Promise<unknown> => {
    const row: Record<string, unknown> = { line_id: id(), import_id: imp, environment: "SANDBOX", account_ref: "acct-kit-1", line_kind: "DEBIT", bank_line_id: `line-${++seq}`, amount_cents: 100, currency: "USD", status: "SENT", observed_at: "2026-10-02T00:00:00Z", evidence_hash: SHA, ...o };
    const cols = Object.keys(row);
    return oracle.query(`INSERT INTO kauro.statement_lines (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((k) => row[k]));
  };
  await line({ bank_line_id: "dup-1" });
  await assert.rejects(line({ bank_line_id: "dup-1" }), (e: unknown) => sqlState(e) === "23505");
  await line({ bank_line_id: "dup-1", line_kind: "CREDIT" });
  await assert.rejects(line({ line_kind: "CREDIT", bank_execution_id: "exec-credit" }), (e: unknown) => constraintOf(e) === "statement_lines_debit_only_execution");
  await assert.rejects(line({ amount_cents: null }), (e: unknown) => constraintOf(e) === "statement_lines_debit_amount");
  // unknown fee is null; the full destination is never a column: only digests, last digits and the provider's recipient references
  await line({ line_kind: "CREDIT", amount_cents: null, fee_cents: null });
});

test("the lock key of an account stream (L1) is one function: deterministic, distinct per environment, account and stream, and it refuses what is not a stream", async () => {
  const key = async (env: string, account: string, stream: string): Promise<string> => (await oracle.query<{ k: string }>("SELECT kauro.bank_stream_lock_key($1, $2, $3)::text AS k", [env, account, stream])).rows[0]!.k;
  const base = await key("SANDBOX", "acct-kit-1", "OUTBOUND");
  assert.equal(base, await key("SANDBOX", "acct-kit-1", "OUTBOUND"));
  assert.notEqual(base, await key("LIVE", "acct-kit-1", "OUTBOUND"));
  assert.notEqual(base, await key("SANDBOX", "acct-kit-2", "OUTBOUND"));
  assert.notEqual(base, await key("SANDBOX", "acct-kit-1", "INBOUND"));
  await assert.rejects(key("SANDBOX", "acct|kit", "OUTBOUND"), (e: unknown) => sqlState(e) === "22023");
  await assert.rejects(key("SANDBOX", "acct-kit-1", "SIDEWAYS"), (e: unknown) => sqlState(e) === "22023");
  // the same key serializes two transactions (a second waits for the first), so a lane's tests and its code share one definition
  const other = await pg.connect("kauro_payment_test");
  try {
    await payment.query("BEGIN");
    await payment.query("SELECT pg_advisory_xact_lock(kauro.bank_stream_lock_key('SANDBOX', 'acct-kit-1', 'OUTBOUND'))");
    await other.query("BEGIN");
    const free = await other.query<{ got: boolean }>("SELECT pg_try_advisory_xact_lock(kauro.bank_stream_lock_key('SANDBOX', 'acct-kit-1', 'OUTBOUND')) AS got");
    assert.equal(free.rows[0]!.got, false, "the held stream lock is not free");
    const unrelated = await other.query<{ got: boolean }>("SELECT pg_try_advisory_xact_lock(kauro.bank_stream_lock_key('SANDBOX', 'acct-kit-2', 'OUTBOUND')) AS got");
    assert.equal(unrelated.rows[0]!.got, true, "another account's stream is free");
    await other.query("ROLLBACK");
  } finally {
    await payment.query("ROLLBACK");
    await other.end();
  }
});
