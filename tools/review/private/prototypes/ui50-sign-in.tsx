"use client";
// UI50 Sign in (registry: "Continue securely."). BLOCKED EXTERNAL: the identity provider is not connected (W-IDP-LIVE), so the real page
// can only say sign-in is not available. This is the design for the owner's decisions of 2026-10-20:
//   - two ways in, Google and email with a password, Google first and never less prominent;
//   - after either, Kauro's own six-digit code from an authenticator app, never replaced by an email;
//   - an unverified email or an account without two-step verification finishes those steps before any private data;
//   - a failure never says whether an account exists, and repeated attempts pause sign-in;
//   - "Create an account" only on the customer application. The operations sign-in (owner, sellers, staff) is by invitation.
// After sign-in the person returns only to an application path (safeReturnPath).
//
// The page is the doorway seen from the public site: the product's own window, holding the form, and nothing competing with it.
import { Banner, Button, ErrorSummary, Field } from "@kauro/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactElement, useState } from "react";
import { asHref } from "../lib/links.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { AuthFrame, CodeField, EnrolSteps, GoogleButton, HELP, Or, PasswordField, RecoveryList, RESET, SIGN_UP, Who } from "./auth.tsx";

export const UI50_STATES: readonly StateDef[] = [
  { key: "normal", label: "Sign in", note: "Google first, then email and password. The password goes to the identity provider; Kauro never receives it." },
  { key: "invalid", label: "Wrong details", note: "One message for every failure: it never says whether an account exists." },
  { key: "code", label: "Kauro code", note: "After the password, the six-digit code of the person's authenticator app." },
  { key: "google", label: "Back from Google", note: "Google has said who the person is; Kauro still asks for its own code." },
  { key: "google-new", label: "Google account without Kauro", note: "The Google account has no Kauro account: the person may create one, with the same Google account." },
  { key: "recovery", label: "Recovery code", note: "The authenticator app is not at hand: one recovery code opens the account once." },
  { key: "unverified", label: "Email not verified", note: "An account that never verified its email: a code is sent, then two-step verification." },
  { key: "enrol", label: "Set up two-step verification", note: "An account without two-step verification sets it up before any private data." },
  { key: "codes", label: "Recovery codes", note: "Shown once, right after two-step verification is set up." },
  { key: "locked", label: "Too many attempts", note: "Repeated failures pause sign-in for a while. The message names no account." },
  { key: "expired", label: "Session ended", note: "A session that ended sends the person here, and back to the same page after signing in." },
  { key: "unavailable", label: "Provider not connected (today)", note: "What the real page shows until the identity provider is connected (W-IDP-LIVE)." },
  { key: "ops", label: "Operations sign-in", note: "The same page on the operations address, for the Kauro owner, sellers and staff: no sign-up, access by invitation." },
];

const EMAIL = "lena.ortiz@northwind.example";
const OPS_EMAIL = "miguel@kauro.example";
type Errors = readonly { readonly fieldId: string; readonly message: string }[];

export function SignIn({ ctx, state }: PrototypeProps): ReactElement {
  const router = useRouter();
  const ops = state === "ops" || ctx.key === "owner" || ctx.key === "seller";
  const email = ops ? OPS_EMAIL : EMAIL;
  const [step, setStep] = useState(state === "ops" ? "normal" : state);
  const [via, setVia] = useState<"password" | "google">(state === "google" ? "google" : "password");
  const [errors, setErrors] = useState<Errors>([]);
  const errorOf = (id: string): string | undefined => errors.find((entry) => entry.fieldId === id)?.message;
  const go = (next: string): void => {
    setErrors([]);
    setStep(next);
  };
  // in the review a correct code opens the person's own start page; the real page returns to the path the person came from
  const enter = (): void => router.push(asHref(ctx.key));

  const submitCredentials = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const found: { fieldId: string; message: string }[] = [];
    if (String(data.get("email") ?? "").trim() === "") found.push({ fieldId: "signin-email", message: "Enter your email address." });
    if (String(data.get("password") ?? "") === "") found.push({ fieldId: "signin-password", message: "Enter your password." });
    setErrors(found);
    if (found.length === 0) {
      setVia("password");
      setStep("code");
    }
  };
  const checkCode = (event: FormEvent<HTMLFormElement>, id: string, then: () => void): void => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code") ?? "").trim();
    const ok = /^[0-9]{6}$/.test(code);
    setErrors(ok ? [] : [{ fieldId: id, message: "Enter the six digits the app shows now. The code changes every 30 seconds." }]);
    if (ok) then();
  };

  let title = "Sign in to Kauro";
  let lead: string | undefined = "Continue securely.";
  let body: ReactElement;
  switch (step) {
    case "code":
    case "google":
      title = "Enter your Kauro code";
      lead = "Open your authenticator app and enter the code it shows for Kauro.";
      body = (
        <form className="kauro-form" noValidate onSubmit={(event) => checkCode(event, "signin-code", enter)}>
          <Who email={email} onChange={() => go("normal")} change="Change" />
          {via === "google" || step === "google" ? <p className="kauro-auth-small">Google confirmed this address. Kauro still asks for its own code.</p> : null}
          <ErrorSummary title="Check the code" errors={errors} />
          <CodeField id="signin-code" error={errorOf("signin-code")} />
          <Button type="submit" variant="primary">
            <span className="kauro-go">Continue</span>
          </Button>
          <button type="button" className="kauro-text-button" onClick={() => go("recovery")}>
            I do not have my authenticator app
          </button>
        </form>
      );
      break;
    case "recovery":
      title = "Use a recovery code";
      lead = "Each of the recovery codes you saved when you set up two-step verification opens your account once.";
      body = (
        <form
          className="kauro-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const code = String(new FormData(event.currentTarget).get("recovery") ?? "").trim();
            const ok = /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(code);
            setErrors(ok ? [] : [{ fieldId: "signin-recovery", message: "Enter one recovery code, such as REVW-0001." }]);
            if (ok) go("recovered");
          }}
        >
          <Who email={email} onChange={() => go("normal")} change="Change" />
          <ErrorSummary title="Check the recovery code" errors={errors} />
          <Field id="signin-recovery" label="Recovery code" hint="Eight letters and digits, with or without the hyphen." error={errorOf("signin-recovery")}>
            {(control) => <input {...control} name="recovery" autoComplete="one-time-code" spellCheck={false} className="kauro-code-input kauro-code-input--wide" />}
          </Field>
          <Button type="submit" variant="primary">
            <span className="kauro-go">Continue</span>
          </Button>
          <p className="kauro-auth-small">
            No app and no codes? <a href={HELP}>Get help from Kauro</a>. We confirm who you are before two-step verification is reset, and that takes time on purpose.
          </p>
        </form>
      );
      break;
    case "recovered":
      title = "You are signed in";
      lead = undefined;
      body = (
        <div className="kauro-form">
          <Banner tone="warning" title="That recovery code is now used" announce="status">
            <p>You have 9 recovery codes left. Set up your authenticator app again, or create new codes, in your settings.</p>
          </Banner>
          <Button variant="primary" onClick={enter}>
            <span className="kauro-go">Continue</span>
          </Button>
        </div>
      );
      break;
    case "google-new":
      title = "No Kauro account yet";
      lead = undefined;
      body = (
        <div className="kauro-form">
          <Who email="lena.ortiz@gmail.example" />
          <p>No Kauro account uses this Google account. You can create one with it now: you will then set up two-step verification and your workspace.</p>
          <a className="kauro-button kauro-button-primary" href={SIGN_UP}>
            <span className="kauro-go">Create an account with Google</span>
          </a>
          <button type="button" className="kauro-text-button" onClick={() => go("normal")}>
            Sign in another way
          </button>
        </div>
      );
      break;
    case "unverified":
      title = "Verify your email";
      lead = "Your account was created but its email address is not verified yet. We have sent a six-digit code to it.";
      body = (
        <form className="kauro-form" noValidate onSubmit={(event) => checkCode(event, "signin-email-code", () => go("enrol"))}>
          <Who email={email} onChange={() => go("normal")} change="Change" />
          <ErrorSummary title="Check the code" errors={errors} />
          <CodeField id="signin-email-code" label="Code from the email" hint="It works for a short time. Look in spam if it has not arrived." error={errorOf("signin-email-code")} />
          <Button type="submit" variant="primary">
            <span className="kauro-go">Verify email</span>
          </Button>
          <button type="button" className="kauro-text-button" onClick={() => go("unverified")}>
            Send a new code
          </button>
        </form>
      );
      break;
    case "enrol":
      title = "Set up two‑step verification";
      lead = "Kauro asks for a code from an authenticator app every time you sign in, before anyone can see client data. This takes a minute, once.";
      body = (
        <form className="kauro-form" noValidate onSubmit={(event) => checkCode(event, "signin-enrol", () => go("codes"))}>
          <EnrolSteps />
          <ErrorSummary title="Check the code" errors={errors} />
          <CodeField id="signin-enrol" hint="This confirms the app is set up." error={errorOf("signin-enrol")} />
          <Button type="submit" variant="primary">
            <span className="kauro-go">Turn on two-step verification</span>
          </Button>
        </form>
      );
      break;
    case "codes":
      title = "Save your recovery codes";
      lead = "If you lose your authenticator app, each code opens your account once. Keep them somewhere safe: a password manager is a good place.";
      body = (
        <form
          className="kauro-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const kept = new FormData(event.currentTarget).get("kept") !== null;
            setErrors(kept ? [] : [{ fieldId: "signin-kept", message: "Confirm that you have saved the codes." }]);
            if (kept) enter();
          }}
        >
          <RecoveryList />
          <div className="kauro-actions">
            <Button>Download as a text file</Button>
            <Button>Copy</Button>
          </div>
          <ErrorSummary title="Before you continue" errors={errors} />
          <label className="kauro-confirm" id="signin-kept">
            <input type="checkbox" name="kept" />
            <span>I have saved these codes somewhere safe.</span>
          </label>
          <Button type="submit" variant="primary">
            <span className="kauro-go">Continue</span>
          </Button>
        </form>
      );
      break;
    case "locked":
      title = "Sign-in is paused";
      lead = undefined;
      body = (
        <div className="kauro-form">
          <Banner tone="warning" title="Too many attempts" announce="alert">
            <p>To protect the account, sign-in is paused for a few minutes. Try again later.</p>
          </Banner>
          <p>
            If you have forgotten your password, <a href={RESET}>reset it</a>. A reset does not change your two-step verification.
          </p>
        </div>
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
        <>
          {step === "invalid" ? (
            <Banner tone="danger" title="We could not sign you in" announce="alert">
              <p>Check your email address and password and try again. If you created your account with Google, use Continue with Google.</p>
            </Banner>
          ) : null}
          {step === "expired" ? (
            <Banner tone="info" title="Your session ended" announce="status">
              <p>Sign in again to carry on. You will return to Team, in Northwind Data.</p>
            </Banner>
          ) : null}
          <GoogleButton
            onClick={() => {
              setVia("google");
              go("google");
            }}
          />
          <Or />
          <form className="kauro-form" noValidate onSubmit={submitCredentials}>
            <ErrorSummary title="Check these details" errors={errors} />
            <Field id="signin-email" label="Email address" error={errorOf("signin-email")}>
              {(control) => <input {...control} name="email" type="email" autoComplete="username" spellCheck={false} defaultValue={step === "invalid" ? email : ""} />}
            </Field>
            <PasswordField id="signin-password" label="Password" autoComplete="current-password" error={errorOf("signin-password")} aside={<a href={RESET}>Forgot password?</a>} />
            <Button type="submit" variant="primary">
              <span className="kauro-go">Sign in</span>
            </Button>
          </form>
        </>
      );
  }

  const after = ops ? (
    <p>
      Kauro operations is for Kauro&apos;s owner, sellers and staff. Access is by invitation only.
      <br />
      <a href={HELP}>Help signing in</a>
    </p>
  ) : (
    <p>
      New to Kauro? <a href={SIGN_UP}>Create an account</a>
      <br />
      <a href={HELP}>Help signing in</a>
    </p>
  );
  return (
    <AuthFrame title={title} lead={lead} bar={ops ? "Operations" : "Sign in"} after={step === "normal" || step === "invalid" || step === "expired" || step === "locked" || step === "unavailable" ? after : undefined}>
      {body}
    </AuthFrame>
  );
}
