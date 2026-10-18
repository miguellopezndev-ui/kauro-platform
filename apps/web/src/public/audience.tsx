// Who buys Kauro, on Home (A10 §8): two cards laid one over the other, an agency's and an in-house team's, held together by one stamp,
// because the point is that both buy the same thing at the same price. The agency card lists three invented client workspaces at different
// phases; the in-house card has one. Everything is on the page at once; nothing is behind a switch.
import type { ReactElement } from "react";
import { PUBLIC_COPY, type PublicCopyId } from "../copy/public.ts";
import { SAMPLE_CLIENTS } from "./sample-data.ts";

const PHASE: Readonly<Record<(typeof SAMPLE_CLIENTS)[number]["phase"], PublicCopyId>> = {
  check: "home.app.phase.check.label",
  decide: "home.app.phase.decide.label",
  ready: "home.app.state.label",
};

function Workspace({ name, phase }: { readonly name: string; readonly phase: keyof typeof PHASE }): ReactElement {
  return (
    <li className={`kauro-buyer-space kauro-buyer-space--${phase}`}>
      <span className="kauro-buyer-space-name">{name}</span>
      <span className="kauro-buyer-space-phase">{PUBLIC_COPY[PHASE[phase]]}</span>
    </li>
  );
}

export function Audience(): ReactElement {
  return (
    <div className="kauro-buyers">
      <article className="kauro-buyer kauro-buyer--agency kauro-inverse" aria-labelledby="buyer-agency">
        <h3 id="buyer-agency">{PUBLIC_COPY["home.buyer.agency.name"]}</h3>
        <p>{PUBLIC_COPY["home.audience.agency.body"]}</p>
        <ul className="kauro-buyer-spaces" aria-hidden="true">
          {SAMPLE_CLIENTS.map((client) => (
            <Workspace key={client.name} name={client.name} phase={client.phase} />
          ))}
        </ul>
        <p className="kauro-buyer-foot" aria-hidden="true">
          {PUBLIC_COPY["home.audience.reports"]}
        </p>
      </article>
      <article className="kauro-buyer kauro-buyer--company" aria-labelledby="buyer-company">
        <h3 id="buyer-company">{PUBLIC_COPY["home.buyer.company.name"]}</h3>
        <p>{PUBLIC_COPY["home.audience.company.body"]}</p>
        <ul className="kauro-buyer-spaces" aria-hidden="true">
          <Workspace name={PUBLIC_COPY["home.audience.workspace"]} phase="decide" />
        </ul>
      </article>
      <p className="kauro-buyers-stamp" aria-hidden="true">
        {PUBLIC_COPY["home.note.same"]}
      </p>
    </div>
  );
}
