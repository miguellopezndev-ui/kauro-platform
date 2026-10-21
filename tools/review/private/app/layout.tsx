// The review's root (Order 11). It loads the web's own stylesheets (the design tokens and the application shell), so the screens are drawn
// in the product's one theme, dark, exactly as the product draws them.
import "@kauro/ui/tokens.css";
import "@web/shell/shell.css";
import "@web/screens/screens.css";
import "./review.css";
import "../prototypes/foundation.css";
import "../prototypes/pages.css";
import "../prototypes/auth.css";
import "../prototypes/ops.css";
import "../prototypes/r2-shared.css";
import "../prototypes/r2-board.css";
import "../prototypes/r2-plan.css";
import "../prototypes/r2-delivery.css";
import "../prototypes/r2-access.css";
import "../prototypes/r2-decisions.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Kauro review — private screens", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
