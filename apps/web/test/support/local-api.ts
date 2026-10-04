// CONTRACT_FAKE: the public routes of the api (W5b: GET /api/v1/public/capability-publication and POST /api/v1/public/inquiries) as a server
// on a free local port. `respond` decides each answer and `seen` records each request, so a test can prove what the web app sent. No
// provider and no database is involved; the contract it answers is the api's response schemas.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Seen {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface Answer {
  readonly status: number;
  readonly body: string | Buffer;
  readonly headers?: Record<string, string>;
}

export async function withServer(respond: (seen: Seen) => Answer | "HANG", run: (origin: string, seen: Seen[]) => Promise<void>): Promise<void> {
  const seen: Seen[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const record: Seen = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(record);
      const answer = respond(record);
      if (answer === "HANG") return; // never answers: the caller's own limit ends the exchange
      response.writeHead(answer.status, { "content-type": "application/json", ...(answer.headers ?? {}) });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, seen);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** An address on a free port where nothing listens. */
export async function closedOrigin(): Promise<string> {
  return await new Promise<string>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });
}
