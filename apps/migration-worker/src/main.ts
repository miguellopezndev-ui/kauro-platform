/**
 * The worker process (B14-A; docs/design/B14-A-worker-executor.md §3, §4). Started by a host with the ticket's digest, its scratch root,
 * the browser and the core child's heap on the command line, an empty environment and a private IPC channel:
 *
 *   1. the first message is the ticket; its bytes must hash to the digest it was started with and be one attempt's complete,
 *      self-consistent input (readAttemptTicket), or the worker ends REFUSED having touched nothing;
 *   2. runAttemptWorker runs the attempt (Migration Core, the report, the staged manifest) through the host's broker;
 *   3. the one result goes back on the channel, and the worker exits.
 *
 * If its host's channel closes, the worker ends itself and everything it started (killOwnTree): a worker never outlives the host that
 * observes it. The process clock below is the worker's one injection point (CK3).
 */
import { diagnosticOf, killOwnTree, readAttemptTicket, runAttemptWorker, WORKER_PROTOCOL_VERSION, WorkerRpc, type HostMessage, type WorkerMessage, type WorkerResultReport } from "@kauro/data-plane";
import { parseWorkerArguments } from "./arguments.js";

/** The worker's one process clock (CK3 injection point). */
const workerClock = { nowMs: (): number => Date.now() };

const TICKET_WAIT_MS = 30_000;

function exitWith(code: number): never {
  process.exit(code);
}

const send = (message: WorkerMessage): void => {
  if (process.send === undefined || !process.connected) throw new Error("the host's channel is closed");
  process.send(message);
};

let finishing = false;

/** Sends the one result, then closes the channel once it is written; the process then exits. */
function finish(result: WorkerResultReport): void {
  finishing = true;
  if (process.send === undefined || !process.connected) exitWith(0);
  try {
    process.send({ t: "result", result } satisfies WorkerMessage, undefined, {}, () => process.disconnect?.());
  } catch {
    // the host is gone: nothing observes this result
    exitWith(0);
  }
}

const refused = (problem: string): WorkerResultReport => ({ state: "FAILED", cause: "REFUSED", manifest: null, refusal: problem, peakScratchBytes: 0, peakMemoryBytes: process.memoryUsage().rss });

async function main(): Promise<void> {
  if (process.send === undefined) {
    process.stderr.write("kauro-migration-worker: started without its host's channel\n");
    exitWith(64);
  }
  const args = parseWorkerArguments(process.argv.slice(2));
  if ("problem" in args) {
    finish(refused(args.problem));
    return;
  }
  const rpc = new WorkerRpc(send);
  // a sign of life between the core's cancellation checks too (the lease's heartbeat is the host's observation, D8-ATT-2)
  setInterval(() => {
    try {
      rpc.beat();
    } catch {
      // the channel is closing: the disconnect handler ends the worker
    }
  }, 30_000).unref();
  process.on("disconnect", () => {
    if (finishing) exitWith(0);
    rpc.close("the host's channel closed");
    killOwnTree();
  });
  const ticketBytes = await new Promise<Uint8Array | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), TICKET_WAIT_MS);
    process.on("message", (message: HostMessage) => {
      if (message?.t === "ticket" && message.protocol === WORKER_PROTOCOL_VERSION && message.bytes instanceof Uint8Array) {
        clearTimeout(timer);
        resolve(message.bytes);
      } else rpc.receive(message);
    });
  });
  if (ticketBytes === null) {
    finish(refused("TICKET_NOT_RECEIVED"));
    return;
  }
  const reading = readAttemptTicket(ticketBytes, args.ticketDigest);
  if (!reading.ok) {
    finish(refused(reading.problem));
    return;
  }
  const result = await runAttemptWorker(reading.ticket, {
    rpc,
    scratchRoot: args.scratchRoot,
    chromiumExecutable: args.chromium,
    clock: workerClock,
    coreHeapMegabytes: args.coreHeapMegabytes,
    storageEvidenceClass: args.storageEvidence,
    diagnostic: (line) => process.stderr.write(`${line}
`),
  });
  finish(result);
}

main().catch((error: unknown) => {
  process.stderr.write(`${diagnosticOf(error)}
`);
  // an error of the worker itself (never a customer value on the channel): WORKER_ERROR, which B08 retries in a new attempt
  finish({ state: "FAILED", cause: "WORKER_ERROR", manifest: null, refusal: null, peakScratchBytes: 0, peakMemoryBytes: process.memoryUsage().rss });
});
