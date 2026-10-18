// UI08 Service status: what the capability publication says right now and when it was read, or an honest unavailable state. A publication
// that cannot be read shows no service and says neither "running normally" nor "down"; a service the publication does not list is not on the
// page. There is no incident feed yet, and the page says so without implying that no incident is open. The services read are one panel in
// the product's own form, a lamp beside each state (A10 §8).
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy } from "../../copy/public.ts";
import { availabilityOf, formatInstant, publishedModes, type Publication } from "../capabilities.ts";
import { modeName } from "../estimate-text.ts";
import { LinkButton, PageHead, Section, stateText } from "../parts.tsx";
import { ROUTE } from "../site.ts";

export function StatusPage({ publication }: { readonly publication: Publication }): ReactElement {
  const modes = publishedModes(publication);
  return (
    <>
      <PageHead size="compact" accent={1} eyebrow={PUBLIC_COPY["nav.status.label"]} title={PUBLIC_COPY["status.title"]}>
        {publication.kind === "READ" ? <p className="kauro-site-observed">{copy("status.observed.body", { time: formatInstant(publication.observedAt) })}</p> : null}
      </PageHead>
      {publication.kind === "READ" ? (
        <>
          <Section id="status-published" heading={PUBLIC_COPY["status.published.heading"]} layout="split">
            {modes.length === 0 ? (
              <p className="kauro-site-callout">{PUBLIC_COPY["status.none.body"]}</p>
            ) : (
              <div className="kauro-status-panel kauro-paper">
                <p className="kauro-status-bar" aria-hidden="true">
                  <span className="kauro-status-brand">{PUBLIC_COPY["site.name"]}</span>
                  <span className="kauro-status-title">{PUBLIC_COPY["nav.status.label"]}</span>
                </p>
                <ul className="kauro-site-status-list">
                  {modes.map((published) => {
                    const availability = availabilityOf(publication, published.mode);
                    return (
                      <li key={published.mode} className={`kauro-site-status-row kauro-site-status-row--${availability.toLowerCase()}`}>
                        <strong>{modeName(published.mode)}</strong> <span className="kauro-site-status-state">{stateText(availability)}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </Section>
          <Section id="status-incidents" heading={PUBLIC_COPY["status.incidents.heading"]} layout="split">
            <p className="kauro-site-muted">{PUBLIC_COPY["status.incidents.body"]}</p>
          </Section>
        </>
      ) : (
        <Section id="status-unavailable" heading={PUBLIC_COPY["status.unavailable.heading"]}>
          <p className="kauro-site-callout">{PUBLIC_COPY["status.unavailable.body"]}</p>
        </Section>
      )}
      <Section id="status-help" heading={PUBLIC_COPY["status.help.heading"]} layout="split" tone="sunken" variant="kauro-site-band-compact">
        <p>{PUBLIC_COPY["status.help.body"]}</p>
        <div className="kauro-site-actions">
          <LinkButton href={ROUTE.contact}>{PUBLIC_COPY["status.help.cta"]}</LinkButton>
        </div>
      </Section>
    </>
  );
}
