// CONTRACT_FAKE: the api's public capability publication (W5b: GET /api/v1/public/capability-publication) on a fixed local port, for the browser
// suite of the public pages. The built server reads it on every request (D-TOPO-2: server-side, uncached), and playwright.config.ts points
// the server's KAURO_LOCAL_PUBLICATION_ORIGIN at this port, so a test chooses what the public site is told by calling `publish`. No provider and no database
// is involved; the reply has exactly the shape the api's response schema declares. The inquiry POST is answered by the test itself at the browser
// network boundary (page.route), because the browser, not the server, sends it.
import { createServer, type Server } from "node:http";

/** The port of this fake: two above the edge, which owns `KAURO_E2E_PORT` and its server one above (the same arithmetic as playwright.config.ts). */
export function publicApiPort(): number {
  return Number(process.env["KAURO_E2E_PORT"] ?? 44300) + 2;
}

export type Reading = ReadonlyArray<readonly [mode: "CLEAN" | "HUBSPOT" | "SALESFORCE", state: "AVAILABLE" | "AVAILABLE_LIMITED"]> | "BROKEN";

export interface PublicApi {
  /** What the next reads of the publication get: the listed modes, or an api that fails. */
  publish(reading: Reading): void;
  close(): Promise<void>;
}

const CAPABILITY_ID = "0192d3a4-5b6c-7d8e-9f01-23456789abcd";

export async function startPublicApi(): Promise<PublicApi> {
  let reading: Reading = [];
  const server: Server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/api/v1/public/capability-publication") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"code":"NOT_FOUND"}');
      return;
    }
    if (reading === "BROKEN") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"code":"UNAVAILABLE"}');
      return;
    }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(
      JSON.stringify({
        observedAt: "2026-10-02T09:30:45.123Z",
        capabilities: reading.map(([mode, state]) => ({ capabilityId: CAPABILITY_ID, mode, version: "2026.10.0", state, validFrom: "2026-10-01T15:00:00.000Z" })),
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(publicApiPort(), "127.0.0.1", resolve);
  });
  return {
    publish(next) {
      reading = next;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
