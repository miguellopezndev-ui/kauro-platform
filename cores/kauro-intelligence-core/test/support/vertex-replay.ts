/**
 * A fetchImpl that replays a hand-written recording (SIMULATED, never a live
 * call) and records what the transport wrote. No network.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { VertexFetch, VertexFetchInit } from '../../src/provider/vertex-transport.js';

export interface Recording {
  readonly label: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export function loadRecording(name: string): Recording {
  const path = fileURLToPath(new URL(`../../../test/support/vertex-recordings/${name}.json`, import.meta.url));
  const recording = JSON.parse(readFileSync(path, 'utf8')) as Recording;
  if (!/^SIMULATED/u.test(recording.label)) throw new Error(`recording ${name} is not labelled SIMULATED`);
  return recording;
}

/** Everything the transport wrote to one fetch. */
export interface Written {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: Uint8Array;
  readonly text: string;
}

export async function drain(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    parts.push(step.value);
  }
  return Buffer.concat(parts);
}

export const streamOf = (chunks: readonly Uint8Array[], failAfter: Error | null = null): ReadableStream<Uint8Array> => {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller): void {
      const chunk = chunks[index];
      if (chunk !== undefined) {
        index += 1;
        controller.enqueue(chunk);
      } else if (failAfter !== null) controller.error(failAfter);
      else controller.close();
    },
  });
};

export const split = (bytes: Uint8Array, size: number): Uint8Array[] => {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, Math.min(bytes.length, at + size)));
  return out;
};

export interface Replay {
  readonly fetchImpl: VertexFetch;
  readonly writes: Written[];
}

/** Replays `recording`; `{{PROMPT}}` in its body text is replaced by the request text as the echoing providers do. `chunkSize` splits the answer. */
export function replay(recording: Recording, options: { readonly chunkSize?: number; readonly transform?: (bytes: Uint8Array) => Uint8Array; readonly failAfterBody?: Error } = {}): Replay {
  const writes: Written[] = [];
  const fetchImpl: VertexFetch = async (url: string, init: VertexFetchInit) => {
    const bytes = await drain(init.body);
    const text = Buffer.from(bytes).toString('utf8');
    writes.push({ url, headers: init.headers, bytes, text });
    const raw = JSON.stringify(recording.body).replaceAll('{{PROMPT}}', () => JSON.stringify(text).slice(1, -1));
    const answer = options.transform === undefined ? Buffer.from(raw, 'utf8') : options.transform(Buffer.from(raw, 'utf8'));
    const chunks = options.chunkSize === undefined ? [answer] : split(answer, options.chunkSize);
    return new Response(streamOf(chunks, options.failAfterBody ?? null), { status: recording.status, headers: recording.headers });
  };
  return { fetchImpl, writes };
}
