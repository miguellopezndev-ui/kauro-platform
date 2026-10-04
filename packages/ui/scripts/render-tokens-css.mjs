// Writes packages/ui/tokens.css from renderTokenCss (src/tokens.ts and src/styles.ts). Run it through `pnpm --filter @kauro/ui run generate`
// after a build; packages/ui/test/tokens.test.ts checks the file byte for byte, so a stale stylesheet fails the tests.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderTokenCss } from "../dist/src/index.js";

const target = join(import.meta.dirname, "..", "tokens.css");
writeFileSync(target, renderTokenCss(), "utf8");
process.stdout.write(`wrote ${target}\n`);
