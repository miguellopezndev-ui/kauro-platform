// UI48 Help (A3 3.8): static, versioned guides written by Kauro and using only invented examples. There is no search and no form here; an
// index links to each guide, and the guides' version and date are stated on the page (test/public-data.test.ts holds a recorded digest of
// the guides' text under that version, so a changed guide cannot ship under an old version).
//
// Order 11 round 2: a reference page, with the reference heading size. The two ways to get help (a support case from the project when
// signed in, the contact page before that) are said once at the top, where a reader with a problem looks first. Seven guides are a list,
// not a grid of cards; the index stays beside the guides on a wide screen and above them on a phone.
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy } from "../../copy/public.ts";
import { GUIDES_CHANGED, GUIDES_VERSION, guides } from "../guides.ts";
import { Head } from "../r2.tsx";
import { ROUTE } from "../site.ts";

export function HelpPage(): ReactElement {
  const list = guides();
  return (
    <>
      <Head kind="reference" eyebrow={PUBLIC_COPY["nav.help.label"]} title={PUBLIC_COPY["help.title"]} lead={PUBLIC_COPY["help.lead"]}>
        <p className="kauro-r2-meta">{copy("help.version", { version: GUIDES_VERSION, date: GUIDES_CHANGED })}</p>
      </Head>
      <div className="kauro-r2-docs">
        <div className="kauro-site-wrap kauro-r2-docs-inner">
          <nav className="kauro-r2-toc" aria-label={PUBLIC_COPY["help.index.label"]}>
            <p className="kauro-r2-toc-title" aria-hidden="true">
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
          <div className="kauro-r2-guides">
            {list.map((guide) => (
              <section key={guide.slug} id={`guide-${guide.slug}`} className="kauro-r2-guide" aria-labelledby={`guide-${guide.slug}-heading`}>
                <h2 id={`guide-${guide.slug}-heading`}>{guide.heading}</h2>
                <p className="kauro-r2-guide-summary">{guide.summary}</p>
                {guide.paragraphs.map((paragraph) => (
                  <p key={paragraph.id}>{paragraph.text}</p>
                ))}
                {guide.slug === "retention" ? (
                  <a className="kauro-site-arrow" href={ROUTE.security}>
                    {PUBLIC_COPY["security.retention.heading"]}
                  </a>
                ) : null}
                {guide.slug === "support" ? (
                  <a className="kauro-site-button" href={ROUTE.contact}>
                    {PUBLIC_COPY["help.contact.cta"]}
                  </a>
                ) : null}
              </section>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
