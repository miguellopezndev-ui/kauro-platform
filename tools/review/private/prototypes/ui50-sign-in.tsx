"use client";
// UI50 Sign in (registry: "Continue securely."). BLOCKED EXTERNAL: the identity provider is not connected (W-IDP-LIVE; which provider is
// open, research/kauro-baseline.md Q-8), so the real page can only say sign-in is not available. This is the design for the owner's decisions
// of 2026-10-20:
//   - two ways in, Google and email with a password, Google first and never less prominent ("Continue with Google", Google's branding);
//   - after either, Kauro's own six-digit code from an authenticator app, never replaced by an email; the bar says which step of two;
//   - an unverified email or an account without two-step verification finishes those steps before any private data;
//   - a failure never says whether an account exists, and repeated attempts pause sign-in, saying until when;
//   - a lost authenticator: a recovery code first; with the codes lost too, a member asks an admin of the workspace to START a recovery
//     (an admin can never turn the factor off or let anyone in), and an owner, a privileged admin or a person with no other admin asks Kauro
//     for a reinforced recovery with independent checks and a person's approval; a waiting period proportional to the risk applies, and
//     without reliable evidence the page says safe recovery is not possible and names the legitimate ways on;
//   - "Create an account" only on the customer application. The operations sign-in (owner, sellers) is by invitation.
// After sign-in the person returns only to an application path (safeReturnPath). Research: research/auth-onboarding.md (GitHub's "More
// options" route to recovery, GOV.UK's code and error patterns, OWASP's generic messages).
import { Banner, Button, ErrorSummary, Field } from "@kauro/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactElement, useState } from "react";
import { asHref } from "../lib/links.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { AuthFrame, CodeField, codeOf, EnrolSteps, GoogleButton, HELP, Or, PasswordField, RecoveryList, RESET, SIGN_UP, Who } from "./auth.tsx";

export const UI50_STATES: readonly StateDef[] = [
  { key: "normal", label: "Sign in", note: "Google first, then email and password; the lead says the Kauro code comes next. The password goes to the identity provider." },
  { key: "invalid", label: "Wrong details", note: "One message for every failure: it never says whether an account exists." },
  { key: "code", label: "Kauro code", note: "Step 2 of 2: the six-digit code of the person's authenticator app; a pasted code with spaces is accepted." },
  { key: "google", label: "Back from Google", note: "Google has said who the person is; Kauro still asks for its own code, and says why." },
  { key: "google-new", label: "Google account without Kauro", note: "The Google account has no Kauro account: the person may create one with it." },
  { key: "recovery", label: "Recovery code", note: "The authenticator app is not at hand: one recovery code opens the account once." },
  { key: "lost", label: "Lost the app and the codes", note: "The two safe ways on: an admin of the workspace starts the recovery, or Kauro does, for an owner or a person with no other admin." },
  { key: "kauro-recovery", label: "Recovery through Kauro", note: "For an owner or a person with no other admin: what Kauro checks, who approves, and that a waiting period applies." },
  { key: "pending", label: "Recovery under way", note: "A recovery is requested: its waiting period, who was told, and how to cancel it if it was not you." },
  { key: "impossible", label: "Cannot be recovered safely", note: "Without reliable evidence of identity and authority, access is not restored; the page names the legitimate ways on." },
  { key: "unverified", label: "Email not verified", note: "An account that never verified its email: a code is sent, then two-step verification." },
  { key: "enrol", label: "Set up two-step verification", note: "An account without two-step verification sets it up before any private data." },
  { key: "codes", label: "Recovery codes", note: "Shown once, right after the code is confirmed; the person confirms they saved them." },
  { key: "locked", label: "Too many attempts", note: "Repeated failures pause sign-in until a stated time; the message names no account." },
  { key: "expired", label: "Session ended", note: "A session that ended sends the person here, and back to the same page after signing in." },
  { key: "unavailable", label: "Provider not connected (today)", note: "What the real page shows until the identity provider is connected (W-IDP-LIVE)." },
  { key: "ops", label: "Operations sign-in", note: "The same page on the operations address, for the Kauro owner and sellers: no sign-up, access by invitation." },
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
    if (String(data.get("email") ?? "").trim() === "") found.push({ fieldId: "signin-email", message: "Enter your email address" });
    if (String(data.get("password") ?? "") === "") found.push({ fieldId: "signin-password", message: "Enter your password" });
    setErrors(found);
    if (found.length === 0) {
      setVia("password");
      setStep("code");
    }
  };
  const checkCode = (event: FormEvent<HTMLFormElement>, id: string, then: () => void, empty = "Enter the 6-digit code from your authenticator app"): void => {
    event.preventDefault();
    const code = codeOf(String(new FormData(event.currentTarget).get("code") ?? ""));
    const message = code === "" ? empty : /^[0-9]{6}$/.test(code) ? null : "The code must be 6 digits";
    setErrors(message === null ? [] : [{ fieldId: id, message }]);
    if (message === null) then();
  };

  let title = "Sign in to Kauro";
  let lead: string | undefined = "With Google, or your email and password. Then Kauro asks for the code from your authenticator app.";
  let bar = ops ? "Operations sign-in" : "Sign in";
  let stepLabel: string | undefined = "Step 1 of 2";
  let body: ReactElement;
  switch (step) {
    case "code":
    case "google":
      title = "Enter your Kauro code";
      lead = "Open your authenticator app and enter the code it shows for Kauro.";
      stepLabel = "Step 2 of 2";
      body = (
        <form className="kauro-form" noValidate onSubmit={(event) => checkCode(event, "signin-code", enter)}>
          <Who email={email} onChange={() => go("normal")} change="Not you?" />
          {via === "google" || step === "google" ? (
            <p className="kauro-auth-small">Google confirmed this address. Kauro asks for its own code too, because your workspace may hold your clients&apos; data.</p>
          ) : null}
          <ErrorSummary title="There is a problem" errors={errors} />
          <CodeField id="signin-code" hint="The code changes every 30 seconds." error={errorOf("signin-code")} />
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
      lead = "Each recovery code you saved when you set up two-step verification opens your account once.";
      stepLabel = "Step 2 of 2";
      body = (
        <form
          className="kauro-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const code = String(new FormData(event.currentTarget).get("recovery") ?? "").trim();
            const message = code === "" ? "Enter a recovery code" : /^[A-Za-z0-9]{16}$/.test(code.replace(/[\s-]/g, "")) ? null : "A recovery code is 16 letters and digits, like RVW7-K2QM-9DXW-4TPL";
            setErrors(message === null ? [] : [{ fieldId: "signin-recovery", message }]);
            if (message === null) go("recovered");
          }}
        >
          <Who email={email} onChange={() => go("normal")} change="Not you?" />
          <ErrorSummary title="There is a problem" errors={errors} />
          <Field id="signin-recovery" label="Recovery code" hint="With or without the hyphen." error={errorOf("signin-recovery")}>
            {(control) => <input {...control} name="recovery" autoComplete="one-time-code" spellCheck={false} autoCapitalize="characters" className="kauro-code-input kauro-code-input--wide" />}
          </Field>
          <Button type="submit" variant="primary">
            <span className="kauro-go">Continue</span>
          </Button>
          <button type="button" className="kauro-text-button" onClick={() => go("lost")}>
            I have lost my recovery codes too
          </button>
        </form>
      );
      break;
    case "recovered":
      title = "You are signed in";
      lead = undefined;
      stepLabel = undefined;
      body = (
        <div className="kauro-form">
          <Banner tone="warning" title="That recovery code is now used" announce="status">
            <p>9 recovery codes are left. Set up your authenticator app again, or create new codes, in your settings. We have emailed you that a recovery code was used.</p>
          </Banner>
          <Button variant="primary" onClick={enter}>
            <span className="kauro-go">Continue</span>
          </Button>
        </div>
      );
      break;
    case "lost":
      title = "Getting back in without your app or codes";
      lead = "Nobody can turn two-step verification off for you. A recovery checks who you are first, and takes time on purpose.";
      bar = "Recovery";
      stepLabel = undefined;
      body = (
        <div className="kauro-form">
          <div className="kauro-recover-ways">
            <section className="kauro-recover-way" aria-labelledby="way-admin">
              <h2 id="way-admin">Someone else in your workspace is an owner or admin</h2>
              <p>Ask them to start your recovery from Team. Kauro then checks who you are, independently of this account, before you set up two-step verification again.</p>
            </section>
            <section className="kauro-recover-way" aria-labelledby="way-kauro">
              <h2 id="way-kauro">You are an owner, or nobody else can help</h2>
              <p>Ask Kauro for a recovery. A person at Kauro reviews the checks and approves it.</p>
              <Button onClick={() => go("kauro-recovery")}>
                <span className="kauro-go">Ask Kauro for a recovery</span>
              </Button>
            </section>
          </div>
          <p className="kauro-auth-small">Kauro never recovers an account by email, password or a support message alone, and never uses security questions or text messages.</p>
        </div>
      );
      break;
    case "kauro-recovery":
      title = "Ask Kauro for a recovery";
      lead = "For an owner of a workspace, or a person with no other owner or admin to start it.";
      bar = "Recovery";
      stepLabel = undefined;
      body = (
        <form
          className="kauro-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            go("pending");
          }}
        >
          <Field id="recover-email" label="Email address of the account">
            {(control) => <input {...control} name="email" type="email" autoComplete="email" spellCheck={false} defaultValue={email} />}
          </Field>
          <Field id="recover-workspace" label="Workspace" hint="The name of your agency or company in Kauro.">
            {(control) => <input {...control} name="workspace" defaultValue="Northwind Data" />}
          </Field>
          <div className="kauro-recover-what">
            <h2>What happens next</h2>
            <ol>
              <li>Kauro checks who you are with evidence independent of this account, and your authority over the workspace.</li>
              <li>A person at Kauro reviews the checks. Nothing is automatic.</li>
              <li>A waiting period, set by the risk, starts. Every owner and admin of the workspace is told, and can stop it.</li>
              <li>Then you set up two-step verification again, and every other session of the account ends.</li>
            </ol>
          </div>
          <Button type="submit" variant="primary">
            <span className="kauro-go">Request the recovery</span>
          </Button>
          <p className="kauro-proposed">Proposed — recovery needs the identity provider and its abuse tests (F-07)</p>
        </form>
      );
      break;
    case "pending":
      title = "Your recovery is under way";
      lead = undefined;
      bar = "Recovery";
      stepLabel = undefined;
      body = (
        <div className="kauro-form">
          <Banner tone="info" title="Requested on 20 Oct 2026 at 16:05 UTC" announce="status">
            <p>Kauro is checking who you are. Every owner and admin of Northwind Data has been told by email, and can stop the recovery from that email.</p>
          </Banner>
          <dl className="kauro-recover-facts">
            <div>
              <dt>Identity check</dt>
              <dd>In progress; Kauro writes to you if it needs anything</dd>
            </div>
            <div>
              <dt>Waiting period</dt>
              <dd>Starts when the check is approved; its end is shown here</dd>
            </div>
            <div>
              <dt>Your sessions</dt>
              <dd>Every session of the account will end when the recovery completes</dd>
            </div>
          </dl>
          <p className="kauro-auth-small">Did not ask for this? Use the link in the email to stop it, and change your password.</p>
        </div>
      );
      break;
    case "impossible":
      title = "This account cannot be recovered safely";
      lead = undefined;
      bar = "Recovery";
      stepLabel = undefined;
      body = (
        <div className="kauro-form">
          <Banner tone="warning" title="Kauro could not confirm who you are or your authority over the workspace" announce="alert">
            <p>Restoring access without that would put your clients&apos; data at risk, so access stays closed. Nothing in the workspace has changed.</p>
          </Banner>
          <h2 className="kauro-auth-subhead">What you can do</h2>
          <ul className="kauro-auth-list">
            <li>If another owner or admin can confirm you, ask them to invite you again with a new account.</li>
            <li>If you can provide other evidence of who you are, reply to Kauro&apos;s email; the review starts again.</li>
            <li>The workspace&apos;s files stay protected and are deleted on their usual schedule.</li>
          </ul>
        </div>
      );
      break;
    case "google-new":
      title = "No Kauro account yet";
      lead = undefined;
      stepLabel = undefined;
      body = (
        <div className="kauro-form">
          <Who email="lena.ortiz@gmail.example" />
          <p>No Kauro account uses this Google account. You can create one with it now; you then set up two-step verification and explore an example before giving anything else.</p>
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
      title = "Check your email";
      lead = "Your account's email address is not verified yet. We have sent a six-digit code to it.";
      stepLabel = undefined;
      body = (
        <form className="kauro-form" noValidate onSubmit={(event) => checkCode(event, "signin-email-code", () => go("enrol"), "Enter the 6-digit code from the email")}>
          <Who email={email} onChange={() => go("normal")} change="Not you?" />
          <ErrorSummary title="There is a problem" errors={errors} />
          <CodeField id="signin-email-code" label="Code from the email" hint="It expires after a short time. Look in spam if it has not arrived." error={errorOf("signin-email-code")} />
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
      lead = "Kauro asks for a code from an authenticator app every time you sign in, also with Google, before anyone can see client data. This takes a minute, once.";
      bar = "Two-step verification";
      stepLabel = undefined;
      body = (
        <form className="kauro-form" noValidate onSubmit={(event) => checkCode(event, "signin-enrol", () => go("codes"))}>
          <EnrolSteps />
          <ErrorSummary title="There is a problem" errors={errors} />
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
      bar = "Two-step verification";
      stepLabel = undefined;
      body = (
        <form
          className="kauro-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const kept = new FormData(event.currentTarget).get("kept") !== null;
            setErrors(kept ? [] : [{ fieldId: "signin-kept", message: "Confirm that you have saved the codes" }]);
            if (kept) enter();
          }}
        >
          <RecoveryList />
          <div className="kauro-actions">
            <Button>Download</Button>
            <Button>Copy</Button>
            <Button>Print</Button>
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
            <p>To protect the account, sign-in is paused until 16:20 UTC. You can try again then.</p>
          </Banner>
          <p>
            Forgotten your password? <a href={RESET}>Reset it</a>. A reset keeps your two-step verification.
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
      if (ops) lead = "With Google, or your email and password, then your Kauro code. For Kauro's owner and sellers.";
      body = (
        <>
          {step === "invalid" ? (
            <Banner tone="danger" title="We could not sign you in" announce="alert">
              <p>Check your email address and password and try again. If you created your account with Google, use Continue with Google.</p>
            </Banner>
          ) : null}
          {step === "expired" ? (
            <Banner tone="info" title="Your session ended" announce="status">
              <p>For your clients&apos; safety a session ends after 30 minutes without activity, or 12 hours after signing in. Sign in again to return to Team, in Northwind Data.</p>
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
            <ErrorSummary title="There is a problem" errors={errors} />
            <Field id="signin-email" label="Email address" error={errorOf("signin-email")}>
              {(control) => <input {...control} name="email" type="email" autoComplete="username" spellCheck={false} defaultValue={step === "invalid" ? email : ""} />}
            </Field>
            <PasswordField id="signin-password" label="Password" autoComplete="current-password" error={errorOf("signin-password")} aside={<a href={RESET}>Forgot your password?</a>} />
            <Button type="submit" variant="primary">
              <span className="kauro-go">Sign in</span>
            </Button>
          </form>
        </>
      );
  }

  const after = ops ? (
    <p>Kauro operations is for Kauro&apos;s owner and sellers. Access is by invitation only.</p>
  ) : (
    <p>
      New to Kauro? <a href={SIGN_UP}>Create an account</a>
    </p>
  );
  const first = step === "normal" || step === "invalid" || step === "expired" || step === "locked" || step === "unavailable";
  return (
    <AuthFrame title={title} lead={lead} bar={bar} {...(stepLabel === undefined ? {} : { step: stepLabel })} after={first ? after : undefined}>
      {body}
    </AuthFrame>
  );
}
