"use client";
// UI10 Agency switcher (registry: "Choose the agency you are working with."). Lists only the person's actual memberships with a safe role
// label (ListAgencies → AgencyMembershipView: name, agency state, role, membership state), keeps the current context visible, and offers to
// create an organisation when the person may (one draft at a time, CMD001). Switching is a full navigation: the page first clears what it
// showed of the previous agency and says it is switching, so nothing of the old tenant can be seen on the way (registry exceptions).
//
// It is the first page after sign-in for someone who works in several agencies: each workspace is one quiet row with its mark, its type
// and the person's role ("Agency · Owner"), and one way in, the last used first (research app-shell-settings.md §9.6, §11.1: a person in
// several workspaces actively chooses, ToS §4.4, so the chooser orders by recency instead of resuming silently). A state is shown only when
// it is not the ordinary one (in setup, restricted, suspended): an "Active" badge on every row said nothing. Opening a workspace lands on
// its Projects page, never a deep page.
import { Button } from "@kauro/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactElement, useState } from "react";
import type { ReviewContext } from "../lib/contexts.ts";
import { IDS } from "../lib/ids.ts";
import { appPathOf, type PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { EXAMPLE_ID, MEMBERSHIPS, workspaceOf } from "../lib/world.ts";
import { EXAMPLE, EXAMPLE_STAGES, UNPAID_RETENTION } from "./example.ts";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import { Badge, day, Monogram, Note, ROLE_NAME, type Role, Rings, ScreenButton, ScreenLink, Window } from "./kit.tsx";

export const UI10_STATES: readonly StateDef[] = [
  { key: "normal", label: "Several agencies", note: "Every membership with its role and state; where the person works now is said first." },
  { key: "empty", label: "Welcome: no workspace yet", note: "A new account (any Google account or email): explore the synthetic example, or set up an agency or company to check its own files. An invitation link joins an existing one." },
  { key: "switching", label: "Switching", note: "After choosing: the old agency's content is cleared and the page says it is switching." },
  { key: "loading", label: "Loading", note: "The list has not arrived: the place is held and announced." },
  { key: "error", label: "Could not load", note: "The list could not be read: try again; nothing else is shown." },
];

const STATE_LABEL = { DRAFT: "In setup", ACTIVE: "Active", RESTRICTED: "Restricted", CLOSING: "Closing", CLOSED: "Closed" } as const;
const STATE_TONE = { DRAFT: "neutral", ACTIVE: "success", RESTRICTED: "warning", CLOSING: "warning", CLOSED: "neutral" } as const;
const TYPE_LABEL = { agency: "Agency", "in-house": "Company" } as const;
/** When this person last opened each workspace (synthetic; needs a read: the membership's last use). */
const LAST_USED: Readonly<Record<string, string>> = {
  "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fa1": "2026-10-21T14:02:00Z",
  "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fc4": "2026-10-18T16:40:00Z",
  "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fc1": "2026-10-15T09:20:00Z",
  "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fc2": "2026-09-30T11:05:00Z",
  "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fc3": "2026-09-12T08:10:00Z",
  "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fb9": "2026-10-21T13:40:00Z",
};

interface Row {
  readonly agencyId: string;
  readonly name: string;
  readonly kind: "agency" | "in-house";
  readonly lastUsed: string;
  readonly role: Role;
  readonly state: keyof typeof STATE_LABEL;
  readonly suspended: boolean;
}

export function AgencySwitcher({ ctx, state }: PrototypeProps): ReactElement {
  const router = useRouter();
  const [switching, setSwitching] = useState<Row | null>(null);
  const rows: readonly Row[] =
    state === "empty"
      ? []
      : (MEMBERSHIPS[ctx.key] ?? []).flatMap((membership) => {
          const workspace = workspaceOf(membership.agencyId);
          return workspace === undefined ? [] : [{ agencyId: workspace.agencyId, name: workspace.name, kind: workspace.kind, lastUsed: LAST_USED[workspace.agencyId] ?? workspace.createdAt, role: membership.role, state: workspace.state, suspended: membership.state === "SUSPENDED" }];
        })
        .sort((a, b) => Date.parse(b.lastUsed) - Date.parse(a.lastUsed));
  const current = rows[0] ?? null;
  const hasDraft = rows.some((row) => row.state === "DRAFT" && row.role === "OWNER");
  const open = (row: Row): void => {
    setSwitching(row);
    // the real switch is a full navigation after the old agency's content is cleared; the review shows the same pause
    window.setTimeout(() => router.push(`/agencies/${row.agencyId}/projects`), 900);
  };
  const target = state === "switching" ? (rows.find((row, index) => index > 0 && row.state === "ACTIVE" && !row.suspended) ?? null) : switching;

  if (target !== null)
    return (
      <div className="kauro-switching" role="status">
        <h1 className="kauro-visually-hidden">Your workspaces</h1>
        <Monogram name={target.name} />
        <p>
          Opening <bdi>{target.name}</bdi>…
        </p>
        <p className="kauro-muted">What you had open from another workspace has been cleared.</p>
      </div>
    );

  if (rows.length === 0 && state !== "loading" && state !== "error") return <Welcome ctx={ctx} />;

  return (
    <>
      <ProjectHeader stage="files" title="Your workspaces" lead="Choose the workspace you are working in. The one you used last is first." />
      {state === "loading" ? (
        <div className="kauro-state" role="status">
          <p>Loading your workspaces…</p>
        </div>
      ) : state === "error" ? (
        <div className="kauro-state" role="alert">
          <h2>Your workspaces could not be loaded</h2>
          <p>Nothing is shown until the list is read. Try again in a moment.</p>
          <Button>Try again</Button>
        </div>
      ) : (
        <>
          <ul className="kauro-workspaces" aria-label="Workspaces you belong to">
            {rows.map((row) => {
              const here = row === current;
              const inner = (
                <>
                  <Monogram name={row.name} />
                  <span className="kauro-workspace-main">
                    <bdi className="kauro-workspace-name">{row.name}</bdi>
                    <span className="kauro-workspace-role">
                      {TYPE_LABEL[row.kind]} · {ROLE_NAME[row.role]} · {here ? "last used" : "opened"} {day(row.lastUsed)}
                    </span>
                  </span>
                  <span className="kauro-workspace-state">
                    {row.suspended ? <Badge tone="danger">Your access is suspended</Badge> : row.state === "ACTIVE" ? null : <Badge tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</Badge>}
                  </span>
                  <span className="kauro-workspace-go">{row.suspended ? "An owner can restore it" : row.state === "DRAFT" ? "Continue setup" : "Open"}</span>
                </>
              );
              return (
                <li key={row.agencyId} className={here ? "is-here" : row.suspended ? "is-suspended" : undefined}>
                  {row.suspended ? (
                    <div className="kauro-workspace">{inner}</div>
                  ) : row.state === "DRAFT" ? (
                    <Link className="kauro-workspace" href={appPathOf("UI09", ctx)}>
                      {inner}
                    </Link>
                  ) : (
                    <a
                      className="kauro-workspace"
                      href={`/agencies/${row.agencyId}/projects`}
                      onClick={(event) => {
                        event.preventDefault();
                        open(row);
                      }}
                    >
                      {inner}
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="kauro-switch-new">
            {hasDraft ? (
              <>
                One workspace is already in setup. <ScreenLink to="UI09" ctx={ctx}>Finish it</ScreenLink> before starting another.
              </>
            ) : (
              <>
                Need another workspace? <ScreenLink to="UI09" ctx={ctx}>Set up an agency or company</ScreenLink>. You become its owner.
              </>
            )}
          </p>
        </>
      )}
    </>
  );
}

/**
 * The welcome of a new account (the owner's decisions of 2026-10-20): any Google account or email may sign up, explore the example with
 * synthetic data, and set up an agency or company only when it wants its own files checked. The first step is the useful one, checking
 * the person's own files, with concrete promises beside it instead of an incentive (research: onboarding-vs-discounts.md, 1 and 8); the
 * example is the second way in, beside it, the public site's own worked example inside the product's window (Hightouch's sample sources).
 * No discount is shown here: the repeat ladder appears once there is a first project (research 6).
 */
function Welcome({ ctx }: { readonly ctx: ReviewContext }): ReactElement {
  const example: ReviewContext = { ...ctx, agency: { agencyId: EXAMPLE_ID, version: 1, displayName: "Example workspace", state: "ACTIVE", createdAt: "2026-10-01T00:00:00Z", permittedActions: ["VIEW"] } };
  return (
    <>
      <ProjectHeader stage="files" title="Welcome to Kauro" lead="See exactly what you would receive, then check your own files for free when you are ready." />
      <div className="kauro-welcome">
        <section className="kauro-welcome-start" aria-labelledby="welcome-start-h">
          <h2 id="welcome-start-h">Check your own files</h2>
          <ol className="kauro-welcome-steps">
            <li>
              <strong>Set up your agency or company</strong>
              <span>Who buys, its name, what your files hold, and the agreements.</span>
            </li>
            <li>
              <strong>Upload your exports</strong>
              <span>CSV or XLSX exports of contacts, companies, deals or similar records.</span>
            </li>
            <li>
              <strong>Read your free data health check</strong>
              <span>What Kauro found in every row, then an estimate for preparing your files.</span>
            </li>
          </ol>
          <ScreenButton to="UI09" ctx={ctx} variant="primary">
            <span className="kauro-go">Set up your agency or company</span>
          </ScreenButton>
          <ul className="kauro-checklist kauro-welcome-promises" aria-label="What Kauro promises">
            <li>No card for the free check, and no obligation after it</li>
            <li>You approve every change before anything is prepared, and a formal quote comes before you pay</li>
            <li>Kauro never connects to your CRM</li>
            <li>
              If you do not buy, your files are deleted {UNPAID_RETENTION.days} days after your results, and never later than {UNPAID_RETENTION.hardDays} days after you sealed them
            </li>
          </ul>
        </section>
        <section className="kauro-welcome-example" aria-labelledby="welcome-example-h">
          <h2 id="welcome-example-h" className="kauro-visually-hidden">
            The example project
          </h2>
          <Window title={EXAMPLE.name} state="Synthetic data">
            <Rings label={`${EXAMPLE.client} · for ${EXAMPLE.destination}`} items={EXAMPLE_STAGES.map((stage) => ({ key: stage.key, name: stage.name, fact: stage.fact, state: "done" as const }))} />
            <div className="kauro-welcome-example-go">
              <ScreenButton to="UI13" ctx={example} project={IDS.project}>
                Explore the example
              </ScreenButton>
            </div>
          </Window>
          <Note>The same project How it works describes, walked from the upload to the delivery. Nothing in it is anyone&apos;s data.</Note>
        </section>
      </div>
      <p className="kauro-switch-new">Invited by a team? Open the link in your invitation email. An email address never adds anyone to an agency on its own.</p>
    </>
  );
}
