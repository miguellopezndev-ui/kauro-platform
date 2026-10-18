"use client";

import { usePathname } from "next/navigation";
import { ThemeControl, type ThemeControlLabels } from "../../shell/theme-control.tsx";

/** The theme control of the public frame: the shared control, told the page's path so a choice made without script comes back here. */
export function SiteThemeControl({ labels }: { readonly labels: ThemeControlLabels }) {
  return <ThemeControl labels={labels} className="kauro-site-theme" returnTo={usePathname()} />;
}
