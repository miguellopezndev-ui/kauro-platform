// Tasks the tests run inside the real core child (under the permission model and the fs meter): the platform store (M24) and an
// isolation probe (M15b). Loaded only inside the child.
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AttemptScratchStore } from "../../src/attempt/scratch-store.js";
import type { CoreChildContext } from "../../src/cores/child-protocol.js";

function diskBytes(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    total += st.isDirectory() ? diskBytes(p) : st.size;
  }
  return total;
}

export async function run(payload: { mode: "store" | "probe"; root: string; attemptId: string; other: string; outside: string; quotaBytes: number }, context: CoreChildContext): Promise<unknown> {
  const ledger = context.meter.ledger();
  if (payload.mode === "probe") {
    const result: Record<string, unknown> = { env: Object.keys(process.env) };
    try {
      writeFileSync(payload.outside, "x");
      result["outside"] = "WRITTEN";
    } catch (error) {
      result["outside"] = (error as { code?: string }).code ?? "ERR";
    }
    try {
      const { promises } = await import("node:fs");
      await (promises as unknown as { writeFile(p: string, d: string): Promise<void> }).writeFile(join(payload.root, "p.txt"), "x");
      result["promises"] = "WRITTEN";
    } catch (error) {
      result["promises"] = (error as { code?: string }).code ?? "ERR";
    }
    try {
      const net = await import("node:net");
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port: 9 }, () => resolve());
        socket.on("error", reject);
      });
      result["network"] = "CONNECTED";
    } catch (error) {
      result["network"] = (error as { code?: string }).code ?? "ERR";
    }
    return result;
  }
  mkdirSync(payload.root, { recursive: true });
  const store = new AttemptScratchStore({ root: payload.root, attemptId: payload.attemptId, quotaBytes: payload.quotaBytes });
  const segment = store.createSegment({ schema: "m24", schemaVersion: "1" });
  for (let i = 0; i < 50; i += 1) segment.append(`line ${i} ${"x".repeat(40)}`);
  const manifest = segment.seal();
  const spool = store.openSpool();
  spool.write(Buffer.alloc(3000, 7));
  const sealed = spool.seal();
  let chunked = 0;
  for (const chunk of spool.chunks(1024)) chunked += chunk.bytes.byteLength;
  const mid = { live: ledger.live, disk: diskBytes(payload.root), segmentBytes: manifest.byteLength, spoolBytes: sealed.byteLength, chunked, peak: ledger.peak };
  spool.discard();
  store.dispose();
  const empty = new AttemptScratchStore({ root: payload.root, attemptId: payload.other, quotaBytes: payload.quotaBytes });
  empty.dispose();
  return { mid, end: { live: ledger.live, disk: diskBytes(payload.root) } };
}
