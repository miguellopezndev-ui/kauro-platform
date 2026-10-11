// Workspace exports need dist declarations; existing tools checks also import compiled runtime source.
// verify:fast skips full workspace/Next.js builds, database/workspace tests, and clean-consume.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dependencyOrder, requireCommand, workspacePackages } from "./test-runner.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = workspacePackages(root);
const dependedOn = new Set(packages.flatMap(({ manifest }) =>
  Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter(([, version]) => version.startsWith("workspace:")).map(([name]) => name)));
// tsconfig paths must use forward slashes on every platform (backslashes give TS18003 on Windows).
const posix = (path) => path.replaceAll("\\", "/");
const work = mkdtempSync(join(tmpdir(), "kauro-types-"));
try {
  // the core wrappers are built too: K04 S045 (tools/test/vendor-cores.test.mjs) imports their dist
  const wrappers = new Set(["@kauro/migration-core", "@kauro/intelligence-core"]);
  const selected = packages.filter(({ manifest }) => dependedOn.has(manifest.name) || wrappers.has(manifest.name) || manifest.name === "@kauro/api" || manifest.name === "@kauro/web");
  for (const pkg of dependencyOrder(packages, selected)) {
    const web = pkg.manifest.name === "@kauro/web";
    const declarationsOnly = pkg.manifest.name === "@kauro/ui";
    const include = (web ? [join(pkg.dir, "src/client/identity/contract-fake.ts"), join(pkg.dir, "src/client/identity/select.ts")]
      : [join(pkg.dir, "src/**/*.ts"), join(pkg.dir, "src/**/*.tsx")]).map(posix);
    if (pkg.manifest.name === "@kauro/api") include.push(posix(join(pkg.dir, "test/support/fake-identity-server.ts")));
    const config = join(work, "tsconfig.json");
    writeFileSync(config, JSON.stringify({
      extends: posix(join(pkg.dir, web ? "tsconfig.node.json" : "tsconfig.json")),
      compilerOptions: {
        noCheck: true, emitDeclarationOnly: declarationsOnly, incremental: false,
        ...(!web ? { declaration: true, declarationMap: false } : {}),
        typeRoots: [join(pkg.dir, "node_modules/@types"), join(root, "node_modules/@types")].map(posix),
      },
      include,
    }));
    console.log(`prepare-fast: ${pkg.manifest.name} (${declarationsOnly ? "source declarations" : web ? "identity adapter" : "source runtime and declarations"})`);
    requireCommand("pnpm", ["exec", "tsc", "-p", config], pkg.dir);
    if (pkg.manifest.name === "@kauro/contracts") requireCommand(process.execPath, ["tools/copy-generated-assets.mjs"], pkg.dir);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
