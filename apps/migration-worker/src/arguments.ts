/**
 * The worker's command line (B14-A; docs/design/B14-A-worker-executor.md §4): only paths, sizes and the ticket's digest — never a
 * secret, never a customer value. Anything missing, repeated or unknown refuses the start before the ticket is read.
 */
import { isAbsolute } from "node:path";

export interface WorkerArguments {
  readonly ticketDigest: string;
  readonly scratchRoot: string;
  readonly chromium: string;
  readonly coreHeapMegabytes: number;
  readonly storageEvidence: "EXECUTED_PROVIDER" | "SIMULATED";
}

const FLAGS = ["--ticket-digest", "--scratch-root", "--chromium", "--core-heap-mb", "--storage-evidence"] as const;

export function parseWorkerArguments(argv: readonly string[]): WorkerArguments | { readonly problem: string } {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] as string;
    const value = argv[i + 1];
    if (!(FLAGS as readonly string[]).includes(flag) || value === undefined || values.has(flag)) return { problem: `ARGUMENT_${flag.replace(/^-+/, "").toUpperCase().replace(/[^A-Z]/g, "_")}` };
    values.set(flag, value);
  }
  for (const flag of FLAGS) if (!values.has(flag)) return { problem: `ARGUMENT_MISSING` };
  const ticketDigest = values.get("--ticket-digest") as string;
  const scratchRoot = values.get("--scratch-root") as string;
  const chromium = values.get("--chromium") as string;
  const coreHeapMegabytes = Number(values.get("--core-heap-mb"));
  const storageEvidence = values.get("--storage-evidence");
  if (!/^[0-9a-f]{64}$/.test(ticketDigest)) return { problem: "ARGUMENT_TICKET_DIGEST" };
  if (!isAbsolute(scratchRoot) || !isAbsolute(chromium)) return { problem: "ARGUMENT_PATH" };
  if (!Number.isSafeInteger(coreHeapMegabytes) || coreHeapMegabytes < 64) return { problem: "ARGUMENT_CORE_HEAP" };
  if (storageEvidence !== "EXECUTED_PROVIDER" && storageEvidence !== "SIMULATED") return { problem: "ARGUMENT_STORAGE_EVIDENCE" };
  return { ticketDigest, scratchRoot, chromium, coreHeapMegabytes, storageEvidence };
}
