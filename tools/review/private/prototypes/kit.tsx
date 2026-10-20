"use client";
// Small pieces the prototypes share (Order 11): the same primitives the implemented screens use (@kauro/ui), plus the few layouts the
// web does not have yet. Everything a prototype draws is synthetic; dates are fixed so a screenshot is the same every time.
import { LinkButton, StatusBadge, type ButtonVariant, type Tone } from "@kauro/ui";
import type { ReactElement, ReactNode } from "react";
import type { ReviewContext } from "../lib/contexts.ts";
import { viewerHref } from "../lib/links.ts";

export type Role = "OWNER" | "ADMIN" | "OPERATOR" | "APPROVER" | "VIEWER" | "BILLING";

export const ROLE_NAME: Readonly<Record<Role, string>> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  OPERATOR: "Operator",
  APPROVER: "Approver",
  VIEWER: "Viewer",
  BILLING: "Billing",
};

/** What each role may do (B06 D-AUTHZ-1), in the words a member reads. */
export const ROLE_SCOPE: Readonly<Record<Role, string>> = {
  OWNER: "Everything, including ownership, closure and approvals.",
  ADMIN: "Team, clients, projects, branding and deletion requests. Never approval or billing.",
  OPERATOR: "Clients and projects: upload, select, seal, check, plan and run.",
  APPROVER: "Approves or withdraws plans and continues staged imports.",
  BILLING: "Quotes, payments and refunds.",
  VIEWER: "Reads, downloads delivered packages and opens support cases.",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 2026-09-14T10:00:00Z → "14 Sep 2026" (UTC, so the review reads the same everywhere). */
export function day(iso: string): string {
  const date = new Date(iso);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** 2026-09-14T10:05:00Z → "14 Sep 2026, 10:05 UTC". */
export function moment(iso: string): string {
  const date = new Date(iso);
  return `${day(iso)}, ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
}

export function Facts({ rows }: { readonly rows: ReadonlyArray<readonly [label: ReactNode, value: ReactNode]> }): ReactElement {
  return (
    <dl>
      {rows.map(([label, value], index) => (
        <div key={index}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Badge({ tone, children }: { readonly tone: Tone; readonly children: ReactNode }): ReactElement {
  return <StatusBadge tone={tone}>{children}</StatusBadge>;
}

/** A page whose heading and lead come first, the way every application screen opens. */
export function Page({ title, lead, children }: { readonly title: string; readonly lead?: ReactNode; readonly children: ReactNode }): ReactElement {
  return (
    <>
      <h1>{title}</h1>
      {lead === undefined ? null : <p className="kauro-lead">{lead}</p>}
      {children}
    </>
  );
}

/** A link to another screen of the application. In review it opens that screen's viewer as the same person; in the product it is the route. */
export function ScreenLink({ to, ctx, children }: { readonly to: string; readonly ctx: ReviewContext; readonly children: ReactNode }): ReactElement {
  return (
    <a href={viewerHref(to, ctx.key)} target="_top">
      {children}
    </a>
  );
}

export function ScreenButton({ to, ctx, variant = "secondary", children }: { readonly to: string; readonly ctx: ReviewContext; readonly variant?: ButtonVariant; readonly children: ReactNode }): ReactElement {
  return (
    <LinkButton href={viewerHref(to, ctx.key)} target="_top" variant={variant}>
      {children}
    </LinkButton>
  );
}
