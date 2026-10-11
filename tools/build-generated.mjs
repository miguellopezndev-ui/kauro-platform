// Full build after verify:fast has generated contracts; no gate or generation is repeated.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPackage, dependencyOrder, workspacePackages } from "./test-runner.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const pkg of dependencyOrder(workspacePackages(root))) {
  console.log(`build: ${pkg.manifest.name}`);
  buildPackage(pkg);
}
