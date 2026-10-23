// B05 L1v (D5-15, S045-S047): the host's full-dataset validation port for Intelligence Core over the real vendored Migration Core
// 3.0.0 in the real isolated core child (fs preload, permission model). The reference is the same run in this process, its scratch
// still live when the effects are read (undisposed), over the same input layout and the same documents.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildSourceProfile, createFilesystemScratchStore, loadConfig, runMigration, syntheticConfig, verifyPackage, writePackage, type HashedSourceProfile } from "@kauro/migration-core";
import { digestOf, effectsFromMigrationRun, toMigrationConfig, type CandidateConfiguration } from "@kauro/intelligence-core";
import type { CoreInputRef } from "@kauro/application";
import { CoreFullDatasetValidation, EffectsResidentLimitExceeded, MigrationCoreAdapter, attemptScratchDirectoryOf, coreInputPathOf } from "../../src/index.js";
import { coreTimersOf } from "../../src/cores/operation.js";
import { attemptFixture, limitsOf, manualChannel, sha } from "../support/attempt.js";
import { inputRef, memorySource, resolverOf, tempRoot } from "../support/core-config.js";

/** The wall clock of a test (CK3 scans product code only). */
const WALL_TIMERS = coreTimersOf({ nowMs: () => Date.now() });
const VALIDATED_AT = "2026-10-13T12:00:00.000Z";

// every effect family is nonempty: two records, a value MC changed (a trimmed name, a lowercased email domain), a column no field
// maps (Notes), an association with an endpoint MC cannot find (company 99), and a duplicate cluster (one email on two contacts)
const FILES: Record<string, string> = {
  "companies.csv": "Id,Name,Domain\n10,Acme,acme.com\n11,Beta,beta.io\n",
  "contacts.csv": "Id,Email,Name,CompanyId,Notes,Phone\n1,a@example.com, Ann ,10,x,+15550100001\n2,a@example.com,Annie,10,y,+15550100002\n3,c@Example.COM,Cy,99,,\n",
};

interface World {
  readonly t: ReturnType<typeof tempRoot>;
  readonly refs: readonly CoreInputRef[];
  readonly profile: HashedSourceProfile;
  readonly configuration: CandidateConfiguration;
  readonly adapter: MigrationCoreAdapter;
  readonly progress: string[];
}

/** Each file at its input path (coreInputPathOf, M21): the layout the profile step, compile and execute share for one revision. */
const pathOf = (name: string): string => coreInputPathOf(name, "1");

/** The input root of one revision: what the profile step and the core child read. */
function inputRootOf(root: string, prefix: string): string {
  const dir = mkdtempSync(join(root, prefix));
  for (const [name, text] of Object.entries(FILES)) writeFileSync(join(dir, pathOf(name)), text);
  return dir;
}

/** The revision's profile as the profile step makes it: over the input paths. */
function profileOf(root: string): HashedSourceProfile {
  const dir = inputRootOf(root, "profile-");
  const scratch = createFilesystemScratchStore({ root: mkdtempSync(join(root, "profile-scr-")), runId: "profile", quotaBytes: 1 << 26 });
  try {
    return buildSourceProfile({ inputRoot: dir, config: syntheticConfig(Object.keys(FILES).map((name) => ({ path: pathOf(name), format: "CSV" as const }))), scratch });
  } finally {
    scratch.dispose();
  }
}

/** A CandidateConfiguration 2.0.0 over the profile's own files and column locators (what IC's compiler emits, by hand). */
function configurationOf(profile: HashedSourceProfile): CandidateConfiguration {
  const file = (name: string) => {
    const f = profile.profile.files.find((x) => x.path === pathOf(name));
    assert.ok(f !== undefined, name);
    return f;
  };
  const column = (path: string, header: string): string => {
    const c = file(path).sheets.flatMap((s) => s.columns).find((x) => x.headerRaw === header);
    assert.ok(c !== undefined, `${path}:${header}`);
    return c.columnLocatorId;
  };
  const h = (s: string): string => sha(`fragment:${s}`);
  const record = (recordId: string, path: string, object: string) => ({ decisionRef: `rec-${recordId}`, fragmentHash: h(recordId), recordId, fileId: file(path).fileId, filePath: pathOf(path), object, sourceRecordIdColumn: { columnLocator: column(path, "Id") }, authoritativeExternalIdColumns: [], identitySpace: null });
  const field = (recordId: string, path: string, object: string, header: string, destinationField: string, semanticType: string, transformPrimitive: string | null, typedTransformParams: Record<string, string> | null = null) => ({
    decisionRef: `fld-${recordId}-${header}`,
    fragmentHash: h(`${recordId}:${header}`),
    recordId,
    fileId: file(path).fileId,
    filePath: pathOf(path),
    object,
    columnHeader: header,
    columnLocator: column(path, header),
    destinationField,
    semanticType,
    required: false,
    onInvalid: "PRESERVE" as const,
    onAmbiguous: "PRESERVE" as const,
    transformPrimitive,
    typedTransformParams,
  });
  return {
    configurationRef: "cfg-m22",
    mode: "CLEAN_ONLY",
    profileHash: profile.profileHash,
    candidateSetHash: sha("candidates"),
    targetContractHash: null,
    records: [record("companies", "companies.csv", "COMPANY"), record("contacts", "contacts.csv", "CONTACT")],
    fields: [
      field("companies", "companies.csv", "COMPANY", "Name", "company.name", "TEXT", null),
      field("companies", "companies.csv", "COMPANY", "Domain", "company.domain", "URL", null),
      field("contacts", "contacts.csv", "CONTACT", "Email", "contact.email", "EMAIL", "NORMALISE_EMAIL_CASE"),
      field("contacts", "contacts.csv", "CONTACT", "Name", "contact.description", "TEXT", "TRIM_WHITESPACE"),
      field("contacts", "contacts.csv", "CONTACT", "Phone", "contact.phone", "PHONE", null),
    ],
    associations: [{ decisionRef: "assoc-works-at", fragmentHash: h("works-at"), associationId: "works-at", recordId: "contacts", relationshipType: "CONTACT_TO_COMPANY", ownerSide: "FROM", keyColumn: { columnLocator: column("contacts.csv", "CompanyId") }, targetRecordId: "companies", targetMatchKey: "SOURCE_RECORD_ID" }],
    preservedColumns: [{ decisionRef: "keep-notes", fragmentHash: h("notes"), fileId: file("contacts.csv").fileId, filePath: pathOf("contacts.csv"), columnLocator: column("contacts.csv", "Notes") }],
    excludedColumns: [],
  } as unknown as CandidateConfiguration;
}

function world(): World {
  const t = tempRoot();
  const fixture = attemptFixture(1);
  mkdirSync(attemptScratchDirectoryOf(t.root, fixture.attemptId), { recursive: true });
  const refs = Object.entries(FILES).map(([name, text]) => inputRef(name, text));
  const profile = profileOf(t.root);
  const progress: string[] = [];
  const adapter = new MigrationCoreAdapter({
    attemptId: fixture.attemptId,
    scratchRoot: t.root,
    inputs: resolverOf(refs),
    corePackageHash: sha("core"),
    pollIntervalMs: 50,
    timers: WALL_TIMERS,
    hooks: { childPausePoints: [], child: (point) => void progress.push(point) },
  });
  return { t, refs, profile, configuration: configurationOf(profile), adapter, progress };
}

const source = (): ReturnType<typeof memorySource> => memorySource(Object.fromEntries(Object.entries(FILES).map(([name, text]) => [`${name}#1`, text])));

function port(w: World, limits: ReturnType<typeof limitsOf>): CoreFullDatasetValidation {
  return new CoreFullDatasetValidation({ adapter: w.adapter, profile: w.profile, revisionHash: sha("revision"), source: source(), limits, cancellation: manualChannel(), liveScratchBytes: () => 0, clock: { now: () => VALIDATED_AT } });
}

/** The child's own run, in this process: the same documents over the same input layout, effects read before anything is disposed. */
function reference(w: World): { effects: unknown; coreConfigHash: string; packageDigest: string; reportDigest: string } {
  const translation = toMigrationConfig(w.configuration, w.profile);
  assert.ok(translation.document !== null, JSON.stringify(translation.problems));
  const inputRoot = inputRootOf(w.t.root, "reference-input-");
  const loaded = loadConfig(JSON.stringify(translation.document), "reference");
  const scratch = createFilesystemScratchStore({ root: mkdtempSync(join(w.t.root, "reference-scr-")), runId: "reference", quotaBytes: 1 << 26 });
  try {
    const result = runMigration({ inputRoot, config: loaded.config, configHash: loaded.configHash, scratch });
    const effects = effectsFromMigrationRun({ loaded, run: result });
    const staged = writePackage({ result, config: loaded.config, normalizedConfig: loaded.normalizedJson, outputDir: join(mkdtempSync(join(w.t.root, "reference-pkg-")), "package"), force: false });
    const verifyScratch = createFilesystemScratchStore({ root: mkdtempSync(join(w.t.root, "reference-ver-")), runId: "reference-verify", quotaBytes: 1 << 26 });
    try {
      const report = verifyPackage(staged.stagingDir, { scratch: verifyScratch });
      assert.equal(report.passed, true, JSON.stringify(report.problems));
      const { packageDir: _dir, ...pathless } = report;
      return { effects, coreConfigHash: loaded.configHash, packageDigest: createHash("sha256").update(readFileSync(join(staged.stagingDir, "manifest.json"))).digest("hex"), reportDigest: digestOf(pathless) };
    } finally {
      verifyScratch.dispose();
    }
  } finally {
    scratch.dispose();
  }
}

test("M22 OK F1 (under the real child preload, nonempty input): effects for records, changes, unmapped columns, associations and duplicate clusters equal an undisposed in-process reference; packageDigest, reportDigest and coreConfigHash are MC's own", async () => {
  const w = world();
  try {
    const result = await port(w, { ...limitsOf(256 * 1024 * 1024), effectsResidentBytes: 1 << 20 }).validate(w.configuration);
    const ref = reference(w);
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.packageVerified, true);
    assert.equal(result.reconciliationHolds, true);
    assert.deepEqual(result.effects, ref.effects, "the child's effects are the in-process run's");
    assert.deepEqual(result.evidence, { packageDigest: ref.packageDigest, reportDigest: ref.reportDigest, coreConfigHash: ref.coreConfigHash });
    // the configuration's own bindings, and the rows the core read
    assert.equal(result.configurationRef, "cfg-m22");
    assert.equal(result.configurationDigest, digestOf(w.configuration));
    assert.equal(result.profileHash, w.profile.profileHash);
    assert.equal(result.rowsInProfile, w.profile.profile.totals.dataRowCount);
    assert.equal(result.rowsValidated, 5);
    assert.equal(result.validatedAt, VALIDATED_AT);
    assert.equal(result.coreVersion, "3.1.0");
    // each family is really there, so the equality above covers it
    const e = result.effects!;
    assert.equal(e.records.length, 2);
    assert.ok(e.fields.some((f) => f.changed > 0), `a value MC changed: ${JSON.stringify(e.fields)}`);
    assert.ok(e.unmapped.some((u) => u.cells > 0), "the unmapped Notes column");
    // the effects speak the profile's language: the preserved column is met on its own file id and locator, so IC matches it
    const preserved = w.configuration.preservedColumns[0]!;
    assert.deepEqual(e.unmapped.map((u) => [u.fileId, u.columnLocator]), [[preserved.fileId, preserved.columnLocator]]);
    assert.equal(e.associations.length, 1);
    assert.ok(e.associations[0]!.missingEndpoints > 0, "company 99 is not found");
    assert.ok(e.duplicateClusters.length > 0 && e.identity.duplicateClusters > 0, "one email on two contacts");
    assert.equal(e.configHash, ref.coreConfigHash);
    // the effects were read before the scratch was disposed and the file is gone with the call directory
    assert.deepEqual(w.progress.filter((p) => ["after-run", "after-effects", "after-write", "after-verify"].includes(p)), ["after-run", "after-effects", "after-write", "after-verify"]);
  } finally {
    w.t.dispose();
  }
});

test("M22b (FV) RACE (resources): effects written to the attempt scratch are charged to the byte ledger and fail SCRATCH_EXHAUSTED at the write that would pass the budget; effects within scratch but larger than limits.effectsResidentBytes fail EFFECTS_RESIDENT_LIMIT before parsing; neither bound is a constant in code", async () => {
  const fits = (w: World, budget: number, resident = 1 << 20): Promise<unknown> => port(w, { ...limitsOf(budget), effectsResidentBytes: resident }).validate(w.configuration);
  // without the resident bound in the limits the adapter refuses: it has no default
  {
    const w = world();
    try {
      await assert.rejects(port(w, limitsOf(256 * 1024 * 1024)).validate(w.configuration), /full validation needs limits\.effectsResidentBytes/);
    } finally {
      w.t.dispose();
    }
  }
  // the scratch budget: the least budget under which the child gets past its effects write, found by bisection; one byte less fails
  // at that write itself (the run is done, "after-run" was reached, "after-effects" never is): SCRATCH_EXHAUSTED
  const exhausted = (e: unknown): boolean => (e as { terminalCause?: unknown }).terminalCause === "SCRATCH_EXHAUSTED";
  const reachesEffects = async (budget: number): Promise<{ reached: boolean; progress: string[] }> => {
    const w = world();
    try {
      await fits(w, budget).catch((e: unknown) => assert.ok(exhausted(e), `${budget}: ${String(e)}`));
      return { reached: w.progress.includes("after-effects"), progress: [...w.progress] };
    } finally {
      w.t.dispose();
    }
  };
  let low = 1;
  let high = 4 * 1024 * 1024;
  assert.equal((await reachesEffects(high)).reached, true);
  assert.equal((await reachesEffects(low)).reached, false);
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if ((await reachesEffects(mid)).reached) high = mid;
    else low = mid;
  }
  const at = world();
  try {
    await assert.rejects(fits(at, high - 1), exhausted);
    assert.ok(at.progress.includes("after-run") && !at.progress.includes("after-effects"), `the budget is passed at the effects write: ${at.progress.join(",")}`);
  } finally {
    at.t.dispose();
  }
  // the resident bound: the file's length, from the limits, checked before a byte is parsed
  let length = 0;
  {
    const w = world();
    try {
      await assert.rejects(fits(w, 256 * 1024 * 1024, 1), (e: unknown) => {
        if (!(e instanceof EffectsResidentLimitExceeded)) return false;
        length = e.byteLength;
        return e.terminalCause === "EFFECTS_RESIDENT_LIMIT" && e.limit === 1;
      });
    } finally {
      w.t.dispose();
    }
  }
  assert.ok(length > 0);
  for (const [resident, refused] of [[length - 1, true], [length, false]] as const) {
    const w = world();
    try {
      if (refused) await assert.rejects(fits(w, 256 * 1024 * 1024, resident), (e: unknown) => e instanceof EffectsResidentLimitExceeded && e.byteLength === length && e.limit === resident);
      else assert.equal(((await fits(w, 256 * 1024 * 1024, resident)) as { ok: boolean }).ok, true);
    } finally {
      w.t.dispose();
    }
  }
});
