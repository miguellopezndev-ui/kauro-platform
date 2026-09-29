// UI49 Communication preferences, reached from the link in a message as /unsubscribe/{token}. Until B12 delivers the unsubscribe
// path, the page is explicitly unavailable: it changes nothing, records nothing, and never reads the token in the address (the route file
// does not read its params, and the test holds that). It offers a written route instead and names the notices that are not optional.
import type { ReactElement } from "react";
import { PUBLIC_COPY } from "../../copy/public.ts";
import { LinkButton, PageHead, Section } from "../parts.tsx";
import { ROUTE } from "../site.ts";

export function UnsubscribePage(): ReactElement {
  return (
    <>
      <PageHead title={PUBLIC_COPY["unsubscribe.title"]} />
      <Section id="unsubscribe-unavailable" heading={PUBLIC_COPY["unsubscribe.unavailable.heading"]}>
        <p>{PUBLIC_COPY["unsubscribe.unavailable.body"]}</p>
        <p>{PUBLIC_COPY["unsubscribe.ask.body"]}</p>
        <div className="kauro-site-actions">
          <LinkButton href={ROUTE.contact}>{PUBLIC_COPY["unsubscribe.ask.cta"]}</LinkButton>
        </div>
      </Section>
      <Section id="unsubscribe-essential" heading={PUBLIC_COPY["unsubscribe.essential.heading"]}>
        <p>{PUBLIC_COPY["unsubscribe.essential.body"]}</p>
      </Section>
    </>
  );
}
