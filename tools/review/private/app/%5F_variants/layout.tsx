// Public-site variants (Order 11; review only). The owner keeps the approved Order 10 site as the reference and asked for proposals as
// reviewable variants, never replacing it in main. A variant is drawn here, at /__variants/..., in the public site's own frame and
// stylesheet, under a ribbon that says it is a proposal and links to the approved page. The application never sees these routes: the
// review edge forwards /__variants to the review app, and nothing here is part of the web's bundle.
import "@web/app/(public)/public.css";
import "../../variants/variants.css";
import type { ReactNode } from "react";
import { PUBLIC_COPY } from "@web/copy/public.ts";
import { SiteFrame } from "@web/public/frame.tsx";
import { SiteThemeControl } from "@web/app/(public)/theme-control.tsx";
import { FooterColumns } from "../../variants/footer-nav.tsx";
import { HeaderNav } from "../../variants/header-nav.tsx";

const THEME_LABELS = {
  group: PUBLIC_COPY["site.theme.label"],
  light: PUBLIC_COPY["site.theme.option.light.label"],
  dark: PUBLIC_COPY["site.theme.option.dark.label"],
};

export default function VariantsLayout({ children }: { readonly children: ReactNode }) {
  return (
    <SiteFrame signInHref="/login" nav={<HeaderNav />} themeControl={<SiteThemeControl labels={THEME_LABELS} />} footerNav={<FooterColumns />}>
      {children}
    </SiteFrame>
  );
}
