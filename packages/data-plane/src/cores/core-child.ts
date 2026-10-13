/**
 * The entry of the core child (B05 D5-2): like sandbox/child.ts, but the job is the first stdin line and stdin stays open, so the
 * parent can pause the child at named progress points (a hold or a kill in a test; the real host never pauses) and release it with
 * an ACK line. The task runs with the fs meter configured to the quota the parent computed (budget minus the parent's live bytes).
 * Loaded inside the child under the permission model, after the isolation preload and the fs preload.
 */
import { pathToFileURL } from "node:url";
import { OBSERVER_KEY, RESULT_MARK, type IsolationObservers, type SandboxRecord } from "../sandbox/observers.js";
import { FS_METER_KEY, PROGRESS_MARK, type CoreChildContext, type CoreChildJob } from "./child-protocol.js";
import type { FsMeter } from "./fs-meter.js";

const observers = (globalThis as unknown as Record<symbol, IsolationObservers | undefined>)[OBSERVER_KEY];
const meter = (globalThis as unknown as Record<symbol, FsMeter | undefined>)[FS_METER_KEY];

const waiting: Array<(line: string) => void> = [];
const queued: string[] = [];
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const at = buffer.indexOf("\n");
    if (at < 0) break;
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    const waiter = waiting.shift();
    if (waiter !== undefined) waiter(line);
    else queued.push(line);
  }
});
function nextLine(): Promise<string> {
  const line = queued.shift();
  return line !== undefined ? Promise.resolve(line) : new Promise((resolve) => waiting.push(resolve));
}

function emit(record: SandboxRecord, exitCode: number): void {
  process.stdout.write(`${RESULT_MARK}${JSON.stringify(record)}\n`, () => process.exit(exitCode));
}

if (observers === undefined || meter === undefined) {
  process.stdout.write(`${RESULT_MARK}${JSON.stringify({ outcome: { ok: false, error: { name: "SandboxError", code: "OBSERVERS_MISSING", message: "the isolation or fs preload is not installed" } }, observers: { outsideWriteAttempts: 0, networkAttempts: 0, processAttempts: 0, network: [] } })}\n`, () => process.exit(70));
} else {
  const job = JSON.parse(await nextLine()) as CoreChildJob;
  meter.configure(job.quotaBytes);
  const pauses = new Set(job.pausePoints);
  const context: CoreChildContext = {
    workDir: job.workDir,
    meter,
    progress: async (point: string): Promise<void> => {
      process.stdout.write(`${PROGRESS_MARK}${point}\n`);
      if (pauses.has(point)) await nextLine();
    },
  };
  let record: SandboxRecord;
  try {
    const task = (await import(pathToFileURL(job.task).href)) as { run?: (payload: unknown, context: CoreChildContext) => Promise<unknown> };
    if (typeof task.run !== "function") throw new TypeError("the task module exports no run function");
    const value = await task.run(job.payload, context);
    record = { outcome: { ok: true, value }, observers: { ...observers, network: [...observers.network] } };
  } catch (error) {
    const e = error as { name?: unknown; code?: unknown; message?: unknown; details?: unknown; resource?: unknown };
    record = {
      outcome: {
        ok: false,
        error: {
          name: typeof e.name === "string" ? e.name : "Error",
          ...(typeof e.code === "string" ? { code: e.code } : {}),
          message: (typeof e.message === "string" ? e.message.slice(0, 480) : "task failed") + (typeof e.resource === "string" ? ` [${e.resource}]` : ""),
        },
      },
      observers: { ...observers, network: [...observers.network] },
    };
  }
  emit(record, 0);
}
