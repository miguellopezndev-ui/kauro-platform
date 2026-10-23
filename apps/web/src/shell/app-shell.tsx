"use client";
// The application shell of the agency screens (design D-PRIV-1, D-TOPO-2, D-A11Y-1): the client component that owns the page's runtime.
// The server renders it as the loading shell (the session is unknown until the browser has asked), the browser creates the runtime after
// the first paint, and from then on the frame draws what `viewOf` answers. Everything the browser provides is read in `browserPage`.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { SessionPhase } from "../client/session.ts";
import { agencyOfPathname, matchRoute, projectOfPathname } from "../screens.ts";
import type { AgencyContext } from "./agency-context.ts";
import { browserPage } from "./browser-page.ts";
import { type ProjectOfPage, readProjectOfPage } from "./project-of-page.ts";
import { type AnchorComponent, ShellFrame } from "./frame.tsx";
import { ShellContext } from "./shell-context.ts";
import { createShell, type Shell } from "./shell-runtime.ts";
import { viewOf } from "./view.ts";

interface Store<T> {
  snapshot(): T;
  subscribe(listener: () => void): () => void;
}

const CHECKING: SessionPhase = { kind: "CHECKING" };
const LOADING: AgencyContext = { kind: "LOADING" };
const IDLE = (): void => undefined;

const sessionOf = (shell: Shell): Store<SessionPhase> => shell.session;
const agencyOf = (shell: Shell): Store<AgencyContext> => shell.agency;

/** A runtime's state as a React value; before the runtime exists (the server render, the first paint) it is the loading shell's. */
function useStore<T>(shell: Shell | null, pick: (shell: Shell) => Store<T>, initial: T): T {
  const subscribe = useCallback((listener: () => void) => (shell === null ? IDLE : pick(shell).subscribe(listener)), [shell, pick]);
  const snapshot = useCallback(() => (shell === null ? initial : pick(shell).snapshot()), [shell, pick, initial]);
  return useSyncExternalStore(subscribe, snapshot, () => initial);
}

const NextAnchor: AnchorComponent = ({ href, prefetch, "aria-current": current, children }) => (
  <Link href={href} prefetch={prefetch} {...(current === undefined ? {} : { "aria-current": current })}>
    {children}
  </Link>
);

export function AppShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  const [shell, setShell] = useState<Shell | null>(null);

  useEffect(() => {
    const made = createShell(browserPage());
    setShell(made);
    void made.session.start();
    return () => {
      made.detach();
      setShell(null);
    };
  }, []);

  // a client-side navigation that crossed an agency boundary is turned into a full document navigation (the heap starts empty)
  useEffect(() => {
    if (shell !== null && matchRoute(pathname) !== null && agencyOfPathname(pathname) !== shell.session.activeAgency()) shell.session.checkAgencyBoundary(pathname);
  }, [shell, pathname]);

  const phase = useStore(shell, sessionOf, CHECKING);
  const agency = useStore(shell, agencyOf, LOADING);

  // Order 24: the project the page is inside, read once per project from GetProject and the agency's clients, for the header and the menu
  const inside = projectOfPathname(pathname);
  const insideKey = inside === null ? null : `${inside.agencyId}/${inside.projectId}`;
  const agencyReady = agency.kind === "READY";
  const [project, setProject] = useState<ProjectOfPage | null>(null);
  useEffect(() => {
    if (shell === null || inside === null || !agencyReady || inside.agencyId !== shell.session.activeAgency()) return;
    if (project !== null && project.projectId === inside.projectId) return;
    const abort = new AbortController();
    readProjectOfPage(shell.client, inside.agencyId, inside.projectId, abort.signal).then(
      (read) => {
        if (!abort.signal.aborted) setProject(read);
      },
      // a client refusal (a malformed id) leaves the frame's fallback, like any unreadable project
      () => undefined,
    );
    return () => abort.abort();
    // the project is read again only when the page enters another project (insideKey) or the runtime or agency changes
  }, [shell, insideKey, agencyReady]);

  const view = viewOf({
    phase,
    agency,
    pathname,
    activeAgency: shell === null ? agencyOfPathname(pathname) : shell.session.activeAgency(),
    ...(project === null ? {} : { project }),
  });
  const actions = {
    signOut: () => {
      void shell?.session.signOut();
    },
    checkAgain: () => {
      void shell?.session.checkAgain();
    },
  };
  return (
    <ShellFrame view={view} Anchor={NextAnchor} actions={actions}>
      <ShellContext value={shell}>{children}</ShellContext>
    </ShellFrame>
  );
}
