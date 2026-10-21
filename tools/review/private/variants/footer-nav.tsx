// The footer variant (Order 11; review only): every public page, grouped, instead of four legal and status links. From the research
// (public-site-ia.md §14.3, after NN/g on footers: contact and support belong there, and a site of about 25 pages or fewer can list them all;
// Kauro has 12 linkable pages). Only pages that exist are linked: the free check's page and "For agencies" are the variants beside it;
// sub-processors and "About" are owner questions and join a column when they exist. No year or legal entity is printed until the owner
// confirms them.
import type { ReactElement } from "react";
import { PUBLIC_COPY } from "@web/copy/public.ts";
import { ROUTE } from "@web/public/site.ts";

const COLUMNS: readonly { readonly heading: string; readonly links: readonly { readonly href: string; readonly label: string }[] }[] = [
  {
    heading: "Kauro",
    links: [
      { href: "/__variants/free-check", label: "Check a file free" },
      { href: ROUTE.how, label: PUBLIC_COPY["nav.how.label"] },
      { href: ROUTE.services, label: PUBLIC_COPY["nav.services.label"] },
      { href: ROUTE.pricing, label: PUBLIC_COPY["nav.pricing.label"] },
      { href: ROUTE.sample, label: PUBLIC_COPY["nav.sample.label"] },
      { href: "/__variants/for-agencies", label: "For agencies" },
    ],
  },
  {
    heading: "Trust",
    links: [
      { href: ROUTE.security, label: PUBLIC_COPY["nav.security.label"] },
      { href: ROUTE.status, label: PUBLIC_COPY["nav.status.label"] },
    ],
  },
  {
    heading: "Help",
    links: [
      { href: ROUTE.help, label: PUBLIC_COPY["nav.help.label"] },
      { href: ROUTE.contact, label: PUBLIC_COPY["nav.contact.label"] },
    ],
  },
  {
    heading: "Account",
    links: [
      { href: "/login", label: PUBLIC_COPY["nav.signin.label"] },
      { href: "/signup", label: "Create an account" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { href: ROUTE.terms, label: PUBLIC_COPY["nav.terms.label"] },
      { href: ROUTE.privacy, label: PUBLIC_COPY["nav.privacy.label"] },
      { href: ROUTE.processing, label: PUBLIC_COPY["nav.processing.label"] },
    ],
  },
];

export function FooterColumns(): ReactElement {
  return (
    <nav className="kauro-variant-footer" aria-label={PUBLIC_COPY["site.nav.footer.label"]}>
      {COLUMNS.map((column) => (
        <div key={column.heading} className="kauro-variant-footer-column">
          <p className="kauro-variant-footer-heading">{column.heading}</p>
          <ul>
            {column.links.map((link) => (
              <li key={link.href}>
                <a href={link.href}>{link.label}</a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
