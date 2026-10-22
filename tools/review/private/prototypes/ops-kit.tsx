"use client";
// The pieces the owner's and the seller's consoles share (Order 11, round 2; research round2/owner-console.md, seller-portal.md,
// principles-craft.md). Each one carries a craft rule so a page cannot break it by accident:
//   - OpsHead: one h1 at the app size, a status word beside it, one lead sentence, at most one action (the page's primary) on the right.
//   - Queue: what needs the person, one row each (what, why, when, one action); only the first row may carry the filled button.
//   - Figures: a set of equal figures, one size, one weight, one structure (label, value, note), in one row of 2 to 4.
//   - Filter: a row of toggles with counts; a zero count is never drawn (the option disappears).
//   - Money in a sentence is "USD 1,295.00"; in a table the currency sits in the header and the cell holds "1,295.00", right-aligned.
import { LinkButton, StatusBadge, type Tone } from "@kauro/ui";
import Link from "next/link";
import { type ReactElement, type ReactNode } from "react";
import { pathOf } from "@web/screens.ts";
import type { ReviewContext } from "../lib/contexts.ts";
import { appPathOf } from "../lib/screens.tsx";

/**
 * Where the console's pages live. The registry's screens keep their routes; the pages round 2 adds (Sellers, Payouts, Customers, Claims,
 * Settings) are proposals at the paths owner-console.md §10.2 gives them, served by the review only.
 */
export const OPS_PATH = {
  today: pathOf("UI33"),
  finance: pathOf("UI39"),
  payouts: "/ops/money/payouts",
  customers: "/ops/customers",
  customer: (id: string): string => pathOf("UI35", { id }),
  sellers: "/ops/sales/sellers",
  seller: (id: string): string => pathOf("UI37", { id }),
  claims: "/ops/sales/claims",
  statements: (sellerId?: string): string => (sellerId === undefined ? pathOf("UI36") : `${pathOf("UI36")}?seller=${sellerId}`),
  prospects: pathOf("UI34"),
  outreach: pathOf("UI54"),
  resources: pathOf("UI53"),
  support: pathOf("UI55"),
  jobs: pathOf("UI40"),
  deletion: pathOf("UI41"),
  incidents: pathOf("UI42"),
  releases: pathOf("UI43"),
  review: pathOf("UI44"),
  actions: pathOf("UI38"),
  settings: "/ops/settings",
} as const;

/** The console's pages, scoped so their type and spacing rules apply to them only. */
export function OpsPage({ children }: { readonly children: ReactNode }): ReactElement {
  return <div className="kauro-ops">{children}</div>;
}

/** The parent page, above the h1 (a page inside a list: a seller, a customer, a statement). */
export function Back({ href, children }: { readonly href: string; readonly children: ReactNode }): ReactElement {
  return (
    <p className="kauro-ops-back">
      <Link href={href} prefetch={false}>
        <span aria-hidden="true">‹&nbsp;</span>
        {children}
      </Link>
    </p>
  );
}

export function OpsHead({ back, title, badge, lead, action }: { readonly back?: ReactNode; readonly title: string; readonly badge?: ReactNode; readonly lead?: ReactNode; readonly action?: ReactNode }): ReactElement {
  return (
    <header className={action === undefined ? "kauro-ops-head" : "kauro-ops-head kauro-ops-head--action"}>
      {back}
      <div className="kauro-ops-head-title">
        <h1>{title}</h1>
        {badge}
      </div>
      {lead === undefined ? null : <p className="kauro-ops-lead">{lead}</p>}
      {action === undefined ? null : <div className="kauro-ops-head-action">{action}</div>}
    </header>
  );
}

export function Word({ tone, children }: { readonly tone: Tone; readonly children: ReactNode }): ReactElement {
  return <StatusBadge tone={tone}>{children}</StatusBadge>;
}

/** A section's heading with, on the right, its one link (never a second button). */
export function SectionHead({ id, title, meta, aside }: { readonly id: string; readonly title: ReactNode; readonly meta?: ReactNode; readonly aside?: ReactNode }): ReactElement {
  return (
    <div className="kauro-ops-section-head">
      <div>
        <h2 id={id}>{title}</h2>
        {meta === undefined ? null : <p className="kauro-ops-meta">{meta}</p>}
      </div>
      {aside === undefined ? null : <div className="kauro-ops-section-aside">{aside}</div>}
    </div>
  );
}

export interface QueueItem {
  readonly key: string;
  readonly what: ReactNode;
  readonly why: ReactNode;
  readonly due: ReactNode;
  /** True when the due date is today or past: the word "Today" carries it, never colour alone. */
  readonly urgent?: boolean;
  readonly action: { readonly label: string; readonly href: string };
}

/** What needs the person, ordered by when it is due, then by consequence. The first row's action is filled only when it is due today. */
export function Queue({ items, label }: { readonly items: readonly QueueItem[]; readonly label: string }): ReactElement {
  return (
    <ol className="kauro-ops-queue" aria-label={label}>
      {items.map((item, index) => (
        <li key={item.key}>
          <div className="kauro-ops-queue-main">
            <p className="kauro-ops-queue-what">{item.what}</p>
            <p className="kauro-ops-queue-why">{item.why}</p>
          </div>
          <p className={item.urgent === true ? "kauro-ops-queue-due is-urgent" : "kauro-ops-queue-due"}>{item.due}</p>
          <div className="kauro-ops-queue-action">
            <LinkButton href={item.action.href} variant={index === 0 && item.urgent === true ? "primary" : "secondary"}>
              {item.action.label}
            </LinkButton>
          </div>
        </li>
      ))}
    </ol>
  );
}

export interface Figure {
  readonly label: string;
  readonly value: string;
  readonly note: ReactNode;
  readonly href?: string;
}

/** A set of equal figures: same size, same weight, same rows in the same order (V14, V15). */
export function Figures({ items, label }: { readonly items: readonly Figure[]; readonly label: string }): ReactElement {
  return (
    <dl className={`kauro-ops-figures kauro-ops-figures--${items.length}`} aria-label={label}>
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd className="kauro-ops-figure">
            {item.href === undefined ? (
              item.value
            ) : (
              <Link href={item.href} prefetch={false}>
                {item.value}
              </Link>
            )}
          </dd>
          <dd className="kauro-ops-figure-note">{item.note}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface FilterOption<K extends string> {
  readonly key: K;
  readonly label: string;
  readonly count?: number;
}

/** A row of toggles that filters what follows. An option with a count of zero is not drawn. */
export function Filter<K extends string>({ label, options, value, onChange }: { readonly label: string; readonly options: readonly FilterOption<K>[]; readonly value: K; readonly onChange: (key: K) => void }): ReactElement {
  return (
    <div className="kauro-ops-filter" role="group" aria-label={label}>
      {options
        .filter((option) => option.count === undefined || option.count > 0)
        .map((option) => (
          <button key={option.key} type="button" aria-pressed={option.key === value} onClick={() => onChange(option.key)}>
            {option.label}
            {option.count === undefined ? null : <span className="kauro-ops-filter-count">{option.count}</span>}
          </button>
        ))}
    </div>
  );
}

/** A kind of setting, said in words: what it is backed by. */
export function Kind({ kind, children }: { readonly kind: "live" | "read" | "backend"; readonly children: ReactNode }): ReactElement {
  return <p className={`kauro-ops-kind kauro-ops-kind--${kind}`}>{children}</p>;
}

/** A link to another screen of the application at its real path. */
export const pathTo = (id: string, ctx: ReviewContext): string => appPathOf(id, ctx);

/** A tone for a figure's note that needs attention, with its word (never colour alone). */
export function Attention({ children }: { readonly children: ReactNode }): ReactElement {
  return <span className="kauro-ops-attention">{children}</span>;
}

/**
 * Alerts (owner, 2026-10-21): three labelled kinds, said in words, never by colour alone. Inactivity flags 14 days without relevant progress,
 * whatever the deadlines; a deadline alerts 2 days before it, or at once once it has passed, whatever the activity; blocked means the next
 * step cannot happen. An item appears once, under its most urgent kind (blocked, then deadline passed, then deadline within 2 days, then
 * inactivity); its other conditions are its second line.
 */
export type AlertKind = "BLOCKED" | "DEADLINE_PASSED" | "DEADLINE_SOON" | "INACTIVE";
const ALERT_RANK: Readonly<Record<AlertKind, number>> = { BLOCKED: 0, DEADLINE_PASSED: 1, DEADLINE_SOON: 2, INACTIVE: 3 };
export const ALERT_WORD: Readonly<Record<AlertKind, string>> = { BLOCKED: "Blocked", DEADLINE_PASSED: "Deadline passed", DEADLINE_SOON: "Deadline in 2 days", INACTIVE: "Inactive 14 days" };
const ALERT_TONE: Readonly<Record<AlertKind, Tone>> = { BLOCKED: "danger", DEADLINE_PASSED: "danger", DEADLINE_SOON: "warning", INACTIVE: "neutral" };

export interface AlertItem {
  readonly key: string;
  readonly kind: AlertKind;
  readonly what: string;
  readonly href?: string;
  readonly detail: ReactNode;
  /** The item's other conditions, in words (never a second alert). */
  readonly also?: string;
}

export function Alerts({ items, label }: { readonly items: readonly AlertItem[]; readonly label: string }): ReactElement {
  const sorted = [...items].sort((a, b) => ALERT_RANK[a.kind] - ALERT_RANK[b.kind]);
  return (
    <ul className="kauro-ops-alerts" aria-label={label}>
      {sorted.map((item) => (
        <li key={item.key}>
          <span className="kauro-ops-alert-kind">
            <StatusBadge tone={ALERT_TONE[item.kind]}>{ALERT_WORD[item.kind]}</StatusBadge>
          </span>
          <div>
            <p className="kauro-ops-alert-what">
              {item.href === undefined ? (
                item.what
              ) : (
                <Link href={item.href} prefetch={false}>
                  {item.what}
                </Link>
              )}
            </p>
            <p className="kauro-ops-alert-detail">{item.detail}</p>
            {item.also === undefined ? null : <p className="kauro-ops-alert-also">Also: {item.also}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** A rule whose legal validation is pending (owner, 2026-10-21): never shown as final on the owner's screens. */
export function PendingLegal(): ReactElement {
  return <span className="kauro-ops-legal">Pending legal review</span>;
}
