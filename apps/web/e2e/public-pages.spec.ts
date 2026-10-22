// The public pages in a real browser (W5a; D-A11Y-1, D-SEC-1, D-TOPO-2): every page in every reading of the capability publication under the
// built server's nonce policy with axe finding no WCAG 2.2 A/AA violation, 320 px reflow, the skip link, the fit form's every outcome with
// focus and live-region behaviour, the estimator, the unavailable pages and the legal refusal. The publication is the CONTRACT_FAKE of
// e2e/support/public-api.ts (read by the server on each request); the inquiry POST is answered at the browser's network boundary
// (page.route), so what the page sends is inspected as sent. B11 has no case-map case for W5a: these are the mandate's own checks.
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Response } from "@playwright/test";
import { startPublicApi, type PublicApi, type Reading } from "./support/public-api.ts";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const UUID = "0192d3a4-5b6c-7d8e-9f01-23456789abcd";

interface PageUnderTest {
  readonly route: string;
  readonly h1: string;
  /** Whether the page's text depends on the capability publication. */
  readonly reads: boolean;
}

const PAGES: readonly PageUnderTest[] = [
  { route: "/", h1: "Prepare and verify CRM data from files.", reads: true },
  { route: "/how-it-works", h1: "From source files to a reviewed import package.", reads: false },
  { route: "/supported-services", h1: "Check your files and target before you start.", reads: true },
  { route: "/pricing", h1: "One scoped project, priced by source units.", reads: true },
  { route: "/sample-delivery", h1: "See a synthetic delivery package.", reads: false },
  { route: "/security", h1: "Know what is processed and when it is deleted.", reads: false },
  { route: "/contact", h1: "Request a free data health check.", reads: false },
  { route: "/status", h1: "Current service availability.", reads: true },
  { route: "/help", h1: "Find the next step for your project.", reads: false },
  { route: "/unsubscribe/an-opaque-value-from-a-link", h1: "Stop optional messages.", reads: false },
];

const READINGS: ReadonlyArray<readonly [string, Reading]> = [
  ["all three services listed", [["CLEAN", "AVAILABLE"], ["HUBSPOT", "AVAILABLE"], ["SALESFORCE", "AVAILABLE"]]],
  ["one service limited and one listed", [["CLEAN", "AVAILABLE_LIMITED"], ["HUBSPOT", "AVAILABLE"]]],
  ["no service listed", []],
  ["the publication unreadable", "BROKEN"],
];

let api: PublicApi;
test.beforeAll(async () => {
  api = await startPublicApi();
});
test.afterAll(async () => {
  await api.close();
});
test.beforeEach(() => {
  api.publish([["CLEAN", "AVAILABLE"], ["HUBSPOT", "AVAILABLE"], ["SALESFORCE", "AVAILABLE"]]);
});

/** What a page must never do: raise a policy violation or an error, fail to load a resource of its own, or ask any origin but its own for anything. */
function watch(page: Page): { readonly problems: string[] } {
  const problems: string[] = [];
  const own = `https://localhost:${process.env["KAURO_E2E_PORT"] ?? 44300}`;
  page.on("console", (message) => {
    // a deliberate 4xx or 5xx answer to the inquiry is logged by the browser as a failed load: the response listener below judges loads
    if (/Content Security Policy|Content-Security-Policy/i.test(message.text())) problems.push(`policy: ${message.text()}`);
    else if (message.type() === "error" && !/^Failed to load resource/.test(message.text())) problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (/^https?:$/.test(url.protocol) && url.origin !== own) problems.push(`request to another origin: ${request.url()}`);
  });
  page.on("response", (response) => {
    const request = response.request();
    if (request.resourceType() !== "document" && !request.url().endsWith("/api/v1/public/inquiries") && response.status() >= 400) problems.push(`${response.status()} for ${request.url()}`);
  });
  return { problems };
}

async function assertDocument(page: Page, response: Response | null, status: number): Promise<void> {
  expect(response?.status()).toBe(status);
  const headers = response?.headers() ?? {};
  const nonce = /'nonce-([A-Za-z0-9+/]{22}==)'/.exec(headers["content-security-policy"] ?? "")?.[1];
  expect(nonce, "the document carries a per-request nonce policy").toBeDefined();
  expect(headers["cache-control"]).toContain("no-store");
  const scripts = await page.locator("script").evaluateAll((elements) => elements.map((element) => (element as unknown as { readonly nonce: string }).nonce));
  for (const value of scripts) expect(value).toBe(nonce);
}

async function assertAccessible(page: Page): Promise<void> {
  // axe measures the page as a reader sees it once it rests. Home's walk plays its first step on arrival (the owner's film timeline), and
  // a row caught while it fades in from opacity 0 fails contrast on a colour nobody reads. So the check waits for every finite animation
  // to end: a condition, never a fixed time (Order 10, proof in order10/tools/flake-proof.mjs: mid-fade 5/5 fail, settled 5/5 clean).
  // Only what runs on the document's clock can end by itself: a scroll-driven animation rests where the scroll leaves it, and a paused
  // one rests where it stopped, so neither is waited for. The condition is read on every frame (an animation's finished promise does
  // not always settle inside the test's evaluation).
  await page.waitForFunction(
    () => document.getAnimations().every((animation) => animation.timeline !== document.timeline || animation.playState !== "running" || !Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity)),
    undefined,
    { polling: "raf" },
  );
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(" | ")}`)).toEqual([]);
}

// ---- every page, every reading --------------------------------------------------------------------------------------------------------

for (const { route, h1, reads } of PAGES) {
  for (const [name, reading] of reads ? READINGS : READINGS.slice(0, 1)) {
    test(`${route}${reads ? ` (${name})` : ""}: its own heading, a nonce policy every script bears, no policy violation and no axe WCAG 2.2 A/AA violation`, async ({ page }) => {
      api.publish(reading);
      const seen = watch(page);
      const response = await page.goto(route);
      await assertDocument(page, response, 200);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(h1);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.locator("main#kauro-main")).toHaveCount(1);
      expect(await page.title()).toMatch(/Kauro/);
      await assertAccessible(page);
      expect(seen.problems).toEqual([]);
    });
  }
}

test("every page reflows to one column at 320 CSS pixels with no horizontal scroll, in the widest reading", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  for (const { route } of PAGES) {
    await page.goto(route);
    const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(overflow.scroll, `${route} scrolls sideways`).toBeLessThanOrEqual(overflow.client);
  }
  await page.goto("/contact");
  await hydrated(page);
  await page.getByRole("button", { name: "Send inquiry" }).click();
  const summary = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(summary.scroll, "the error summary reflows").toBeLessThanOrEqual(summary.client);
});

// The web keeps the system families it was designed and reviewed with (owner, 2026-10-19; Inter is the printed report's face only): no page
// downloads a font, body and headings use the system stacks, and the notes use the Georgia stack. Checked on a root-layout page and a legal page.
for (const route of ["/sample-delivery", "/legal/terms"]) {
  test(`the web serves no font and keeps its system families (${route}) (owner's decision, 2026-10-19)`, async ({ page }) => {
    const fonts: string[] = [];
    page.on("request", (r) => {
      if (r.resourceType() === "font") fonts.push(r.url());
    });
    await page.goto(route);
    await page.evaluate(() => document.fonts.ready);
    const facts = await page.evaluate(() => {
      const family = (selector: string): string | null => {
        const el = document.querySelector(selector);
        return el === null ? null : getComputedStyle(el).fontFamily;
      };
      return { body: family("body"), h1: family("h1"), note: family(".kauro-site-margin"), faces: ((): number => {
        let count = 0;
        document.fonts.forEach(() => {
          count += 1;
        });
        return count;
      })() };
    });
    expect(fonts).toEqual([]);
    expect(facts.faces).toBe(0);
    expect(facts.body).toMatch(/^system-ui,/);
    expect(facts.h1).toMatch(/^"Segoe UI Variable Display", system-ui,|^system-ui,/);
    if (route === "/sample-delivery") expect(facts.note).toMatch(/^Georgia,/);
  });
}

test("the pages give the same reading twice in a row: the publication is read on every request, never cached", async ({ page }) => {
  api.publish([["CLEAN", "AVAILABLE"]]);
  await page.goto("/status");
  await expect(page.locator("main")).toContainText("Clean your data");
  await expect(page.locator("main")).not.toContainText("HubSpot");
  api.publish([["CLEAN", "AVAILABLE"], ["HUBSPOT", "AVAILABLE"]]);
  await page.goto("/status");
  await expect(page.locator("main")).toContainText("HubSpot");
  api.publish("BROKEN");
  await page.goto("/status");
  await expect(page.locator("main")).toContainText("Status cannot be shown");
  await expect(page.locator("main")).not.toContainText("HubSpot");
});

// ---- the frame ------------------------------------------------------------------------------------------------------------------------

test("keyboard: the skip link is the first stop, visible when focused, and moves focus to the main content", async ({ page }) => {
  await page.goto("/pricing");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  const box = await skip.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  // in front of everything, not merely on the screen: the sticky header must not cover it (independent review R-110-1)
  expect(await onTop(skip), "the focused skip link is not covered").toBe(true);
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("kauro-main");
});

/** Whether the element is what a pointer at its centre would reach: on screen and covered by nothing. */
async function onTop(locator: ReturnType<Page["locator"]>): Promise<boolean> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    return hit !== null && (hit === element || element.contains(hit));
  });
}

test("navigation: on a short screen (a phone in landscape) every link of the open menu can be reached by keyboard and by pointer (independent review R-110-2)", async ({ page }) => {
  await page.setViewportSize({ width: 568, height: 320 });
  await page.goto("/pricing");
  await page.locator(".kauro-site-menu summary").click();
  const links = page.getByRole("navigation", { name: "Main" }).getByRole("link");
  const count = await links.count();
  expect(count).toBeGreaterThan(5);
  for (let index = 0; index < count; index++) {
    const link = links.nth(index);
    await link.focus();
    expect(await onTop(link), `${await link.textContent()} is reachable`).toBe(true);
  }
  await links.last().click();
  await expect(page).toHaveURL(/\/contact$/);
});

test("one theme (owner, 2026-10-21): every page is dark, offers no theme choice, and the old preference route is gone", async ({ page, request }) => {
  for (const path of ["/", "/pricing", "/contact", "/legal/privacy"]) {
    await page.goto(path);
    expect(await page.evaluate(() => document.documentElement.hasAttribute("data-theme")), path).toBe(false);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), path).toBe("dark");
    await expect(page.locator("form[action*='/preferences/']"), path).toHaveCount(0);
  }
  const stored = await request.post("/preferences/theme", { form: { theme: "light" }, maxRedirects: 0 });
  expect(stored.status()).toBe(404);
  expect(stored.headers()["set-cookie"]).toBeUndefined();
});

test("How it works, the six stages: one open beside the timeline on a wide screen, none until tapped on a phone, previous and next move between them, a link opens its stage, and axe finds no violation", async ({ browser }) => {
  const wide = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
  const desk = await wide.newPage();
  await desk.goto("/how-it-works");
  await desk.locator(".kauro-path[data-ready]").waitFor();
  await expect(desk.locator(".kauro-path [aria-expanded='true']")).toHaveCount(1);
  await expect(desk.locator("#stage-files-panel")).toBeVisible();
  await desk.locator("#stage-decide-button").click();
  await expect(desk.locator("#stage-decide-button")).toHaveAttribute("aria-expanded", "true");
  await expect(desk.locator("#stage-files-panel")).toBeHidden();
  await desk.locator("#stage-decide-button").click();
  await expect(desk.locator("#stage-decide-panel"), "a wide screen always shows one stage").toBeVisible();
  await desk.locator("#stage-decide-panel .kauro-path-turn-next").click();
  await expect(desk.locator("#stage-quote-panel")).toBeVisible();
  await expect(desk.locator("#stage-quote-button")).toBeFocused();
  await assertAccessible(desk);
  await desk.goto("/how-it-works#stage-prepare");
  await desk.locator(".kauro-path[data-ready]").waitFor();
  await expect(desk.locator("#stage-prepare-panel"), "a link to a stage opens it").toBeVisible();
  await wide.close();

  const narrow = await browser.newContext({ viewport: { width: 375, height: 812 }, ignoreHTTPSErrors: true });
  const phone = await narrow.newPage();
  await phone.goto("/how-it-works");
  await phone.locator(".kauro-path[data-ready]").waitFor();
  await expect(phone.locator(".kauro-path [aria-expanded='true']"), "a phone starts with the six closed").toHaveCount(0);
  await expect(phone.locator(".kauro-path-panel:visible")).toHaveCount(0);
  await phone.locator("#stage-check-button").click();
  await expect(phone.locator("#stage-check-panel")).toBeVisible();
  await phone.locator("#stage-check-button").click();
  await expect(phone.locator("#stage-check-panel"), "a phone closes the open stage again").toBeHidden();
  await phone.locator("#stage-check-button").click();
  await phone.locator("#stage-check-panel .kauro-path-turn-next").click();
  await expect(phone.locator("#stage-decide-panel")).toBeVisible();
  await expect(phone.locator("#stage-check-panel")).toBeHidden();
  await assertAccessible(phone);
  await narrow.close();
});

test("navigation: the current page is marked in the main navigation, and every link of the navigations reaches a page that answers", async ({ page, request }) => {
  await page.goto("/pricing");
  // on a wide screen the main pages are in the header's line and the menu is not drawn (Order 11 round 2): one "Main" navigation is visible
  await expect(page.locator(".kauro-site-menu")).toBeHidden();
  const main = page.getByRole("navigation", { name: "Main" });
  await expect(main).toHaveCount(1);
  await expect(main.locator('a[aria-current="page"]')).toHaveText("Pricing");
  await expect(main.locator('a[aria-current="page"]')).toHaveCount(1);
  await expect(page.locator("header .kauro-site-header-cta")).toHaveAttribute("href", "/contact");
  const hrefs = await page.locator("header a, footer a").evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).getAttribute("href") ?? ""));
  expect(hrefs.length).toBeGreaterThan(8);
  for (const href of new Set(hrefs.filter((value) => value.startsWith("/") && value !== "/login"))) {
    const answer = await request.get(href);
    expect([200, 503], `${href} answers`).toContain(answer.status());
  }
});

// ---- the fit form ---------------------------------------------------------------------------------------------------------------------

async function hydrated(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const form = document.querySelector("main form[method='post']");
    return form !== null && Object.keys(form).some((key) => key.startsWith("__reactProps"));
  });
}

async function fillValid(page: Page): Promise<void> {
  await page.getByRole("radio", { name: "An agency preparing data for clients" }).check();
  await page.getByLabel("Your name").fill("Ada Example");
  await page.getByLabel("Work email").fill("ada@example.com");
  await page.getByLabel("Company", { exact: true }).fill("Example Agency");
  await page.getByLabel("How will your team receive the cleaned data?").selectOption("files-only");
  await page.getByLabel("Roughly how many records?").selectOption({ index: 1 });
  await page.getByLabel("When would you like to start?").selectOption("flexible");
}

const focusedGroupLabel = (page: Page): Promise<string | null> => page.evaluate(() => document.activeElement?.getAttribute("aria-labelledby") ?? null);

test("contact: an empty form sends nothing, moves focus to a summary that links to each field, and marks each field with its message", async ({ page }) => {
  let posted = 0;
  await page.route("**/api/v1/public/inquiries", async (route) => {
    posted += 1;
    await route.abort();
  });
  const seen = watch(page);
  await page.goto("/contact");
  await hydrated(page);
  await page.getByRole("button", { name: "Send inquiry" }).click();
  expect(await focusedGroupLabel(page)).toBe("contact-summary-heading");
  await expect(page.getByRole("group", { name: "Some answers need a look" }).getByRole("link")).toHaveCount(7);
  for (const [field, message] of [
    ["contact-name", "Enter your name."],
    ["contact-email", "Enter an email address such as name@company.com."],
    ["contact-company", "Enter your company."],
    ["contact-destination", "Choose how your team will receive the data."],
    ["contact-band", "Choose the nearest size."],
    ["contact-timing", "Choose when you would like to start."],
  ] as const) {
    const control = page.locator(`#${field}`);
    await expect(control).toHaveAttribute("aria-invalid", "true");
    // a field with a hint keeps it, and its message is named last (the size question says why it is asked)
    await expect(control).toHaveAttribute("aria-describedby", new RegExp(`^(?:\\S+ )?${field}-error$`));
    await expect(page.locator(`#${field}-error`)).toHaveText(message);
  }
  await expect(page.locator("#contact-buyer")).toHaveAttribute("aria-describedby", "contact-buyer-error");
  await page.getByRole("link", { name: "Enter your name." }).click();
  await expect(page.locator("#contact-name")).toBeFocused();
  await assertAccessible(page);
  expect(posted, "nothing was sent").toBe(0);
  expect(seen.problems).toEqual([]);
});

test("contact: a valid inquiry is sent once, as the api's vocabulary, with no cookie and no credential, and the received panel takes focus and says the reference", async ({ page }) => {
  const bodies: string[] = [];
  const cookies: Array<string | undefined> = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/public/inquiries", async (route) => {
    bodies.push(route.request().postData() ?? "");
    cookies.push(route.request().headers()["cookie"]);
    await held;
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ inquiryId: UUID }) });
  });
  const seen = watch(page);
  await page.goto("/contact");
  await hydrated(page);
  await fillValid(page);
  await page.getByLabel("Anything we should know? (optional)").fill("Two CRMs to merge before a migration.");
  const send = page.getByRole("button", { name: "Send inquiry" });
  await send.click();
  await expect(page.getByRole("status").filter({ hasText: "Sending your inquiry." })).toHaveCount(1);
  await expect(send).toHaveAttribute("aria-disabled", "true");
  await send.click({ force: true });
  await page.keyboard.press("Enter");
  release();
  await expect(page.getByRole("heading", { name: "We received your inquiry" })).toBeVisible();
  expect(await focusedGroupLabel(page)).toBe("contact-outcome-heading");
  await expect(page.getByRole("group", { name: "We received your inquiry" })).toContainText(UUID);
  // the inquiry form is gone from the page's main region (the header's theme control is a form of its own and stays)
  await expect(page.locator("main form[method='post']")).toHaveCount(0);
  expect(bodies, "a second press while sending sends nothing").toHaveLength(1);
  expect(JSON.parse(bodies[0] ?? "null")).toEqual({
    buyerType: "agency",
    contactName: "Ada Example",
    contactEmail: "ada@example.com",
    companyName: "Example Agency",
    destination: "files-only",
    recordBand: expect.stringMatching(/^up-to-\d+$/),
    timing: "flexible",
    description: "Two CRMs to merge before a migration.",
  });
  expect(cookies).toEqual([undefined]);
  await assertAccessible(page);
  expect(seen.problems).toEqual([]);
});

const REPLIES: ReadonlyArray<{ readonly name: string; readonly status: number; readonly body: unknown; readonly heading: string; readonly text: RegExp }> = [
  { name: "the api refuses the content", status: 422, body: { code: "CONTENT_REFUSED" }, heading: "Nothing was sent", text: /credential or customer records/ },
  { name: "the api limits admission and says when to return", status: 429, body: { code: "ADMISSION_LIMITED", retryAfterSeconds: 90 }, heading: "Too many inquiries for now", text: /Please try again in 2 minutes\. Nothing you typed has been lost\./ },
  { name: "the api limits admission and says nothing more", status: 429, body: { code: "ADMISSION_LIMITED" }, heading: "Too many inquiries for now", text: /Please try again in a little while\./ },
  { name: "the api refuses the fields", status: 400, body: { code: "INVALID_REQUEST" }, heading: "Some answers need a look", text: /The inquiry was not accepted as written\./ },
  { name: "the api answers something the contract does not describe", status: 500, body: { code: "SOMETHING_ELSE" }, heading: "The inquiry could not be sent", text: /safe to retry/ },
];

for (const reply of REPLIES) {
  test(`contact: when ${reply.name}, the panel takes focus, the answers stay in the form, and axe finds no violation`, async ({ page }) => {
    await page.route("**/api/v1/public/inquiries", (route) => route.fulfill({ status: reply.status, contentType: "application/json", body: JSON.stringify(reply.body) }));
    const seen = watch(page);
    await page.goto("/contact");
    await hydrated(page);
    await fillValid(page);
    await page.getByRole("button", { name: "Send inquiry" }).click();
    const panel = page.getByRole("group", { name: reply.heading });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(reply.text);
    expect(await focusedGroupLabel(page)).toBe("contact-outcome-heading");
    await expect(page.getByLabel("Your name")).toHaveValue("Ada Example");
    await expect(page.getByLabel("Work email")).toHaveValue("ada@example.com");
    await assertAccessible(page);
    expect(seen.problems).toEqual([]);
  });
}

test("contact: a request that never reaches the api is a failure the visitor can send again, and the second send is the same inquiry", async ({ page }) => {
  const bodies: string[] = [];
  let attempts = 0;
  await page.route("**/api/v1/public/inquiries", async (route) => {
    attempts += 1;
    bodies.push(route.request().postData() ?? "");
    if (attempts === 1) await route.abort("connectionreset");
    else await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ inquiryId: UUID }) });
  });
  await page.goto("/contact");
  await hydrated(page);
  await fillValid(page);
  await page.getByRole("button", { name: "Send inquiry" }).click();
  await expect(page.getByRole("group", { name: "The inquiry could not be sent" })).toBeVisible();
  await page.getByRole("button", { name: "Send inquiry" }).click();
  await expect(page.getByRole("heading", { name: "We received your inquiry" })).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
});

test("contact: an address that is not one is told so before anything is sent", async ({ page }) => {
  let posted = 0;
  await page.route("**/api/v1/public/inquiries", async (route) => {
    posted += 1;
    await route.abort();
  });
  await page.goto("/contact");
  await hydrated(page);
  await fillValid(page);
  await page.getByLabel("Work email").fill("ada at example");
  await page.getByRole("button", { name: "Send inquiry" }).click();
  await expect(page.locator("#contact-email-error")).toHaveText("Enter an email address such as name@company.com.");
  await expect(page.getByRole("group", { name: "Some answers need a look" }).getByRole("link")).toHaveCount(1);
  expect(posted).toBe(0);
});

test("no scripts: the fit form and the estimator each say they need scripts, in words on the page", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true, baseURL: `https://localhost:${process.env["KAURO_E2E_PORT"] ?? 44300}` });
  try {
    const page = await context.newPage();
    await page.goto("/contact");
    // the text engine of the tool skips a noscript element by design, so the note is addressed by structure
    await expect(page.locator("noscript > p")).toHaveText("This form needs JavaScript to send your inquiry.");
    await expect(page.locator("noscript > p")).toBeVisible();
    await page.goto("/pricing");
    await expect(page.locator("noscript > p")).toHaveText("The estimate needs JavaScript. The table below shows every band and price.");
    await expect(page.locator("noscript > p")).toBeVisible();
  } finally {
    await context.close();
  }
});

// ---- the estimator --------------------------------------------------------------------------------------------------------------------

test("pricing: the estimator answers in a polite live region only when asked, in words a screen reader can read, and never as a quote", async ({ page }) => {
  await page.goto("/pricing");
  await page.waitForFunction(() => {
    const form = document.querySelector("form.kauro-r2-estimator");
    return form !== null && Object.keys(form).some((key) => key.startsWith("__reactProps"));
  });
  const result = page.locator("#estimate-result");
  await expect(result).toHaveAttribute("role", "status");
  await expect(result).toContainText("Enter a number to see the indicative band.");
  await page.getByLabel("Billable source units").fill("many");
  await expect(result, "typing announces nothing").toContainText("Enter a number to see the indicative band.");
  await page.getByRole("button", { name: "Show the indicative band" }).click();
  await expect(result, "no service is chosen for the visitor").toContainText("Choose a service to see the indicative band.");
  await page.getByLabel("Prepare for HubSpot").check();
  await page.getByRole("button", { name: "Show the indicative band" }).click();
  await expect(result).toContainText("Enter a whole number of units, such as 42,000.");
  await page.getByLabel("Billable source units").fill("42,000");
  await page.getByRole("button", { name: "Show the indicative band" }).press("Enter");
  await expect(result).toContainText(/Indicative band for Prepare for HubSpot: .+ units, .+\. This is an estimate and reserves nothing\./);
  await page.getByLabel("Clean your data").check();
  await page.getByRole("button", { name: "Show the indicative band" }).click();
  await expect(result).toContainText(/for Clean your data/);
  await assertAccessible(page);
});

test("pricing: a service the publication does not list says it cannot be bought, beside the estimate", async ({ page }) => {
  api.publish([["CLEAN", "AVAILABLE"]]);
  await page.goto("/pricing");
  await page.waitForFunction(() => {
    const form = document.querySelector("form.kauro-r2-estimator");
    return form !== null && Object.keys(form).some((key) => key.startsWith("__reactProps"));
  });
  await page.getByLabel("Billable source units").fill("42,000");
  await page.getByLabel("Prepare for Salesforce").check();
  await page.getByRole("button", { name: "Show the indicative band" }).click();
  await expect(page.locator("#estimate-result")).toContainText("Salesforce is not available for purchase right now.");
});

// ---- the pages that refuse ------------------------------------------------------------------------------------------------------------

// UI49 as B12 built it (L-ACT, "UI49 form" and "UI49 submit"): one explicit button posts the RFC 8058 one-click body to the api's opt-out
// route. The unit tests hold the markup and the request contract; this case holds what only a browser shows: opening the link changes
// nothing, the press sends once, each answer is said, and the essential notices stay apart, and the page is accessible.
test("unsubscribe (UI49): opening the link sends nothing and never shows the value; one explicit press sends the one-click body once; failure, limit and success are said; essential notices stay apart; accessible", async ({ page }) => {
  const token = "abc123-not-a-real-token";
  const optOut = `/api/v1/public/outreach/opt-out/${token}`;
  const posts: Array<{ readonly method: string; readonly body: string; readonly type: string | undefined; readonly cookie: string | undefined }> = [];
  let status = 500;
  let held: Promise<void> = Promise.resolve();
  await page.route(`**${optOut}`, async (route) => {
    const request = route.request();
    posts.push({ method: request.method(), body: request.postData() ?? "", type: request.headers()["content-type"], cookie: request.headers()["cookie"] });
    await held;
    await route.fulfill({ status, contentType: "application/json", body: "{}" });
  });

  // opening the page (a GET, as a mail client's prefetch would) changes nothing
  const seen = watch(page);
  await assertDocument(page, await page.goto(`/unsubscribe/${token}`), 200);
  await hydrated(page);
  expect(posts, "opening the link sends no opt-out").toEqual([]);
  expect(seen.problems).toEqual([]);
  expect(await page.locator("body").innerText(), "the value is not page text").not.toContain(token);
  expect(await page.title(), "nor the title").not.toContain(token);

  // one explicit action, and the essential notices apart from it
  const form = page.locator("main form[method='post']");
  await expect(form).toHaveCount(1);
  await expect(form).toHaveAttribute("action", optOut);
  const stop = page.getByRole("button", { name: "Stop optional messages" });
  await expect(stop).toBeVisible();
  const essential = page.getByRole("region", { name: "Notices you will still receive" });
  await expect(essential).toContainText("this page never turns them off");
  await expect(essential.locator("form, button, input")).toHaveCount(0);
  await assertAccessible(page);

  // a failure is said and the press can be repeated; a limit says to wait
  await stop.click();
  await expect(page.locator("main").getByRole("alert")).toContainText("it is safe to repeat");
  await expect(stop).toBeEnabled();
  status = 429;
  await stop.click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Wait a few minutes");

  // success is said only after the api's 200, and a second press while sending sends nothing
  status = 200;
  let release!: () => void;
  held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const before = posts.length;
  await stop.click();
  await expect(stop).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Optional messages stopped" })).toHaveCount(0);
  await stop.click({ force: true });
  release();
  await expect(page.getByRole("heading", { name: "Optional messages stopped" })).toBeVisible();
  expect(posts.length - before, "one press, one request").toBe(1);
  for (const post of posts) {
    expect(post.method).toBe("POST");
    expect(post.body).toBe("List-Unsubscribe=One-Click");
    expect(post.type).toContain("application/x-www-form-urlencoded");
    expect(post.cookie, "no credential is sent").toBeUndefined();
  }
  await expect(page.locator("main form[method='post']")).toHaveCount(0);
  await expect(essential).toBeVisible();
  await assertAccessible(page);
});

for (const document of ["terms", "privacy", "data-processing"]) {
  test(`legal ${document}: with the operator's facts unknown the page is refused with 503, says it is not published and names no version, and axe finds no violation`, async ({ page }) => {
    const seen = watch(page);
    const response = await page.goto(`/legal/${document}`);
    await assertDocument(page, response, 503);
    await expect(page.locator("body")).toContainText("This document is not published yet");
    expect(await page.content()).not.toMatch(new RegExp(`${document}-\\d{4}-\\d{2}-\\d{2}-[0-9a-f]{12}`));
    await assertAccessible(page);
    expect(seen.problems).toEqual([]);
  });
}
