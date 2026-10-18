// Amendment A10 §2: the visitor's colour theme is a display preference the server stores. The pure rules of src/server/theme.ts: what a
// stored value names, what a submitted choice resolves to, the cookie that stores it, and the return path of a choice made without script,
// which must never become an open redirect.
import assert from "node:assert/strict";
import { test } from "node:test";
import { THEME_COOKIE, THEME_COOKIE_MAX_AGE_SECONDS, parseTheme, resolveChoice, returnPath, sameOriginWrite, servedOrigin, themeCookie, themeOfCookieHeader, type RequestOriginFacts } from "../src/server/theme.ts";

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

test("A10: a write is the site's own only when its Origin equals the served origin whole — scheme, host and port — and a browser's Sec-Fetch-Site says same-origin", () => {
  // behind the TLS edge: the server sees http, the edge says https
  const edge: RequestOriginFacts = { url: "http://localhost:3000/preferences/theme", origin: "https://localhost:44400", host: "localhost:44400", forwardedProto: "https", forwardedHost: "localhost:44400", fetchSite: "same-origin" };
  assert.equal(servedOrigin(edge), "https://localhost:44400");
  assert.equal(sameOriginWrite(edge), true);
  // the same host and port under another scheme is another origin (the independent review's reproduction, R-110-3)
  assert.equal(sameOriginWrite({ ...edge, origin: "http://localhost:44400", fetchSite: null }), false);
  assert.equal(sameOriginWrite({ ...edge, origin: "https://localhost:44401", fetchSite: null }), false);
  assert.equal(sameOriginWrite({ ...edge, origin: "https://evil.example", fetchSite: null }), false);
  assert.equal(sameOriginWrite({ ...edge, origin: "https://www.localhost:44400", fetchSite: null }), false);
  assert.equal(sameOriginWrite({ ...edge, origin: "null", fetchSite: null }), false, "an opaque origin without fetch metadata is refused");
  // the site's own native form under no-referrer: Chromium sends Origin "null" with Sec-Fetch-Site same-origin (R-110-4)
  assert.equal(sameOriginWrite({ ...edge, origin: "null", fetchSite: "same-origin" }), true, "the site's own form without script");
  for (const site of ["cross-site", "same-site", "none"]) assert.equal(sameOriginWrite({ ...edge, origin: "null", fetchSite: site }), false, `null from ${site}`);
  assert.equal(sameOriginWrite({ ...edge, origin: "not a url", fetchSite: null }), false);
  // a browser that says the request crossed sites is refused whatever Origin says
  for (const site of ["cross-site", "same-site", "none"]) assert.equal(sameOriginWrite({ ...edge, fetchSite: site }), false, site);
  // without the edge, the request URL is the served origin
  const direct: RequestOriginFacts = { url: "http://localhost:3000/preferences/theme", origin: "http://localhost:3000", host: "localhost:3000", forwardedProto: null, forwardedHost: null, fetchSite: null };
  assert.equal(sameOriginWrite(direct), true);
  assert.equal(sameOriginWrite({ ...direct, origin: "https://localhost:3000" }), false);
  // a client that sends neither header is the site's own (the change is a display preference)
  assert.equal(sameOriginWrite({ ...direct, origin: null }), true);
});
