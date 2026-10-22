// UI08 Service status: what the capability publication says right now, or an honest unavailable state. A publication that cannot be read
// shows no service and says neither "running normally" nor "down"; a service the publication does not list is not on the page. There is no
// incident feed yet, and the page says so without implying that no incident is open.
//
// Order 11 round 2: a status page leads with the state and nothing else (every status page in the round-2 sample opens on one state line),
// so the services are rows of one table, a name and the state for new projects, under a real heading at the site's one section size. The
// notes on incidents and help follow as text, with no uptime bars or percentages, since no history exists to draw them from.
import type { ReactElement } from "react";
import { PUBLIC_COPY } from "../../copy/public.ts";
import { availabilityOf, publishedModes, type Publication } from "../capabilities.ts";
import { modeName } from "../estimate-text.ts";
import { Block, Head, SERVICE_ORDER, StateTag } from "../r2.tsx";
import { ROUTE } from "../site.ts";

export function StatusPage({ publication }: { readonly publication: Publication }): ReactElement {
  const listed = publishedModes(publication).map((entry) => entry.mode);
  const modes = SERVICE_ORDER.filter((mode) => listed.includes(mode));
  return (
    <>
      <Head kind="reference" eyebrow={PUBLIC_COPY["nav.status.label"]} title={PUBLIC_COPY["status.title"]} />
      {publication.kind === "READ" ? (
        <Block id="status-services" heading={PUBLIC_COPY["status.published.heading"]} variant="kauro-r2-block--first">
          {modes.length === 0 ? (
            <p className="kauro-r2-callout">{PUBLIC_COPY["status.none.body"]}</p>
          ) : (
            <div className="kauro-r2-table-region">
              <table className="kauro-r2-status">
                <caption>{PUBLIC_COPY["status.table.caption"]}</caption>
                <thead>
                  <tr>
                    <th scope="col">{PUBLIC_COPY["status.service.label"]}</th>
                    <th scope="col">{PUBLIC_COPY["status.state.label"]}</th>
                  </tr>
                </thead>
                <tbody>
                  {modes.map((mode) => (
                    <tr key={mode}>
                      <th scope="row">{modeName(mode)}</th>
                      <td>
                        <StateTag availability={availabilityOf(publication, mode)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Block>
      ) : (
        <Block id="status-services" heading={PUBLIC_COPY["status.unavailable.heading"]} variant="kauro-r2-block--first">
          <p className="kauro-r2-callout">{PUBLIC_COPY["status.unavailable.body"]}</p>
        </Block>
      )}
      <Block id="status-notes" heading={PUBLIC_COPY["status.help.heading"]} layout="split">
        {publication.kind === "READ" ? <p>{PUBLIC_COPY["status.incidents.body"]}</p> : null}
        <p>{PUBLIC_COPY["status.help.body"]}</p>
        <a className="kauro-site-arrow" href={ROUTE.contact}>
          {PUBLIC_COPY["status.help.cta"]}
        </a>
      </Block>
    </>
  );
}
