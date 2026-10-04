// The frame every public page shares (UI01-UI08, UI48, UI49): a skip link, the site header with its navigation and the sign-in link, the
// main region every page renders into, and a footer with the service links and the one-line limit of what Kauro does.
//
// Pure markup with no router: the navigation that marks the current page is handed in (the client component src/app/(public)/main-nav.tsx
// reads the path), so node:test renders this whole frame. Classes are all kauro-site-*: this frame and W3's application shell never share a
// selector. The main region's id is the one the application shell also uses for its skip link.
import type { ReactElement, ReactNode } from "react";
import { PUBLIC_COPY, type PublicCopyId } from "../copy/public.ts";
import { FOOTER_NAV, ROUTE, type NavItem } from "./site.ts";

export const MAIN_ID = "kauro-main";

export interface NavListProps {
  readonly items: readonly NavItem[];
  /** The path of the page being shown, or null when the page is not in this list (nothing is then marked current). */
  readonly current: string | null;
  readonly label: PublicCopyId;
}

/** A named list of links; the one whose address is the current path carries aria-current="page". */
export function NavList({ items, current, label }: NavListProps): ReactElement {
  return (
    <nav className="kauro-site-nav" aria-label={PUBLIC_COPY[label]}>
      <ul className="kauro-site-nav-list">
        {items.map((item) => (
          <li key={item.href}>
            <a href={item.href} aria-current={item.href === current ? "page" : undefined}>
              {PUBLIC_COPY[item.label]}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export interface SiteFrameProps {
  /** Where "Sign in" leads (an absolute application address in a split deployment, see signInUrl). */
  readonly signInHref: string;
  /** The header navigation. */
  readonly nav: ReactNode;
  /** The footer navigation; the plain list when not given. */
  readonly footerNav?: ReactNode;
  readonly children: ReactNode;
}

export function SiteFrame({ signInHref, nav, footerNav, children }: SiteFrameProps): ReactElement {
  return (
    <>
      <a className="kauro-site-skip" href={`#${MAIN_ID}`}>
        {PUBLIC_COPY["site.skip.label"]}
      </a>
      <header className="kauro-site-header">
        <div className="kauro-site-header-inner">
          <a className="kauro-site-brand" href={ROUTE.home}>
            {PUBLIC_COPY["site.name"]}
          </a>
          {nav}
          <a className="kauro-site-signin" href={signInHref}>
            {PUBLIC_COPY["nav.signin.label"]}
          </a>
        </div>
      </header>
      <main id={MAIN_ID} className="kauro-site-main" tabIndex={-1}>
        {children}
      </main>
      <footer className="kauro-site-footer">
        <div className="kauro-site-footer-inner">
          {footerNav ?? <NavList items={FOOTER_NAV} current={null} label="site.nav.footer.label" />}
          <p className="kauro-site-footer-note">{PUBLIC_COPY["site.footer.note"]}</p>
        </div>
      </footer>
    </>
  );
}
