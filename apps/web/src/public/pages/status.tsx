// UI08 Service status: what the capability publication says right now, or an honest unavailable state. A publication that cannot be read
// shows no service and says neither "running normally" nor "down"; a service the publication does not list is not on the page. There is no
// incident feed yet, and the page says so without implying that no incident is open.
//
// Order 10, owner review: an ordinary page that takes only the room it needs, so with nothing to report the footer is in view. Each service
// is a small card whose edge glows with its state: green when it is open for new projects, amber within limits, red when it is not.
import type { ReactElement } from "react";
import { PUBLIC_COPY } from "../../copy/public.ts";
import { availabilityOf, publishedModes, type Publication } from "../capabilities.ts";
import { modeName } from "../estimate-text.ts";
import { Eyebrow, stateText } from "../parts.tsx";
import { ROUTE } from "../site.ts";

export function StatusPage({ publication }: { readonly publication: Publication }): ReactElement {
  const modes = publishedModes(publication);
  return (
    <section className="kauro-fitpage kauro-statuspage" aria-labelledby="status-title">
      <div className="kauro-site-wrap kauro-statuspage-inner">
        <div className="kauro-statuspage-head">
          <Eyebrow>{PUBLIC_COPY["nav.status.label"]}</Eyebrow>
          <h1 id="status-title">{PUBLIC_COPY["status.title"]}</h1>
        </div>
        {publication.kind === "READ" ? (
          <div className="kauro-statuspage-board">
            <h2 className="kauro-statuspage-label">{PUBLIC_COPY["status.published.heading"]}</h2>
            {modes.length === 0 ? (
              <p className="kauro-statuspage-empty">{PUBLIC_COPY["status.none.body"]}</p>
            ) : (
              <ul className="kauro-statuspage-services">
                {modes.map((published) => {
                  const availability = availabilityOf(publication, published.mode);
                  return (
                    <li key={published.mode} className={`kauro-site-status-row kauro-site-status-row--${availability.toLowerCase()} kauro-statuspage-service`}>
                      <strong>{modeName(published.mode)}</strong> <span className="kauro-site-status-state">{stateText(availability)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : (
          <div className="kauro-statuspage-board">
            <h2 className="kauro-statuspage-label">{PUBLIC_COPY["status.unavailable.heading"]}</h2>
            <p className="kauro-statuspage-empty">{PUBLIC_COPY["status.unavailable.body"]}</p>
          </div>
        )}
        <div className="kauro-statuspage-notes">
          {publication.kind === "READ" ? (
            <div className="kauro-statuspage-note">
              <h2 className="kauro-statuspage-label">{PUBLIC_COPY["status.incidents.heading"]}</h2>
              <p>{PUBLIC_COPY["status.incidents.body"]}</p>
            </div>
          ) : null}
          <div className="kauro-statuspage-note">
            <h2 className="kauro-statuspage-label">{PUBLIC_COPY["status.help.heading"]}</h2>
            <p>{PUBLIC_COPY["status.help.body"]}</p>
            <a className="kauro-site-arrow" href={ROUTE.contact}>
              {PUBLIC_COPY["status.help.cta"]}
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
