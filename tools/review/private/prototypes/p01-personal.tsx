"use client";
// P-01 Personal settings (proposed; Order 11 §4 A). One page per person, the same in every agency. Built only from what exists where it
// can be: the theme is the application's own control (POST /preferences/theme), two-step verification and the session's limits come from
// the session (getCurrentSession: mfaAt, idleExpiresAt, absoluteExpiresAt), signing out is the real sign-out. The profile read, signing
// out other devices and notices have no contract: each is marked as proposed. No password, code or secret appears here, ever.
import { Button } from "@kauro/ui";
import { type ReactElement, useEffect, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, Facts, PageHead, ScreenLink } from "./kit.tsx";

export const P01_STATES: readonly StateDef[] = [
  { key: "normal", label: "Personal settings", note: "Every section with the person's synthetic data." },
  { key: "no-mfa", label: "Two-step verification off", note: "A person whose two-step verification is not set up: the page says what it blocks and how to fix it." },
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
      <PageHead eyebrow="Your account" title="Your settings" lead="Your own settings, the same in every agency." />
      <nav className="kauro-local-nav" aria-label="Sections of this page">
        <ul>
          <li>
            <a href="#me-appearance">Appearance</a>
          </li>
          <li>
            <a href="#me-profile">Profile</a>
          </li>
          <li>
            <a href="#me-security">Security</a>
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
        <p className="kauro-proposed">Proposed — needs a read of the identity provider&apos;s profile (D-P01-1)</p>
        <Facts
          rows={[
            ["Name", person.name],
            ["Email address", person.email],
          ]}
        />
        <p className="kauro-muted">Your name and address are held by Kauro&apos;s identity provider. Change them there; Kauro shows what it holds.</p>
      </section>

      <section id="me-security" aria-labelledby="me-security-h">
        <h2 id="me-security-h">Security</h2>
        <Facts
          rows={[
            [
              "Two-step verification",
              state === "no-mfa" ? <Badge key="m" tone="warning">Not set up</Badge> : <Badge key="m" tone="success">On since 2 Sep 2026</Badge>,
            ],
            ["Identity confirmed for sensitive actions", "Not in the last 15 minutes. Kauro asks again before a sensitive action."],
            ["Password", "Kept by the identity provider. Kauro never receives it."],
          ]}
        />
        {state === "no-mfa" ? (
          <p>
            Until two-step verification is on you cannot open any agency&apos;s data. <ScreenLink to="UI50" ctx={ctx}>Set it up now</ScreenLink>.
          </p>
        ) : null}
      </section>

      <section id="me-sessions" aria-labelledby="me-sessions-h">
        <h2 id="me-sessions-h">Sessions</h2>
        <Facts
          rows={[
            ["This session", "Started today at 14:02 UTC on this device"],
            ["Ends after inactivity", "30 minutes without activity"],
            ["Ends at the latest", "Tomorrow at 02:02 UTC, 12 hours after sign-in"],
          ]}
        />
        <div className="kauro-actions">
          <Button>Sign out</Button>
        </div>
        <p className="kauro-proposed">Proposed — signing out other devices needs a contract (D-P01-2)</p>
        <p className="kauro-muted">Other devices where you are signed in are not listed yet. Signing out here ends this session only.</p>
      </section>

      <section id="me-notices" aria-labelledby="me-notices-h">
        <h2 id="me-notices-h">Notices</h2>
        <p className="kauro-proposed">Proposed — notices need a contract and an email route (D-P01-3)</p>
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
