// The local process host's rig (B14-A; docs/design/B14-A-worker-executor.md §8): a real worker process (@kauro/migration-worker's
// entry, started by LocalProcessWorkerHost) running the vendored Migration Core 3.0.0 over a sealed CSV and the real Chromium where a
// browser exists, against B07's object-storage fake (CONTRACT FAKE — SIMULATED: no cloud storage exists locally) through the host's
// broker. The report's inputs are the platform-binding inputs of the assembler's tests (synthetic, consistent; the control plane's
// suite reads the same bindings from PostgreSQL 17). The package the worker must deliver is the one the core's own validation of the
// same plan binding produced in this process first — so a delivered report also proves the worker's run reproduced it byte for byte.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@kauro/migration-core";
import type { RowCounts, Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { CoreInputRef, ExecutionLimits, WorkerLaunchSpec } from "@kauro/application";
import { ContractFakeObjectStorage } from "@kauro/application/testing";
import { toUtcInstant, type Clock } from "@kauro/domain";
import { LOCAL_HOST_ISOLATION, LocalProcessWorkerHost, MigrationCoreAdapter, coreTimersOf, findChromiumExecutable, type AuthorizedReportInputs, type LocalProcessHostHooks, type LocalProcessWorkerHostOptions, type ReportScope } from "../../src/index.js";
import { attemptFixture, holderOf, limitsOf, sha, v7, type AttemptFixture } from "./attempt.js";
import { CONTACTS_CSV, configDocument, memorySource } from "./core-config.js";
import { platformInputsOf } from "./platform-inputs.js";

// compiled to packages/data-plane/dist/test/support: four levels up is the repository root
export const REPO_ROOT = resolve(fileURLToPath(new URL("../../../../../", import.meta.url)));
export const WORKER_ENTRY = join(REPO_ROOT, "apps", "migration-worker", "dist", "src", "main.js");
export const BROWSER = findChromiumExecutable(process.env["KAURO_PDF_BROWSER"] ?? null);
export const BROWSER_REQUIRED = process.env["KAURO_REQUIRE_PDF_ENGINE"] === "1";
export const CORE_PACKAGE_HASH: Sha256Hex = sha("kauro-migration-core-3.0.0.tgz (test binding)");
export const RENDER = { pageSize: "LETTER", locale: "en-US", rendererVersion: "renderer-1.0.0" } as const;

/** The wall clock of these tests (CK3 scans product code only). */
export const WALL: Clock = { now: () => toUtcInstant(Date.now()), nowMs: () => Date.now() };

/** The test limits: the attempt's hard memory fits the host's two heaps and the browser's reserve. */
export function hostLimits(scratchBudgetBytes = 8 << 20, wallClockMs = 8 * 3_600_000): ExecutionLimits {
  return { ...limitsOf(scratchBudgetBytes), wallClockMs };
}

export interface Planted {
  readonly fixture: AttemptFixture;
  readonly inputs: readonly CoreInputRef[];
  readonly configDocument: Record<string, unknown>;
  readonly coreConfigHash: Sha256Hex;
}

/** Attempt `n` over one sealed CSV planted in ACCEPTED: its capability names exactly that generation. */
export function plantedAttempt(storage: ContractFakeObjectStorage, n: number, options: { readonly csv?: string; readonly agency?: number; readonly deadlineAt?: string } = {}): Planted {
  const probe = attemptFixture(n, options.agency === undefined ? {} : { agency: options.agency });
  const objectName = `accepted/${probe.agencyId}/${probe.projectId}/${v7(9000 + n)}`;
  const bytes = Buffer.from(options.csv ?? CONTACTS_CSV);
  const { generation } = storage.plantObject(storage.location("ACCEPTED"), objectName, bytes);
  const accepted = [{ objectName, generation, sha256: sha(bytes), byteLength: bytes.byteLength }];
  const base = attemptFixture(n, { accepted, ...(options.agency === undefined ? {} : { agency: options.agency }) });
  const document = configDocument(objectName);
  const fixture: AttemptFixture = {
    ...base,
    subject: { ...base.subject, executionDeadlineAt: (options.deadlineAt ?? new Date(Date.now() + 3_600_000).toISOString()) as UtcInstant },
    spec(fence, limits = hostLimits()) {
      return { identity: base.identity, capability: base.capability, subject: this.subject, limits, fence };
    },
  };
  return {
    fixture,
    inputs: accepted.map((g) => ({ ...g, readConfig: { format: "CSV" as const, encoding: null, delimiter: null, sheets: null } })),
    configDocument: document,
    coreConfigHash: loadConfig(JSON.stringify(document), "test").configHash as Sha256Hex,
  };
}

/**
 * What the platform's records would say of the attempt's package: the core's own validation of the same binding over the same bytes
 * (receipt manifest hash and counts), in this process, before the worker runs.
 */
export async function receiptOf(planted: Planted, scratchRoot: string): Promise<{ readonly expectedManifestSha256: Sha256Hex; readonly counts: RowCounts }> {
  const { fixture, inputs } = planted;
  const validationAttempt = v7(8000 + Number.parseInt(fixture.attemptId.slice(-4), 16));
  const adapter = new MigrationCoreAdapter({
    attemptId: validationAttempt,
    scratchRoot,
    inputs: { resolve: () => Promise.resolve(inputs) },
    documents: { planBinding: () => Promise.resolve({ configDocument: planted.configDocument, coreConfigHash: planted.coreConfigHash }) },
    corePackageHash: CORE_PACKAGE_HASH,
    timers: coreTimersOf(WALL),
  });
  const { mkdirSync } = await import("node:fs");
  const { attemptScratchDirectoryOf } = await import("../../src/index.js");
  mkdirSync(attemptScratchDirectoryOf(scratchRoot, validationAttempt), { recursive: true });
  const source = memorySource({ [`${inputs[0]!.objectName}#${inputs[0]!.generation}`]: CONTACTS_CSV });
  const scratch = { usage: () => ({ bytes: 0, peakBytes: 0, quotaBytes: 0, segmentCount: 0, bytesWritten: 0, byFamily: [], framingBytesPerLine: 0 }) } as never;
  const result = await adapter.validate({
    revisionHash: fixture.subject.revisionHash,
    planBody: {} as never,
    planHash: fixture.subject.planHash,
    targetContractHash: fixture.subject.targetContractHash,
    scratch,
    cancellation: { check: () => Promise.resolve("CONTINUE") },
    controls: { limits: hostLimits(64 << 20), source, billableSourceUnits: 3 },
  });
  if (result.outcome !== "VALID" || result.receipt === null) throw new Error(`the core's validation of the fixture was ${result.outcome}: ${result.problems.join(", ")}`);
  return { expectedManifestSha256: result.receipt.artifactEvidenceHash, counts: result.receipt.counts };
}

export interface LocalRig {
  readonly storage: ContractFakeObjectStorage;
  /** The live host (one per root): the one `reopen` opened last. */
  readonly host: LocalProcessWorkerHost;
  readonly root: string;
  readonly hostRoot: string;
  readonly scratchRoot: string;
  /** What the ticket source answers per attempt id (tests edit it). */
  readonly reads: Map<string, { planBinding: { configDocument: unknown; coreConfigHash: Sha256Hex } | null; inputs: readonly CoreInputRef[]; reportInputs: AuthorizedReportInputs | null }>;
  /** A restarted control plane: the live host stops (its running workers end TERMINATED), then a new one opens the same roots. */
  reopen(overrides?: Partial<LocalProcessWorkerHostOptions>): Promise<LocalProcessWorkerHost>;
  /** The host's options over this rig's roots (a test opens its own with changes). */
  options(overrides?: Partial<LocalProcessWorkerHostOptions>): LocalProcessWorkerHostOptions;
  dispose(): Promise<void>;
}

export type LocalRigOptions = { readonly root?: string; readonly render?: typeof RENDER | { pageSize: "LETTER"; locale: string; rendererVersion: string }; readonly workerEntry?: string; readonly hooks?: LocalProcessHostHooks; readonly maxWallClockMs?: number; readonly workerHeapMegabytes?: number; readonly coreHeapMegabytes?: number; readonly terminationGraceMs?: number; readonly creationHorizonSeconds?: number; readonly browserReserveBytes?: number };

export async function localRig(options: LocalRigOptions = {}): Promise<LocalRig> {
  if (BROWSER === null) throw new Error("no Chromium-family browser (set KAURO_PDF_BROWSER)");
  const browser = BROWSER;
  const root = options.root ?? mkdtempSync(join(tmpdir(), "kauro-b14a-"));
  const hostRoot = join(root, "host");
  const scratchRoot = join(root, "scratch");
  const storage = new ContractFakeObjectStorage();
  const reads: LocalRig["reads"] = new Map();
  const optionsOf = (overrides: Partial<LocalProcessWorkerHostOptions> = {}, clock: Clock = WALL): LocalProcessWorkerHostOptions => ({
    isolation: LOCAL_HOST_ISOLATION,
    workerEntry: options.workerEntry ?? WORKER_ENTRY,
    codeRoots: [REPO_ROOT],
    hostRoot,
    scratchRoot,
    chromiumExecutable: browser,
    storage,
    uploads: holderOf(storage),
    tickets: {
      read: (spec: WorkerLaunchSpec) => {
        const r = reads.get(spec.capability.attemptId);
        if (r === undefined) return Promise.reject(new Error(`no reads for ${spec.capability.attemptId}`));
        return Promise.resolve(r as never);
      },
    },
    render: options.render ?? RENDER,
    corePackageHash: CORE_PACKAGE_HASH,
    clock,
    sessionOrigin: "https://app.kauro.test",
    workerHeapMegabytes: options.workerHeapMegabytes ?? 512,
    coreHeapMegabytes: options.coreHeapMegabytes ?? 512,
    ...(options.maxWallClockMs === undefined ? {} : { maxWallClockMs: options.maxWallClockMs }),
    ...(options.terminationGraceMs === undefined ? {} : { terminationGraceMs: options.terminationGraceMs }),
    ...(options.creationHorizonSeconds === undefined ? {} : { creationHorizonSeconds: options.creationHorizonSeconds }),
    ...(options.browserReserveBytes === undefined ? {} : { browserReserveBytes: options.browserReserveBytes }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...overrides,
  });
  let host = await LocalProcessWorkerHost.open(optionsOf());
  return {
    storage,
    get host() {
      return host;
    },
    root,
    hostRoot,
    scratchRoot,
    reads,
    async reopen(overrides?: Partial<LocalProcessWorkerHostOptions>) {
      await host.stop();
      host = await LocalProcessWorkerHost.open(optionsOf(overrides));
      return host;
    },
    options: (overrides) => optionsOf(overrides),
    async dispose() {
      await host.stop();
      if (options.root === undefined) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

/** Registers what the control plane would read for `planted`: its binding, its inputs, and the platform's report inputs. */
export async function readsFor(rig: LocalRig, planted: Planted, edit: (inputs: AuthorizedReportInputs) => AuthorizedReportInputs | null = (i) => i): Promise<void> {
  const record = await receiptOf(planted, rig.root);
  const scope: ReportScope = { agencyId: planted.fixture.agencyId, projectId: planted.fixture.projectId, jobId: planted.fixture.jobId, attemptId: planted.fixture.attemptId };
  rig.reads.set(planted.fixture.attemptId, {
    planBinding: { configDocument: planted.configDocument, coreConfigHash: planted.coreConfigHash },
    inputs: planted.inputs,
    reportInputs: edit(platformInputsOf(scope, record)),
  });
}

export const hasWorkerEntry = existsSync(WORKER_ENTRY);
/** The hostile worker (support/hostile-worker.ts), compiled beside this file. */
export const HOSTILE_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "hostile-worker.js");

/**
 * The pids of the processes whose command line names `marker` (an attempt's scratch directory: the worker's own flags, the core child's
 * call directory and the browser's profile all name it). Linux reads /proc; Windows asks CIM for every process's command line.
 */
export function processesReferencing(marker: string): number[] {
  if (process.platform === "linux") {
    const out: number[] = [];
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      try {
        if (readFileSync(`/proc/${name}/cmdline`, "utf8").includes(marker)) out.push(Number(name));
      } catch (error) {
        if (!gone(error)) throw new Error(`/proc/${name} could not be read: no evidence either way`, { cause: error });
      }
    }
    return out;
  }
  if (process.platform === "win32") {
    const escaped = marker.replace(/'/g, "''");
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${escaped}') } | ForEach-Object { $_.ProcessId }`], { encoding: "utf8", windowsHide: true });
    return String(r.stdout ?? "").split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number).filter((pid) => pid !== process.pid);
  }
  return [];
}

/** One process as the operating system lists it: its pid with its start (a pid alone can be reused), its parent and command line. */
export interface ProcessInstance {
  readonly pid: number;
  readonly start: string;
  readonly ppid: number;
  readonly command: string;
}

/** A /proc read that failed because the process ended (its entry gone); any other failure is no evidence of an end, and throws. */
function gone(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ESRCH";
}

/**
 * Every live process of the machine (Linux /proc, Windows CIM). A process that ended while it was read is left out; one that cannot
 * be read for another reason makes the whole snapshot throw (review R3-3): an unreadable process is never taken for an ended one, and
 * an empty list is never assumed. A zombie (Linux state Z) has ended.
 */
export function processSnapshot(): ProcessInstance[] {
  if (process.platform === "linux") {
    const out: ProcessInstance[] = [];
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      let stat: string;
      let command: string;
      try {
        // /proc/<pid>/stat: "pid (comm) state ppid ..." — the fields after the last ")": state is 1st, ppid 2nd, starttime 20th
        stat = readFileSync(`/proc/${name}/stat`, "utf8");
        command = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").join(" ");
      } catch (error) {
        if (gone(error)) continue;
        throw new Error(`/proc/${name} could not be read: no evidence either way`, { cause: error });
      }
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") continue;
      out.push({ pid: Number(name), ppid: Number(fields[1]), start: String(fields[19]), command });
    }
    if (out.length === 0) throw new Error("/proc listed no process");
    return out;
  }
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; start = $_.CreationDate.ToString('o'); command = [string]$_.CommandLine } } | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`the process list could not be read: ${r.stderr}`);
  const list = JSON.parse(r.stdout) as Array<{ pid: number; ppid: number; start: string; command: string | null }>;
  if (!Array.isArray(list) || list.length === 0) throw new Error("CIM listed no process");
  return list.map((p) => ({ pid: p.pid, ppid: p.ppid, start: p.start, command: p.command ?? "" }));
}

/** The process `rootPid` and all its descendants, as the snapshot shows them (their own command lines need not name anything). */
export function treeOf(snapshot: readonly ProcessInstance[], rootPid: number): ProcessInstance[] {
  const tree = snapshot.filter((p) => p.pid === rootPid);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of snapshot) {
      if (!tree.includes(p) && tree.some((t) => t.pid === p.ppid && t.pid !== p.pid)) {
        tree.push(p);
        grew = true;
      }
    }
  }
  return tree;
}

/** The instances still running: the same pid with the same start. */
export function stillRunning(instances: readonly ProcessInstance[]): ProcessInstance[] {
  const now = processSnapshot();
  return instances.filter((i) => now.some((p) => p.pid === i.pid && p.start === i.start));
}

/** Polls until `check` holds or `timeoutMs` passes (a process appearing or disappearing; never an interleaving). */
export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 20_000, everyMs = 100): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
