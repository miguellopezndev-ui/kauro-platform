// The imperative half of NavigationGuard, free of React and of the DOM types so it is testable with stubs.
//
// Unsaved work is lost in two ways. Leaving the document (closing the tab, typing another address, following an external link)
// raises `beforeunload`, which the browser turns into its own prompt. Following a same-origin link inside the application is a
// client-side transition that never raises it, so a capturing click listener asks the owner's confirmation first.
// Going back with the browser button cannot be intercepted by a page; the guard does not pretend to.

export interface AnchorLike {
  readonly href: string;
  readonly target: string;
  hasAttribute(name: string): boolean;
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
}

export interface GuardOptions {
  readonly message: string;
  /** Asks the person whether to leave; the default is the browser's own confirm(). */
  readonly confirmLeave: (message: string) => boolean;
}

function closestAnchor(target: unknown): AnchorLike | null {
  const candidate = target as { closest?: unknown } | null;
  if (candidate === null || typeof candidate !== "object" || typeof candidate.closest !== "function") return null;
  const anchor = (candidate as { closest(selector: string): AnchorLike | null }).closest("a[href]");
  // An SVG <a> has an href that is not a string; it is not a page link.
  return anchor !== null && typeof anchor.href === "string" ? anchor : null;
}

/** True when following this click leaves the current page for another page of the same application. */
export function leavesPageInApp(click: ClickLike, currentHref: string): boolean {
  if (click.defaultPrevented || click.button !== 0) return false;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return false;
  const anchor = closestAnchor(click.target);
  if (anchor === null) return false;
  if (anchor.hasAttribute("download") || (anchor.target !== "" && anchor.target !== "_self")) return false;
  let destination: URL;
  let current: URL;
  try {
    destination = new URL(anchor.href);
    current = new URL(currentHref);
  } catch {
    return false;
  }
  if (destination.origin !== current.origin) return false; // beforeunload covers leaving the origin
  return destination.pathname !== current.pathname || destination.search !== current.search;
}

/** Installs both guards and returns the function that removes them. */
export function installNavigationGuard(environment: GuardEnvironment, options: GuardOptions): () => void {
  const onBeforeUnload = (event: BeforeUnloadLike): void => {
    event.preventDefault();
    event.returnValue = "";
  };
  const onClick = (click: ClickLike): void => {
    if (!leavesPageInApp(click, environment.currentHref())) return;
    if (options.confirmLeave(options.message)) return;
    click.preventDefault();
    click.stopPropagation();
    click.stopImmediatePropagation();
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
