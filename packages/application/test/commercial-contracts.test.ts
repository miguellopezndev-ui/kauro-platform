// The wire and access contracts of package B10's commercial commands (design 13 "Commands and reads", D10-API-1, D10-CTX-1,
// D10-CTX-2, D10-BIND-1): the request schemas carry exactly the registry fields of CMD002, CMD027, CMD043 and CMD045..CMD053
// (money as MoneyMinorUnits strings), every response view is closed and derived under the B06 rules, withholding contact details,
// destination digests and other sellers' rows, and CommercialAuthorizer admits a seller only while its row is ACTIVE, the owner only
// with an ACTIVE KAURO_OWNER grant and the two commission services only under their technical roles.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { COMMANDS } from "@kauro/contracts";
import { SERVICE_ROLE_TABLE, serviceHoldsRole } from "@kauro/domain";
import {
  COMMERCIAL_COMMANDS,
  COMMERCIAL_COMMAND_RESPONSES,
  COMMERCIAL_FORBIDDEN_MEMBERS,
  COMMERCIAL_READ_ROUTES,
  COMMERCIAL_REQUEST_SCHEMAS,
  COMMERCIAL_VIEW_DEFINITIONS,
  FORBIDDEN_RESPONSE_FIELDS,
  REQUEST_SCHEMA_PREFIX,
  RESPONSE_FIELD_VOCABULARY,
  VIEW_MEMBER_KIT,
  buildCommerceResponseSchemas,
  buildCommercialResponseSchemas,
  buildResponseSchemas,
  commercialCommandResponseSchemaId,
  commercialReadResponseSchemaId,
  compileSchemaBundle,
  createCommercialAuthorizer,
  declaredMembers,
  type CommercialPrincipalReader,
  type RegistryBundle,
  type SellerPrincipal,
  type ViewDefinition,
} from "../src/index.js";
import { commerceWorld, type CommerceWorld } from "./commerce-support.js";

const B10_COMMANDS = ["CMD002", "CMD027", "CMD043", "CMD045", "CMD046", "CMD047", "CMD048", "CMD049", "CMD050", "CMD051", "CMD052", "CMD053"] as const;
const ALL_COMMANDS = [...B10_COMMANDS, "CMD054", "CMD055", "CMD056", "CMD057", "CMD058", "CMD059"] as const;
const require = createRequire(import.meta.url);
const bundle = JSON.parse(readFileSync(require.resolve("@kauro/contracts/schemas.json"), "utf8")) as RegistryBundle;

test("every B10 command spec matches its catalogue entry: name, method, path, role, gate, idempotency, fields in order, test ids and the aggregate the path names", () => {
  for (const id of B10_COMMANDS) {
    const catalogue = COMMANDS.find((c) => c.id === id);
    assert.ok(catalogue, id);
    const spec = COMMERCIAL_COMMANDS[id];
    assert.equal(spec.id, catalogue.id);
    assert.equal(spec.name, catalogue.name);
    assert.equal(spec.method, catalogue.method);
    assert.equal(spec.path, catalogue.path);
    assert.equal(spec.role, catalogue.role, `${id} role (the generator emits the Kauro identifiers, amendment A2)`);
    assert.deepEqual([...spec.fields], catalogue.fields.map((f) => f.name), `${id} fields`);
    assert.equal(catalogue.gate, "G-COMMERCIAL");
    assert.equal(catalogue.idempotency, "REQUIRED");
    assert.deepEqual([...(catalogue.testIds ?? [])], [`${id}-OK`, `${id}-DENY`, `${id}-RACE`]);
    if (spec.aggregateParam === null) assert.ok(!spec.path.includes("{"), `${id} has no path parameter`);
    else assert.ok(spec.path.includes(`{${spec.aggregateParam}}`), id);
    assert.equal(spec.expectedVersionRequired, catalogue.fields.some((f) => f.name === "expectedVersion"), id);
  }
  assert.deepEqual(Object.keys(COMMERCIAL_COMMANDS), [...B10_COMMANDS, "CMD054", "CMD055", "CMD056", "CMD057", "CMD058", "CMD059"], "B10 twelve, the two breakglass commands, the two operations commands and B18 two capability commands");
  assert.equal(COMMERCIAL_COMMANDS.CMD045.aggregateParam, null, "a prospect is registered before it has an identity");
});

test("principal, runtime role, scope and step-up follow the design's principal table; the two commission services hold only their technical roles", () => {
  // [role, principal, runtimeRole, scope, aggregate, scopeKind, stepUp]  (design 2 and 13)
  const table = {
    CMD002: ["AGENCY_OWNER", "AGENCY_MEMBER", "kauro_app", "AGENCY_PATH", "agencyId", null, false],
    CMD027: ["AGENCY_BILLING", "AGENCY_MEMBER", "kauro_app", "AGENCY_HEADER", "projectId", null, false],
    CMD043: ["AGENCY_OWNER", "AGENCY_MEMBER", "kauro_app", "AGENCY_PATH", "agencyId", null, true],
    CMD045: ["ACTIVE_SELLER_OR_OWNER", "SELLER_OR_OWNER", "kauro_app", "CORPORATE", null, null, false],
    CMD046: ["ACTIVE_SELLER", "SELLER", "kauro_app", "CORPORATE", "prospectId", null, false],
    CMD047: ["KAURO_OWNER", "CORPORATE_OPERATOR", "kauro_app", "CORPORATE", "claimId", null, false],
    CMD048: ["KAURO_OWNER", "CORPORATE_OPERATOR", "kauro_app", "CORPORATE", "agencyId", null, false],
    CMD049: ["KAURO_OWNER", "CORPORATE_OPERATOR", "kauro_app", "CORPORATE", "sellerId", null, true],
    CMD050: ["KAURO_OWNER", "CORPORATE_OPERATOR", "kauro_app", "CORPORATE", "sellerId", null, false],
    CMD051: ["COMMISSION_SERVICE", "COMMERCIAL_SERVICE", "kauro_commission", "STORED_OPERATION", "periodId", "COMMISSION_PERIOD", false],
    CMD052: ["KAURO_OWNER", "CORPORATE_OPERATOR", "kauro_app", "CORPORATE", "statementId", null, true],
    CMD053: ["FINANCE_SERVICE", "COMMERCIAL_SERVICE", "kauro_commission", "STORED_OPERATION", "statementId", "COMMISSION_STATEMENT", false],
  } as const;
  for (const id of B10_COMMANDS) {
    const spec = COMMERCIAL_COMMANDS[id];
    const [role, principal, runtimeRole, scope, aggregate, scopeKind, stepUp] = table[id];
    assert.deepEqual([spec.role, spec.principal, spec.runtimeRole, spec.scope, spec.aggregateParam, spec.scopeKind, spec.stepUp], [role, principal, runtimeRole, scope, aggregate, scopeKind, stepUp], id);
    assert.equal(spec.scopeKind !== null, spec.scope === "STORED_OPERATION", `${id}: only a stored operation resolves its scope through the index`);
    assert.deepEqual([...spec.authorityHashFields], id === "CMD051" ? ["ledgerCutoffHash"] : [], `${id} authority hashes: only the period close names its exact ledger cutoff`);
  }
  // a service account has only its technical role (08): the table is code-owned and one role per identity
  assert.equal(serviceHoldsRole("commission-service", "COMMISSION_SERVICE"), true);
  assert.equal(serviceHoldsRole("finance-service", "FINANCE_SERVICE"), true);
  assert.equal(serviceHoldsRole("commission-service", "FINANCE_SERVICE"), false);
  assert.equal(serviceHoldsRole("finance-service", "COMMISSION_SERVICE"), false);
  assert.equal(serviceHoldsRole("payment-service", "COMMISSION_SERVICE"), false);
  assert.equal(serviceHoldsRole("commission-service", "PAYMENT_SERVICE"), false);
  assert.equal(serviceHoldsRole("constructor", "FINANCE_SERVICE"), false, "an inherited object key is not a service identity");
  assert.equal(Object.keys(SERVICE_ROLE_TABLE).length, 6);
});

// --- sample bodies and DTOs the design specifies ----------------------------------------------------------------------------------

const ID = (n: number) => `01920000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const H = (c: string) => c.repeat(64);
const AT = "2026-10-07T12:00:00.000Z";

const requests = {
  CMD002: { expectedVersion: 2, termsVersion: "R2-TERMS", privacyAgreementVersion: "R2-PRIVACY", billingProfileRef: ID(9) },
  CMD027: { planId: ID(10), billingProfileRef: ID(9) },
  CMD043: { expectedVersion: 3, assuranceProofRef: ID(11) },
  CMD045: { organizationLabel: "Acme Data SAS", businessContactRef: ID(12), sourceEvidenceHash: H("a"), jurisdiction: "CO" },
  CMD046: { evidenceHash: H("b"), agreementVersion: "SELLER-AGREEMENT-2026-1" },
  CMD047: { expectedVersion: 1, shareAllocationRef: ID(13) },
  CMD048: { expectedVersion: 1, sellerId: ID(14), serviceAssignmentRef: ID(15) },
  CMD049: { agreementId: ID(16), assessmentEvidenceRef: ID(17), assuranceProofRef: ID(18) },
  CMD050: { expectedVersion: 2, terminationTermsRef: ID(19), activeOpportunityManifestRef: ID(20) },
  CMD051: { ledgerCutoffHash: H("c") },
  CMD052: { expectedVersion: 1, payeeRef: ID(21), authorizationRef: ID(22) },
  CMD053: { providerPayoutEvidenceRef: ID(23) },
} as const;

const agency = { agencyId: ID(2), version: 3, displayName: "Acme", state: "ACTIVE", termsVersion: "R2-TERMS", privacyAgreementVersion: "R2-PRIVACY", createdAt: "2026-09-25T12:00:00.000Z", permittedActions: [] };
const quote = {
  quoteId: ID(1), agencyId: ID(2), projectId: ID(3), revisionHash: H("a"), planHash: H("b"), billableUnits: 50000, mode: "HUBSPOT",
  pricePolicyVersion: "R2-INITIAL", discountPolicyVersion: "R2-INITIAL", baseServiceCents: "129500", discountCents: "32375", serviceCents: "97125",
  taxCents: "0", totalCents: "97125", currency: "USD", expiresAt: "2026-10-09T12:00:00.000Z", sourceAvailableUntil: "2026-10-01T12:00:00.000Z",
  termsHash: H("c"), version: 2, state: "ISSUED", discount: { bps: 2500, basis: "FOUNDING" }, taxTreatment: "EXEMPT_EXPORT",
  issuedAt: "2026-09-25T12:00:00.000Z", checkoutReady: false, checkoutBlockers: ["SOURCE_EXPIRED"], permittedActions: [],
};
const prospect = { prospectId: ID(101), organizationLabel: "Acme Data SAS", sourceEvidenceHash: H("a"), jurisdiction: "CO", state: "RESEARCHED", suppressed: false };
const claim = { claimId: ID(102), prospectId: ID(101), sellerId: ID(103), expiresAt: "2026-12-28T12:00:00.000Z", evidenceHash: H("b"), state: "SUBMITTED", agreementVersion: "SELLER-AGREEMENT-2026-1", version: 1 };
const period = { periodId: ID(111), version: 2, periodStart: "2026-09-01T05:00:00.000Z", periodEnd: "2026-10-01T05:00:00.000Z", state: "CLOSED", closeDueOn: "2026-10-07", payDueOn: "2026-10-15", calendarVersion: "test-fixture-2026-10", calendarSource: "TEST_FIXTURE", simulated: true };
const item = {
  lineId: ID(120), agencyId: ID(2), projectId: ID(3), sequence: "FIRST", netServiceBasisCents: "97125", rateBps: 1500, shareBps: 10000,
  cumulativeEntitlementCents: "14568", previouslyPaidCents: "0", adjustmentCents: "0", heldCents: "0", payableCents: "14568",
};
const statement = {
  statementId: ID(110), sellerId: ID(103), periodStart: period.periodStart, periodEnd: period.periodEnd, lineIds: [ID(120)], payableCents: "14568", heldCents: "0",
  state: "ISSUED", version: 1, periodId: ID(111), items: [item], balanceItems: [], calendarVersion: "test-fixture-2026-10", payDueOn: "2026-10-15", simulated: true, issuedAt: AT,
};
const intent = {
  intentId: ID(130), statementId: ID(110), state: "AUTHORIZED", amountCents: "14568", currency: "USD", feeBearer: "KAURO", reference: `kauro-payout-${ID(130)}`,
  destinationVersion: 2, authorizedAt: AT, version: 1, statementState: "APPROVED",
};

const completed = (data: unknown, version = 1) => ({ kind: "COMPLETED", version, replayed: false, data });

test("the commercial contracts: every request schema carries exactly the registry fields of its command, every view is closed and withholds contact details, destination digests and other sellers' rows, and CommercialAuthorizer admits a seller only while its row is ACTIVE and the owner only with an ACTIVE grant", async () => {
  // --- the request schemas are the registry fields, closed, and no money is a number ---------------------------------------------
  const typeOf: Record<string, string> = { label: "string", id: "string", version: "integer", hash: "string", money: "string", text: "string" };
  const requestRoots: Record<string, unknown> = {};
  for (const id of B10_COMMANDS) {
    const catalogue = COMMANDS.find((c) => c.id === id)!;
    const s = COMMERCIAL_REQUEST_SCHEMAS[id];
    assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(s.$id, `${REQUEST_SCHEMA_PREFIX}${id}`);
    assert.equal(s.additionalProperties, false, `${id} must reject unknown fields (R2-059)`);
    assert.deepEqual(Object.keys(s.properties), catalogue.fields.map((f) => f.name), `${id} properties are exactly the registry fields`);
    assert.deepEqual([...s.required], catalogue.fields.map((f) => f.name), `${id}: every catalogue field is required`);
    for (const f of catalogue.fields) {
      const p = s.properties[f.name]!;
      assert.equal(p["type"], typeOf[f.type], `${id}.${f.name} (${f.type})`);
      assert.ok(!("default" in p), `${id}.${f.name} must not default`);
      if (f.type === "money") assert.equal(p["pattern"], "^(0|[1-9][0-9]{0,15})$", "money is a MoneyMinorUnits decimal string, never a JSON number");
      if (f.type === "label") assert.equal(p["maxLength"], 200, "a label is 1..200 characters (B06 D-LABEL-1)");
    }
    requestRoots[id] = s;
  }
  assert.ok(Object.values(COMMERCIAL_REQUEST_SCHEMAS).every((s) => !s.properties["amountCents"] && !s.properties["destinationDigest"] && !s.properties["sellerId"] === (s.$id !== `${REQUEST_SCHEMA_PREFIX}CMD048`)), "no request carries an amount, a destination digest or, but for the assignment, a seller identity");
  const requestsCompiled = compileSchemaBundle({ defs: {}, roots: requestRoots });
  const requestCodes = (id: string, body: unknown) => requestsCompiled.validate(id, body).map((e) => `${e.field}:${e.code}`);
  for (const id of B10_COMMANDS) assert.deepEqual(requestsCompiled.validate(id, requests[id]), [], `${id} ${JSON.stringify(requests[id])}`);
  assert.ok(requestCodes("CMD045", { ...requests.CMD045, email: "buyer@example.com" }).includes("email:UNKNOWN_FIELD"), "contact details travel as a reference, never as text");
  assert.ok(requestCodes("CMD046", { ...requests.CMD046, prospectId: ID(101) }).includes("prospectId:UNKNOWN_FIELD"), "the prospect is the path's");
  assert.ok(requestCodes("CMD052", { ...requests.CMD052, amountCents: "14568" }).includes("amountCents:UNKNOWN_FIELD"), "the payout amount is the statement's, never the caller's");
  assert.ok(requestCodes("CMD049", { ...requests.CMD049, destinationDigest: H("d") }).includes("destinationDigest:UNKNOWN_FIELD"));
  assert.ok(requestCodes("CMD051", {}).some((c) => c.startsWith("ledgerCutoffHash:")), "a period is closed against its exact ledger cutoff");
  assert.ok(requestCodes("CMD051", { ledgerCutoffHash: "ABC" }).some((c) => c.startsWith("ledgerCutoffHash:")));
  assert.ok(requestCodes("CMD045", { ...requests.CMD045, organizationLabel: "line\u0007break" }).some((c) => c.startsWith("organizationLabel:")), "a label refuses control characters");
  assert.ok(requestCodes("CMD002", { ...requests.CMD002, expectedVersion: "2" }).some((c) => c.startsWith("expectedVersion:")), "a version is never coerced");
  assert.ok(requestCodes("CMD053", { providerPayoutEvidenceRef: "not-an-id" }).some((c) => c.startsWith("providerPayoutEvidenceRef:")));

  // --- the response views are closed, derived under the B06 rules and never carry what D10-API-1 withholds -------------------------
  const shared = { ...buildResponseSchemas(bundle).defs, ...buildCommerceResponseSchemas(bundle).defs };
  const { defs, roots } = buildCommercialResponseSchemas(bundle, shared);
  const compiled = compileSchemaBundle({ defs: { ...bundle.$defs, ...shared, ...defs }, roots });
  const ok = (id: string, body: unknown) => assert.deepEqual(compiled.validate(id, body), [], `${id} ${JSON.stringify(body).slice(0, 240)}`);
  const refused = (id: string, body: unknown) => assert.notDeepEqual(compiled.validate(id, body), [], `${id} must refuse ${JSON.stringify(body).slice(0, 240)}`);
  const viewNames = COMMERCIAL_VIEW_DEFINITIONS.map((v) => v.name);
  assert.equal(new Set(viewNames).size, viewNames.length, "a view is defined once");
  assert.deepEqual(Object.keys(defs), viewNames);
  assert.ok(viewNames.every((n) => !(n in bundle.$defs) && !(n in shared)), "no B10 view shadows a registry or an earlier package's definition");
  assert.deepEqual(Object.keys(COMMERCIAL_COMMAND_RESPONSES), [...B10_COMMANDS, "CMD054", "CMD055", "CMD056", "CMD057", "CMD058", "CMD059"]);
  assert.deepEqual(Object.values(COMMERCIAL_COMMAND_RESPONSES).map((r) => r.status), [200, 201, 200, 201, 201, 200, 200, 200, 200, 200, 200, 200, 201, 200, 201, 200, 200, 200]);
  assert.deepEqual(Object.values(COMMERCIAL_COMMAND_RESPONSES).map((r) => r.accepted), ALL_COMMANDS.map((c) => c === "CMD027"));
  assert.deepEqual(Object.keys(roots).sort(), [...ALL_COMMANDS.map((c) => commercialCommandResponseSchemaId(c)), commercialReadResponseSchemaId("GetCommissionStatement"), commercialReadResponseSchemaId("PreviewTableUnderBreakglass")].sort());
  assert.deepEqual(COMMERCIAL_READ_ROUTES.GetCommissionStatement, {
    path: "/api/v1/sales/statements/{statementId}",
    scope: "CORPORATE",
    role: "SELLER_OR_KAURO_OWNER",
    view: "CommissionStatementView",
    action: "READ_COMMISSION_STATEMENT",
    summary: COMMERCIAL_READ_ROUTES.GetCommissionStatement.summary,
    authority: COMMERCIAL_READ_ROUTES.GetCommissionStatement.authority,
  });
  for (const id of B10_COMMANDS) assert.ok(COMMERCIAL_COMMAND_RESPONSES[id].view in defs, `${id} answers a view this package defines`);

  // the specified DTOs of every command and of the read
  const closure = { openQuotesWithdrawn: 1, liveAuthorizations: 0, openRefunds: 0, nonTerminalTaxDocuments: 0, openReconciliationCases: 1, activeWorkItems: 0, openReconciliationCents: "12000" };
  ok(commercialCommandResponseSchemaId("CMD002"), completed({ agency, acceptedAt: AT, offeredModes: ["HUBSPOT"] }, 3));
  ok(commercialCommandResponseSchemaId("CMD027"), completed({ quote, eligibility: { qualifyingProjectCount: 2, repeatDiscountBps: 1500, foundingOffer: "NOT_ELIGIBLE", appliedDiscountBps: 1500, lookbackStartsAt: "2025-09-25T12:00:00.000Z" } }, 1));
  ok(commercialCommandResponseSchemaId("CMD027"), completed({ quote, eligibility: { qualifyingProjectCount: 0, repeatDiscountBps: 0, foundingOffer: "RESERVED", appliedDiscountBps: 2500, lookbackStartsAt: "2025-09-25T12:00:00.000Z" }, supersededQuoteId: ID(4), replacement: { replacedQuoteId: ID(4), revokedAuthorizationId: ID(5), approvalRequired: true, outcome: "REBOUND" } }, 1));
  ok(commercialCommandResponseSchemaId("CMD043"), completed({ agency: { ...agency, state: "CLOSING" }, closureId: ID(6), requestedAt: AT, obligations: closure, deletionScheduledFor: "2027-01-05T12:00:00.000Z" }, 4));
  ok(commercialCommandResponseSchemaId("CMD045"), completed(prospect, 1));
  ok(commercialCommandResponseSchemaId("CMD045"), completed({ ...prospect, ownerSellerId: ID(103), state: "QUALIFIED" }, 2));
  ok(commercialCommandResponseSchemaId("CMD046"), completed(claim, 1));
  ok(commercialCommandResponseSchemaId("CMD047"), completed({ claim: { ...claim, state: "ACCEPTED", acceptedAt: AT, version: 2 }, allocationId: ID(140), agencyId: ID(2), decisionReason: "FIRST_CLAIM_WINS", beneficiaryCount: 1, rejectedClaimCount: 2 }, 2));
  ok(commercialCommandResponseSchemaId("CMD048"), completed({ agencyId: ID(2), version: 4, sellerId: ID(103), assignedAt: AT, newWorkCompensation: "NONE" }, 4));
  ok(commercialCommandResponseSchemaId("CMD048"), completed({ agencyId: ID(2), version: 5, sellerId: ID(103), assignedAt: AT, newWorkCompensation: "ASSISTANCE_AGREEMENT", assistanceAgreementId: ID(141) }, 5));
  ok(commercialCommandResponseSchemaId("CMD049"), completed({ sellerId: ID(103), version: 2, state: "ACTIVE", agreementId: ID(16), classification: "INDEPENDENT_COLLABORATION", activatedAt: AT, payoutDestinationVerified: false }, 2));
  ok(commercialCommandResponseSchemaId("CMD050"), completed({ sellerId: ID(103), version: 3, state: "TERMINATED", effectiveAt: AT, tailEndsAt: "2027-01-05T12:00:00.000Z", tailEntries: 2, entitlementsResidual: 2, claimsExpired: 1, prospectsUnassigned: 3, assignmentsEnded: 2 }, 3));
  ok(commercialCommandResponseSchemaId("CMD051"), completed({ period, ledgerCutoffHash: H("c"), statementCount: 3, payableTotalCents: "43704", heldTotalCents: "2000", guardReviewCount: 1 }, 2));
  ok(commercialCommandResponseSchemaId("CMD052"), completed(intent, 1));
  ok(commercialCommandResponseSchemaId("CMD053"), completed({ intentId: ID(130), statementId: ID(110), intentState: "SETTLED", statementState: "PAID", payoutEvidenceHash: H("e"), settledAt: AT, linesPaid: 3, linesHeld: 0, version: 3 }, 3));
  ok(commercialCommandResponseSchemaId("CMD053"), completed({ intentId: ID(130), statementId: ID(110), intentState: "FAILED", statementState: "APPROVED", linesPaid: 0, linesHeld: 3, reviewOn: "2026-10-22", version: 3 }, 3));
  ok(commercialReadResponseSchemaId("GetCommissionStatement"), { kind: "READ", data: statement });
  ok(commercialReadResponseSchemaId("GetCommissionStatement"), { kind: "READ", data: { ...statement, state: "PAID", payoutEvidenceHash: H("e"), balanceItems: [{ kind: "OFFSET", lineId: ID(121), amountCents: "500" }], items: [{ ...item, adjustmentDirection: "DECREASE", adjustmentCents: "500", heldCents: "1000", holdReason: "CUSTOMER_DISPUTE", holdReviewOn: "2026-10-22" }] } });

  // never: contact details, destination digests, another seller's rows, an agency's CRM, a guard finding
  const stmt = commercialReadResponseSchemaId("GetCommissionStatement");
  refused(commercialCommandResponseSchemaId("CMD045"), completed({ ...prospect, businessContactRef: ID(12) }));
  refused(commercialCommandResponseSchemaId("CMD045"), completed({ ...prospect, email: "buyer@example.com" }));
  refused(commercialCommandResponseSchemaId("CMD045"), completed({ ...prospect, contactEmail: "buyer@example.com", phone: "+57 300 000 0000" }));
  refused(commercialCommandResponseSchemaId("CMD052"), completed({ ...intent, destinationDigest: H("d") }));
  refused(commercialCommandResponseSchemaId("CMD052"), completed({ ...intent, bankAccount: "0123456789" }));
  refused(commercialCommandResponseSchemaId("CMD053"), completed({ intentId: ID(130), statementId: ID(110), intentState: "SETTLED", statementState: "PAID", linesPaid: 3, linesHeld: 0, version: 3, destinationDigest: H("d") }));
  refused(stmt, { kind: "READ", data: { ...statement, items: [{ ...item, sellerId: ID(104) }] } });
  refused(stmt, { kind: "READ", data: { ...statement, statements: [statement] } });
  refused(stmt, { kind: "READ", data: { ...statement, sellerLedger: [{ sellerId: ID(104), payableCents: "1" }] } });
  refused(stmt, { kind: "READ", data: { ...statement, items: [{ ...item, customerEmail: "buyer@example.com" }] } });
  refused(commercialCommandResponseSchemaId("CMD051"), completed({ period, ledgerCutoffHash: H("c"), statementCount: 1, payableTotalCents: "1", heldTotalCents: "0", guardReviewCount: 0, statements: [{ sellerId: ID(104), payableCents: "1" }] }));
  refused(commercialCommandResponseSchemaId("CMD047"), completed({ claim, allocationId: ID(140), agencyId: ID(2), decisionReason: "FIRST_CLAIM_WINS", beneficiaryCount: 1, rejectedClaimCount: 0, rejectedClaims: [claim] }));
  refused(commercialCommandResponseSchemaId("CMD049"), completed({ sellerId: ID(103), version: 2, state: "ACTIVE", agreementId: ID(16), classification: "INDEPENDENT_COLLABORATION", payoutDestinationVerified: true, taxIdentifier: "900123456-7" }));
  // money is a MoneyMinorUnits string, never a number or a decimal; a state the domain does not have is not answered
  refused(stmt, { kind: "READ", data: { ...statement, payableCents: 14568 } });
  refused(stmt, { kind: "READ", data: { ...statement, payableCents: "145.68" } });
  refused(commercialCommandResponseSchemaId("CMD052"), completed({ ...intent, amountCents: 14568 }));
  refused(commercialCommandResponseSchemaId("CMD052"), completed({ ...intent, feeBearer: "SELLER" }));
  refused(commercialCommandResponseSchemaId("CMD053"), completed({ intentId: ID(130), statementId: ID(110), intentState: "PENDING", statementState: "PAID", linesPaid: 3, linesHeld: 0, version: 3 }));
  refused(commercialCommandResponseSchemaId("CMD045"), completed({ ...prospect, organizationLabel: "a\u0000b" }));
  // the envelope is exact
  refused(commercialCommandResponseSchemaId("CMD045"), { kind: "COMPLETED", replayed: false, data: prospect });
  refused(commercialCommandResponseSchemaId("CMD045"), { ...completed(prospect), extra: true });

  // the registry projections withhold what the design says, and nothing else is missing
  const prospectView = COMMERCIAL_VIEW_DEFINITIONS.find((v) => v.name === "ProspectView")!;
  assert.deepEqual(Object.keys(prospectView.withheld), ["businessContactRef"]);
  assert.ok(!("businessContactRef" in (defs["ProspectView"] as { properties: Record<string, unknown> }).properties));
  for (const view of COMMERCIAL_VIEW_DEFINITIONS.filter((v) => v.contract !== null)) {
    const contract = bundle.$defs[view.contract!] as { properties: Record<string, unknown> };
    for (const name of Object.keys(contract.properties)) assert.ok(name in view.members || name in view.withheld, `${view.name}: ${name} is selected or withheld with a reason`);
  }
  // no schema of this package declares a forbidden member: the B06 list and the commercial one (contact details, digests, accounts)
  for (const name of ["destinationDigest", "businessContactRef", "email", "phone", "bankAccount", "accountNumber", "taxIdentifier"]) assert.ok(name in COMMERCIAL_FORBIDDEN_MEMBERS, name);
  for (const [where, schema] of [...Object.entries(defs), ...Object.entries(roots)]) {
    for (const member of declaredMembers(schema)) {
      assert.ok(!(member.name in FORBIDDEN_RESPONSE_FIELDS) && !(member.name in COMMERCIAL_FORBIDDEN_MEMBERS), `${where}${member.path} declares ${member.name}`);
    }
  }
  // a view that does not select the seller's own statement fields cannot leak another seller's: no view of the package lists sellers
  for (const view of COMMERCIAL_VIEW_DEFINITIONS) {
    // "rows": the breakglass preview's bounded sample of ONE table of the project the holder's own live grant covers (B16 L4, S071)
    const arrays = Object.entries(view.members).filter(([, m]) => m.kind === "platform" && (m.schema as { type?: string }).type === "array").map(([name]) => name);
    for (const name of arrays) assert.ok(["offeredModes", "items", "balanceItems", "lineIds", "affectedScopeRefs", "openResponsibilities", "rows"].includes(name), `${view.name}.${name}: a list in a commercial view is the caller's own`);
  }

  // injected definitions are refused by the same builder (a start-up check, not a convention)
  const { registry, platform, ref } = VIEW_MEMBER_KIT;
  const { HASH, ID: ID_SCHEMA } = RESPONSE_FIELD_VOCABULARY;
  const view = (name: string, members: ViewDefinition["members"], extra: Partial<ViewDefinition> = {}): ViewDefinition => ({ name, description: "an injected view", contract: null, withheld: {}, members, ...extra });
  const build = (views: ReadonlyArray<ViewDefinition>) => () => buildCommercialResponseSchemas(bundle, shared, views);
  assert.doesNotThrow(build([...COMMERCIAL_VIEW_DEFINITIONS, view("FineView", { intentId: platform(true, ID_SCHEMA, "An identity.") })]));
  assert.throws(build([...COMMERCIAL_VIEW_DEFINITIONS, view("LeakView", { destinationDigest: platform(true, HASH, "A digest.") })]), /forbidden member destinationDigest/);
  assert.throws(build([...COMMERCIAL_VIEW_DEFINITIONS, view("LeakView", { contact: platform(true, { type: "object", additionalProperties: false, required: ["email"], properties: { email: { type: "string" } } }, "Contact.") })]), /forbidden member email/);
  assert.throws(build([...COMMERCIAL_VIEW_DEFINITIONS, view("LeakView", { title: platform(true, { type: "string" }, "The B06 list applies too."), token: platform(true, { type: "string" }, "A token.") })]), /forbidden member token/);
  assert.throws(build([...COMMERCIAL_VIEW_DEFINITIONS, view("Prospect", { intentId: platform(true, ID_SCHEMA, "An identity.") })]), /collides with a registry definition/);
  assert.throws(build([...COMMERCIAL_VIEW_DEFINITIONS, view("QuoteView", { intentId: platform(true, ID_SCHEMA, "An identity.") })]), /collides with/);
  assert.throws(build([...COMMERCIAL_VIEW_DEFINITIONS, view("ProspectView", { intentId: platform(true, ID_SCHEMA, "An identity.") })]), /defined twice/);
  assert.throws(build([...COMMERCIAL_VIEW_DEFINITIONS, view("DanglingView", { thing: platform(true, ref("NoSuchView"), "A reference that resolves to nothing.") })]), /NoSuchView/);
  assert.throws(build([...COMMERCIAL_VIEW_DEFINITIONS, view("OpenView", { thing: platform(true, { type: "object", properties: { a: ID_SCHEMA } }, "An open object.") })]), /not closed/);
  assert.throws(build(COMMERCIAL_VIEW_DEFINITIONS.map((v) => (v.name === "ProspectView" ? { ...v, withheld: {}, members: { ...v.members, businessContactRef: registry(false) } } : v))), /forbidden member businessContactRef/);
  assert.throws(build(COMMERCIAL_VIEW_DEFINITIONS.map((v) => (v.name === "ProspectView" ? { ...v, withheld: {} } : v))), /businessContactRef is neither selected nor withheld/);
  assert.throws(build(COMMERCIAL_VIEW_DEFINITIONS.map((v) => (v.name === "CommissionStatementView" ? { ...v, members: { ...v.members, lineIds: registry(true, { items: { type: "string" } }) } } : v))), /narrowing may only add keywords/);

  // --- CommercialAuthorizer: the seller's row after its lock, the owner's grant, the two services ----------------------------------
  const w: CommerceWorld = commerceWorld();
  const sellers = new Map<string, SellerPrincipal>();
  const reads: string[] = [];
  const principals: CommercialPrincipalReader = {
    binding: "CONTRACT_FAKE",
    async sellerOf(_uow, userId) {
      reads.push(`seller ${userId}`);
      return sellers.get(userId) ?? null;
    },
    async ownerGrantOf(uow, userId) {
      reads.push(`owner ${userId}`);
      const grant = await uow.commerce.corporateGrants.activeGrant(userId, "KAURO_OWNER");
      return grant === null ? null : { userId: grant.userId, state: grant.state };
    },
  };
  const authorizer = createCommercialAuthorizer({ principals });
  const sellerUser = w.billing;
  const sellerId = ID(103);
  const row = (state: SellerPrincipal["state"], overrides: Partial<SellerPrincipal> = {}): SellerPrincipal => ({ sellerId, userId: sellerUser.userId, state, version: 2, ...overrides });
  const asSeller = (identity = sellerUser.identity, context = w.operator(sellerUser.userId)) => w.ports.unitOfWork.run(context, (uow) => authorizer.authorizeSeller(uow, { identity }));
  const asOwner = (identity = w.owner.identity, context = w.operator()) => w.ports.unitOfWork.run(context, (uow) => authorizer.authorizeCorporateOwner(uow, { identity }));
  const outcome = (d: { readonly kind: string; readonly code?: string; readonly reason?: string | null }) => (d.kind === "DENY" ? [d.code, d.reason] : d.kind);

  // no row: not a seller
  assert.deepEqual(outcome(await asSeller()), ["NOT_AUTHORIZED", "CORPORATE_ROLE_MISSING"]);
  // only ACTIVE is admitted; a candidate, a suspended and a terminated seller are refused with the same reason (no state oracle)
  for (const state of ["CANDIDATE", "SUSPENDED", "TERMINATED"] as const) {
    sellers.set(sellerUser.userId, row(state));
    assert.deepEqual(outcome(await asSeller()), ["NOT_AUTHORIZED", "CORPORATE_ROLE_MISSING"], state);
  }
  sellers.set(sellerUser.userId, row("ACTIVE"));
  assert.deepEqual(await asSeller(), { kind: "ALLOW", userId: sellerUser.userId, sellerId, policyVersion: "B09-1" });
  // the row is read for each decision: a suspension after the first decision is honoured by the next
  sellers.set(sellerUser.userId, row("SUSPENDED"));
  assert.deepEqual(outcome(await asSeller()), ["NOT_AUTHORIZED", "CORPORATE_ROLE_MISSING"]);
  sellers.set(sellerUser.userId, row("ACTIVE", { version: 3 }));
  assert.equal((await asSeller()).kind, "ALLOW");
  // another person's row is never this caller's, whatever the reader returned
  sellers.set(sellerUser.userId, row("ACTIVE", { userId: w.owner.userId }));
  assert.deepEqual(outcome(await asSeller()), ["NOT_AUTHORIZED", "CORPORATE_ROLE_MISSING"]);
  sellers.set(sellerUser.userId, row("ACTIVE"));
  // the unit of work must run for the caller as an OPERATOR; a token of another person, a TENANT context and a disabled or unverified identity are refused first
  assert.deepEqual(outcome(await asSeller(sellerUser.identity, w.operator(w.owner.userId))), ["AUTHENTICATION_REQUIRED", "SUBJECT_UNAUTHENTICATED"]);
  assert.deepEqual(outcome(await asSeller(sellerUser.identity, w.tenant() as never)), ["AUTHENTICATION_REQUIRED", "SUBJECT_UNAUTHENTICATED"], "an agency context is not a seller");
  assert.deepEqual(outcome(await asSeller({ ...sellerUser.identity, mfaEnrolledAt: null })), ["NOT_AUTHORIZED", "IDENTITY_UNVERIFIED"]);
  assert.deepEqual(outcome(await asSeller({ ...sellerUser.identity, state: "DISABLED" })), ["NOT_AUTHORIZED", "IDENTITY_DISABLED"]);
  const before = reads.length;
  await asSeller({ ...sellerUser.identity, state: "DISABLED" });
  assert.equal(reads.length, before, "a refused identity never reaches the seller row");

  // the owner: an ACTIVE KAURO_OWNER grant of its own, read inside the decision; an agency member holds none; a revoked grant grants nothing
  assert.deepEqual(await asOwner(), { kind: "ALLOW", userId: w.owner.userId, policyVersion: "B09-1" });
  assert.deepEqual(outcome(await asOwner(w.billing.identity, w.operator(w.billing.userId))), ["NOT_AUTHORIZED", "CORPORATE_ROLE_MISSING"]);
  assert.deepEqual(outcome(await asOwner(w.owner.identity, w.operator(w.billing.userId))), ["AUTHENTICATION_REQUIRED", "SUBJECT_UNAUTHENTICATED"]);
  assert.deepEqual(outcome(await asOwner(w.owner.identity, w.tenant() as never)), ["AUTHENTICATION_REQUIRED", "SUBJECT_UNAUTHENTICATED"]);
  assert.deepEqual(outcome(await asOwner({ ...w.owner.identity, mfaEnrolledAt: null })), ["NOT_AUTHORIZED", "IDENTITY_UNVERIFIED"]);
  assert.deepEqual(outcome(await asOwner({ ...w.owner.identity, state: "DISABLED" })), ["NOT_AUTHORIZED", "IDENTITY_DISABLED"]);
  for (const [key, grant] of w.store().grants) w.store().grants.set(key, { ...grant, state: "REVOKED", revokedAt: w.clock.now() });
  assert.deepEqual(outcome(await asOwner()), ["NOT_AUTHORIZED", "CORPORATE_ROLE_MISSING"], "a revoked grant grants nothing");
  // an ACTIVE seller row is not an owner grant, and an owner grant is not a seller row
  assert.deepEqual(outcome(await asOwner(sellerUser.identity, w.operator(sellerUser.userId))), ["NOT_AUTHORIZED", "CORPORATE_ROLE_MISSING"]);
  assert.deepEqual(outcome(await asSeller(w.owner.identity, w.operator())), ["NOT_AUTHORIZED", "CORPORATE_ROLE_MISSING"]);

  // the services: the code-owned table decides, the environment must match
  const service = { serviceId: "commission-service", audience: "kauro-api", environment: "SANDBOX" as const };
  assert.deepEqual(authorizer.authorizeCommercialService({ identity: service, role: "COMMISSION_SERVICE", deploymentEnvironment: "SANDBOX" }), { kind: "ALLOW", serviceId: "commission-service", role: "COMMISSION_SERVICE", policyVersion: "B09-1" });
  assert.deepEqual(authorizer.authorizeCommercialService({ identity: { ...service, serviceId: "finance-service" }, role: "FINANCE_SERVICE", deploymentEnvironment: "SANDBOX" }), { kind: "ALLOW", serviceId: "finance-service", role: "FINANCE_SERVICE", policyVersion: "B09-1" });
  const asService = (serviceId: string, role: "COMMISSION_SERVICE" | "FINANCE_SERVICE", env: "LOCAL" | "SANDBOX" | "LIVE" = "SANDBOX", identityEnv: "LOCAL" | "SANDBOX" | "LIVE" = "SANDBOX") =>
    outcome(authorizer.authorizeCommercialService({ identity: { ...service, serviceId, environment: identityEnv }, role, deploymentEnvironment: env }));
  assert.deepEqual(asService("finance-service", "COMMISSION_SERVICE"), ["NOT_AUTHORIZED", "SERVICE_NOT_PERMITTED"], "the finance service cannot close a period");
  assert.deepEqual(asService("commission-service", "FINANCE_SERVICE"), ["NOT_AUTHORIZED", "SERVICE_NOT_PERMITTED"], "the commission service cannot reconcile a payout");
  assert.deepEqual(asService("payment-service", "COMMISSION_SERVICE"), ["NOT_AUTHORIZED", "SERVICE_NOT_PERMITTED"]);
  assert.deepEqual(asService("provider-ingress", "FINANCE_SERVICE"), ["NOT_AUTHORIZED", "SERVICE_NOT_PERMITTED"]);
  assert.deepEqual(asService("someone-else", "COMMISSION_SERVICE"), ["NOT_AUTHORIZED", "SERVICE_NOT_PERMITTED"]);
  assert.deepEqual(asService("constructor", "COMMISSION_SERVICE"), ["NOT_AUTHORIZED", "SERVICE_NOT_PERMITTED"]);
  assert.deepEqual(asService("commission-service", "COMMISSION_SERVICE", "LIVE"), ["NOT_AUTHORIZED", "SERVICE_ENVIRONMENT_MISMATCH"]);
  assert.deepEqual(asService("finance-service", "FINANCE_SERVICE", "SANDBOX", "LIVE"), ["NOT_AUTHORIZED", "SERVICE_ENVIRONMENT_MISMATCH"]);
});
