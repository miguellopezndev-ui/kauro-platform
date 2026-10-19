// UI08 Service status: what the capability publication says right now, or an honest unavailable state. A publication that cannot be read
// shows no service and says neither "running normally" nor "down"; a service the publication does not list is not on the page. There is no
// incident feed yet, and the page says so without implying that no incident is open.
//
// The page is one card of the product, as the not-found page is (Order 10, owner review): the status board, set in the middle of the page
// and tilted like a sheet left on a desk, a lamp beside each service, the incidents line and the way to ask for help on the same card. It
// straightens when it is pointed at.
import type { ReactElement } from "react";
import { PUBLIC_COPY } from "../../copy/public.ts";
import { availabilityOf, publishedModes, type Publication } from "../capabilities.ts";
import { modeName } from "../estimate-text.ts";
import { stateText } from "../parts.tsx";
import { ROUTE } from "../site.ts";

export function StatusPage({ publication }: { readonly publication: Publication }): ReactElement {
  const modes = publishedModes(publication);
  return (
    <section className="kauro-cardpage" aria-labelledby="status-title">
      <div className="kauro-cardsheet kauro-paper">
        <p className="kauro-cardsheet-bar" aria-hidden="true">
          <span className="kauro-cardsheet-brand">{PUBLIC_COPY["site.name"]}</span>
          <span className="kauro-cardsheet-title">{PUBLIC_COPY["nav.status.label"]}</span>
        </p>
        <div className="kauro-cardsheet-body">
          <h1 id="status-title">{PUBLIC_COPY["status.title"]}</h1>
          {publication.kind === "READ" ? (
            <>
              <h2 className="kauro-cardsheet-label">{PUBLIC_COPY["status.published.heading"]}</h2>
              {modes.length === 0 ? (
                <p className="kauro-cardsheet-empty">{PUBLIC_COPY["status.none.body"]}</p>
              ) : (
                <ul className="kauro-site-status-list kauro-cardsheet-list">
                  {modes.map((published) => {
                    const availability = availabilityOf(publication, published.mode);
                    return (
                      <li key={published.mode} className={`kauro-site-status-row kauro-site-status-row--${availability.toLowerCase()}`}>
                        <strong>{modeName(published.mode)}</strong> <span className="kauro-site-status-state">{stateText(availability)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="kauro-cardsheet-note">
                <h2 className="kauro-cardsheet-label">{PUBLIC_COPY["status.incidents.heading"]}</h2>
                <p>{PUBLIC_COPY["status.incidents.body"]}</p>
              </div>
            </>
          ) : (
            <>
              <h2 className="kauro-cardsheet-label">{PUBLIC_COPY["status.unavailable.heading"]}</h2>
              <p className="kauro-cardsheet-empty">{PUBLIC_COPY["status.unavailable.body"]}</p>
              <div className="kauro-cardsheet-blank" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            </>
          )}
        </div>
        <div className="kauro-cardsheet-foot">
          <h2 className="kauro-cardsheet-label">{PUBLIC_COPY["status.help.heading"]}</h2>
          <p>{PUBLIC_COPY["status.help.body"]}</p>
          <a className="kauro-site-arrow" href={ROUTE.contact}>
            {PUBLIC_COPY["status.help.cta"]}
          </a>
        </div>
      </div>
    </section>
  );
}
