// The private-journey browser suite (Order 24): the built application behind the TLS edge (e2e/support/serve.mjs) with /api/v1 routed to a
// real api over the test harness (apps/api dist/test/o24-e2e-world.js: PostgreSQL 17 from PGBIN, the contract-fake identity issuer,
// synthetic data). Run after `pnpm run build` here and in apps/api: `pnpm run e2e:private` (playwright test -c e2e/private.config.ts; it lives in e2e/, the node-side harness). KAURO_E2E_CHANNEL
// names an installed browser channel (msedge, chrome) where Playwright's own Chromium is not installed. The edge needs `openssl` on PATH (on
// this Windows PC: C:/Program Files/Git/usr/bin) and PGBIN naming the PostgreSQL 17 binaries.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env["KAURO_E2E_PORT"] ?? 44300);
const apiPort = port + 10;
const channel = process.env["KAURO_E2E_CHANNEL"];
const worldFile = process.env["KAURO_E2E_WORLD"] ?? join(tmpdir(), `kauro-o24-e2e-world-${port}.json`);
// KAURO_E2E_CANDIDATE=on switches the O19A candidate's CLEAN without a target on in both the api world and the web (LOCAL only)
const candidate = process.env["KAURO_E2E_CANDIDATE"] === "on" ? "on" : "off";
process.env["KAURO_E2E_WORLD"] = worldFile;

export default defineConfig({
  testDir: ".",
  testMatch: /private-journey\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `https://localhost:${port}`, ignoreHTTPSErrors: true, trace: "off", screenshot: "off", video: "off" },
  projects: [{ name: channel ?? "chromium", use: { ...devices["Desktop Chrome"], ...(channel === undefined ? {} : { channel }) } }],
  webServer: [
    {
      command: "node ../../api/dist/test/o24-e2e-world.js",
      url: `http://127.0.0.1:${apiPort}/livez`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { KAURO_E2E_API_PORT: String(apiPort), KAURO_E2E_WORLD: worldFile, KAURO_E2E_CANDIDATE: candidate },
    },
    {
      command: "node support/serve.mjs",
      url: `https://localhost:${port}/livez`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { KAURO_E2E_PORT: String(port), KAURO_ENV: "LOCAL", KAURO_E2E_API_ORIGIN: `http://127.0.0.1:${apiPort}`, KAURO_LOCAL_PUBLICATION_ORIGIN: `http://127.0.0.1:${port + 2}`, KAURO_CANDIDATE_CLEAN_NO_TARGET: candidate === "on" ? "true" : "false" },
    },
  ],
});
