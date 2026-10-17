// UI48 Help (A3 3.8): static, versioned guides written by Kauro and using only invented examples. There is no search and no form here; an
// index links to each guide, and the guides' version and date are stated on the page (test/public-data.test.ts holds a recorded digest of
// the guides' text under that version, so a changed guide cannot ship under an old version).
//
// Laid out like documentation: the index stays beside the guides on a wide screen, and each guide opens with its summary.
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy } from "../../copy/public.ts";
import { GUIDES_CHANGED, GUIDES_VERSION, guides } from "../guides.ts";
import { LinkButton, PageHead } from "../parts.tsx";
import { ROUTE } from "../site.ts";

export function HelpPage(): ReactElement {
  const list = guides();
  return (
    <>
      <PageHead size="compact" tone="sunken" accent={3} eyebrow={PUBLIC_COPY["nav.help.label"]} title={PUBLIC_COPY["help.title"]} lead={PUBLIC_COPY["help.lead"]}>
        <p className="kauro-site-meta">{copy("help.version", { version: GUIDES_VERSION, date: GUIDES_CHANGED })}</p>
      </PageHead>
      <div className="kauro-site-docs">
        <div className="kauro-site-wrap kauro-site-docs-inner">
          <nav className="kauro-site-toc" aria-label={PUBLIC_COPY["help.index.label"]}>
            <p className="kauro-site-toc-title" aria-hidden="true">
              {PUBLIC_COPY["help.index.label"]}
            </p>
            <ul>
              {list.map((guide) => (
                <li key={guide.slug}>
                  <a href={`#guide-${guide.slug}`}>{guide.heading}</a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="kauro-site-guides">
            {list.map((guide) => (
              <section key={guide.slug} id={`guide-${guide.slug}`} className="kauro-site-guide" aria-labelledby={`guide-${guide.slug}-heading`}>
                <h2 id={`guide-${guide.slug}-heading`}>{guide.heading}</h2>
                <p className="kauro-site-guide-summary">{guide.summary}</p>
                {guide.paragraphs.map((paragraph) => (
                  <p key={paragraph.id}>{paragraph.text}</p>
                ))}
                {guide.slug === "retention" ? (
                  <p>
                    <LinkButton href={ROUTE.security} kind="text">
                      {PUBLIC_COPY["security.retention.heading"]}
                    </LinkButton>
                  </p>
                ) : null}
                {guide.slug === "support" ? (
                  <div className="kauro-site-actions">
                    <LinkButton href={ROUTE.contact}>{PUBLIC_COPY["help.contact.cta"]}</LinkButton>
                  </div>
                ) : null}
              </section>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
