// The review's root (Order 11). It loads the web's own stylesheets (the design tokens and the application shell) and reads the theme the
// web stores (the same cookie, the same values), so the screens are drawn in the light or dark theme exactly as the product draws them.
import "@kauro/ui/tokens.css";
import "@web/shell/shell.css";
import "@web/screens/screens.css";
import "./review.css";
import "../prototypes/foundation.css";
import "../prototypes/pages.css";
import "../prototypes/auth.css";
import "../prototypes/ops.css";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { THEME_COOKIE, parseTheme } from "@web/server/theme.ts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Kauro review — private screens", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme ?? undefined}>
      <body>{children}</body>
    </html>
  );
}
