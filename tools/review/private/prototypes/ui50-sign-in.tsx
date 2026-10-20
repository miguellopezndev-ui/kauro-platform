"use client";
// UI50 Sign in (registry: "Continue securely."). BLOCKED EXTERNAL: the identity provider is not connected (W-IDP-LIVE), so the real page
// can only say sign-in is not available. The design follows the identity port's steps (apps/web/src/client/identity/port.ts): email and
// password go to the provider, never to Kauro; then a code, or setting up two-step verification; an unverified email is sent a link. A
// failure never says whether an account exists. After sign-in the person returns only to an application path (safeReturnPath).
import { Banner, Button, ErrorSummary, Field } from "@kauro/ui";
import { type FormEvent, type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";

export const UI50_STATES: readonly StateDef[] = [
  { key: "normal", label: "Sign in", note: "Email and password. They go to the identity provider; Kauro never receives the password." },
  { key: "invalid", label: "Wrong details", note: "One generic message for every failure: it never says whether an account exists." },
  { key: "code", label: "Two-step code", note: "The provider asks for the six-digit code of the person's authenticator app." },
  { key: "enrol", label: "Set up two-step verification", note: "First sign-in without two-step verification: Kauro requires it before any agency data." },
  { key: "unverified", label: "Email not verified", note: "The address is not verified yet: send the link again, then continue." },
  { key: "sent", label: "Verification sent", note: "The link was sent; the person confirms once they have opened it." },
  { key: "locked", label: "Too many attempts", note: "The provider paused attempts. The message names no account." },
  { key: "unavailable", label: "Provider not connected (today)", note: "What the real page shows until the identity provider is connected (W-IDP-LIVE)." },
  { key: "expired", label: "Session ended", note: "A session that ended sends the person here, and back to the same screen after signing in." },
  { key: "ops", label: "Operations sign-in", note: "The same page on the operations address, for the Kauro owner and sellers." },
];

function Code({ id, label, hint, error }: { readonly id: string; readonly label: string; readonly hint: string; readonly error?: string | undefined }): ReactElement {
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      {(control) => <input {...control} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} className="kauro-code-input" />}
    </Field>
  );
}

export function SignIn({ state }: PrototypeProps): ReactElement {
  const [step, setStep] = useState(state);
  const [errors, setErrors] = useState<readonly { fieldId: string; message: string }[]>([]);
  const ops = state === "ops";

  const submitCredentials = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const found: { fieldId: string; message: string }[] = [];
    if (String(data.get("email") ?? "").trim() === "") found.push({ fieldId: "signin-email", message: "Enter your email address." });
    if (String(data.get("password") ?? "") === "") found.push({ fieldId: "signin-password", message: "Enter your password." });
    setErrors(found);
    if (found.length === 0) setStep("code");
  };
  const submitCode = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code") ?? "");
    setErrors(/^[0-9]{6}$/.test(code) ? [] : [{ fieldId: "signin-code", message: "Enter the six digits shown in your authenticator app." }]);
  };
  const errorOf = (id: string): string | undefined => errors.find((entry) => entry.fieldId === id)?.message;

  const credentials = (
    <form className="kauro-signin-form" noValidate onSubmit={submitCredentials}>
      <ErrorSummary title="Check these details" errors={errors} />
      {step === "invalid" ? (
        <Banner tone="danger" title="We could not sign you in" announce="alert">
          <p>Check your email address and password and try again. If you still cannot sign in, use the help link below.</p>
        </Banner>
      ) : null}
      {step === "expired" ? (
        <Banner tone="info" title="Your session ended" announce="status">
          <p>Sign in again to continue. You will return to Team in Northwind Data.</p>
        </Banner>
      ) : null}
      <Field id="signin-email" label="Email address" error={errorOf("signin-email")}>
        {(control) => <input {...control} name="email" type="email" autoComplete="username" spellCheck={false} defaultValue={step === "invalid" ? "lena.ortiz@northwind.example" : ""} />}
      </Field>
      <Field id="signin-password" label="Password" hint="Sent to the identity provider only. Kauro never receives or stores it." error={errorOf("signin-password")}>
        {(control) => <input {...control} name="password" type="password" autoComplete="current-password" />}
      </Field>
      <Button type="submit" variant="primary">
        Sign in
      </Button>
    </form>
  );

  let body: ReactElement;
  switch (step) {
    case "code":
      body = (
        <form className="kauro-signin-form" noValidate onSubmit={submitCode}>
          <h2>Enter your code</h2>
          <p>Open your authenticator app and enter the six-digit code for Kauro.</p>
          <ErrorSummary title="Check the code" errors={errors} />
          <Code id="signin-code" label="Six-digit code" hint="The code changes every 30 seconds." error={errorOf("signin-code")} />
          <Button type="submit" variant="primary">
            Continue
          </Button>
          <button type="button" className="kauro-text-button" onClick={() => setStep("normal")}>
            Use another account
          </button>
        </form>
      );
      break;
    case "enrol":
      body = (
        <form className="kauro-signin-form" noValidate onSubmit={submitCode}>
          <h2>Set up two-step verification</h2>
          <p>Kauro asks for a second step before anyone can see agency data. Add Kauro to an authenticator app, then enter the code it shows.</p>
          <ol className="kauro-numbered">
            <li>Open your authenticator app and choose to add an account.</li>
            <li>
              Scan the code your provider shows, or type this setup key: <code className="kauro-secret">REVW SYNT HETI CXXX</code>
              <span className="kauro-hint">Synthetic key for review. A real key is shown once and never stored by Kauro.</span>
            </li>
            <li>Enter the six-digit code the app shows.</li>
          </ol>
          <ErrorSummary title="Check the code" errors={errors} />
          <Code id="signin-code" label="Six-digit code" hint="This confirms the app is set up." error={errorOf("signin-code")} />
          <Button type="submit" variant="primary">
            Confirm and continue
          </Button>
        </form>
      );
      break;
    case "unverified":
    case "sent":
      body = (
        <div className="kauro-signin-form">
          <h2>Verify your email address</h2>
          {step === "sent" ? (
            <Banner tone="success" title="Link sent" announce="status">
              <p>We sent a new link to the address you signed in with. Open it, then come back here.</p>
            </Banner>
          ) : (
            <p>Before you continue, open the link we sent to the address you signed in with.</p>
          )}
          <div className="kauro-actions">
            <Button variant="primary" onClick={() => setStep("code")}>
              I have opened the link
            </Button>
            <Button onClick={() => setStep("sent")}>Send the link again</Button>
          </div>
        </div>
      );
      break;
    case "locked":
      body = (
        <div className="kauro-signin-form">
          <Banner tone="warning" title="Too many attempts" announce="alert">
            <p>Sign-in is paused for now to protect the account. Try again later, or use the help link below.</p>
          </Banner>
        </div>
      );
      break;
    case "unavailable":
      body = (
        <div className="kauro-signin-form">
          <Banner tone="warning" title="Sign-in is not available yet" announce="status">
            <p>Kauro&apos;s identity provider is not connected in this environment, so no one can sign in here. Nothing you type is sent.</p>
          </Banner>
        </div>
      );
      break;
    default:
      body = credentials;
  }

  return (
    <div className="kauro-signin">
      <section className="kauro-signin-aside" aria-labelledby="signin-aside">
        <p className="kauro-signin-eyebrow">{ops ? "Kauro operations" : "Agency workspace"}</p>
        <h2 id="signin-aside">{ops ? "Operations for the Kauro owner and sellers." : "Prepared, verified CRM data from your exported files."}</h2>
        <ul>
          {ops ? (
            <>
              <li>Each person sees only what their role allows.</li>
              <li>Sensitive actions ask you to confirm your identity again.</li>
              <li>Customer CRM records are never shown here.</li>
            </>
          ) : (
            <>
              <li>Two-step verification protects every agency.</li>
              <li>Your password stays with the identity provider.</li>
              <li>Kauro never writes to your CRM.</li>
            </>
          )}
        </ul>
      </section>
      <section className="kauro-signin-main" aria-labelledby="signin-title">
        <h1 id="signin-title">Sign in</h1>
        <p className="kauro-lead">Continue securely.</p>
        {body}
        <p className="kauro-signin-help">
          Cannot sign in? <a href="/help">Get help signing in</a>. New to Kauro? <a href="/contact">Request a free data health check</a>.
        </p>
      </section>
    </div>
  );
}
