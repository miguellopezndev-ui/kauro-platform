import "@kauro/ui/tokens.css";
import "../shell/shell.css";
import "../screens/screens.css";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { NONCE_REQUEST_HEADER } from "../server/security-headers";

// Every document is rendered per request: the CSP nonce is per request (D-SEC-1) and no page is ever served from a build-time
// or shared cache (08 "Browser, API and cache isolation").
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Kauro",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  // One theme, dark (owner, 2026-10-21): the browser's bar takes the page's carbon.
  themeColor: "#242426",
  colorScheme: "dark",
};

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  // A document rendered without the proxy's nonce would run without its policy: refuse it (D-SEC-1).
  if ((await headers()).get(NONCE_REQUEST_HEADER) === null) throw new Error("CSP_NONCE_MISSING");
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
