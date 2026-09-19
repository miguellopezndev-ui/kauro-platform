// Copies the generated JSON Schema bundle next to the compiled output so `@kauro/contracts/schemas.json` resolves from dist.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src", "generated", "schemas.json");
const dst = join(here, "..", "dist", "src", "generated", "schemas.json");
mkdirSync(dirname(dst), { recursive: true });
copyFileSync(src, dst);
console.log(`copied ${src} -> ${dst}`);
