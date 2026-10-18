// Amendment A10 §2: the visitor's colour theme is a display preference the server stores. The pure rules of src/server/theme.ts: what a
// stored value names, what a submitted choice resolves to, the cookie that stores it, and the return path of a choice made without script,
// which must never become an open redirect.
import assert from "node:assert/strict";
import { test } from "node:test";
import { THEME_COOKIE, THEME_COOKIE_MAX_AGE_SECONDS, parseTheme, resolveChoice, returnPath, themeCookie, themeOfCookieHeader } from "../src/server/theme.ts";

test("A10: a stored value names a theme only when it is exactly light or dark", () => {
  assert.equal(parseTheme("light"), "light");
  assert.equal(parseTheme("dark"), "dark");
  for (const value of [undefined, null, "", "Dark", "system", "dark;", " light"]) assert.equal(parseTheme(value), null, String(value));
});

test("A10: the theme is read from a Cookie header by its own name, among other cookies, and nothing else is read from it", () => {
  assert.equal(themeOfCookieHeader(null), null);
  assert.equal(themeOfCookieHeader(`${THEME_COOKIE}=dark`), "dark");
  assert.equal(themeOfCookieHeader(`a=1; ${THEME_COOKIE}=light; __Host-kauro_session=x`), "light");
  assert.equal(themeOfCookieHeader(`x${THEME_COOKIE}=dark`), null, "a cookie whose name only ends with the theme's is not the theme");
  assert.equal(themeOfCookieHeader(`${THEME_COOKIE}=blue`), null);
});

test("A10: an explicit choice is kept; a choice made without script flips what is stored, and with nothing stored chooses dark", () => {
  assert.equal(resolveChoice("light", "dark"), "light");
  assert.equal(resolveChoice("dark", null), "dark");
  assert.equal(resolveChoice("toggle", "dark"), "light");
  assert.equal(resolveChoice("toggle", "light"), "dark");
  assert.equal(resolveChoice("toggle", null), "dark");
  for (const choice of [null, "", "system", "DARK"]) assert.equal(resolveChoice(choice, null), null, String(choice));
});

test("A10: the cookie is the server's alone (HttpOnly), sent on the site's own navigation (SameSite=Lax), kept a year, and Secure on https", () => {
  const plain = themeCookie("dark", false);
  assert.equal(plain, `${THEME_COOKIE}=dark; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax; HttpOnly`);
  assert.equal(THEME_COOKIE_MAX_AGE_SECONDS, 31_536_000);
  assert.match(themeCookie("light", true), /; HttpOnly; Secure$/);
});

test("A10: a choice made without script returns to a path of this site and nowhere else", () => {
  assert.equal(returnPath("/pricing"), "/pricing");
  assert.equal(returnPath("/help#guide-files"), "/help#guide-files");
  for (const value of [null, "", "pricing", "//evil.example/", "https://evil.example/", "/\\evil.example", "/a\u0000b", "/a\nb", `/${"a".repeat(600)}`]) {
    assert.equal(returnPath(value), "/", JSON.stringify(value));
  }
});
