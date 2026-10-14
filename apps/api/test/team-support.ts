// Shared fixtures of the team-command tests (CMD003-CMD007): an invitation through the real route, and an invitation planted through
// the ports with a chosen token and deadline (the only way to hold an invitation at a deadline: its columns are immutable).
import type { InviteMemberView } from "@kauro/application";
import { hashInvitationToken, mintInvitationToken, toUtcInstant, type CausationId, type InvitationId, type MembershipId, type MembershipRole } from "@kauro/domain";
import { randomBytes } from "node:crypto";
import { call, completed, deliveredInvitations, outcome, routes, type Person, type Reply, type World } from "./support.js";

export interface Invited {
  readonly person: Person;
  readonly invitationId: string;
  readonly membershipId: string;
  readonly token: string;
}

export type Issued = InviteMemberView;

/** The raw token the delivery channel received for an invitation. */
export function tokenOf(invitationId: string): string {
  const token = deliveredInvitations.get(invitationId);
  if (token === undefined || token === "") throw new Error(`no token was delivered for invitation ${invitationId}`);
  return token;
}

export async function agencyVersion(w: World, agencyId: string = w.A.agencyId): Promise<number> {
  return Number((await w.row<{ version: string }>("agencies", "agency_id = $1", [agencyId]))?.version);
}

/** A new person invited to agency A through CMD003 by the owner. */
export async function invitePerson(w: World, name: string, role: MembershipRole = "OPERATOR"): Promise<Invited> {
  const person = await w.person(name);
  const reply = await call(w, { url: routes.inviteMember(w.A.agencyId), body: { expectedVersion: await agencyVersion(w), intendedIdentityRef: person.userId, role } });
  const done = completed<Issued>(reply, 201);
  return { person, invitationId: done.data.invitationId, membershipId: done.data.membershipId, token: tokenOf(done.data.invitationId) };
}

/** A new person with an ACTIVE membership of agency A in `role`. */
export async function activePerson(w: World, name: string, role: MembershipRole): Promise<{ person: Person; membershipId: string }> {
  const person = await w.person(name);
  const membershipId = await w.h.addMember(w.A, person.userId, role);
  return { person, membershipId };
}

/** An INVITED membership with an open invitation whose deadline is `lifetimeMs` after the database's now, written through the ports. */
export async function plantInvitation(w: World, name: string, lifetimeMs: number, role: MembershipRole = "OPERATOR"): Promise<Invited> {
  const person = await w.person(name);
  const token = mintInvitationToken((n) => new Uint8Array(randomBytes(n)));
  const now = (await w.h.oracle.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
  const created = toUtcInstant(now.getTime());
  const { membershipId, invitationId } = await w.h.app.run(w.h.tenant(w.A.agencyId, w.owner.userId), async (uow) => {
    const id = uow.ids.next() as MembershipId;
    const inv = uow.ids.next() as InvitationId;
    await uow.memberships.insert({ membershipId: id, agencyId: w.A.agencyId, userId: person.userId, role, state: "INVITED", assurancePolicy: "MFA_REQUIRED", createdAt: created });
    await uow.events.publish({ aggregateKind: "membership", aggregateId: id, aggregateVersion: 1, agencyId: w.A.agencyId, eventType: "membership.invited.v1", actor: { kind: "USER", userId: w.owner.userId }, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { membershipId: id, agencyId: w.A.agencyId, role, invitedByMembershipId: w.A.ownerMembershipId } });
    const issued = await uow.invitations.insert({ invitationId: inv, agencyId: w.A.agencyId, membershipId: id, tokenHash: hashInvitationToken(token), role, invitedByMembershipId: w.A.ownerMembershipId, expiresAt: toUtcInstant(now.getTime() + lifetimeMs), createdAt: created });
    if (issued.kind !== "ISSUED") throw new Error("planted invitation not issued");
    return { membershipId: id, invitationId: inv };
  });
  return { person, invitationId, membershipId, token };
}

/** Suspends a membership through the ports (a SUSPENDED member: there is no served command for it in B16), with its event. */
export async function suspendMember(w: World, membershipId: string, agency: { readonly agencyId: string; readonly ownerUserId: string; readonly ownerMembershipId: string } = { agencyId: w.A.agencyId, ownerUserId: w.owner.userId, ownerMembershipId: w.A.ownerMembershipId }): Promise<void> {
  await w.h.app.run(w.h.tenant(agency.agencyId as never, agency.ownerUserId as never), async (uow) => {
    const m = await uow.memberships.lock(membershipId as MembershipId);
    if (!m) throw new Error("the member to suspend is not visible");
    const written = await uow.memberships.transition(m.membershipId, m.version, { state: "SUSPENDED" }, toUtcInstant(Date.now()));
    if (written.kind !== "APPLIED") throw new Error("suspension fixture did not apply");
    await uow.events.publish({ aggregateKind: "membership", aggregateId: membershipId, aggregateVersion: written.record.version, agencyId: agency.agencyId as never, eventType: "membership.suspended.v1", actor: { kind: "USER", userId: agency.ownerUserId as never }, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { membershipId, agencyId: agency.agencyId, byMembershipId: agency.ownerMembershipId } });
  });
}

/** `${status} ${code} ${reason}` of a refusal, or the whole reply when the call unexpectedly succeeded (a failing assertion then shows it). */
export function refusalOf(w: World, reply: Reply): string {
  return reply.status < 400 ? `UNEXPECTED SUCCESS ${reply.status} ${reply.text}` : outcome(w, reply);
}
