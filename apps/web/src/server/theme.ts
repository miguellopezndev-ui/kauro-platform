// The visitor's colour theme (amendment A10): light, dark, or — with nothing stored — whatever the system asks for. The choice is a display
// preference and nothing else: it names no person, account or agency, it is written only by the server (POST /preferences/theme answers
// with the cookie; no browser source touches a browser store, D-PRIV-1) and it is read by the root layout and the legal documents to set
// <html data-theme>. Pure: no request, no environment, so node:test reads every rule here.

export type Theme = "light" | "dark";

export const THEME_COOKIE = "kauro_theme";

/** The route that stores a choice, and the header the theme control's script sends so the route answers 204 instead of redirecting. */
export const THEME_ROUTE = "/preferences/theme";
export const THEME_SCRIPT_HEADER = "x-kauro-theme";

/** One year: a display preference outlives a session but is not kept for ever. */
export const THEME_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** The theme a stored value names, or null for a value that names none (absent, empty, anything else). */
export function parseTheme(value: string | null | undefined): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}

/** The theme a request's Cookie header stores, read without a framework (the legal route handlers have only the request). */
export function themeOfCookieHeader(header: string | null): Theme | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === THEME_COOKIE) return parseTheme(rest.join("="));
  }
  return null;
}

/**
 * What a submitted choice resolves to. "light" and "dark" are explicit (a page with its script running knows which theme is drawn);
 * "toggle" comes from a page without script and flips the stored value, and with nothing stored the page was drawn light by default
 * unless the system asked otherwise, which the server cannot see, so it chooses dark.
 */
export function resolveChoice(choice: string | null, stored: Theme | null): Theme | null {
  if (choice === "light" || choice === "dark") return choice;
  if (choice === "toggle") return stored === "dark" ? "light" : "dark";
  return null;
}

/** The Set-Cookie value that stores a theme. Readable only by the server (HttpOnly): the page learns its theme from <html data-theme>. */
export function themeCookie(theme: Theme, secure: boolean): string {
  return `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax; HttpOnly${secure ? "; Secure" : ""}`;
}

/**
 * Where to send the visitor back after a choice made without script: a path of this site and nothing else. A value that is not a plain
 * absolute path (a scheme, a host, a protocol-relative "//", a backslash, a control character) returns the home page, so the route can
 * never become an open redirect.
 */
export function returnPath(value: string | null): string {
  if (value === null || value.length === 0 || value.length > 512) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return "/";
  return value;
}
