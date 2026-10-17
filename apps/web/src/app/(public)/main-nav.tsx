"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { PUBLIC_COPY } from "../../copy/public.ts";
import { NavList } from "../../public/frame.tsx";
import { MAIN_NAV } from "../../public/site.ts";

/**
 * The header navigation, folded into a menu: a native disclosure, so it opens and closes without the script, and the links stay the page's
 * one "Main" navigation. The script adds the two things a disclosure lacks: Escape closes it (and gives focus back to its button), and a
 * click on the veil outside the links closes it too. The current page is marked from the router.
 */
export function MainNav() {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: KeyboardEvent): void => {
      const element = menu.current;
      if (event.key !== "Escape" || element === null || !element.open) return;
      element.open = false;
      element.querySelector("summary")?.focus();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  return (
    <details
      ref={menu}
      className="kauro-site-menu"
      onClick={(event) => {
        if (event.target instanceof HTMLElement && event.target.classList.contains("kauro-site-menu-panel")) event.currentTarget.open = false;
      }}
    >
      <summary className="kauro-site-menu-toggle">
        <span className="kauro-site-menu-glyph" aria-hidden="true" />
        <span className="kauro-site-menu-label">{PUBLIC_COPY["site.menu.label"]}</span>
      </summary>
      <div className="kauro-site-menu-panel kauro-wine">
        <div className="kauro-site-menu-inner">
          <NavList items={MAIN_NAV} current={usePathname()} label="site.nav.main.label" />
          <p className="kauro-site-menu-tagline" aria-hidden="true">
            {PUBLIC_COPY["site.footer.tagline"]}
          </p>
        </div>
      </div>
    </details>
  );
}
