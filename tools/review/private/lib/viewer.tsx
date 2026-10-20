"use client";
// The owner's viewer of one screen (Order 11 §6): the screen in a frame at the chosen width, with the controls to change the person, the
// state, the width and the theme, to go to the previous or next screen, and a panel with the registry's contract and every call the screen
// made in review (all answered on this machine).
import { type ChangeEvent, type ReactElement, useEffect, useState } from "react";
import { CONTEXTS, type ContextKey } from "./contexts.ts";
import { neighbours, type PrivateScreen, TECHNICAL_LABEL, type Review } from "./inventory.ts";

import { REVIEW, stateHref, viewerHref } from "./links.ts";
import { appPathOf, screenDef } from "./screens.tsx";

const WIDTHS = [
  { key: "full", label: "Fit window" },
  { key: "1440", label: "1440 · wide desktop" },
  { key: "1280", label: "1280 · desktop" },
  { key: "768", label: "768 · tablet" },
  { key: "375", label: "375 · phone" },
  { key: "320", label: "320 · small phone" },
] as const;

export interface ViewerProps {
  readonly screen: PrivateScreen;
  readonly review: Review;
  readonly context: ContextKey;
  readonly state: string;
  readonly width: string;
}

function setTheme(next: "light" | "dark"): Promise<unknown> {
  // the web's own theme route (the same cookie the product reads); the review sets nothing else
  return fetch("/preferences/theme", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-kauro-theme": "1" }, body: `theme=${next}`, credentials: "same-origin" });
}

export function Viewer({ screen, review, context, state, width }: ViewerProps): ReactElement {
  const def = screenDef(screen.id);
  const { previous, next } = neighbours(screen.id);
  const [calls, setCalls] = useState<readonly string[]>([]);
  const [frameKey, setFrameKey] = useState(0);
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    const stored = document.documentElement.dataset["theme"];
    setDark(stored === "dark" ? true : stored === "light" ? false : window.matchMedia("(prefers-color-scheme: dark)").matches);
    const listen = (event: MessageEvent): void => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { kind?: string; detail?: string } | null;
      if (data?.kind === "kauro-review-call" && typeof data.detail === "string") setCalls((list) => [...list.slice(-39), data.detail as string]);
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, []);

  const go = (ctx: string, st: string, w: string): void => {
    const query = new URLSearchParams({ ctx, state: st, w });
    window.location.assign(`${REVIEW}/screen/${screen.id}?${query.toString()}`);
  };
  const onTheme = (): void => {
    const next = dark === true ? "light" : "dark";
    void setTheme(next).then(() => {
      document.documentElement.dataset["theme"] = next;
      setDark(next === "dark");
      setCalls([]);
      setFrameKey((key) => key + 1);
    });
  };
  const stateDef = def.states.find((candidate) => candidate.key === state) ?? def.states[0];
  const src = stateHref(appPathOf(screen.id, CONTEXTS[context]), context, stateDef?.key, screen.technical === "PROPOSED" ? screen.id : undefined);

  return (
    <div className="rv">
      <header className="rv-bar">
        <a className="rv-home" href={REVIEW}>
          ← All 42 screens
        </a>
        <nav className="rv-step" aria-label="Screens">
          {previous === null ? <span aria-hidden="true" /> : <a href={viewerHref(previous, context)}>← {previous}</a>}
          {next === null ? <span aria-hidden="true" /> : <a href={viewerHref(next, context)}>{next} →</a>}
        </nav>
        <h1 className="rv-title">
          <span className="rv-id">{screen.id}</span> {screen.title} <span className="rv-group">Group {screen.group}</span>
        </h1>
        <p className="rv-badges">
          <span className={`rv-tech rv-tech--${screen.technical}`}>{TECHNICAL_LABEL[screen.technical]}</span>
          <span className={`rv-review rv-review--${review}`}>{review.replaceAll("_", " ")}</span>
        </p>
      </header>
      <form className="rv-controls" onSubmit={(event) => event.preventDefault()}>
        <label>
          Person
          <select value={context} onChange={(event: ChangeEvent<HTMLSelectElement>) => go(event.target.value, state, width)}>
            {def.contexts.map((key) => (
              <option key={key} value={key}>
                {CONTEXTS[key].label}
              </option>
            ))}
          </select>
        </label>
        <label>
          State
          <select value={stateDef?.key ?? state} onChange={(event: ChangeEvent<HTMLSelectElement>) => go(context, event.target.value, width)}>
            {def.states.map((candidate) => (
              <option key={candidate.key} value={candidate.key}>
                {candidate.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Width
          <select value={width} onChange={(event: ChangeEvent<HTMLSelectElement>) => go(context, state, event.target.value)}>
            {WIDTHS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={onTheme}>
          {dark === null ? "Theme" : dark ? "Light theme" : "Dark theme"}
        </button>
        <a href={src} target="_blank" rel="noreferrer">
          Open alone
        </a>
      </form>
      {stateDef === undefined ? null : <p className="rv-state-note">{stateDef.note}</p>}
      <div className="rv-body">
        <div className={`rv-stage rv-stage--${width}`}>
          <iframe key={frameKey} className="rv-frame" title={`${screen.id} ${screen.title}`} src={src} />
        </div>
        <aside className="rv-side" aria-label="What this screen is">
          <h2>Contract (registry)</h2>
          <dl>
            <dt>Route</dt>
            <dd>
              <code>{screen.route}</code>
            </dd>
            <dt>Says</dt>
            <dd>{screen.primaryCopy}</dd>
            <dt>Shows</dt>
            <dd>{screen.information}</dd>
            <dt>Lets you</dt>
            <dd>{screen.actions}</dd>
            <dt>Must hold</dt>
            <dd>{screen.exceptions}</dd>
          </dl>
          <h2>Calls in this review</h2>
          {calls.length === 0 ? <p className="rv-muted">None yet.</p> : null}
          <ol className="rv-calls">
            {calls.map((call, index) => (
              <li key={`${index}-${call}`}>{call}</li>
            ))}
          </ol>
          <p className="rv-muted">Answered on this machine from synthetic data. Nothing reaches a server, a provider or a CRM.</p>
        </aside>
      </div>
    </div>
  );
}
