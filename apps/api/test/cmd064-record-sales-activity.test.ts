/**
 * CMD064 RecordSalesActivity (lane L-ACT; plan docs/design/B12-outreach-plan.md §1 CMD064-OK / CMD064-DENY / CMD064-RACE, §M M17-M29, M44, GAP-AC-*).
 * The kind-shape rules (a pure function) run here; every cell that needs PostgreSQL 17 under the real roles, the dispatcher or a race at a write is
 * `todo` with its reason: the sprint packet of 2026-10-14 forbids test runs, so the cells are written at batch verification on outreach-support.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkActivityShape } from "@kauro/application";
import { DomainFailure } from "@kauro/domain";

const base = { prospectId: "0190aaaa-bbbb-7ccc-8ddd-eeeeffff0010", draftId: "0190aaaa-bbbb-7ccc-8ddd-eeeeffff0011", occurredAt: "2026-10-14T12:00:00.000Z", evidenceHash: "a".repeat(64) };
// the closed schema types are narrower than this record; the checker reads only the members it names
const shape = (a: Record<string, unknown>, owner = false): void => checkActivityShape({ ...base, ...a } as never, owner);
const refused = (a: Record<string, unknown>, owner = false): void => assert.throws(() => shape(a, owner), (e: unknown) => e instanceof DomainFailure && e.code === "INVALID_REQUEST");

test("CMD064-DENY (shape): each kind needs its own members and refuses the others", () => {
  shape({ kind: "REPLIED", providerMessageRef: "inbound-1" });
  shape({ kind: "BOUNCED", providerMessageRef: "dsn-1" });
  shape({ kind: "HUMAN_SEND_OBSERVED", providerMessageRef: "NONE", observation: "SENT" });
  shape({ kind: "SUPPRESSED", providerMessageRef: "NONE", suppressionKeyKind: "CONTACT", suppressionReason: "OPT_OUT" });
  refused({ kind: "REPLIED", providerMessageRef: "NONE" });
  refused({ kind: "REPLIED", providerMessageRef: "x", draftId: undefined });
  refused({ kind: "BOUNCED", providerMessageRef: "x", suppressionReason: "OPT_OUT" });
  refused({ kind: "HUMAN_SEND_OBSERVED", providerMessageRef: "NONE" });
  refused({ kind: "SUPPRESSED", providerMessageRef: "x", suppressionKeyKind: "CONTACT", suppressionReason: "OPT_OUT" });
  refused({ kind: "SUPPRESSED", providerMessageRef: "NONE", suppressionKeyKind: "CONTACT" });
  refused({ kind: "SUPPRESSED", providerMessageRef: "NONE", suppressionKeyKind: "CONTACT", suppressionReason: "COMPLAINT", draftId: undefined });
});

test("CMD064-DENY (organization key): only the corporate owner may suppress an ORGANIZATION key", () => {
  const org = { kind: "SUPPRESSED", providerMessageRef: "NONE", suppressionKeyKind: "ORGANIZATION", suppressionReason: "REFUSAL" };
  refused(org, false);
  shape(org, true);
});

const PG = "needs PostgreSQL 17 under the real roles and outreach-support.ts; sprint packet forbids runs: write at batch verification";
const cells: ReadonlyArray<string> = [
  "CMD064-OK (REPLIED alone): the seller records REPLIED with an inbound ref on an accepted intent: one activity, draft REPLIED, the queued follow-up NOT_SENT(CADENCE_CLOSED) at the next dispatcher pass with zero calls (draft back to DRAFT), a new FOLLOW_UP CMD063 409, metrics accepted 1 replied 1 bounced 0 acceptedLessKnownBounces 1",
  "CMD064-OK (BOUNCED alone): draft BOUNCED, the queued follow-up NOT_SENT(CADENCE_CLOSED) at the next pass, new FOLLOW_UP 409, the person paused (KC034), metrics accepted 1 bounced 1 acceptedLessKnownBounces 0",
  "CMD064-OK (SUPPRESSED opt-out alone): contact suppressed, prospect SUPPRESSED, the queued follow-up NOT_SENT(SUPPRESSED) at the next pass with zero calls, CMD061 and CMD063 409 PROSPECT_SUPPRESSED",
  "CMD064-OK (complaint alone): SUPPRESSED reason COMPLAINT suppresses the contact and pauses the person",
  "CMD064-OK (disqualification alone): SUPPRESSED reason DISQUALIFIED stops the sequence and refuses a new sequence after 90 days",
  "CMD064-OK (complaint after opt-out): the contact already suppressed by the public opt-out, a COMPLAINT is recorded as a second SUPPRESSED activity, one suppression row stays (first reason kept), the prospect is not re-transitioned, the person is paused (KC034)",
  "CMD064-OK (organization after contact): the owner's ORGANIZATION suppression of a prospect whose contact is suppressed adds an ORGANIZATION row and an activity, prospect unchanged",
  "CMD064-DENY: a seller of another prospect is 404, a TERMINATED seller 403, REPLIED on a DRAFT, REPLIED whose ref is an outbound provider id, a DELIVERED kind, PROVIDER_ACCEPTED or SEND_UNCERTAIN by a person, a second activity of one dedup identity under another key (per kind), HUMAN_SEND_OBSERVED NOT_SENT before uncertain_after or after an accepted answer was recorded (KC036), an activity dated after the database instant; nothing counts twice",
  "CMD064-RACE: identical retry replays one activity, same key other kind is 409, crash before COMMIT nothing and after COMMIT one activity",
  "CMD064-RACE (REPLIED x claim) M17: REPLIED against the dispatcher claim of the queued follow-up held at L3 in both orders",
  "CMD064-RACE (BOUNCED x claim) M18: BOUNCED of P1 against the claim of the same person's intent on P2 held at L4: NOT_SENT(PAUSED) with zero calls or one call then paused",
  "CMD064-RACE (two observations) M29: HUMAN SENT against HUMAN NOT_SENT of one intent held at L10: the first's state stands, the other 409",
  "CMD064-RACE M28 (GAP-AC-5): HUMAN NOT_SENT against a late ACCEPTED answer of one intent held at L10",
  "CMD064-RACE M44 (GAP-AC-7): SUPPRESSED OPT_OUT of contact K against the claim of another person's intent to K on another prospect held at L8",
  "GAP-AC-1 (lock order): every CMD064 kind takes its serializer set in the global order; red with an order swapped",
  "GAP-AC-2 RACE: CMD050 held at L1 in both orders",
  "GAP-AC-3 PARTIAL: failure at the prospect SUPPRESSED update rolls back the suppression row and the activity",
  "GAP-AC-4 TIMEOUT: runtime 503 at L3",
  "GAP-AC-5b: after the evidence path the person 24 h count, the grant reserved, the 14-day anchor and the accepted metric include the evidenced send",
  "GAP-AC-6 EXPIRY (observed not sent): held at L10 X across uncertain_after; microsecond boundary",
  "GAP-AC-7: see M44",
  "GAP-SUP-1 RACE (suppression) M25: the owner's ORGANIZATION SUPPRESSED against seller B's CMD045 of the organization held at L8 in both orders",
  "GAP-DG-1 RACE: RecordOutreachDiagnosis against CMD063 of the paused person held at L4",
  "GAP-DG-2: RecordOutreachDiagnosis needs the owner step-up and a person who has sent",
];
for (const title of cells) test(title, { todo: PG }, () => {});
