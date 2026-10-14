// UI49 Communication preferences, reached from the link in a message as /unsubscribe/{token}. One form stops the optional messages of the
// message that carried the link (B12 opt-out); the token appears only in the form's action, never in the page text. Rendering issues no
// request. It names the notices that are not optional and never turns those off.
import type { ReactElement } from "react";
import { PUBLIC_COPY } from "../../copy/public.ts";
import { OptOutForm } from "../opt-out-form.tsx";
import { PageHead, Section } from "../parts.tsx";

export function UnsubscribePage({ token }: { readonly token: string }): ReactElement {
  return (
    <>
      <PageHead title={PUBLIC_COPY["unsubscribe.title"]} />
      <Section id="unsubscribe-form" heading={PUBLIC_COPY["unsubscribe.form.heading"]}>
        <p>{PUBLIC_COPY["unsubscribe.form.body"]}</p>
        <OptOutForm token={token} />
      </Section>
      <Section id="unsubscribe-essential" heading={PUBLIC_COPY["unsubscribe.essential.heading"]}>
        <p>{PUBLIC_COPY["unsubscribe.essential.body"]}</p>
      </Section>
    </>
  );
}
