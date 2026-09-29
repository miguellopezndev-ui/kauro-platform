"use client";

import { useEffect } from "react";
import { guardWhile } from "../internal/navigation-guard.js";
import type { LeaveAttempt } from "../internal/navigation-guard.js";

export type { LeaveAttempt } from "../internal/navigation-guard.js";

export interface NavigationGuardProps {
  /** True while the page holds work that leaving would lose. The guard is installed only while it is true. */
  readonly dirty: boolean;
  /** What the confirmation says when a link inside the application would leave the page. */
  readonly message: string;
  /** Asks the person whether to leave; the browser's own confirm() when omitted. Ignored when onBlocked is given. */
  readonly confirmLeave?: ((message: string) => boolean) | undefined;
  /**
   * Takes over the question: the click on a link that would leave the page is held and this receives the destination and a
   * `proceed()` that follows it. The page opens its own dialog (stay, save then leave, leave without saving) and calls
   * `proceed()` once the person has chosen to go.
   */
  readonly onBlocked?: ((attempt: LeaveAttempt) => void) | undefined;
}

/**
 * NavigationGuard (D-DS-1): while a page holds unsaved work, closing the tab or following a link away from the page asks first.
 * It renders nothing. The browser's own prompt covers leaving the document; a capturing click listener covers following a link
 * inside the application. The browser's Back button cannot be intercepted by a page and is not.
 */
export function NavigationGuard({ dirty, message, confirmLeave, onBlocked }: NavigationGuardProps): null {
  useEffect(
    () =>
      guardWhile(
        dirty,
        { window, document, currentHref: () => window.location.href, navigate: (href) => window.location.assign(href) },
        { message, confirmLeave: confirmLeave ?? ((text) => window.confirm(text)), onBlocked },
      ),
    [dirty, message, confirmLeave, onBlocked],
  );
  return null;
}
