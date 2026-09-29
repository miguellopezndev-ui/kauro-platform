// The browser suite of @kauro/web (B11 design D-E2E-1): Playwright 1.63.0 with axe-core 4.13.0, against the built application
// behind the TLS edge (e2e/support/serve.mjs). Chromium (headless shell) runs every suite; Firefox and WebKit run when
// KAURO_E2E_ENGINES=all (the browser-privacy and keyboard suites of S067, S068 and R2-062 need all three engines).
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env["KAURO_E2E_PORT"] ?? 44300);
const all = process.env["KAURO_E2E_ENGINES"] === "all";

export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `https://localhost:${port}`,
    ignoreHTTPSErrors: true,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    ...(all ? [{ name: "firefox", use: { ...devices["Desktop Firefox"] } }, { name: "webkit", use: { ...devices["Desktop Safari"] } }] : []),
  ],
  webServer: {
    command: "node e2e/support/serve.mjs",
    url: `https://localhost:${port}/livez`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { KAURO_E2E_PORT: String(port) },
  },
});
