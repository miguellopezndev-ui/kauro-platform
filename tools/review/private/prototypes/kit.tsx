"use client";
// The pieces the private pages share (Order 11, docs/design/ORDER11-PRIVATE-DESIGN.md): the design system's primitives (@kauro/ui) and the
// few elements the brief adds to the application register, each taken from the public site so the product fulfils the picture the site
// drew: the eyebrow with its rule, the two-weight heading, the carbon window with its stage rings, the stamp for a verdict, and the
// editor's note. Everything a prototype draws is synthetic; dates are fixed so a screenshot is the same every time.
import { LinkButton, StatusBadge, type ButtonVariant, type Tone } from "@kauro/ui";
import Link from "next/link";
import type { ReactElement, ReactNode } from "react";
import type { ReviewContext } from "../lib/contexts.ts";
import { appPathOf } from "../lib/screens.tsx";

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

/** 2026-09-14T10:00:00Z → "Sep 14, 2026" (UTC, so the review reads the same everywhere; the design system's format). */
export function day(iso: string): string {
  const date = new Date(iso);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** 2026-09-14T10:05:00Z → "Sep 14, 2026, 10:05 AM UTC", the design system's format (formatDeadline). */
export function moment(iso: string): string {
  const date = new Date(iso);
  const hour = date.getUTCHours();
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${day(iso)}, ${twelve}:${String(date.getUTCMinutes()).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"} UTC`;
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

/** Where the page is: the workspace, then the section. Small caps in the primary colour, after a short rule, as on the public site. */
export function Eyebrow({ children }: { readonly children: ReactNode }): ReactElement {
  return <p className="kauro-eyebrow">{children}</p>;
}

/**
 * The opening of a page: eyebrow, one h1, and the lead, which is the registry's own sentence. `accent` sets the heading's last words light
 * in the primary colour (the public site's two-weight heading), only on the pages that open a path.
 */
export function PageHead({ eyebrow, title, accent = 0, lead, aside }: { readonly eyebrow?: ReactNode; readonly title: string; readonly accent?: number; readonly lead?: ReactNode; readonly aside?: ReactNode }): ReactElement {
  const words = title.split(" ");
  const head = accent > 0 && accent < words.length ? words.slice(0, words.length - accent).join(" ") : title;
  const tail = accent > 0 && accent < words.length ? words.slice(words.length - accent).join(" ") : null;
  return (
    <header className={aside === undefined ? "kauro-pagehead" : "kauro-pagehead kauro-pagehead--aside"}>
      <div>
        {eyebrow === undefined ? null : <Eyebrow>{eyebrow}</Eyebrow>}
        <h1>
          {head}
          {tail === null ? null : (
            <>
              {" "}
              <span className="kauro-accent">{tail}</span>
            </>
          )}
        </h1>
        {lead === undefined ? null : <p className="kauro-lead">{lead}</p>}
      </div>
      {aside === undefined ? null : <div className="kauro-pagehead-aside">{aside}</div>}
    </header>
  );
}

/** The product's window (the public Home's picture made real): a carbon bar with the wordmark, what it holds, and its state. */
export function Window({ title, state, stateTone = "neutral", children, className }: { readonly title: ReactNode; readonly state?: ReactNode; readonly stateTone?: "neutral" | "done" | "attention"; readonly children: ReactNode; readonly className?: string }): ReactElement {
  return (
    <div className={className === undefined ? "kauro-window" : `kauro-window ${className}`}>
      <div className="kauro-window-bar">
        <span className="kauro-window-brand">Kauro</span>
        <span className="kauro-window-title">{title}</span>
        {state === undefined ? null : <span className={`kauro-window-state kauro-window-state--${stateTone}`}>{state}</span>}
      </div>
      <div className="kauro-window-body">{children}</div>
    </div>
  );
}

export type RingState = "done" | "current" | "waiting" | "blocked";

/** A list of stages or readiness checks, each a ring with a word and its fact on the right (the public window's progress list). */
export function Rings({ items, label }: { readonly label?: string; readonly items: ReadonlyArray<{ readonly key: string; readonly name: ReactNode; readonly fact?: ReactNode; readonly state: RingState }> }): ReactElement {
  return (
    <>
      {label === undefined ? null : <p className="kauro-window-label">{label}</p>}
      <ol className="kauro-rings">
        {items.map((item) => (
          <li key={item.key} className={`kauro-ring kauro-ring--${item.state}`} aria-current={item.state === "current" ? "step" : undefined}>
            <span className="kauro-ring-name">
              {item.name}
              <span className="kauro-visually-hidden">{item.state === "done" ? " (done)" : item.state === "current" ? " (now)" : item.state === "blocked" ? " (not available yet)" : " (later)"}</span>
            </span>
            {item.fact === undefined ? null : <span className="kauro-ring-fact">{item.fact}</span>}
          </li>
        ))}
      </ol>
    </>
  );
}

/** A verdict, stamped (one per page at most, and never instead of the words). */
export function Stamp({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <p className="kauro-stamp" aria-hidden="true">
      {children}
    </p>
  );
}

/** The editor's note: where a person may hesitate, one quiet sentence in the editor's italic. At most one per page. */
export function Note({ children }: { readonly children: ReactNode }): ReactElement {
  return <p className="kauro-note">{children}</p>;
}

/** A link to another screen of the application, at its real path (the review serves every private path, as the product will). */
export function ScreenLink({ to, ctx, project, children }: { readonly to: string; readonly ctx: ReviewContext; readonly project?: string; readonly children: ReactNode }): ReactElement {
  return <Link href={appPathOf(to, ctx, project)}>{children}</Link>;
}

export function ScreenButton({ to, ctx, project, variant = "secondary", children }: { readonly to: string; readonly ctx: ReviewContext; readonly project?: string; readonly variant?: ButtonVariant; readonly children: ReactNode }): ReactElement {
  return (
    <LinkButton href={appPathOf(to, ctx, project)} variant={variant}>
      {children}
    </LinkButton>
  );
}

/** The monogram a workspace shows until it has a logo: its initials on wine. */
export function Monogram({ name }: { readonly name: string }): ReactElement {
  const initials = name
    .split(/[\s&]+/)
    .filter((word) => word.length > 0)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span className="kauro-monogram" aria-hidden="true">
      {initials}
    </span>
  );
}
