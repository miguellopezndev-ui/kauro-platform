"use client";
// A variant of the contact form (Order 11; review only, never in the application's bundle). The approved form, with two changes:
//   - the required, unticked authorisation the Data Processing Policy §8.1 and the internal data manual §5.3 (A-01) ask for on the
//     contact form, linking the Policy and the Privacy notice (defect F-08: the approved form lacks it, and the Policy has no public page);
//   - "Email address" instead of "Work email": the owner opened sign-up to any address, a personal Gmail included.
// In the review nothing is sent: a valid form says it would be sent.
import { useEffect, useRef, useState, type FormEvent, type ReactElement, type RefObject } from "react";
import { PUBLIC_COPY, copy, type PublicCopyId } from "@web/copy/public.ts";
import { Section } from "@web/public/parts.tsx";
import {
  BUYER_TYPES,
  DESCRIPTION_MAX,
  DESTINATIONS,
  EMPTY_VALUES,
  FIELD_ORDER,
  RECORD_BANDS,
  TIMINGS,
  validateInquiry,
  waitPhrase,
  type FieldName,
  type InquiryValues,
  type Outcome,
} from "@web/public/inquiry.ts";

type Errors = Readonly<Partial<Record<FieldName, PublicCopyId>>>;

const CONSENT_ERROR = "Tick the box to authorise Kauro to process your personal data for this inquiry";

/** The control a summary link moves focus to, for each field (the first radio for the buyer question). */
const FOCUS_TARGET: Readonly<Record<FieldName, string>> = {
  buyerType: "contact-buyer-agency",
  contactName: "contact-name",
  contactEmail: "contact-email",
  companyName: "contact-company",
  destination: "contact-destination",
  recordBand: "contact-band",
  timing: "contact-timing",
  description: "contact-description",
};

const ERROR_ID: Readonly<Record<FieldName, string>> = {
  buyerType: "contact-buyer-error",
  contactName: "contact-name-error",
  contactEmail: "contact-email-error",
  companyName: "contact-company-error",
  destination: "contact-destination-error",
  recordBand: "contact-band-error",
  timing: "contact-timing-error",
  description: "contact-description-error",
};

function Message({ name, errors }: { readonly name: FieldName; readonly errors: Errors }): ReactElement | null {
  const id = errors[name];
  if (id === undefined) return null;
  return (
    <p id={ERROR_ID[name]} className="kauro-site-error">
      {id === "contact.error.description" ? copy(id, { max: DESCRIPTION_MAX }) : PUBLIC_COPY[id]}
    </p>
  );
}

function Panel({ kind, headingId, heading, body, panelRef }: { readonly kind: string; readonly headingId: string; readonly heading: string; readonly body: string; readonly panelRef: RefObject<HTMLDivElement | null> }): ReactElement {
  return (
    <div className={`kauro-site-panel kauro-site-panel--${kind}`} role="group" aria-labelledby={headingId} tabIndex={-1} ref={panelRef}>
      <h3 id={headingId}>{heading}</h3>
      <p>{body}</p>
    </div>
  );
}

function panelFor(outcome: Outcome): { readonly kind: string; readonly heading: string; readonly body: string } {
  switch (outcome.kind) {
    case "RECEIVED":
      return { kind: "received", heading: PUBLIC_COPY["contact.received.heading"], body: copy("contact.received.body", { reference: outcome.reference }) };
    case "REFUSED":
      return { kind: "refused", heading: PUBLIC_COPY["contact.refused.heading"], body: PUBLIC_COPY["contact.refused.body"] };
    case "LIMITED":
      return { kind: "limited", heading: PUBLIC_COPY["contact.limited.heading"], body: copy("contact.limited.body", { wait: waitPhrase(outcome.retryAfterSeconds) }) };
    case "FIELDS":
      return { kind: "fields", heading: PUBLIC_COPY["contact.summary.heading"], body: PUBLIC_COPY["contact.fields.body"] };
    case "FAILED":
      return { kind: "failed", heading: PUBLIC_COPY["contact.failed.heading"], body: PUBLIC_COPY["contact.failed.body"] };
  }
}

const POLICY = "/legal/data-processing-policy";
const PRIVACY = "/legal/privacy";

export function InquiryFormConsent(): ReactElement {
  const [consent, setConsent] = useState(false);
  const [consentMissing, setConsentMissing] = useState(false);
  const [previewed, setPreviewed] = useState(false);
  const [values, setValues] = useState<InquiryValues>(EMPTY_VALUES);
  const [errors, setErrors] = useState<Errors>({});
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const inFlight = useRef(false);
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (focusTick === 0) return;
    (summaryRef.current ?? panelRef.current)?.focus();
  }, [focusTick]);

  const set = (name: FieldName, value: string): void => setValues((current) => ({ ...current, [name]: value }));
  const failing = FIELD_ORDER.filter((name) => errors[name] !== undefined);
  const describedBy = (name: FieldName, extra?: string): string | undefined => {
    const ids = [extra, errors[name] === undefined ? undefined : ERROR_ID[name]].filter((id): id is string => id !== undefined);
    return ids.length === 0 ? undefined : ids.join(" ");
  };
  const invalid = (name: FieldName): true | undefined => (errors[name] === undefined ? undefined : true);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current) return;
    const result = validateInquiry(values);
    setConsentMissing(!consent);
    setPreviewed(false);
    if (!result.ok || !consent) {
      setErrors(result.ok ? {} : result.errors);
      setOutcome(null);
      setFocusTick((tick) => tick + 1);
      return;
    }
    // the review sends nothing: the form is valid and the authorisation given, so it says what would happen
    setErrors({});
    setOutcome(null);
    setPreviewed(true);
    setFocusTick((tick) => tick + 1);
  }

  function focusField(name: FieldName): void {
    document.getElementById(FOCUS_TARGET[name])?.focus();
  }

  const received = outcome?.kind === "RECEIVED";
  const shown = outcome === null ? null : panelFor(outcome);

  return (
    <Section id="contact-form" heading={PUBLIC_COPY["contact.form.label"]}>
      <div className="kauro-site-result" role="status">
        {sending ? PUBLIC_COPY["contact.sending.status"] : null}
      </div>
      {received && shown !== null ? (
        <Panel kind={shown.kind} headingId="contact-outcome-heading" heading={shown.heading} body={shown.body} panelRef={panelRef} />
      ) : (
        <>
          {failing.length > 0 || consentMissing ? (
            <div className="kauro-site-panel kauro-site-panel--summary" role="group" aria-labelledby="contact-summary-heading" tabIndex={-1} ref={summaryRef}>
              <h3 id="contact-summary-heading">{PUBLIC_COPY["contact.summary.heading"]}</h3>
              <ul className="kauro-site-list">
                {failing.map((name) => (
                  <li key={name}>
                    <a
                      href={`#${FOCUS_TARGET[name]}`}
                      onClick={(event) => {
                        event.preventDefault();
                        focusField(name);
                      }}
                    >
                      {errors[name] === "contact.error.description" ? copy("contact.error.description", { max: DESCRIPTION_MAX }) : PUBLIC_COPY[errors[name] ?? "contact.error.name"]}
                    </a>
                  </li>
                ))}
                {consentMissing ? (
                  <li>
                    <a
                      href="#contact-consent"
                      onClick={(event) => {
                        event.preventDefault();
                        document.getElementById("contact-consent")?.focus();
                      }}
                    >
                      {CONSENT_ERROR}
                    </a>
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}
          {previewed ? (
            <div className="kauro-site-panel kauro-site-panel--received" role="group" aria-labelledby="contact-preview-heading" tabIndex={-1} ref={panelRef}>
              <h3 id="contact-preview-heading">The inquiry would be sent</h3>
              <p>This is a review: nothing was sent. In the product, the authorisation is kept with its version, date and time.</p>
            </div>
          ) : null}
          {shown !== null ? <Panel kind={shown.kind} headingId="contact-outcome-heading" heading={shown.heading} body={shown.body} panelRef={panelRef} /> : null}
          <form className="kauro-site-form" method="post" noValidate onSubmit={(event) => void submit(event)}>
            <p className="kauro-site-note">{PUBLIC_COPY["contact.required.hint"]}</p>
            <fieldset className="kauro-site-fieldset" id="contact-buyer" aria-describedby={describedBy("buyerType")}>
              <legend>{PUBLIC_COPY["contact.buyer.legend"]}</legend>
              <Message name="buyerType" errors={errors} />
              {BUYER_TYPES.map((type) => (
                <div className="kauro-site-choice" key={type}>
                  <input id={`contact-buyer-${type}`} name="buyerType" type="radio" required value={type} checked={values.buyerType === type} onChange={() => set("buyerType", type)} />
                  <label htmlFor={`contact-buyer-${type}`}>{PUBLIC_COPY[`contact.buyer.${type}`]}</label>
                </div>
              ))}
            </fieldset>
            <div className="kauro-site-field">
              <label htmlFor="contact-name">{PUBLIC_COPY["contact.name.label"]}</label>
              <Message name="contactName" errors={errors} />
              <input id="contact-name" name="contactName" type="text" autoComplete="name" required aria-invalid={invalid("contactName")} aria-describedby={describedBy("contactName")} value={values.contactName} onChange={(event) => set("contactName", event.target.value)} />
            </div>
            <div className="kauro-site-field">
              <label htmlFor="contact-email">Email address</label>
              <Message name="contactEmail" errors={errors} />
              <input id="contact-email" name="contactEmail" type="email" autoComplete="email" required aria-invalid={invalid("contactEmail")} aria-describedby={describedBy("contactEmail")} value={values.contactEmail} onChange={(event) => set("contactEmail", event.target.value)} />
            </div>
            <div className="kauro-site-field">
              <label htmlFor="contact-company">{PUBLIC_COPY["contact.company.label"]}</label>
              <Message name="companyName" errors={errors} />
              <input id="contact-company" name="companyName" type="text" autoComplete="organization" required aria-invalid={invalid("companyName")} aria-describedby={describedBy("companyName")} value={values.companyName} onChange={(event) => set("companyName", event.target.value)} />
            </div>
            <div className="kauro-site-field">
              <label htmlFor="contact-destination">{PUBLIC_COPY["contact.destination.label"]}</label>
              <Message name="destination" errors={errors} />
              <select id="contact-destination" name="destination" required aria-invalid={invalid("destination")} aria-describedby={describedBy("destination")} value={values.destination} onChange={(event) => set("destination", event.target.value)}>
                <option value="">{PUBLIC_COPY["contact.choose.option"]}</option>
                {DESTINATIONS.map((destination) => (
                  <option key={destination} value={destination}>
                    {PUBLIC_COPY[`contact.destination.${destination}`]}
                  </option>
                ))}
              </select>
            </div>
            <div className="kauro-site-field">
              <label htmlFor="contact-band">{PUBLIC_COPY["contact.band.label"]}</label>
              <Message name="recordBand" errors={errors} />
              <select id="contact-band" name="recordBand" required aria-invalid={invalid("recordBand")} aria-describedby={describedBy("recordBand")} value={values.recordBand} onChange={(event) => set("recordBand", event.target.value)}>
                <option value="">{PUBLIC_COPY["contact.choose.option"]}</option>
                {RECORD_BANDS.map((band) => (
                  <option key={band.value} value={band.value}>
                    {band.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="kauro-site-field">
              <label htmlFor="contact-timing">{PUBLIC_COPY["contact.timing.label"]}</label>
              <Message name="timing" errors={errors} />
              <select id="contact-timing" name="timing" required aria-invalid={invalid("timing")} aria-describedby={describedBy("timing")} value={values.timing} onChange={(event) => set("timing", event.target.value)}>
                <option value="">{PUBLIC_COPY["contact.choose.option"]}</option>
                {TIMINGS.map((timing) => (
                  <option key={timing} value={timing}>
                    {PUBLIC_COPY[`contact.timing.${timing}`]}
                  </option>
                ))}
              </select>
            </div>
            <div className="kauro-site-field">
              <label htmlFor="contact-description">{PUBLIC_COPY["contact.description.label"]}</label>
              <p id="contact-description-hint" className="kauro-site-note">
                {copy("contact.description.hint", { max: DESCRIPTION_MAX })}
              </p>
              <Message name="description" errors={errors} />
              <textarea id="contact-description" name="description" rows={6} aria-invalid={invalid("description")} aria-describedby={describedBy("description", "contact-description-hint")} value={values.description} onChange={(event) => set("description", event.target.value)} />
            </div>
            <div className="kauro-site-field kauro-variant-consent">
              {consentMissing ? (
                <p id="contact-consent-error" className="kauro-site-error">
                  {CONSENT_ERROR}
                </p>
              ) : null}
              <div className="kauro-site-choice">
                <input
                  id="contact-consent"
                  name="consent"
                  type="checkbox"
                  required
                  checked={consent}
                  aria-invalid={consentMissing ? true : undefined}
                  aria-describedby={consentMissing ? "contact-consent-error" : undefined}
                  onChange={(event) => {
                    setConsent(event.target.checked);
                    if (event.target.checked) setConsentMissing(false);
                  }}
                />
                <label htmlFor="contact-consent">
                  I authorise Kauro to process my personal data to answer this inquiry, as the <a href={POLICY}>Data processing policy</a> and the <a href={PRIVACY}>Privacy notice</a> explain.
                </label>
              </div>
            </div>
            <button className="kauro-site-button kauro-site-button--primary" type="submit" aria-disabled={sending ? true : undefined}>
              {PUBLIC_COPY["contact.submit.cta"]}
            </button>
          </form>
          <noscript>
            <p className="kauro-site-note">{PUBLIC_COPY["contact.form.noscript"]}</p>
          </noscript>
        </>
      )}
    </Section>
  );
}
