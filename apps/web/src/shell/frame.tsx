// The frames of the application (design D-A11Y-1, D-DS-3, D-SEC-1, D-PRIV-1): the menu with the workspace indicator, the navigation and the
// one <main> (landmarks.tsx) every screen renders into. Order 11: a signed-in person works with the menu at the side, as the products they
// already use do (Linear, Stripe, Attio, Vercel): the workspace and its switch at the top, the screens in groups, help and the person's own
// controls at the foot. On a phone the menu folds behind one button. A page without a person (sign-in, invitation) keeps a plain header.
// The frames draw what `viewOf` answers and nothing else, hold no session and read no network, so the same components render on the
// server, in the browser and in a node test. Screens render their own <h1> and content and never their own <main>: the frame owns the
// landmark the skip link points at.
//   - Customer strings (the agency name) are text nodes inside <bdi>, never markup (D-DS-3).
//   - No inline style and no script: the look is shell.css (D-SEC-1).
//   - Waiting is announced by one polite live region that exists before its text does; a refusal takes focus once, on its heading.
//   - Navigation links are not prefetched (D-PRIV-1): a link that fetches on sight would load a screen's private data before it is asked for.
import { type ComponentType, createContext, type ReactElement, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { message } from "../copy/en.ts";
import { Main, SkipLink } from "./landmarks.tsx";
import { ThemeChoice } from "./theme-control.tsx";
import type { NavigationItem, ProjectInView, RefusedAction, ShellView } from "./view.ts";

export interface AnchorProps {
  readonly href: string;
  readonly prefetch: false;
  readonly "aria-current"?: "page";
  readonly children: ReactNode;
}

export type AnchorComponent = ComponentType<AnchorProps>;

/** A plain anchor: the fallback of a test and of a server render that has no client router. */
export const PlainAnchor: AnchorComponent = ({ href, "aria-current": current, children }: AnchorProps) => (
  <a href={href} {...(current === undefined ? {} : { "aria-current": current })}>
    {children}
  </a>
);

/** The anchor of the running frame, for the links a screen draws inside it: the router's in the app, a plain one elsewhere. */
export const AnchorContext = createContext<AnchorComponent>(PlainAnchor);

/** The project the page is inside, as the frame read it for the menu: the project's header names it from here. */
export const ProjectContext = createContext<Pick<ProjectInView, "name" | "clientLabel" | "mode"> | null>(null);

/** A project's areas, nested under Projects: its work in order, then, apart, its activity and the data it keeps. */
function ProjectAreas({ project, Link }: { readonly project: ProjectInView; readonly Link: AnchorComponent }): ReactElement {
  const work = project.areas.filter((area) => !area.apart);
  const apart = project.areas.filter((area) => area.apart);
  const item = (area: ProjectInView["areas"][number]): ReactElement => (
    <li key={area.key}>
      <Link href={area.href} prefetch={false} {...(area.current ? { "aria-current": "page" as const } : {})}>
        {message(area.label)}
      </Link>
    </li>
  );
  return (
    <div className="kauro-shell-project">
      <p className="kauro-shell-project-name">
        <bdi>{project.name}</bdi>
      </p>
      <ul aria-label={message("nav.project.label")}>{work.map(item)}</ul>
      {apart.length === 0 ? null : <ul className="kauro-shell-project-apart">{apart.map(item)}</ul>}
    </div>
  );
}

export interface ShellActions {
  readonly signOut: () => void;
  readonly checkAgain: () => void;
}

function Refused({ title, body, action, Anchor, actions }: { readonly title: string; readonly body: string; readonly action: RefusedAction; readonly Anchor: AnchorComponent; readonly actions: ShellActions }): ReactElement {
  const heading = useRef<HTMLHeadingElement>(null);
  // a refusal replaces the page's content: the person's place is its heading (the effect does not run on the server)
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section className="kauro-refused" aria-labelledby="kauro-refused-title">
      <h1 id="kauro-refused-title" ref={heading} tabIndex={-1}>
        {title}
      </h1>
      <p>{body}</p>
      {action.kind === "SIGN_IN" ? (
        <Anchor href={action.href} prefetch={false}>
          {message("next.SIGN_IN.label")}
        </Anchor>
      ) : null}
      {action.kind === "CHECK_AGAIN" ? (
        <button type="button" className="kauro-button" onClick={actions.checkAgain}>
          {message("shell.session.check-again.label")}
        </button>
      ) : null}
      {action.kind === "SIGN_OUT" ? (
        <button type="button" className="kauro-button" onClick={actions.signOut}>
          {message("shell.sign-out.label")}
        </button>
      ) : null}
    </section>
  );
}

/** The first letters of a workspace's name, the mark beside it (a text node: never markup). */
function initials(name: string): string {
  const words = name.split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word));
  return words
    .slice(0, 2)
    .map((word) => (word.match(/[A-Za-z0-9]/)?.[0] ?? "").toUpperCase())
    .join("");
}

/**
 * The person's own controls at the foot of the menu (Order 11 round 2): one button that opens a short menu upward, next to it, with the
 * person's settings, the theme by name, and Sign out last. It replaces a link, a lone icon and a bordered button that sat side by side.
 * The menu closes on Escape (focus returns to its button) and on a click anywhere outside it; a click, never a pointerdown, so the press
 * that lands outside is finished before anything closes.
 */
function AccountMenu({ accountHref, role, Link, onSignOut }: { readonly accountHref: string | null; readonly role: string | null; readonly Link: AnchorComponent; readonly onSignOut: () => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onClick = (event: MouseEvent): void => {
      if (event.target instanceof Node && root.current?.contains(event.target) === true) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="kauro-account" ref={root}>
      <div className="kauro-account-panel" id={panelId} hidden={!open}>
        <ul>
          {accountHref === null ? null : (
            <li>
              <Link href={accountHref} prefetch={false}>
                {message("shell.account.settings.label")}
              </Link>
            </li>
          )}
          <li className="kauro-account-theme">
            <span aria-hidden="true">{message("shell.theme.label")}</span>
            <ThemeChoice className="kauro-theme-choice" labels={{ group: message("shell.theme.label"), light: message("shell.theme.option.light.label"), dark: message("shell.theme.option.dark.label") }} />
          </li>
          <li className="kauro-account-leave">
            <button type="button" className="kauro-account-item" onClick={onSignOut}>
              {message("shell.sign-out.label")}
            </button>
          </li>
        </ul>
      </div>
      <button type="button" ref={button} className="kauro-account-button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
        <span className="kauro-account-mark" aria-hidden="true" />
        <span className="kauro-account-text">
          <span className="kauro-account-name">{message("shell.account.label")}</span>
          {role === null ? null : <span className="kauro-account-role">{role}</span>}
        </span>
        <span className="kauro-chevron" aria-hidden="true" />
      </button>
    </div>
  );
}

/** A workspace as the menu names it: the mark, the name, and its state only when that state asks for attention. */
function AgencyFace({ agency }: { readonly agency: NonNullable<ShellView["agency"]> }): ReactElement {
  return (
    <>
      <span className="kauro-agency-mark" aria-hidden="true">
        {initials(agency.name)}
      </span>
      <span className="kauro-agency-text">
        <span className="kauro-agency-label">{message("shell.agency.label")}</span>
        <bdi className="kauro-agency-name">{agency.name}</bdi>
        {agency.state === "shell.agency.state.ACTIVE.label" ? null : <span className="kauro-agency-state">{message(agency.state)}</span>}
      </span>
    </>
  );
}

/** The menu's entries in their groups, each group under its heading; Help is left for the foot of the menu. */
function Groups({ items, Link, project }: { readonly items: readonly NavigationItem[]; readonly Link: AnchorComponent; readonly project?: ProjectInView | null | undefined }): ReactElement {
  const groups: { readonly heading: NavigationItem["group"]; readonly items: NavigationItem[] }[] = [];
  for (const item of items) {
    if (item.group === "nav.group.help.label") continue;
    const last = groups.at(-1);
    if (last !== undefined && last.heading === item.group) last.items.push(item);
    else groups.push({ heading: item.group, items: [item] });
  }
  return (
    <>
      {groups.map((group) => (
        <div key={group.heading ?? "first"} className="kauro-shell-group">
          {group.heading === undefined ? null : <p className="kauro-shell-group-heading">{message(group.heading)}</p>}
          <ul>
            {group.items.map((item) => (
              <li key={item.screen}>
                <Link href={item.href} prefetch={false} {...(item.current && (project === null || project === undefined) ? { "aria-current": "page" as const } : {})}>
                  {message(item.label)}
                </Link>
                {item.screen === "UI11" && project !== null && project !== undefined ? <ProjectAreas project={project} Link={Link} /> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

export function ShellFrame({ view, Anchor, actions, children }: { readonly view: ShellView; readonly Anchor?: AnchorComponent; readonly actions: ShellActions; readonly children: ReactNode }): ReactElement {
  const Link = Anchor ?? PlainAnchor;
  const { gate } = view;
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const main = (
    <Main>
      <div role="status" className="kauro-live">
        {gate.kind === "WAIT" ? <p>{message(gate.message)}</p> : null}
      </div>
      {gate.kind === "OPEN" ? (
        <AnchorContext value={Link}>
          <ProjectContext value={view.project === null || view.project === undefined ? null : { name: view.project.name, clientLabel: view.project.clientLabel, mode: view.project.mode }}>{children}</ProjectContext>
        </AnchorContext>
      ) : null}
      {gate.kind === "REFUSED" ? <Refused key={gate.title} title={message(gate.title)} body={message(gate.body)} action={gate.action} Anchor={Link} actions={actions} /> : null}
    </Main>
  );

  if (view.anonymous === true)
    return (
      <>
        <SkipLink />
        <header className="kauro-shell-header">
          <span className="kauro-shell-brand">{message("shell.brand.name")}</span>
        </header>
        {main}
      </>
    );

  const help = view.navigation.filter((item) => item.group === "nav.group.help.label");
  return (
    <>
      <SkipLink />
      <div className="kauro-shell">
      <header className="kauro-shell-side" data-open={open ? "true" : undefined}>
        <div className="kauro-shell-top">
          <span className="kauro-shell-brand">{message("shell.brand.name")}</span>
          {view.signOut ? (
            <button type="button" className="kauro-shell-menu" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((value) => !value)}>
            <span className="kauro-shell-menu-glyph" aria-hidden="true" />
            {message("shell.menu.label")}
            </button>
          ) : null}
        </div>
        {view.ops ? (
          <p className="kauro-agency kauro-agency--ops">
            <span className="kauro-agency-mark" aria-hidden="true">
              K
            </span>
            <span className="kauro-agency-text">
              <span className="kauro-agency-name">{message("shell.ops.label")}</span>
            </span>
          </p>
        ) : view.agency === null ? null : (
          // the workspace is its own switch (Order 11 round 2): its mark, its name and, only when it is not simply active, its state; the
          // whole block goes to the workspaces when there is somewhere to switch to
          <div className={view.switchHref === null ? "kauro-agency" : "kauro-agency kauro-agency--switch"}>
            {view.switchHref === null ? (
              <AgencyFace agency={view.agency} />
            ) : (
              <Link href={view.switchHref} prefetch={false}>
                <AgencyFace agency={view.agency} />
                <span className="kauro-shell-hidden">{message("shell.agency.switch.label")}</span>
                <span className="kauro-chevron" aria-hidden="true" />
              </Link>
            )}
          </div>
        )}
        <div className="kauro-shell-panel" id={menuId}>
          {view.switchHref === null || view.agency !== null ? null : (
            <p className="kauro-shell-switch">
              <Link href={view.switchHref} prefetch={false}>
                {message("shell.workspaces.label")}
              </Link>
            </p>
          )}
          {view.navigation.length === 0 ? null : (
            <nav className="kauro-shell-nav" aria-label={message(view.ops ? "shell.navigation.ops.label" : "shell.navigation.label")}>
              <Groups items={view.navigation} Link={Link} project={view.project} />
              {help.length === 0 ? null : (
                <div className="kauro-shell-group kauro-shell-group--foot">
                  <ul>
                    {help.map((item) => (
                      <li key={item.screen}>
                        <Link href={item.href} prefetch={false} {...(item.current ? { "aria-current": "page" as const } : {})}>
                          {message(item.label)}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </nav>
          )}
          {view.signOut ? <AccountMenu accountHref={view.accountHref} role={view.agency?.role === null || view.agency?.role === undefined ? null : message(view.agency.role)} Link={Link} onSignOut={actions.signOut} /> : null}
        </div>
      </header>
      {main}
      </div>
    </>
  );
}
