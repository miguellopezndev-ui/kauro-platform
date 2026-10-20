// UI49 Communication preferences, reached from the link in a message as /unsubscribe/{token}. One form stops the optional messages of the
// message that carried the link (B12 opt-out); the token appears only in the form's action, never in the page text. Rendering issues no
// request. It names the notices that are not optional and never turns those off.
//
// The page is one card of the product, as the not-found page is (Order 10, owner review): the preferences card set in the middle of the
// page, the one button on it, and the notices that stay on below a rule. A stopped request is stamped on the card.
import type { ReactElement } from "react";
import { PUBLIC_COPY } from "../../copy/public.ts";
import { OptOutForm } from "../opt-out-form.tsx";

export function UnsubscribePage({ token }: { readonly token: string }): ReactElement {
  return (
    <section className="kauro-fitpage kauro-cardpage" aria-labelledby="unsubscribe-title">
      <div className="kauro-cardsheet kauro-paper">
        <p className="kauro-cardsheet-bar" aria-hidden="true">
          <span className="kauro-cardsheet-brand">{PUBLIC_COPY["site.name"]}</span>
          <span className="kauro-cardsheet-title">{PUBLIC_COPY["unsubscribe.meta.title"]}</span>
        </p>
        <div className="kauro-cardsheet-body">
          <h1 id="unsubscribe-title">{PUBLIC_COPY["unsubscribe.title"]}</h1>
          <section className="kauro-cardsheet-part" aria-labelledby="unsubscribe-form-heading">
            <h2 id="unsubscribe-form-heading" className="kauro-cardsheet-label">
              {PUBLIC_COPY["unsubscribe.form.heading"]}
            </h2>
            <p>{PUBLIC_COPY["unsubscribe.form.body"]}</p>
            <OptOutForm token={token} />
          </section>
        </div>
        <section className="kauro-cardsheet-foot" aria-labelledby="unsubscribe-essential-heading">
          <h2 id="unsubscribe-essential-heading" className="kauro-cardsheet-label">
            {PUBLIC_COPY["unsubscribe.essential.heading"]}
          </h2>
          <p>{PUBLIC_COPY["unsubscribe.essential.body"]}</p>
        </section>
      </div>
    </section>
  );
}
