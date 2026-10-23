// Order 24: the private journey in a real browser against the real api (e2e/private.config.ts; synthetic data, SIMULATED identity).
// Signed in by the session the api issued (POST /api/v1/sessions through the contract-fake issuer; the sign-in screen UI50 is not built), a
// person reads the agency's projects from ListProjects, opens a project whose header and menu come from GetProject and ListClients, and reads
// its health check page; a viewer reads the same projects; the owner of another agency reaches none of them. Checked at 375 and 1280 px: no
// horizontal scroll, axe clean.
import { readFileSync } from "node:fs";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { message } from "../src/copy/en.ts";

interface World {
  readonly agencyA: string;
  readonly agencyB: string;
  readonly projects: { readonly clean: string; readonly hubspot: string; readonly foreign: string };
  readonly sessions: { readonly owner: string; readonly viewer: string; readonly stranger: string };
  /** The CLEAN project's free check, started with no target contract (KAURO_E2E_CANDIDATE=on only). */
  readonly cleanAudit: string | null;
}
const candidate = process.env["KAURO_E2E_CANDIDATE"] === "on";
const world = (): World => JSON.parse(readFileSync(process.env["KAURO_E2E_WORLD"] ?? "", "utf8")) as World;

async function signedIn(context: BrowserContext, secret: string): Promise<void> {
  await context.addCookies([{ name: "__Host-kauro_session", value: secret, domain: "localhost", path: "/", secure: true, httpOnly: true, sameSite: "Strict" }]);
}

async function checked(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${label}: no horizontal scroll`).toBe(0);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.map((v) => v.id), `${label}: axe`).toEqual([]);
}

for (const width of [1280, 375]) {
  test(`the owner reads the projects, opens one, and reads its health check (${width} px)`, async ({ browser }) => {
    const w = world();
    const context = await browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true, colorScheme: "dark" });
    await signedIn(context, w.sessions.owner);
    const page = await context.newPage();
    await page.goto(`/agencies/${w.agencyA}/projects`);
    await expect(page.getByRole("heading", { level: 1, name: message("screen.projects.title") })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: message("screen.projects.group.needs.title") })).toBeVisible();
    await expect(page.getByText(message("service.CLEAN.name")).first()).toBeVisible();
    await expect(page.getByText(message("service.HUBSPOT.name")).first()).toBeVisible();
    await checked(page, `UI11 ${width}`);

    // the switcher: the owner's one membership and its way in
    await page.goto("/agencies");
    await expect(page.getByRole("link", { name: message("screen.switcher.open.cta") })).toHaveAttribute("href", `/agencies/${w.agencyA}/projects`);
    await checked(page, `UI10 ${width}`);

    // the CLEAN project: its overview, its header and menu from GetProject and ListClients
    await page.goto(`/agencies/${w.agencyA}/projects/${w.projects.clean}`);
    await expect(page.getByRole("heading", { level: 1, name: "Quarterly cleanup" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: message("screen.overview.next.heading") })).toBeVisible();
    await expect(page.getByText(message("screen.projects.action.START_HEALTH_CHECK"))).toBeVisible();
    await checked(page, `UI13 ${width}`);

    // its health check page with no check named: the served wording, or the candidate's for CLEAN (no destination)
    await page.goto(`/agencies/${w.agencyA}/projects/${w.projects.clean}/audit`);
    await expect(page.getByText(message(candidate ? "screen.health.none.clean.body" : "screen.health.none.body"))).toBeVisible();
    await checked(page, `UI18 ${width}`);
    await context.close();
  });
}

test("a viewer reads the same projects; their role is named", async ({ browser }) => {
  const w = world();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
  await signedIn(context, w.sessions.viewer);
  const page = await context.newPage();
  await page.goto(`/agencies/${w.agencyA}/projects`);
  await expect(page.getByText(message("service.HUBSPOT.name")).first()).toBeVisible();
  await expect(page.getByText(message("shell.role.VIEWER.label")).first()).toBeVisible();
  await context.close();
});

test("the owner of another agency reaches none of agency A's projects", async ({ browser }) => {
  const w = world();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
  await signedIn(context, w.sessions.stranger);
  const page = await context.newPage();
  const seen: string[] = [];
  page.on("response", (r) => {
    if (r.url().includes("/api/v1/")) seen.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  // A's workspace under A's address: not available, nothing of A drawn
  await page.goto(`/agencies/${w.agencyA}/projects`);
  await expect(page.getByText(message("shell.agency.unavailable.body"))).toBeVisible();
  await expect(page.getByText(message("service.HUBSPOT.name"))).toHaveCount(0);
  // A's project under B's own address: the api answers as if it did not exist, and the page draws no project of A
  await page.goto(`/agencies/${w.agencyB}/projects/${w.projects.clean}`);
  await expect.poll(() => seen.some((s) => s === `404 /api/v1/projects/${w.projects.clean}`)).toBe(true);
  await expect(page.getByRole("heading", { level: 1, name: "Quarterly cleanup" })).toHaveCount(0);
  // the switcher lists B only: one way in, to B's own projects
  await page.goto("/agencies");
  await expect(page.getByRole("link", { name: message("screen.switcher.open.cta") })).toHaveCount(1);
  await expect(page.getByRole("link", { name: message("screen.switcher.open.cta") })).toHaveAttribute("href", `/agencies/${w.agencyB}/projects`);
  // B's own projects list B's project only
  await page.goto(`/agencies/${w.agencyB}/projects`);
  await expect(page.getByRole("heading", { level: 2, name: message("screen.projects.group.needs.title") })).toBeVisible();
  await expect(page.getByText(message("service.HUBSPOT.name")), "only A holds a HubSpot project").toHaveCount(0);
  await context.close();
});

test("O20 × O24 under the candidate switch: the CLEAN project's free check, started with no target contract, reads in the browser", async ({ browser }) => {
  test.skip(!candidate, "KAURO_E2E_CANDIDATE=on runs the api and the web with the O19A candidate switched on");
  const w = world();
  expect(w.cleanAudit).not.toBeNull();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
  await signedIn(context, w.sessions.owner);
  const page = await context.newPage();
  const audits: number[] = [];
  page.on("response", (r) => {
    if (r.url().includes(`/api/v1/audits/${w.cleanAudit}`)) audits.push(r.status());
  });
  await page.goto(`/agencies/${w.agencyA}/projects/${w.projects.clean}/audit?audit=${w.cleanAudit}`);
  await expect(page.getByRole("button", { name: message("screen.health.refresh.label") })).toBeVisible();
  expect(audits).toContain(200);
  await checked(page, "UI18 CLEAN audit");
  await context.close();
});
