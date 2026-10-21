"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { PUBLIC_COPY } from "../../copy/public.ts";
import { NavList } from "../../public/frame.tsx";
import { HEADER_NAV, MAIN_NAV, ROUTE } from "../../public/site.ts";

/**
 * The header's pages in one line, the current one marked from the router (Order 11 round 2). It is shown on a wide screen only; a narrow
 * screen has the menu below instead, so a reader and a screen reader meet one "Main" navigation at any width.
 */
export function HeaderNav() {
  return (
    <div className="kauro-site-header-nav">
      <NavList items={HEADER_NAV} current={usePathname()} label="site.nav.main.label" />
    </div>
  );
}

/** The site's one call to action in the header; on the page it opens it would only lead to itself, so it is left out there. */
export function HeaderCta() {
  if (usePathname() === ROUTE.contact) return null;
  return (
    <a className="kauro-site-button kauro-site-button--primary kauro-site-header-cta" href={ROUTE.contact}>
      {PUBLIC_COPY["public.cta.request-health-check.cta"]}
    </a>
  );
}

/**
 * The menu of a narrow screen: a native disclosure, so it opens and closes without the script. It drops a small card under its button,
 * dims the page a little behind it and leaves the page where it was; on a phone the card also carries "Sign in" and the call to action,
 * which the header has no room for. The script adds what a disclosure lacks: Escape closes it and gives focus back to its button, and a
 * press anywhere outside the card (the dimmed page included) closes it.
 */
export function MainNav({ signInHref }: { readonly signInHref: string }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const current = usePathname();
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const element = menu.current;
      if (event.key !== "Escape" || element === null || !element.open) return;
      element.open = false;
      element.querySelector("summary")?.focus();
    };
    // closed on click, after the press is released: closing a <details> inside a pointerdown handler crashed Chromium's renderer
    // ("Aw, Snap", STATUS_BREAKPOINT) when the press landed outside the open menu (Order 11, owner's walk of 2026-10-21)
    const onPress = (event: MouseEvent): void => {
      const element = menu.current;
      if (element === null || !element.open) return;
      const target = event.target;
      const onScrim = target instanceof Element && target.classList.contains("kauro-site-menu-scrim");
      if (onScrim || (target instanceof Node && !element.contains(target))) element.open = false;
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("click", onPress);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onPress);
    };
  }, []);
  return (
    <details ref={menu} className="kauro-site-menu">
      <span className="kauro-site-menu-scrim" aria-hidden="true" />
      <summary className="kauro-site-menu-toggle">
        <span className="kauro-site-menu-glyph" aria-hidden="true" />
        <span className="kauro-site-menu-label">{PUBLIC_COPY["site.menu.label"]}</span>
      </summary>
      <div className="kauro-site-menu-panel kauro-inverse">
        <div className="kauro-site-menu-inner">
          <NavList items={MAIN_NAV} current={current} label="site.nav.main.label" />
          <div className="kauro-site-menu-actions">
            {current === ROUTE.contact ? null : (
              <a className="kauro-site-button kauro-site-button--primary" href={ROUTE.contact}>
                {PUBLIC_COPY["public.cta.request-health-check.cta"]}
              </a>
            )}
            <a className="kauro-site-menu-signin" href={signInHref}>
              {PUBLIC_COPY["nav.signin.label"]}
            </a>
          </div>
        </div>
      </div>
    </details>
  );
}
