// The faces of the web (Order 10): the official files kept in public/fonts are exactly the ones their provenance records, the faces the B13
// report embeds are the same bytes, and the one declaration (src/server/faces.ts) names only these files, from the origin, never a remote
// source.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FACE_CSS, FACES, FONT_ROOT, PRELOADED_FACE } from "../src/server/faces.ts";

// the compiled test runs from dist/test: the sources are two levels up
const here = (path: string): URL => new URL(`../${path}`, import.meta.url);
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
interface Provenance {
  readonly families: readonly { readonly family: string; readonly licenseFile: string; readonly files: readonly { readonly file: string; readonly sha256: string; readonly sameAs?: string }[] }[];
}
const provenance = JSON.parse(readFileSync(here("../public/fonts/PROVENANCE.json"), "utf8")) as Provenance;
const recorded = provenance.families.flatMap((f) => f.files);

test("every face file is the one its provenance records, with its licence beside it, and only Inter and JetBrains Mono are kept", () => {
  assert.deepEqual(provenance.families.map((f) => f.family), ["Inter", "JetBrains Mono"]);
  for (const family of provenance.families) {
    assert.match(readFileSync(here(`../public/fonts/${family.licenseFile}`), "utf8"), /SIL Open Font License, Version 1\.1/);
    for (const face of family.files) assert.equal(sha(readFileSync(here(`../public/fonts/${face.file}`))), face.sha256, face.file);
  }
});

test("the faces the web shares with the printed report are byte for byte the report's", () => {
  const shared = recorded.filter((f) => f.sameAs !== undefined);
  assert.ok(shared.length >= 3);
  for (const face of shared) assert.equal(sha(readFileSync(here(`../../../${face.sameAs as string}`))), face.sha256, face.sameAs);
});

test("the declaration names exactly the recorded files, from the origin, preloads Inter's roman only, and fetches nothing elsewhere", () => {
  assert.deepEqual(FACES.map((f) => f.file).sort(), recorded.map((f) => f.file).sort());
  assert.deepEqual([...new Set(FACES.map((f) => f.family))], ["Inter", "JetBrains Mono"]);
  assert.equal(PRELOADED_FACE, `${FONT_ROOT}/inter-4.1/InterVariable.woff2`);
  const urls = [...FACE_CSS.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.equal(urls.length, FACES.length);
  for (const url of urls) assert.ok(url?.startsWith(`${FONT_ROOT}/`), url);
  assert.doesNotMatch(FACE_CSS, /https?:|\/\/|@import|serif"/);
  assert.match(FACE_CSS, /font-family:"Inter Fallback";src:local\("Arial"\)/);
});
