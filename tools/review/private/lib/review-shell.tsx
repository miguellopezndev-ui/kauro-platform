"use client";
// The application shell as the review runs it (Order 11). It is the web's own composition, with only the browser swapped out: the real
// session runtime, api client and agency context (createShell), the real frame (ShellFrame) and the real gate (viewOf), over a page whose
// network is the scenario's fixture fetch and whose navigation never leaves the review. A link of the frame that names another screen
// opens that screen's review frame instead. Nothing here is imported by the product.
import Link from "next/link";
import { type ReactElement, type ReactNode, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { BrowserPage } from "@web/client/browser-session.ts";
import type { SessionPhase } from "@web/client/session.ts";
import type { AgencyContext } from "@web/shell/agency-context.ts";
import { type AnchorComponent, type AnchorProps, ShellFrame } from "@web/shell/frame.tsx";
import { ShellContext } from "@web/shell/shell-context.ts";
import { createShell, type Shell } from "@web/shell/shell-runtime.ts";
import { viewOf } from "@web/shell/view.ts";
import { fixtureFetch, type ReviewCall, type Script } from "./fixture-fetch.ts";
import { PRIVATE_IDS } from "./inventory.ts";

const CHECKING: SessionPhase = { kind: "CHECKING" };
const LOADING: AgencyContext = { kind: "LOADING" };
const IDLE = (): void => undefined;
/** The review draws the finished application: every private screen counts as present, so the navigation shows them all. */
const ALL_PRIVATE: ReadonlySet<string> = new Set(PRIVATE_IDS);

interface Store<T> {
  snapshot(): T;
  subscribe(listener: () => void): () => void;
}

function useStore<T>(shell: Shell | null, pick: (shell: Shell) => Store<T>, initial: T): T {
  const subscribe = useCallback((listener: () => void) => (shell === null ? IDLE : pick(shell).subscribe(listener)), [shell, pick]);
  const snapshot = useCallback(() => (shell === null ? initial : pick(shell).snapshot()), [shell, pick, initial]);
  return useSyncExternalStore(subscribe, snapshot, () => initial);
}
const sessionOf = (shell: Shell): Store<SessionPhase> => shell.session;
const agencyOf = (shell: Shell): Store<AgencyContext> => shell.agency;

/** Reports a call to the review's panel (the owner sees that nothing left the machine). */
function announce(call: ReviewCall, answered: string): void {
  tell(`${call.method} ${call.operationId ?? call.path} → ${answered}`);
}

/** Tells the review's viewer (the parent page, same origin) what the screen asked for; nothing else hears it. */
function tell(detail: string): void {
  if (window.parent !== window) window.parent.postMessage({ kind: "kauro-review-call", detail }, window.location.origin);
  else console.info(`[review] ${detail}`);
}

function reviewPage(appPath: string, script: () => Script): BrowserPage {
  return {
    fetch: fixtureFetch(script, announce),
    location: {
      pathname: appPath,
      assign: (url) => tell(`navigation to ${url} (not followed in review)`),
      replace: (url) => tell(`navigation to ${url} (not followed in review)`),
    },
    window,
    document,
    now: () => Date.now(),
    randomBytes: (length) => window.crypto.getRandomValues(new Uint8Array(length)),
  };
}

export interface ReviewShellProps {
  /** The path the screen has in the application, e.g. /agencies/{id}/settings. */
  readonly appPath: string;
  readonly context: string;
  readonly script: () => Script;
  readonly children: ReactNode;
}

export function ReviewShell({ appPath, context, script, children }: ReviewShellProps): ReactElement {
  const [shell, setShell] = useState<Shell | null>(null);
  useEffect(() => {
    const made = createShell(reviewPage(appPath, script));
    setShell(made);
    void made.session.start();
    return () => {
      made.detach();
      setShell(null);
    };
  }, [appPath, script]);
  const phase = useStore(shell, sessionOf, CHECKING);
  const agency = useStore(shell, agencyOf, LOADING);
  const view = viewOf({ phase, agency, pathname: appPath, activeAgency: shell === null ? null : shell.session.activeAgency(), implemented: ALL_PRIVATE });
  // the application's own links: the review serves every private path, so they are followed exactly as in the product
  const Anchor: AnchorComponent = useCallback(
    ({ href, "aria-current": current, children: label }: AnchorProps) => (
      <Link href={href} prefetch={false} {...(current === undefined ? {} : { "aria-current": current })}>
        {label}
      </Link>
    ),
    [],
  );
  const actions = {
    signOut: () => void shell?.session.signOut(),
    checkAgain: () => void shell?.session.checkAgain(),
  };
  return (
    <ShellFrame view={view} Anchor={Anchor} actions={actions}>
      <ShellContext value={shell}>{children}</ShellContext>
    </ShellFrame>
  );
}
