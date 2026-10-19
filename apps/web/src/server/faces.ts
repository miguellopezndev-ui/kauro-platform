// The faces of the Kauro web (Order 10; docs/design/KAURO_VISUAL_IDENTITY.md §3), declared once and used by every document Kauro serves:
// the root layout and the legal pages (whose route handler writes its own document) both inline FACE_CSS under the request's nonce; the root
// layout also preloads Inter's roman (a legal page carries no <link>, D-LEGAL-1, and loads it from the declaration).
//
// - The official files are in public/fonts (licences and PROVENANCE.json beside them), served from Kauro's own origin at stable, versioned
//   paths: no font CDN, nothing fetched elsewhere (CSP font-src 'self').
// - "Inter Fallback" is the local Arial with Inter's metrics (the values next/font computes for Inter 4.1), so text does not reflow when
//   Inter arrives. JetBrains Mono falls back to the system mono, whose advance is close; its arrival moves a few technical lines slightly.
// - A browser downloads a face only when a page uses it; only Inter's roman is preloaded.
export const FONT_ROOT = "/fonts";

export const PRELOADED_FACE = `${FONT_ROOT}/inter-4.1/InterVariable.woff2`;

interface Face {
  readonly family: string;
  readonly file: string;
  readonly weight: string;
  readonly slant: "normal" | "italic";
}

export const FACES: readonly Face[] = [
  { family: "Inter", file: "inter-4.1/InterVariable.woff2", weight: "100 900", slant: "normal" },
  { family: "Inter", file: "inter-4.1/Inter-Italic.woff2", weight: "400", slant: "italic" },
  { family: "JetBrains Mono", file: "jetbrains-mono-2.304/JetBrainsMono-Regular.woff2", weight: "400", slant: "normal" },
  { family: "JetBrains Mono", file: "jetbrains-mono-2.304/JetBrainsMono-Medium.woff2", weight: "500", slant: "normal" },
  { family: "JetBrains Mono", file: "jetbrains-mono-2.304/JetBrainsMono-SemiBold.woff2", weight: "600", slant: "normal" },
  { family: "JetBrains Mono", file: "jetbrains-mono-2.304/JetBrainsMono-Bold.woff2", weight: "700", slant: "normal" },
];

const face = (f: Face): string =>
  `@font-face{font-family:"${f.family}";src:url("${FONT_ROOT}/${f.file}") format("woff2");font-weight:${f.weight};font-style:${f.slant};font-display:swap}`;

/** The @font-face rules of every face, and Inter's metric-matched fallbacks (roman and italic). */
export const FACE_CSS = [
  ...FACES.map(face),
  '@font-face{font-family:"Inter Fallback";src:local("Arial");font-style:normal;ascent-override:89.79%;descent-override:22.36%;line-gap-override:0%;size-adjust:107.89%}',
  '@font-face{font-family:"Inter Fallback";src:local("Arial Italic"),local("Arial");font-style:italic;ascent-override:89.21%;descent-override:22.21%;line-gap-override:0%;size-adjust:108.59%}',
].join("\n");
