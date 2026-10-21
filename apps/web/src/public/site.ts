// The public site's route table, navigation and page metadata (D-TOPO-1: the public origin serves exactly these screens and the legal
// pages). The routes are the registry's (test/public-data.test.ts holds them equal), the labels are catalogue messages, and a page's h1
// is its `<key>.title` message, which the test holds equal to the registry's primary copy for the screen.
import { PUBLIC_COPY, type PublicCopyId } from "../copy/public.ts";

export const ROUTE = Object.freeze({
  home: "/",
  how: "/how-it-works",
  services: "/supported-services",
  pricing: "/pricing",
  sample: "/sample-delivery",
  security: "/security",
  contact: "/contact",
  status: "/status",
  help: "/help",
  terms: "/legal/terms",
  privacy: "/legal/privacy",
  processing: "/legal/data-processing",
});

export type PageKey = "home" | "how" | "services" | "pricing" | "sample" | "security" | "contact" | "status" | "help" | "unsubscribe";

export interface SitePage {
  readonly key: PageKey;
  /** The registry's screen id. */
  readonly screen: string;
  /** The registry's route pattern. */
  readonly route: string;
}

export const SITE_PAGES: readonly SitePage[] = Object.freeze([
  { key: "home", screen: "UI01", route: ROUTE.home },
  { key: "how", screen: "UI02", route: ROUTE.how },
  { key: "services", screen: "UI03", route: ROUTE.services },
  { key: "pricing", screen: "UI04", route: ROUTE.pricing },
  { key: "sample", screen: "UI05", route: ROUTE.sample },
  { key: "security", screen: "UI06", route: ROUTE.security },
  { key: "contact", screen: "UI07", route: ROUTE.contact },
  { key: "status", screen: "UI08", route: ROUTE.status },
  { key: "help", screen: "UI48", route: ROUTE.help },
  { key: "unsubscribe", screen: "UI49", route: "/unsubscribe/{token}" },
]);

export interface NavItem {
  readonly href: string;
  readonly label: PublicCopyId;
}

/**
 * The header, in the order a buyer reads the site (Order 11 round 2): what Kauro does, which services are open, what it costs, the proof, how
 * data is handled. Every one of the B2B headers measured shows its main pages in one line on a wide screen (31 of 31) and ends in one
 * filled button (30 of 31); none leads with Home (the name is the way home). Help and Contact sit in the footer, where help is looked for,
 * and the call to action already opens Contact.
 */
export const HEADER_NAV: readonly NavItem[] = Object.freeze([
  { href: ROUTE.how, label: "nav.how.label" },
  { href: ROUTE.services, label: "nav.services.short.label" },
  { href: ROUTE.pricing, label: "nav.pricing.label" },
  { href: ROUTE.sample, label: "nav.sample.label" },
  { href: ROUTE.security, label: "nav.security.label" },
]);

/** The menu of a narrow screen: the header's pages, then Help and Contact, so a phone reaches every page from the top. */
export const MAIN_NAV: readonly NavItem[] = Object.freeze([...HEADER_NAV, { href: ROUTE.help, label: "nav.help.label" }, { href: ROUTE.contact, label: "nav.contact.label" }]);

export const FOOTER_NAV: readonly NavItem[] = Object.freeze([
  { href: ROUTE.help, label: "nav.help.label" },
  { href: ROUTE.contact, label: "nav.contact.label" },
  { href: ROUTE.status, label: "nav.status.label" },
  { href: ROUTE.terms, label: "nav.terms.label" },
  { href: ROUTE.privacy, label: "nav.privacy.label" },
  { href: ROUTE.processing, label: "nav.processing.label" },
]);

export interface PageMetadata {
  readonly title: string;
  readonly description: string;
}

/**
 * The document title and description of a page. The title gets the site name from the layout's template, except the home page: a layout's
 * template does not reach a page of its own route segment, so the home title (copy "home.meta.title") carries the site name itself.
 */
export function pageMetadata(key: PageKey): PageMetadata {
  return { title: PUBLIC_COPY[`${key}.meta.title`], description: PUBLIC_COPY[`${key}.meta.description`] };
}
