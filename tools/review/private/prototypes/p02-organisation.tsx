"use client";
// P-02 Organisation settings, complete (proposed design of UI32 within its current contract; Order 11 §4 B). UI32 today shows the name and
// branding as "not available in this release". The contract already serves both: UpdateBranding (CMD008: display name up to 120
// characters, an optional logo reference; owner or admin) and SubmitBrandingLogo (PNG only, rights confirmed). Who buys is read with
// GetBuyerType and was set once in setup. Legal and billing identity change through support. Closure is the owner's (CMD043, step-up).
// For a company buying for itself the same page speaks of the company, not of an agency (the copy has no such variant yet: D-P02-1).
import { Banner, Button, ErrorSummary, Field } from "@kauro/ui";
import { type FormEvent, type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, day, Facts, PageHead, ScreenButton, ScreenLink } from "./kit.tsx";

export const P02_STATES: readonly StateDef[] = [
  { key: "normal", label: "Settings", note: "Everything an owner manages for the organisation, each in its own section." },
  { key: "invalid", label: "Name or logo not accepted", note: "The name is too long and the logo is not a PNG: each error next to its field, and in a summary." },
  { key: "saved", label: "Saved", note: "The new name and logo are saved; earlier deliveries keep the branding they were made with." },
  { key: "closing", label: "Closure requested", note: "After the owner requested closure: the page says what happens and offers nothing more." },
];

export function OrganisationSettings({ ctx, state }: PrototypeProps): ReactElement {
  const company = ctx.key === "company";
  const name = company ? "Halden Outdoor" : "Northwind Data";
  const actions = ctx.agency?.permittedActions ?? [];
  const branding = actions.includes("MANAGE_BRANDING");
  const owner = actions.includes("MANAGE_AGENCY");
  const [saved, setSaved] = useState(state === "saved");
  const [errors, setErrors] = useState<readonly { fieldId: string; message: string }[]>(
    state === "invalid"
      ? [
          { fieldId: "org-name", message: "Use 120 characters or fewer." },
          { fieldId: "org-logo", message: "Choose a PNG file. Other formats are not accepted." },
        ]
      : [],
  );
  const errorOf = (id: string): string | undefined => errors.find((entry) => entry.fieldId === id)?.message;
  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = String(data.get("name") ?? "").trim();
    const found = text === "" ? [{ fieldId: "org-name", message: "Enter a name." }] : text.length > 120 ? [{ fieldId: "org-name", message: "Use 120 characters or fewer." }] : [];
    setErrors(found);
    setSaved(found.length === 0);
  };

  return (
    <>
      <PageHead eyebrow={name} title="Settings" lead={company ? "Manage your company's details and safe branding." : "Manage agency details and safe branding."} />
      <nav className="kauro-local-nav" aria-label="Sections of this page">
        <ul>
          <li>
            <a href="#org-brand">Name and logo</a>
          </li>
          <li>
            <a href="#org-buyer">Who buys</a>
          </li>
          <li>
            <a href="#org-legal">Legal and billing</a>
          </li>
          <li>
            <a href="#org-security">Security</a>
          </li>
          <li>
            <a href="#org-closure">Closure</a>
          </li>
        </ul>
      </nav>
      <div className="kauro-settings-split">

      <section id="org-brand" aria-labelledby="org-brand-h">
        <h2 id="org-brand-h">Name and logo</h2>
        <p>Shown to your team and on the reports Kauro delivers. Renaming does not reset discounts, attribution or client identity.</p>
        {saved ? (
          <Banner tone="success" title="Saved" announce="status">
            <p>New deliveries use the new name and logo. Deliveries already made keep the branding they were made with.</p>
          </Banner>
        ) : null}
        {branding ? (
          <form className="kauro-brand-form" noValidate onSubmit={save}>
            <ErrorSummary title="Check these details" errors={errors} />
            <Field id="org-name" label={company ? "Company name" : "Agency name"} hint="Up to 120 characters." error={errorOf("org-name")}>
              {(control) => <input {...control} name="name" defaultValue={state === "invalid" ? `${name} — Revenue Operations, Data Preparation and CRM Migration Services for Mid-Market Clients` : name} />}
            </Field>
            <div className="kauro-logo-row">
              <span className="kauro-logo-preview" aria-hidden="true">
                {company ? "HO" : "NW"}
              </span>
              <Field id="org-logo" label="Logo" hint="PNG only, with your rights to use it. Kauro re-encodes it before it appears on a report." error={errorOf("org-logo")}>
                {(control) => <input {...control} name="logo" type="file" accept="image/png" />}
              </Field>
            </div>
            <label className="kauro-confirm">
              <input type="checkbox" name="rights" defaultChecked />
              <span>We have the rights to use this logo on documents Kauro prepares for us.</span>
            </label>
            <div className="kauro-actions">
              <Button type="submit" variant="primary">
                Save name and logo
              </Button>
            </div>
          </form>
        ) : (
          <Facts rows={[[company ? "Company name" : "Agency name", <bdi key="n">{name}</bdi>]]} />
        )}
      </section>

      <section id="org-buyer" aria-labelledby="org-buyer-h">
        <h2 id="org-buyer-h">Who buys</h2>
        <Facts
          rows={[
            [name, company ? "A company preparing its own CRM data" : "An agency preparing CRM data for its clients"],
            ["Recorded", `${day("2026-09-02T14:25:00Z")} by the owner`],
          ]}
        />
        <p className="kauro-muted">Set once during setup. It does not change prices, discounts or what Kauro can prepare.</p>
      </section>

      <section id="org-legal" aria-labelledby="org-legal-h">
        <h2 id="org-legal-h">Legal and billing identity</h2>
        <Facts
          rows={[
            ["Service terms accepted", "Version 2026-10, on 2 Sep 2026"],
            ["Data processing terms accepted", "Version 2026-10, on 2 Sep 2026"],
            ["Billing profile", <Badge key="b" tone="success">Prepared by Kauro</Badge>],
          ]}
        />
        <p>
          A change of legal name, address or tax details is followed through a support case, not edited here. <ScreenLink to="UI52" ctx={ctx}>Open a support case</ScreenLink>
        </p>
      </section>

      <section id="org-security" aria-labelledby="org-security-h">
        <h2 id="org-security-h">Security</h2>
        <ul>
          <li>Every member signs in with two-step verification.</li>
          <li>Changing roles, transferring ownership, approving plans and closing ask for a fresh confirmation of identity.</li>
          <li>Kauro never connects to your CRM; your team imports the files Kauro prepares.</li>
        </ul>
        <ScreenButton to="UI31" ctx={ctx}>
          Manage the team
        </ScreenButton>
      </section>

      <section id="org-closure" aria-labelledby="org-closure-h">
        <h2 id="org-closure-h">Close {company ? "this company workspace" : "this agency"}</h2>
        {state === "closing" ? (
          <Banner tone="info" title="Closure requested on 20 Oct 2026" announce="status">
            <p>Open quotes were withdrawn. Paid work in progress, refunds and reconciliation finish with Kauro; then your data is scheduled for deletion. It cannot be requested again.</p>
          </Banner>
        ) : owner ? (
          <>
            <p>Closing withdraws open quotes and ends live authorisations. Work already paid for, refunds and reconciliation finish first; then your data is scheduled for deletion. It needs a fresh confirmation of your identity.</p>
            <Button variant="danger">Request closure</Button>
          </>
        ) : (
          <p>Only an owner of {name} can request closure.</p>
        )}
      </section>
      </div>
    </>
  );
}
