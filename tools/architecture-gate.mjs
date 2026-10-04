// Architecture gate (07_DOMAIN "Platform topology": dependencies flow contracts -> domain ports -> application -> adapters; UI
// consumes HTTP DTOs; the cores depend on no persistence/payments/framework/UI; checks reject cycles, private core imports,
// server credentials in client bundles and deep imports). Static, dependency-free, deterministic: it scans every import/export
// specifier of every workspace package and applies architecture.rules.json. Exit 1 on any violation, listing file:line.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rules = JSON.parse(readFileSync(join(root, "architecture.rules.json"), "utf8"));
const argvRoot = process.argv[2] ? resolve(process.argv[2]) : root; // a fixture tree can be gated the same way (tests)

const SOURCE_EXT = new Set([".ts", ".tsx", ".mts", ".js", ".mjs"]);
// build and test outputs are generated, never source (.next: the Next.js build of apps/web; the Playwright result folders)
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "tmp", ".next", "test-results", "playwright-report", "blob-report"]);
const nodeSide = rules.clientBundleNodeSide ?? [];
const forbiddenDirectives = rules.forbiddenInClientBundles?.directives ?? [];
const forbiddenSpecifiers = rules.forbiddenInClientBundles?.specifiers ?? [];
const DIRECTIVE_RE = /^\s*(["'])(use [a-z]+)\1;?\s*(\/\/.*)?$/;
const serverConfigDirs = rules.serverConfigDirectories ?? [];
const serverOnlyImport = rules.serverOnlyImport ?? "server-only";
const environmentReaders = (rules.environmentReaders ?? []).map((pattern) => new RegExp(pattern));
const serverOnlyLine = new RegExp(`^\\s*import\\s+["']${serverOnlyImport}["'];?\\s*$`);

// a file's lines with its comments blanked (line numbers kept): a comment that talks about process.env reads nothing
function codeLines(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"));
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (SOURCE_EXT.has(p.slice(p.lastIndexOf(".")))) yield p;
  }
}

function workspacePackages(base) {
  const out = [];
  for (const group of ["packages", "apps"]) {
    const dir = join(base, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const pkgPath = join(dir, name, "package.json");
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      out.push({ name: pkg.name, dir: join(dir, name), group, layer: rules.layers[pkg.name] ?? null, deps: { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) }, devDeps: pkg.devDependencies ?? {} });
    }
  }
  return out;
}

const IMPORT_RE = /\b(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiersOf(file) {
  const text = readFileSync(file, "utf8");
  const found = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(line)) !== null) found.push({ spec: m[1] ?? m[2] ?? m[3], line: i + 1 });
  });
  return found;
}

function packageOfSpecifier(spec, pkgs) {
  const m = /^(@[^/]+\/[^/]+|[^@./][^/]*)(\/.*)?$/.exec(spec);
  if (!m) return null;
  const name = m[1];
  const sub = m[2] ?? "";
  return { name, sub, pkg: pkgs.find((p) => p.name === name) ?? null };
}

const pkgs = workspacePackages(argvRoot);
const violations = [];
const edges = new Map(); // pkg -> Set(pkg) for cycle detection
const testOnlySubpaths = rules.testOnlySubpaths ?? [];

for (const pkg of pkgs) {
  if (!pkg.layer) {
    violations.push({ file: join(pkg.dir, "package.json"), line: 1, rule: "layer", text: `${pkg.name} has no layer in architecture.rules.json` });
    continue;
  }
  const allowed = new Set(rules.allowedDependencies[pkg.layer] ?? []);
  const imported = new Set(); // workspace packages this package's files import (source and tests)
  for (const file of walk(pkg.dir)) {
    const rel = relative(argvRoot, file).split(sep).join("/");
    const inPackage = relative(pkg.dir, file).split(sep).join("/");
    const isTestFile = inPackage.startsWith("test/");
    // a node-side file of a client-bundle package (its tests, build scripts and configuration, the browser-test harness) never
    // reaches a browser: the client-bundle rules do not apply to it (B11 design D-SEC-2)
    const isNodeSide = nodeSide.some((entry) => (entry.endsWith("/") ? inPackage.startsWith(entry) : inPackage === entry));
    const isClientBundle = rules.clientBundles.some((prefix) => rel.startsWith(prefix)) && !isNodeSide;
    if (isClientBundle) {
      readFileSync(file, "utf8").split("\n").forEach((text, i) => {
        const m = DIRECTIVE_RE.exec(text);
        if (m && forbiddenDirectives.includes(m[2])) violations.push({ file: rel, line: i + 1, rule: "client-bundle", text: `a client bundle declares "${m[2]}" (no Server Action and no server data cache, B11 design D-SEC-2)` });
      });
    }
    if (isClientBundle && serverConfigDirs.length > 0) {
      const code = codeLines(readFileSync(file, "utf8"));
      const inConfig = serverConfigDirs.some((dir) => rel.startsWith(dir));
      const reading = code.findIndex((text) => environmentReaders.some((re) => re.test(text)));
      if (reading >= 0 && !inConfig) violations.push({ file: rel, line: reading + 1, rule: "server-config", text: `a client bundle reads the environment outside ${serverConfigDirs.join(", ")} (B11 design D-SEC-2)` });
      if (inConfig) {
        const first = code.findIndex((text) => text.trim() !== "");
        if (first < 0 || !serverOnlyLine.test(code[first])) violations.push({ file: rel, line: first < 0 ? 1 : first + 1, rule: "server-config", text: `a server configuration module must start with import "${serverOnlyImport}" (B11 design D-SEC-2)` });
      }
    }
    for (const { spec, line } of specifiersOf(file)) {
      if (isClientBundle && forbiddenSpecifiers.some((f) => spec === f || spec.startsWith(`${f}/`))) {
        violations.push({ file: rel, line, rule: "client-bundle", text: `a client bundle imports the forbidden module ${spec} (B11 design D-SEC-2)` });
      }
      if (spec.startsWith("node:")) {
        if (isClientBundle) violations.push({ file: rel, line, rule: "client-bundle", text: `client bundle imports a Node built-in (${spec})` });
        continue;
      }
      if (spec.startsWith(".")) {
        // relative import: must stay inside the package
        const target = resolve(dirname(file), spec);
        if (!target.startsWith(pkg.dir + sep) && target !== pkg.dir) {
          violations.push({ file: rel, line, rule: "sibling", text: `relative import escapes the package (${spec}); depend on a published entry point instead` });
        }
        continue;
      }
      const ref = packageOfSpecifier(spec, pkgs);
      if (!ref) continue;
      if (ref.pkg) {
        edges.set(pkg.name, (edges.get(pkg.name) ?? new Set()).add(ref.pkg.name));
        imported.add(ref.pkg.name);
        if (!(ref.name in pkg.deps) && !(isNodeSide && ref.name in pkg.devDeps)) violations.push({ file: rel, line, rule: "declared", text: `${ref.name} is imported but not declared in ${pkg.name}/package.json dependencies` });
        if (!allowed.has(ref.pkg.layer)) violations.push({ file: rel, line, rule: "layer", text: `${pkg.layer} package ${pkg.name} may not import ${ref.pkg.layer} package ${ref.name}` });
        if (ref.sub && !rules.publicSubpaths.some((s) => ref.sub === s || ref.sub.startsWith(s + "/"))) {
          violations.push({ file: rel, line, rule: "deep-import", text: `deep import into ${ref.name}${ref.sub}; only the public entry points are allowed` });
        }
        if (!isTestFile && testOnlySubpaths.some((s) => ref.sub === s || ref.sub.startsWith(s + "/"))) {
          violations.push({ file: rel, line, rule: "test-only", text: `production source imports the test-only subpath ${ref.name}${ref.sub}; only files under test/ may` });
        }
        if (ref.sub.startsWith("/src/") || ref.sub.startsWith("/dist/")) violations.push({ file: rel, line, rule: "private", text: `private module import ${spec}` });
      } else if (isClientBundle && rules.serverOnlyPackages.includes(ref.name)) {
        violations.push({ file: rel, line, rule: "client-bundle", text: `server-only package ${ref.name} imported from a client bundle` });
      }
    }
    if (isClientBundle) {
      const text = readFileSync(file, "utf8");
      for (const pattern of rules.credentialPatterns) {
        const re = new RegExp(pattern);
        const idx = text.search(re);
        if (idx >= 0) violations.push({ file: rel, line: text.slice(0, idx).split("\n").length, rule: "credential", text: `credential-like identifier ${pattern} in a client bundle` });
      }
    }
  }
  // a declared workspace dependency that no file of the package imports is an edge that still ships and installs
  for (const dep of Object.keys(pkg.deps)) {
    if (pkgs.some((p) => p.name === dep) && !imported.has(dep)) {
      violations.push({ file: relative(argvRoot, join(pkg.dir, "package.json")).split(sep).join("/"), line: 1, rule: "unused", text: `${dep} is declared in ${pkg.name}/package.json dependencies but never imported` });
    }
  }
}

// cycles (Tarjan is overkill: depth-first with a path stack over <= a few dozen packages)
function findCycle() {
  const state = new Map();
  const stack = [];
  function visit(n) {
    state.set(n, 1);
    stack.push(n);
    for (const m of edges.get(n) ?? []) {
      if (state.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m];
      if (!state.has(m)) {
        const c = visit(m);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  }
  for (const n of edges.keys()) if (!state.has(n)) {
    const c = visit(n);
    if (c) return c;
  }
  return null;
}
const cycle = findCycle();
if (cycle) violations.push({ file: "(graph)", line: 0, rule: "cycle", text: `dependency cycle ${cycle.join(" -> ")}` });

if (violations.length) {
  for (const v of violations) console.error(`${v.file}:${v.line}: [${v.rule}] ${v.text}`);
  console.error(`architecture gate: ${violations.length} violation(s) in ${pkgs.length} package(s)`);
  process.exit(1);
}
console.log(`architecture gate: ${pkgs.length} package(s), ${[...edges.values()].reduce((n, s) => n + s.size, 0)} edge(s), no violation`);
