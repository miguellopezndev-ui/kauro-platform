// UI07 Contact (A3 3.7): a fit form for a visitor without an account. The page states the rule the form enforces: describe the task and keep
// CRM files, records, passwords and keys out of every field. The form itself is the client component that posts to the api (W5b).
import type { ReactElement } from "react";
import { PUBLIC_COPY } from "../../copy/public.ts";
import { InquiryForm } from "../inquiry-form.tsx";
import { PageHead } from "../parts.tsx";

export function ContactPage(): ReactElement {
  return (
    <>
      <PageHead title={PUBLIC_COPY["contact.title"]} lead={PUBLIC_COPY["contact.lead"]} />
      <InquiryForm />
    </>
  );
}
