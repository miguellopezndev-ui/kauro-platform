// The contact page as a variant (Order 11; review only): the approved page, with the form that carries the §8.1 authorisation.
import type { ReactElement } from "react";
import { PUBLIC_COPY } from "@web/copy/public.ts";
import { PageHead } from "@web/public/parts.tsx";
import { InquiryFormConsent } from "./inquiry-form-consent.tsx";

export function ContactVariant(): ReactElement {
  return (
    <>
      <PageHead size="compact" accent={7} eyebrow={PUBLIC_COPY["nav.contact.label"]} title={PUBLIC_COPY["contact.title"]} lead={PUBLIC_COPY["contact.lead"]} />
      <div className="kauro-site-contact">
        <div className="kauro-site-wrap kauro-site-contact-inner">
          <aside className="kauro-site-contact-aside kauro-wine" aria-labelledby="contact-next-heading">
            <h2 id="contact-next-heading">{PUBLIC_COPY["contact.next.heading"]}</h2>
            <ol className="kauro-site-numbered kauro-site-numbered--compact">
              <li>{PUBLIC_COPY["contact.next.describe"]}</li>
              <li>{PUBLIC_COPY["contact.next.reply"]}</li>
              <li>{PUBLIC_COPY["contact.next.upload"]}</li>
            </ol>
          </aside>
          <InquiryFormConsent />
        </div>
      </div>
    </>
  );
}
