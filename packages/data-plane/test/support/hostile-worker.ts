// TEST ONLY — a hostile worker (B14-A; docs/design/B14-A-worker-executor.md §8, B14-A-recovery.md): started by LocalProcessWorkerHost
// exactly as the real worker is (the same permission flags, the same empty environment, the same channel on fd 3 and broker), it tries
// what a misbehaving or compromised worker would and reports what happened, as the `refusal` of its one result (a JSON of observations;
// never a customer value). Its ticket's locale picks the behaviour: "hostile-probe" (files, network, environment, broker, and the local
// limit: a native child), "hostile-allocate" (memory), "hostile-spin" (stuck), "hostile-tree" (a stuck Node child and a browser in a
// session of its own, as Playwright starts one), or one of the channel's misuses ("hostile-garbage", "hostile-huge", "hostile-header",
// "hostile-message", "hostile-nodrain").
import { spawn, spawnSync } from "node:child_process";
import dns from "node:dns";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { FrameDecoder, WorkerRpc, encodeFrame, type HostMessage, type WorkerMessage, type WorkerResultReport } from "../../src/index.js";

const args = process.argv.slice(2);
const scratchRoot = args[args.indexOf("--scratch-root") + 1] as string;
const chromium = args[args.indexOf("--chromium") + 1] as string;
const browserTemp = args[args.indexOf("--browser-temp") + 1] as string;
const socket = new net.Socket({ fd: 3, readable: true, writable: true });
const send = (m: WorkerMessage, written?: () => void): void => void socket.write(encodeFrame(m), () => written?.());
const rpc = new WorkerRpc((m) => send(m));

function finish(observations: unknown): void {
  const result: WorkerResultReport = { state: "FAILED", cause: "WORKER_ERROR", manifest: null, refusal: JSON.stringify(observations), peakScratchBytes: 0, peakMemoryBytes: 0 };
  send({ t: "result", result }, () => process.exit(0));
}

const outcome = (f: () => unknown): string => {
  try {
    f();
    return "ALLOWED";
  } catch (error) {
    return String((error as { code?: unknown }).code ?? (error as Error).name);
  }
};

const settle = async (f: () => Promise<unknown>): Promise<string> => {
  try {
    await f();
    return "ALLOWED";
  } catch (error) {
    return String((error as { code?: unknown }).code ?? (error as Error).name);
  }
};

async function probe(ticket: { capability: { stagingPrefix: string } }, probeData: { port: number; neighbourObject: string; neighbourGeneration: string; neighbourPrefix: string; otherScratchFile: string; secretFile: string; hostRecords: string }): Promise<void> {
  const observations: Record<string, unknown> = {};
  observations["envKeys"] = Object.keys(process.env).sort();
  observations["readOtherAttemptScratch"] = outcome(() => readFileSync(probeData.otherScratchFile));
  observations["readHostRecords"] = outcome(() => readFileSync(probeData.hostRecords));
  observations["readSecretFile"] = outcome(() => readFileSync(probeData.secretFile));
  observations["writeOutsideOwnScratch"] = outcome(() => writeFileSync(join(scratchRoot, "escape.txt"), "x"));
  observations["writeHostRoot"] = outcome(() => writeFileSync(join(dirname(probeData.hostRecords), "planted.json"), "x"));
  observations["procEnvironOfHost"] = process.platform === "linux" ? outcome(() => readFileSync(`/proc/${process.ppid}/environ`)) : "NOT_LINUX";
  observations["netConnect"] = await settle(
    () =>
      new Promise<void>((resolve, reject) => {
        try {
          const s = net.connect({ host: "127.0.0.1", port: probeData.port }, () => resolve());
          s.on("error", reject);
        } catch (error) {
          reject(error);
        }
      }),
  );
  observations["fetch"] = await settle(() => fetch(`http://127.0.0.1:${probeData.port}/`));
  observations["dnsLookup"] = await settle(() => dns.promises.lookup("example.com"));
  observations["brokerForeignSource"] = await settle(() => rpc.call({ op: "storage.readOpen", zone: "ACCEPTED", objectName: probeData.neighbourObject, generation: probeData.neighbourGeneration }));
  observations["brokerForeignPrefix"] = await settle(() => rpc.call({ op: "storage.createSession", zone: "STAGING", objectName: `${probeData.neighbourPrefix}00000000-0000-8000-8000-000000000000`, declaredBytes: 1, contentType: "x", timeoutMs: 1000 }));
  observations["brokerDelivery"] = await settle(() => rpc.call({ op: "storage.readOpen", zone: "DELIVERY" as never, objectName: `${ticket.capability.stagingPrefix}x`, generation: "1" }));
  // THE LOCAL LIMIT (B14-A-recovery.md §6): the worker may start processes (the core's child, the browser), and a native program it
  // starts is outside Node's permission model. A compromised worker could read the host user's files this way; the boundary against
  // it is the cloud task, not the local host. Observed, not hidden.
  const nativeRead = process.platform === "win32" ? spawnSync(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "cmd.exe"), ["/d", "/c", "type", probeData.secretFile], { encoding: "utf8", windowsHide: true }) : spawnSync("/bin/cat", [probeData.secretFile], { encoding: "utf8" });
  observations["nativeChildRead"] = String(nativeRead.stdout ?? "").includes("a secret of the host") ? "READ" : String(nativeRead.error ?? `EXIT_${nativeRead.status}`);
  finish(observations);
}

/** The channel's misuses: each is outside the protocol, and the host must end the attempt without ending itself. */
function misuse(locale: string, ticket: { capability: { stagingPrefix: string } }): boolean {
  const prefix = (header: number, body: number): Buffer => {
    const b = Buffer.alloc(8);
    b.writeUInt32BE(header, 0);
    b.writeUInt32BE(body, 4);
    return b;
  };
  switch (locale) {
    case "hostile-garbage":
      // bytes that are no frame at all (a header length of zero)
      socket.write(Buffer.alloc(64, 0));
      return true;
    case "hostile-huge": {
      // review round 21 (R21-2): a frame declaring a 4 GiB body, its bytes trickled with one reusable buffer
      socket.write(prefix(16, 0xffffffff));
      const piece = Buffer.alloc(64 * 1024, 1);
      const trickle = (): void => void socket.write(piece, () => setTimeout(trickle, 1));
      trickle();
      return true;
    }
    case "hostile-header": {
      // review round 21 (R21-1): a frame whose header is not UTF-8 JSON
      const header = Buffer.from([0xff, 0x00, 0xfe, 0x01]);
      socket.write(Buffer.concat([prefix(header.byteLength, 0), header]));
      return true;
    }
    case "hostile-message":
      // review round 20 (R20-1): well-framed, but no message of the protocol (Node's own IPC commands, a call without an id)
      socket.write(encodeFrame({ cmd: "NODE_HANDLE_ACK" }));
      socket.write(encodeFrame({ t: "call", call: { op: "storage.stat" } }));
      return true;
    case "hostile-nodrain": {
      // review round 19 (R19-1): it stops reading its channel and keeps asking — the host must stop reading too, never queue replies
      socket.pause();
      socket.removeAllListeners("data");
      let id = 1_000_000;
      const objectName = `${ticket.capability.stagingPrefix}00000000-0000-8000-8000-000000000000`;
      const flood = (): void => {
        let more = true;
        for (let i = 0; i < 200 && more; i++) more = socket.write(encodeFrame({ t: "call", id: id++, call: { op: "storage.stat", zone: "STAGING", objectName } } satisfies WorkerMessage));
        setTimeout(flood, more ? 1 : 50);
      };
      flood();
      return true;
    }
    default:
      return false;
  }
}

/** Playwright's Chromium driver, as the PDF engine loads it. */
const chromiumOf = async (): Promise<{ launch(options: Record<string, unknown>): Promise<unknown> }> => (await import("playwright-core")).chromium as never;

const decoder = new FrameDecoder();
socket.on("data", (bytes: Buffer) => {
  decoder.push(bytes);
  for (let message = decoder.next() as HostMessage | null; message !== null; message = decoder.next() as HostMessage | null) {
    if (message.t !== "ticket") {
      rpc.receive(message);
      continue;
    }
    const doc = JSON.parse(Buffer.from(message.bytes).toString("utf8")) as { payload: { capability: { stagingPrefix: string }; render: { locale: string; rendererVersion: string } } };
    const ticket = doc.payload;
    const locale = ticket.render.locale;
    if (locale === "hostile-allocate") {
      // the heap, which --max-old-space-size bounds (a Buffer would be outside it)
      const hoard: number[][] = [];
      for (;;) hoard.push(new Array<number>(1_000_000).fill(hoard.length + 0.5));
    }
    if (locale === "hostile-tree") {
      // a tree like the real one's, each process naming the attempt's directory: a Node child stuck in synchronous work (the core's
      // child, hung), and the browser in a session of its own (POSIX), kept alive by its debugging pipe — then the stage the test holds
      const attemptDir = join(scratchRoot, `kauro-attempt-scratch-${(ticket as unknown as { capability: { attemptId: string } }).capability.attemptId}`);
      spawn(process.execPath, ["-e", "for (;;) Math.sqrt(Math.random())", attemptDir, "kauro-stuck-child"], { stdio: "ignore", windowsHide: true });
      // the browser as the PDF engine starts it (Playwright: on POSIX in a session of its own), with the worker's own environment and
      // the host's short temporary directory (a POSIX socket path is at most 107 bytes), marked on its command line
      // (as worker-runtime.ts does: the driver's profile in the attempt's own directory, which the worker may write; the browser's own
      // temporary files in the host's short directory)
      const own = join(attemptDir, "hostile-tmp");
      mkdirSync(own, { recursive: true });
      for (const name of ["TMPDIR", "TMP", "TEMP", "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) process.env[name] = own;
      const env: Record<string, string> = { ...(process.env as Record<string, string>), TMPDIR: browserTemp, TMP: browserTemp, TEMP: browserTemp };
      void chromiumOf().then((c) => c.launch({ executablePath: chromium, headless: true, chromiumSandbox: true, args: ["--kauro-hostile-browser"], env })).then(
        () => void rpc.stage("CORE_STARTED"),
        // never a silent hang: the test sees the attempt end, with the browser's error as its evidence
        (error: unknown) => finish({ browserFailed: String(error).slice(0, 4000) }),
      );
      setInterval(() => undefined, 1_000);
      return;
    }
    if (locale === "hostile-spin") {
      // stuck in synchronous work: no handler of its own can run any more
      for (;;) Math.sqrt(Math.random());
    }
    if (misuse(locale, ticket)) {
      setInterval(() => undefined, 1_000);
      return;
    }
    void probe(ticket, JSON.parse(ticket.render.rendererVersion) as Parameters<typeof probe>[1]);
  }
});
socket.on("close", () => process.exit(0));
// the host sends the ticket only once the worker says it runs
send({ t: "hello" });
