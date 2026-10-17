// UI07 Contact (A3 3.7): a fit form for a visitor without an account. The page states the rule the form enforces: describe the task and keep
// CRM files, records, passwords and keys out of every field. Beside the form, what happens after it is sent, so a buyer knows the next step
// before they write. The form itself is the client component that posts to the api (W5b).
import type { ReactElement } from "react";
import { PUBLIC_COPY } from "../../copy/public.ts";
import { InquiryForm } from "../inquiry-form.tsx";
import { PageHead } from "../parts.tsx";

export function ContactPage(): ReactElement {
  return (
    <>
      <PageHead size="compact" eyebrow={PUBLIC_COPY["nav.contact.label"]} title={PUBLIC_COPY["contact.title"]} lead={PUBLIC_COPY["contact.lead"]} />
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
          <InquiryForm />
        </div>
      </div>
    </>
  );
}
