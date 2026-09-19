// Agency aggregate (07 "Agency and membership states"; registry machine Agency; reference/TRANSITIONS "Acceptance must cover
// every listed edge, each material guard failing independently, a stale-version race"). Oracle: the vendored registry — every
// listed (from, event) pair must succeed through the aggregate and every unlisted pair must be refused as UNLISTED_TRANSITION.
import assert from "node:assert/strict";
import { test } from "node:test";
import { STATE_MACHINES } from "@kauro/contracts";
import {
  type AgencyId,
  type AgencyOutcome,
  type AgencyRecord,
  EVENT_PAYLOAD_ALLOWLIST,
  abandonSetup,
  activateAgency,
  assertAgencyActive,
  assertAgencyOpen,
  completeClosure,
  createAgency,
  eventsOf,
  isAgencyOpen,
  isUnderClosureAuthority,
  remedyRestriction,
  requestClosure,
  restrictAgency,
  statesOf,
} from "../src/index.js";
import { NOW, activeAgency, agency, at, id, refused, users } from "./fixtures.js";

const REQUIRED = { termsVersion: "TERMS-2026-01", privacyAgreementVersion: "DPA-2026-01" };

/** One aggregate operation per registry event; the test refuses to know any event the registry does not list. */
const OPERATIONS: Readonly<Record<string, (a: AgencyRecord) => AgencyOutcome>> = {
  agreements_and_profile_accepted: (a) => activateAgency(a, { expectedVersion: a.version, ...REQUIRED, legalProfileRef: id(), required: REQUIRED, now: at(1000) }),
  material_risk_or_account_failure: (a) => restrictAgency(a, { expectedVersion: a.version, incidentId: id(), now: at(1000) }),
  restriction_remedied: (a) => remedyRestriction(a, { expectedVersion: a.version, incidentId: id(), now: at(1000) }),
  owner_requests_closure: (a) => requestClosure(a, { expectedVersion: a.version, now: at(1000) }),
  owner_abandons_setup: (a) => abandonSetup(a, { expectedVersion: a.version, now: at(1000) }),
  closure_obligations_completed: (a) => completeClosure(a, { expectedVersion: a.version, now: at(1000) }),
};

const EVENT_OF: Readonly<Record<string, string>> = {
  agreements_and_profile_accepted: "agency.activated.v1",
  material_risk_or_account_failure: "agency.restricted.v1",
  restriction_remedied: "agency.restriction_remedied.v1",
  owner_requests_closure: "agency.closing.v1",
  owner_abandons_setup: "agency.closing.v1",
  closure_obligations_completed: "agency.closed.v1",
};

function inState(state: AgencyRecord["state"], version = 3): AgencyRecord {
  return state === "DRAFT" ? agency({ version }) : activeAgency({ state, version });
}

test("CMD001: createAgency yields one DRAFT agency at version 1 with agency.created.v1 and no activation, contract or billing", () => {
  const agencyId = id() as AgencyId;
  const { agency: a, event } = createAgency({ agencyId, displayName: "Acme Agency", createdByUserId: users.owner, now: NOW });
  assert.equal(a.state, "DRAFT");
  assert.equal(a.version, 1);
  assert.equal(a.createdByUserId, users.owner);
  assert.equal(a.termsVersion, undefined);
  assert.equal(a.privacyAgreementVersion, undefined);
  assert.equal(a.legalProfileRef, undefined);
  assert.equal(event.eventType, "agency.created.v1");
  assert.equal(event.aggregateVersion, 1);
  assert.equal(event.aggregateId, agencyId);
  assert.deepEqual(event.payload, { agencyId, createdByUserId: users.owner, state: "DRAFT" });
  assert.ok(Object.isFrozen(a));
  // the label is never in the event (07: payloads carry references and safe counts, never labels)
  assert.ok(!JSON.stringify(event).includes("Acme"));
});

test("createAgency refuses a display name that is not a safe label and never echoes the value", () => {
  for (const bad of ["", "a".repeat(201), "line\nbreak", "tab\there"]) {
    const f = refused(() => createAgency({ agencyId: id() as AgencyId, displayName: bad, createdByUserId: users.owner, now: NOW }), "INVALID_REQUEST");
    assert.deepEqual(f.details.fields, [{ field: "displayName", code: "FORMAT" }]);
    assert.ok(!f.message.includes(bad) || bad.length === 0);
  }
  const typed = refused(() => createAgency({ agencyId: id() as AgencyId, displayName: 42 as unknown as string, createdByUserId: users.owner, now: NOW }), "INVALID_REQUEST");
  assert.deepEqual(typed.details.fields, [{ field: "displayName", code: "TYPE" }]);
  // two agencies may share a label: the name is not a unique legal identity (contract Agency)
  const one = createAgency({ agencyId: id() as AgencyId, displayName: "Same", createdByUserId: users.owner, now: NOW }).agency;
  const two = createAgency({ agencyId: id() as AgencyId, displayName: "Same", createdByUserId: users.second, now: NOW }).agency;
  assert.notEqual(one.agencyId, two.agencyId);
});

test("every listed edge of the registry Agency machine is performed by exactly one aggregate operation", () => {
  const m = STATE_MACHINES.find((x) => x.contract === "Agency");
  assert.ok(m);
  assert.deepEqual([...eventsOf("Agency")].sort(), Object.keys(OPERATIONS).sort(), "the aggregate covers exactly the registry events");
  for (const edge of m.transitions) {
    const before = inState(edge.from as AgencyRecord["state"]);
    const op = OPERATIONS[edge.event];
    assert.ok(op, edge.event);
    const { agency: after, event } = op(before);
    assert.equal(after.state, edge.to, `${edge.from} --${edge.event}--> ${edge.to}`);
    assert.equal(after.version, before.version + 1, "exactly one version per transition (D-VER-1)");
    assert.equal(after.agencyId, before.agencyId);
    assert.equal(after.createdAt, before.createdAt);
    assert.equal(after.updatedAt, at(1000));
    assert.equal(event.aggregateKind, "agency");
    assert.equal(event.aggregateVersion, after.version);
    assert.equal(event.eventType, EVENT_OF[edge.event]);
    for (const key of Object.keys(event.payload)) assert.ok(EVENT_PAYLOAD_ALLOWLIST[event.eventType].includes(key), `${event.eventType}.${key}`);
    assert.ok(Object.isFrozen(after));
    assert.ok(Object.isFrozen(event.payload));
  }
});

test("every unlisted (state, event) pair of the Agency machine is refused as PRECONDITION_FAILED / UNLISTED_TRANSITION with no change", () => {
  const m = STATE_MACHINES.find((x) => x.contract === "Agency");
  assert.ok(m);
  let refusedPairs = 0;
  for (const state of statesOf("Agency")) {
    for (const event of eventsOf("Agency")) {
      if (m.transitions.some((t) => t.from === state && t.event === event)) continue;
      const before = inState(state as AgencyRecord["state"]);
      const snapshot = JSON.stringify(before);
      const f = refused(() => (OPERATIONS[event] as (a: AgencyRecord) => AgencyOutcome)(before), "PRECONDITION_FAILED", "UNLISTED_TRANSITION");
      assert.equal(f.details.currentState, state);
      assert.equal(JSON.stringify(before), snapshot, "a refused transition mutates nothing");
      refusedPairs += 1;
    }
  }
  const listed = m.transitions.length;
  assert.equal(refusedPairs, statesOf("Agency").length * eventsOf("Agency").length - listed);
  assert.equal(listed, 7);
  // the terminal state has no exit at all
  for (const event of eventsOf("Agency")) refused(() => (OPERATIONS[event] as (a: AgencyRecord) => AgencyOutcome)(inState("CLOSED")), "PRECONDITION_FAILED", "UNLISTED_TRANSITION");
});

test("a stale expectedVersion is STALE_VERSION carrying the current safe version and state, before any guard runs", () => {
  const a = activeAgency({ version: 4 });
  const f = refused(() => requestClosure(a, { expectedVersion: 3, now: NOW }), "STALE_VERSION");
  assert.equal(f.details.currentVersion, 4);
  assert.equal(f.details.currentState, "ACTIVE");
  assert.equal(f.status, 409);
  // an unlisted edge with a stale version is still reported as stale first (the UI must reload before it can reason)
  const closed = activeAgency({ state: "CLOSED", version: 9 });
  refused(() => requestClosure(closed, { expectedVersion: 1, now: NOW }), "STALE_VERSION");
  for (const bad of [0, -1, 1.5, Number.NaN]) refused(() => requestClosure(a, { expectedVersion: bad, now: NOW }), "INVALID_REQUEST");
});

test("activation guard: legal profile and the required agreement versions must be present; nothing else is activated", () => {
  const draft = agency();
  const base = { expectedVersion: 1, termsVersion: REQUIRED.termsVersion, privacyAgreementVersion: REQUIRED.privacyAgreementVersion, legalProfileRef: id(), required: REQUIRED, now: NOW };
  const ok = activateAgency(draft, base);
  assert.equal(ok.agency.state, "ACTIVE");
  assert.equal(ok.agency.termsVersion, REQUIRED.termsVersion);
  assert.equal(ok.agency.privacyAgreementVersion, REQUIRED.privacyAgreementVersion);
  assert.equal(ok.agency.legalProfileRef, base.legalProfileRef);
  assert.equal(ok.agency.firstQualifyingCaptureId, undefined, "activation creates no first-project designation");

  const stale = refused(() => activateAgency(draft, { ...base, termsVersion: "TERMS-2025-09" }), "PRECONDITION_FAILED", "AGREEMENTS_INCOMPLETE");
  assert.equal(stale.details.currentState, "DRAFT");
  refused(() => activateAgency(draft, { ...base, privacyAgreementVersion: "DPA-2025-09" }), "PRECONDITION_FAILED", "AGREEMENTS_INCOMPLETE");
  const noProfile = refused(() => activateAgency(draft, { ...base, legalProfileRef: "not-an-id" }), "INVALID_REQUEST");
  assert.deepEqual(noProfile.details.fields, [{ field: "legalProfileRef", code: "FORMAT" }]);
  const emptyTerms = refused(() => activateAgency(draft, { ...base, termsVersion: "" }), "INVALID_REQUEST");
  assert.deepEqual(emptyTerms.details.fields, [{ field: "termsVersion", code: "FORMAT" }]);
});

test("restriction and remedy name the documented incident; closure edges carry no extra facts", () => {
  const active = activeAgency();
  const restricted = restrictAgency(active, { expectedVersion: active.version, incidentId: id(), now: NOW });
  assert.equal(restricted.agency.state, "RESTRICTED");
  assert.equal(typeof restricted.event.payload["incidentId"], "string");
  const noIncident = refused(() => restrictAgency(active, { expectedVersion: active.version, incidentId: "incident-1", now: NOW }), "INVALID_REQUEST");
  assert.deepEqual(noIncident.details.fields, [{ field: "incidentId", code: "FORMAT" }]);
  const remedied = remedyRestriction(restricted.agency, { expectedVersion: restricted.agency.version, incidentId: id(), now: NOW });
  assert.equal(remedied.agency.state, "ACTIVE");
  assert.equal(remedied.agency.termsVersion, active.termsVersion, "remedy restores state, not agreements");
  const closing = requestClosure(remedied.agency, { expectedVersion: remedied.agency.version, now: NOW });
  assert.deepEqual(Object.keys(closing.event.payload), ["agencyId"]);
  const closed = completeClosure(closing.agency, { expectedVersion: closing.agency.version, now: NOW });
  assert.equal(closed.agency.state, "CLOSED");
  assert.equal(closed.agency.version, active.version + 4);
});

test("open, active and closure-authority predicates (D-CMD-2; 07 DRAFT permits setup only; R2-043 closure authority)", () => {
  const draft = agency();
  const active = activeAgency();
  const restricted = activeAgency({ state: "RESTRICTED" });
  const closing = activeAgency({ state: "CLOSING" });
  const closed = activeAgency({ state: "CLOSED" });
  assert.ok(isAgencyOpen(draft) && isAgencyOpen(active));
  assert.ok(!isAgencyOpen(restricted) && !isAgencyOpen(closing) && !isAgencyOpen(closed));
  assert.equal(assertAgencyOpen(draft), draft);
  for (const a of [restricted, closing, closed]) {
    const f = refused(() => assertAgencyOpen(a), "PRECONDITION_FAILED", "AGENCY_NOT_OPEN");
    assert.equal(f.details.currentState, a.state);
    assert.equal(f.details.currentVersion, a.version);
  }
  assert.equal(assertAgencyActive(active), active);
  for (const a of [draft, restricted, closing, closed]) refused(() => assertAgencyActive(a), "PRECONDITION_FAILED", "AGENCY_NOT_ACTIVE");
  assert.ok(isUnderClosureAuthority(closing) && isUnderClosureAuthority(closed));
  assert.ok(!isUnderClosureAuthority(draft) && !isUnderClosureAuthority(active) && !isUnderClosureAuthority(restricted));
});
