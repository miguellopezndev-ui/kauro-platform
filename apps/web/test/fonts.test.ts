// The faces of the web (Order 10): the official files kept in src/fonts are exactly the ones their provenance records, the faces the B13
// report embeds are the same bytes, and the font loader names only these files and never a remote source.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// the compiled test runs from dist/test: the sources are two levels up
const here = (path: string): URL => new URL(`../${path}`, import.meta.url);
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
interface Provenance {
  readonly families: readonly { readonly family: string; readonly licenseFile: string; readonly files: readonly { readonly file: string; readonly sha256: string; readonly sameAs?: string }[] }[];
}
const provenance = JSON.parse(readFileSync(here("../src/fonts/PROVENANCE.json"), "utf8")) as Provenance;

test("every face file is the one its provenance records, with its licence beside it, and only Inter and JetBrains Mono are kept", () => {
  assert.deepEqual(provenance.families.map((f) => f.family), ["Inter", "JetBrains Mono"]);
  for (const family of provenance.families) {
    assert.match(readFileSync(here(`../src/fonts/${family.licenseFile}`), "utf8"), /SIL Open Font License, Version 1\.1/);
    for (const face of family.files) assert.equal(sha(readFileSync(here(`../src/fonts/${face.file}`))), face.sha256, face.file);
  }
});

test("the faces the web shares with the printed report are byte for byte the report's", () => {
  const shared = provenance.families.flatMap((f) => f.files).filter((f) => f.sameAs !== undefined);
  assert.ok(shared.length >= 3);
  for (const face of shared) assert.equal(sha(readFileSync(here(`../../../${face.sameAs as string}`))), face.sha256, face.sameAs);
});

test("the font loader reads only these files, preloads only Inter's roman, and names no remote source", () => {
  const loader = readFileSync(here("../src/app/fonts.ts"), "utf8");
  const paths = [...loader.matchAll(/path: "\.\.\/fonts\/([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(paths.sort(), provenance.families.flatMap((f) => f.files.map((x) => x.file)).sort());
  assert.equal([...loader.matchAll(/preload: true/g)].length, 1);
  assert.doesNotMatch(loader, /https?:|next\/font\/google|@import/);
});
