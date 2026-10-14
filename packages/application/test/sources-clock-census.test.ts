// CS-C (CLOCK-SWEEP-B07 L1; docs/design/B07-clock-sweep-plan.md sec. 2, 3; FAILURE-MATRIX-TEMPLATE rules 15 and 25 as a static check):
// the clock census of the source lifecycle (packages/application/src/sources/**), on the TypeScript syntax tree, never on lines.
//   - uow.serverInstant() (the transaction's start, kauro.server_now()) is called only by RequestDeletion, as a stamp (S7);
//   - every deadline judgment reachedOnServer(deadline, instant) judges at an effect instant read in the same function
//     (await effectNowOf(uow) / await <unit>.effectInstant(), kauro.effect_now() of 0038) with no await between that read and the
//     judgment (the read is after the unit's last await before it), except the two declared forms (the revision view's facts, a
//     stored-instant shape check);
//   - between each judgment and its effect statement only the declared awaits (rule 25), the refusal branch excluded;
//   - the process clocks (the Clock port, Date, performance) only at the stamps the census lists.
// The plants prove the census bites: a copy of complete-upload.ts reading `await uow.serverInstant()` and a copy with an await planted
// between its judgment and its effect both fail.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const SOURCES = join(packageRoot, "src", "sources");

function sourceFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts")) out.set(relative(SOURCES, p).split("\\").join("/"), readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out;
}

/** The only serverInstant() call of the folder: RequestDeletion's stamp (the Pg adapter ignores the instant, plan sec. 2 S7). */
const SERVER_INSTANT_SITES: Readonly<Record<string, number>> = { "handlers/request-deletion.ts": 1 };

/** reachedOnServer second arguments that are not an effect read of the same function (by file, exact text). */
const DECLARED_INSTANTS: Readonly<Record<string, ReadonlyArray<string>>> = {
  // blockersOf judges the facts revisionFacts read: its serverNow is `await effectNowOf(uow)`, the last await of revisionFacts (S6)
  "handlers/projections.ts": ["f.serverNow"],
  // two stored instants (the soft deadline already at the hard cap): a shape check, no clock
  "handlers/request-retention-extension.ts": ["record.softDeadline"],
};

interface JudgmentSite {
  readonly site: string;
  readonly file: string;
  /** The first await of the effect after the judgment (callee text); null: the judgment has no effect in its function. */
  readonly effect: string | null;
  /** The awaits between the judgment and the effect, in order (callee text), the refusal branch excluded. */
  readonly between: ReadonlyArray<string>;
}

/** Every effect read of the folder, in file order (plan sec. 3). */
const JUDGMENTS: ReadonlyArray<JudgmentSite> = [
  { site: "S1 CMD014", file: "handlers/complete-upload.ts", effect: "uow.sources.uploads.transition", between: [] },
  { site: "S6 revisionFacts", file: "handlers/projections.ts", effect: null, between: [] },
  { site: "RX CMD060", file: "handlers/request-retention-extension.ts", effect: "retention.extendSoftDeadline", between: [] },
  // C-1: the session secret's INSERT (no wait: its FK KEY SHARE is on the row this unit holds FOR UPDATE); the DB re-judges at the edge
  { site: "S2 CMD013 unit 2", file: "handlers/reserve-upload.ts", effect: "uow.sources.uploads.transition", between: ["uow.sources.sessionSecrets.store"] },
  { site: "S3 CMD013 resume", file: "handlers/reserve-upload.ts", effect: "uow.sources.uploads.claimSessionAttempt", between: [] },
  { site: "S4 CMD017", file: "handlers/seal-revision.ts", effect: "uow.sources.seals.insert", between: [] },
  // C-3: the binding is not the retention effect; the seal re-judges R-2 (S4 and the deferred COMMIT trigger)
  { site: "S5a CMD016 sealed bytes", file: "handlers/selection-rules.ts", effect: null, between: [] },
  { site: "S5b CMD016 never-sealed bytes", file: "handlers/selection-rules.ts", effect: null, between: [] },
];

/** Process clocks of the folder by file (stamps and the pending grace against the journal's own Clock stamp; plan sec. 2). */
const PROCESS_CLOCKS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  "handlers/intake.ts": { CLOCK_PORT: 1 },
  "handlers/reads.ts": { CLOCK_PORT: 2 },
  "handlers/reserve-upload.ts": { CLOCK_PORT: 4 },
  "provider-holds.ts": { MONOTONIC: 1 },
};

const isFunctionLike = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);

function enclosingFunction(n: ts.Node): ts.Node | undefined {
  for (let p = n.parent; p !== undefined; p = p.parent) if (isFunctionLike(p)) return p;
  return undefined;
}

function calleeText(e: ts.Expression, sf: ts.SourceFile): string {
  let x: ts.Expression = e;
  while (ts.isParenthesizedExpression(x)) x = x.expression;
  return ts.isCallExpression(x) ? x.expression.getText(sf) : x.getText(sf);
}

function isEffectRead(n: ts.AwaitExpression): boolean {
  const call = n.expression;
  if (!ts.isCallExpression(call)) return false;
  const callee = call.expression;
  return (ts.isIdentifier(callee) && callee.text === "effectNowOf") || (ts.isPropertyAccessExpression(callee) && callee.name.text === "effectInstant");
}

function descendants(root: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

const contains = (outer: ts.Node, inner: ts.Node): boolean => inner.pos >= outer.pos && inner.end <= outer.end;

/** The census over `files` (path relative to src/sources -> text). Returns every violation; [] is green. */
export function clockCensus(files: ReadonlyMap<string, string>): string[] {
  const errors: string[] = [];
  const serverInstant: Record<string, number> = {};
  const clocks: Record<string, Record<string, number>> = {};
  const reads: Array<{ file: string; read: ts.AwaitExpression; sf: ts.SourceFile }> = [];
  for (const [file, text] of files) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const nodes = descendants(sf);
    const fileReads: ts.AwaitExpression[] = [];
    for (const n of nodes) {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const name = n.expression.name.text;
        const object = n.expression.expression.getText(sf);
        if (name === "serverInstant") serverInstant[file] = (serverInstant[file] ?? 0) + 1;
        const kind = (name === "now" || name === "nowMs") && /clock$/i.test(object) ? "CLOCK_PORT" : name === "now" && object === "Date" ? "PROCESS" : name === "now" && object === "performance" ? "MONOTONIC" : null;
        if (kind !== null) (clocks[file] ??= {})[kind] = (clocks[file]?.[kind] ?? 0) + 1;
      }
      if (ts.isNewExpression(n) && n.expression.getText(sf) === "Date" && (n.arguments === undefined || n.arguments.length === 0)) {
        (clocks[file] ??= {})["PROCESS"] = (clocks[file]?.["PROCESS"] ?? 0) + 1;
      }
      if (ts.isAwaitExpression(n) && isEffectRead(n)) fileReads.push(n);
    }
    for (const read of fileReads) reads.push({ file, read, sf });

    // every reachedOnServer judges at an effect read of its function, or at a declared instant
    const declared = DECLARED_INSTANTS[file] ?? [];
    for (const n of nodes) {
      if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== "reachedOnServer") continue;
      const instant = n.arguments[1];
      const at = `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
      if (instant === undefined) {
        errors.push(`${at}: reachedOnServer without an instant`);
        continue;
      }
      const text = instant.getText(sf);
      if (declared.includes(text)) continue;
      const fn = enclosingFunction(n);
      const bound = ts.isIdentifier(instant) && fileReads.some((r) => r.end <= n.getStart(sf) && enclosingFunction(r) === fn && bindingOf(r) === instant.text);
      if (!bound) errors.push(`${at}: reachedOnServer judges at ${text}, not at an effect instant (await effectNowOf(uow)) read in the same function`);
    }
  }
  for (const [file, n] of Object.entries(serverInstant)) {
    if (SERVER_INSTANT_SITES[file] !== n) errors.push(`${file}: uow.serverInstant() called ${n} time(s); only the listed stamps may (${JSON.stringify(SERVER_INSTANT_SITES)})`);
  }
  for (const [file, n] of Object.entries(SERVER_INSTANT_SITES)) if (serverInstant[file] !== n) errors.push(`${file}: the listed serverInstant stamp is not there (${serverInstant[file] ?? 0} of ${n})`);
  const clockKeys = new Set([...Object.keys(clocks), ...Object.keys(PROCESS_CLOCKS)]);
  for (const file of clockKeys) {
    if (JSON.stringify(sortedEntries(clocks[file] ?? {})) !== JSON.stringify(sortedEntries(PROCESS_CLOCKS[file] ?? {}))) {
      errors.push(`${file}: process clocks ${JSON.stringify(clocks[file] ?? {})}, listed ${JSON.stringify(PROCESS_CLOCKS[file] ?? {})}`);
    }
  }

  // the effect reads are exactly the declared judgment sites, in order; each with its await table
  const expected = [...JUDGMENTS].map((j) => j.file);
  const found = reads.map((r) => r.file);
  if (JSON.stringify([...found].sort()) !== JSON.stringify([...expected].sort())) {
    errors.push(`effect reads ${JSON.stringify(found)} are not the declared judgment sites ${JSON.stringify(expected)}`);
    return errors;
  }
  const byFile = new Map<string, Array<{ read: ts.AwaitExpression; sf: ts.SourceFile }>>();
  for (const r of reads) byFile.set(r.file, [...(byFile.get(r.file) ?? []), { read: r.read, sf: r.sf }]);
  const ordinal = new Map<string, number>();
  for (const site of JUDGMENTS) {
    const k = ordinal.get(site.file) ?? 0;
    ordinal.set(site.file, k + 1);
    const { read, sf } = (byFile.get(site.file) as Array<{ read: ts.AwaitExpression; sf: ts.SourceFile }>)[k] as { read: ts.AwaitExpression; sf: ts.SourceFile };
    errors.push(...checkSite(site, read, sf));
  }
  return errors;
}

function sortedEntries(o: Readonly<Record<string, number>>): Array<[string, number]> {
  return Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The name an effect read is bound to: `const x = await effectNowOf(uow)` -> x; `{ serverNow: await effectNowOf(uow) }` -> serverNow. */
function bindingOf(read: ts.AwaitExpression): string | null {
  const p = read.parent;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
  return null;
}

function checkSite(site: JudgmentSite, read: ts.AwaitExpression, sf: ts.SourceFile): string[] {
  const errors: string[] = [];
  const fn = enclosingFunction(read);
  if (fn === undefined) return [`${site.site}: the effect read is outside any function`];
  const awaits = descendants(fn).filter((n): n is ts.AwaitExpression => ts.isAwaitExpression(n));
  const name = bindingOf(read);
  const line = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  if (name === null) return [`${site.site}: the effect read at ${site.file}:${line(read)} is not bound to a name`];
  if (ts.isPropertyAssignment(read.parent)) {
    // the facts' instant (S6): the last await of its function, judged by the caller
    const later = awaits.filter((a) => a.getStart(sf) > read.end);
    if (later.length > 0) errors.push(`${site.site}: awaits after the effect read (${later.map((a) => calleeText(a.expression, sf)).join(", ")}): it is not the last await`);
    return errors;
  }
  const judgment = descendants(fn).find(
    (n): n is ts.CallExpression =>
      ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "reachedOnServer" && n.getStart(sf) > read.end && n.arguments[1] !== undefined && ts.isIdentifier(n.arguments[1]) && n.arguments[1].text === name,
  );
  if (judgment === undefined) return [`${site.site}: the effect read at ${site.file}:${line(read)} judges nothing`];
  const before = awaits.filter((a) => a.getStart(sf) > read.end && a.end <= judgment.getStart(sf));
  if (before.length > 0) errors.push(`${site.site}: awaits between the effect read and the judgment (${before.map((a) => calleeText(a.expression, sf)).join(", ")}): the read is not after the last await`);
  if (site.effect === null) return errors;
  const effect = awaits.find((a) => a.getStart(sf) > judgment.end && calleeText(a.expression, sf) === site.effect);
  if (effect === undefined) return [...errors, `${site.site}: no effect ${site.effect} after the judgment`];
  // the refusal branch: the then-branch of the if whose condition holds the judgment, when it does not hold the effect
  const refusal = descendants(fn).filter((n): n is ts.IfStatement => ts.isIfStatement(n) && contains(n.expression, judgment) && !contains(n.thenStatement, effect)).map((n) => n.thenStatement);
  const between = awaits
    .filter((a) => a.getStart(sf) > judgment.end && a.end <= effect.getStart(sf) && !refusal.some((r) => contains(r, a)))
    .map((a) => calleeText(a.expression, sf));
  if (JSON.stringify(between) !== JSON.stringify(site.between)) {
    errors.push(`${site.site}: awaits between the judgment (${site.file}:${line(judgment)}) and the effect ${site.effect} (${site.file}:${line(effect)}) are ${JSON.stringify(between)}, declared ${JSON.stringify(site.between)}`);
  }
  return errors;
}

test("CS-C DENY clock census (sources): uow.serverInstant( only at request-deletion.ts (stamp); every reachedOnServer( judges at an effect instant (effectNowOf / effectInstant) read in the same function after its last await, or at a declared instant; process clocks only at the listed stamps; between each judgment and its effect only the declared awaits (S1/S3/S4 none, S2 the session secret)", () => {
  assert.deepEqual(clockCensus(sourceFiles(SOURCES)), []);
});

test("CS-C plants: a copy of complete-upload.ts judging at `await uow.serverInstant()` fails the census; a copy with an await planted between its judgment and its effect fails the census", () => {
  const files = sourceFiles(SOURCES);
  const original = files.get("handlers/complete-upload.ts");
  assert.ok(original !== undefined);
  const read = "await effectNowOf(uow)";
  assert.ok(original.includes(read), "complete-upload.ts reads the effect instant");
  const stale = new Map(files).set("handlers/complete-upload.ts", original.replace(read, "await uow.serverInstant()"));
  const staleErrors = clockCensus(stale);
  assert.ok(staleErrors.some((e) => e.startsWith("handlers/complete-upload.ts: uow.serverInstant() called 1 time(s)")), JSON.stringify(staleErrors));
  assert.ok(staleErrors.some((e) => /handlers\/complete-upload\.ts:\d+: reachedOnServer judges at /.test(e)), JSON.stringify(staleErrors));

  const effect = "const write = await uow.sources.uploads.transition(";
  assert.ok(original.includes(effect), "complete-upload.ts has its effect statement");
  const planted = new Map(files).set("handlers/complete-upload.ts", original.replace(effect, `await uow.sources.uploads.get(uploadId);\n          ${effect}`));
  const plantedErrors = clockCensus(planted);
  assert.ok(plantedErrors.some((e) => e.startsWith("S1 CMD014: awaits between the judgment") && e.includes('["uow.sources.uploads.get"]')), JSON.stringify(plantedErrors));

  // the read moved before the last lock (rule 25): an await between the read and the judgment
  const lock = "const upload = await uow.sources.uploads.lock(uploadId);";
  assert.ok(original.includes(lock));
  const early = new Map(files).set("handlers/complete-upload.ts", original.replace(`const effectNow = ${read};`, "").replace(lock, `const effectNow = ${read};\n          ${lock}`));
  const earlyErrors = clockCensus(early);
  assert.ok(earlyErrors.some((e) => e.startsWith("S1 CMD014: awaits between the effect read and the judgment")), JSON.stringify(earlyErrors));
});
