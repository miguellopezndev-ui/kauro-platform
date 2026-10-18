// TEST ONLY — a hostile worker (B14-A; docs/design/B14-A-worker-executor.md §8): started by LocalProcessWorkerHost exactly as the real
// worker is (the same permission flags, the same empty environment, the same IPC channel and broker), it tries what a compromised worker
// would and reports what happened, as the `refusal` of its one result (a JSON of observations; never a customer value). Its ticket's
// locale picks the behaviour: "hostile-probe" (files, network, environment, broker, child processes) or "hostile-allocate" (memory).
import { execSync, spawn, spawnSync } from "node:child_process";
import dns from "node:dns";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { WorkerRpc, type HostMessage, type WorkerMessage, type WorkerResultReport } from "../../src/index.js";

const args = process.argv.slice(2);
const scratchRoot = args[args.indexOf("--scratch-root") + 1] as string;
const send = (m: WorkerMessage): void => void process.send?.(m);
const rpc = new WorkerRpc(send);

function finish(observations: unknown): void {
  const result: WorkerResultReport = { state: "FAILED", cause: "WORKER_ERROR", manifest: null, refusal: JSON.stringify(observations), peakScratchBytes: 0, peakMemoryBytes: 0 };
  process.send?.({ t: "result", result } satisfies WorkerMessage, undefined, {}, () => process.disconnect?.());
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

async function probe(ticket: { capability: { stagingPrefix: string }; render: { locale: string } }, probeData: { port: number; neighbourObject: string; neighbourGeneration: string; neighbourPrefix: string; otherScratchFile: string; secretFile: string; otherTicket: string }): Promise<void> {
  const observations: Record<string, unknown> = {};
  observations["envKeys"] = Object.keys(process.env).sort();
  observations["readOtherAttemptScratch"] = outcome(() => readFileSync(probeData.otherScratchFile));
  observations["readOtherJobTicket"] = outcome(() => readFileSync(probeData.otherTicket));
  observations["readSecretFile"] = outcome(() => readFileSync(probeData.secretFile));
  observations["writeOutsideOwnScratch"] = outcome(() => writeFileSync(join(scratchRoot, "escape.txt"), "x"));
  observations["writeHostRoot"] = outcome(() => writeFileSync(join(dirname(probeData.otherTicket), "planted.json"), "x"));
  observations["procEnvironOfHost"] = process.platform === "linux" ? outcome(() => readFileSync(`/proc/${process.ppid}/environ`)) : "NOT_LINUX";
  observations["netConnect"] = await settle(
    () =>
      new Promise<void>((resolve, reject) => {
        try {
          const socket = net.connect({ host: "127.0.0.1", port: probeData.port }, () => resolve());
          socket.on("error", reject);
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
  // child processes: the worker's process allowlist (worker-preload.ts) admits only Node under a permission no wider than the worker's,
  // the named browser and its own taskkill; every other way out is refused before a process exists
  const read = `try{require("fs").readFileSync(${JSON.stringify(probeData.secretFile)});console.log("READ")}catch(e){console.log(e.code)}`;
  const ran = (f: () => { stdout?: unknown; status?: number | null }): string => {
    try {
      const r = f();
      return String(r.stdout ?? "").includes("a secret of the host") || String(r.stdout ?? "").trim() === "READ" ? "READ" : String(r.stdout ?? "").trim() || `EXIT_${r.status}`;
    } catch (error) {
      return String((error as { code?: unknown }).code ?? (error as Error).name);
    }
  };
  observations["nodeChildPlain"] = ran(() => spawnSync(process.execPath, ["-e", read], { encoding: "utf8", env: {} }));
  observations["nodeChildWiderPermission"] = ran(() => spawnSync(process.execPath, ["--permission", "--allow-fs-read=*", "-e", read], { encoding: "utf8", env: {} }));
  observations["nodeChildOwnPermission"] = ran(() => spawnSync(process.execPath, ["--permission", `--allow-fs-read=${process.execPath}`, "-e", read], { encoding: "utf8", env: {} }));
  observations["nodeChildNodeOptions"] = ran(() => spawnSync(process.execPath, ["--permission", "-e", read], { encoding: "utf8", env: { NODE_OPTIONS: "--allow-fs-read=*" } }));
  observations["nativeChild"] = ran(() => (process.platform === "win32" ? spawnSync(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "cmd.exe"), ["/d", "/c", "type", probeData.secretFile], { encoding: "utf8", windowsHide: true }) : spawnSync("/bin/cat", [probeData.secretFile], { encoding: "utf8" })));
  observations["shellExec"] = ran(() => ({ stdout: execSync(process.platform === "win32" ? `type "${probeData.secretFile}"` : `cat "${probeData.secretFile}"`, { encoding: "utf8" }) }));
  observations["asyncSpawn"] = await new Promise<string>((resolve) => {
    try {
      const c = spawn(process.platform === "win32" ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "cmd.exe") : "/bin/cat", process.platform === "win32" ? ["/d", "/c", "type", probeData.secretFile] : [probeData.secretFile]);
      let out = "";
      c.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      c.on("close", () => resolve(out.includes("a secret of the host") ? "READ" : "NO_OUTPUT"));
      c.on("error", (e: { code?: string }) => resolve(String(e.code)));
    } catch (error) {
      resolve(String((error as { code?: unknown }).code ?? (error as Error).name));
    }
  });
  finish(observations);
}

process.on("message", (message: HostMessage) => {
  if (message?.t !== "ticket") {
    rpc.receive(message);
    return;
  }
  const doc = JSON.parse(Buffer.from(message.bytes).toString("utf8")) as { payload: { capability: { stagingPrefix: string }; render: { locale: string; rendererVersion: string } } };
  const ticket = doc.payload;
  if (ticket.render.locale === "hostile-allocate") {
    // the heap, which --max-old-space-size bounds (a Buffer would be outside it)
    const hoard: number[][] = [];
    for (;;) hoard.push(new Array<number>(1_000_000).fill(hoard.length + 0.5));
  }
  if (ticket.render.locale === "hostile-buffers") {
    // native memory outside the heap, touched so it is resident: only the supervisor's view of the tree bounds it
    const hoard: Buffer[] = [];
    const grow = (): void => {
      hoard.push(Buffer.alloc(32 * 1024 * 1024, hoard.length % 251));
      setTimeout(grow, 20);
    };
    grow();
    return;
  }
  if (ticket.render.locale === "hostile-disk") {
    // writes inside its own directory past the attempt's hard scratch, outside every quota the attempt store keeps
    const file = join(scratchRoot, `kauro-attempt-scratch-${(ticket as unknown as { capability: { attemptId: string } }).capability.attemptId}`, "runaway.bin");
    const chunk = Buffer.alloc(1024 * 1024, 7);
    const grow = (): void => {
      appendFileSync(file, chunk);
      setTimeout(grow, 5);
    };
    grow();
    return;
  }
  if (ticket.render.locale === "hostile-spin") {
    // stuck in synchronous work: no handler of its own can run any more
    for (;;) Math.sqrt(Math.random());
  }
  void probe(ticket, JSON.parse(ticket.render.rendererVersion) as Parameters<typeof probe>[1]);
});
