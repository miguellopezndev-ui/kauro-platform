// UI08 Service status: what the capability publication says right now and when it was read, or an honest unavailable state. A publication
// that cannot be read shows no service and says neither "running normally" nor "down"; a service the publication does not list is not on the
// page. There is no incident feed yet, and the page says so without implying that no incident is open.
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
      <PageHead title={PUBLIC_COPY["status.title"]} />
      {publication.kind === "READ" ? (
        <>
          <p className="kauro-site-lead">{copy("status.observed.body", { time: formatInstant(publication.observedAt) })}</p>
          <Section id="status-published" heading={PUBLIC_COPY["status.published.heading"]}>
            {modes.length === 0 ? (
              <p>{PUBLIC_COPY["status.none.body"]}</p>
            ) : (
              <ul className="kauro-site-list">
                {modes.map((published) => (
                  <li key={published.mode}>
                    <strong>{modeName(published.mode)}</strong> {stateText(availabilityOf(publication, published.mode))}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section id="status-incidents" heading={PUBLIC_COPY["status.incidents.heading"]}>
            <p>{PUBLIC_COPY["status.incidents.body"]}</p>
          </Section>
        </>
      ) : (
        <Section id="status-unavailable" heading={PUBLIC_COPY["status.unavailable.heading"]}>
          <p>{PUBLIC_COPY["status.unavailable.body"]}</p>
        </Section>
      )}
      <Section id="status-help" heading={PUBLIC_COPY["status.help.heading"]}>
        <p>{PUBLIC_COPY["status.help.body"]}</p>
        <div className="kauro-site-actions">
          <LinkButton href={ROUTE.contact}>{PUBLIC_COPY["status.help.cta"]}</LinkButton>
        </div>
      </Section>
    </>
  );
}
