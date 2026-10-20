"use client";
// UI10 Agency switcher (registry: "Choose the agency you are working with."). Lists only the person's actual memberships with a safe role
// label (ListAgencies → AgencyMembershipView: name, agency state, role, membership state), keeps the current context visible, and offers to
// create an organisation when the person may (one draft at a time, CMD001). Switching is a full navigation: the page first clears what it
// showed of the previous agency and says it is switching, so nothing of the old tenant can be seen on the way (registry exceptions).
import { Button } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, ROLE_NAME, type Role, ScreenButton, ScreenLink } from "./kit.tsx";

export const UI10_STATES: readonly StateDef[] = [
  { key: "normal", label: "Several agencies", note: "Every membership with its role and state; the current one is marked." },
  { key: "single", label: "One agency", note: "A person with one membership (a company buying for itself usually has one)." },
  { key: "empty", label: "No agency yet", note: "Signed in without any membership: set up an organisation or use an invitation." },
  { key: "switching", label: "Switching", note: "After choosing: the old agency's content is cleared and the page says it is switching." },
  { key: "many", label: "Many agencies", note: "A long list is paged (25 at a time); the person can show more." },
  { key: "loading", label: "Loading", note: "The list has not arrived: the place is held and announced." },
  { key: "error", label: "Could not load", note: "The list could not be read: try again, nothing else is shown." },
];

interface Row {
  readonly name: string;
  readonly role: Role;
  readonly agencyState: "DRAFT" | "ACTIVE" | "RESTRICTED" | "CLOSING" | "CLOSED";
  readonly membership: "ACTIVE" | "INVITED" | "SUSPENDED";
  readonly current?: boolean;
}

const AGENCY_ROWS: readonly Row[] = [
  { name: "Northwind Data", role: "OWNER", agencyState: "ACTIVE", membership: "ACTIVE", current: true },
  { name: "Coastline Analytics", role: "OPERATOR", agencyState: "ACTIVE", membership: "ACTIVE" },
  { name: "Ridge & Fennel Consulting", role: "VIEWER", agencyState: "RESTRICTED", membership: "ACTIVE" },
  { name: "Juniper Digital", role: "APPROVER", agencyState: "ACTIVE", membership: "SUSPENDED" },
  { name: "Northwind Labs", role: "OWNER", agencyState: "DRAFT", membership: "ACTIVE" },
];

const STATE_LABEL = { DRAFT: "Draft", ACTIVE: "Active", RESTRICTED: "Restricted", CLOSING: "Closing", CLOSED: "Closed" } as const;
const STATE_TONE = { DRAFT: "neutral", ACTIVE: "success", RESTRICTED: "warning", CLOSING: "warning", CLOSED: "neutral" } as const;

function more(): readonly Row[] {
  const names = ["Atlas Revenue Ops", "Bramble Partners", "Cobalt CRM Studio", "Delta Growth", "Ember Data Co", "Fjord Advisory", "Granite Sales Lab", "Harbour Metrics", "Iris Pipeline", "Kestrel Analytics", "Lumen Ops", "Meridian Data", "Nimbus Partners", "Oakline Digital", "Pioneer CRM", "Quarry Insight", "Rowan & Co", "Sable Systems", "Tidewater Group", "Umber Analytics"];
  return [...AGENCY_ROWS.slice(0, 4), ...names.map((name, index) => ({ name, role: (["OPERATOR", "VIEWER", "APPROVER", "BILLING"] as const)[index % 4] ?? "VIEWER", agencyState: "ACTIVE" as const, membership: "ACTIVE" as const })), AGENCY_ROWS[4] as Row];
}

export function AgencySwitcher({ ctx, state }: PrototypeProps): ReactElement {
  const company = ctx.key === "company";
  const [switching, setSwitching] = useState<string | null>(state === "switching" ? "Coastline Analytics" : null);
  const rows: readonly Row[] =
    state === "empty" ? [] : state === "single" || company ? [{ name: company ? "Halden Outdoor" : "Northwind Data", role: "OWNER", agencyState: "ACTIVE", membership: "ACTIVE", current: true }] : state === "many" ? more() : AGENCY_ROWS;
  const hasDraft = rows.some((row) => row.agencyState === "DRAFT" && row.role === "OWNER");

  if (switching !== null)
    return (
      <>
        <h1>Your agencies</h1>
        <div className="kauro-state" role="status">
          <h2>Switching to {switching}</h2>
          <p>The previous agency&apos;s content has been cleared. {switching} opens in a moment.</p>
        </div>
      </>
    );

  return (
    <>
      <h1>Your agencies</h1>
      <p className="kauro-lead">Choose the agency you are working with.</p>
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
        <div className="kauro-empty">
          <h2>You are not a member of any agency yet</h2>
          <p>Set up your own organisation, or open the invitation link an agency sent you. An email address never adds you to an agency on its own.</p>
          <div className="kauro-actions">
            <ScreenButton to="UI09" ctx={ctx} variant="primary">
              Set up an organisation
            </ScreenButton>
            <ScreenButton to="UI51" ctx={ctx}>
              I have an invitation
            </ScreenButton>
          </div>
        </div>
      ) : (
        <>
          {rows.some((row) => row.current) ? (
            <p className="kauro-current">
              You are working in <bdi>{rows.find((row) => row.current)?.name}</bdi> as {ROLE_NAME[rows.find((row) => row.current)?.role ?? "VIEWER"]}.
            </p>
          ) : null}
          <ul className="kauro-agency-list" aria-label="Agencies you belong to">
            {rows.map((row) => (
              <li key={row.name} className={row.current === true ? "is-current" : undefined}>
                <div className="kauro-agency-row-main">
                  <bdi className="kauro-agency-row-name">{row.name}</bdi>
                  <span className="kauro-agency-row-meta">
                    Your role: <strong>{ROLE_NAME[row.role]}</strong>
                  </span>
                </div>
                <div className="kauro-agency-row-state">
                  <Badge tone={STATE_TONE[row.agencyState]}>{STATE_LABEL[row.agencyState]}</Badge>
                  {row.membership === "SUSPENDED" ? <Badge tone="danger">Your access is suspended</Badge> : null}
                </div>
                <div className="kauro-agency-row-action">
                  {row.current === true ? (
                    <span className="kauro-muted">Current</span>
                  ) : row.membership === "SUSPENDED" ? (
                    <span className="kauro-muted">Ask an owner of this agency</span>
                  ) : row.agencyState === "DRAFT" ? (
                    <ScreenButton to="UI09" ctx={ctx}>
                      Continue setup
                    </ScreenButton>
                  ) : (
                    <Button onClick={() => setSwitching(row.name)}>Open</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {state === "many" ? (
            <div className="kauro-pager">
              <p>Showing 25 of 31 agencies.</p>
              <Button>Show more</Button>
            </div>
          ) : null}
          <section className="kauro-create" aria-labelledby="switcher-create">
            <h2 id="switcher-create">Another organisation</h2>
            {hasDraft ? (
              <p>
                You already have one organisation in setup. <ScreenLink to="UI09" ctx={ctx}>Continue setting it up</ScreenLink> before starting another.
              </p>
            ) : (
              <>
                <p>Set up a new agency or company workspace. You become its owner; it starts as a draft until its agreements are accepted.</p>
                <ScreenButton to="UI09" ctx={ctx}>
                  Set up an organisation
                </ScreenButton>
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}
