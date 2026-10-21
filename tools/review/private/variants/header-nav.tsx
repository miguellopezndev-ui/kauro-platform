"use client";
// The header variant (Order 11; review only): the main pages in a line on wide screens, without "Home" (the name is the way home), and
// one primary action, "Check a file free" (the owner's call to action, answer 7). On narrow screens the same pages stay in a menu, the
// action last. From the research (navigation-copy-selling.md §7.1; public-site-ia.md §14.1 and §14.2): 4 to 7 visible items in the sample,
// Pricing at the top level, one page for agencies rather than a parallel site, Help as a utility, a single filled button. The approved
// header folds every page into a menu at every width; this variant keeps that menu only where a line does not fit.
import { usePathname } from "next/navigation";
import type { ReactElement } from "react";
import { PUBLIC_COPY } from "@web/copy/public.ts";
import { ROUTE } from "@web/public/site.ts";

const ITEMS: readonly { readonly href: string; readonly label: string }[] = [
  { href: ROUTE.how, label: PUBLIC_COPY["nav.how.label"] },
  { href: ROUTE.services, label: PUBLIC_COPY["nav.services.label"] },
  { href: ROUTE.pricing, label: PUBLIC_COPY["nav.pricing.label"] },
  { href: ROUTE.sample, label: PUBLIC_COPY["nav.sample.label"] },
  { href: ROUTE.security, label: PUBLIC_COPY["nav.security.label"] },
  { href: "/__variants/for-agencies", label: "For agencies" },
];
const HELP = { href: ROUTE.help, label: PUBLIC_COPY["nav.help.label"] };
const UTILITIES: readonly { readonly href: string; readonly label: string }[] = [HELP, { href: ROUTE.contact, label: PUBLIC_COPY["nav.contact.label"] }];
const ACTION = { href: "/__variants/free-check", label: "Check a file free" };

/** The variant pages stand for the approved pages they vary: /__variants/supported-services is Supported services. */
const isCurrent = (pathname: string, href: string): boolean => pathname === href || pathname === href.replace(/^\//, "/__variants/");

export function HeaderNav(): ReactElement {
  const pathname = usePathname();
  const link = (item: { readonly href: string; readonly label: string }): ReactElement => (
    <a href={item.href} aria-current={isCurrent(pathname, item.href) ? "page" : undefined}>
      {item.label}
    </a>
  );
  return (
    <nav className="kauro-variant-nav" aria-label={PUBLIC_COPY["site.nav.main.label"]}>
      <ul className="kauro-variant-nav-line">
        {ITEMS.map((item) => (
          <li key={item.href}>{link(item)}</li>
        ))}
        <li className="kauro-variant-nav-utility">{link(HELP)}</li>
        <li>
          <a className="kauro-variant-nav-action" href={ACTION.href}>
            {ACTION.label}
          </a>
        </li>
      </ul>
      <details className="kauro-variant-nav-menu">
        <summary>Menu</summary>
        <ul>
          {[...ITEMS, ...UTILITIES].map((item) => (
            <li key={item.href}>{link(item)}</li>
          ))}
          <li>
            <a className="kauro-variant-nav-action" href={ACTION.href}>
              {ACTION.label}
            </a>
          </li>
        </ul>
      </details>
    </nav>
  );
}
