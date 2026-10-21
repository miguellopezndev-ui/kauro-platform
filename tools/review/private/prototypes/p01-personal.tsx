"use client";
// P-01 Personal settings (proposed; Order 11 §4 A). One page per person, the same in every agency. Built only from what exists where it
// can be: the theme is the application's own control (POST /preferences/theme), two-step verification and the session's limits come from
// the session (getCurrentSession: mfaAt, idleExpiresAt, absoluteExpiresAt), signing out is the real sign-out. The profile read, the
// sign-in methods, recovery codes, other sessions and notices have no contract: each is marked as proposed. Two-step verification cannot
// be turned off (the owner's decision of 2026-10-20). No password, code or secret appears here, ever: a new set of recovery codes is shown
// once, at the moment it is made, and never again.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement, useEffect, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { RecoveryList } from "./auth.tsx";
import { Badge, Facts, PageHead, ScreenLink } from "./kit.tsx";

export const P01_STATES: readonly StateDef[] = [
  { key: "normal", label: "Personal settings", note: "Every section with the person's synthetic data." },
  { key: "signed-out", label: "Other sessions ended", note: "After signing out of every other session: only this one is left." },
  { key: "new-codes", label: "New recovery codes", note: "After confirming identity again: the new set is shown once, and the old codes stop working." },
  { key: "saved", label: "Notices saved", note: "After saving notice choices (proposed)." },
];

const NOTICES = [
  { id: "check", label: "A free data health check is ready", on: true },
  { id: "approval", label: "A plan is waiting for my approval", on: true },
  { id: "payment", label: "A payment is confirmed", on: false },
  { id: "package", label: "A package is ready to download", on: true },
  { id: "team", label: "Someone joins or leaves my team", on: false },
] as const;

export function PersonalSettings({ ctx, state }: PrototypeProps): ReactElement {
  const [saved, setSaved] = useState(state === "saved");
  const person = ctx.key === "company" ? { name: "Tomas Reyes", email: "tomas.reyes@halden.example" } : ctx.key === "operator" ? { name: "Priya Nair", email: "priya.nair@northwind.example" } : { name: "Lena Ortiz", email: "lena.ortiz@northwind.example" };
  return (
    <>
      <PageHead title="Your settings" lead="Your own account, the same in every workspace you belong to." />
      <p className="kauro-proposed kauro-proposed--page">Proposed — your profile, sign-in methods, sessions and notices need reads and commands the API does not have yet (D-P01-1 to D-P01-4, F-07)</p>
      <nav className="kauro-local-nav" aria-label="Sections of this page">
        <ul>
          <li>
            <a href="#me-appearance">Appearance</a>
          </li>
          <li>
            <a href="#me-profile">Profile</a>
          </li>
          <li>
            <a href="#me-security">Sign-in and security</a>
          </li>
          <li>
            <a href="#me-sessions">Sessions</a>
          </li>
          <li>
            <a href="#me-notices">Notices</a>
          </li>
        </ul>
      </nav>
      <div className="kauro-settings-split">

      <section id="me-appearance" aria-labelledby="me-appearance-h">
        <h2 id="me-appearance-h">Appearance</h2>
        <p>Your choice is kept on this device and applies to every Kauro page. With nothing chosen, Kauro follows your system.</p>
        <Appearance />
      </section>

      <section id="me-profile" aria-labelledby="me-profile-h">
        <h2 id="me-profile-h">Profile</h2>
        <Facts
          rows={[
            ["Name", person.name],
            ["Email address", person.email],
          ]}
        />
        <p className="kauro-muted">Your name and email address are the ones you signed up with. To change either, open a support case: a new address is verified before it is used.</p>
      </section>

      <section id="me-security" aria-labelledby="me-security-h">
        <h2 id="me-security-h">Sign-in and security</h2>
        <Facts
          rows={[
            ["Google", ctx.key === "operator" ? "Not connected" : <span key="g">Connected as <bdi>{person.email}</bdi></span>],
            ["Password", "Set on Sep 2, 2026"],
            ["Two-step verification", <Badge key="m" tone="success">Authenticator app, since Sep 2, 2026</Badge>],
            ["Recovery codes", "8 of 10 unused"],
            ["Identity confirmed for sensitive actions", "Not in the last 15 minutes. Kauro asks again before a sensitive action."],
          ]}
        />
        <div className="kauro-actions">
          <Button>Change password</Button>
          <Button>Replace authenticator app</Button>
          <Button>Create new recovery codes</Button>
        </div>
        <p className="kauro-muted">Two-step verification is required on every Kauro account and cannot be turned off. Each of these asks you to confirm your identity first.</p>
        {state === "new-codes" ? (
          <Banner tone="warning" title="Your new recovery codes" announce="status">
            <p>Save them now: they are shown only this once. Your previous codes no longer work.</p>
            <RecoveryList />
          </Banner>
        ) : null}
      </section>

      <section id="me-sessions" aria-labelledby="me-sessions-h">
        <h2 id="me-sessions-h">Sessions</h2>
        {state === "signed-out" ? (
          <Banner tone="success" title="Other sessions ended" announce="status">
            <p>You are now signed in only here. Anyone on another device must sign in again, with your password and Kauro code.</p>
          </Banner>
        ) : null}
        <ul className="kauro-sessions">
          <li>
            <span className="kauro-sessions-what">
              <strong>This device</strong>
              <span>Chrome on Windows · signed in today at 2:02 PM UTC</span>
            </span>
            <Badge tone="success">Active now</Badge>
          </li>
          {state === "signed-out" ? null : (
            <>
              <li>
                <span className="kauro-sessions-what">
                  <strong>Safari on iPhone</strong>
                  <span>Signed in on Oct 18, 2026 · last active yesterday · near Bogotá, CO</span>
                </span>
                <Button>Sign out</Button>
              </li>
              <li>
                <span className="kauro-sessions-what">
                  <strong>Firefox on macOS</strong>
                  <span>Signed in on Oct 12, 2026 · last active Oct 14, 2026 · near Medellín, CO</span>
                </span>
                <Button>Sign out</Button>
              </li>
            </>
          )}
        </ul>
        <div className="kauro-actions">
          {state === "signed-out" ? null : <Button>Sign out all other sessions</Button>}
          <Button>Sign out here</Button>
        </div>
        <Facts
          rows={[
            ["Ends after inactivity", "30 minutes without activity"],
            ["Ends at the latest", "12 hours after signing in"],
          ]}
        />
      </section>

      <section id="me-notices" aria-labelledby="me-notices-h">
        <h2 id="me-notices-h">Notices</h2>
        <form
          className="kauro-notice-form"
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(true);
          }}
        >
          <fieldset>
            <legend>Email me when</legend>
            {NOTICES.map((notice) => (
              <label key={notice.id} className="kauro-check-row">
                <input type="checkbox" name={notice.id} defaultChecked={notice.on} />
                <span>{notice.label}</span>
              </label>
            ))}
          </fieldset>
          <div className="kauro-actions">
            <Button type="submit" variant="primary">
              Save notices
            </Button>
            {saved ? (
              <span role="status" className="kauro-saved">
                Saved
              </span>
            ) : null}
          </div>
        </form>
      </section>

      <p className="kauro-muted">
        Agency settings (name, logo, members, closure) are in each agency: <ScreenLink to="UI32" ctx={ctx}>open this agency&apos;s settings</ScreenLink>.
      </p>
      </div>
    </>
  );
}

/** Light or dark, each shown as a miniature of the product window; the choice goes to the web's own theme route (POST /preferences/theme). */
function Appearance(): ReactElement {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  useEffect(() => {
    const stored = document.documentElement.dataset["theme"];
    setTheme(stored === "light" || stored === "dark" ? stored : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }, []);
  const choose = (next: "light" | "dark"): void => {
    document.documentElement.dataset["theme"] = next;
    setTheme(next);
    void fetch("/preferences/theme", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-kauro-theme": "1" }, body: `theme=${next}`, credentials: "same-origin" }).catch(() => undefined);
  };
  return (
    <fieldset className="kauro-appearance">
      <legend className="kauro-visually-hidden">Theme</legend>
      {(["light", "dark"] as const).map((option) => (
        <label key={option} className={`kauro-appearance-option kauro-appearance-option--${option}`}>
          <input type="radio" name="theme" value={option} checked={theme === option} onChange={() => choose(option)} />
          <span className="kauro-appearance-preview" aria-hidden="true">
            <span className="kauro-appearance-bar">Kauro</span>
            <span className="kauro-appearance-line" />
            <span className="kauro-appearance-line kauro-appearance-line--short" />
            <span className="kauro-appearance-ring" />
          </span>
          <span className="kauro-appearance-name">{option === "light" ? "Light" : "Dark"}</span>
        </label>
      ))}
    </fieldset>
  );
}
