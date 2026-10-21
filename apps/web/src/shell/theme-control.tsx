"use client";

// The colour theme control (amendment A10) of the public frame and the application header. A form that posts to /preferences/theme, so it
// works before (and without) the script: the server stores the choice and sends the visitor back. With the script, the page switches at
// once and posts the same choice in the background; the server stores it, and no browser source writes a browser store (D-PRIV-1).
//
// What the button says depends on the theme being drawn, which only the browser knows when nothing is stored (the system's preference),
// so the server renders the neutral name and the browser names the next theme after the first paint.
import { useSyncExternalStore, type FormEvent, type ReactElement } from "react";
import { THEME_ROUTE, THEME_SCRIPT_HEADER, returnPath, type Theme } from "../server/theme.ts";

export interface ThemeControlLabels {
  /** The name of the button when the next theme is dark, when it is light, and when the server cannot tell. */
  readonly toDark: string;
  readonly toLight: string;
  readonly toggle: string;
}

const CHANGE = "kauro-theme-change";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function drawnTheme(): Theme {
  const stored = document.documentElement.dataset["theme"];
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

function subscribe(listener: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener("change", listener);
  window.addEventListener(CHANGE, listener);
  return () => {
    media.removeEventListener("change", listener);
    window.removeEventListener(CHANGE, listener);
  };
}

export interface ThemeControlProps {
  readonly labels: ThemeControlLabels;
  readonly className: string;
  /** The path of the page, where a choice made without script returns to (the caller reads it from its router). */
  readonly returnTo: string | null;
  /**
   * "form" (the default) works without script; "button" is the control alone, for a frame that is drawn only once its script runs (the
   * application shell, whose markup holds no form).
   */
  readonly mode?: "form" | "button";
}

/** Draws the next theme at once and asks the server to store it; the page never writes a browser store. */
function choose(next: Theme): void {
  // The new colours land at once: no rule's colour transition replays across the whole page (tokens.css, data-theme-switching).
  const root = document.documentElement;
  root.dataset["themeSwitching"] = "";
  root.dataset["theme"] = next;
  void document.body.offsetHeight;
  delete root.dataset["themeSwitching"];
  window.dispatchEvent(new Event(CHANGE));
  void fetch(THEME_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", [THEME_SCRIPT_HEADER]: "1" },
    body: `theme=${next}`,
    credentials: "same-origin",
    cache: "no-store",
    // the choice is stored even when the visitor follows a link before the answer arrives
    keepalive: true,
  }).catch(() => undefined);
}

export interface ThemeChoiceLabels {
  /** The name of the group, and of its two options. */
  readonly group: string;
  readonly light: string;
  readonly dark: string;
}

/**
 * The theme as two named options side by side, the drawn one pressed (Order 11 round 2: the account menu names the choice instead of a
 * lone icon). It needs its script, like the menu it sits in.
 */
export function ThemeChoice({ labels, className }: { readonly labels: ThemeChoiceLabels; readonly className: string }): ReactElement {
  const drawn = useSyncExternalStore<Theme | null>(subscribe, drawnTheme, () => null);
  const option = (theme: Theme, label: string): ReactElement => (
    <button type="button" aria-pressed={drawn === theme} onClick={() => (drawn === theme ? undefined : choose(theme))}>
      {label}
    </button>
  );
  return (
    <div className={className} role="group" aria-label={labels.group}>
      {option("light", labels.light)}
      {option("dark", labels.dark)}
    </div>
  );
}

export function ThemeControl({ labels, className, returnTo, mode = "form" }: ThemeControlProps): ReactElement {
  const drawn = useSyncExternalStore<Theme | null>(subscribe, drawnTheme, () => null);
  const next: Theme | null = drawn === null ? null : drawn === "dark" ? "light" : "dark";
  const label = next === null ? labels.toggle : next === "dark" ? labels.toDark : labels.toLight;

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    if (next === null) return;
    event.preventDefault();
    choose(next);
  }

  if (mode === "button") {
    return (
      <button type="button" className={className} aria-label={label} title={label} onClick={() => (next === null ? undefined : choose(next))}>
        <span className="kauro-theme-glyph" aria-hidden="true" />
      </button>
    );
  }

  return (
    <form className={className} method="post" action={`${THEME_ROUTE}?return=${encodeURIComponent(returnPath(returnTo))}`} onSubmit={onSubmit}>
      <button type="submit" name="theme" value={next ?? "toggle"} aria-label={label} title={label}>
        <span className="kauro-theme-glyph" aria-hidden="true" />
      </button>
    </form>
  );
}
