"use client";
// UI09 Agency setup (registry: "Complete the steps needed to handle client data."). Identity, the organisation, who buys, the billing
// profile and the agreements are separate steps, each with its state (registry "Separate identity, membership, legal/billing profile,
// agreements and MFA readiness"). The organisation is created as a draft (CMD001, one draft per person), its buyer type is set once by the
// owner (setBuyerType, A3 3.7: an agency or a company buying for its own data), the billing profile is prepared by Kauro (no intake
// command yet), and activation accepts the published agreements (CMD002). Today the agreements are not published, so activation is shown
// as not available. An email domain never adds anyone to an agency: joining an existing one is by invitation only.
//
// The setup is the first stretch of the path, so it is drawn as the product's window: the organisation and its state in the bar, the five
// steps as rings with their facts, and the current step's work beside them. One object, one next step.
import { Banner, Button, ErrorSummary, Field } from "@kauro/ui";
import { type FormEvent, type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, day, Facts, Note, PageHead, type RingState, Rings, ScreenButton, ScreenLink, Stamp, Window } from "./kit.tsx";

export const UI09_STATES: readonly StateDef[] = [
  { key: "normal", label: "Name your organisation", note: "Identity is ready; the person names the organisation, which is created as a draft." },
  { key: "identity", label: "Two-step verification missing", note: "The email is verified but two-step verification is off: nothing else can start until it is on." },
  { key: "invalid", label: "Name not accepted", note: "Validation: an empty or over-long name is explained next to the field and in a summary." },
  { key: "buyer", label: "Who buys", note: "The draft exists; the owner says once whether it is an agency or a company buying for its own data." },
  { key: "billing", label: "Billing profile pending", note: "Kauro prepares the billing profile from the details sent through support; the person waits." },
  { key: "agreements-today", label: "Agreements not published (today)", note: "The real state today: the legal documents are not published, so activation is not available." },
  { key: "agreements", label: "Accept and activate", note: "Designed future: the published agreements are accepted and the organisation becomes active." },
  { key: "activated", label: "Active", note: "Activation done: the organisation is ready for its first client or project." },
  { key: "draft-exists", label: "A draft already exists", note: "One draft per person: the existing draft is resumed instead of creating another." },
  { key: "limited", label: "Too many new organisations", note: "Creation is rate-limited: the person is told to wait, nothing is created." },
];

type StepKey = "identity" | "organisation" | "buyer" | "billing" | "agreements";
const ORDER: readonly StepKey[] = ["identity", "organisation", "buyer", "billing", "agreements"];

function firstStep(state: string): StepKey {
  if (state === "identity") return "identity";
  if (state === "buyer" || state === "draft-exists") return state === "buyer" ? "buyer" : "organisation";
  if (state === "billing") return "billing";
  if (state === "agreements" || state === "agreements-today" || state === "activated") return "agreements";
  return "organisation";
}

export function AgencySetup({ ctx, state }: PrototypeProps): ReactElement {
  const company = ctx.key === "company";
  const orgName = company ? "Halden Outdoor" : "Northwind Data";
  const kind = company ? "company" : "agency";
  const [current, setCurrent] = useState<StepKey>(firstStep(state));
  const [activated, setActivated] = useState(state === "activated");
  const [errors, setErrors] = useState<readonly { fieldId: string; message: string }[]>(
    state === "invalid" ? [{ fieldId: "setup-name", message: "Enter the name of your organisation." }] : [],
  );
  const position = ORDER.indexOf(current);
  const named = position > 1;
  const ring = (step: StepKey): RingState => {
    if (activated) return "done";
    const at = ORDER.indexOf(step);
    if (step === "agreements" && current === "agreements" && state === "agreements-today") return "blocked";
    return at < position ? "done" : at === position ? "current" : "waiting";
  };
  const facts: Readonly<Record<StepKey, string>> = {
    identity: current === "identity" ? "Two-step verification needed" : "Verified · two-step on",
    organisation: activated ? orgName : named ? `${orgName} · draft` : current === "organisation" ? "Now" : "",
    buyer: position > 2 || activated ? (company ? "A company, for its own data" : "An agency, for its clients") : current === "buyer" ? "Now" : "",
    billing: position > 3 || activated ? "Prepared by Kauro" : current === "billing" ? "Kauro is preparing it" : "",
    agreements: activated ? "Accepted · 2026-10" : state === "agreements-today" && current === "agreements" ? "Not published yet" : current === "agreements" ? "Now" : "",
  };
  const createDraft = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    const found = name === "" ? [{ fieldId: "setup-name", message: "Enter the name of your organisation." }] : name.length > 120 ? [{ fieldId: "setup-name", message: "Use 120 characters or fewer." }] : [];
    setErrors(found);
    if (found.length === 0) setCurrent("buyer");
  };

  let step: ReactElement;
  if (activated) {
    step = (
      <>
        <h2>{orgName} is active</h2>
        <p>The agreements are accepted and the billing profile is in place. {company ? "Start your first project: upload the exports you want prepared." : "Add your first client: each client is its own workspace, with its own projects and files."}</p>
        <div className="kauro-actions">
          <ScreenButton to={company ? "UI11" : "UI12"} ctx={ctx} variant="primary">
            <span className="kauro-go">{company ? "Start a project" : "Add a client"}</span>
          </ScreenButton>
        </div>
      </>
    );
  } else
    switch (current) {
      case "identity":
        step = (
          <>
            <h2>Your identity</h2>
            <p>Kauro asks every person for two-step verification before any client data can be seen. It is set up once, and asked for again before sensitive actions.</p>
            <ul className="kauro-checklist">
              <li>Email address verified</li>
            </ul>
            <div className="kauro-actions">
              <ScreenButton to="UI50" ctx={ctx} variant="primary">
                <span className="kauro-go">Set up two-step verification</span>
              </ScreenButton>
            </div>
          </>
        );
        break;
      case "buyer":
        step = (
          <form className="kauro-form" noValidate onSubmit={(event) => (event.preventDefault(), setCurrent("billing"))}>
            <h2>Who buys</h2>
            <fieldset className="kauro-choice">
              <legend>
                <bdi>{orgName}</bdi> is
              </legend>
              <label>
                <input type="radio" name="buyerType" value="agency" defaultChecked={!company} />
                <span>
                  <strong>An agency</strong>
                  <small>Prepares CRM data for its clients. Each client is its own workspace, with its own projects.</small>
                </span>
              </label>
              <label>
                <input type="radio" name="buyerType" value="in-house" defaultChecked={company} />
                <span>
                  <strong>A company</strong>
                  <small>Prepares its own CRM data. The company is the one workspace.</small>
                </span>
              </label>
            </fieldset>
            <label className="kauro-confirm">
              <input type="checkbox" name="economic" defaultChecked />
              <span>We buy for a business activity, not as private consumers.</span>
            </label>
            <Note>Same price, same discounts, either way. Only the owner sets it, once.</Note>
            <Button type="submit" variant="primary">
              <span className="kauro-go">Save and continue</span>
            </Button>
          </form>
        );
        break;
      case "billing":
        step = (
          <>
            <h2>Billing profile</h2>
            <p>Kauro prepares your billing profile from the legal name, address and tax details you send through support. It appears here, ready to confirm, once it is prepared.</p>
            <Facts
              rows={[
                ["State", <Badge key="s" tone="info">Being prepared by Kauro</Badge>],
                ["Requested", day("2026-10-20T09:00:00Z")],
              ]}
            />
            <div className="kauro-actions">
              <ScreenButton to="UI52" ctx={ctx}>
                Send the billing details
              </ScreenButton>
              <Button variant="primary" onClick={() => setCurrent("agreements")}>
                <span className="kauro-go">Continue to agreements</span>
              </Button>
            </div>
          </>
        );
        break;
      case "agreements":
        step =
          state === "agreements-today" ? (
            <>
              <h2>Agreements</h2>
              <Banner tone="warning" title="The agreements are not published yet" announce="status">
                <p>Activation needs the published service terms and data processing terms. They are not available in this environment, so {orgName} stays a draft for now.</p>
              </Banner>
            </>
          ) : (
            <form className="kauro-form" noValidate onSubmit={(event) => (event.preventDefault(), setActivated(true))}>
              <h2>Agreements</h2>
              <p>Read both documents. The versions you accept are kept with {orgName}, and every order refers to them.</p>
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
              <label className="kauro-confirm">
                <input type="checkbox" name="accept" required />
                <span>I accept both documents on behalf of {orgName}, and I am authorised to do so.</span>
              </label>
              <Button type="submit" variant="primary">
                <span className="kauro-go">Accept and activate</span>
              </Button>
            </form>
          );
        break;
      default:
        step =
          state === "draft-exists" ? (
            <>
              <h2>Your organisation</h2>
              <p>
                You already have one organisation in setup: <bdi>{orgName}</bdi>, started on {day("2026-10-18T16:40:00Z")}. Each person can have one in setup at a time.
              </p>
              <div className="kauro-actions">
                <Button variant="primary" onClick={() => setCurrent("buyer")}>
                  <span className="kauro-go">Continue with {orgName}</span>
                </Button>
              </div>
            </>
          ) : (
            <form className="kauro-form" noValidate onSubmit={createDraft}>
              <h2>Your organisation</h2>
              {state === "limited" ? (
                <Banner tone="warning" title="Please wait before starting another" announce="alert">
                  <p>Too many organisations were started from this account recently. Nothing was created. Try again later.</p>
                </Banner>
              ) : null}
              <ErrorSummary title="Check the name" errors={errors} />
              <Field id="setup-name" label="Name" hint="Shown to your team and on the reports Kauro delivers. You can change it later." error={errors.find((entry) => entry.fieldId === "setup-name")?.message}>
                {(control) => <input {...control} name="name" autoComplete="organization" defaultValue={state === "invalid" ? "" : orgName} maxLength={200} />}
              </Field>
              <Button type="submit" variant="primary">
                <span className="kauro-go">Create {company ? "the company workspace" : "the agency"}</span>
              </Button>
            </form>
          );
    }

  const windowState = activated ? "Active" : named ? "Draft" : "Not created yet";
  return (
    <>
      <PageHead eyebrow="Getting started" title={`Set up your ${kind}`} accent={2} lead="Complete the steps needed to handle client data." />
      <div className="kauro-setup-object">
        <Window title={named || activated ? `${orgName} · setup` : "New organisation · setup"} state={windowState} stateTone={activated ? "done" : "neutral"} className="kauro-setup">
          <div className="kauro-setup-grid">
            <div className="kauro-setup-path">
              <Rings
                label="Five steps"
                items={[
                  { key: "identity", name: "Your identity", fact: facts.identity, state: ring("identity") },
                  { key: "organisation", name: "Your organisation", fact: facts.organisation, state: ring("organisation") },
                  { key: "buyer", name: "Who buys", fact: facts.buyer, state: ring("buyer") },
                  { key: "billing", name: "Billing profile", fact: facts.billing, state: ring("billing") },
                  { key: "agreements", name: "Agreements", fact: facts.agreements, state: ring("agreements") },
                ]}
              />
            </div>
            <section className="kauro-setup-step" aria-live="polite" aria-label="Current step">
              {step}
            </section>
          </div>
        </Window>
        {activated ? <Stamp>Active</Stamp> : null}
      </div>
      <p className="kauro-setup-join">
        Joining an agency that already uses Kauro? Open the invitation link you were sent. An email address never adds anyone to an agency on its own. <ScreenLink to="UI51" ctx={ctx}>About invitations</ScreenLink>
      </p>
    </>
  );
}
