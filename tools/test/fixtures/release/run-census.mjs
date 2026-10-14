import { census } from "./owned-census.mjs";
const r = census(process.argv[2]);
console.log(r.sites.length, r.stubs.length, JSON.stringify(r.aliasBindings), r.unresolved);
for (const s of r.sites) if (!s.owned) console.log("UNOWNED", s.file, s.line, s.path, "|", s.text.slice(0, 80));
