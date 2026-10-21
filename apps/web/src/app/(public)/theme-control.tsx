"use client";

import { usePathname } from "next/navigation";
import { ThemeChoiceForm, type ThemeChoiceLabels } from "../../shell/theme-control.tsx";

/**
 * The theme choice of the public footer: "Theme" with "Light" and "Dark" named (Order 11 round 2; of the 20 B2B footers measured only Vercel
 * offers a theme, as named options in its footer), told the page's path so a choice made without script comes back here.
 */
export function SiteThemeControl({ labels }: { readonly labels: ThemeChoiceLabels }) {
  return <ThemeChoiceForm labels={labels} className="kauro-site-theme-choice" returnTo={usePathname()} />;
}
