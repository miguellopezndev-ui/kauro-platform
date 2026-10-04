// B11 stage-1 integration (INT-1): the environment the browser suite gives the built server (playwright.config.ts) is one W3's host policy
// serves and W5a's public pages read their publication from. W5a named its publication fake with KAURO_PUBLIC_ORIGIN, which W3's host
// policy reads as the public host: in LOCAL, one host named and not the other is ONE_ORIGIN_ONLY, and every screen answers 503.
import assert from "node:assert/strict";
import { test } from "node:test";
import config from "../playwright.config.ts";
import { PUBLICATION_PATH } from "../src/public/capabilities.ts";
import { parseHostPolicy } from "../src/server/host-config.ts";
import { publicationUrl } from "../src/server/public-origins.ts";

test("B11 INT-1 seam, the browser suite's environment (D-TOPO-2, D-W5a-9, D-INT1-13): the server the suite starts serves both groups on its one local origin and reads the public pages' publication from the suite's fake", () => {
  const server = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
  const env = (server?.env ?? {}) as Readonly<Record<string, string | undefined>>;
  const port = Number(env["KAURO_E2E_PORT"]);
  assert.ok(Number.isInteger(port) && port > 0, "the edge's port");
  const hosts = parseHostPolicy({ KAURO_ENV: env["KAURO_ENV"], KAURO_PUBLIC_ORIGIN: env["KAURO_PUBLIC_ORIGIN"], KAURO_APP_ORIGIN: env["KAURO_APP_ORIGIN"] });
  assert.deepEqual(hosts, { ok: true, policy: { kind: "LOCAL" } }, "the local stack names no host: one origin serves both groups");
  assert.equal(
    publicationUrl({ KAURO_ENV: env["KAURO_ENV"], KAURO_PUBLIC_ORIGIN: env["KAURO_PUBLIC_ORIGIN"], KAURO_LOCAL_PUBLICATION_ORIGIN: env["KAURO_LOCAL_PUBLICATION_ORIGIN"] }),
    `http://127.0.0.1:${port + 2}${PUBLICATION_PATH}`,
    "the public pages read the suite's publication fake (the edge's port plus two)",
  );
});
