// Test preload (node --import): the first recursive rmSync of a tree whose name starts with KAURO_EPERM_FAULT.prefix fails the way
// Codex's PR #112 round-2 run recorded on Windows ("EPERM, Permission denied" on the tree's root):
// - left: null       the tree is left intact (kauro-changed-cells-*, touch-*: 59 and 141 entries left);
// - left: [dirs...]  everything is removed except these empty directories (kauro-red-proof-*: repository; audit-kit-*:
//                    work/kauro-platform; kauro-red-test-*: repo and scratch).
// `code` replaces EPERM to inject a failure that is not a transient hold. The interception forwards every other call unchanged and
// removes nothing the caller did not ask to remove.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";

const fault = JSON.parse(process.env.KAURO_EPERM_FAULT ?? "null");
if (fault) {
  let remaining = fault.times ?? 1;
  fs.rmSync = new Proxy(fs.rmSync, {
    apply(target, self, args) {
      const [path, options] = args;
      if (remaining <= 0 || !options?.recursive || !basename(String(path)).startsWith(fault.prefix)) return Reflect.apply(target, self, args);
      remaining--;
      if (fault.left) {
        Reflect.apply(target, self, args);
        for (const dir of fault.left) fs.mkdirSync(join(String(path), dir), { recursive: true });
      }
      const code = fault.code ?? "EPERM";
      throw Object.assign(new Error(`${code}, Permission denied: ${path}`), { code, syscall: "rm", path: String(path) });
    },
  });
  syncBuiltinESMExports();
}
