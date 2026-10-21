"use client";
// UI09 Agency setup (registry: "Complete the steps needed to handle client data."). The owner's decisions of 2026-10-20: the account
// already exists (any Google account or email, verified, with Kauro's two-step verification) and may explore the example without any of
// this. Before Kauro receives real files, one short, progressive step:
//   1. who buys: an agency, or a company working on its own data (setBuyerType, A3 3.7), for a business activity, never as consumers (D-30);
//   2. the workspace's name;
//   3. what Kauro admits: exports of customer records as CSV or XLSX, without the data the terms exclude (ToS §5.2: credentials or keys, full
//      card numbers, health data, other sensitive data, children's data); files outside that scope are turned to "Ask a question";
//   4. the authority over the data (for an agency, its clients' documented authorisation, as the data processing terms require) and the
//      agreements: the service terms and the data processing terms, accepted by the signed-in person on the organisation's behalf;
//   5. two-step verification, already on (shown, not asked).
// The billing profile is asked at the first quote. PROPOSED (D-UI09-2): today activation (CMD002) needs agreements_and_profile_accepted,
// so the profile would move from activation to the quote. The eligibility questions are recorded where the onboarding records the buyer
// type and the agreements (F-03). No business email domain is required, and a domain never adds anyone to an agency.
//
// Revision of 2026-10-20 (owner's review of group A): the column of rings beside the form broke its step names one word a line; the path is
// now one line at the top, and the form reads as four numbered parts. Research: research/auth-onboarding.md (the gate at the first real
// upload, not at sign-up; the DPA incorporated by reference with a copy to download); research/onboarding-vs-discounts.md (no questionnaire).
//
// Round 2 (2026-10-21): the page header is the application's one anatomy (h1 at 28 px, the lead, no larger type than its meaning); the
// next step after activation is the shared next-step card; while the agreements are unpublished the page offers the one thing that works
// (save a draft) as its action instead of a disabled "Create" button beside it (GOV.UK: avoid disabled buttons).
import { Banner, Button, ErrorSummary, Field } from "@kauro/ui";
import { type FormEvent, type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import { day, NextStep, ScreenButton, ScreenLink } from "./kit.tsx";

export const UI09_STATES: readonly StateDef[] = [
  { key: "normal", label: "Before real files", note: "Four short parts: who buys, the name, what Kauro admits, authority and agreements. Billing comes at the first quote." },
  { key: "invalid", label: "Something missing", note: "No name, the scope not confirmed and the agreements not accepted: each explained beside it and in a summary." },
  { key: "out-of-scope", label: "Files Kauro does not admit", note: "The files hold data the terms exclude: nothing is created, and the page offers to ask a question instead." },
  { key: "agreements-today", label: "Agreements not published (today)", note: "The real state today: the legal documents are not published, so the workspace stays a draft and nothing can be uploaded yet." },
  { key: "activated", label: "Ready", note: "The workspace is active: the next step is the first project and its free data health check." },
  { key: "draft-exists", label: "A draft already exists", note: "One draft per person: the existing draft is resumed instead of creating another." },
  { key: "limited", label: "Too many new organisations", note: "Creation is rate-limited: the person is told to wait, nothing is created." },
];

type Errors = readonly { readonly fieldId: string; readonly message: string }[];

const PERSON: Readonly<Record<string, { readonly name: string; readonly email: string }>> = {
  newcomer: { name: "Ana Silva", email: "ana.silva@gmail.example" },
  company: { name: "Tomas Reyes", email: "tomas.reyes@halden.example" },
};

export function AgencySetup({ ctx, state }: PrototypeProps): ReactElement {
  const company = ctx.key === "company";
  const person = PERSON[ctx.key] ?? { name: "Lena Ortiz", email: "lena.ortiz@northwind.example" };
  const suggested = ctx.key === "newcomer" ? "" : company ? "Halden Outdoor" : "Northwind Data";
  const [activated, setActivated] = useState(state === "activated");
  const [name, setName] = useState(state === "activated" ? suggested || "Silva Data Studio" : suggested);
  const [kind, setKind] = useState<"agency" | "in-house">(company ? "in-house" : "agency");
  const outside = state === "out-of-scope";
  const [errors, setErrors] = useState<Errors>(
    state === "invalid"
      ? [
          { fieldId: "setup-name", message: "Enter the name of your agency or company" },
          { fieldId: "setup-scope", message: "Confirm what your files hold" },
          { fieldId: "setup-accept", message: "Accept the agreements to continue" },
        ]
      : [],
  );
  const errorOf = (id: string): string | undefined => errors.find((entry) => entry.fieldId === id)?.message;
  const label = name.trim() === "" ? "your organisation" : name.trim();

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = String(data.get("name") ?? "").trim();
    const found: { fieldId: string; message: string }[] = [];
    if (text === "") found.push({ fieldId: "setup-name", message: "Enter the name of your agency or company" });
    else if (text.length > 120) found.push({ fieldId: "setup-name", message: "Name must be 120 characters or fewer" });
    if (data.get("scope") === null) found.push({ fieldId: "setup-scope", message: "Confirm what your files hold" });
    if (data.get("authority") === null) found.push({ fieldId: "setup-authority", message: "Confirm that you may share these files with Kauro" });
    if (data.get("accept") === null) found.push({ fieldId: "setup-accept", message: "Accept the agreements to continue" });
    setErrors(found);
    if (found.length === 0) setActivated(true);
  };

  if (activated) {
    return (
      <>
        <ProjectHeader stage="files" title={`${label} is ready`} lead="The agreements are accepted and kept with your workspace. Kauro can now receive your real files." />
        <NextStep
          id="ready-next"
          heading="Start your first project"
          action={
            <ScreenButton to="UI11" ctx={ctx} variant="primary">
              <span className="kauro-go">Start your first project</span>
            </ScreenButton>
          }
        >
          <p>Upload the exports you want prepared. The free data health check measures every row and shows what it finds, then an estimate for your files.</p>
          {kind === "agency" ? (
            <p>
              Working for several clients? Each client keeps its own projects and files. <ScreenLink to="UI12" ctx={ctx}>Add your clients</ScreenLink> when you need them.
            </p>
          ) : null}
        </NextStep>
      </>
    );
  }

  if (state === "draft-exists") {
    return (
      <>
        <ProjectHeader stage="files" title="You already have a workspace in setup" lead="Each person can have one workspace in setup at a time." />
        <NextStep
          id="draft-next"
          heading="Continue with Northwind Labs"
          facts={[["Started", day("2026-10-18T16:40:00Z")]]}
          action={
            <Button variant="primary">
              <span className="kauro-go">Continue with Northwind Labs</span>
            </Button>
          }
        />
      </>
    );
  }

  return (
    <>
      <ProjectHeader stage="files" title="Set up your agency or company" lead="What Kauro needs before it can receive real files: four short parts. Billing details come later." />
      <p className="kauro-setup-done">
        <span className="kauro-setup-done-mark" aria-hidden="true" />
        <span>
          Your account <bdi>{person.email}</bdi> · email verified · two-step verification on
        </span>
      </p>
      {outside ? (
        <Banner tone="warning" title="Kauro does not accept files with that data" announce="alert">
          <p>
            Kauro prepares exports of customer records. Files that hold passwords or keys, full card numbers, health data, other sensitive personal data or children&apos;s data are outside the
            service, so nothing was created.
          </p>
          <p>
            <a href="/contact">Ask a question</a> if you are unsure what your files hold, or remove that data from the exports before you upload them.
          </p>
        </Banner>
      ) : null}
      {state === "limited" ? (
        <Banner tone="warning" title="Wait before starting another" announce="alert">
          <p>Too many organisations were started from this account recently. Nothing was created. Try again later.</p>
        </Banner>
      ) : null}
      {state === "agreements-today" ? (
        <Banner tone="warning" title="The agreements are not published yet" announce="status">
          <p>Your workspace can be named and saved as a draft. It can be activated, and files uploaded, only once the service terms and the data processing terms are published.</p>
        </Banner>
      ) : null}
      <form className="kauro-form kauro-setup-form" noValidate onSubmit={submit}>
        <ErrorSummary title="There is a problem" errors={errors} />
        <fieldset className="kauro-setup-part">
          <legend>
            <span className="kauro-setup-number">1</span> Who buys
          </legend>
          <div className="kauro-choice kauro-choice--row">
            <label>
              <input type="radio" name="buyerType" value="agency" checked={kind === "agency"} onChange={() => setKind("agency")} />
              <span>
                <strong>An agency</strong>
                <small>You prepare CRM data for your clients. Each client keeps its own projects and files.</small>
              </span>
            </label>
            <label>
              <input type="radio" name="buyerType" value="in-house" checked={kind === "in-house"} onChange={() => setKind("in-house")} />
              <span>
                <strong>A company</strong>
                <small>You prepare your own company&apos;s data.</small>
              </span>
            </label>
          </div>
          <p className="kauro-muted">Same prices and the same discounts either way. Kauro is for business use, not for private consumers.</p>
        </fieldset>

        <fieldset className="kauro-setup-part">
          <legend>
            <span className="kauro-setup-number">2</span> {kind === "agency" ? "Your agency" : "Your company"}
          </legend>
          <Field id="setup-name" label="Name" hint="Shown to your team and on the reports Kauro delivers. You can change it later." error={errorOf("setup-name")}>
            {(control) => <input {...control} name="name" autoComplete="organization" value={name} onChange={(event) => setName(event.target.value)} maxLength={200} />}
          </Field>
        </fieldset>

        <fieldset className="kauro-setup-part">
          <legend>
            <span className="kauro-setup-number">3</span> Your files
          </legend>
          <p className="kauro-setup-explain">Kauro works on exports of customer records (contacts, companies, deals or similar), as CSV or XLSX files.</p>
          <label className="kauro-confirm" id="setup-scope">
            <input type="checkbox" name="scope" />
            <span>
              Our files hold customer records only: no passwords or keys, no full card numbers, no health data, no other sensitive personal data and no children&apos;s data.
            </span>
          </label>
          {errorOf("setup-scope") === undefined ? null : <p className="kauro-setup-error">{errorOf("setup-scope")}</p>}
        </fieldset>

        <fieldset className="kauro-setup-part">
          <legend>
            <span className="kauro-setup-number">4</span> Authority and agreements
          </legend>
          <label className="kauro-confirm" id="setup-authority">
            <input type="checkbox" name="authority" />
            <span>
              {kind === "agency"
                ? "We may share our clients' files with Kauro: each client has authorised it, as the data processing terms require."
                : "We may share these files with Kauro: they are our own company's records."}
            </span>
          </label>
          <ul className="kauro-documents">
            <li>
              <a href="/legal/terms">Service terms</a>
              <span>Version 2026-10</span>
            </li>
            <li>
              <a href="/legal/data-processing">Data processing terms</a>
              <span>Version 2026-10 · download</span>
            </li>
          </ul>
          <label className="kauro-confirm" id="setup-accept">
            <input type="checkbox" name="accept" />
            <span>
              I, <strong>{person.name}</strong>, accept both documents on behalf of <bdi>{label}</bdi>, and I am authorised to do so.
            </span>
          </label>
        </fieldset>

        <div className="kauro-actions">
          {state === "agreements-today" ? (
            <Button type="button" variant="primary">
              Save as a draft
            </Button>
          ) : (
            <Button type="submit" variant="primary">
              <span className="kauro-go">Create the workspace</span>
            </Button>
          )}
        </div>
        <p className="kauro-muted">
          Billing details are asked before your first quote is issued, not now. <span className="kauro-proposed kauro-a-proposed">Proposed — D-UI09-2</span>
        </p>
      </form>
      <p className="kauro-setup-join">
        Joining a team that already uses Kauro? Open the invitation link you were sent. An email address never adds anyone to a workspace on its own. <ScreenLink to="UI51" ctx={ctx}>About invitations</ScreenLink>
      </p>
    </>
  );
}
