import "@kauro/ui/tokens.css";
import "../shell/shell.css";
import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import type { ReactNode } from "react";
import { NONCE_REQUEST_HEADER } from "../server/security-headers";
import { THEME_COOKIE, parseTheme } from "../server/theme";

// Every document is rendered per request: the CSP nonce is per request (D-SEC-1) and no page is ever served from a build-time
// or shared cache (08 "Browser, API and cache isolation").
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Kauro",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F8F6F3" },
    { media: "(prefers-color-scheme: dark)", color: "#242426" },
  ],
};

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  // A document rendered without the proxy's nonce would run without its policy: refuse it (D-SEC-1).
  if ((await headers()).get(NONCE_REQUEST_HEADER) === null) throw new Error("CSP_NONCE_MISSING");
  // The stored display preference (A10); with none, the stylesheet follows the system's preference.
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme ?? undefined}>
      <body>{children}</body>
    </html>
  );
}
