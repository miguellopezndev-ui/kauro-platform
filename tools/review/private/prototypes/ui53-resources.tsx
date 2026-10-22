"use client";
// UI53 Resources (registry: "Use the current approved offer."). Round 2 (seller-portal.md §11). What a seller may say comes first, because
// it is what keeps a seller from promising what Kauro does not offer (ToS §20.1). Then the current resources grouped by the question they
// answer (explain, answer, limits), not by file type, each with its version and the date it became current, and two actions: open it, use
// it in a message. Replaced versions stay visible at the foot, greyed, with what replaced them and when; they cannot be used. A draft that
// quotes a replaced version is flagged in Outreach and never changed silently. The repeat discount is the buyer's own, by the policy's
// ladder; a seller never offers a discount of their own.
import Link from "next/link";
import { type ReactElement } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { OPS_PATH, OpsHead, OpsPage, SectionHead, Word } from "./ops-kit.tsx";
import { REPEAT_TIERS, RESOURCES, type Resource } from "./sales.ts";

export const UI53_STATES: readonly StateDef[] = [{ key: "normal", label: "Resources", note: "What you may say first; four current resources by purpose; one replaced offer sheet at the foot." }];

const PURPOSES: readonly { readonly key: Resource["purpose"]; readonly title: string; readonly meta: string }[] = [
  { key: "Explain", title: "Explain Kauro", meta: "What Kauro does, for whom, and what it costs" },
  { key: "Answer", title: "Answer questions", meta: "Each answer points to the public page that backs it" },
  { key: "Limits", title: "Know the limits", meta: "What a seller may and may not promise" },
];

export function Resources(_props: PrototypeProps): ReactElement {
  const tiers = REPEAT_TIERS.filter((tier) => tier.percent > 0)
    .map((tier) => `${tier.percent}% from ${tier.minimum} earlier ${tier.minimum === 1 ? "project" : "projects"}`)
    .join(", ");
  const replaced = RESOURCES.filter((one) => one.state === "SUPERSEDED");
  return (
    <OpsPage>
      <OpsHead title="Resources" lead="The current approved material. Quote only these." />
      <section aria-labelledby="say-h">
        <SectionHead id="say-h" title="What you may say" />
        <dl className="kauro-ops-facts">
          <div>
            <dt>Prices</dt>
            <dd>The public price bands, and that the free data health check is free and creates no obligation to buy.</dd>
          </div>
          <div>
            <dt>Discounts</dt>
            <dd>Only the repeat discount a buyer earns by itself: {tiers}. It is never yours to give or to promise early.</dd>
          </div>
          <div>
            <dt>Never promise</dt>
            <dd>A feature, a date, a price outside the bands, unlimited support, permanent retention, or an import into a live CRM.</dd>
          </div>
          <div>
            <dt>Words</dt>
            <dd>&ldquo;Prepared for import&rdquo;, never &ldquo;imported&rdquo;: the customer&apos;s team runs the import with its own tools.</dd>
          </div>
        </dl>
      </section>
      {PURPOSES.map((purpose) => (
        <section key={purpose.key} aria-labelledby={`purpose-${purpose.key}`}>
          <SectionHead id={`purpose-${purpose.key}`} title={purpose.title} meta={purpose.meta} />
          <ul className="kauro-ops-resources">
            {RESOURCES.filter((one) => one.state === "CURRENT" && one.purpose === purpose.key).map((resource) => (
              <li key={resource.family}>
                <div>
                  <h3>{resource.family}</h3>
                  <p>{resource.what}.</p>
                  <p className="kauro-muted">
                    Version {resource.version} · current since {resource.since} · English
                  </p>
                </div>
                <div className="kauro-actions">
                  <a className="kauro-button kauro-button-secondary" href={`#${resource.family.toLowerCase().replace(/ /g, "-")}`}>
                    Open<span className="kauro-visually-hidden"> {resource.family.toLowerCase()}</span>
                  </a>
                  <Link className="kauro-text-button" href={OPS_PATH.outreach} prefetch={false}>
                    Use in a message<span className="kauro-visually-hidden">: {resource.family.toLowerCase()}</span>
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <section aria-labelledby="replaced-h">
        <SectionHead id="replaced-h" title="Replaced" meta="Kept so you can see what changed; they cannot be used in a message" />
        <ul className="kauro-ops-resources">
          {replaced.map((resource) => (
            <li key={`${resource.family}-${resource.version}`} className="is-replaced">
              <div>
                <h3>
                  {resource.family}, version {resource.version}
                </h3>
                <p>{resource.what}.</p>
                <p className="kauro-muted">
                  Replaced by {resource.replacedBy} on {resource.replacedOn}.
                </p>
              </div>
              <Word tone="neutral">Replaced</Word>
            </li>
          ))}
        </ul>
      </section>
    </OpsPage>
  );
}
