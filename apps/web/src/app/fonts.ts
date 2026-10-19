// The faces of the Kauro web (Order 10; docs/design/KAURO_VISUAL_IDENTITY.md §3): Inter for everything, JetBrains Mono for technical
// information, Inter Italic for the editor's notes. Official files kept in src/fonts (licences and PROVENANCE.json beside them), served by
// next/font/local from Kauro's own origin under /_next/static/media: no font CDN, nothing fetched elsewhere (CSP font-src 'self').
//
// - Inter (roman) is preloaded and swapped in over a fallback whose metrics next/font adjusts to Inter's, so the text does not reflow
//   when it arrives.
// - The italic and the mono weights are not preloaded: a browser downloads a face only when a page uses it.
// - The faces reach the stylesheets through CSS variables on <html>; the tokens (packages/ui/src/tokens.ts) name them.
import localFont from "next/font/local";

export const interFace = localFont({
  src: [{ path: "../fonts/InterVariable.woff2", weight: "100 900", style: "normal" }],
  variable: "--kauro-face-inter",
  display: "swap",
  preload: true,
  adjustFontFallback: "Arial",
  fallback: [], // the stacks are in the tokens (packages/ui/src/tokens.ts)
});

export const interItalicFace = localFont({
  src: [{ path: "../fonts/InterVariable-Italic.woff2", weight: "100 900", style: "italic" }],
  variable: "--kauro-face-inter-italic",
  display: "swap",
  preload: false,
  adjustFontFallback: "Arial",
  fallback: [], // the stacks are in the tokens (packages/ui/src/tokens.ts)
});

export const monoFace = localFont({
  src: [
    { path: "../fonts/JetBrainsMono-Regular.woff2", weight: "400", style: "normal" },
    { path: "../fonts/JetBrainsMono-Medium.woff2", weight: "500", style: "normal" },
    { path: "../fonts/JetBrainsMono-SemiBold.woff2", weight: "600", style: "normal" },
    { path: "../fonts/JetBrainsMono-Bold.woff2", weight: "700", style: "normal" },
  ],
  variable: "--kauro-face-mono",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  fallback: [], // the stacks are in the tokens (packages/ui/src/tokens.ts)
});

/** The classes that define the three face variables, for the root element. */
export const FACE_CLASSES = `${interFace.variable} ${interItalicFace.variable} ${monoFace.variable}`;
