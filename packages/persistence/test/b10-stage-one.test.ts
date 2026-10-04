// B10 stage 1 is one implementation (the `b10/stage-1` integrator; docs/design/B10-commercial-domain.md §11, D10-STAGE-1,
// D10-STAGE-2). B10-MODEL declared the domain's records, vocabularies and time rules while B10-SCHEMA-RECURRENCE and
// B10-SCHEMA-COMMISSION built migrations 0028..0031 in other worktrees; this file keeps what they share one thing on real PostgreSQL 17,
// the superuser reading the catalog and calling the pure functions only as the oracle: every enumerated column of 0028..0031 admits
// exactly the tokens COMMERCIAL_VOCABULARY declares for it, the domain's banking-day ordinal answers what kauro.banking_day_after
// answers for the same stored calendar, and kauro.eligibility_findings reports only findings the domain declares.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { COMMERCIAL_VOCABULARY, bankingDayAfterMonthEnd } from "@kauro/domain";
import { MIGRATIONS_DIR, listMigrations } from "../src/index.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "../src/testing/index.js";

let pg: TemporaryPostgres;
let oracle: Client;

before(async () => {
  pg = await startTemporaryPostgres();
  oracle = await pg.connect("postgres");
});
after(async () => {
  await oracle.end();
  await pg.stop();
});

/** The tables migrations 0028..0031 create (B10's own numbers; D10-BASE-1). */
function b10Tables(): string[] {
  const files = listMigrations(MIGRATIONS_DIR).filter((m) => m.version >= 28 && m.version <= 31);
  assert.equal(files.length, 4, "B10 owns 0028..0031");
  return files.flatMap((m) => [...m.sql.matchAll(/^CREATE TABLE kauro\.(\w+) \(/gm)].map((x) => x[1] as string));
}

/**
 * Each enumerated column of a B10 table and the domain vocabulary it stores: the whole list, or (`token`) the one member a binding
 * column is pinned to. A column the database enumerates that is not listed here fails the check, so a new token set gets a vocabulary.
 */
const STORED: Readonly<Record<string, { readonly vocabulary: string; readonly token?: string }>> = {
  "founding_slot_reservations.state": { vocabulary: "foundingReservationStates" },
  "founding_slot_reservations.release_reason": { vocabulary: "reservationReleaseReasons" },
  "qualifying_purchases.founding_basis": { vocabulary: "foundingBases" },
  "service_agreement_versions.agreement_kind": { vocabulary: "serviceAgreementKinds" },
  "service_agreement_versions.state": { vocabulary: "serviceAgreementStates" },
  "agency_agreement_acceptances.terms_kind": { vocabulary: "serviceAgreementKinds", token: "TERMS" },
  "agency_agreement_acceptances.privacy_kind": { vocabulary: "serviceAgreementKinds", token: "PRIVACY" },
  "agency_closures.from_state": { vocabulary: "closureFromStates" },
  "agency_relationship_decisions.treatment": { vocabulary: "relationshipTreatments" },
  "sellers.state": { vocabulary: "sellerStates" },
  "seller_legal_reviews.classification": { vocabulary: "sellerClassifications" },
  "seller_legal_reviews.outcome": { vocabulary: "legalReviewOutcomes" },
  "seller_agreements.classification": { vocabulary: "sellerClassifications" },
  "seller_agreements.offset_terms": { vocabulary: "offsetTerms" },
  "seller_assessments.outcome": { vocabulary: "assessmentOutcomes" },
  "seller_payout_destinations.currency": { vocabulary: "destinationCurrencies" },
  "seller_payout_destinations.state": { vocabulary: "payoutDestinationStates" },
  "prospect_source_evidence.segment": { vocabulary: "prospectSegments" },
  "prospects.state": { vocabulary: "prospectStates" },
  "prospect_suppressions.key_kind": { vocabulary: "suppressionKeyKinds" },
  "attribution_claims.state": { vocabulary: "attributionClaimStates" },
  "assistance_agreements.scope": { vocabulary: "assistanceScopes" },
  "commission_entitlements.kind": { vocabulary: "commissionSources" },
  "commission_entitlements.state": { vocabulary: "entitlementStates" },
  "service_assignments.compensation": { vocabulary: "serviceCompensations" },
  "account_assignments.reason": { vocabulary: "assignmentReasons" },
  "purchase_completions.kind": { vocabulary: "completionKinds" },
  "purchase_completions.source": { vocabulary: "completionSources" },
  "commission_pools.source": { vocabulary: "commissionSources" },
  "commission_pools.rate_kind": { vocabulary: "rateKinds" },
  "commission_lines.state": { vocabulary: "lineStates" },
  "commission_adjustments.reason": { vocabulary: "adjustmentReasons" },
  "commission_adjustments.direction": { vocabulary: "adjustmentDirections" },
  "commission_holds.state": { vocabulary: "holdStates" },
  "capture_funds_observations.funds_state": { vocabulary: "observedFundsStates" },
  "banking_calendars.jurisdiction": { vocabulary: "calendarJurisdictions" },
  "banking_calendars.source": { vocabulary: "calendarSources" },
  "commission_periods.state": { vocabulary: "periodStates" },
  "commission_statements.label": { vocabulary: "statementLabels" },
  "commission_statements.state": { vocabulary: "statementStates" },
  "statement_items.item_kind": { vocabulary: "statementItemKinds" },
  "statement_items.disposition": { vocabulary: "statementItemDispositions" },
  "statement_items.rate_kind": { vocabulary: "rateKinds" },
  "statement_items.adjustment_direction": { vocabulary: "adjustmentDirections" },
  "payout_intents.currency": { vocabulary: "payoutCurrencies" },
  "payout_intents.fee_bearer": { vocabulary: "payoutFeeBearers" },
  "payout_intents.state": { vocabulary: "payoutIntentStates" },
  "payout_reconciliations.evidence_kind": { vocabulary: "payoutEvidenceStatuses" },
  "compensation_guard_reviews.outcome": { vocabulary: "guardResults" },
  "compensation_guard_reviews.label": { vocabulary: "guardLabels" },
};

/** A single-column CHECK that only enumerates text tokens (`col IN (...)`, `col = '...'`, optionally `col IS NULL OR ...`). */
const ENUMERATION = /^CHECK \(\(*(?:\w+ IS NULL\) OR \(*)?\w+ = (?:ANY \(ARRAY\[L(?:, L)*\]\)|L)\)*$/;
const LITERAL = /'((?:[^']|'')*)'::text/g;

test("B10 stage 1 is one vocabulary: every enumerated column of migrations 0028..0031 admits exactly the tokens COMMERCIAL_VOCABULARY declares for it, so no record, machine or view spells a token the database refuses", async () => {
  const tables = b10Tables();
  assert.ok(tables.length >= 40, `${tables.length} B10 tables`);
  const { rows } = await oracle.query<{ tbl: string; col: string; def: string }>(
    `SELECT t.relname AS tbl, a.attname AS col, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'c' AND cardinality(c.conkey) = 1 AND c.connamespace = 'kauro'::regnamespace AND t.relname = ANY ($1)
      ORDER BY 1, 2`,
    [tables],
  );
  const enumerated = new Map<string, string[]>();
  for (const r of rows) {
    if (!ENUMERATION.test(r.def.replace(LITERAL, "L"))) continue;
    enumerated.set(`${r.tbl}.${r.col}`, [...r.def.matchAll(LITERAL)].map((m) => (m[1] as string).replaceAll("''", "'")));
  }
  const vocabulary = COMMERCIAL_VOCABULARY as unknown as Readonly<Record<string, ReadonlyArray<string> | undefined>>;
  const drift: string[] = Object.keys(STORED)
    .filter((column) => !enumerated.has(column))
    .map((column) => `${column}: listed here, but the database enumerates no such column`);
  for (const [column, stored] of enumerated) {
    const expected = STORED[column];
    if (expected === undefined) {
      drift.push(`${column}: the database admits [${stored.join(", ")}] and no domain vocabulary is named for it`);
      continue;
    }
    const declared = vocabulary[expected.vocabulary];
    if (declared === undefined) {
      drift.push(`${column}: the database admits [${stored.join(", ")}] and the domain declares no ${expected.vocabulary}`);
      continue;
    }
    if (expected.token !== undefined) {
      if (!declared.includes(expected.token) || stored.length !== 1 || stored[0] !== expected.token) drift.push(`${column}: pinned to ${expected.token} of ${expected.vocabulary}, the database admits [${stored.join(", ")}]`);
      continue;
    }
    if (JSON.stringify([...stored].sort()) !== JSON.stringify([...declared].sort())) {
      drift.push(`${column}: the database admits [${stored.join(", ")}], ${expected.vocabulary} declares [${declared.join(", ")}]`);
    }
  }
  assert.deepEqual(drift.sort(), [], "every enumerated column is listed, and every stored token set is the domain's");
});

test("B10 stage 1 is one calendar rule: the domain's banking-day ordinal answers what kauro.banking_day_after answers for the same stored calendar — the example 21 fixture's 2026-10-07 and 2026-10-15, and no date where the calendar does not cover the day it needs", async () => {
  const cases: ReadonlyArray<{ readonly month: string; readonly monthEnd: string; readonly ordinal: number; readonly nonbanking: string[]; readonly coversFrom: string; readonly coversTo: string }> = [
    // example 21: 2026-10-12 nonbanking beside the weekends, the whole of October covered
    { month: "2026-09", monthEnd: "2026-09-30", ordinal: 5, nonbanking: ["2026-10-12"], coversFrom: "2026-10-01", coversTo: "2026-10-31" },
    { month: "2026-09", monthEnd: "2026-09-30", ordinal: 10, nonbanking: ["2026-10-12"], coversFrom: "2026-10-01", coversTo: "2026-10-31" },
    { month: "2026-09", monthEnd: "2026-09-30", ordinal: 10, nonbanking: [], coversFrom: "2026-09-01", coversTo: "2026-12-31" },
    // the version ends before the tenth banking day: the fifth is known, the tenth is not
    { month: "2026-09", monthEnd: "2026-09-30", ordinal: 5, nonbanking: ["2026-10-12"], coversFrom: "2026-10-01", coversTo: "2026-10-10" },
    { month: "2026-09", monthEnd: "2026-09-30", ordinal: 10, nonbanking: ["2026-10-12"], coversFrom: "2026-10-01", coversTo: "2026-10-10" },
    // the last covered day is exactly the tenth banking day
    { month: "2026-09", monthEnd: "2026-09-30", ordinal: 10, nonbanking: ["2026-10-12"], coversFrom: "2026-10-01", coversTo: "2026-10-15" },
    // the version starts after the first day it would count
    { month: "2026-09", monthEnd: "2026-09-30", ordinal: 5, nonbanking: ["2026-10-12"], coversFrom: "2026-10-02", coversTo: "2026-10-31" },
    // across the year end with a listed holiday
    { month: "2026-12", monthEnd: "2026-12-31", ordinal: 1, nonbanking: ["2027-01-01"], coversFrom: "2027-01-01", coversTo: "2027-01-31" },
  ];
  const answers: string[] = [];
  const expected: string[] = [];
  for (const c of cases) {
    const { rows } = await oracle.query<{ day: string | null }>("SELECT kauro.banking_day_after($1::date, $2, $3::date[], $4::date, $5::date)::text AS day", [
      c.monthEnd,
      c.ordinal,
      c.nonbanking,
      c.coversFrom,
      c.coversTo,
    ]);
    const calendar = { nonbankingDates: c.nonbanking, coversFrom: c.coversFrom, coversTo: c.coversTo };
    const label = `${c.month} #${c.ordinal} covering ${c.coversFrom}..${c.coversTo}`;
    expected.push(`${label}: ${rows[0]?.day ?? "none"}`);
    answers.push(`${label}: ${bankingDayAfterMonthEnd(c.month, c.ordinal, calendar as Parameters<typeof bankingDayAfterMonthEnd>[2]) ?? "none"}`);
  }
  assert.deepEqual(answers, expected, "the domain's ordinal is the database's");
  // the oracle's own values (example 21), written here rather than read back
  assert.deepEqual(expected.slice(0, 2), ["2026-09 #5 covering 2026-10-01..2026-10-31: 2026-10-07", "2026-09 #10 covering 2026-10-01..2026-10-31: 2026-10-15"]);
});

test("B10 stage 1 is one findings list: kauro.eligibility_findings reports only the findings the domain's EligibilityFinding declares", async () => {
  const { rows } = await oracle.query<{ def: string }>("SELECT pg_get_functiondef('kauro.eligibility_findings()'::regprocedure) AS def");
  const reported = [...(rows[0]?.def ?? "").matchAll(/SELECT s\.agency_id, s\.quote_id, '([A-Z_]+)'/g)].map((m) => m[1] as string);
  assert.ok(reported.length >= 2, "the function's findings are read from its definition");
  assert.deepEqual([...reported].sort(), [...(COMMERCIAL_VOCABULARY.eligibilityFindings as ReadonlyArray<string>)].sort());
});
