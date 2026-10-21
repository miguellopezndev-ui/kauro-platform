"use client";
// The pieces every identity page shares (Order 11; the owner's decisions of 2026-10-20). Two ways in for V1, Google and email with a strong
// password; after either, Kauro's own second factor, a six-digit code from an authenticator app, which an email never replaces.
//
// The Google button follows Google's sign-in branding: the standard four-colour "G" unaltered, "Continue with Google", white with a #747775
// stroke and #1F1F1F text in the light theme, #131314 with a #8E918F stroke and #E3E3E3 text in the dark one, and never less prominent than
// the other way in. Everything secret on these pages (a setup key, recovery codes, a QR code) is synthetic and says so.
//
// Order 11 revision, from the research (research/auth-onboarding.md; NIST SP 800-63B-4 §8.1, WCAG 2.2 3.3.8, GOV.UK patterns): the window's
// bar names the step instead of drawing a padlock (an icon that imitates the browser's security indicator is advised against); a code field
// is one text input that takes a pasted code with spaces; every page of an identity step ends with the same small footer.
import { Field } from "@kauro/ui";
import { type ReactElement, type ReactNode, useState } from "react";

export const SIGN_IN = "/login";
export const SIGN_UP = "/signup";
export const RESET = "/login/reset";
export const HELP = "/help";
export const PRIVACY = "/legal/privacy";
export const POLICY = "/legal/data-processing-policy";
export const TERMS = "/legal/terms";
export const STATUS = "/status";

/** The page of an identity step: one window, its heading and lead, the step, then the way to the other page. The bar names the step (and
 * where it stands, "step 2 of 2"), or the state of the thing the page is about (an invitation); a verdict may be stamped on the window. */
export function AuthFrame({ title, lead, bar, step, state, stateTone = "neutral", stamp, children, after }: { readonly title: ReactNode; readonly lead?: ReactNode; readonly bar: string; readonly step?: string; readonly state?: string; readonly stateTone?: "neutral" | "done" | "attention"; readonly stamp?: string | null; readonly children: ReactNode; readonly after?: ReactNode }): ReactElement {
  return (
    <div className="kauro-auth">
      <div className="kauro-auth-object">
        <section className="kauro-window kauro-auth-window" aria-labelledby="auth-title">
          <div className="kauro-window-bar">
            <span className="kauro-window-brand">Kauro</span>
            <span className="kauro-window-title">{bar}</span>
            {state !== undefined ? <span className={`kauro-window-state kauro-window-state--${stateTone}`}>{state}</span> : step === undefined ? null : <span className="kauro-auth-step-count">{step}</span>}
          </div>
          <div className="kauro-window-body kauro-auth-body">
            <h1 id="auth-title">{title}</h1>
            {lead === undefined ? null : <p className="kauro-auth-lead">{lead}</p>}
            <div className="kauro-auth-step" aria-live="polite">
              {children}
            </div>
          </div>
        </section>
        {stamp === undefined || stamp === null ? null : (
          <p className="kauro-stamp kauro-auth-stamp" aria-hidden="true">
            {stamp}
          </p>
        )}
      </div>
      {after === undefined ? null : <div className="kauro-auth-after">{after}</div>}
      <AuthFooter />
    </div>
  );
}

/** The same quiet footer under every identity step: what governs the account, where to get help, whether the service is up. */
export function AuthFooter(): ReactElement {
  return (
    <nav className="kauro-auth-footer" aria-label="Kauro">
      <a href={PRIVACY}>Privacy notice</a>
      <a href={TERMS}>Terms</a>
      <a href={HELP}>Help</a>
      <a href={STATUS}>Service status</a>
    </nav>
  );
}

/** Google's standard "G", in its four colours, as Google publishes it for sign-in buttons. */
function GoogleMark(): ReactElement {
  return (
    <svg className="kauro-google-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** "Continue with Google": in the review it stands for the round trip to Google and back. */
export function GoogleButton({ onClick }: { readonly onClick: () => void }): ReactElement {
  return (
    <button type="button" className="kauro-google" onClick={onClick}>
      <GoogleMark />
      <span>Continue with Google</span>
    </button>
  );
}

/** The quiet line between the two ways in. */
export function Or(): ReactElement {
  return (
    <p className="kauro-auth-or" role="separator" aria-label="or">
      <span aria-hidden="true">or</span>
    </p>
  );
}

/** A password field with a show and hide switch, for the browser's and the password manager's own handling. */
export function PasswordField({ id, label, hint, error, autoComplete, aside }: { readonly id: string; readonly label: string; readonly hint?: ReactNode; readonly error?: string | undefined; readonly autoComplete: "current-password" | "new-password"; readonly aside?: ReactNode }): ReactElement {
  const [shown, setShown] = useState(false);
  return (
    <div className="kauro-auth-password">
      {aside === undefined ? null : <span className="kauro-auth-password-aside">{aside}</span>}
      <Field id={id} label={label} hint={hint} error={error}>
        {(control) => (
          <span className="kauro-password">
            <input {...control} name="password" type={shown ? "text" : "password"} autoComplete={autoComplete} spellCheck={false} />
            <button type="button" className="kauro-password-toggle" aria-pressed={shown} aria-controls={id} onClick={() => setShown((value) => !value)}>
              {shown ? "Hide" : "Show"}
            </button>
          </span>
        )}
      </Field>
    </div>
  );
}

/** The six digits of an authenticator app (or of an email, where the page says so): one field that takes a pasted code, spaces included. */
export function CodeField({ id, label = "Six-digit code", hint, error }: { readonly id: string; readonly label?: string; readonly hint?: ReactNode; readonly error?: string | undefined }): ReactElement {
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      {(control) => <input {...control} name="code" inputMode="numeric" autoComplete="one-time-code" spellCheck={false} autoCapitalize="off" className="kauro-code-input" />}
    </Field>
  );
}

/**
 * The authorisation a registration needs (Data Processing Policy §8.1; internal data manual §5.3 A-01): prior, express and informed, by an
 * unticked checkbox with links to the Policy and the Privacy notice, its version and time kept as proof. Commercial messages are a
 * separate, optional, unticked choice (A-14).
 */
export function RegistrationConsent({ error }: { readonly error?: string | undefined }): ReactElement {
  return (
    <div className="kauro-auth-consent">
      {error === undefined ? null : (
        <p className="kauro-auth-consent-error" id="signup-consent-error">
          {error}
        </p>
      )}
      <label className="kauro-confirm" id="signup-consent">
        <input type="checkbox" name="consent" aria-describedby={error === undefined ? undefined : "signup-consent-error"} />
        <span>
          I authorise Kauro to process my personal data to run my account, as the <a href={POLICY}>Data processing policy</a> and the <a href={PRIVACY}>Privacy notice</a> explain.
        </span>
      </label>
      <label className="kauro-confirm kauro-confirm--optional">
        <input type="checkbox" name="news" />
        <span>Optional: send me occasional news about Kauro. I can stop it at any time.</span>
      </label>
    </div>
  );
}

/** A code's six digits, read the way people paste them ("123 456", "123-456"). */
export const codeOf = (raw: string): string => raw.replace(/[\s-]/g, "");

/** The account a step is about, with the way out of it. */
export function Who({ email, onChange, change = "Change" }: { readonly email: string; readonly onChange?: () => void; readonly change?: string }): ReactElement {
  return (
    <p className="kauro-auth-who">
      <bdi>{email}</bdi>
      {onChange === undefined ? null : (
        <button type="button" className="kauro-text-button" onClick={onChange}>
          {change}
        </button>
      )}
    </p>
  );
}

// A synthetic QR code: the three finder squares and a fixed scatter of modules. It is drawn so the step can be seen; it does not scan.
const SIZE = 25;
function modules(): readonly (readonly [number, number])[] {
  const cells: [number, number][] = [];
  let seed = 7;
  const finder = (x: number, y: number): boolean => (x < 8 && y < 8) || (x >= SIZE - 8 && y < 8) || (x < 8 && y >= SIZE - 8);
  for (let y = 0; y < SIZE; y += 1)
    for (let x = 0; x < SIZE; x += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      if (!finder(x, y) && seed % 100 < 46) cells.push([x, y]);
    }
  return cells;
}
const CELLS = modules();
function FinderSquare({ x, y }: { readonly x: number; readonly y: number }): ReactElement {
  return (
    <g>
      <rect x={x} y={y} width="7" height="7" />
      <rect x={x + 1} y={y + 1} width="5" height="5" className="kauro-qr-gap" />
      <rect x={x + 2} y={y + 2} width="3" height="3" />
    </g>
  );
}
export function SyntheticQr(): ReactElement {
  return (
    <figure className="kauro-qr">
      <svg viewBox={`-2 -2 ${SIZE + 4} ${SIZE + 4}`} aria-hidden="true" focusable="false">
        <rect x="-2" y="-2" width={SIZE + 4} height={SIZE + 4} className="kauro-qr-gap" />
        <FinderSquare x={0} y={0} />
        <FinderSquare x={SIZE - 7} y={0} />
        <FinderSquare x={0} y={SIZE - 7} />
        {CELLS.map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" />
        ))}
      </svg>
      <figcaption>Synthetic, for review: it does not scan.</figcaption>
    </figure>
  );
}

/** Setting up Kauro's second factor: scan, or type the key, then prove it with the first code. */
export function EnrolSteps(): ReactElement {
  return (
    <div className="kauro-enrol">
      <SyntheticQr />
      <ol className="kauro-enrol-steps">
        <li>Open your authenticator app (for example Google Authenticator, Microsoft Authenticator or 1Password) and add an account.</li>
        <li>
          Scan this code. If you cannot scan it, type this key instead: <code className="kauro-secret">REVW SYNT HETI CXXX</code>
        </li>
        <li>Enter the six-digit code the app shows for Kauro.</li>
      </ol>
    </div>
  );
}

/** The recovery codes, shown once at enrolment: each opens the account once if the authenticator app is lost. */
export const RECOVERY_CODES = ["RVW7-K2QM-9DXW-4TPL", "RVWA-6N3H-8JCY-2ZFE", "RVWQ-5MBT-7KLR-9WDS", "RVW3-XPV8-4HNG-6CJA", "RVWM-2DTY-9QEK-5LWB", "RVW9-HJ4C-7ZSN-3PXF", "RVWE-8GKW-2MVD-6RTQ", "RVW6-LCBN-5YXJ-8HSK", "RVWT-3WQP-7FDA-4MZG", "RVW2-9KRE-6NHX-5CBV"] as const;
export function RecoveryList(): ReactElement {
  return (
    <div className="kauro-recovery">
      <ol className="kauro-recovery-codes" aria-label="Recovery codes">
        {RECOVERY_CODES.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ol>
      <p className="kauro-auth-small">Synthetic codes, for review. Real codes are shown once, here; each works once.</p>
    </div>
  );
}
