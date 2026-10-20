"use client";
// UI31 Team (registry: "Give each person only the access they need."). Reads ListMembers → TeamMemberView: role, membership state, version,
// whether the row is the reader, and dates. The api names no other person (no name, no address, no assurance detail), so a member is shown
// as "You" or by the end of its membership reference; showing names is a proposed contract (D-UI31-2). What a reader sees follows the api:
// an owner or admin (MANAGE_TEAM) sees every membership with its lifecycle; anyone else sees the active team's roles only.
// Commands: invite (CMD003, owner or admin; an admin never grants owner), change a role (CMD005, owner, fresh step-up), revoke (CMD006,
// owner or admin; an admin never acts on an owner), transfer ownership (CMD007, owner, fresh step-up). The last owner is protected.
import { Banner, Button, ConfirmDialog, ErrorSummary, Field } from "@kauro/ui";
import { type FormEvent, type ReactElement, useState } from "react";
import { StepUpPanel } from "@web/screens/shared/step-up.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, day, ROLE_NAME, ROLE_SCOPE, type Role } from "./kit.tsx";

export const UI31_STATES: readonly StateDef[] = [
  { key: "normal", label: "Team", note: "The whole team as an owner sees it, with what each person may do." },
  { key: "invite", label: "Invite someone", note: "The invitation form: a role and who to invite. An invitation lasts seven days and is used once." },
  { key: "invite-invalid", label: "Invitation not valid", note: "Validation of the invitation form, next to each field and in a summary." },
  { key: "invited", label: "Invitation created", note: "Done: the invitation exists, with its expiry; the link is sent once and never shown again." },
  { key: "change-role", label: "Change a role", note: "An owner changes a member's role; it asks the owner to confirm their identity again first." },
  { key: "step-up", label: "Identity confirmation needed", note: "A sensitive change waits for a fresh confirmation of identity; the form stays as it was." },
  { key: "revoke", label: "Remove access", note: "The confirmation for revoking a member: what happens, acknowledged before it is done." },
  { key: "last-owner", label: "Last owner protected", note: "Removing or demoting the only owner is refused, with what to do instead." },
  { key: "transfer", label: "Transfer ownership", note: "Ownership moves to an active member after a fresh identity confirmation; the previous owner stays as admin." },
  { key: "only-you", label: "Only you", note: "A team of one: the screen invites the next person." },
  { key: "names", label: "PROPOSED: with names", note: "Proposed design: members shown by name and address. Needs the api to return them to managers (D-UI31-2)." },
  { key: "loading", label: "Loading", note: "The team has not arrived: the place is held and announced." },
  { key: "error", label: "Could not load", note: "The team could not be read: try again; nothing else is shown." },
];

interface Member {
  readonly ref: string;
  readonly role: Role;
  readonly state: "ACTIVE" | "INVITED" | "SUSPENDED" | "EXPIRED";
  readonly self?: boolean;
  readonly since: string;
  readonly name?: string;
  readonly email?: string;
}

const TEAM: readonly Member[] = [
  { ref: "7a01", role: "OWNER", state: "ACTIVE", self: true, since: "2026-09-02T14:25:00Z", name: "Lena Ortiz", email: "lena.ortiz@northwind.example" },
  { ref: "5fb5", role: "ADMIN", state: "ACTIVE", since: "2026-09-04T09:10:00Z", name: "Marco Bianchi", email: "marco.bianchi@northwind.example" },
  { ref: "3c9e", role: "OPERATOR", state: "ACTIVE", since: "2026-09-14T10:00:00Z", name: "Priya Nair", email: "priya.nair@northwind.example" },
  { ref: "8d27", role: "APPROVER", state: "ACTIVE", since: "2026-09-21T16:30:00Z", name: "Samuel Osei", email: "samuel.osei@northwind.example" },
  { ref: "41b0", role: "BILLING", state: "ACTIVE", since: "2026-10-01T08:45:00Z", name: "Ines Duarte", email: "ines.duarte@northwind.example" },
  { ref: "e6f2", role: "OPERATOR", state: "INVITED", since: "2026-10-18T11:20:00Z", name: "Invited person", email: "a.kowalski@northwind.example" },
  { ref: "92ad", role: "VIEWER", state: "SUSPENDED", since: "2026-09-10T13:00:00Z", name: "Tom Lindqvist", email: "tom.lindqvist@northwind.example" },
];

const STATE_LABEL = { ACTIVE: "Active", INVITED: "Invitation sent", SUSPENDED: "Suspended", EXPIRED: "Invitation expired" } as const;
const STATE_TONE = { ACTIVE: "success", INVITED: "info", SUSPENDED: "danger", EXPIRED: "neutral" } as const;
const INVITE_ROLES: readonly Role[] = ["ADMIN", "OPERATOR", "APPROVER", "BILLING", "VIEWER"];

export function Team({ ctx, state }: PrototypeProps): ReactElement {
  const actions = ctx.agency?.permittedActions ?? [];
  const manages = actions.includes("MANAGE_TEAM");
  const owner = actions.includes("MANAGE_AGENCY");
  const names = state === "names";
  const [panel, setPanel] = useState<string>(state);
  const [errors, setErrors] = useState<readonly { fieldId: string; message: string }[]>(
    state === "invite-invalid"
      ? [
          { fieldId: "invite-who", message: "Enter the person's email address, such as name@company.com." },
          { fieldId: "invite-role", message: "Choose the role this person needs." },
        ]
      : [],
  );
  const team = state === "only-you" ? TEAM.slice(0, 1) : manages ? TEAM : TEAM.filter((member) => member.state === "ACTIVE");
  const who = (member: Member): string => (member.self === true ? "You" : names ? (member.name ?? "") : `Member ··${member.ref}`);

  if (state === "loading")
    return (
      <>
        <h1>Team</h1>
        <div className="kauro-state" role="status">
          <p>Loading your team…</p>
        </div>
      </>
    );
  if (state === "error")
    return (
      <>
        <h1>Team</h1>
        <div className="kauro-state" role="alert">
          <h2>The team could not be loaded</h2>
          <p>Nothing is shown until the team is read. Try again in a moment.</p>
          <Button>Try again</Button>
        </div>
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

  return (
    <>
      <h1>Team</h1>
      <p className="kauro-lead">Give each person only the access they need.</p>

      {panel === "invited" ? (
        <Banner tone="success" title="Invitation created" announce="status">
          <p>The invitation is valid until 27 Oct 2026 and can be used once, by the person invited. The link is sent to them once and is never shown again; if it is lost, withdraw it and invite again.</p>
        </Banner>
      ) : null}
      {panel === "last-owner" ? (
        <Banner tone="danger" title="The last owner cannot be removed" announce="alert">
          <p>Northwind Data needs at least one active owner. Transfer ownership to another active member first, then change your own role.</p>
        </Banner>
      ) : null}

      <section aria-labelledby="team-members">
        <div className="kauro-section-head">
          <h2 id="team-members">{manages ? "Members and invitations" : "Who is on the team"}</h2>
          {manages && panel !== "invite" && panel !== "invite-invalid" ? (
            <Button variant="primary" onClick={() => setPanel("invite")}>
              Invite someone
            </Button>
          ) : null}
        </div>
        {names ? <p className="kauro-proposed">Proposed — needs member names from the api (D-UI31-2)</p> : null}
        {!manages ? <p className="kauro-muted">You see the active team and its roles. Owners and admins manage invitations and access.</p> : null}
        <div className="kauro-table-region" role="region" aria-labelledby="team-members" tabIndex={0}>
          <table className="kauro-table kauro-team-table">
            <caption className="kauro-table-caption">{team.length === 1 ? "1 member" : `${team.length} members`}</caption>
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Role</th>
                <th scope="col">Access</th>
                <th scope="col">{manages ? "Since" : "Member since"}</th>
                {manages ? (
                  <th scope="col">
                    <span className="kauro-visually-hidden">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {team.map((member) => (
                <tr key={member.ref} className={member.self === true ? "is-self" : undefined}>
                  <th scope="row">
                    <span className="kauro-member-name">{who(member)}</span>
                    {names && member.email !== undefined ? <span className="kauro-member-sub">{member.email}</span> : null}
                    {!names && member.self !== true ? <span className="kauro-member-sub">Reference ends {member.ref}</span> : null}
                  </th>
                  <td data-label="Role">{ROLE_NAME[member.role]}</td>
                  <td data-label="Access">
                    <Badge tone={STATE_TONE[member.state]}>{STATE_LABEL[member.state]}</Badge>
                  </td>
                  <td data-label="Since">{day(member.since)}</td>
                  {manages ? (
                    <td className="kauro-row-actions">
                      {member.self === true ? (
                        owner ? (
                          <Button onClick={() => setPanel("last-owner")}>Change my role</Button>
                        ) : null
                      ) : member.state === "INVITED" ? (
                        <Button variant="danger" onClick={() => setPanel("revoke")}>
                          Withdraw
                        </Button>
                      ) : member.role === "OWNER" && !owner ? null : (
                        <>
                          {owner && member.state === "ACTIVE" ? <Button onClick={() => setPanel("change-role")}>Change role</Button> : null}
                          <Button variant="danger" onClick={() => setPanel("revoke")}>
                            Remove access
                          </Button>
                        </>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {state === "only-you" ? <p>You are the only member. Invite the people who prepare, approve or pay for projects, each with the role they need.</p> : null}
      </section>

      {manages && (panel === "invite" || panel === "invite-invalid") ? (
        <section aria-labelledby="team-invite" className="kauro-form-panel">
          <h2 id="team-invite">Invite someone</h2>
          <form noValidate onSubmit={submitInvite}>
            <ErrorSummary title="Check the invitation" errors={errors} />
            <p className="kauro-proposed">Proposed — invite by email address needs a contract (D-UI31-1)</p>
            <Field id="invite-who" label="Email address" hint="The invitation can only be accepted by the person who signs in with this address." error={errorOf("invite-who")}>
              {(control) => <input {...control} name="who" type="email" autoComplete="off" spellCheck={false} />}
            </Field>
            <Field id="invite-role" label="Role" hint={owner ? "What each role can do is listed below. Ownership is not offered here: it is transferred below." : "What each role can do is listed below. Admins can invite any role except owner."} error={errorOf("invite-role")}>
              {(control) => (
                <select {...control} name="role" defaultValue="">
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
            <div className="kauro-actions">
              <Button type="submit" variant="primary">
                Send invitation
              </Button>
              <Button onClick={() => setPanel("normal")}>Cancel</Button>
            </div>
          </form>
        </section>
      ) : null}

      {owner && (panel === "change-role" || panel === "step-up") ? (
        <section aria-labelledby="team-role" className="kauro-form-panel">
          <h2 id="team-role">Change the role of Member ··3c9e</h2>
          <StepUpPanel result={panel === "step-up" ? { kind: "STEP_UP", cause: "NO_CREDENTIAL" } : null} onStepUp={() => setPanel("change-role")}>
            <form noValidate onSubmit={(event) => (event.preventDefault(), setPanel("step-up"))}>
              <Field id="role-new" label="New role" hint="Currently Operator. The change applies at once; Kauro asks you to confirm your identity first.">
                {(control) => (
                  <select {...control} name="role" defaultValue="APPROVER">
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
                  Confirm identity and change role
                </Button>
                <Button onClick={() => setPanel("normal")}>Cancel</Button>
              </div>
            </form>
          </StepUpPanel>
        </section>
      ) : null}

      <ConfirmDialog
        open={panel === "revoke"}
        title="Remove access for Member ··3c9e"
        summary={<p>Member ··3c9e will no longer be able to open Northwind Data. Their past actions stay in the record.</p>}
        effects={[
          { id: "access", description: <p>Their access ends at once, including any page they have open.</p>, count: 1, countLabel: "member loses access", acknowledgeLabel: "I understand this member loses access now" },
          { id: "rejoin", description: <p>To return, they need a new invitation.</p>, count: 1, countLabel: "new invitation needed to return", acknowledgeLabel: "I understand they need a new invitation to return" },
        ]}
        copy={{ approve: "Remove access", cancel: "Keep access", errorSummaryTitle: "Check before removing access" }}
        onApprove={() => setPanel("normal")}
        onCancel={() => setPanel("normal")}
      />

      {owner ? (
        <section aria-labelledby="team-ownership">
          <h2 id="team-ownership">Ownership</h2>
          <p>An owner can transfer ownership to another active member. You stay on the team as an admin. Kauro asks you to confirm your identity first.</p>
          <Button onClick={() => setPanel("transfer")}>Transfer ownership</Button>
        </section>
      ) : null}
      <ConfirmDialog
        open={panel === "transfer"}
        title="Transfer ownership to Member ··5fb5"
        summary={<p>Member ··5fb5 (now an admin) becomes the owner of Northwind Data. You become an admin.</p>}
        effects={[
          { id: "owner", description: <p>The new owner can close the agency, change roles and transfer ownership again.</p>, count: 1, countLabel: "new owner", acknowledgeLabel: "I understand Member ··5fb5 becomes the owner" },
          { id: "me", description: <p>You lose the owner&apos;s actions and keep the admin&apos;s.</p>, count: 1, countLabel: "role changes for you", acknowledgeLabel: "I understand I become an admin" },
        ]}
        copy={{ approve: "Confirm identity and transfer", cancel: "Keep ownership", errorSummaryTitle: "Check before transferring" }}
        onApprove={() => setPanel("step-up")}
        onCancel={() => setPanel("normal")}
      />

      <section aria-labelledby="team-roles">
        <h2 id="team-roles">What each role can do</h2>
        <dl>
          {(["OWNER", "ADMIN", "OPERATOR", "APPROVER", "BILLING", "VIEWER"] as const).map((role) => (
            <div key={role}>
              <dt>{ROLE_NAME[role]}</dt>
              <dd>{ROLE_SCOPE[role]}</dd>
            </div>
          ))}
        </dl>
        <p className="kauro-muted">Sensitive actions (changing roles, transferring ownership, approving plans, closing the agency) ask for a fresh confirmation of identity.</p>
      </section>
    </>
  );
}
