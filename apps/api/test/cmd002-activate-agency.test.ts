// CMD002 ActivateAgency — POST /api/v1/agencies/{agencyId}/activate — AGENCY_OWNER — scope AGENCY_PATH (package B10, mandate
// B10-AGENCY-LIFECYCLE; docs/design/B10-case-map.md CMD002-OK, CMD002-DENY, CMD002-RACE; design §4, §12; decisions D10-AGY-1, D10-CTX-1;
// registry "record versioned acceptance and activate only eligible capabilities"; "missing agreements or a mismatched billing identity
// leave the agency draft; no implicit signature"). The real route, the real authorizer, the commerce adapters and PostgreSQL 17 through
// the runtime login roles; the superuser only reads. The published agreement versions are the control plane's (B19 publishes the reviewed
// texts, R2-111), the reviewed fiscal profiles the corporate owner's, both recorded by the testing fixtures of @kauro/persistence.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AgencyActivationView } from "@kauro/application";
import type { AgencyId, FiscalIssuerRef, FiscalProfileId, UserId } from "@kauro/domain";
import { publishAgreementVersions, recordReviewedFiscalProfile, type AgencyFixture, type PublishedAgreements } from "@kauro/persistence/testing";
import { SimulatedCrash, asProblem, call, completed, freshKey, ids, outcome, replayTextOf, routes, sha, waitForApiLockWait, world, type Person, type Reply, type World } from "./support.js";
import { apiIdleInTransaction, blockersOf, disarm, readerCell, track, until, waitersOn, type CellOutcome } from "./agency-lock-cells.js";

let w: World;
let versions: PublishedAgreements;
let issuerRef: FiscalIssuerRef;
let kora: Person;

before(async () => {
  w = await world();
  // the reviewed texts: an old version of each kind, retired when the current one is published
  await publishAgreementVersions(w.h, { terms: "TERMS-2026-01", privacy: "PRIVACY-2026-01" });
  versions = await publishAgreementVersions(w.h, { terms: "TERMS-2026-10", privacy: "PRIVACY-2026-10" });
  issuerRef = await w.h.qualifiedFiscalIssuer();
  kora = await w.person("kora-cmd002-corporate-owner");
  await w.h.grantKauroOwner(kora.userId);
});
after(async () => {
  await w.stop();
});

const activateUrl = (agencyId: string): string => `/api/v1/agencies/${agencyId}/activate`;

interface Draft {
  readonly agency: AgencyFixture;
  readonly owner: Person;
  readonly billing: Person;
  readonly profileId: FiscalProfileId;
}

/** A DRAFT agency with its owner, a BILLING member and a reviewed fiscal profile recorded by the corporate owner. */
async function draftAgency(label: string): Promise<Draft> {
  const owner = await w.person(`${label}-owner`);
  const agency = await w.h.createAgency(owner.userId, `Agency ${label}`);
  const billing = await w.person(`${label}-billing`);
  await w.h.addMember(agency, billing.userId, "BILLING");
  const profileId = await recordReviewedFiscalProfile(w.h, { operatorUserId: kora.userId as UserId, agencyId: agency.agencyId, issuerRef });
  return { agency, owner, billing, profileId };
}

function activate(d: Pick<Draft, "agency" | "owner">, options: { readonly token?: string; readonly key?: string; readonly body?: Record<string, unknown>; readonly agencyId?: string } = {}) {
  return call(w, {
    url: activateUrl(options.agencyId ?? d.agency.agencyId),
    token: options.token ?? d.owner.token,
    agency: null,
    key: options.key ?? freshKey("cmd002"),
    body: options.body,
  });
}

const bodyFor = (profileId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  expectedVersion: 1,
  termsVersion: versions.terms.version,
  privacyAgreementVersion: versions.privacy.version,
  billingProfileRef: profileId,
  ...overrides,
});

const agencyRow = async (agencyId: string) =>
  (await w.h.oracle.query<{ state: string; version: string; terms_version: string | null; privacy_agreement_version: string | null; legal_profile_ref: string | null }>("SELECT state, version::text AS version, terms_version, privacy_agreement_version, legal_profile_ref FROM kauro.agencies WHERE agency_id = $1", [agencyId])).rows[0] ?? null;

test("OK: the agency's OWNER activates its DRAFT agency with the published terms and privacy versions and its current reviewed billing profile — 200 with the agency ACTIVE at the next version, one append-only acceptance naming both versions, their document hashes and the membership, agency.activated.v1, and no capability written", async () => {
  const d = await draftAgency("cmd002-ok");
  const key = freshKey("cmd002-ok");
  const capabilities = await w.h.oracle.query("SELECT capability_id, state, version FROM kauro.capabilities ORDER BY capability_id");
  const reply = completed<AgencyActivationView>(await activate(d, { key, body: bodyFor(d.profileId) }), 200);
  assert.equal(reply.version, 2);
  assert.equal(reply.replayed, false);
  assert.deepEqual([reply.data.agency.agencyId, reply.data.agency.state, reply.data.agency.version, reply.data.agency.termsVersion, reply.data.agency.privacyAgreementVersion], [d.agency.agencyId, "ACTIVE", 2, versions.terms.version, versions.privacy.version]);

  // the agency row: ACTIVE at version 2 with both versions and the reviewed billing profile as its legal profile
  assert.deepEqual(await agencyRow(d.agency.agencyId), { state: "ACTIVE", version: "2", terms_version: versions.terms.version, privacy_agreement_version: versions.privacy.version, legal_profile_ref: d.profileId });
  // exactly one acceptance, naming both published versions with their documents, the OWNER membership and its person; the answer's instant is the row's
  const acceptances = await w.h.oracle.query<{ acceptance_id: string; membership_id: string; user_id: string; terms_version: string; terms_document_hash: string; privacy_version: string; privacy_document_hash: string; accepted_at: string }>(
    `SELECT acceptance_id, membership_id, user_id, terms_version, terms_document_hash, privacy_version, privacy_document_hash,
            to_char(accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS accepted_at
       FROM kauro.agency_agreement_acceptances WHERE agency_id = $1`,
    [d.agency.agencyId],
  );
  assert.equal(acceptances.rows.length, 1);
  const acceptance = acceptances.rows[0]!;
  assert.deepEqual(
    [acceptance.membership_id, acceptance.user_id, acceptance.terms_version, acceptance.terms_document_hash, acceptance.privacy_version, acceptance.privacy_document_hash],
    [d.agency.ownerMembershipId, d.owner.userId, versions.terms.version, versions.terms.documentHash, versions.privacy.version, versions.privacy.documentHash],
  );
  assert.equal(reply.data.acceptedAt, acceptance.accepted_at);
  // agency.activated.v1 at version 2, by the owner; the unchanged capabilities offered are answered, none written
  const events = await w.events("agency", d.agency.agencyId);
  assert.deepEqual(events.map((e) => [e.version, e.type]), [[1, "agency.created.v1"], [2, "agency.activated.v1"]]);
  assert.deepEqual(await w.h.oracle.query("SELECT capability_id, state, version FROM kauro.capabilities ORDER BY capability_id").then((r) => r.rows), capabilities.rows, "no capability is written");
  const offered = await w.h.oracle.query<{ mode: string }>("SELECT DISTINCT mode FROM kauro.capabilities WHERE state IN ('AVAILABLE_LIMITED', 'AVAILABLE') ORDER BY mode");
  assert.deepEqual([...reply.data.offeredModes].sort(), offered.rows.map((r) => r.mode));
  const journal = await w.journal(key);
  assert.deepEqual([journal?.state, journal?.status, journal?.resourceKind, journal?.resourceId], ["COMMITTED", 200, "agency", d.agency.agencyId]);
  assert.equal(await w.count("commercial_authorizations", "agency_id = $1", [d.agency.agencyId]), 0, "activation creates no payment or import authority");
});

test("DENY: another agency's OWNER is a foreign tenant (404) and a BILLING member a wrong role (403 ROLE_INSUFFICIENT); then one missing prerequisite at a time — an unpublished terms version AGREEMENT_VERSION_NOT_PUBLISHED, another agency's billing profile BILLING_PROFILE_MISMATCH, an unreviewed profile FISCAL_TREATMENT_UNREVIEWED, an ACTIVE agency AGENCY_NOT_DRAFT — each leaves the agency as it was with no acceptance", async () => {
  const d = await draftAgency("cmd002-deny");
  const other = await draftAgency("cmd002-deny-other");
  /** Refuses with the outcome, leaving the agency row as it was, no acceptance, no event, no journal row and no new durable fact but the DENY facts. */
  const refused = async (what: string, request: () => Promise<ReturnType<typeof activate> extends Promise<infer R> ? R : never>, expected: string) => {
    const before = { row: await agencyRow(d.agency.agencyId), acceptances: await w.count("agency_agreement_acceptances"), events: await w.count("domain_events", "agency_id = $1", [d.agency.agencyId]), journal: await w.count("command_journal", "agency_id = $1", [d.agency.agencyId]) };
    const reply = await request();
    assert.equal(outcome(w, reply), expected, what);
    const after = { row: await agencyRow(d.agency.agencyId), acceptances: await w.count("agency_agreement_acceptances"), events: await w.count("domain_events", "agency_id = $1", [d.agency.agencyId]), journal: await w.count("command_journal", "agency_id = $1", [d.agency.agencyId]) };
    assert.deepEqual(after, before, `${what}: the agency as it was, no acceptance, event or journal entry`);
    return reply;
  };

  // a foreign tenant answers as a nonexistent agency; a BILLING member is a wrong role, recorded in the agency's own stream
  const foreign = await refused("foreign tenant", () => activate(other, { agencyId: d.agency.agencyId, body: bodyFor(d.profileId) }), "404 NOT_FOUND NOT_A_MEMBER");
  const unknown = await activate(other, { agencyId: ids.next(), body: bodyFor(d.profileId) });
  assert.equal(unknown.status, 404);
  assert.deepEqual({ ...asProblem(w, foreign), correlationId: "" }, { ...asProblem(w, unknown), correlationId: "" }, "a foreign and a nonexistent agency answer alike");
  const denials = (await w.securityEvents("CMD002")).length;
  await refused("wrong role", () => activate(d, { token: d.billing.token, body: bodyFor(d.profileId) }), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.deepEqual((await w.securityEvents("CMD002")).slice(denials).map((f) => [f.outcome, f.reason, f.agencyId]), [["DENY", "ROLE_INSUFFICIENT", d.agency.agencyId]]);

  // an unpublished terms version (never published, and a retired one) and an unpublished privacy version: no default, no implicit signature
  await refused("unknown terms version", () => activate(d, { body: bodyFor(d.profileId, { termsVersion: "TERMS-NEVER-PUBLISHED" }) }), "409 PRECONDITION_FAILED AGREEMENT_VERSION_NOT_PUBLISHED");
  await refused("retired terms version", () => activate(d, { body: bodyFor(d.profileId, { termsVersion: "TERMS-2026-01" }) }), "409 PRECONDITION_FAILED AGREEMENT_VERSION_NOT_PUBLISHED");
  await refused("retired privacy version", () => activate(d, { body: bodyFor(d.profileId, { privacyAgreementVersion: "PRIVACY-2026-01" }) }), "409 PRECONDITION_FAILED AGREEMENT_VERSION_NOT_PUBLISHED");
  // another agency's billing profile is not this agency's profile (a profile the policies hide is as unknown as one that does not exist)
  await refused("another agency's billing profile", () => activate(d, { body: bodyFor(other.profileId) }), "409 PRECONDITION_FAILED BILLING_PROFILE_MISMATCH");
  await refused("an unknown billing profile", () => activate(d, { body: bodyFor(d.agency.ownerMembershipId) }), "409 PRECONDITION_FAILED BILLING_PROFILE_MISMATCH");

  // the corporate owner withdraws the profile's treatment for review: the current version is the unreviewed one, which activation cannot rest on
  const unreviewed = await w.h.commerce.run(w.h.operator(kora.userId as UserId), async (uow) => {
    await uow.adoptFinanceScope(d.agency.agencyId as AgencyId);
    const current = await uow.commerce.fiscal.currentProfile(d.agency.agencyId as AgencyId);
    const profileId = uow.ids.next() as FiscalProfileId;
    const recordedAt = new Date().toISOString() as never;
    await uow.commerce.fiscal.recordProfile({
      profileId,
      agencyId: d.agency.agencyId as AgencyId,
      operatorLegalRef: issuerRef,
      customerLegalRef: uow.ids.next(),
      serviceClassification: "Data services",
      territory: "Colombia and abroad",
      taxTreatment: "REVIEW_REQUIRED",
      taxRule: "UNRESOLVED",
      taxRateBps: 0,
      evidenceHash: sha("cmd002-unreviewed-evidence"),
      validFrom: new Date(Date.now() - 24 * 3_600_000).toISOString() as never,
      ...(current !== null ? { supersedesProfileId: current.profileId } : {}),
      recordedAt,
    });
    return profileId;
  });
  await refused("an unreviewed profile", () => activate(d, { body: bodyFor(unreviewed) }), "409 PRECONDITION_FAILED FISCAL_TREATMENT_UNREVIEWED");
  // the earlier reviewed version is superseded: it is no longer the agency's current profile
  await refused("a superseded profile", () => activate(d, { body: bodyFor(d.profileId) }), "409 PRECONDITION_FAILED BILLING_PROFILE_MISMATCH");

  // an ACTIVE agency is not DRAFT: the same request for an agency another owner activated before is refused with the current state
  const active = await draftAgency("cmd002-deny-active");
  completed<AgencyActivationView>(await activate(active, { body: bodyFor(active.profileId) }), 200);
  const again = await activate(active, { body: bodyFor(active.profileId, { expectedVersion: 2 }) });
  assert.equal(outcome(w, again), "409 PRECONDITION_FAILED AGENCY_NOT_DRAFT");
  assert.deepEqual(asProblem(w, again).current, { version: 2, state: "ACTIVE" });
  assert.equal(await w.count("agency_agreement_acceptances", "agency_id = $1", [active.agency.agencyId]), 1, "the refused repeat recorded no second acceptance");
  assert.equal(await w.count("agency_agreement_acceptances", "agency_id = $1", [d.agency.agencyId]), 0);
});

test("RACE: an identical retry replays the 200 without a second acceptance, the same key with another billingProfileRef is 409 IDEMPOTENCY_CONFLICT, two keys racing on one expectedVersion yield one activation and one 409 STALE_VERSION with the wait observed, and a crash before COMMIT leaves the agency DRAFT with no acceptance", async () => {
  const d = await draftAgency("cmd002-race");
  const key = freshKey("cmd002-race");
  const body = bodyFor(d.profileId);
  const acceptancesOf = (agencyId: string) => w.count("agency_agreement_acceptances", "agency_id = $1", [agencyId]);

  // a crash at the intent/commit boundary: the acceptance, the agency's move and the journal entry were written and never committed
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await activate(d, { key, body });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.deepEqual(await agencyRow(d.agency.agencyId), { state: "DRAFT", version: "1", terms_version: null, privacy_agreement_version: null, legal_profile_ref: null });
  assert.equal(await acceptancesOf(d.agency.agencyId), 0);
  assert.equal(await w.journal(key), null);

  // the retry under the same key activates it once; the identical retry replays the journaled 200 byte for byte
  const first = await activate(d, { key, body });
  completed<AgencyActivationView>(first, 200);
  assert.equal(await w.count("agency_agreement_acceptances", "agency_id = $1", [d.agency.agencyId]), 1);
  const replay = await activate(d, { key, body });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.text, replayTextOf(first));
  assert.equal(await acceptancesOf(d.agency.agencyId), 1, "the replay recorded no second acceptance");

  // the same key naming another billing profile is another request: a conflict, and nothing happens
  const other = await draftAgency("cmd002-race-other");
  assert.equal(outcome(w, await activate(d, { key, body: bodyFor(other.profileId) })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal(await w.count("agency_agreement_acceptances", "agency_id = $1", [d.agency.agencyId]), 1);
  assert.equal((await agencyRow(d.agency.agencyId))?.version, "2");

  // two keys racing on one expectedVersion: A holds inside its unit of work with the agency's row written; B's journal reservation (the
  // agency's KEY SHARE) passes beside A's NO KEY row lock and B blocks on the agency's row lock (FOR NO KEY UPDATE, observed in
  // pg_stat_activity), reads the agency at version 2 after A commits and answers STALE_VERSION with the current state
  const racing = await draftAgency("cmd002-race-two");
  const hold = w.holds.arm("journal.commit");
  const requestA = activate(racing, { key: freshKey("cmd002-race-a"), body: bodyFor(racing.profileId) });
  await hold.reached;
  const requestB = activate(racing, { key: freshKey("cmd002-race-b"), body: bodyFor(racing.profileId) });
  try {
    await waitForApiLockWait(w, "FOR NO KEY UPDATE");
  } finally {
    hold.release();
  }
  const [a, b] = await Promise.all([requestA, requestB]);
  assert.equal(completed<AgencyActivationView>(a, 200).data.agency.version, 2);
  assert.equal(outcome(w, b), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, b).current, { version: 2, state: "ACTIVE" });
  assert.equal(await acceptancesOf(racing.agency.agencyId), 1, "one acceptance for one activation");
  assert.deepEqual((await w.events("agency", racing.agency.agencyId)).map((e) => e.type), ["agency.created.v1", "agency.activated.v1"]);
});


const activationAnswer = (reply: Reply): string => (reply.status < 300 ? String(reply.status) : outcome(w, reply));
const settledAnswer = (r: PromiseSettledResult<Reply>): string => (r.status === "fulfilled" ? activationAnswer(r.value) : `threw ${String(r.reason)}`);

test("RACE (D10-TX-1, 40P01) reader KEY_SHARE_THEN_SHARED, production: CreateClient (CMD009) on the DRAFT agency reserved its journal entry (the agency's KEY SHARE) and pauses before reading the agency after its shared half; ActivateAgency then locks the row FOR NO KEY UPDATE beside that KEY SHARE, writes the state (the exclusive half through the transition trigger) and reaches its commit without waiting for the client's backend; CreateClient's shared half waits for the activation's backend, the activation commits 200 and the client is created 201 in the ACTIVE agency — never a deadlock (red at 593c47f: the exclusive half first, then the row FOR UPDATE waits for the KEY SHARE while CreateClient's shared half waits for the exclusive half, 40P01)", async () => {
  const d = await draftAgency("cmd002-reserved-client");
  const reserved = w.holds.arm("journal.reserved");
  const creating = track(call(w, { url: routes.createClient(d.agency.agencyId), token: d.owner.token, agency: null, key: freshKey("cmd002-reserved-client"), body: { displayName: "Reserved Client", processingAuthorityRef: ids.next() } }));
  await reserved.reached;
  const idle = await apiIdleInTransaction(w);
  assert.equal(idle.length, 1, "only CreateClient's reserved unit of work is inside a transaction");
  const clientPid = idle[0]!;
  const commit = w.holds.arm("journal.commit");
  const committing = track(commit.reached);
  const activating = track(activate(d, { key: freshKey("cmd002-reserved-client-activation"), body: bodyFor(d.profileId) }));
  let activationWaited = false;
  let clientWaited = false;
  try {
    await until("the activation reaches its commit, or waits for CreateClient's backend", async () => committing.done() || activating.done() || (activationWaited = (await waitersOn(w, clientPid)).length > 0));
  } finally {
    reserved.release();
  }
  try {
    await until("CreateClient finishes, or its backend waits", async () => creating.done() || (clientWaited = (await blockersOf(w, clientPid)).length > 0));
  } finally {
    commit.release();
  }
  const [created, activated] = await Promise.all([creating.settled, activating.settled]);
  await disarm(w, "journal.commit", committing.done());
  assert.deepEqual(
    { activationWaitedForTheClient: activationWaited, clientWaitedForTheActivation: clientWaited, activation: settledAnswer(activated), client: settledAnswer(created) },
    { activationWaitedForTheClient: false, clientWaitedForTheActivation: true, activation: "200", client: "201" },
  );
  assert.equal((await agencyRow(d.agency.agencyId))?.state, "ACTIVE");
});

test("RACE (D10-TX-1, 40P01) lock-order matrix: ActivateAgency against a reader of the DRAFT agency in both orders (SHARED_THEN_KEY_SHARE — no DRAFT reader of production has this order today, the cell guards one; KEY_SHARE_THEN_SHARED — CMD009, CMD011) and both interleavings (the activation first, holding the row and the exclusive half at its commit; the reader first, holding its first lock) — every cell completes: the activation 200, the reader's statements succeed, and who waited for whom (by backend pid) is the NO KEY row lock's (red at c9f7f95 in the SHARED_THEN_KEY_SHARE reader-first cell and at 593c47f in the KEY_SHARE_THEN_SHARED reader-first cell, 40P01)", async () => {
  const cells: Record<string, CellOutcome> = {};
  const states: Array<string | undefined> = [];
  for (const shape of ["SHARED_THEN_KEY_SHARE", "KEY_SHARE_THEN_SHARED"] as const) {
    for (const first of ["WRITER_FIRST", "READER_FIRST"] as const) {
      const d = await draftAgency(`cmd002-cell-${shape}-${first}`);
      cells[`${shape} ${first}`] = await readerCell(w, { agency: d.agency, start: () => activate(d, { key: freshKey(`cmd002-cell-${shape}-${first}`), body: bodyFor(d.profileId) }), rowHold: "journal.commit" }, shape, first, activationAnswer);
      states.push((await agencyRow(d.agency.agencyId))?.state);
    }
  }
  assert.deepEqual(cells, {
    // the activation holds the row and the exclusive half at its commit: the reader's shared half waits for it, its insert passes
    "SHARED_THEN_KEY_SHARE WRITER_FIRST": { writer: "200", reader: "OK", readerWaited: true, writerWaited: false },
    // the activation's state change (the exclusive half) waits for the reader's shared half; the reader's insert passes beside the row
    "SHARED_THEN_KEY_SHARE READER_FIRST": { writer: "200", reader: "OK", readerWaited: false, writerWaited: true },
    "KEY_SHARE_THEN_SHARED WRITER_FIRST": { writer: "200", reader: "OK", readerWaited: true, writerWaited: false },
    // the activation passes beside the reader's KEY SHARE to its commit; the reader's shared half waits for it
    "KEY_SHARE_THEN_SHARED READER_FIRST": { writer: "200", reader: "OK", readerWaited: true, writerWaited: false },
  });
  assert.deepEqual(states, ["ACTIVE", "ACTIVE", "ACTIVE", "ACTIVE"]);
});
