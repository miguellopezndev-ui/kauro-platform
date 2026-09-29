import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NavigationGuard } from "../src/index.js";
import { guardWhile, installNavigationGuard, leavesPageInApp } from "../src/internal/navigation-guard.js";
import type { AnchorLike, BeforeUnloadLike, ClickLike, GuardEnvironment, LeaveAttempt } from "../src/internal/navigation-guard.js";

const HERE = "https://app.example.test/clients/42?tab=files";

const anchor = (href: string, extra: Partial<AnchorLike> & { readonly download?: boolean } = {}): AnchorLike => ({
  href,
  target: extra.target ?? "",
  isConnected: extra.isConnected ?? true,
  click: extra.click ?? (() => undefined),
  hasAttribute: (name) => name === "download" && extra.download === true,
});

interface ClickLog {
  prevented: number;
  stopped: number;
  stoppedImmediately: number;
}

function click(target: unknown, overrides: Partial<ClickLike> = {}): { readonly event: ClickLike; readonly log: ClickLog } {
  const log: ClickLog = { prevented: 0, stopped: 0, stoppedImmediately: 0 };
  const event: ClickLike = {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target,
    preventDefault: () => void log.prevented++,
    stopPropagation: () => void log.stopped++,
    stopImmediatePropagation: () => void log.stoppedImmediately++,
    ...overrides,
  };
  return { event, log };
}

/** An element whose closest("a[href]") is the given anchor, as a click on a link's inner text or icon would report. */
const inside = (link: AnchorLike | null): { closest(selector: string): AnchorLike | null } => ({ closest: (selector) => (selector === "a[href]" ? link : null) });

test("D-DS-1: a click leaves the page when it follows a link to another page of the same application, and only then", () => {
  assert.equal(leavesPageInApp(click(inside(anchor("https://app.example.test/clients"))).event, HERE), true);
  assert.equal(leavesPageInApp(click(inside(anchor("https://app.example.test/clients/42?tab=history"))).event, HERE), true, "another query is another page");
  assert.equal(leavesPageInApp(click(inside(anchor("https://app.example.test/clients/42?tab=files#notes"))).event, HERE), false, "a fragment stays on the page");
  assert.equal(leavesPageInApp(click(inside(anchor("https://app.example.test/clients/42?tab=files"))).event, HERE), false, "the same address");
  assert.equal(leavesPageInApp(click(inside(anchor("https://other.example.test/x"))).event, HERE), false, "another origin is left through beforeunload");
  assert.equal(leavesPageInApp(click(inside(anchor("https://app.example.test/clients", { target: "_self" }))).event, HERE), true);
  assert.equal(leavesPageInApp(click(inside(anchor("https://app.example.test/clients", { target: "_blank" }))).event, HERE), false, "a new tab leaves the page where it is");
  assert.equal(leavesPageInApp(click(inside(anchor("https://app.example.test/report.csv", { download: true }))).event, HERE), false);
});

test("D-DS-1: a click that the browser will not treat as a plain navigation is not guarded — a modifier key, another button, a prevented default, or a target that is no link", () => {
  const link = inside(anchor("https://app.example.test/clients"));
  for (const overrides of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }, { defaultPrevented: true }] as const) {
    assert.equal(leavesPageInApp(click(link, overrides).event, HERE), false, JSON.stringify(overrides));
  }
  assert.equal(leavesPageInApp(click(null).event, HERE), false);
  assert.equal(leavesPageInApp(click({}).event, HERE), false, "a target with no closest()");
  assert.equal(leavesPageInApp(click("text").event, HERE), false);
  assert.equal(leavesPageInApp(click(inside(null)).event, HERE), false, "no enclosing link");
  const svgLink = { href: { baseVal: "/x" }, target: "", isConnected: true, click: () => undefined, hasAttribute: () => false } as unknown as AnchorLike;
  assert.equal(leavesPageInApp(click(inside(svgLink)).event, HERE), false, "an SVG anchor's href is not a string");
  assert.equal(leavesPageInApp(click(inside(anchor("http://[bad"))).event, HERE), false, "an address that does not parse");
  assert.equal(leavesPageInApp(click(inside(anchor("https://app.example.test/x"))).event, "not a url"), false);
});

function environment(href = HERE): {
  readonly env: GuardEnvironment;
  readonly windowListeners: Map<string, (event: BeforeUnloadLike) => void>;
  readonly documentListeners: Map<string, { listener: (event: ClickLike) => void; capture: boolean }>;
  readonly navigated: string[];
} {
  const windowListeners = new Map<string, (event: BeforeUnloadLike) => void>();
  const documentListeners = new Map<string, { listener: (event: ClickLike) => void; capture: boolean }>();
  const navigated: string[] = [];
  const env: GuardEnvironment = {
    window: {
      addEventListener: (type, listener) => void windowListeners.set(type, listener),
      removeEventListener: (type, listener) => {
        if (windowListeners.get(type) === listener) windowListeners.delete(type);
      },
    },
    document: {
      addEventListener: (type, listener, capture) => void documentListeners.set(type, { listener, capture }),
      removeEventListener: (type, listener, capture) => {
        const held = documentListeners.get(type);
        if (held?.listener === listener && held.capture === capture) documentListeners.delete(type);
      },
    },
    currentHref: () => href,
    navigate: (destination) => void navigated.push(destination),
  };
  return { env, windowListeners, documentListeners, navigated };
}

test("D-DS-1: the guard asks the browser to confirm leaving the document and, in the capture phase, asks the person before a link inside the application is followed", () => {
  const { env, windowListeners, documentListeners } = environment();
  const asked: string[] = [];
  const remove = installNavigationGuard(env, { message: "You have unsaved changes. Leave anyway?", confirmLeave: (message) => (asked.push(message), false) });
  const beforeUnload = windowListeners.get("beforeunload");
  assert.ok(beforeUnload !== undefined);
  let prevented = 0;
  const unloadEvent: BeforeUnloadLike = { preventDefault: () => void prevented++, returnValue: undefined };
  beforeUnload(unloadEvent);
  assert.equal(prevented, 1);
  assert.equal(unloadEvent.returnValue, "", "the legacy returnValue is set so browsers that need it still prompt");
  const held = documentListeners.get("click");
  assert.ok(held !== undefined);
  assert.equal(held.capture, true, "captured, so it runs before the application's own link handling");
  const leaving = click(inside(anchor("https://app.example.test/clients")));
  held.listener(leaving.event);
  assert.deepEqual(asked, ["You have unsaved changes. Leave anyway?"]);
  assert.deepEqual(leaving.log, { prevented: 1, stopped: 1, stoppedImmediately: 1 }, "a refusal stops the navigation completely");
  remove();
  assert.equal(windowListeners.size, 0);
  assert.equal(documentListeners.size, 0);
});

test("D-DS-1: when the person agrees to leave, the click goes through untouched; a click that does not leave is never asked about", () => {
  const { env, documentListeners } = environment();
  let asked = 0;
  installNavigationGuard(env, { message: "m", confirmLeave: () => (asked++, true) });
  const held = documentListeners.get("click");
  assert.ok(held !== undefined);
  const agreed = click(inside(anchor("https://app.example.test/clients")));
  held.listener(agreed.event);
  assert.equal(asked, 1);
  assert.deepEqual(agreed.log, { prevented: 0, stopped: 0, stoppedImmediately: 0 });
  const staying = click(inside(anchor("https://app.example.test/clients/42?tab=files#notes")));
  held.listener(staying.event);
  held.listener(click(inside(anchor("https://other.example.test/x"))).event);
  held.listener(click(null).event);
  assert.equal(asked, 1, "no question for a click that stays, goes elsewhere or is no link");
  assert.deepEqual(staying.log, { prevented: 0, stopped: 0, stoppedImmediately: 0 });
});

test("D-DS-1: when the caller takes over the question, a click that would leave is held and handed over with its destination, and proceed follows it once, as the original click, past the guard", () => {
  const { env, documentListeners } = environment();
  const attempts: LeaveAttempt[] = [];
  installNavigationGuard(env, { message: "m", confirmLeave: () => assert.fail("the browser's own question is not asked"), onBlocked: (attempt) => void attempts.push(attempt) });
  const held = documentListeners.get("click");
  assert.ok(held !== undefined);
  const followed: ClickLog[] = [];
  const link: AnchorLike = anchor("https://app.example.test/clients", {
    click: () => {
      const again = click(inside(link));
      held.listener(again.event);
      followed.push(again.log);
    },
  });
  const leaving = click(inside(link));
  held.listener(leaving.event);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.href, "https://app.example.test/clients");
  assert.deepEqual(leaving.log, { prevented: 1, stopped: 1, stoppedImmediately: 1 });
  assert.equal(followed.length, 0, "nothing is followed until the person has chosen");
  attempts[0]?.proceed();
  assert.equal(followed.length, 1);
  assert.deepEqual(followed[0], { prevented: 0, stopped: 0, stoppedImmediately: 0 }, "the re-issued click is not held again");
  assert.equal(attempts.length, 1, "the re-issued click is not handed over again");
  attempts[0]?.proceed();
  assert.equal(followed.length, 1, "a second proceed does nothing");
  held.listener(click(inside(anchor("https://app.example.test/other"))).event);
  assert.equal(attempts.length, 2, "once the link has been followed the guard holds the next click again");
  held.listener(click(inside(anchor("https://app.example.test/clients/42?tab=files#notes"))).event);
  held.listener(click(inside(anchor("https://other.example.test/x"))).event);
  assert.equal(attempts.length, 2, "a click that does not leave the page is never handed over");
});

test("D-DS-1: a held link that is no longer on the page is followed by a full navigation to its address", () => {
  const { env, documentListeners, navigated } = environment();
  const attempts: LeaveAttempt[] = [];
  installNavigationGuard(env, { message: "m", confirmLeave: () => true, onBlocked: (attempt) => void attempts.push(attempt) });
  let clicked = 0;
  const gone = anchor("https://app.example.test/clients?tab=history", { isConnected: false, click: () => void clicked++ });
  documentListeners.get("click")?.listener(click(inside(gone)).event);
  assert.equal(attempts.length, 1);
  attempts[0]?.proceed();
  attempts[0]?.proceed();
  assert.deepEqual(navigated, ["https://app.example.test/clients?tab=history"]);
  assert.equal(clicked, 0);
});

test("D-DS-1: the guard is installed only while the page is dirty and removes exactly what it installed", () => {
  const clean = environment();
  assert.equal(guardWhile(false, clean.env, { message: "m", confirmLeave: () => true }), undefined);
  assert.equal(clean.windowListeners.size + clean.documentListeners.size, 0, "a page with nothing to lose is not guarded");
  const dirty = environment();
  const remove = guardWhile(true, dirty.env, { message: "m", confirmLeave: () => true });
  assert.equal(typeof remove, "function");
  assert.equal(dirty.windowListeners.size, 1);
  assert.equal(dirty.documentListeners.size, 1);
  remove?.();
  assert.equal(dirty.windowListeners.size + dirty.documentListeners.size, 0);
});

test("D-DS-1: NavigationGuard renders nothing at all, on the server or in the browser", () => {
  assert.equal(renderToStaticMarkup(createElement(NavigationGuard, { dirty: true, message: "Leave?" })), "");
  assert.equal(renderToStaticMarkup(createElement("div", null, createElement(NavigationGuard, { dirty: false, message: "Leave?" }))), "<div></div>");
});
