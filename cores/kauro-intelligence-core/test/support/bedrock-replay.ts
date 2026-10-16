/**
 * A fetchImpl that replays a hand-written Bedrock recording (SIMULATED, never a
 * live call) and records what the transport wrote, headers included, so a test
 * can check the SigV4 headers. No network. The stream helpers are the Vertex
 * replay's own.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { BedrockFetch, BedrockFetchInit } from '../../src/provider/bedrock-transport.js';
import { drain, split, streamOf } from './vertex-replay.js';

export { drain, split, streamOf };

export interface BedrockRecording {
  readonly label: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export function loadBedrockRecording(name: string): BedrockRecording {
  const path = fileURLToPath(new URL(`../../../test/support/bedrock-recordings/${name}.json`, import.meta.url));
  const recording = JSON.parse(readFileSync(path, 'utf8')) as BedrockRecording;
  if (!/^SIMULATED/u.test(recording.label)) throw new Error(`recording ${name} is not labelled SIMULATED`);
  return recording;
}

export interface BedrockWritten {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: Uint8Array;
  readonly text: string;
}

export interface BedrockReplay {
  readonly fetchImpl: BedrockFetch;
  readonly writes: BedrockWritten[];
}

/** Replays `recording`; `{{PROMPT}}` in its body is replaced by the request text as the echoing providers do. `chunkSize` splits the answer. */
export function replayBedrock(recording: BedrockRecording, options: { readonly chunkSize?: number; readonly transform?: (bytes: Uint8Array) => Uint8Array; readonly failAfterBody?: Error } = {}): BedrockReplay {
  const writes: BedrockWritten[] = [];
  const fetchImpl: BedrockFetch = async (url: string, init: BedrockFetchInit) => {
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
