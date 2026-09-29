"use client";

import { useEffect } from "react";
import { installNavigationGuard } from "../internal/navigation-guard.js";

export interface NavigationGuardProps {
  /** True while the page holds work that leaving would lose. The guard is installed only while it is true. */
  readonly dirty: boolean;
  /** What the confirmation says when a link inside the application would leave the page. */
  readonly message: string;
  /** Asks the person whether to leave; the browser's own confirm() when omitted. */
  readonly confirmLeave?: ((message: string) => boolean) | undefined;
}

/**
 * NavigationGuard (D-DS-1): while a page holds unsaved work, closing the tab or following a link away from the page asks first.
 * It renders nothing. The browser's own prompt covers leaving the document; a capturing click listener covers following a link
 * inside the application. The browser's Back button cannot be intercepted by a page and is not.
 */
export function NavigationGuard({ dirty, message, confirmLeave }: NavigationGuardProps): null {
  useEffect(() => {
    if (!dirty) return undefined;
    return installNavigationGuard(
      { window, document, currentHref: () => window.location.href },
      { message, confirmLeave: confirmLeave ?? ((text) => window.confirm(text)) },
    );
  }, [dirty, message, confirmLeave]);
  return null;
}
