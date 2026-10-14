// The probe of case R2-049 (SIM): a task that tries, inside the isolated child, what a compromised worker would try first to widen
// its authority — reach a cloud instance-metadata endpoint (AWS IMDS over IPv4 and IPv6, the GCP metadata server by name, ECS's task
// credential endpoint) by connect, fetch, http and name resolution, read a credentials file and the parent's credential variables —
// and reports what each attempt met. It runs under exactly the flags and the preload of the inspector (runIsolated).
import dns from "node:dns";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";

export interface MetadataProbePayload {
  readonly credentialsFile: string;
}

function codeOf(error: unknown): string {
  const e = error as { code?: unknown; permission?: unknown };
  return `${typeof e.code === "string" ? e.code : "UNKNOWN"}${typeof e.permission === "string" ? `:${e.permission}` : ""}`;
}

async function attempt(out: Record<string, string>, name: string, reached: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    out[name] = reached;
  } catch (error) {
    out[name] = codeOf(error);
  }
}

function connected(socket: net.Socket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.on("connect", () => resolve());
    socket.on("error", (e) => reject(e));
  });
}

export async function run(payload: MetadataProbePayload): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await attempt(out, "imdsConnect", "CONNECTED", async () => {
    const socket = net.connect({ host: "169.254.169.254", port: 80 });
    try {
      await connected(socket);
    } finally {
      socket.destroy();
    }
  });
  await attempt(out, "imdsV6Connect", "CONNECTED", async () => {
    const socket = net.connect({ host: "fd00:ec2::254", port: 80 });
    try {
      await connected(socket);
    } finally {
      socket.destroy();
    }
  });
  await attempt(out, "imdsFetch", "FETCHED", async () => {
    await fetch("http://169.254.169.254/latest/meta-data/iam/security-credentials/", { method: "PUT", headers: { "X-aws-ec2-metadata-token-ttl-seconds": "21600" } });
  });
  await attempt(out, "ecsHttp", "REQUESTED", () => {
    http.get("http://169.254.170.2/v2/credentials/");
  });
  await attempt(out, "gcpLookup", "RESOLVED", () => new Promise<void>((resolve, reject) => dns.lookup("metadata.google.internal", (error) => (error === null ? resolve() : reject(error)))));
  await attempt(out, "credentialsFile", "READ", () => {
    readFileSync(payload.credentialsFile, "utf8");
  });
  const names = Object.keys(process.env).filter((k) => k !== "SystemRoot");
  out["env"] = names.length === 0 ? "EMPTY" : names.sort().join(",");
  out["awsKey"] = process.env["AWS_SECRET_ACCESS_KEY"] === undefined ? "ABSENT" : "PRESENT";
  return out;
}
