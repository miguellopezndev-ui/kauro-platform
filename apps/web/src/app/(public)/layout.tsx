import "./public.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PUBLIC_COPY } from "../../copy/public.ts";
import { SiteFrame } from "../../public/frame.tsx";
import { signInAddress } from "../../server/config/site-origins.ts";
import { MainNav } from "./main-nav.tsx";
import { SiteThemeControl } from "./theme-control.tsx";

// The frame of every page of the public origin (D-TOPO-1). The document itself (html, body, the nonce, the stored theme) is the root layout's;
// the legal pages are route handlers with their own document and do not pass through here. Nothing here reads a cookie, a header or a session.
export const metadata: Metadata = { title: { template: "%s | Kauro", default: "Kauro" } };

const THEME_LABELS = {
  toDark: PUBLIC_COPY["site.theme.dark.label"],
  toLight: PUBLIC_COPY["site.theme.light.label"],
  toggle: PUBLIC_COPY["site.theme.toggle.label"],
};

export default function PublicLayout({ children }: { readonly children: ReactNode }) {
  return (
    <SiteFrame signInHref={signInAddress()} nav={<MainNav />} themeControl={<SiteThemeControl labels={THEME_LABELS} />}>
      {children}
    </SiteFrame>
  );
}
