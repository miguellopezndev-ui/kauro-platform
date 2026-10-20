"use client";
// UI09 Agency setup (registry: "Complete the steps needed to handle client data."). Identity, the organisation, who buys, the billing
// profile and the agreements are separate steps, each with its state (registry "Separate identity, membership, legal/billing profile,
// agreements and MFA readiness"). The organisation is created as a draft (CMD001, one draft per person), its buyer type is set once by the
// owner (setBuyerType, A3 3.7: an agency or a company buying for its own data), the billing profile is prepared by Kauro (no intake
// command yet), and activation accepts the published agreements (CMD002). Today the agreements are not published, so activation is shown
// as not available. An email domain never adds anyone to an agency: joining an existing one is by invitation only.
import { Banner, Button, ErrorSummary, Field } from "@kauro/ui";
import { type FormEvent, type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, day, Facts, ScreenButton, ScreenLink } from "./kit.tsx";

export const UI09_STATES: readonly StateDef[] = [
  { key: "normal", label: "Name your organisation", note: "Identity is ready; the person names the organisation, which is created as a draft." },
  { key: "identity", label: "Two-step verification missing", note: "The email is verified but two-step verification is off: nothing else can start until it is on." },
  { key: "invalid", label: "Name not accepted", note: "Validation: an empty or over-long name is explained next to the field and in a summary." },
  { key: "buyer", label: "Who buys", note: "The draft exists; the owner says once whether it is an agency or a company buying for its own data." },
  { key: "billing", label: "Billing profile pending", note: "Kauro prepares the billing profile from the details sent through support; the person waits." },
  { key: "agreements-today", label: "Agreements not published (today)", note: "The real state today: the legal documents are not published, so activation is not available." },
  { key: "agreements", label: "Accept and activate", note: "Designed future: the published agreements are accepted and the organisation becomes active." },
  { key: "activated", label: "Active", note: "Activation done: the organisation is ready for clients and projects." },
  { key: "draft-exists", label: "A draft already exists", note: "One draft per person: the existing draft is resumed instead of creating another." },
  { key: "limited", label: "Too many new organisations", note: "Creation is rate-limited: the person is told to wait, nothing is created." },
];

type StepKey = "identity" | "organisation" | "buyer" | "billing" | "agreements";

const STEPS: ReadonlyArray<{ readonly key: StepKey; readonly title: string; readonly detail: string }> = [
  { key: "identity", title: "Your identity", detail: "Verified email and two-step verification" },
  { key: "organisation", title: "Your organisation", detail: "The name your team and deliveries show" },
  { key: "buyer", title: "Who buys", detail: "An agency, or a company for its own data" },
  { key: "billing", title: "Billing profile", detail: "Prepared by Kauro for your invoices" },
  { key: "agreements", title: "Agreements", detail: "Service terms and data processing terms" },
];

function currentOf(state: string): StepKey {
  switch (state) {
    case "identity":
      return "identity";
    case "buyer":
      return "buyer";
    case "billing":
      return "billing";
    case "agreements":
    case "agreements-today":
    case "activated":
      return "agreements";
    default:
      return "organisation";
  }
}

export function AgencySetup({ ctx, state }: PrototypeProps): ReactElement {
  const company = ctx.key === "company";
  const orgName = company ? "Halden Outdoor" : "Northwind Data";
  const [current, setCurrent] = useState<StepKey>(currentOf(state));
  const [errors, setErrors] = useState<readonly { fieldId: string; message: string }[]>(
    state === "invalid" ? [{ fieldId: "setup-name", message: "Enter a name of 120 characters or fewer, without control characters." }] : [],
  );
  const [activated, setActivated] = useState(state === "activated");
  const index = STEPS.findIndex((step) => step.key === current);
  const statusOf = (key: StepKey, position: number): "done" | "current" | "waiting" | "blocked" => {
    if (activated) return "done";
    if (key === "agreements" && state === "agreements-today" && current === "agreements") return "blocked";
    return position < index ? "done" : position === index ? "current" : "waiting";
  };
  const createDraft = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    const found = name === "" ? [{ fieldId: "setup-name", message: "Enter the name of your organisation." }] : name.length > 120 ? [{ fieldId: "setup-name", message: "Use 120 characters or fewer." }] : [];
    setErrors(found);
    if (found.length === 0) setCurrent("buyer");
  };

  let panel: ReactElement;
  if (activated) {
    panel = (
      <>
        <Banner tone="success" title={`${orgName} is active`} announce="status">
          <p>You accepted the agreements. Add your first {company ? "data set" : "client"} and start a project.</p>
        </Banner>
        <div className="kauro-actions">
          <ScreenButton to={company ? "UI11" : "UI12"} ctx={ctx} variant="primary">
            {company ? "Start a project" : "Add a client"}
          </ScreenButton>
        </div>
      </>
    );
  } else
    switch (current) {
      case "identity":
        panel = (
          <>
            <h2>Your identity</h2>
            <Facts
              rows={[
                ["Email address", <Badge key="e" tone="success">Verified</Badge>],
                ["Two-step verification", <Badge key="m" tone="warning">Not set up</Badge>],
              ]}
            />
            <p>Kauro requires two-step verification before anyone can see client data. Set it up once; it is asked for again before sensitive actions.</p>
            <div className="kauro-actions">
              <ScreenButton to="UI50" ctx={ctx} variant="primary">
                Set up two-step verification
              </ScreenButton>
            </div>
          </>
        );
        break;
      case "buyer":
        panel = (
          <form noValidate onSubmit={(event) => (event.preventDefault(), setCurrent("billing"))}>
            <h2>Who buys</h2>
            <p>
              Tell us once how <bdi>{orgName}</bdi> uses Kauro. It does not change prices, discounts or what Kauro can prepare. Only the owner can set it, and it cannot be changed afterwards.
            </p>
            <fieldset className="kauro-choice">
              <legend>{orgName} is</legend>
              <label>
                <input type="radio" name="buyerType" value="agency" defaultChecked={!company} />
                <span>
                  <strong>An agency</strong> preparing CRM data for its clients
                </span>
              </label>
              <label>
                <input type="radio" name="buyerType" value="in-house" defaultChecked={company} />
                <span>
                  <strong>A company</strong> preparing its own CRM data
                </span>
              </label>
            </fieldset>
            <label className="kauro-confirm">
              <input type="checkbox" name="economic" defaultChecked />
              <span>We buy for a business activity, not as private consumers.</span>
            </label>
            <div className="kauro-actions">
              <Button type="submit" variant="primary">
                Save and continue
              </Button>
            </div>
          </form>
        );
        break;
      case "billing":
        panel = (
          <>
            <h2>Billing profile</h2>
            <Facts
              rows={[
                ["State", <Badge key="s" tone="info">Being prepared by Kauro</Badge>],
                ["Requested", day("2026-10-20T09:00:00Z")],
              ]}
            />
            <p>Kauro prepares your billing profile from the legal name, address and tax details you send through support. You will see it here, ready to confirm, when it is prepared.</p>
            <div className="kauro-actions">
              <Button variant="primary" onClick={() => setCurrent("agreements")}>
                Continue to agreements
              </Button>
              <ScreenButton to="UI52" ctx={ctx}>
                Send billing details through support
              </ScreenButton>
            </div>
          </>
        );
        break;
      case "agreements":
        panel =
          state === "agreements-today" ? (
            <>
              <h2>Agreements</h2>
              <Banner tone="warning" title="The agreements are not published yet" announce="status">
                <p>Activation needs the published service terms and data processing terms. They are not available in this environment, so {orgName} stays a draft for now.</p>
              </Banner>
              <Facts
                rows={[
                  ["Service terms", "Not published"],
                  ["Data processing terms", "Not published"],
                ]}
              />
            </>
          ) : (
            <form noValidate onSubmit={(event) => (event.preventDefault(), setActivated(true))}>
              <h2>Agreements</h2>
              <p>Read and accept the versions below. Accepting activates {orgName}; the accepted versions are kept with your organisation.</p>
              <Facts
                rows={[
                  ["Service terms", <a key="t" href="/legal/terms">Version 2026-10 (read)</a>],
                  ["Data processing terms", <a key="d" href="/legal/data-processing">Version 2026-10 (read)</a>],
                  ["Billing profile", <Badge key="b" tone="success">Prepared</Badge>],
                ]}
              />
              <label className="kauro-confirm">
                <input type="checkbox" name="accept" required />
                <span>I accept the service terms and the data processing terms on behalf of {orgName}, and I am authorised to do so.</span>
              </label>
              <div className="kauro-actions">
                <Button type="submit" variant="primary">
                  Accept and activate
                </Button>
              </div>
            </form>
          );
        break;
      default:
        panel =
          state === "draft-exists" ? (
            <>
              <h2>Your organisation</h2>
              <Banner tone="info" title="You already have an organisation in setup" announce="status">
                <p>Each person can have one organisation in setup at a time. Continue with it, or finish it before starting another.</p>
              </Banner>
              <Facts
                rows={[
                  ["Name", <bdi key="n">{orgName}</bdi>],
                  ["State", <Badge key="s" tone="neutral">Draft</Badge>],
                  ["Started", day("2026-10-18T16:40:00Z")],
                ]}
              />
              <div className="kauro-actions">
                <Button variant="primary" onClick={() => setCurrent("buyer")}>
                  Continue setting up {orgName}
                </Button>
              </div>
            </>
          ) : (
            <form noValidate onSubmit={createDraft}>
              <h2>Your organisation</h2>
              {state === "limited" ? (
                <Banner tone="warning" title="Please wait before creating another organisation" announce="alert">
                  <p>Too many organisations were started from this account recently. Nothing was created. Try again later.</p>
                </Banner>
              ) : null}
              <ErrorSummary title="Check the name" errors={errors} />
              <Field id="setup-name" label="Organisation name" hint="Shown to your team and on your deliveries. Up to 120 characters; you can change it later." error={errors.find((entry) => entry.fieldId === "setup-name")?.message}>
                {(control) => <input {...control} name="name" autoComplete="organization" defaultValue={state === "invalid" ? "" : orgName} maxLength={200} />}
              </Field>
              <div className="kauro-actions">
                <Button type="submit" variant="primary">
                  Create {company ? "the organisation" : "the agency"}
                </Button>
              </div>
            </form>
          );
    }

  return (
    <>
      <h1>Set up {company ? "your organisation" : "your agency"}</h1>
      <p className="kauro-lead">Complete the steps needed to handle client data.</p>
      <div className="kauro-setup">
        <nav className="kauro-setup-steps" aria-label="Setup steps">
          <ol>
            {STEPS.map((step, position) => {
              const status = statusOf(step.key, position);
              return (
                <li key={step.key} className={`kauro-setup-step kauro-setup-step--${status}`} aria-current={status === "current" ? "step" : undefined}>
                  <span className="kauro-setup-mark" aria-hidden="true">
                    {status === "done" ? "" : position + 1}
                  </span>
                  <span className="kauro-setup-text">
                    <span className="kauro-setup-title">{step.title}</span>
                    <span className="kauro-setup-detail">{step.detail}</span>
                    <span className={`kauro-setup-state kauro-setup-state--${status}`}>{status === "done" ? "Done" : status === "current" ? "Now" : status === "blocked" ? "Not available yet" : "Later"}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </nav>
        <section className="kauro-setup-panel" aria-live="polite">
          {panel}
        </section>
      </div>
      <aside className="kauro-setup-aside" aria-labelledby="setup-join">
        <h2 id="setup-join">Joining an existing agency?</h2>
        <p>
          Open the invitation link you received. Kauro never adds you to an agency because of your email address; only an invitation does. <ScreenLink to="UI51" ctx={ctx}>What an invitation looks like</ScreenLink>
        </p>
      </aside>
    </>
  );
}
