/**
 * The worker process (B14-A; docs/design/B14-A-worker-executor.md §3, §4). Started by a host with the ticket's digest, its scratch root,
 * the browser and the core child's heap on the command line, an empty environment and its host's channel on fd 3 (framing.ts):
 *
 *   1. the first message is the ticket; its bytes must hash to the digest it was started with and be one attempt's complete,
 *      self-consistent input (readAttemptTicket), or the worker ends REFUSED having touched nothing;
 *   2. runAttemptWorker runs the attempt (Migration Core, the report, the staged manifest) through the host's broker;
 *   3. the one result goes back on the channel, and the worker exits.
 *
 * It says `hello` first; the host sends the ticket only then. If its host's channel closes, the worker exits, and its attempt's boundary
 * ends everything it started with it (a PID namespace on Linux, its kill-on-close job on Windows): a worker never outlives the host that
 * observes it. The process clock below is the worker's one injection point (CK3).
 */
import { diagnosticOf, openWorkerChannel, readAttemptTicket, runAttemptWorker, WORKER_PROTOCOL_VERSION, WorkerRpc, type HostMessage, type WorkerChannel, type WorkerResultReport } from "@kauro/data-plane";
import { parseWorkerArguments } from "./arguments.js";

/** The worker's one process clock (CK3 injection point). */
const workerClock = { nowMs: (): number => Date.now() };

const TICKET_WAIT_MS = 30_000;

let finishing = false;
let onTicket: (bytes: Uint8Array) => void = () => undefined;
let rpc: WorkerRpc | null = null;

const channel: WorkerChannel | null = openWorkerChannel(
  (message: HostMessage) => {
    if (message?.t === "ticket" && message.protocol === WORKER_PROTOCOL_VERSION && message.bytes instanceof Uint8Array) onTicket(message.bytes);
    else rpc?.receive(message);
  },
  () => {
    // the host's end closed (or spoke outside the protocol): nothing observes this worker any more
    if (finishing) process.exit(0);
    rpc?.close("the host's channel closed");
    process.exit(70);
  },
);

/** Sends the one result, then exits once it has left this process. */
function finish(result: WorkerResultReport): void {
  finishing = true;
  if (channel === null || !channel.open) process.exit(0);
  try {
    channel.send({ t: "result", result }, () => process.exit(0));
  } catch {
    // the host is gone: nothing observes this result
    process.exit(0);
  }
}

const refused = (problem: string): WorkerResultReport => ({ state: "FAILED", cause: "REFUSED", manifest: null, refusal: problem, peakScratchBytes: 0, peakMemoryBytes: process.memoryUsage().rss });

async function main(): Promise<void> {
  if (channel === null) {
    process.stderr.write("kauro-migration-worker: started without its host's channel\n");
    process.exit(64);
  }
  const args = parseWorkerArguments(process.argv.slice(2));
  if ("problem" in args) {
    finish(refused(args.problem));
    return;
  }
  const calls = new WorkerRpc((message) => channel.send(message));
  rpc = calls;
  channel.send({ t: "hello" });
  // a sign of life between the core's cancellation checks too (the lease's heartbeat is the host's observation, D8-ATT-2)
  setInterval(() => {
    try {
      calls.beat();
    } catch {
      // the channel is closing: its close ends the worker
    }
  }, 30_000).unref();
  const ticketBytes = await new Promise<Uint8Array | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), TICKET_WAIT_MS);
    onTicket = (bytes) => {
      clearTimeout(timer);
      onTicket = () => undefined;
      resolve(bytes);
    };
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
    rpc: calls,
    scratchRoot: args.scratchRoot,
    chromiumExecutable: args.chromium,
    browserTemp: args.browserTemp,
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
