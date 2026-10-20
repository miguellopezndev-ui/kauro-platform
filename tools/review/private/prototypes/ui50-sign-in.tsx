"use client";
// UI50 Sign in (registry: "Continue securely."). BLOCKED EXTERNAL: the identity provider is not connected (W-IDP-LIVE), so the real page
// can only say sign-in is not available. The design follows the identity port's steps (apps/web/src/client/identity/port.ts): email and
// password go to the provider, never to Kauro; then a code, or setting up two-step verification; an unverified email is sent a link. A
// failure never says whether an account exists. After sign-in the person returns only to an application path (safeReturnPath).
//
// The page is the doorway from the public site: one card with the form, and under it the same strip of three assurances the public Home
// shows under its hero, here about how the account is protected. Nothing else competes with the form.
import { Banner, Button, ErrorSummary, Field } from "@kauro/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactElement, useState } from "react";
import { asHref } from "../lib/links.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Eyebrow } from "./kit.tsx";

export const UI50_STATES: readonly StateDef[] = [
  { key: "normal", label: "Sign in", note: "Email and password. They go to the identity provider; Kauro never receives the password." },
  { key: "invalid", label: "Wrong details", note: "One generic message for every failure: it never says whether an account exists." },
  { key: "code", label: "Two-step code", note: "The provider asks for the six-digit code of the person's authenticator app." },
  { key: "enrol", label: "Set up two-step verification", note: "First sign-in without two-step verification: Kauro requires it before any client data." },
  { key: "unverified", label: "Email not verified", note: "The address is not verified yet: send the link again, then continue." },
  { key: "sent", label: "Verification sent", note: "The link was sent; the person confirms once they have opened it." },
  { key: "locked", label: "Too many attempts", note: "The provider paused attempts. The message names no account." },
  { key: "unavailable", label: "Provider not connected (today)", note: "What the real page shows until the identity provider is connected (W-IDP-LIVE)." },
  { key: "expired", label: "Session ended", note: "A session that ended sends the person here, and back to the same screen after signing in." },
  { key: "ops", label: "Operations sign-in", note: "The same page on the operations address, for the Kauro owner and sellers." },
];

const ASSURANCES = [
  { title: "Two-step verification", body: "Required on every account before any client data is shown." },
  { title: "Your password stays private", body: "It goes to the identity provider only. Kauro never receives or stores it." },
  { title: "Kauro never writes to your CRM", body: "Your team imports the files Kauro prepares, in its own account." },
] as const;

function CodeField({ id, hint, error }: { readonly id: string; readonly hint: string; readonly error?: string | undefined }): ReactElement {
  return (
    <Field id={id} label="Six-digit code" hint={hint} error={error}>
      {(control) => <input {...control} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} className="kauro-code-input" />}
    </Field>
  );
}

export function SignIn({ ctx, state }: PrototypeProps): ReactElement {
  const router = useRouter();
  const [step, setStep] = useState(state);
  const [errors, setErrors] = useState<readonly { fieldId: string; message: string }[]>([]);
  const ops = state === "ops" || ctx.key === "owner" || ctx.key === "seller";
  const errorOf = (id: string): string | undefined => errors.find((entry) => entry.fieldId === id)?.message;
  // in review, a correct code opens the person's own start page (the real page returns to the path the person came from)
  const enter = (): void => router.push(asHref(ctx.key));

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
    const ok = /^[0-9]{6}$/.test(code);
    setErrors(ok ? [] : [{ fieldId: "signin-code", message: "Enter the six digits your authenticator app shows." }]);
    if (ok) enter();
  };

  let body: ReactElement;
  switch (step) {
    case "code":
      body = (
        <form className="kauro-form" noValidate onSubmit={submitCode}>
          <p className="kauro-signin-who">lena.ortiz@northwind.example</p>
          <ErrorSummary title="Check the code" errors={errors} />
          <CodeField id="signin-code" hint="Open your authenticator app and enter the code it shows for Kauro." error={errorOf("signin-code")} />
          <Button type="submit" variant="primary">
            <span className="kauro-go">Continue</span>
          </Button>
          <button type="button" className="kauro-text-button" onClick={() => setStep("normal")}>
            Use another account
          </button>
        </form>
      );
      break;
    case "enrol":
      body = (
        <form className="kauro-form" noValidate onSubmit={submitCode}>
          <p>Kauro asks for a second step before anyone can see client data. Add Kauro to your authenticator app, once:</p>
          <ol className="kauro-signin-steps">
            <li>In the app, choose to add an account.</li>
            <li>
              Scan the code your identity provider shows, or type this setup key: <code className="kauro-secret">REVW SYNT HETI CXXX</code>
            </li>
            <li>Enter the six-digit code the app now shows.</li>
          </ol>
          <p className="kauro-muted">A synthetic key, for review. A real key is shown once by the identity provider and never kept by Kauro.</p>
          <ErrorSummary title="Check the code" errors={errors} />
          <CodeField id="signin-code" hint="This confirms the app is set up." error={errorOf("signin-code")} />
          <Button type="submit" variant="primary">
            <span className="kauro-go">Confirm and continue</span>
          </Button>
        </form>
      );
      break;
    case "unverified":
    case "sent":
      body = (
        <div className="kauro-form">
          {step === "sent" ? (
            <Banner tone="success" title="Link sent" announce="status">
              <p>A new link is on its way to the address you signed in with. Open it, then come back here.</p>
            </Banner>
          ) : (
            <p>Before you continue, open the verification link we sent to the address you signed in with.</p>
          )}
          <div className="kauro-actions">
            <Button variant="primary" onClick={() => setStep("code")}>
              <span className="kauro-go">I have opened the link</span>
            </Button>
            <Button onClick={() => setStep("sent")}>Send the link again</Button>
          </div>
        </div>
      );
      break;
    case "locked":
      body = (
        <Banner tone="warning" title="Too many attempts" announce="alert">
          <p>Sign-in is paused for a while to protect the account. Try again later, or get help below.</p>
        </Banner>
      );
      break;
    case "unavailable":
      body = (
        <Banner tone="warning" title="Sign-in is not available yet" announce="status">
          <p>Kauro&apos;s identity provider is not connected in this environment, so no one can sign in here. Nothing you type is sent.</p>
        </Banner>
      );
      break;
    default:
      body = (
        <form className="kauro-form" noValidate onSubmit={submitCredentials}>
          {step === "invalid" ? (
            <Banner tone="danger" title="We could not sign you in" announce="alert">
              <p>Check your email address and password and try again.</p>
            </Banner>
          ) : null}
          {step === "expired" ? (
            <Banner tone="info" title="Your session ended" announce="status">
              <p>Sign in again to carry on. You will return to Team, in Northwind Data.</p>
            </Banner>
          ) : null}
          <ErrorSummary title="Check these details" errors={errors} />
          <Field id="signin-email" label="Email address" error={errorOf("signin-email")}>
            {(control) => <input {...control} name="email" type="email" autoComplete="username" spellCheck={false} defaultValue={step === "invalid" ? "lena.ortiz@northwind.example" : ""} />}
          </Field>
          <Field id="signin-password" label="Password" error={errorOf("signin-password")}>
            {(control) => <input {...control} name="password" type="password" autoComplete="current-password" />}
          </Field>
          <Button type="submit" variant="primary">
            <span className="kauro-go">Sign in</span>
          </Button>
        </form>
      );
  }

  return (
    <div className="kauro-signin">
      <section className="kauro-signin-card" aria-labelledby="signin-title">
        <Eyebrow>{ops ? "Kauro operations" : "Your Kauro workspace"}</Eyebrow>
        <h1 id="signin-title">Sign in</h1>
        <p className="kauro-lead">Continue securely.</p>
        <div className="kauro-signin-body" aria-live="polite">
          {body}
        </div>
        <p className="kauro-signin-help">
          Cannot sign in? <a href="/help">Get help signing in</a>
          {ops ? null : (
            <>
              <br />
              New to Kauro? <a href="/contact">Request a free data health check</a>
            </>
          )}
        </p>
      </section>
      <ul className="kauro-assurances" aria-label="How your account is protected">
        {ASSURANCES.map((item) => (
          <li key={item.title}>
            <strong>{item.title}</strong>
            <span>{item.body}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
