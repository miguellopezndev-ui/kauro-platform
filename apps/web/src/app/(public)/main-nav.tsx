"use client";

import { usePathname } from "next/navigation";
import { NavList } from "../../public/frame.tsx";
import { MAIN_NAV } from "../../public/site.ts";

/** The header navigation: the only part of the frame that needs the router, to mark the page being shown. */
export function MainNav() {
  return <NavList items={MAIN_NAV} current={usePathname()} label="site.nav.main.label" />;
}
