// UI48 Help (A3 3.8): static, versioned guides written by Kauro and using only invented examples. There is no search and no form here; an
// index links to each guide, and the guides' version and date are stated on the page (test/public-data.test.ts holds a recorded digest of
// the guides' text under that version, so a changed guide cannot ship under an old version).
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy } from "../../copy/public.ts";
import { GUIDES_CHANGED, GUIDES_VERSION, guides } from "../guides.ts";
import { LinkButton, PageHead, Section } from "../parts.tsx";
import { ROUTE } from "../site.ts";

export function HelpPage(): ReactElement {
  const list = guides();
  return (
    <>
      <PageHead title={PUBLIC_COPY["help.title"]} lead={PUBLIC_COPY["help.lead"]} />
      <p className="kauro-site-note">{copy("help.version", { version: GUIDES_VERSION, date: GUIDES_CHANGED })}</p>
      <nav className="kauro-site-toc" aria-label={PUBLIC_COPY["help.index.label"]}>
        <ul className="kauro-site-list">
          {list.map((guide) => (
            <li key={guide.slug}>
              <a href={`#guide-${guide.slug}`}>{guide.heading}</a>
            </li>
          ))}
        </ul>
      </nav>
      {list.map((guide) => (
        <Section key={guide.slug} id={`guide-${guide.slug}`} heading={guide.heading}>
          <p className="kauro-site-lead">{guide.summary}</p>
          {guide.paragraphs.map((paragraph) => (
            <p key={paragraph.id}>{paragraph.text}</p>
          ))}
          {guide.slug === "retention" ? (
            <p>
              <a href={ROUTE.security}>{PUBLIC_COPY["security.retention.heading"]}</a>
            </p>
          ) : null}
          {guide.slug === "support" ? (
            <div className="kauro-site-actions">
              <LinkButton href={ROUTE.contact}>{PUBLIC_COPY["help.contact.cta"]}</LinkButton>
            </div>
          ) : null}
        </Section>
      ))}
    </>
  );
}
