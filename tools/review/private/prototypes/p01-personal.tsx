"use client";
// P-01 Your account (proposed; Order 11 round 2, research app-shell-settings.md §9.10 A). The personal scope, the same in every workspace,
// opened from the account menu (route /account). Four pages, in order of use: Profile · Sign-in and security · Notifications ·
// Your workspaces. Each states its scope under its heading: "These settings only apply to you."
//
// Built only from what exists where it can be (the product has one theme, dark, so there is no Appearance page): two-step verification
// and the session's limits come from the session (getCurrentSession) and the session policy (idle 30 minutes, 12 hours at most, a fresh
// confirmation after 15 minutes: packages/application/src/sessions/protocol.ts, ports/assurance-and-admission.ts); the memberships are the
// switcher's read (ListAgencies). The profile read, sign-in methods, recovery codes, other sessions, security activity and notification
// choices have no contract: each is marked where it appears. No password, code, recovery code or secret is drawn here, ever: new recovery
// codes are shown once, in their own step after the identity check, and never on this page.
import { Banner, Button } from "@kauro/ui";
import Link from "next/link";
import { type ReactElement, useEffect, useState } from "react";
import { IDS } from "../lib/ids.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { EXAMPLE_ID, MEMBERSHIPS, workspaceOf } from "../lib/world.ts";
import { Badge, day, Facts, ROLE_NAME, ScreenButton, ScreenLink } from "./kit.tsx";
import { Needs, personOf, SettingsFrame, type SettingsPage } from "./settings-frame.tsx";

export const P01_STATES: readonly StateDef[] = [
  { key: "normal", label: "Profile", note: "Your name, your email address as you signed up with it, and how Kauro writes dates and times." },
  { key: "security", label: "Sign-in and security", note: "How you sign in, two-step verification, recovery codes as a count, your sessions and recent security events. Nothing secret is shown." },
  { key: "security-codes", label: "New recovery codes made", note: "After confirming identity and making new codes: the page says the old ones stopped working; the new ones were shown once, in their own step." },
  { key: "security-signed-out", label: "Other sessions ended", note: "After signing out of every other session: only this one is left." },
  { key: "notifications", label: "Notifications", note: "The emails you choose, per workspace, and the ones that are always sent." },
  { key: "notifications-saved", label: "Notifications saved", note: "After saving the choices." },
  { key: "workspaces", label: "Your workspaces", note: "Each membership with its type, role and when you joined; leave one, create one, open the example." },
];

const PAGES: readonly SettingsPage[] = [
  { key: "normal", label: "Profile" },
  { key: "security", label: "Sign-in and security" },
  { key: "notifications", label: "Notifications" },
  { key: "workspaces", label: "Your workspaces" },
];

const pageOf = (state: string): string => (state.startsWith("security") ? "security" : state.startsWith("notifications") ? "notifications" : PAGES.some((page) => page.key === state) ? state : "normal");

export function PersonalSettings({ ctx, state }: PrototypeProps): ReactElement {
  const page = pageOf(state);
  const title = PAGES.find((one) => one.key === page)?.label ?? "Profile";
  return (
    <SettingsFrame ctx={ctx} path="/account" context="Your account" pages={PAGES} current={page} title={title} scope="These settings only apply to you. They are the same in every workspace you belong to.">
      {page === "normal" ? <Profile ctx={ctx} /> : null}
      {page === "security" ? <Security ctx={ctx} state={state} /> : null}
      {page === "notifications" ? <Notifications ctx={ctx} state={state} /> : null}
      {page === "workspaces" ? <Workspaces ctx={ctx} /> : null}
    </SettingsFrame>
  );
}

function Profile({ ctx }: Pick<PrototypeProps, "ctx">): ReactElement {
  const person = personOf(ctx);
  return (
    <>
      <section aria-labelledby="me-profile-h">
        <h2 id="me-profile-h">Your details</h2>
        <Facts
          rows={[
            ["Name", <bdi key="n">{person.name}</bdi>],
            ["Email address", <bdi key="e">{person.email}</bdi>],
          ]}
        />
        <p className="kauro-muted">
          Your name appears on approvals, invitations and the activity of each workspace. Your email address is the one you sign in with; a new address is verified before it is used, so a
          change goes through <ScreenLink to="UI52" ctx={ctx}>support</ScreenLink>.
        </p>
        <Needs>Needs a read and a command: your profile as the sign-in provider holds it, and changing your name</Needs>
      </section>
      <section aria-labelledby="me-time-h">
        <h2 id="me-time-h">Dates and times</h2>
        <Facts rows={[["Shown in", "Coordinated Universal Time (UTC), on every page, every deadline and every email"]]} />
        <p className="kauro-muted">One time zone for everyone in a workspace, so a deadline reads the same for the person who approves and the person who pays.</p>
      </section>
    </>
  );
}

function Security({ ctx, state }: Pick<PrototypeProps, "ctx" | "state">): ReactElement {
  const person = personOf(ctx);
  const google = ctx.key !== "operator";
  const signedOut = state === "security-signed-out";
  return (
    <>
      {state === "security-codes" ? (
        <Banner tone="success" title="New recovery codes made" announce="status">
          <p>Your previous recovery codes no longer work. The new ones were shown once, when you made them; Kauro does not show them again.</p>
        </Banner>
      ) : null}
      {signedOut ? (
        <Banner tone="success" title="Other sessions ended" announce="status">
          <p>You are signed in only here. Anyone on another device must sign in again, with your password or Google and your Kauro code.</p>
        </Banner>
      ) : null}
      <section aria-labelledby="me-signin-h">
        <h2 id="me-signin-h">How you sign in</h2>
        <Facts
          rows={[
            ["Email address", <bdi key="e">{person.email}</bdi>],
            google ? ["Google", <span key="g">Connected as <bdi>{person.email}</bdi></span>] : ["Password", "Set on Sep 14, 2026"],
            ["Two-step verification", <Badge key="m" tone="success">On · authenticator app since Sep 2, 2026</Badge>],
            ["Recovery codes", "8 of 10 unused"],
          ]}
        />
        <div className="kauro-actions">
          <Button>{google ? "Add a password" : "Change password"}</Button>
          <Button>Replace authenticator app</Button>
          <Button>Make new recovery codes</Button>
        </div>
        <p className="kauro-muted">Two-step verification is required on every Kauro account and cannot be turned off. Each change here asks for your Kauro code first.</p>
        <Needs>Needs commands: password, authenticator and recovery codes are changed through the sign-in provider</Needs>
      </section>
      <section aria-labelledby="me-sessions-h">
        <h2 id="me-sessions-h">Where you are signed in</h2>
        <ul className="kauro-a-sessions">
          <li>
            <span>
              <strong>This browser</strong>
              <span className="kauro-a-sub">Chrome on Windows · signed in today at 2:02 PM UTC</span>
            </span>
            <Badge tone="success">This session</Badge>
          </li>
          {signedOut ? null : (
            <>
              <li>
                <span>
                  <strong>Safari on iPhone</strong>
                  <span className="kauro-a-sub">Signed in on Oct 18, 2026 · last active Oct 20, 2026</span>
                </span>
                <Button>Sign out</Button>
              </li>
              <li>
                <span>
                  <strong>Firefox on macOS</strong>
                  <span className="kauro-a-sub">Signed in on Oct 12, 2026 · last active Oct 14, 2026</span>
                </span>
                <Button>Sign out</Button>
              </li>
            </>
          )}
        </ul>
        {signedOut ? null : (
          <div className="kauro-actions">
            <Button>Sign out of all other sessions</Button>
          </div>
        )}
        <Facts
          rows={[
            ["A session ends", "After 30 minutes without activity, and 12 hours after signing in at the latest"],
            ["Sensitive actions", "Approving a plan, downloading a package, changing a role or deleting data ask you to confirm it is you, when you last did so more than 15 minutes ago"],
          ]}
        />
        <Needs>Needs a read: your other sessions; only this session is read today</Needs>
      </section>
      <section aria-labelledby="me-events-h">
        <h2 id="me-events-h">Recent security events</h2>
        <ol className="kauro-a-events">
          <li>
            <span className="kauro-a-when">Oct 21, 2026, 2:02 PM UTC</span>
            <span>Signed in with Google and your Kauro code · Chrome on Windows</span>
          </li>
          <li>
            <span className="kauro-a-when">Oct 18, 2026, 8:41 AM UTC</span>
            <span>Signed in with Google and your Kauro code · Safari on iPhone</span>
          </li>
          <li>
            <span className="kauro-a-when">Sep 2, 2026, 2:21 PM UTC</span>
            <span>Two-step verification turned on · recovery codes made</span>
          </li>
        </ol>
        <p className="kauro-muted">
          Something here you do not recognise? Sign out of the other sessions, then <ScreenLink to="UI52" ctx={ctx}>open a support case</ScreenLink>.
        </p>
      </section>
    </>
  );
}

const NOTICES = [
  { id: "approval", label: "A plan waits for my approval", roles: ["OWNER", "APPROVER"] },
  { id: "payment", label: "A quote waits for payment", roles: ["OWNER", "BILLING"] },
  { id: "check", label: "A free data health check is ready", roles: ["OWNER", "ADMIN", "OPERATOR"] },
  { id: "package", label: "A package is ready to download", roles: ["OWNER", "ADMIN", "OPERATOR", "APPROVER", "BILLING", "VIEWER"] },
  { id: "import", label: "An import stage needs its result", roles: ["OWNER", "ADMIN", "OPERATOR"] },
  { id: "team", label: "Someone joins or leaves the team", roles: ["OWNER", "ADMIN"] },
] as const;

function Notifications({ ctx, state }: Pick<PrototypeProps, "ctx" | "state">): ReactElement {
  const [saved, setSaved] = useState(state === "notifications-saved");
  const person = personOf(ctx);
  const workspace = ctx.agency?.displayName ?? null;
  const mine = NOTICES.filter((notice) => (notice.roles as readonly string[]).includes(person.role));
  return (
    <>
      {workspace === null ? (
        <section aria-labelledby="me-notices-h" className="kauro-empty">
          <h2 id="me-notices-h">No workspace yet</h2>
          <p>Emails about projects start once you belong to a workspace. Security messages are sent from now on.</p>
        </section>
      ) : (
        <section aria-labelledby="me-notices-h">
          <h2 id="me-notices-h">Emails you choose</h2>
          {saved ? (
            <Banner tone="success" title="Saved" announce="status">
              <p>Kauro emails you about these from now on, in <bdi>{workspace}</bdi>.</p>
            </Banner>
          ) : null}
          <form
            className="kauro-a-notices"
            onSubmit={(event) => {
              event.preventDefault();
              setSaved(true);
            }}
          >
            <fieldset>
              <legend>
                In <bdi>{workspace}</bdi>, email me when
              </legend>
              {mine.map((notice) => (
                <label key={notice.id} className="kauro-check-row">
                  <input type="checkbox" name={notice.id} defaultChecked={notice.id !== "team"} />
                  <span>{notice.label}</span>
                </label>
              ))}
            </fieldset>
            <div className="kauro-actions">
              <Button type="submit" variant="primary">
                Save notifications
              </Button>
            </div>
          </form>
          <p className="kauro-muted">Only the emails your role can act on are listed. Each workspace keeps its own choices.</p>
          <Needs>Needs a contract: Kauro does not store notification choices yet</Needs>
        </section>
      )}
      <section aria-labelledby="me-always-h">
        <h2 id="me-always-h">Emails that are always sent</h2>
        <ul>
          <li>Security messages: a new sign-in method, new recovery codes, a recovery started for you.</li>
          <li>Payment messages: a transfer matched, a payment under review, a refund.</li>
          <li>Deletion messages: files about to be deleted, and the record once they are.</li>
        </ul>
      </section>
    </>
  );
}

const TYPE_LABEL = { agency: "Agency", "in-house": "Company" } as const;

function Workspaces({ ctx }: Pick<PrototypeProps, "ctx">): ReactElement {
  const rows = (MEMBERSHIPS[ctx.key] ?? []).flatMap((membership) => {
    const workspace = workspaceOf(membership.agencyId);
    return workspace === undefined ? [] : [{ ...membership, workspace }];
  });
  const exampleCtx = { ...ctx, agency: { agencyId: EXAMPLE_ID, version: 1, displayName: "Example workspace", state: "ACTIVE" as const, createdAt: "2026-10-01T00:00:00Z", permittedActions: ["VIEW" as const] } };
  return (
    <>
      <section aria-labelledby="me-ws-h">
        <h2 id="me-ws-h">Workspaces you belong to</h2>
        {rows.length === 0 ? (
          <div className="kauro-empty">
            <p>You are not in a workspace yet. Set one up to check your own files, or open the invitation link a team sent you.</p>
            <ScreenButton to="UI09" ctx={ctx} variant="primary">
              Set up an agency or company
            </ScreenButton>
          </div>
        ) : (
          <table className="kauro-rtable">
            <caption className="kauro-visually-hidden">Your memberships</caption>
            <thead>
              <tr>
                <th scope="col">Workspace</th>
                <th scope="col">Type</th>
                <th scope="col">Your role</th>
                <th scope="col">Joined</th>
                <th scope="col">
                  <span className="kauro-visually-hidden">Leave</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const onlyOwner = row.role === "OWNER";
                return (
                  <tr key={row.agencyId}>
                    <td data-label="">
                      <Link href={`/agencies/${row.agencyId}/projects`} prefetch={false}>
                        <bdi>{row.workspace.name}</bdi>
                      </Link>
                      {row.state === "SUSPENDED" ? <span className="kauro-sub">Your access is suspended</span> : row.workspace.state === "DRAFT" ? <span className="kauro-sub">In setup</span> : null}
                    </td>
                    <td data-label="Type">{TYPE_LABEL[row.workspace.kind]}</td>
                    <td data-label="Your role">{ROLE_NAME[row.role]}</td>
                    <td data-label="Joined">{day(row.workspace.createdAt)}</td>
                    <td data-label="">{onlyOwner ? <span className="kauro-sub">Transfer ownership before you leave</span> : <Button>Leave</Button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
      <section aria-labelledby="me-ws-more-h">
        <h2 id="me-ws-more-h">Another workspace</h2>
        <p>
          <ScreenLink to="UI09" ctx={ctx}>
            Set up an agency or company
          </ScreenLink>
          . You become its owner. To join a team, open the invitation it sent you: an email address never adds anyone to a workspace on its own.
        </p>
        <p>
          <ScreenLink to="UI13" ctx={exampleCtx} project={IDS.project}>
            Open the example project
          </ScreenLink>
          , with invented data, read only.
        </p>
      </section>
    </>
  );
}
