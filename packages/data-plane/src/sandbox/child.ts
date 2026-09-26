/**
 * The entry of the isolated child (decision D-ISO-1). Started by the runner under the Node permission model with the preload
 * already installed: reads one job from stdin, imports the task module, runs it with the attempt scratch as its only writable
 * directory, and writes exactly one result record (the task's value or its failure, and the observers) to stdout.
 *
 * A failure is reported by its class and code with a message of this package's own making (the parsers never put a value of the
 * file into an error). Loaded inside the child: only node built-ins and this package's own child modules.
 */
import { pathToFileURL } from "node:url";
import { OBSERVER_KEY, RESULT_MARK, type IsolationObservers, type SandboxJob, type SandboxRecord } from "./observers.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

function emit(record: SandboxRecord, exitCode: number): void {
  process.stdout.write(`${RESULT_MARK}${JSON.stringify(record)}\n`, () => process.exit(exitCode));
}

const observers = (globalThis as unknown as Record<symbol, IsolationObservers | undefined>)[OBSERVER_KEY];
if (observers === undefined) {
  // the preload did not run: nothing may be inspected without its observers
  process.stdout.write(`${RESULT_MARK}${JSON.stringify({ outcome: { ok: false, error: { name: "SandboxError", code: "OBSERVERS_MISSING", message: "the isolation preload is not installed" } }, observers: { outsideWriteAttempts: 0, networkAttempts: 0, processAttempts: 0, network: [] } })}\n`, () => process.exit(70));
} else {
  const job = JSON.parse(await readStdin()) as SandboxJob;
  let record: SandboxRecord;
  try {
    const task = (await import(pathToFileURL(job.task).href)) as { run?: (payload: unknown, context: { readonly workDir: string }) => Promise<unknown> };
    if (typeof task.run !== "function") throw new TypeError("the task module exports no run function");
    const value = await task.run(job.payload, { workDir: job.workDir });
    record = { outcome: { ok: true, value }, observers: { ...observers, network: [...observers.network] } };
  } catch (error) {
    const e = error as { name?: unknown; code?: unknown; message?: unknown };
    record = {
      outcome: {
        ok: false,
        error: {
          name: typeof e.name === "string" ? e.name : "Error",
          ...(typeof e.code === "string" ? { code: e.code } : {}),
          message: typeof e.message === "string" ? e.message.slice(0, 512) : "task failed",
        },
      },
      observers: { ...observers, network: [...observers.network] },
    };
  }
  emit(record, 0);
}
