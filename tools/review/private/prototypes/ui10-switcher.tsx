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
import { appPathOf, type PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { MEMBERSHIPS, workspaceOf } from "../lib/world.ts";
import { Badge, Monogram, PageHead, ROLE_NAME, type Role, ScreenButton, ScreenLink } from "./kit.tsx";

export const UI10_STATES: readonly StateDef[] = [
  { key: "normal", label: "Several agencies", note: "Every membership with its role and state; where the person works now is said first." },
  { key: "empty", label: "No agency yet", note: "Signed in without any membership: set up an organisation or use an invitation." },
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
        <h1 className="kauro-visually-hidden">Your agencies</h1>
        <Monogram name={target.name} />
        <p>
          Opening <bdi>{target.name}</bdi>…
        </p>
        <p className="kauro-muted">What you had open from another agency has been cleared.</p>
      </div>
    );

  return (
    <>
      <PageHead eyebrow="Signed in" title="Your agencies" accent={1} lead="Choose the agency you are working with." />
      {state === "loading" ? (
        <div className="kauro-state" role="status">
          <p>Loading your agencies…</p>
        </div>
      ) : state === "error" ? (
        <div className="kauro-state" role="alert">
          <h2>Your agencies could not be loaded</h2>
          <p>Nothing is shown until the list is read. Try again in a moment.</p>
          <Button>Try again</Button>
        </div>
      ) : rows.length === 0 ? (
        <section className="kauro-panel kauro-switch-empty" aria-labelledby="switch-empty">
          <h2 id="switch-empty">You are not part of an agency yet</h2>
          <p>Set up your own organisation, or open the invitation link an agency sent you. An email address never adds you to an agency on its own.</p>
          <div className="kauro-actions">
            <ScreenButton to="UI09" ctx={ctx} variant="primary">
              <span className="kauro-go">Set up an organisation</span>
            </ScreenButton>
            <ScreenButton to="UI51" ctx={ctx}>
              I have an invitation
            </ScreenButton>
          </div>
        </section>
      ) : (
        <>
          <ul className="kauro-workspaces" aria-label="Agencies you belong to">
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
                One organisation is already in setup. <ScreenLink to="UI09" ctx={ctx}>Finish it</ScreenLink> before starting another.
              </>
            ) : (
              <>
                Need another workspace? <ScreenLink to="UI09" ctx={ctx}>Set up an organisation</ScreenLink>. You become its owner.
              </>
            )}
          </p>
        </>
      )}
    </>
  );
}
