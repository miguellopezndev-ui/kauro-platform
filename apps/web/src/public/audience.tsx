"use client";

// Who buys (Home): the visitor says which they are, an agency or a company, and the workspace beside it shows what that looks like in
// Kauro: one workspace per client for an agency, one for a company, and the same price either way (D-33). Without the script both are
// shown one after the other.
import type { ReactElement } from "react";
import { PUBLIC_COPY, type PublicCopyId } from "../copy/public.ts";
import { formatUsd, startingPrice } from "./pricing-bands.ts";
import { SAMPLE_CLIENTS } from "./sample-data.ts";
import { useTabs } from "./tabs.ts";

const KINDS = [
  { key: "agency", name: "home.buyer.agency.name", body: "home.audience.agency.body" },
  { key: "company", name: "home.buyer.company.name", body: "home.audience.company.body" },
] as const satisfies ReadonlyArray<{ readonly key: string; readonly name: PublicCopyId; readonly body: PublicCopyId }>;

const PHASE: Readonly<Record<(typeof SAMPLE_CLIENTS)[number]["phase"], PublicCopyId>> = {
  check: "home.app.phase.check.label",
  decide: "home.app.phase.decide.label",
  ready: "home.app.state.label",
};

const cx = (...names: ReadonlyArray<string | false>): string => names.filter((name) => name !== false && name !== "").join(" ");

function Price(): ReactElement {
  return (
    <span className="kauro-audience-price">
      <span className="kauro-audience-price-label">{PUBLIC_COPY["pricing.ladder.clean.name"]}</span>
      <span className="kauro-audience-price-figure">{formatUsd(startingPrice("CLEAN"))}</span>
    </span>
  );
}

function Agency(): ReactElement {
  return (
    <div className="kauro-audience-stage">
      <div className="kauro-audience-switcher">
        {SAMPLE_CLIENTS.map((client, index) => (
          <span key={client.name} className={cx("kauro-audience-client", index === 0 && "is-open", `kauro-audience-client--${client.phase}`)}>
            <span className="kauro-audience-client-name">{client.name}</span>
            <span className="kauro-audience-client-phase">{PUBLIC_COPY[PHASE[client.phase]]}</span>
          </span>
        ))}
      </div>
      <div className="kauro-audience-foot">
        <span className="kauro-audience-chip">{PUBLIC_COPY["home.audience.reports"]}</span>
        <Price />
      </div>
    </div>
  );
}

function Company(): ReactElement {
  return (
    <div className="kauro-audience-stage">
      <div className="kauro-audience-switcher">
        <span className="kauro-audience-client is-open kauro-audience-client--ready">
          <span className="kauro-audience-client-name">{PUBLIC_COPY["home.audience.workspace"]}</span>
          <span className="kauro-audience-client-phase">{PUBLIC_COPY["home.app.state.label"]}</span>
        </span>
      </div>
      <div className="kauro-audience-foot">
        <span className="kauro-audience-chip kauro-audience-chip--note">{PUBLIC_COPY["home.note.same"]}</span>
        <Price />
      </div>
    </div>
  );
}

export function Audience(): ReactElement {
  const tabs = useTabs(KINDS.length);
  return (
    <div className={cx("kauro-audience", tabs.ready && "is-ready")}>
      <div className="kauro-audience-switch" role="tablist" aria-label={PUBLIC_COPY["home.audience.label"]} onKeyDown={tabs.onKeyDown}>
        {KINDS.map((kind, index) => (
          <button
            key={kind.key}
            ref={(element) => {
              tabs.refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`audience-tab-${kind.key}`}
            aria-selected={tabs.index === index}
            aria-controls={`audience-panel-${kind.key}`}
            tabIndex={tabs.index === index ? 0 : -1}
            className="kauro-audience-option"
            onClick={() => tabs.select(index)}
          >
            {PUBLIC_COPY[kind.name]}
          </button>
        ))}
      </div>
      {KINDS.map((kind, index) => {
        const shown = !tabs.ready || tabs.index === index;
        return (
          <div key={kind.key} role="tabpanel" id={`audience-panel-${kind.key}`} aria-labelledby={`audience-tab-${kind.key}`} hidden={!shown} className="kauro-audience-panel">
            <div className="kauro-audience-copy">
              <h3>{PUBLIC_COPY[kind.name]}</h3>
              <p>{PUBLIC_COPY[kind.body]}</p>
              {kind.key === "company" ? <p className="kauro-audience-terms">{PUBLIC_COPY["pricing.in-house.body"]}</p> : null}
            </div>
            {kind.key === "agency" ? <Agency /> : <Company />}
          </div>
        );
      })}
    </div>
  );
}
