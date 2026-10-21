"use client";
// P-06 Reset password (proposed; the owner's decisions of 2026-10-20: safe recovery, protection against abusive attempts, revocation of
// sessions). The address is asked, a code is sent to it, a new password is set, and every other session ends. The page never says whether
// an address has an account: the same "If ... has a Kauro account" follows every request. A reset never touches two-step verification: the
// next sign-in still asks for Kauro's code. An account created with Google has no Kauro password; its email says so.
import { Banner, Button, ErrorSummary, Field } from "@kauro/ui";
import { type FormEvent, type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { AuthFrame, CodeField, codeOf, PasswordField, SIGN_IN, Who } from "./auth.tsx";

export const P06_STATES: readonly StateDef[] = [
  { key: "normal", label: "Ask for a code", note: "The email address the person signs in with." },
  { key: "sent", label: "Code sent", note: "The same words whether or not the address has an account." },
  { key: "wrong", label: "Code not accepted", note: "A wrong or expired code, with a way to send a new one." },
  { key: "factor", label: "Kauro code", note: "An email alone never changes a password: the person also enters the code of their authenticator app (or a recovery code)." },
  { key: "new", label: "New password", note: "One field with a show switch; no second copy to type." },
  { key: "done", label: "Password changed", note: "Every other session has ended. The next sign-in asks for Kauro's code as always." },
  { key: "limited", label: "Too many requests", note: "Repeated requests pause sending for a while, without naming any account." },
];

const EMAIL = "lena.ortiz@northwind.example";
type Errors = readonly { readonly fieldId: string; readonly message: string }[];

export function ResetPassword({ state }: PrototypeProps): ReactElement {
  const [step, setStep] = useState(state);
  const [errors, setErrors] = useState<Errors>(state === "wrong" ? [{ fieldId: "reset-code", message: "The code is not correct or has expired. Enter the code from the latest email, or send a new one" }] : []);
  const errorOf = (id: string): string | undefined => errors.find((entry) => entry.fieldId === id)?.message;
  const go = (next: string): void => {
    setErrors([]);
    setStep(next);
  };
  const submit = (event: FormEvent<HTMLFormElement>, check: (data: FormData) => { fieldId: string; message: string } | null, next: string): void => {
    event.preventDefault();
    const found = check(new FormData(event.currentTarget));
    setErrors(found === null ? [] : [found]);
    if (found === null) setStep(next);
  };

  let title = "Reset your password";
  let lead: string | undefined = "Enter the email address you sign in with. We will send it a code.";
  let body: ReactElement;
  switch (step) {
    case "sent":
    case "wrong":
      title = "Check your email";
      lead = undefined;
      body = (
        <form className="kauro-form" noValidate onSubmit={(event) => submit(event, (data) => (/^[0-9]{6}$/.test(codeOf(String(data.get("code") ?? ""))) ? null : { fieldId: "reset-code", message: "The code is not correct or has expired. Enter the code from the latest email, or send a new one" }), "factor")}>
          <p>
            If <bdi className="kauro-auth-inline">{EMAIL}</bdi> has a Kauro account, a code is on its way to it.
          </p>
          <ErrorSummary title="There is a problem" errors={errors} />
          <CodeField id="reset-code" label="Code from the email" hint="It works for a short time. Look in spam if it has not arrived." error={errorOf("reset-code")} />
          <Button type="submit" variant="primary">
            <span className="kauro-go">Continue</span>
          </Button>
          <button type="button" className="kauro-text-button" onClick={() => go("sent")}>
            Send a new code
          </button>
        </form>
      );
      break;
    case "factor":
      title = "Enter your Kauro code";
      lead = "An email alone never changes a password. Enter the code your authenticator app shows for Kauro.";
      body = (
        <form className="kauro-form" noValidate onSubmit={(event) => submit(event, (data) => (/^[0-9]{6}$/.test(codeOf(String(data.get("code") ?? ""))) ? null : { fieldId: "reset-factor", message: "Enter the 6-digit code from your authenticator app" }), "new")}>
          <Who email={EMAIL} />
          <ErrorSummary title="There is a problem" errors={errors} />
          <CodeField id="reset-factor" hint="The code changes every 30 seconds." error={errorOf("reset-factor")} />
          <Button type="submit" variant="primary">
            <span className="kauro-go">Continue</span>
          </Button>
          <p className="kauro-auth-small">
            No app and no recovery codes? <a href="/login?review-state=lost">See how to get back in safely</a>
          </p>
        </form>
      );
      break;
    case "new":
      title = "Choose a new password";
      lead = undefined;
      body = (
        <form className="kauro-form" noValidate onSubmit={(event) => submit(event, (data) => (String(data.get("password") ?? "").length >= 12 ? null : { fieldId: "reset-password", message: "Password must be 12 characters or more" }), "done")}>
          <Who email={EMAIL} />
          <ErrorSummary title="There is a problem" errors={errors} />
          <PasswordField id="reset-password" label="New password" autoComplete="new-password" hint="12 characters or more, different from the one before. We check it against passwords exposed in known breaches." error={errorOf("reset-password")} />
          <p className="kauro-auth-small">Changing it signs you out of Kauro everywhere else.</p>
          <Button type="submit" variant="primary">
            <span className="kauro-go">Change password</span>
          </Button>
        </form>
      );
      break;
    case "done":
      title = "Your password is changed";
      lead = undefined;
      body = (
        <div className="kauro-form">
          <Banner tone="success" title="Signed out everywhere else" announce="status">
            <p>Every other session on every device has ended. Sign in with your new password, then your Kauro code.</p>
          </Banner>
          <a className="kauro-button kauro-button-primary" href={SIGN_IN}>
            <span className="kauro-go">Sign in</span>
          </a>
        </div>
      );
      break;
    case "limited":
      title = "Reset your password";
      lead = undefined;
      body = (
        <Banner tone="warning" title="Too many requests" announce="alert">
          <p>To protect accounts, no more codes are sent for a few minutes. Use the latest code you received, or try again later.</p>
        </Banner>
      );
      break;
    default:
      body = (
        <form className="kauro-form" noValidate onSubmit={(event) => submit(event, (data) => (/^\S+@\S+\.\S+$/.test(String(data.get("email") ?? "").trim()) ? null : { fieldId: "reset-email", message: "Enter an email address in the correct format, like name@example.com" }), "sent")}>
          <ErrorSummary title="There is a problem" errors={errors} />
          <Field id="reset-email" label="Email address" error={errorOf("reset-email")}>
            {(control) => <input {...control} name="email" type="email" autoComplete="username" spellCheck={false} />}
          </Field>
          <Button type="submit" variant="primary">
            <span className="kauro-go">Send code</span>
          </Button>
          <p className="kauro-auth-small">A reset does not change your two-step verification. If you signed up with Google, sign in with Google instead.</p>
        </form>
      );
  }
  return (
    <AuthFrame
      title={title}
      lead={lead}
      bar="Reset password"
      after={
        <p>
          <a href={SIGN_IN}>Back to sign in</a>
        </p>
      }
    >
      {body}
    </AuthFrame>
  );
}
