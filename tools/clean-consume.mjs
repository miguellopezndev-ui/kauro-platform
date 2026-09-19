// S045: a clean checkout has no sibling workspace or prior cache — packages install, build and are consumed through declared
// dependencies only. This script packs every publishable workspace package (pnpm pack), installs the tarballs into a fresh
// consumer project in a temporary directory with an empty store, imports each public entry point and runs a smoke call.
// Nothing from the workspace is reachable from the consumer except through the tarballs.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publishable = [];
for (const group of ["packages"]) {
  const dir = join(root, group);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const pkgPath = join(dir, name, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.private) continue;
    publishable.push({ name: pkg.name, dir: join(dir, name), pkg });
  }
}
if (publishable.length === 0) throw new Error("no publishable workspace package found");

const work = mkdtempSync(join(tmpdir(), "kauro-clean-consume-"));
const tarballs = join(work, "tarballs");
mkdirSync(tarballs);
const consumer = join(work, "consumer");
mkdirSync(consumer);
try {
  const spec = {};
  for (const p of publishable) {
    const out = execFileSync("pnpm", ["pack", "--pack-destination", tarballs], { cwd: p.dir, encoding: "utf8", shell: process.platform === "win32" });
    const file = out.trim().split(/\r?\n/).pop();
    const path = resolve(p.dir, file);
    spec[p.name] = "file:" + path.split("\\").join("/");
    console.log(`packed ${p.name} -> ${path}`);
  }
  // A packed workspace package declares its sibling dependencies by version (pnpm pack rewrites workspace:*); the consumer
  // must resolve them to the tarballs, never to a registry, so every sibling is also an override.
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "kauro-clean-consumer", private: true, type: "module", dependencies: spec, pnpm: { overrides: spec } }, null, 2));
  writeFileSync(join(consumer, ".npmrc"), `store-dir=${join(work, "store").split("\\").join("/")}\nnode-linker=isolated\n`);
  execFileSync("pnpm", ["install", "--ignore-workspace", "--no-frozen-lockfile"], { cwd: consumer, stdio: "inherit", shell: process.platform === "win32" });
  const smoke = `
import { structuredDigest, DOMAINS, canonicalize, CONTRACT_NAMES, COMMANDS, provenance } from "@kauro/contracts";
import { readFileSync } from "node:fs";
const schemas = JSON.parse(readFileSync(new URL(import.meta.resolve("@kauro/contracts/schemas.json")), "utf8"));
const d = structuredDigest(DOMAINS.QUOTE_TERMS, 1, { items: ["a", "b"], currency: "USD", amount: "129500" });
if (!/^[0-9a-f]{64}$/.test(d)) throw new Error("digest shape");
if (canonicalize({ b: 1, a: [2, 1] }) !== '{"a":[2,1],"b":1}') throw new Error("canonical");
if (CONTRACT_NAMES.length !== Object.keys(schemas.$defs).length) throw new Error("schemas vs types");
if (COMMANDS.length < 60) throw new Error("commands");
console.log("clean consumer ok:", CONTRACT_NAMES.length, "contracts,", COMMANDS.length, "commands, provenance", provenance().files["contracts.json"].slice(0, 12));
// every other publishable package resolves and exposes its public entry point from the tarball alone
for (const name of ${JSON.stringify(publishable.map((p) => p.name).filter((n) => n !== "@kauro/contracts"))}) {
  const m = await import(name);
  if (typeof m !== "object" || m === null || Object.keys(m).length === 0) throw new Error(name + " has an empty public entry point");
  console.log("clean consumer ok:", name, Object.keys(m).length, "exports");
}
`;
  writeFileSync(join(consumer, "smoke.mjs"), smoke);
  execFileSync("node", ["smoke.mjs"], { cwd: consumer, stdio: "inherit" });
  // the consumer must not see the workspace: no symlink into the repo, no workspace protocol
  const lock = readFileSync(join(consumer, "pnpm-lock.yaml"), "utf8");
  if (lock.includes("link:") || lock.includes("workspace:")) throw new Error("consumer lockfile references the workspace (link:/workspace:)");
  console.log("clean-consume: every publishable package installs and works from its tarball alone");
} finally {
  rmSync(work, { recursive: true, force: true });
}
