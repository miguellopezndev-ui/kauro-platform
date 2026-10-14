// The migrations against a real PostgreSQL 17 (07 "Acceptance obligations"): they apply in order, re-apply as a no-op,
// refuse drift, and the schema they build agrees with the vendored registry (state vocabularies, listed transitions, event
// types, aggregate kinds) and with the isolation rules (runtime roles are not owners/superusers/BYPASSRLS; every kauro table
// has RLS forced).
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { STATE_MACHINES, registryJson } from "@kauro/contracts";
import {
  AGGREGATE_KINDS,
  COMMERCIAL_PLATFORM_MACHINES,
  EVENT_TYPES,
  EXECUTION_PLATFORM_MACHINES,
  PLATFORM_STATE_MACHINES,
  SOURCE_LIFECYCLE_STATE_MACHINES,
  SUPPORT_CASE_STATES,
} from "@kauro/domain";
import { MIGRATIONS_DIR, MigrationDriftError, applyMigrations, appliedMigrations, listMigrations } from "../src/index.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "../src/testing/index.js";

let pg: TemporaryPostgres;
before(async () => {
  // the shipped schema exactly as the runner leaves it: no labelled TEST CLOCK in this cluster (B07 decision D-CLOCK-1)
  pg = await startTemporaryPostgres({ testClock: false });
});
after(async () => {
  await pg.stop();
});

test("every migration applied once, in order, with its checksum recorded; a second run applies nothing", async () => {
  const files = listMigrations();
  // B06 owns 0001..0007; 0008 is the shared aggregate-kind registry (docs/design/FOUNDATION-aggregate-kinds.md); B07 owns 0009..0012
  // and B09 0013..0017 (the second of B07 and B09 to merge was renumbered after the first); the package-close reviews took 0019
  // (B09) and 0020 (B07), B08 0021..0024, B11 0025..0027 (D11-SYNC-1) and B10 0028 onward
  assert.deepEqual(files.map((f) => f.file), [
    "0001_schema_roles_helpers.sql",
    "0002_identity_agencies_memberships.sql",
    "0003_capabilities_clients_projects.sql",
    "0004_plans_receipts_approvals.sql",
    "0005_events_outbox_inbox.sql",
    "0006_journals_leases.sql",
    "0007_security_events.sql",
    "0008_aggregate_kind_registry.sql",
    "0009_source_uploads_registry.sql",
    "0010_source_inspection_inventory.sql",
    "0011_source_selection_seal.sql",
    "0012_source_retention_events.sql",
    // package B09 (docs/design/B09-payments-fiscal.md): numbered 0009..0013 on its branch and renumbered 0013..0017 after B07's
    // by the B07+B09 merge (FOUNDATION D-AGGK-5; docs/design/B07-B09-merge.md)
    "0013_payments_foundation.sql",
    "0014_quotes_fiscal_profiles.sql",
    "0015_orders_attempts_captures_authorizations.sql",
    "0016_refunds_cases_exceptions.sql",
    "0017_tax_documents_ledger_settlements.sql",
    // the B07 + B09 merge: the payment service's read of the source lifecycle's retention (docs/design/B07-B09-merge.md D-MERGE-3)
    "0018_payment_service_source_reads.sql",
    // the B09 package-close review: a provider refund no local refund explains is its own case (B09-R1)
    "0019_unknown_refund_cases.sql",
    // the B07 package-close re-check: the provider hold record of a seal's accepted generations (B07-R1)
    "0020_source_object_holds.sql",
    // package B08 (docs/design/B08-audit-approval-jobs.md §9, D8-BASE-1): processing authority, landed after main's 0019 (B09)
    // and 0020 (B07); numbered 0019..0021 on b08/integration
    "0021_execution_jobs_capacity.sql",
    "0022_staging_verification_packages.sql",
    "0023_audits_cost_grants.sql",
    "0024_execution_review_fixes.sql",
    // package B11: numbered 0009 on each mandate's branch, 0022..0024 by the stage-1 integrator (D-INT1-1) and 0025..0027 by the
    // trunk sync, which replaced the reservations of main (B08 took 0022..0024; D10-SYNC-1, docs/design/B11-agency-app.md D11-SYNC-1)
    "0025_web_sessions.sql",
    "0026_support_cases.sql",
    "0027_inquiries.sql",
    // package B10 (docs/design/B10-commercial-domain.md): the recurrence history, the founding cohort and the agency lifecycle records
    "0028_recurrence_founding_agency.sql",
    // package B10: the sales and attribution records, the commission ledger, and the periods, statements and payouts
    "0029_sales_attribution.sql",
    "0030_commission_ledger.sql",
    "0031_statements_payouts.sql",
    // package B10 (mandate B10-COMMANDS-PROSPECTS, D10-CLAIM-2): the claim conflict review reads the claims on a prospect the session can read
    "0032_claim_conflict_review.sql",
    // package B10 (mandate B10-COMMISSION-SERVICE, D10-SVC-1): the QUOTE_EXPIRY sweep reads the live reservations whose end has passed
    "0033_commission_due_reservations.sql",
    // package B10 (mandate B10-STATEMENTS-PAYOUTS, D10-STMT-4): the commission group's journal, its COMMISSIONS inputs and a statement's calendar read
    "0034_commission_service_commands.sql",
    // package B10 (gap closure PAY_DEST_RACE, D10-GAP-3): a payout destination change takes its seller's transition lock
    "0035_destination_change_lock.sql",
    // package B10 (Codex r1 B10G-R2, D10-GAP-8): a payout intent is born only over payable lines without an unwithheld hold
    "0036_payout_line_fence.sql",
    // package B10 (Codex r1 B10G-R1, D10-GAP-9): one live payable item per line (commission_lines.payable_statement_id)
    "0037_line_payable_owner.sql",
    // package B10 (Codex r1 B10G-R7, D10-GAP-11): a payout's step-up expiry compared with the statement's instant (kauro.effect_now)
    "0038_step_up_effect_clock.sql",
    // package B10 (Codex r2 B10G-R1, D10-GAP-12): one live payable item per line, keyed on the statement's liveness
    "0039_live_payable_item.sql",
    // package B10 (Codex r2 B10G-R7, D10-GAP-14): a payout's step-up judged again at COMMIT (deferred constraint triggers)
    "0040_step_up_at_commit.sql",
    // package B10 (Codex r4 B10G-R9, D10-GAP-16): a statement records the lines it was composed from (input_line_ids)
    "0041_statement_input_lines.sql",
    // package B10 (lane 4 of the failure-matrix GAPs, D10-GAP-19): the corporate owner reads an agency's first designation (CMD050 leaves a claim whose agency already bought for its conversion)
    "0042_owner_reads_first_designation.sql",
    // package B10 (lane 5 of the failure-matrix GAPs, Codex r1 B10G5-R1, D10-GAP-23): a payout is authorized only over lines whose capture's funds are AVAILABLE
    "0043_payout_funds_fence.sql",
    // P0 R2-046: an older ledger waiter retries with a fresh transaction instant.
    "0044_admission_instants.sql",
    // Payments V1 bank-transfer route, lane KIT (tables and vocabulary only; provisional number, renumbered at merge)
    "0045_bank_transfer_kit.sql",
    // Payments V1 bank-transfer route, lane L-ROUTE (provisional number, renumbered at merge)
    "0046_bank_routes.sql",
    // PV1 L-ROUTE PV1R-07 r4: the session fence (lock-only privileges of kauro_app on the presented session; provisional number)
    "0047_session_fence.sql",
    // B10-T1-b gaps D and L2: the commission effect COMMIT fenced by the dispatcher lease (lock-only privileges of kauro_commission; provisional number)
    "0048_commission_dispatch_fence.sql",
    // package B10 (failure-matrix lane 6c): sales and attribution changes ordered with the commands resting on them (tail vs designation,
    // identity assurance, agreement changes, the activation's step-up at COMMIT)
    "0049_b10g6c_sales_ordering.sql",
    // package B17: CMD018 CreateTargetContract and CMD019 ConfirmTargetContract (target artifacts, the contract's version and confirmation columns)
    "0050_b17_target_contracts.sql",
    // package B18: CMD058 ChangeCapability and CMD059 RestrictCapability (capability revision, versions, restrictions)
    "0051_b18_capabilities.sql",
    // package B17: CMD040 SubmitStageReceipt and CMD041 ContinueStage (import stages, append-only receipt revisions, the STAGE_RECEIPT artifact kind)
    "0052_b17_import_stage_receipts.sql",
    "0053_b09_tax_follows_service.sql",
    // FCG-B06-LEASE-1: claim_lease / heartbeat_lease / checkpoint_lease judge expiry at the database clock after the row lock (provisional number)
    "0054_lease_expiry_after_lock.sql",
    // Payments V1 KIT-2: bank_credits, treasury_refunds and the manual-rail timings of a route version (provisional structure for the lanes)
    "0055_bank_kit_fixtures.sql",
    // package B10 lane OFFSET: offsets as claims that yield, the one lock order, noncash settlement (docs/design/B10-OFFSET.md)
    "0056_offset_claims_yield.sql",
    // package B10 lane OFFSET: seller credit as a durable receivable, CREDIT statement items, the source position shrink (docs/design/B10-OFFSET.md; provisional number)
    "0057_seller_credit.sql",
    // package B05 L3: the stored core documents and plan bindings (provisional number)
    "0058_b05_core_documents.sql",
    // package B16/B18: operations service principal, incidents, restore candidates and recoveries (provisional number)
    "0059_b16_operations_recovery.sql",
    // SEC-DEPTH-PROVENANCE L1 (A1/R1/R2): runtime principals outside the guard-execution boundary (provisional number)
    "0060_runtime_hardening.sql",
    // package B05 L3m: the durable send and the settlement of a model dispatch, dispatch liabilities, the pool's liability gate (provisional number)
    "0061_b05_dispatch_settlement.sql",
    // package B11 lane A1: the agency's buyer type, recorded once by SetBuyerType (provisional number)
    "0062_agency_buyer_types.sql",
    // Payments V1 PV1-INBOUND: credit and statement-import aggregates, guards, the owner pipeline on the payment pool (provisional number)
    "0063_bank_inbound.sql",
    // owner decision D-33: prospect source evidence of the AGENCY or COMPANY segment (provisional number, renumbered at merge)
    "0064_d33_company_prospects.sql",
    // package B16 lane L7: PAID_STAGED retention windows (first release + 21 d, capture + 30 d, final download + 7 d; provisional number)
    "0065_b16_staged_retention.sql",
    // package B05 L3t: the audit's and the grant's authority deadlines judged at COMMIT (provisional number)
    "0066_audit_clock_at_commit.sql",
    // FCG-B06-LEASE-1b: claim_lease judges its caller's deadline at the database clock after the row lock (provisional number)
    "0067_lease_deadline_after_lock.sql",
    // package B05 L1v: a dispatch leaves RESERVED only while it has never been settled (provisional number)
    "0068_dispatch_from_unsettled_reserved.sql",
    // B16 L2 CMD060: the one retention extension, its guard path B (KA085) and the request role update grant (provisional number)
    "0069_b16_retention_extensions.sql",
    // package B05 IJR: one IC request key is one model task, each IC invocation one request row (ADR-B05-IJR-1; provisional number)
    "0070_b05_model_task_request_key.sql",
    // B16 L3 CMD042: the deletion request, its receipts, the DELETING/DELETED guards and the prevention guards KA087/KA088 (provisional number)
    "0071_b16_deletion.sql",
    // Payments V1 OWNER-OUTBOX-POLICY: the owner's agency-less outbox policies are SELECT and INSERT only (provisional number)
    "0075_owner_outbox_policy.sql",
    // B10-CMD053-SETTLED-AT: a payout intent's settlement instant is one of its transaction's, read after the cash lock (provisional number)
    "0076_payout_effect_instant.sql",
    // B16 L4 CMD054/CMD055: the breakglass grants, their accesses and the policies a named grant reads under (KA089; provisional number)
    "0071_b16_breakglass.sql",
    // B16 L5 CMD038: download authorizations, their KA094 guard and the package transition lock (provisional number)
    "0074_b16_download_authorizations.sql",
  ]);
  assert.deepEqual(files.map((f) => f.version), files.map((_, i) => i + 1));
  assert.deepEqual(pg.migrations.applied.map((f) => f.version), files.map((f) => f.version));
  const owner = await pg.connect("kauro_owner");
  try {
    const again = await applyMigrations(owner);
    assert.equal(again.applied.length, 0);
    assert.equal(again.skipped.length, files.length);
    const ledger = await appliedMigrations(owner);
    assert.deepEqual(ledger.map((l) => [l.version, l.checksum]), files.map((f) => [f.version, f.checksum]));
    for (const l of ledger) assert.equal(l.appliedBy, "kauro_owner");
  } finally {
    await owner.end();
  }
});

test("a migration file edited after being applied is refused as drift", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kauro-mig-drift-"));
  try {
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const owner = await pg.connect("kauro_owner");
    try {
      const first = await applyMigrations(owner, { dir });
      assert.equal(first.applied.length, 0, "the copy matches the applied set");
      writeFileSync(join(dir, "0007_security_events.sql"), "-- edited after application\nSELECT 1;\n");
      await assert.rejects(applyMigrations(owner, { dir }), MigrationDriftError);
    } finally {
      await owner.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime roles are neither owners nor superusers and have no BYPASSRLS; the owner never serves requests", async () => {
  const su = await pg.connect("postgres");
  try {
    const roles = await su.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }>(
      `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname IN
         ('kauro_app', 'kauro_control', 'kauro_assurance', 'kauro_validator', 'kauro_ingress', 'kauro_payment', 'kauro_commission', 'kauro_app_test', 'kauro_control_test', 'kauro_assurance_test', 'kauro_validator_test', 'kauro_ingress_test', 'kauro_payment_test', 'kauro_commission_test')`,
    );
    assert.equal(roles.rows.length, 14);
    for (const r of roles.rows) {
      assert.equal(r.rolsuper, false, r.rolname);
      assert.equal(r.rolbypassrls, false, r.rolname);
      assert.equal(r.rolcreaterole, false, r.rolname);
    }
    const owners = await su.query<{ tableowner: string }>("SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'kauro'");
    assert.deepEqual(owners.rows.map((o) => o.tableowner), ["kauro_owner"]);
    const rls = await su.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'kauro' AND c.relkind = 'r' ORDER BY c.relname",
    );
    assert.ok(rls.rows.length >= 20);
    for (const t of rls.rows) {
      if (t.relname === "state_transitions" || t.relname === "state_machines") continue; // reference data, SELECT only, no tenant rows
      assert.equal(t.relrowsecurity, true, `${t.relname} has no RLS`);
      assert.equal(t.relforcerowsecurity, true, `${t.relname} does not FORCE RLS`);
    }
    // SECURITY DEFINER requires specific justification (08): the one function is the registration of a bank route's payment route
    // (migration 0046, coordinator decision #2 of lane L-ROUTE: payment_routes stays closed to every runtime role; the function checks the
    // caller's ACTIVE KAURO_OWNER grant and writes CONFIGURED rows only), with a pinned search_path
    const definers = await su.query<{ proname: string; proconfig: string[] | null }>("SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'kauro' AND p.prosecdef");
    assert.deepEqual(definers.rows, [{ proname: "register_bank_payment_route", proconfig: ["search_path=pg_catalog, pg_temp"] }]);
    // request handlers never hold DELETE on any table
    const deletes = await su.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.role_table_grants WHERE grantee = 'kauro_app' AND privilege_type = 'DELETE' AND table_schema = 'kauro'",
    );
    assert.deepEqual(deletes.rows, []);
  } finally {
    await su.end();
  }
});

interface RegistryContract {
  name: string;
  fields: Array<{ name: string; type: string }>;
}

function registryEnum(contract: string, field: string): string[] {
  const contracts = registryJson<RegistryContract[]>("contracts.json");
  const f = contracts.find((c) => c.name === contract)?.fields.find((x) => x.name === field);
  assert.ok(f && f.type.startsWith("enum:"), `${contract}.${field}`);
  return f.type.slice(5).split(",");
}

test("state and enum CHECK constraints carry exactly the registry vocabularies", async () => {
  const su = await pg.connect("postgres");
  try {
    const expect: Array<[string, string, string, string]> = [
      ["agencies", "state", "Agency", "state"],
      ["memberships", "role", "Membership", "role"],
      ["memberships", "state", "Membership", "state"],
      ["end_clients", "state", "EndClient", "state"],
      ["dataset_revisions", "state", "DatasetRevision", "state"],
      ["plans", "state", "Plan", "state"],
      ["capabilities", "state", "Capability", "state"],
      ["validation_receipts", "result", "ValidationReceipt", "result"],
      ["request_journal", "state", "RequestJournal", "state"],
      ["request_journal", "usage_state", "RequestJournal", "usageState"],
      ["outbox_records", "state", "OutboxRecord", "state"],
      ["inbox_records", "state", "InboxRecord", "state"],
      ["inbox_records", "environment", "InboxRecord", "environment"],
      ["target_contracts", "mode", "TargetContract", "mode"],
      ["support_cases", "category", "SupportCase", "category"],
      ["support_cases", "severity", "SupportCase", "severity"],
      ["support_cases", "state", "SupportCase", "state"],
      // package B08 (0023): the registry Audit and CostGrant vocabularies
      ["audits", "state", "Audit", "state"],
      ["cost_grants", "state", "CostGrant", "state"],
      // package B10 (0029..0031)
      ["prospects", "state", "Prospect", "state"],
      ["attribution_claims", "state", "AttributionClaim", "state"],
      ["seller_agreements", "classification", "SellerAgreement", "classification"],
      ["commission_entitlements", "state", "CommissionEntitlement", "state"],
      ["commission_lines", "state", "CommissionLine", "state"],
      ["commission_adjustments", "reason", "CommissionAdjustment", "reason"],
      ["commission_adjustments", "direction", "CommissionAdjustment", "direction"],
      ["commission_statements", "state", "CommissionStatement", "state"],
    ];
    for (const [table, column, contract, field] of expect) {
      const r = await su.query<{ def: string }>(
        `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'kauro' AND t.relname = $1 AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ~ ('^CHECK \\(\\(' || $2 || ' = ANY')`,
        [table, column],
      );
      assert.equal(r.rows.length, 1, `${table}.${column} has no enum CHECK`);
      const values = [...r.rows[0]!.def.matchAll(/'([A-Z][A-Z0-9_]*)'::text/g)].map((m) => m[1]);
      // the vendored registry still spells one token of SupportCase.state with the authority edition's brand; the generated contract, which
      // the domain vocabulary is typed against, emits the Kauro token (amendment A2), so that one enum is compared through it
      const raw = registryEnum(contract, field);
      const emitted = contract === "SupportCase" && field === "state" ? [...SUPPORT_CASE_STATES] : raw;
      assert.equal(emitted.length, raw.length, `${table}.${column} keeps the registry's size`);
      assert.deepEqual(values, emitted, `${table}.${column}`);
    }
  } finally {
    await su.end();
  }
});

test("the listed-transition seed equals the registry machines for every machine the schema guards", async () => {
  const su = await pg.connect("postgres");
  try {
    for (const name of ["Agency", "Membership", "DatasetRevision", "Plan", "Capability", "PaymentAttempt", "TaxDocument", "Job", "Audit", "CostGrant", "CommissionLine"]) {
      const m = STATE_MACHINES.find((x) => x.contract === name)!;
      const expected = [...new Set(m.transitions.map((t) => `${t.from}>${t.to}`))].sort();
      const r = await su.query<{ edge: string }>("SELECT from_state || '>' || to_state AS edge FROM kauro.state_transitions WHERE machine = $1 ORDER BY 1", [name]);
      assert.deepEqual(r.rows.map((x) => x.edge), expected, name);
    }
    const others = await su.query<{ machine: string }>("SELECT DISTINCT machine FROM kauro.state_transitions ORDER BY 1");
    // B06 seeds seven machines; B07 adds the platform machines RetentionRecord, SourceFile, StoredObject and UploadSession (their
    // edges equal the domain SOURCE_LIFECYCLE_STATE_MACHINES: source-migrations.test.ts); package B09 adds the registry machines
    // PaymentAttempt and TaxDocument and its ten platform machines (b09-migrations.test.ts compares those seeds with @kauro/domain
    // COMMERCE_PLATFORM_MACHINES); package B08 adds the registry machine Job and its platform machines PackageVersion and
    // ProcessingAttempt (execution-migrations.test.ts compares those seeds with @kauro/domain EXECUTION_PLATFORM_MACHINES), and the
    // registry machines Audit and CostGrant (0023); package B10 adds the platform machine FoundingReservation (b10-recurrence-migrations.test.ts compares
    // its seed with @kauro/domain COMMERCIAL_PLATFORM_MACHINES), then the registry machine CommissionLine (compared above) and the
    // platform machines Seller, Prospect, AttributionClaim, CommissionEntitlement, PayoutDestination, CommissionHold, CommissionPeriod,
    // CommissionStatement and PayoutIntent (b10-sales-migrations.test.ts and b10-ledger-migrations.test.ts compare those seeds)
    assert.deepEqual(others.rows.map((x) => x.machine), ["Agency", "AttributionClaim", "Audit", "Capability", "CaptureFact", "CommercialAuthorization", "CommissionEntitlement", "CommissionHold", "CommissionLine", "CommissionPeriod", "CommissionStatement", "CorporateGrant", "CostGrant", "DatasetRevision", "EndClient", "FiscalIssuerRoute", "FoundingReservation", "Job", "Membership", "PackageVersion", "PaymentAttempt", "PaymentOrder", "PaymentRoute", "PayoutDestination", "PayoutIntent", "Plan", "ProcessingAttempt", "Project", "Prospect", "Quote", "ReconciliationCase", "Refund", "RefundPolicy", "RetentionRecord", "Seller", "SourceFile", "StoredObject", "TaxDocument", "UploadSession"]);
  } finally {
    await su.end();
  }
});

test("R20: the initial-state seed equals the registry machines (and the platform machines of D-AGG-1/D-AGG-2, of package B09 and of B11 D-SUP-6); every table that guards its listed edges also guards its birth state", async () => {
  const su = await pg.connect("postgres");
  try {
    const seeded = await su.query<{ machine: string; initial_state: string }>("SELECT machine, initial_state FROM kauro.state_machines ORDER BY machine");
    // B07 adds the platform machines of the source lifecycle (D-UP-1, D-OBJ-1, D-FILE-1, D-RET-2), package B09 its commerce
    // machines, package B08 the registry machine Job and its platform machines of design 8.2, and the registry machines Audit and
    // CostGrant (0023), and package B10 its founding reservation (D10-FOUND-1), the registry's CommissionLine and its sales, ledger and
    // payout machines (0029..0031), and package B11 its SupportCase (D-SUP-6), each born in its initial state
    const expected = ["Agency", "AttributionClaim", "Audit", "Capability", "CaptureFact", "CommercialAuthorization", "CommissionEntitlement", "CommissionHold", "CommissionLine", "CommissionPeriod", "CommissionStatement", "CorporateGrant", "CostGrant", "DatasetRevision", "EndClient", "FiscalIssuerRoute", "FoundingReservation", "Job", "Membership", "PackageVersion", "PaymentAttempt", "PaymentOrder", "PaymentRoute", "PayoutDestination", "PayoutIntent", "Plan", "ProcessingAttempt", "Project", "Prospect", "Quote", "ReconciliationCase", "Refund", "RefundPolicy", "RetentionRecord", "Seller", "SourceFile", "StoredObject", "SupportCase", "TaxDocument", "UploadSession"].map((name) => {
      const m =
        STATE_MACHINES.find((x) => x.contract === name) ??
        PLATFORM_STATE_MACHINES.find((x) => x.contract === name) ??
        SOURCE_LIFECYCLE_STATE_MACHINES.find((x) => x.contract === name) ??
        EXECUTION_PLATFORM_MACHINES.find((x) => x.contract === name) ??
        COMMERCIAL_PLATFORM_MACHINES.find((x) => x.contract === name);
      assert.ok(m, `${name} is a registry or platform machine`);
      return { machine: name, initial_state: m.initial };
    });
    assert.deepEqual(seeded.rows, expected);
    // every machine with listed edges has its initial state, and every edge starts from a state of that machine
    const orphanEdges = await su.query("SELECT DISTINCT machine FROM kauro.state_transitions t WHERE NOT EXISTS (SELECT 1 FROM kauro.state_machines m WHERE m.machine = t.machine)");
    assert.deepEqual(orphanEdges.rows, []);
    // the birth guard sits on exactly the tables whose state changes are guarded, for the same machine
    const defs = await su.query<{ relname: string; def: string }>(
      `SELECT c.relname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'kauro' AND NOT t.tgisinternal ORDER BY c.relname, t.tgname`,
    );
    // the guard functions take the machine, and (package B09, a state column not named `state`) the column: `_of` variants; an
    // observed fact (a provider capture, D-INIT-B1) is born at its machine's initial state or one listed edge from it
    const machineOf = (fns: ReadonlyArray<string>): Map<string, string> => {
      const out = new Map<string, string>();
      for (const d of defs.rows) {
        for (const fn of fns) {
          const m = new RegExp(`EXECUTE FUNCTION kauro\\.${fn}\\('([A-Za-z]+)'(?:, '[a-z_]+')?\\)`).exec(d.def);
          if (m?.[1]) out.set(d.relname, m[1]);
        }
      }
      return out;
    };
    const edges = machineOf(["enforce_listed_transition", "enforce_listed_transition_of"]);
    const births = machineOf(["enforce_initial_state", "enforce_initial_state_of", "enforce_observed_birth"]);
    for (const d of defs.rows) if (/EXECUTE FUNCTION kauro\.enforce_membership_initial_state\(\)/.test(d.def)) births.set(d.relname, "Membership");
    assert.deepEqual([...births.entries()].sort(), [...edges.entries()].sort());
    assert.equal(edges.size, 40, "every seeded machine guards its table's edges (B06 seven, B07 four, B09 twelve, B08 five, B10 eleven, B11 one)");
    for (const d of defs.rows) {
      if (/enforce_initial_state|enforce_membership_initial_state|enforce_observed_birth/.test(d.def)) assert.match(d.def, /BEFORE INSERT ON/, d.def);
    }
  } finally {
    await su.end();
  }
});

test("registered event types in the database are exactly the domain EVENT_TYPES", async () => {
  const su = await pg.connect("postgres");
  try {
    const r = await su.query<{ event_type: string }>("SELECT event_type FROM kauro.event_types ORDER BY 1");
    assert.deepEqual(r.rows.map((x) => x.event_type), [...EVENT_TYPES].sort());
  } finally {
    await su.end();
  }
});

test("registered aggregate kinds are exactly the domain AGGREGATE_KINDS, B06's seven with their exact tables and id columns, each bound to the table and id column its event-per-version trigger names", async () => {
  const su = await pg.connect("postgres");
  try {
    const r = await su.query<{ aggregate_kind: string; table_name: string; id_column: string; owner_package: string }>(
      "SELECT aggregate_kind, table_name, id_column, owner_package FROM kauro.aggregate_kinds ORDER BY aggregate_kind",
    );
    assert.deepEqual(r.rows.map((x) => x.aggregate_kind), [...AGGREGATE_KINDS].sort());
    // the kinds, tables and id columns of B06's former CHECK list and CASE arms (0005), owned by B06
    assert.deepEqual(
      r.rows.filter((x) => x.owner_package === "B06").map((x) => [x.aggregate_kind, x.table_name, x.id_column]),
      [
        ["agency", "agencies", "agency_id"],
        ["approval", "approvals", "approval_id"],
        ["dataset_revision", "dataset_revisions", "revision_id"],
        ["end_client", "end_clients", "client_id"],
        ["membership", "memberships", "membership_id"],
        ["plan", "plans", "plan_id"],
        ["project", "projects", "project_id"],
      ],
    );
    // B11 W4 registers its own kind in its own migration (0026, D11-SYNC-1), owned by B11; B11 lane A1 the agency's buyer type (0062)
    assert.deepEqual(
      r.rows.filter((x) => x.owner_package === "B11").map((x) => [x.aggregate_kind, x.table_name, x.id_column]),
      [["agency_buyer_type", "agency_buyer_types", "agency_id"], ["support_case", "support_cases", "case_id"]],
    );
    // D-EVT-1 over the registry: every registered kind's table carries require_event_for_version(kind, id column), and every such
    // trigger names a registered kind with that table and column — the event-per-version rule and the binding agree on each kind
    const triggers = await su.query<{ table_name: string; def: string }>(
      `SELECT c.relname AS table_name, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'kauro' AND NOT t.tgisinternal AND t.tgfoid = 'kauro.require_event_for_version()'::regprocedure ORDER BY 1`,
    );
    const perVersion = triggers.rows.map((t) => {
      const m = /EXECUTE FUNCTION kauro\.require_event_for_version\('([a-z_]+)', '([a-z_]+)'\)/.exec(t.def);
      assert.ok(m, t.def);
      return [m[1], t.table_name, m[2]];
    });
    assert.deepEqual(perVersion.sort(), r.rows.map((x) => [x.aggregate_kind, x.table_name, x.id_column]).sort());
    // the former CHECK list is gone; a foreign key to the registry stands in its place
    const constraints = await su.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'kauro.domain_events'::regclass AND conname LIKE 'domain_events_aggregate_kind%' ORDER BY 1`,
    );
    assert.deepEqual(constraints.rows, [{ conname: "domain_events_aggregate_kind_fkey", def: "FOREIGN KEY (aggregate_kind) REFERENCES kauro.aggregate_kinds(aggregate_kind)" }]);
  } finally {
    await su.end();
  }
});

test("B07 D-CLOCK-1: the shipped kauro.server_now() is the transaction time and nothing else — no setting, no offset — and no runtime role can redefine it", async () => {
  const su = await pg.connect("postgres");
  try {
    const f = await su.query<{ body: string; owner: string; volatility: string; comment: string | null }>(
      "SELECT prosrc AS body, pg_get_userbyid(proowner) AS owner, provolatile AS volatility, obj_description(oid, 'pg_proc') AS comment FROM pg_proc WHERE oid = 'kauro.server_now()'::regprocedure",
    );
    assert.deepEqual(f.rows, [{ body: " SELECT transaction_timestamp() ", owner: "kauro_owner", volatility: "s", comment: null }]);
    // within one transaction it is constant and equal to now(); a transaction-local test-clock setting changes nothing here
    await su.query("BEGIN");
    try {
      await su.query("SELECT set_config('kauro_test.clock_offset_seconds', '-1296000', true)");
      const r = await su.query<{ same: boolean }>("SELECT kauro.server_now() = now() AS same");
      assert.deepEqual(r.rows, [{ same: true }]);
    } finally {
      await su.query("ROLLBACK");
    }
  } finally {
    await su.end();
  }
  for (const login of ["kauro_app_test", "kauro_control_test", "kauro_assurance_test", "kauro_validator_test", "kauro_ingress_test", "kauro_commission_test"] as const) {
    const c = await pg.connect(login);
    try {
      await assert.rejects(c.query("CREATE OR REPLACE FUNCTION kauro.server_now() RETURNS timestamptz LANGUAGE sql AS $$ SELECT now() - interval '15 days' $$"), (e: unknown) => (e as { code?: string }).code === "42501", login);
    } finally {
      await c.end();
    }
  }
});
