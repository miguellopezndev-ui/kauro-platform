"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { PUBLIC_COPY } from "../../copy/public.ts";
import { NavList } from "../../public/frame.tsx";
import { MAIN_NAV } from "../../public/site.ts";

/**
 * The header navigation, folded into a menu: a native disclosure, so it opens and closes without the script, and the links stay the page's
 * one "Main" navigation. It drops a small card under its button and leaves the page where it was. The script adds what a disclosure lacks:
 * Escape closes it and gives focus back to its button, and a press anywhere outside it closes it. The current page is marked from the router.
 */
export function MainNav() {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const element = menu.current;
      if (event.key !== "Escape" || element === null || !element.open) return;
      element.open = false;
      element.querySelector("summary")?.focus();
    };
    const onPress = (event: PointerEvent): void => {
      const element = menu.current;
      if (element === null || !element.open) return;
      if (event.target instanceof Node && !element.contains(event.target)) element.open = false;
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPress);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPress);
    };
  }, []);
  return (
    <details ref={menu} className="kauro-site-menu">
      <summary className="kauro-site-menu-toggle">
        <span className="kauro-site-menu-glyph" aria-hidden="true" />
        <span className="kauro-site-menu-label">{PUBLIC_COPY["site.menu.label"]}</span>
      </summary>
      <div className="kauro-site-menu-panel kauro-inverse">
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
