// The imperative half of NavigationGuard, free of React and of the DOM types so it is testable with stubs.
//
// Unsaved work is lost in two ways. Leaving the document (closing the tab, typing another address, following an external link)
// raises `beforeunload`, which the browser turns into its own prompt. Following a same-origin link inside the application is a
// client-side transition that never raises it, so a capturing click listener asks the owner's confirmation first.
// Going back with the browser button cannot be intercepted by a page (popstate is raised after the page has already changed);
// the guard does not pretend to.
//
// The confirmation is either the browser's own two-way question (confirmLeave) or the caller's: with onBlocked the click is
// always held and the caller is handed the destination and a proceed() that follows it, so a page can offer three choices
// (stay, save then leave, leave without saving) in a dialog of its own.

export interface AnchorLike {
  readonly href: string;
  readonly target: string;
  readonly isConnected: boolean;
  hasAttribute(name: string): boolean;
  click(): void;
}

export interface ClickLike {
  readonly defaultPrevented: boolean;
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  /** An EventTarget in a browser; read only through closest() when it has one. */
  readonly target: unknown;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
}

export interface BeforeUnloadLike {
  preventDefault(): void;
  returnValue: unknown;
}

export interface GuardEnvironment {
  readonly window: {
    addEventListener(type: "beforeunload", listener: (event: BeforeUnloadLike) => void): void;
    removeEventListener(type: "beforeunload", listener: (event: BeforeUnloadLike) => void): void;
  };
  readonly document: {
    addEventListener(type: "click", listener: (event: ClickLike) => void, capture: boolean): void;
    removeEventListener(type: "click", listener: (event: ClickLike) => void, capture: boolean): void;
  };
  /** The address of the page now, as location.href reads. */
  readonly currentHref: () => string;
  /** A full navigation to an address, for a held link that is no longer on the page. */
  readonly navigate: (href: string) => void;
}

/** A link click the guard held: where it was going, and the way to let it through. */
export interface LeaveAttempt {
  readonly href: string;
  /** Follows the held link as the click would have (once; a later call does nothing). Call it after saving or discarding. */
  proceed(): void;
}

export interface GuardOptions {
  readonly message: string;
  /** Asks the person whether to leave; the default is the browser's own confirm(). */
  readonly confirmLeave: (message: string) => boolean;
  /** When given, replaces confirmLeave: every click that would leave the page is held and handed over. */
  readonly onBlocked?: ((attempt: LeaveAttempt) => void) | undefined;
}

function closestAnchor(target: unknown): AnchorLike | null {
  const candidate = target as { closest?: unknown } | null;
  if (candidate === null || typeof candidate !== "object" || typeof candidate.closest !== "function") return null;
  const anchor = (candidate as { closest(selector: string): AnchorLike | null }).closest("a[href]");
  // An SVG <a> has an href that is not a string; it is not a page link.
  return anchor !== null && typeof anchor.href === "string" ? anchor : null;
}

/** The link this click follows when that leaves the current page for another page of the same application, else null. */
function leavingAnchor(click: ClickLike, currentHref: string): AnchorLike | null {
  if (click.defaultPrevented || click.button !== 0) return null;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return null;
  const anchor = closestAnchor(click.target);
  if (anchor === null) return null;
  if (anchor.hasAttribute("download") || (anchor.target !== "" && anchor.target !== "_self")) return null;
  let destination: URL;
  let current: URL;
  try {
    destination = new URL(anchor.href);
    current = new URL(currentHref);
  } catch {
    return null;
  }
  if (destination.origin !== current.origin) return null; // beforeunload covers leaving the origin
  return destination.pathname !== current.pathname || destination.search !== current.search ? anchor : null;
}

/** True when following this click leaves the current page for another page of the same application. */
export function leavesPageInApp(click: ClickLike, currentHref: string): boolean {
  return leavingAnchor(click, currentHref) !== null;
}

function hold(click: ClickLike): void {
  click.preventDefault();
  click.stopPropagation();
  click.stopImmediatePropagation();
}

/** Installs both guards and returns the function that removes them. */
export function installNavigationGuard(environment: GuardEnvironment, options: GuardOptions): () => void {
  const onBeforeUnload = (event: BeforeUnloadLike): void => {
    event.preventDefault();
    event.returnValue = "";
  };
  let releasing = false; // true while proceed() re-issues a held click, so the guard lets that one through
  const onClick = (click: ClickLike): void => {
    if (releasing) return;
    const anchor = leavingAnchor(click, environment.currentHref());
    if (anchor === null) return;
    const { onBlocked } = options;
    if (onBlocked === undefined) {
      if (!options.confirmLeave(options.message)) hold(click);
      return;
    }
    hold(click);
    let used = false;
    onBlocked({
      href: anchor.href,
      proceed: () => {
        if (used) return;
        used = true;
        if (!anchor.isConnected) {
          environment.navigate(anchor.href);
          return;
        }
        releasing = true;
        try {
          anchor.click();
        } finally {
          releasing = false;
        }
      },
    });
  };
  environment.window.addEventListener("beforeunload", onBeforeUnload);
  environment.document.addEventListener("click", onClick, true);
  return () => {
    environment.window.removeEventListener("beforeunload", onBeforeUnload);
    environment.document.removeEventListener("click", onClick, true);
  };
}

/** The effect of NavigationGuard: the guard is installed only while the page holds unsaved work, and removed when it stops. */
export function guardWhile(dirty: boolean, environment: GuardEnvironment, options: GuardOptions): (() => void) | undefined {
  return dirty ? installNavigationGuard(environment, options) : undefined;
}
