// The negative-control probe of decision D-ISO-1: a task that tries, inside the isolated child, everything a clean inspection
// never does — write outside the attempt scratch (synchronously and asynchronously), connect, resolve a name, fetch, request over
// http, start a process and a worker — and reports what each attempt met. It runs under exactly the flags and the preload of the
// inspector (runIsolated). A write inside the scratch is its positive control.
import childProcess from "node:child_process";
import dns from "node:dns";
import { existsSync, promises as fsp, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

export interface ProbePayload {
  readonly outside: string;
  readonly port: number;
  readonly attempts: ReadonlyArray<"write" | "writeAsync" | "connect" | "lookup" | "fetch" | "http" | "spawn" | "worker">;
}

function codeOf(error: unknown): string {
  const e = error as { code?: unknown; permission?: unknown };
  return `${typeof e.code === "string" ? e.code : "UNKNOWN"}${typeof e.permission === "string" ? `:${e.permission}` : ""}`;
}

export async function run(payload: ProbePayload, context: { readonly workDir: string }): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const inside = join(context.workDir, "inside.txt");
  writeFileSync(inside, "positive control");
  out["inside"] = existsSync(inside) ? "WRITTEN" : "MISSING";
  for (const attempt of payload.attempts) {
    try {
      switch (attempt) {
        case "write":
          writeFileSync(payload.outside, "escaped");
          out[attempt] = "WROTE";
          break;
        case "writeAsync":
          await fsp.writeFile(`${payload.outside}.async`, "escaped");
          out[attempt] = "WROTE";
          break;
        case "connect": {
          const socket = net.connect({ host: "127.0.0.1", port: payload.port });
          await new Promise<void>((resolve) => {
            socket.on("connect", () => resolve());
            socket.on("error", () => resolve());
          });
          socket.destroy();
          out[attempt] = "CONNECTED";
          break;
        }
        case "lookup":
          await new Promise<void>((resolve, reject) => dns.lookup("localhost", (error) => (error === null ? resolve() : reject(error))));
          out[attempt] = "RESOLVED";
          break;
        case "fetch":
          await fetch(`http://127.0.0.1:${payload.port}/`);
          out[attempt] = "FETCHED";
          break;
        case "http":
          http.get(`http://127.0.0.1:${payload.port}/`);
          out[attempt] = "REQUESTED";
          break;
        case "spawn":
          childProcess.spawnSync(process.execPath, ["-v"]);
          out[attempt] = "SPAWNED";
          break;
        case "worker":
          new Worker("0", { eval: true });
          out[attempt] = "STARTED";
          break;
      }
    } catch (error) {
      out[attempt] = codeOf(error);
    }
  }
  return out;
}
