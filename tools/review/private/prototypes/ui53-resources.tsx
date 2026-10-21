"use client";
// UI53 Seller resources (registry: "Use the current approved offer."). The approved material a seller may use, each a version
// (SalesResourceView: family, version, current or superseded): the offer sheet, the worked example, the answers to usual questions and the
// limits of what a seller may promise. A superseded version says what replaced it and why, and cannot be used to prepare a new message
// (registry exception: an obsolete claim is never reused silently). The repeat discount is the buyer's own, by the policy's ladder; a seller
// never offers a discount of their own.
import { LinkButton } from "@kauro/ui";
import { type ReactElement } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, day, PageHead, ScreenButton } from "./kit.tsx";
import { REPEAT_TIERS, RESOURCES } from "./sales.ts";

export const UI53_STATES: readonly StateDef[] = [
  { key: "normal", label: "Resources", note: "Four current resources and one superseded offer sheet, marked with what replaced it." },
];

export function Resources({ ctx }: PrototypeProps): ReactElement {
  const current = RESOURCES.filter((one) => one.state === "CURRENT");
  const old = RESOURCES.filter((one) => one.state === "SUPERSEDED");
  const tiers = REPEAT_TIERS.filter((tier) => tier.percent > 0)
    .map((tier) => `${tier.percent}% from ${tier.minimum} earlier ${tier.minimum === 1 ? "project" : "projects"}`)
    .join(", ");
  return (
    <>
      <PageHead title="Resources" lead="Use the current approved offer." />
      <ul className="kauro-resources">
        {current.map((resource) => (
          <li key={resource.family} className="kauro-resource">
            <div className="kauro-resource-head">
              <h2>{resource.family}</h2>
              <Badge tone="success">Current · version {resource.version}</Badge>
            </div>
            <p>{resource.what}</p>
            <p className="kauro-muted-text">Since {day(`${resource.since}T00:00:00Z`)} · English</p>
            <div className="kauro-actions">
              <LinkButton href={`#${resource.family.toLowerCase().replace(/ /g, "-")}`} variant="secondary">
                Open<span className="kauro-visually-hidden"> {resource.family.toLowerCase()}</span>
              </LinkButton>
              {resource.family === "Worked example" ? (
                <ScreenButton to="UI54" ctx={ctx}>
                  Use it in a message
                </ScreenButton>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <section className="kauro-screen-section" aria-labelledby="price-h">
        <h2 id="price-h">What you may say about price</h2>
        <ul>
          <li>The public price bands, and that the data health check is free.</li>
          <li>The repeat discount a buyer earns by itself: {tiers}. It is never yours to give or to promise early.</li>
          <li>No other discount, deadline or result. What a seller may promise has the full list.</li>
        </ul>
      </section>
      <section className="kauro-screen-section" aria-labelledby="old-h">
        <h2 id="old-h">Superseded</h2>
        <ul className="kauro-resources">
          {old.map((resource) => (
            <li key={`${resource.family}-${resource.version}`} className="kauro-resource is-superseded">
              <div className="kauro-resource-head">
                <h3>
                  {resource.family}, version {resource.version}
                </h3>
                <Badge tone="neutral">Superseded</Badge>
              </div>
              <p>{resource.what}.</p>
              <p className="kauro-muted-text">Replaced by {resource.replacedBy}. It cannot be used in a new message.</p>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
