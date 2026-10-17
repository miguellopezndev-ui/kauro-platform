# Amendment A10 — visual identity: the Kauro palette, a light and a dark theme

Status: owner decision of 2026-10-17 (chat instruction, with reference sketches). Amends the reference UI_STATE_AND_COPY_CONTRACT
"Visual and interaction tokens" (text #17212B on white, primary action #0B6463 with white text, focus #005FCC) and B11 decision D-DS-1
("Light theme only at launch"). Everything else in that section stands: system-ui typography with no external font request, body text
16 px with 1.5 line height, dense secondary text never below 14 px, a visible two-pixel focus indicator with spacing, status as text or
icon plus colour, and WCAG 2.2 AA. Not yet hashed in PROVENANCE.md: it is added with the A7 re-issue.

## 1. The palette

The brand is four colours. Every token is one of them or a tint of one, except the four status families (danger, warning, success, info),
which are earthy versions chosen to sit with the palette and to keep their meaning.

| Name | Value | Role |
|---|---|---|
| Carbon | `#242426` | Text in the light theme; the page in the dark theme; the inverse band |
| Porcelain | `#F8F6F3` | The page in the light theme; text on wine and on carbon |
| Wine | `#653A46` | The primary action and the marks of the brand in the light theme; the wine band in both themes |
| Clay | `#C4A693` | Warmth and texture in the light theme; the primary action and the focus ring in the dark theme |

`packages/ui/src/tokens.ts` is the single source of truth (`BRAND`, `COLOR`, `COLOR_DARK`, `COLOR_INVERSE`, `COLOR_INVERSE_DARK`,
`COLOR_WINE`); `tokens.css` is its rendering, checked byte for byte.

## 2. Themes

1. **Light is the default.** The dark theme applies when the document says so (`<html data-theme="dark">`) or, with nothing stored, when
   the system asks for it (`prefers-color-scheme: dark`) and the document does not say light.
2. **The visitor's choice is a display preference and nothing else.** The theme control posts to `POST /preferences/theme`; the server
   answers with an `HttpOnly`, `SameSite=Lax` cookie `kauro_theme` (`light` or `dark`, one year) and the root layout and the legal
   documents read it to set `data-theme`. No browser source writes a browser store (D-PRIV-1 is unchanged); the cookie names no person,
   account or agency. Without script the control is a form that comes back to the page it was on (a path of the site only, never an
   absolute address); with script the page switches at once and the same choice is stored in the background.
3. **Bands.** A section may be drawn as an inverse (carbon) band or a wine band (`.kauro-inverse`, `.kauro-wine`). Each band redefines every
   token, so a control, a table or a state inside it follows the band in either theme.

## 3. Contrast

The same pairs are bound in every palette: each text pair reaches 4.5:1 and each indicator 3:1 (`TEXT_PAIRS`, `NON_TEXT_PAIRS` in
`tokens.ts`; `packages/ui/test/tokens.test.ts` and `styles.test.ts`). The focus colour is the primary colour of its theme, so the focus
ring stays an outline offset over the surface, never adjacent to a primary fill (D-DS-2); on a band it is clay, bound against both bands.

## 4. What does not change

No external font, script, image or stylesheet is requested (the policy of D-SEC-1 is unchanged: `font-src 'self'`, `img-src 'self'`,
`style-src-attr 'none'`); every rule is a class of `tokens.css`, `public.css` or `shell.css`. The copy rules of A3 and the registry's
primary copy for each screen are unchanged.
