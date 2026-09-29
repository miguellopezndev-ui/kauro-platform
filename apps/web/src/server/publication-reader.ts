// The server-side read of the capability publication (design D-TOPO-2: the public site reads only public data, server-side, uncached).
// It sends no credential (the route reads none), asks for a fresh answer, follows no redirect, gives up after a short time, refuses a
// reply larger than a publication can be, and turns every failure into UNAVAILABLE: a page must render whatever the api does.
import { UNAVAILABLE, parsePublication, type Publication } from "../public/capabilities.ts";

const DEFAULT_TIMEOUT_MS = 3000;
/** Three modes with their identifiers and versions fit in well under a kilobyte; this is the ceiling of what is read at all. */
const MAX_BYTES = 65_536;

export interface ReaderOptions {
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
}

async function boundedText(response: Response): Promise<string | null> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

/** The publication at `url`, or UNAVAILABLE. A null address (no public origin named) reads nothing. Never throws. */
export async function readPublication(url: string | null, options: ReaderOptions = {}): Promise<Publication> {
  if (url === null) return UNAVAILABLE;
  const fetcher = options.fetcher ?? fetch;
  try {
    const response = await fetcher(url, {
      method: "GET",
      headers: { accept: "application/json", "cache-control": "no-store" },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return UNAVAILABLE;
    }
    const text = await boundedText(response);
    return text === null ? UNAVAILABLE : parsePublication(JSON.parse(text) as unknown);
  } catch {
    return UNAVAILABLE;
  }
}
