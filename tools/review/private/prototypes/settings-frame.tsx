"use client";
// The frame of a settings page (Order 11 round 2; research app-shell-settings.md §9.10, signed-in-notes.md): two scopes, each named in a
// context line above the page's heading ("Your account", "Workspace settings · Northwind Data"), then the h1 (the page's name) and one line
// that says who a change here reaches ("These settings only apply to you." HubSpot states its scope the same way; it answers the most
// common settings question, "who else does this change?"). The scope's pages are a vertical list beside the content from 1012 px (Asana's
// 2026 vertical tabs, "easier to scan") and a plain list above it on a phone: a second level, never a third. Each page is a review state,
// so the list's links are the review's own addresses for this person.
import Link from "next/link";
import type { ReactElement, ReactNode } from "react";
import type { ReviewContext } from "../lib/contexts.ts";
import { stateHref } from "../lib/links.ts";
import { type Role, Scope } from "./kit.tsx";
import { type Person, teamOf } from "./people.ts";

export interface SettingsPage {
  /** The review state that draws the page. */
  readonly key: string;
  readonly label: string;
}

export function SettingsFrame({ ctx, path, proposal, context, pages, current, title, scope, children }: { readonly ctx: ReviewContext; readonly path: string; readonly proposal?: string; readonly context: ReactNode; readonly pages: readonly SettingsPage[]; readonly current: string; readonly title: string; readonly scope: ReactNode; readonly children: ReactNode }): ReactElement {
  return (
    <div className="kauro-settings">
      <header className="kauro-settings-head">
        <p className="kauro-settings-context">{context}</p>
        <h1>{title}</h1>
        <Scope>{scope}</Scope>
      </header>
      <div className="kauro-settings-body">
        <nav className="kauro-settings-nav" aria-label="Settings pages">
          <ul>
            {pages.map((page) => (
              <li key={page.key}>
                <Link href={stateHref(path, ctx.key, page.key, proposal)} prefetch={false} {...(page.key === current ? { "aria-current": "page" as const } : {})}>
                  {page.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="kauro-settings-page">{children}</div>
      </div>
    </div>
  );
}

const ROLE_OF: Readonly<Partial<Record<string, Role>>> = { agency: "OWNER", company: "OWNER", admin: "ADMIN", operator: "OPERATOR", approver: "APPROVER", billing: "BILLING", viewer: "VIEWER" };

/** The person the review shows the application to, as the team lists them; a new account has no workspace yet. */
export function personOf(ctx: ReviewContext): Person {
  const role = ROLE_OF[ctx.key];
  const found = role === undefined ? undefined : teamOf(ctx).find((person) => person.role === role);
  return found ?? { name: "Ana Silva", role: "VIEWER", email: "ana.silva@gmail.example" };
}

/** What a page needs before it can be built: a contract or a read the api does not have yet, said once where it applies. */
export function Needs({ children }: { readonly children: ReactNode }): ReactElement {
  return <p className="kauro-proposed kauro-a-proposed">{children}</p>;
}
