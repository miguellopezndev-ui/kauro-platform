// The frames of the application (design D-A11Y-1, D-DS-3, D-SEC-1, D-PRIV-1): the header with the agency indicator, the navigation and the
// one <main> (landmarks.tsx) every screen renders into. They draw what `viewOf` answers and nothing else, hold no session and read no
// network, so the same components render on the server, in the browser and in a node test. Screens render their own <h1> and content and
// never their own <main>: the frame owns the landmark the skip link points at.
//   - Customer strings (the agency name) are text nodes inside <bdi>, never markup (D-DS-3).
//   - No inline style and no script: the look is shell.css (D-SEC-1).
//   - Waiting is announced by one polite live region that exists before its text does; a refusal takes focus once, on its heading.
//   - Navigation links are not prefetched (D-PRIV-1): a link that fetches on sight would load a screen's private data before it is asked for.
import { type ComponentType, type ReactElement, type ReactNode, useEffect, useRef } from "react";
import { message } from "../copy/en.ts";
import { Main, SkipLink } from "./landmarks.tsx";
import { ThemeControl } from "./theme-control.tsx";
import type { RefusedAction, ShellView } from "./view.ts";

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

export function ShellFrame({ view, Anchor, actions, children }: { readonly view: ShellView; readonly Anchor?: AnchorComponent; readonly actions: ShellActions; readonly children: ReactNode }): ReactElement {
  const Link = Anchor ?? PlainAnchor;
  const { gate } = view;
  return (
    <>
      <SkipLink />
      <header className="kauro-shell-header">
        <span className="kauro-shell-brand">{message("shell.brand.name")}</span>
        {view.agency === null ? null : (
          <div className="kauro-agency">
            <span className="kauro-agency-label">{message("shell.agency.label")}</span>
            <bdi className="kauro-agency-name">{view.agency.name}</bdi>
            <span className="kauro-agency-state">{message(view.agency.state)}</span>
          </div>
        )}
        {view.switchHref === null && !view.signOut ? null : (
          <div className="kauro-shell-actions">
            {view.switchHref === null ? null : (
              <Link href={view.switchHref} prefetch={false}>
                {message("shell.agency.switch.label")}
              </Link>
            )}
            {view.signOut ? (
              <>
                <ThemeControl
                  mode="button"
                  className="kauro-shell-theme"
                  returnTo={null}
                  labels={{ toDark: message("shell.theme.dark.label"), toLight: message("shell.theme.light.label"), toggle: message("shell.theme.toggle.label") }}
                />
                <button type="button" className="kauro-button" onClick={actions.signOut}>
                  {message("shell.sign-out.label")}
                </button>
              </>
            ) : null}
          </div>
        )}
      </header>
      {view.navigation.length === 0 ? null : (
        <nav className="kauro-shell-nav" aria-label={message("shell.navigation.label")}>
          <ul>
            {view.navigation.map((item) => (
              <li key={item.screen}>
                <Link href={item.href} prefetch={false} {...(item.current ? { "aria-current": "page" as const } : {})}>
                  {message(item.label)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <Main>
        <div role="status" className="kauro-live">
          {gate.kind === "WAIT" ? <p>{message(gate.message)}</p> : null}
        </div>
        {gate.kind === "OPEN" ? children : null}
        {gate.kind === "REFUSED" ? <Refused key={gate.title} title={message(gate.title)} body={message(gate.body)} action={gate.action} Anchor={Link} actions={actions} /> : null}
      </Main>
    </>
  );
}
