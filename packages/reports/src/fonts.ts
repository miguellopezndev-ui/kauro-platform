/**
 * The faces the report embeds (template 2): Inter 4.1 and JetBrains Mono 2.304, official release files shipped with this package under
 * `assets/fonts` (licences and provenance beside them, assets/fonts/PROVENANCE.json). Each file is read once, the first time a report is
 * rendered, and refused unless its SHA-256 is the pinned one, so a document never embeds a face other than the recorded one. This is the
 * renderer's only read, and it reads only these files.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ReportModelError } from "./problems.js";

interface Face {
  readonly family: "Inter" | "JetBrains Mono";
  readonly weight: string;
  readonly file: string;
  readonly sha256: string;
}

export const REPORT_FACES: readonly Face[] = [
  { family: "Inter", weight: "100 900", file: "InterVariable.woff2", sha256: "693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3" },
  { family: "JetBrains Mono", weight: "400", file: "JetBrainsMono-Regular.woff2", sha256: "a9cb1cd82332b23a47e3a1239d25d13c86d16c4220695e34b243effa999f45f2" },
  { family: "JetBrains Mono", weight: "500", file: "JetBrainsMono-Medium.woff2", sha256: "086c48dfbea9ddaff1320f7e09399b8e2924e88ce67453721255db3bdbb5a353" },
];

let cached: string | null = null;

/** The @font-face rules of the embedded faces, each as a `data:` font. */
export function fontFaceRules(): string {
  if (cached !== null) return cached;
  const rules = REPORT_FACES.map((face) => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(new URL(`../../assets/fonts/${face.file}`, import.meta.url));
    } catch {
      throw new ReportModelError([{ code: "FONT_UNAVAILABLE", subject: face.file, detail: "a face the report embeds is not where the package ships it" }]);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== face.sha256)
      throw new ReportModelError([{ code: "FONT_UNAVAILABLE", subject: face.file, detail: "a face the report embeds is not the pinned file" }]);
    return `@font-face { font-family: "${face.family}"; font-style: normal; font-weight: ${face.weight}; src: url(data:font/woff2;base64,${bytes.toString("base64")}) format("woff2"); }`;
  });
  cached = rules.join("\n");
  return cached;
}
