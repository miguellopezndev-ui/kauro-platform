/**
 * The task the core child runs (B05 D5-2, D5-2c, D5-15 order; M01, M10, M20, M24): vendored kauro-migration-core 3.0.0 over the
 * materialized inputs, entirely inside the call directory, every device write metered by the fs preload.
 *
 *   execute / validate:  loadConfig (hash must equal the binding's) -> [buildSourceProfile] -> runMigration -> writePackage ->
 *                        dispose the run scratch S -> verifyPackage(stagingDir) with a fresh scratch V -> dispose V ->
 *                        promotePackage -> record
 *   profile:             buildSourceProfile over the inputs -> record
 *   full-validation:     loadConfig (the document as compiled, its paths the input paths; the hash must equal the binding's when
 *                        one is bound) -> runMigration -> effectsFromMigrationRun while the run's
 *                        scratch families are live -> effects.ndjson in the call directory (outside S, every write metered) ->
 *                        writePackage -> dispose S -> verifyPackage(stagingDir) with V -> reportDigest -> dispose V -> record (D5-15)
 *
 * The platform AttemptScratchStore is the core's host-injected ScratchStore (contract 1.0.0), so its `device` is the metered
 * writeSync. The record carries the package's artifacts (path, sha256, length, rows), the core's reconciliation, the residual map of
 * charged bytes still on disk (the parent adopts it into its ledger) and the child's peak memory. Loaded inside the child: node
 * built-ins, this package's own child modules and the Migration Core wrapper.
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readdirSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  CORE_VERSION,
  buildSourceProfile,
  hashSourceProfile,
  listPackageFiles,
  loadConfig,
  promotePackage,
  runMigration,
  serializeSourceProfile,
  syntheticConfig,
  verifyPackage,
  writePackage,
  type HashedSourceProfile,
  type Reconciliation,
} from "@kauro/migration-core";
import { digestOf, effectsFromMigrationRun, type MigrationEffects } from "@kauro/intelligence-core";
import { AttemptScratchStore } from "../attempt/scratch-store.js";
import type { CoreChildContext } from "./child-protocol.js";

export interface CoreTaskPayload {
  readonly mode: "execute" | "validate" | "profile" | "full-validation";
  /** The MigrationConfig document (execute, validate); the files of the profile (profile). */
  readonly configText: string;
  /** The same document with each file path rewritten to its input path (D5-5); the run reads these, the hash binds the original. */
  readonly runConfigText?: string;
  /** The coreConfigHash the plan was bound to; the child refuses a configuration that hashes elsewhere. */
  readonly expectedConfigHash: string | null;
  readonly profileFiles: ReadonlyArray<{ readonly path: string; readonly format: "CSV" | "XLSX" }>;
  readonly inputRoot: string;
  readonly runDir: string;
  readonly verifyDir: string;
  readonly packageDir: string;
  readonly attemptId: string;
  readonly quotaBytes: number;
  /** full-validation: where the effects are written, in the call directory and outside the run segments S (D5-15). */
  readonly effectsPath?: string;
}

export interface CoreTaskArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly rowCount: number | null;
}

export type CoreTaskRecord =
  | {
      readonly kind: "PACKAGE";
      readonly coreVersion: string;
      readonly configHash: string;
      readonly profileHash: string | null;
      readonly manifestSha256: string;
      readonly packageDir: string;
      readonly artifacts: readonly CoreTaskArtifact[];
      readonly reconciliation: Reconciliation;
      /** Records of the lineage rows with contribution_kind RECORD and of every MACHINE_IMPORT_CSV, counted from bytes. */
      readonly lineageRecordRows: number;
      readonly emittedArtifactRows: number;
      readonly residual: ReadonlyArray<readonly [string, number]>;
      readonly peakLedgerBytes: number;
      readonly maxRssBytes: number;
    }
  | { readonly kind: "CORRUPT"; readonly problems: readonly string[]; readonly maxRssBytes: number }
  | { readonly kind: "PROFILE"; readonly profileHash: string; readonly profileText: string; readonly maxRssBytes: number }
  | {
      readonly kind: "FULL_VALIDATION";
      readonly coreVersion: string;
      readonly configHash: string;
      /** The staged package manifest's sha256 as Migration Core wrote it. */
      readonly manifestSha256: string;
      /** digestOf the verifier's report, packageDir excluded (the IC receipt's reportDigest). */
      readonly reportDigest: string;
      readonly packageVerified: boolean;
      readonly problems: readonly string[];
      readonly reconciliation: Reconciliation;
      readonly effects: { readonly path: string; readonly sha256: string; readonly byteLength: number };
      readonly maxRssBytes: number;
    }
  | { readonly kind: "CONFIG_MISMATCH"; readonly actual: string };

function maxRssBytes(): number {
  return process.resourceUsage().maxRSS * 1024;
}

function sha256File(path: string): { sha256: string; byteLength: number } {
  const bytes = readFileSync(path);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength };
}

function csvRecordCount(path: string): number {
  // records of a machine CSV counted from its bytes: physical lines minus the header, quoted newlines respected
  const text = readFileSync(path, "utf8");
  let records = 0;
  let inQuote = false;
  let sawContent = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "\n" && !inQuote) {
      if (sawContent) records += 1;
      sawContent = false;
    } else if (ch !== "\r") sawContent = true;
  }
  if (sawContent) records += 1;
  return Math.max(0, records - 1);
}

function lineageRecordRows(packageDir: string): number {
  const lineage = listPackageFiles(packageDir).find((p) => /(^|\/)source-lineage\.csv$/.test(p));
  if (lineage === undefined) return 0;
  const lines = readFileSync(join(packageDir, lineage), "utf8").split(/\r?\n/);
  const header = lines[0]?.split(",") ?? [];
  const at = header.indexOf("contribution_kind");
  if (at < 0) return 0;
  let n = 0;
  for (const line of lines.slice(1)) if (line.split(",")[at] === "RECORD") n += 1;
  return n;
}

function directoryBytes(dir: string): Array<readonly [string, number]> {
  const out: Array<readonly [string, number]> = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...directoryBytes(p));
    else out.push([p, st.size] as const);
  }
  return out;
}

/**
 * The effects as NDJSON: a head line (configHash, identity) and then one line per element of each family, in the core's order, so
 * the parent can bound the file by its length before it parses a byte. Every write goes through the metered writeSync.
 */
function writeEffects(path: string, effects: MigrationEffects): { path: string; sha256: string; byteLength: number } {
  const hash = createHash("sha256");
  let byteLength = 0;
  const fd = openSync(path, "wx");
  try {
    const line = (value: unknown): void => {
      const bytes = Buffer.from(JSON.stringify(value) + "\n", "utf8");
      writeSync(fd, bytes);
      hash.update(bytes);
      byteLength += bytes.byteLength;
    };
    line({ head: { configHash: effects.configHash, identity: effects.identity } });
    for (const family of EFFECT_FAMILIES) for (const item of effects[family]) line({ [family]: item });
  } finally {
    closeSync(fd);
  }
  return { path, sha256: hash.digest("hex"), byteLength };
}

/** The list families of MigrationEffects, in the order they are written and read back. */
export const EFFECT_FAMILIES = ["records", "fields", "associations", "duplicateClusters", "unmapped", "leftoverFiles"] as const;

async function fullValidation(payload: CoreTaskPayload, context: CoreChildContext): Promise<CoreTaskRecord> {
  if (payload.effectsPath === undefined) throw new TypeError("full-validation needs an effects path");
  const loaded = loadConfig(payload.configText, "kauro-core-config");
  if (payload.expectedConfigHash !== null && loaded.configHash !== payload.expectedConfigHash) return { kind: "CONFIG_MISMATCH", actual: loaded.configHash };
  if (payload.runConfigText !== undefined) throw new TypeError("full-validation runs the document as compiled, never a rewritten one");
  const runScratch = new AttemptScratchStore({ root: payload.runDir, attemptId: payload.attemptId, quotaBytes: payload.quotaBytes });
  let result: ReturnType<typeof runMigration>;
  let staged: ReturnType<typeof writePackage>;
  let effects: { path: string; sha256: string; byteLength: number };
  try {
    await context.progress("before-run");
    result = runMigration({ inputRoot: payload.inputRoot, config: loaded.config, configHash: loaded.configHash, scratch: runScratch });
    await context.progress("after-run");
    // the effects are read off the run's spooled families while S is live, and written before anything is disposed
    effects = writeEffects(payload.effectsPath, effectsFromMigrationRun({ loaded, run: result }));
    await context.progress("after-effects");
    staged = writePackage({ result, config: loaded.config, normalizedConfig: loaded.normalizedJson, outputDir: payload.packageDir, force: false });
    await context.progress("after-write");
  } finally {
    runScratch.dispose();
  }
  const verifyScratch = new AttemptScratchStore({ root: payload.verifyDir, attemptId: payload.attemptId, quotaBytes: payload.quotaBytes });
  let report: ReturnType<typeof verifyPackage>;
  let reportDigest: string;
  try {
    report = verifyPackage(staged.stagingDir, { scratch: verifyScratch });
    const { packageDir: _path, ...pathless } = report;
    reportDigest = digestOf(pathless);
  } finally {
    verifyScratch.dispose();
  }
  await context.progress("after-verify");
  return {
    kind: "FULL_VALIDATION",
    coreVersion: CORE_VERSION,
    configHash: loaded.configHash,
    manifestSha256: sha256File(join(staged.stagingDir, "manifest.json")).sha256,
    reportDigest,
    packageVerified: report.passed,
    problems: report.problems.map((p) => `${p.check}: ${p.detail}`),
    reconciliation: result.reconciliation,
    effects,
    maxRssBytes: maxRssBytes(),
  };
}

export async function run(payload: CoreTaskPayload, context: CoreChildContext): Promise<CoreTaskRecord> {
  await context.progress("child:started");
  if (payload.mode === "profile") {
    const config = syntheticConfig(payload.profileFiles.map((f) => ({ path: f.path, format: f.format })));
    const scratch = new AttemptScratchStore({ root: payload.runDir, attemptId: payload.attemptId, quotaBytes: payload.quotaBytes });
    try {
      const profile = buildSourceProfile({ inputRoot: payload.inputRoot, config, scratch });
      await context.progress("after-profile");
      return { kind: "PROFILE", profileHash: profile.profileHash, profileText: serializeSourceProfile(profile), maxRssBytes: maxRssBytes() };
    } finally {
      scratch.dispose();
    }
  }

  if (payload.mode === "full-validation") return fullValidation(payload, context);

  const loaded = loadConfig(payload.configText, "kauro-core-config");
  if (payload.expectedConfigHash !== null && loaded.configHash !== payload.expectedConfigHash) return { kind: "CONFIG_MISMATCH", actual: loaded.configHash };

  const runLoaded = payload.runConfigText === undefined ? loaded : loadConfig(payload.runConfigText, "kauro-core-config-run");
  const runScratch = new AttemptScratchStore({ root: payload.runDir, attemptId: payload.attemptId, quotaBytes: payload.quotaBytes });
  let profile: HashedSourceProfile | null = null;
  let result: ReturnType<typeof runMigration>;
  let staged: ReturnType<typeof writePackage>;
  try {
    if (payload.mode === "validate") profile = buildSourceProfile({ inputRoot: payload.inputRoot, config: runLoaded.config, scratch: runScratch });
    await context.progress("before-run");
    result = runMigration({ inputRoot: payload.inputRoot, config: runLoaded.config, configHash: loaded.configHash, scratch: runScratch, ...(profile === null ? {} : { sourceProfile: profile }) });
    await context.progress("after-run");
    staged = writePackage({ result, config: loaded.config, normalizedConfig: loaded.normalizedJson, outputDir: payload.packageDir, force: false });
    await context.progress("after-write");
  } finally {
    runScratch.dispose();
  }

  const verifyScratch = new AttemptScratchStore({ root: payload.verifyDir, attemptId: payload.attemptId, quotaBytes: payload.quotaBytes });
  let report: ReturnType<typeof verifyPackage>;
  try {
    report = verifyPackage(staged.stagingDir, { scratch: verifyScratch });
  } finally {
    verifyScratch.dispose();
  }
  await context.progress("after-verify");
  if (!report.passed) return { kind: "CORRUPT", problems: report.problems.map((p) => `${p.check}: ${p.detail}`), maxRssBytes: maxRssBytes() };

  const packageDir = promotePackage(staged, { force: false });
  await context.progress("before-record");
  const artifacts: CoreTaskArtifact[] = staged.artifacts.map((a) => ({ path: a.path, sha256: a.sha256, byteLength: a.byteLength, rowCount: a.rowCount }));
  const manifest = sha256File(join(packageDir, "manifest.json"));
  let emitted = 0;
  for (const a of artifacts) if (/(^|\/)01_IMPORT\//.test(a.path) && a.path.endsWith(".csv")) emitted += csvRecordCount(join(packageDir, a.path));
  return {
    kind: "PACKAGE",
    coreVersion: CORE_VERSION,
    configHash: loaded.configHash,
    profileHash: profile === null ? null : hashSourceProfile(profile.profile),
    manifestSha256: manifest.sha256,
    packageDir,
    artifacts,
    reconciliation: result.reconciliation,
    lineageRecordRows: lineageRecordRows(packageDir),
    emittedArtifactRows: emitted,
    residual: directoryBytes(packageDir),
    peakLedgerBytes: context.meter.ledger().peak,
    maxRssBytes: maxRssBytes(),
  };
}
