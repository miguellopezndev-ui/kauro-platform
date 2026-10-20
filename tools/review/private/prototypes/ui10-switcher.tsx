"use client";
// UI10 Agency switcher (registry: "Choose the agency you are working with."). Lists only the person's actual memberships with a safe role
// label (ListAgencies → AgencyMembershipView: name, agency state, role, membership state), keeps the current context visible, and offers to
// create an organisation when the person may (one draft at a time, CMD001). Switching is a full navigation: the page first clears what it
// showed of the previous agency and says it is switching, so nothing of the old tenant can be seen on the way (registry exceptions).
//
// It is the first page after sign-in for someone who works in several agencies: each workspace is one quiet row with its mark, the
// person's role and the workspace's state, and one way in. Where the person is now is said in words, not only by a colour.
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
import { Badge, Monogram, Note, PageHead, ROLE_NAME, type Role, Rings, ScreenButton, ScreenLink, Window } from "./kit.tsx";

export const UI10_STATES: readonly StateDef[] = [
  { key: "normal", label: "Several agencies", note: "Every membership with its role and state; where the person works now is said first." },
  { key: "empty", label: "Welcome: no workspace yet", note: "A new account (any Google account or email): explore the synthetic example, or set up an agency or company to check its own files. An invitation link joins an existing one." },
  { key: "switching", label: "Switching", note: "After choosing: the old agency's content is cleared and the page says it is switching." },
  { key: "loading", label: "Loading", note: "The list has not arrived: the place is held and announced." },
  { key: "error", label: "Could not load", note: "The list could not be read: try again; nothing else is shown." },
];

const STATE_LABEL = { DRAFT: "In setup", ACTIVE: "Active", RESTRICTED: "Restricted", CLOSING: "Closing", CLOSED: "Closed" } as const;
const STATE_TONE = { DRAFT: "neutral", ACTIVE: "success", RESTRICTED: "warning", CLOSING: "warning", CLOSED: "neutral" } as const;
const ROLE_LINE: Readonly<Record<Role, string>> = {
  OWNER: "You own it",
  ADMIN: "You run its team and clients",
  OPERATOR: "You work on its projects",
  APPROVER: "You approve its plans",
  BILLING: "You handle its billing",
  VIEWER: "You can read it",
};

interface Row {
  readonly agencyId: string;
  readonly name: string;
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
          return workspace === undefined ? [] : [{ agencyId: workspace.agencyId, name: workspace.name, role: membership.role, state: workspace.state, suspended: membership.state === "SUSPENDED" }];
        });
  const current = rows[0] ?? null;
  const hasDraft = rows.some((row) => row.state === "DRAFT" && row.role === "OWNER");
  const open = (row: Row): void => {
    setSwitching(row);
    // the real switch is a full navigation after the old agency's content is cleared; the review shows the same pause
    window.setTimeout(() => router.push(`/agencies/${row.agencyId}/projects`), 900);
  };
  const target = state === "switching" ? (rows[1] ?? null) : switching;

  if (target !== null)
    return (
      <div className="kauro-switching" role="status">
        <h1 className="kauro-visually-hidden">Your workspaces</h1>
        <Monogram name={target.name} />
        <p>
          Opening <bdi>{target.name}</bdi>…
        </p>
        <p className="kauro-muted">What you had open from another agency has been cleared.</p>
      </div>
    );

  if (rows.length === 0 && state !== "loading" && state !== "error") return <Welcome ctx={ctx} />;

  return (
    <>
      <PageHead eyebrow="Signed in" title="Your workspaces" accent={1} lead="Choose the workspace you are working in." />
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
                      {ROLE_NAME[row.role]} · {ROLE_LINE[row.role]}
                    </span>
                  </span>
                  <span className="kauro-workspace-state">
                    {here ? <span className="kauro-here">Where you are</span> : null}
                    {row.suspended ? <Badge tone="danger">Your access is suspended</Badge> : <Badge tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</Badge>}
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
      <PageHead eyebrow="Your account is ready" title="Welcome to Kauro." lead="See exactly what you would receive, then check your own files for free when you are ready." />
      <div className="kauro-welcome">
        <section className="kauro-welcome-start" aria-labelledby="welcome-start-h">
          <h2 id="welcome-start-h">Check your own files</h2>
          <ol className="kauro-welcome-steps">
            <li>
              <strong>Set up your agency or company</strong>
              <span>Its name, who buys, and the agreements. About a minute.</span>
            </li>
            <li>
              <strong>Upload your exports</strong>
              <span>CSV or spreadsheet files of contacts, companies and deals.</span>
            </li>
            <li>
              <strong>Read your free data health check</strong>
              <span>What Kauro found in your files, and the exact price to prepare them.</span>
            </li>
          </ol>
          <ScreenButton to="UI09" ctx={ctx} variant="primary">
            <span className="kauro-go">Set up your agency or company</span>
          </ScreenButton>
          <ul className="kauro-checklist kauro-welcome-promises" aria-label="What Kauro promises">
            <li>An exact quote before you pay anything</li>
            <li>You approve every change before it is prepared</li>
            <li>Kauro never connects to your CRM</li>
            <li>
              Unless you buy, your files are deleted {UNPAID_RETENTION.days} days after the check, {UNPAID_RETENTION.hardDays} at the latest
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
