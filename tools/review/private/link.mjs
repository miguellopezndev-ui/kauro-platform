// Gives the review project the web's packages without installing anything: node_modules here is a directory junction to apps/web's own
// (Windows needs no privilege for a junction; elsewhere it is a symlink). Run by tools/review/serve.mjs before it builds the review.
import { existsSync, lstatSync, symlinkSync } from "node:fs";
import { join } from "node:path";

export function linkModules() {
  const here = import.meta.dirname;
  const link = join(here, "node_modules");
  const target = join(here, "..", "..", "..", "apps", "web", "node_modules");
  if (!existsSync(target)) throw new Error(`no ${target}: run pnpm install first`);
  if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) return;
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll("\\", "/")}` || process.argv[1]?.endsWith("link.mjs")) linkModules();
