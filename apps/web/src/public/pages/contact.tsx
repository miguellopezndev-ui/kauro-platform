// UI07 Contact (A3 3.7): a fit form for a visitor without an account. The page states the rule the form enforces: describe the task and keep
// CRM files, records, passwords and keys out of every field. Beside the form, what happens after it is sent, so a buyer knows the next step
// before they write. The form itself is the client component that posts to the api (W5b).
//
// Order 11 round 2: this is where the site's call to action lands, so the heading is that call to action: the visitor sees the promise kept
// (information scent). The rule about files moved from the heading into the lead and the field it governs. The heading is an amended
// rendered copy (docs/design/ORDER11-ROUND2-PUBLIC.md, amendment R2-1, owner's approval of 2026-10-21); the registry record is unchanged. The
// form is one column (forms laid out in pairs are filled with more errors), the optional field says so at the field, and the steps beside
// it sit on paper, not on a colour band.
import type { ReactElement } from "react";
import { PUBLIC_COPY } from "../../copy/public.ts";
import { InquiryForm } from "../inquiry-form.tsx";
import { Head } from "../r2.tsx";

export function ContactPage(): ReactElement {
  return (
    <>
      <Head kind="reference" eyebrow={PUBLIC_COPY["nav.contact.label"]} title={PUBLIC_COPY["contact.title"]} lead={PUBLIC_COPY["contact.lead"]} />
      <div className="kauro-r2-contact">
        <div className="kauro-site-wrap kauro-r2-contact-inner">
          <aside className="kauro-r2-contact-aside" aria-labelledby="contact-next-heading">
            <h2 id="contact-next-heading">{PUBLIC_COPY["contact.next.heading"]}</h2>
            <ol className="kauro-r2-steps">
              <li>{PUBLIC_COPY["contact.next.describe"]}</li>
              <li>{PUBLIC_COPY["contact.next.reply"]}</li>
              <li>{PUBLIC_COPY["contact.next.upload"]}</li>
            </ol>
          </aside>
          <div className="kauro-r2-contact-form">
            <InquiryForm />
          </div>
        </div>
      </div>
    </>
  );
}
