// UI01 Home (A3 3.1, 3.2): the job line, one call to action, the sample and the prices beside it, what the agency receives, the services open
// now (read from the capability publication and nothing else), what Kauro does not do, and the one sentence about AI, below the offer and the
// limits and never in a headline. The call to action leads to sign-in, where the free data health check is requested.
import type { ReactElement } from "react";
import { PUBLIC_COPY } from "../../copy/public.ts";
import { publishedModes, type Publication } from "../capabilities.ts";
import { modeName } from "../estimate-text.ts";
import { LinkButton, PageHead, Section, stateText } from "../parts.tsx";
import { ROUTE } from "../site.ts";

export interface HomePageProps {
  readonly publication: Publication;
  readonly signInHref: string;
}

function ModesSection({ publication }: { readonly publication: Publication }): ReactElement {
  const modes = publishedModes(publication);
  return (
    <Section id="home-modes" heading={PUBLIC_COPY["home.modes.heading"]}>
      {publication.kind === "UNAVAILABLE" ? (
        <p>{PUBLIC_COPY["home.modes.unknown.body"]}</p>
      ) : modes.length === 0 ? (
        <p>{PUBLIC_COPY["home.modes.none.body"]}</p>
      ) : (
        <>
          <p>{PUBLIC_COPY["home.modes.published.lead"]}</p>
          <ul className="kauro-site-list">
            {modes.map((published) => (
              <li key={published.mode}>
                {modeName(published.mode)}
                {published.state === "AVAILABLE_LIMITED" ? `: ${stateText("LIMITED")}` : null}
              </li>
            ))}
          </ul>
        </>
      )}
      <p>
        <a href={ROUTE.services}>{PUBLIC_COPY["nav.services.label"]}</a>
      </p>
    </Section>
  );
}

export function HomePage({ publication, signInHref }: HomePageProps): ReactElement {
  return (
    <>
      <div className="kauro-site-hero">
        <PageHead title={PUBLIC_COPY["home.title"]} lead={PUBLIC_COPY["home.hero.lead"]} />
        <div className="kauro-site-actions">
          <LinkButton href={signInHref} primary>
            {PUBLIC_COPY["public.cta.request-health-check.cta"]}
          </LinkButton>
          <LinkButton href={ROUTE.sample}>{PUBLIC_COPY["home.hero.sample.cta"]}</LinkButton>
          <LinkButton href={ROUTE.pricing}>{PUBLIC_COPY["home.hero.pricing.cta"]}</LinkButton>
        </div>
        <p className="kauro-site-note">{PUBLIC_COPY["home.hero.note"]}</p>
      </div>
      <Section id="home-buyer" heading={PUBLIC_COPY["home.buyer.heading"]}>
        <p>{PUBLIC_COPY["home.buyer.body"]}</p>
      </Section>
      <Section id="home-delivery" heading={PUBLIC_COPY["home.delivery.heading"]}>
        <ul className="kauro-site-list">
          <li>{PUBLIC_COPY["home.delivery.report"]}</li>
          <li>{PUBLIC_COPY["home.delivery.files"]}</li>
          <li>{PUBLIC_COPY["home.delivery.manifest"]}</li>
          <li>{PUBLIC_COPY["home.delivery.steps"]}</li>
        </ul>
      </Section>
      <ModesSection publication={publication} />
      <Section id="home-limits" heading={PUBLIC_COPY["home.limits.heading"]}>
        <ul className="kauro-site-list">
          <li>{PUBLIC_COPY["home.limits.live"]}</li>
          <li>{PUBLIC_COPY["home.limits.import"]}</li>
          <li>{PUBLIC_COPY["home.limits.decide"]}</li>
        </ul>
      </Section>
      <Section id="home-context" heading={PUBLIC_COPY["home.context.heading"]}>
        <p>{PUBLIC_COPY["home.context.body"]}</p>
      </Section>
      <Section id="home-start" heading={PUBLIC_COPY["home.closing.heading"]}>
        <p>{PUBLIC_COPY["home.closing.body"]}</p>
        <div className="kauro-site-actions">
          <LinkButton href={signInHref} primary>
            {PUBLIC_COPY["public.cta.request-health-check.cta"]}
          </LinkButton>
        </div>
      </Section>
    </>
  );
}
