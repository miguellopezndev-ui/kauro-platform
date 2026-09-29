// The browser harness itself (B11 design D-E2E-1/2): the TLS edge serves the built application, every document carries the
// per-request nonce policy and the static headers, no policy violation fires, and axe finds no WCAG 2.2 A/AA violation.
// These are harness checks, not acceptance cases: no case of B11 is demonstrated by this file.
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("harness: the web liveness answers ok over the TLS edge, never cached, with the static security headers", async ({ request }) => {
  const response = await request.get("/livez");
  expect(response.status()).toBe(200);
  expect(await response.text()).toBe("ok\n");
  const headers = response.headers();
  expect(headers["cache-control"]).toContain("no-store");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["x-powered-by"]).toBeUndefined();
});

test("harness: a document carries a per-request nonce policy that every script element bears, raises no policy violation and has no axe WCAG 2.2 A/AA violation", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Content-Security-Policy/i.test(message.text())) violations.push(message.text());
  });
  const first = await page.goto("/no-such-page");
  expect(first?.status()).toBe(404);
  const policy = first?.headers()["content-security-policy"] ?? "";
  const nonce = /'nonce-([A-Za-z0-9+/]{22}==)'/.exec(policy)?.[1];
  expect(nonce).toBeDefined();
  expect(first?.headers()["cache-control"]).toContain("no-store");
  const scripts = await page.locator("script").evaluateAll((elements) => elements.map((e) => (e as unknown as { readonly nonce: string }).nonce));
  expect(scripts.length).toBeGreaterThan(0);
  for (const value of scripts) expect(value).toBe(nonce);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
  const second = await page.goto("/no-such-page");
  expect(second?.headers()["content-security-policy"]).not.toBe(policy);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
  expect(violations).toEqual([]);
});
