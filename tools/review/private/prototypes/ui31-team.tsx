"use client";
// UI31 Team (registry: "Give each person only the access they need."). Reads ListMembers → TeamMemberView: role, membership state, version,
// whether the row is the reader, and dates. The api names no other person (no name, no address, no assurance detail). People are shown here
// by name, marked once as proposed (the api would need to return them to the team's managers: D-UI31-2); the "as the contract allows today"
// state shows the page with the membership reference only. What a reader sees follows the api: an owner or admin (MANAGE_TEAM) sees every
// membership with its lifecycle; anyone else sees the active team's roles only.
// Commands: invite (CMD003, owner or admin; an admin never grants owner), change a role (CMD005, owner, fresh step-up), revoke (CMD006,
// owner or admin; an admin never acts on an owner), transfer ownership (CMD007, owner, fresh step-up). The last owner is protected.
// Recovery (the owner's decision of 2026-10-20, proposed, F-07): an owner or admin may START a member's recovery when the member has lost
// their authenticator and recovery codes; they can never turn two-step verification off or let anyone in. Kauro checks the member's identity
// independently, the admin confirms with a fresh code, the member and every owner are told, a waiting period applies, and the member's
// sessions end when the recovery completes.
//
// Round 2 (2026-10-21; research agency-workspace.md §5.20, app-shell-settings.md §9.11): the two facts that drive every other page sit above
// the table (who approves plans, who handles quotes and payments), with a way to invite when nobody holds the role; each role reads as Can
// and Cannot (Stripe), from the code (roles.ts), not from a sentence; a role that cannot invite or change roles sees one line naming who can;
// a row's menu closes on a click outside it and on Escape (listening to click, never closing a <details> inside pointerdown).
import { Banner, Button, ConfirmDialog, ErrorSummary, Field } from "@kauro/ui";
import { type FormEvent, type ReactElement, useEffect, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import { StepUpPanel } from "@web/screens/shared/step-up.tsx";
import { COMPANY_ID } from "../lib/contexts.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, day, ROLE_NAME, ROLE_SCOPE, type Role } from "./kit.tsx";
import { onlyLine } from "./people.ts";

export const UI31_STATES: readonly StateDef[] = [
  { key: "normal", label: "Team", note: "The team as an owner sees it: who has which access, and what each role allows." },
  { key: "invite", label: "Invite someone", note: "The invitation form; choosing a role says what it allows. An invitation lasts seven days and is used once." },
  { key: "invite-invalid", label: "Invitation not valid", note: "Validation of the invitation, next to each field and in a summary." },
  { key: "invited", label: "Invitation created", note: "Done: the invitation exists with its expiry; the link is sent once and never shown again." },
  { key: "change-role", label: "Change a role", note: "An owner changes a member's role; Kauro asks the owner to confirm their identity first." },
  { key: "step-up", label: "Identity confirmation needed", note: "A sensitive change waits for a fresh confirmation of identity; the form stays as it was." },
  { key: "revoke", label: "Remove access", note: "The confirmation for removing a member: what happens, acknowledged before it is done." },
  { key: "last-owner", label: "Last owner protected", note: "Removing or demoting the only owner is refused, with what to do instead." },
  { key: "transfer", label: "Transfer ownership", note: "Ownership moves to an active member after a fresh identity confirmation; the previous owner stays as admin." },
  { key: "recovery", label: "Start a member's recovery", note: "Proposed: an admin starts the recovery of a member who lost their app and codes; Kauro checks identity; nobody turns two-step verification off." },
  { key: "only-you", label: "Only you", note: "A team of one: the page invites the next person." },
  { key: "contract", label: "As the contract allows today", note: "Without the proposed names: each person is shown by the end of their membership reference." },
  { key: "loading", label: "Loading", note: "The team has not arrived: the place is held and announced." },
  { key: "error", label: "Could not load", note: "The team could not be read: try again; nothing else is shown." },
];

interface Member {
  readonly ref: string;
  readonly role: Role;
  readonly state: "ACTIVE" | "INVITED" | "SUSPENDED";
  readonly self?: boolean;
  readonly since: string;
  readonly name: string;
  readonly email: string;
}

const TEAM: readonly Member[] = [
  { ref: "7a01", role: "OWNER", state: "ACTIVE", self: true, since: "2026-09-02T14:25:00Z", name: "Lena Ortiz", email: "lena.ortiz@northwind.example" },
  { ref: "5fb5", role: "ADMIN", state: "ACTIVE", since: "2026-09-04T09:10:00Z", name: "Marco Bianchi", email: "marco.bianchi@northwind.example" },
  { ref: "3c9e", role: "OPERATOR", state: "ACTIVE", since: "2026-09-14T10:00:00Z", name: "Priya Nair", email: "priya.nair@northwind.example" },
  { ref: "8d27", role: "APPROVER", state: "ACTIVE", since: "2026-09-21T16:30:00Z", name: "Samuel Osei", email: "samuel.osei@northwind.example" },
  { ref: "41b0", role: "BILLING", state: "ACTIVE", since: "2026-10-01T08:45:00Z", name: "Ines Duarte", email: "ines.duarte@northwind.example" },
  { ref: "c3d8", role: "VIEWER", state: "ACTIVE", since: "2026-10-06T12:00:00Z", name: "Ruth Okafor", email: "ruth.okafor@northwind.example" },
  { ref: "e6f2", role: "OPERATOR", state: "INVITED", since: "2026-10-18T11:20:00Z", name: "Invitation sent", email: "a.kowalski@northwind.example" },
  { ref: "92ad", role: "VIEWER", state: "SUSPENDED", since: "2026-09-10T13:00:00Z", name: "Tom Lindqvist", email: "tom.lindqvist@northwind.example" },
];

/** A company buying for itself, run by its owner alone (people.ts). */
const COMPANY_TEAM: readonly Member[] = [{ ref: "b201", role: "OWNER", state: "ACTIVE", self: true, since: "2026-09-20T10:05:00Z", name: "Tomas Reyes", email: "tomas.reyes@halden.example" }];

/** What each role can and cannot do, from the code (packages/domain/src/model/roles.ts and the commands' roles), in the words a member reads. */
const CAN: Readonly<Record<Role, { readonly can: string; readonly cannot: string }>> = {
  OWNER: { can: "Everything: the team and roles, ownership, clients, projects, approving plans, quotes and payments, deletion, the name and logo, closing the workspace.", cannot: "Leave while they are the only owner." },
  ADMIN: { can: "Invite and remove members (never an owner), clients, all project work, deletion requests, the name and logo.", cannot: "Approve plans, request quotes or pay, change roles, close the workspace." },
  OPERATOR: { can: "Add clients; upload and seal files, start the free check, make plan decisions, start the preparation, return import results.", cannot: "Approve plans, pay, manage the team, delete data." },
  APPROVER: { can: "Confirm the destination, approve or withdraw a plan, continue a staged import.", cannot: "Do the project work, pay, manage the team." },
  BILLING: { can: "Request quotes, create payment orders, ask for refunds.", cannot: "Do the project work, approve plans, manage the team." },
  VIEWER: { can: "Read every project, quote and payment; download delivered packages; open support cases.", cannot: "Change anything." },
};

const STATE_LABEL = { ACTIVE: "Active", INVITED: "Invited", SUSPENDED: "Suspended" } as const;
const STATE_TONE = { ACTIVE: "success", INVITED: "info", SUSPENDED: "danger" } as const;
const INVITE_ROLES: readonly Role[] = ["ADMIN", "OPERATOR", "APPROVER", "BILLING", "VIEWER"];
const ALL_ROLES: readonly Role[] = ["OWNER", "ADMIN", "OPERATOR", "APPROVER", "BILLING", "VIEWER"];

export function Team({ ctx, state }: PrototypeProps): ReactElement {
  const actions = ctx.agency?.permittedActions ?? [];
  const manages = actions.includes("MANAGE_TEAM");
  const owner = actions.includes("MANAGE_AGENCY");
  const contract = state === "contract";
  const workspace = ctx.agency?.displayName ?? "Northwind Data";
  const [panel, setPanel] = useState<string>(state);
  const [subject, setSubject] = useState<Member>(TEAM[2] as Member);
  const [inviteRole, setInviteRole] = useState<Role | "">(state === "invite-invalid" ? "" : "OPERATOR");
  const [errors, setErrors] = useState<readonly { fieldId: string; message: string }[]>(
    state === "invite-invalid"
      ? [
          { fieldId: "invite-who", message: "Enter an email address in the correct format, like name@example.com" },
          { fieldId: "invite-role", message: "Choose the role this person needs" },
        ]
      : [],
  );
  // the reader's own row follows who is reading
  const company = ctx.agency?.agencyId === COMPANY_ID;
  const me = ({ admin: "5fb5", operator: "3c9e", approver: "8d27", billing: "41b0", viewer: "c3d8" } as Readonly<Record<string, string>>)[ctx.key] ?? (company ? "b201" : "7a01");
  const everyone = (company ? COMPANY_TEAM : TEAM).map((member) => ({ ...member, self: member.ref === me }));
  useCloseMenusOnOutsideClick();
  const team = state === "only-you" || company ? everyone.filter((member) => member.self) : manages ? everyone : everyone.filter((member) => member.state === "ACTIVE");
  const who = (member: Member): string => (member.self === true ? `${contract ? "You" : member.name} (you)` : contract ? `Member ··${member.ref}` : member.name);
  const counts = { active: team.filter((member) => member.state === "ACTIVE").length, invited: team.filter((member) => member.state === "INVITED").length, suspended: team.filter((member) => member.state === "SUSPENDED").length };

  if (state === "loading" || state === "error")
    return (
      <>
        <ProjectHeader stage="files" title="Team" lead="Give each person only the access they need." />
        {state === "loading" ? (
          <div className="kauro-state" role="status">
            <p>Loading your team…</p>
          </div>
        ) : (
          <div className="kauro-state" role="alert">
            <h2>The team could not be loaded</h2>
            <p>Nothing is shown until the team is read. Try again in a moment.</p>
            <Button>Try again</Button>
          </div>
        )}
      </>
    );

  const submitInvite = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const found: { fieldId: string; message: string }[] = [];
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(data.get("who") ?? ""))) found.push({ fieldId: "invite-who", message: "Enter the person's email address, such as name@company.com." });
    if (String(data.get("role") ?? "") === "") found.push({ fieldId: "invite-role", message: "Choose the role this person needs." });
    setErrors(found);
    if (found.length === 0) setPanel("invited");
  };
  const errorOf = (id: string): string | undefined => errors.find((entry) => entry.fieldId === id)?.message;
  const manage = (member: Member, next: string): void => {
    setSubject(member);
    setPanel(next);
  };

  return (
    <>
      <ProjectHeader
        stage="files"
        title="Team"
        lead="Give each person only the access they need."
        {...(manages && panel !== "invite" && panel !== "invite-invalid"
          ? {
              action: (
                <Button variant="primary" onClick={() => setPanel("invite")}>
                  Invite someone
                </Button>
              ),
            }
          : {})}
      />
      {manages ? null : <p className="kauro-a-only kauro-a-only--page">{onlyLine(ctx, "team", "invite people or remove access")}</p>}

      <section className="kauro-a-duties" aria-labelledby="team-duties">
        <h2 id="team-duties" className="kauro-visually-hidden">
          Who approves and who pays
        </h2>
        <dl className="kauro-a-duties-list">
          {(
            [
              ["Plans are approved by", ["APPROVER", "OWNER"], "an approver"],
              ["Quotes and payments are handled by", ["BILLING", "OWNER"], "a billing member"],
            ] as const
          ).map(([label, roles, missing]) => {
            const people = everyone.filter((member) => member.state === "ACTIVE" && (roles as readonly Role[]).includes(member.role));
            const specialist = people.some((member) => member.role !== "OWNER");
            return (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  {people.map((member) => `${member.name} (${ROLE_NAME[member.role]})`).join(", ")}
                  {!specialist && manages && !company ? (
                    <>
                      {" "}
                      ·{" "}
                      <button type="button" className="kauro-text-button" onClick={() => setPanel("invite")}>
                        Invite {missing}
                      </button>
                    </>
                  ) : null}
                </dd>
              </div>
            );
          })}
        </dl>
      </section>

      {panel === "invited" ? (
        <Banner tone="success" title="Invitation sent" announce="status">
          <p>It can be accepted until Oct 27, 2026, once, by the person invited. The link is sent to them and never shown again; if it is lost, withdraw it and invite again.</p>
        </Banner>
      ) : null}
      {panel === "last-owner" ? (
        <Banner tone="danger" title="The last owner cannot step down" announce="alert">
          <p>{workspace} needs at least one active owner. Transfer ownership to another active member first; then your own role can change.</p>
        </Banner>
      ) : null}

      {manages && (panel === "invite" || panel === "invite-invalid") ? (
        <section className="kauro-panel kauro-team-panel" aria-labelledby="team-invite">
          <div className="kauro-section-head">
            <h2 id="team-invite">Invite someone</h2>
            {contract ? null : <p className="kauro-proposed kauro-a-proposed">Proposed: invite by email address (D-UI31-1)</p>}
          </div>
          <form className="kauro-form kauro-team-invite" noValidate onSubmit={submitInvite}>
            <ErrorSummary title="Check the invitation" errors={errors} />
            <div className="kauro-team-invite-fields">
              <Field id="invite-who" label="Email address" hint="Only the person who signs in with this address can accept." error={errorOf("invite-who")}>
                {(control) => <input {...control} name="who" type="email" autoComplete="off" spellCheck={false} />}
              </Field>
              <Field id="invite-role" label="Role" hint={inviteRole === "" ? (owner ? "Ownership is transferred, not invited." : "Admins invite any role except owner.") : ROLE_SCOPE[inviteRole]} error={errorOf("invite-role")}>
                {(control) => (
                  <select {...control} name="role" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as Role | "")}>
                    <option value="" disabled>
                      Choose a role
                    </option>
                    {INVITE_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_NAME[role]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
            <div className="kauro-actions">
              <Button type="submit" variant="primary">
                Send invitation
              </Button>
              <Button onClick={() => setPanel("normal")}>Cancel</Button>
            </div>
            <p className="kauro-muted">An invitation lasts seven days and can be used once.</p>
          </form>
        </section>
      ) : null}

      {owner && (panel === "change-role" || panel === "step-up") ? (
        <section className="kauro-panel kauro-team-panel" aria-labelledby="team-role">
          <h2 id="team-role">Change the role of {who(subject)}</h2>
          <StepUpPanel result={panel === "step-up" ? { kind: "STEP_UP", cause: "NO_CREDENTIAL" } : null} onStepUp={() => setPanel("change-role")}>
            <form className="kauro-form" noValidate onSubmit={(event) => (event.preventDefault(), setPanel("step-up"))}>
              <Field id="role-new" label="New role" hint={`Now ${ROLE_NAME[subject.role]}. The change applies at once; Kauro asks you to confirm your identity first.`}>
                {(control) => (
                  <select {...control} name="role" defaultValue={subject.role === "OPERATOR" ? "APPROVER" : "OPERATOR"}>
                    {INVITE_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_NAME[role]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <div className="kauro-actions">
                <Button type="submit" variant="primary">
                  Confirm identity and change
                </Button>
                <Button onClick={() => setPanel("normal")}>Cancel</Button>
              </div>
            </form>
          </StepUpPanel>
        </section>
      ) : null}

      <section className="kauro-team" aria-labelledby="team-people">
        <div className="kauro-section-head">
          <h2 id="team-people">{manages ? "People and invitations" : "Who is on the team"}</h2>
          <p className="kauro-team-count">
            {counts.active} active
            {counts.invited > 0 ? ` · ${counts.invited} invited` : ""}
            {counts.suspended > 0 ? ` · ${counts.suspended} suspended` : ""}
            {contract ? null : <span className="kauro-proposed kauro-a-proposed">Names proposed (D-UI31-2)</span>}
          </p>
        </div>
        <div className="kauro-table-region" role="region" aria-labelledby="team-people" tabIndex={0}>
          <table className="kauro-table kauro-team-table">
            <caption className="kauro-visually-hidden">The members of {workspace}</caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col">Access</th>
                <th scope="col">Since</th>
                {manages ? (
                  <th scope="col">
                    <span className="kauro-visually-hidden">Manage</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {team.map((member) => {
                const canAct = manages && member.self !== true && !(member.role === "OWNER" && !owner);
                return (
                  <tr key={member.ref} className={member.self === true ? "is-self" : member.state === "SUSPENDED" ? "is-muted" : undefined}>
                    <th scope="row">
                      <span className="kauro-person">{member.state === "INVITED" && !contract ? member.email : who(member)}</span>
                      {contract || member.state === "INVITED" ? (member.state === "INVITED" ? <span className="kauro-person-sub">Invitation waiting · until {day("2026-10-25T11:20:00Z")}</span> : null) : <span className="kauro-person-sub">{member.email}</span>}
                    </th>
                    <td data-label="Role">{ROLE_NAME[member.role]}</td>
                    <td data-label="Access">
                      <Badge tone={STATE_TONE[member.state]}>{STATE_LABEL[member.state]}</Badge>
                    </td>
                    <td data-label="Since">{day(member.since)}</td>
                    {manages ? (
                      <td className="kauro-row-manage">
                        {member.self === true ? (
                          <span className="kauro-muted-text">Your access</span>
                        ) : canAct ? (
                          <details className="kauro-menu">
                            <summary>
                              Manage <span className="kauro-visually-hidden">{who(member)}</span>
                            </summary>
                            <ul>
                              {member.state === "ACTIVE" && owner ? (
                                <li>
                                  <button type="button" onClick={() => manage(member, "change-role")}>
                                    Change role
                                  </button>
                                </li>
                              ) : null}
                              {member.state === "ACTIVE" ? (
                                <li>
                                  <button type="button" onClick={() => manage(member, "recovery")}>
                                    Start a recovery
                                  </button>
                                </li>
                              ) : null}
                              <li>
                                <button type="button" className="is-danger" onClick={() => manage(member, "revoke")}>
                                  {member.state === "INVITED" ? "Withdraw invitation" : "Remove access"}
                                </button>
                              </li>
                            </ul>
                          </details>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {state === "only-you" || company ? <p className="kauro-team-alone">You are the only member. Invite the people who prepare, approve or pay for projects, each with the role they need.</p> : null}
      </section>

      <ConfirmDialog
        open={panel === "revoke"}
        title={subject.state === "INVITED" ? "Withdraw this invitation" : `Remove access for ${who(subject)}`}
        summary={<p>{subject.state === "INVITED" ? "The invitation stops working at once." : `${who(subject)} will no longer be able to open ${workspace}. What they did stays in the record.`}</p>}
        effects={[
          { id: "access", description: <p>{subject.state === "INVITED" ? "The link can no longer be used." : "Their access ends at once, including any page they have open."}</p>, acknowledgeLabel: "I understand this takes effect now" },
          { id: "return", description: <p>To come back, they need a new invitation.</p>, acknowledgeLabel: "I understand they need a new invitation" },
        ]}
        copy={{ approve: subject.state === "INVITED" ? "Withdraw invitation" : "Remove access", cancel: "Keep it", errorSummaryTitle: "Check before continuing" }}
        onApprove={() => setPanel("normal")}
        onCancel={() => setPanel("normal")}
      />

      <ConfirmDialog
        open={panel === "recovery"}
        title={`Start a recovery for ${who(subject)}`}
        summary={<p>Use this only when {who(subject)} has lost both their authenticator app and their recovery codes. You start the recovery; you cannot turn two-step verification off or let anyone in.</p>}
        effects={[
          { id: "check", description: <p>Kauro checks who they are with evidence independent of this account before anything changes.</p>, acknowledgeLabel: "I understand Kauro checks their identity" },
          { id: "wait", description: <p>A waiting period, set by the risk, follows. {who(subject)} and every owner are told.</p>, acknowledgeLabel: "I understand a waiting period applies" },
          { id: "sessions", description: <p>When it completes, {who(subject)} sets up two-step verification again and every session of their account ends.</p>, acknowledgeLabel: "I understand their sessions end" },
        ]}
        copy={{ approve: "Confirm identity and start", cancel: "Do not start", errorSummaryTitle: "Check before starting" }}
        onApprove={() => setPanel("step-up")}
        onCancel={() => setPanel("normal")}
      />

      <section aria-labelledby="team-roles">
        <h2 id="team-roles">What each role can and cannot do</h2>
        <table className="kauro-rtable kauro-a-roles">
          <caption className="kauro-visually-hidden">Each role, what it can do and what it cannot</caption>
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Can</th>
              <th scope="col">Cannot</th>
            </tr>
          </thead>
          <tbody>
            {ALL_ROLES.map((role) => (
              <tr key={role}>
                <th scope="row">{ROLE_NAME[role]}</th>
                <td data-label="Can">{CAN[role].can}</td>
                <td data-label="Cannot">{CAN[role].cannot}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="kauro-muted">Every member can download a delivered package and open a support case. Changing a role, transferring ownership, approving a plan, downloading a package and closing the workspace ask the person to confirm it is them first.</p>
      </section>

      {owner && !company ? (
        <section className="kauro-team-ownership" aria-labelledby="team-ownership">
          <h2 id="team-ownership">Ownership</h2>
          <p>You own {workspace}. You can hand ownership to another active member; you then stay on the team as an admin.</p>
          <Button onClick={() => setPanel("transfer")}>Transfer ownership</Button>
        </section>
      ) : null}
      <ConfirmDialog
        open={panel === "transfer"}
        title={`Transfer ownership to ${contract ? "Member ··5fb5" : "Marco Bianchi"}`}
        summary={<p>{contract ? "Member ··5fb5" : "Marco Bianchi"}, now an admin, becomes the owner of {workspace}. You become an admin.</p>}
        effects={[
          { id: "owner", description: <p>The new owner can close the workspace, change roles and transfer ownership again.</p>, acknowledgeLabel: "I understand who becomes the owner" },
          { id: "me", description: <p>You lose the owner&apos;s actions and keep the admin&apos;s.</p>, acknowledgeLabel: "I understand I become an admin" },
        ]}
        copy={{ approve: "Confirm identity and transfer", cancel: "Keep ownership", errorSummaryTitle: "Check before transferring" }}
        onApprove={() => setPanel("step-up")}
        onCancel={() => setPanel("normal")}
      />
    </>
  );
}

/** A row's menu (a <details>) closes on a click outside it and on Escape; it listens to click, never closing it inside pointerdown. */
function useCloseMenusOnOutsideClick(): void {
  useEffect(() => {
    const close = (except: EventTarget | null): void => {
      for (const menu of document.querySelectorAll<HTMLDetailsElement>("details.kauro-menu[open]")) if (!(except instanceof Node && menu.contains(except))) menu.open = false;
    };
    const onClick = (event: MouseEvent): void => close(event.target);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const open = document.querySelector<HTMLDetailsElement>("details.kauro-menu[open]");
      if (open === null) return;
      open.open = false;
      open.querySelector("summary")?.focus();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
}
