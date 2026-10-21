"use client";
// P-05 Create account (proposed; the owner's decisions of 2026-10-20, as corrected the same day): public, self-serve sign-up with any
// Google account, a personal one included, or any email address and a strong password. No business domain is asked for. The person starts
// as themself; the agency or company is set up later, when they want to upload real files (UI09). The order is fixed:
//   1. the account: Google, or full name, email and a password of 12 characters or more, checked against passwords exposed in known
//      breaches, with no composition rules (the owner's rule; NIST SP 800-63B-4 §3.1.1.2);
//   2. a verified email, by a six-digit code (Google has verified it already);
//   3. Kauro's own two-step verification, then the recovery codes, shown once;
//   4. the welcome (UI10 with no workspace): explore a synthetic example, or set up the agency or company.
// Whether the buyer is an agency or a company is asked in the setup, not here: no reference product asks it on the sign-up form. An email
// domain never joins anyone to an agency (UI09). Sign-up never grants seller, staff or owner access: those come by invitation.
//
// A sign-up with an address that already has an account goes on to "Check your email" all the same, and the email says to sign in instead,
// so the page never tells a stranger which addresses have accounts.
//
// The layout is the form in the product's window, beside the path from here to the first project (Clay and Attio set a panel beside the
// form): the path moves on as the person does.
import { Button, ErrorSummary, Field } from "@kauro/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactElement, useState } from "react";
import { asHref } from "../lib/links.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { AuthFrame, CodeField, codeOf, EnrolSteps, GoogleButton, Or, PasswordField, RecoveryList, RegistrationConsent, SIGN_IN, Who } from "./auth.tsx";
import { Note, type RingState, Rings } from "./kit.tsx";

export const P05_STATES: readonly StateDef[] = [
  { key: "normal", label: "Create account", note: "Google first, then full name, email and password in one form. Any address works, personal or work." },
  { key: "invalid", label: "Details not accepted", note: "Each problem beside its field and in a summary: an empty name, an address that is not an email, a short password." },
  { key: "breached", label: "Password found in a breach", note: "The password appears in a known data breach: the person chooses another, and is told why." },
  { key: "google", label: "Back from Google", note: "Google has given the name and a verified address; the person confirms and goes straight to two-step verification." },
  { key: "verify", label: "Check your email", note: "A six-digit code was sent. The same screen appears when the address already has an account: the email then says to sign in." },
  { key: "verify-wrong", label: "Code not accepted", note: "A wrong or expired code: the person may send a new one." },
  { key: "enrol", label: "Two-step verification", note: "Kauro's own second factor, required before any private data, also after Google." },
  { key: "codes", label: "Recovery codes", note: "Shown once. The person confirms they have kept them, then arrives at the welcome." },
];

const STEPS = [
  { key: "account", name: "Your account", fact: "Name, email and password, or Google" },
  { key: "email", name: "Your email", fact: "A six-digit code" },
  { key: "mfa", name: "Two-step verification", fact: "Your authenticator app" },
  { key: "workspace", name: "Your agency or company", fact: "When you want to upload real files" },
  { key: "project", name: "Your first project", fact: "The free data health check" },
] as const;
const AT: Readonly<Record<string, number>> = { normal: 0, invalid: 0, breached: 0, google: 0, verify: 1, "verify-wrong": 1, enrol: 2, codes: 2 };

type Errors = readonly { readonly fieldId: string; readonly message: string }[];

export function SignUp({ state }: PrototypeProps): ReactElement {
  const router = useRouter();
  const [step, setStep] = useState(state);
  const [google, setGoogle] = useState(state === "google");
  const [errors, setErrors] = useState<Errors>(
    state === "invalid"
      ? [
          { fieldId: "signup-name", message: "Enter your full name" },
          { fieldId: "signup-email", message: "Enter an email address in the correct format, like name@example.com" },
          { fieldId: "signup-password", message: "Password must be 12 characters or more" },
          { fieldId: "signup-consent", message: "Authorise the processing of your personal data to create an account" },
        ]
      : state === "breached"
        ? [{ fieldId: "signup-password", message: "This password appears in a known data breach, so it is easy to guess. Choose a different one" }]
        : state === "verify-wrong"
          ? [{ fieldId: "signup-email-code", message: "The code is not correct or has expired. Enter the code from the latest email, or send a new one" }]
          : [],
  );
  const errorOf = (id: string): string | undefined => errors.find((entry) => entry.fieldId === id)?.message;
  const go = (next: string): void => {
    setErrors([]);
    setStep(next);
  };
  const at = AT[step] ?? 0;

  const submitAccount = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const found: { fieldId: string; message: string }[] = [];
    if (String(data.get("name") ?? "").trim() === "") found.push({ fieldId: "signup-name", message: "Enter your full name" });
    if (!/^\S+@\S+\.\S+$/.test(String(data.get("email") ?? "").trim())) found.push({ fieldId: "signup-email", message: "Enter an email address in the correct format, like name@example.com" });
    if (String(data.get("password") ?? "").length < 12) found.push({ fieldId: "signup-password", message: "Password must be 12 characters or more" });
    if (data.get("consent") === null) found.push({ fieldId: "signup-consent", message: "Authorise the processing of your personal data to create an account" });
    setErrors(found);
    if (found.length === 0) setStep("verify");
  };
  const checkCode = (event: FormEvent<HTMLFormElement>, id: string, message: string, then: () => void): void => {
    event.preventDefault();
    const ok = /^[0-9]{6}$/.test(codeOf(String(new FormData(event.currentTarget).get("code") ?? "")));
    setErrors(ok ? [] : [{ fieldId: id, message }]);
    if (ok) then();
  };

  let title = "Create your Kauro account";
  let lead: string | undefined = "Start with your own account. You set up your agency or company when you are ready to upload files.";
  let body: ReactElement;
  switch (step) {
    case "google":
      title = "Create your account with Google";
      lead = undefined;
      body = (
        <form
          className="kauro-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            go("enrol");
          }}
        >
          <Who email="ana.silva@gmail.example" onChange={() => go("normal")} change="Change" />
          <Field id="signup-google-name" label="Full name" hint="As Google gave it. You can change it.">
            {(control) => <input {...control} name="name" autoComplete="name" defaultValue="Ana Silva" />}
          </Field>
          <RegistrationConsent />
          <p className="kauro-auth-small">Google has verified this address. Next, Kauro asks for its own two-step verification.</p>
          <Button type="submit" variant="primary">
            <span className="kauro-go">Continue</span>
          </Button>
        </form>
      );
      break;
    case "verify":
    case "verify-wrong":
      title = "Check your email";
      lead = "We sent a six-digit code to the address below. Enter it to confirm the address is yours.";
      body = (
        <form className="kauro-form" noValidate onSubmit={(event) => checkCode(event, "signup-email-code", "The code is not correct or has expired. Enter the code from the latest email, or send a new one", () => go("enrol"))}>
          <Who email="ana.silva@gmail.example" onChange={() => go("normal")} change="Change" />
          <ErrorSummary title="There is a problem" errors={errors} />
          <CodeField id="signup-email-code" label="Code from the email" hint="It works for a short time. Look in spam if it has not arrived." error={errorOf("signup-email-code")} />
          <Button type="submit" variant="primary">
            <span className="kauro-go">Verify email</span>
          </Button>
          <button type="button" className="kauro-text-button" onClick={() => go("verify")}>
            Send a new code
          </button>
        </form>
      );
      break;
    case "enrol":
      title = "Set up two‑step verification";
      lead = google
        ? "Google has confirmed who you are. Kauro also asks for a code from an authenticator app every time you sign in, before anyone can see client data."
        : "Kauro asks for a code from an authenticator app every time you sign in, before anyone can see client data. This takes a minute, once.";
      body = (
        <form className="kauro-form" noValidate onSubmit={(event) => checkCode(event, "signup-enrol", "The code must be the 6 digits your app shows now; it changes every 30 seconds", () => go("codes"))}>
          <EnrolSteps />
          <ErrorSummary title="There is a problem" errors={errors} />
          <CodeField id="signup-enrol" hint="This confirms the app is set up." error={errorOf("signup-enrol")} />
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
            setErrors(kept ? [] : [{ fieldId: "signup-kept", message: "Confirm that you have saved the codes" }]);
            if (kept) router.push(asHref("newcomer"));
          }}
        >
          <RecoveryList />
          <div className="kauro-actions">
            <Button>Download</Button>
            <Button>Copy</Button>
            <Button>Print</Button>
          </div>
          <ErrorSummary title="Before you continue" errors={errors} />
          <label className="kauro-confirm" id="signup-kept">
            <input type="checkbox" name="kept" />
            <span>I have saved these codes somewhere safe.</span>
          </label>
          <Button type="submit" variant="primary">
            <span className="kauro-go">Continue</span>
          </Button>
        </form>
      );
      break;
    default:
      body = (
        <>
          <GoogleButton
            onClick={() => {
              setGoogle(true);
              go("google");
            }}
          />
          <Or />
          <form className="kauro-form" noValidate onSubmit={submitAccount}>
            <ErrorSummary title="There is a problem" errors={errors} />
            <Field id="signup-name" label="Full name" error={errorOf("signup-name")}>
              {(control) => <input {...control} name="name" autoComplete="name" defaultValue={step === "breached" ? "Ana Silva" : ""} />}
            </Field>
            <Field id="signup-email" label="Email address" hint="Any address: personal or work." error={errorOf("signup-email")}>
              {(control) => <input {...control} name="email" type="email" autoComplete="email" spellCheck={false} defaultValue={step === "invalid" ? "ana.silva@gmail" : step === "breached" ? "ana.silva@gmail.example" : ""} />}
            </Field>
            <PasswordField id="signup-password" label="Create a password" autoComplete="new-password" hint="12 characters or more. A phrase of a few words works well. We check it against passwords exposed in known breaches." error={errorOf("signup-password")} />
            <RegistrationConsent error={errorOf("signup-consent")} />
            <Button type="submit" variant="primary">
              <span className="kauro-go">Create account</span>
            </Button>
            <p className="kauro-auth-small">The service terms and the data processing terms are accepted later, by your agency or company, before any real file.</p>
          </form>
        </>
      );
  }

  const ringState = (index: number): RingState => (index < at ? "done" : index === at ? "current" : "waiting");
  return (
    <div className="kauro-signup">
      <AuthFrame
        title={title}
        lead={lead}
        bar="Create account"
        after={
          at === 0 ? (
            <p>
              Already have an account? <a href={SIGN_IN}>Sign in</a>
            </p>
          ) : undefined
        }
      >
        {body}
      </AuthFrame>
      <aside className="kauro-signup-path" aria-labelledby="signup-path-h">
        <h2 id="signup-path-h">From here to your first project</h2>
        <Rings items={STEPS.map((item, index) => ({ key: item.key, name: item.name, fact: item.fact, state: ringState(index) }))} />
        <Note>The free check asks for no card. After it you see an estimate; the formal quote comes once you approve the plan, and you can leave it there.</Note>
      </aside>
    </div>
  );
}

