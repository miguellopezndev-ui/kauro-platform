"use client";
// UI09 Agency setup (registry: "Complete the steps needed to handle client data."). The owner's decisions of 2026-10-20: the account
// already exists (any Google account or email, verified, with Kauro's two-step verification); the agency or company is set up when the
// person wants their own files checked, as a minimal workspace, and every detail is asked only when it is needed:
//   - its name;
//   - who buys: an agency, or a company buying for its own data (setBuyerType, A3 3.7), for a business activity, never as consumers (D-30);
//   - who accepts: the signed-in person, who confirms they are authorised to accept on the organisation's behalf;
//   - the agreements: the service terms and the data processing terms (DPA), whose accepted versions are kept with the organisation.
// The billing profile is not asked here: it is asked at the first quote, the first moment money is involved. PROPOSED (D-UI09-2): today
// activation (CMD002) needs agreements_and_profile_accepted, so the profile would move from activation to the quote. No business email
// domain is required, and a domain never adds anyone to an agency: joining an existing one is by invitation only.
//
// The organisation is created as a draft (CMD001, one draft per person) and activated by accepting (CMD002). Today the agreements are not
// published, so activation is shown as not available.
//
// The setup is drawn as the product's window, with the path beside the form: the account done, the workspace now, the first project next.
// Starting with a step already done is honest here (the account is done) and moves people on (endowed progress, research 6).
import { Banner, Button, ErrorSummary, Field } from "@kauro/ui";
import { type FormEvent, type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { day, Note, PageHead, type RingState, Rings, ScreenButton, ScreenLink, Stamp, Window } from "./kit.tsx";

export const UI09_STATES: readonly StateDef[] = [
  { key: "normal", label: "Set up the workspace", note: "One short form: the name, who buys, who accepts, and the agreements. Billing details come at the first quote." },
  { key: "invalid", label: "Something missing", note: "No name and the agreements not accepted: each is explained beside it and in a summary." },
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
  const [errors, setErrors] = useState<Errors>(
    state === "invalid"
      ? [
          { fieldId: "setup-name", message: "Enter the name of your agency or company." },
          { fieldId: "setup-accept", message: "Accept the agreements to continue." },
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
    if (text === "") found.push({ fieldId: "setup-name", message: "Enter the name of your agency or company." });
    else if (text.length > 120) found.push({ fieldId: "setup-name", message: "Use 120 characters or fewer." });
    if (data.get("economic") === null) found.push({ fieldId: "setup-economic", message: "Confirm that you buy for a business activity." });
    if (data.get("accept") === null) found.push({ fieldId: "setup-accept", message: "Accept the agreements to continue." });
    setErrors(found);
    if (found.length === 0) setActivated(true);
  };

  const rings = (current: "workspace" | "project"): ReadonlyArray<{ key: string; name: string; fact: string; state: RingState }> => [
    { key: "account", name: "Your account", fact: "Verified · two-step on", state: "done" },
    { key: "workspace", name: kind === "in-house" ? "Your company" : "Your agency", fact: current === "project" ? "Ready" : "Now", state: current === "project" ? "done" : state === "agreements-today" ? "blocked" : "current" },
    { key: "project", name: "Your first project", fact: "The free data health check", state: current === "project" ? "current" : "waiting" },
  ];

  let body: ReactElement;
  if (activated) {
    body = (
      <div className="kauro-setup-step">
        <h2>
          <bdi>{label}</bdi> is ready
        </h2>
        <p>
          The agreements are accepted and kept with {label}. Start your first project: upload the exports you want prepared, and the free data
          health check shows what Kauro finds and the exact price.
        </p>
        <ScreenButton to="UI11" ctx={ctx} variant="primary">
          <span className="kauro-go">Start your first project</span>
        </ScreenButton>
        {kind === "agency" ? (
          <p className="kauro-muted">
            Working for several clients? Each client keeps its own projects and files. <ScreenLink to="UI12" ctx={ctx}>Add your clients</ScreenLink> when you need them.
          </p>
        ) : null}
      </div>
    );
  } else if (state === "draft-exists") {
    body = (
      <div className="kauro-setup-step">
        <h2>You already have one in setup</h2>
        <p>
          <bdi>Northwind Labs</bdi> was started on {day("2026-10-18T16:40:00Z")}. Each person can have one organisation in setup at a time.
        </p>
        <Button variant="primary">
          <span className="kauro-go">Continue with Northwind Labs</span>
        </Button>
      </div>
    );
  } else {
    body = (
      <form className="kauro-form kauro-setup-step" noValidate onSubmit={submit}>
        {state === "limited" ? (
          <Banner tone="warning" title="Please wait before starting another" announce="alert">
            <p>Too many organisations were started from this account recently. Nothing was created. Try again later.</p>
          </Banner>
        ) : null}
        {state === "agreements-today" ? (
          <Banner tone="warning" title="The agreements are not published yet" announce="status">
            <p>Your workspace can be named and saved as a draft, but it can be activated, and files uploaded, only once the service terms and data processing terms are published.</p>
          </Banner>
        ) : null}
        <ErrorSummary title="Check these details" errors={errors} />
        <Field id="setup-name" label="Name of your agency or company" hint="Shown to your team and on the reports Kauro delivers. You can change it later." error={errorOf("setup-name")}>
          {(control) => <input {...control} name="name" autoComplete="organization" value={name} onChange={(event) => setName(event.target.value)} maxLength={200} />}
        </Field>

        <fieldset className="kauro-choice">
          <legend>Who buys</legend>
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
              <small>You prepare your own company&apos;s CRM data.</small>
            </span>
          </label>
        </fieldset>
        <Note>Same prices and the same discounts either way.</Note>

        <div className="kauro-setup-accept">
          <h3>Who accepts</h3>
          <p className="kauro-setup-who">
            <strong>{person.name}</strong> <bdi>{person.email}</bdi>
          </p>
          <ul className="kauro-documents">
            <li>
              <a href="/legal/terms">Service terms</a>
              <span>Version 2026-10</span>
            </li>
            <li>
              <a href="/legal/data-processing">Data processing terms</a>
              <span>Version 2026-10</span>
            </li>
          </ul>
          <label className="kauro-confirm" id="setup-economic">
            <input type="checkbox" name="economic" defaultChecked={state !== "invalid"} />
            <span>We buy for a business activity, not as private consumers.</span>
          </label>
          <label className="kauro-confirm" id="setup-accept">
            <input type="checkbox" name="accept" />
            <span>
              I accept both documents on behalf of <bdi>{label}</bdi>, and I am authorised to do so.
            </span>
          </label>
        </div>

        <Button type="submit" variant="primary" disabled={state === "agreements-today"} aria-describedby={state === "agreements-today" ? undefined : "setup-billing-later"}>
          <span className="kauro-go">{state === "agreements-today" ? "Not available yet" : "Create the workspace"}</span>
        </Button>
        {state === "agreements-today" ? (
          <Button type="button">Save as a draft</Button>
        ) : (
          <p id="setup-billing-later" className="kauro-muted">
            Billing details are asked when you accept your first quote, not before. <span className="kauro-proposed">Proposed — D-UI09-2</span>
          </p>
        )}
      </form>
    );
  }

  return (
    <>
      <PageHead eyebrow="Your workspace" title="Set up your agency or company" accent={4} lead="Complete the steps needed to handle client data." />
      <div className="kauro-setup-object">
        <Window title={activated ? `${label} · setup` : "New workspace · setup"} state={activated ? "Ready" : state === "agreements-today" ? "Draft" : "Not created yet"} stateTone={activated ? "done" : "neutral"} className="kauro-setup">
          <div className="kauro-setup-grid">
            <div className="kauro-setup-path">
              <Rings label="From your account to your first project" items={rings(activated ? "project" : "workspace")} />
            </div>
            <section aria-live="polite" aria-label="Current step">
              {body}
            </section>
          </div>
        </Window>
        {activated ? <Stamp>Ready</Stamp> : null}
      </div>
      <p className="kauro-setup-join">
        Joining an agency that already uses Kauro? Open the invitation link you were sent. An email address never adds anyone to an agency on its own. <ScreenLink to="UI51" ctx={ctx}>About invitations</ScreenLink>
      </p>
    </>
  );
}
