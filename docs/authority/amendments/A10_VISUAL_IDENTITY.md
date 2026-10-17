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

## 5. The signature (2026-10-17, second pass)

The owner asked for more personality on the base of the reference sketches. What carries it, and the rule each keeps:

1. **Clay rock.** The brand's material: strata, layers laid down and refined. Five textures generated as SVG relief
   (`apps/web/src/app/(public)/textures`: clay, ember for the dark theme, wine, carbon and a grain), bundled by the build into
   `_next/static/media` and loaded from the site's own origin (`img-src 'self'`); no photograph and no request to another origin. Text
   never sits on the raw texture: a band that carries words lays a veil of its own colour over the rock first.
2. **The product, not a dashboard.** The Home figure is a project window drawn in HTML from the synthetic sample: the phases a project
   goes through, its counts, and three invented records (example.com addresses), one held for the customer's decision. It is hidden
   from assistive technology (the page says everything in words) and stamped "Synthetic sample data" in its caption (A3 3.6).
3. **Marginal notes and a stamp.** Two short notes in an editor's italic with thin leaders, and the synthetic label as a rubber stamp.
   Decorative, hidden from assistive technology, and words from the catalogue like every other word.
4. **Headlines in two weights.** The last words of a page's h1 are set light in the primary colour; the words are the registry's own and
   unchanged (one sentence for a screen reader and for the tests).
5. **The name, cut in clay.** The footer's wordmark is filled with the clay texture (`background-clip: text`), hidden from assistive
   technology (the header already names the site) and drawn in the system's text colour under forced colours.

## 6. Third pass (2026-10-17): the menu, fragments, and rock only under things

1. **The navigation is folded into a menu.** The header shows the name, the theme control, Sign in and a Menu button; the page links are
   one native disclosure (`<details>`), so the menu opens without script, stays the page's one "Main" navigation and keeps every link in
   document order. The script adds Escape and a click on the veil to close it. The open menu is a wine room with the pages set large
   and numbered.
2. **Fragments of the product beside the words** (`apps/web/src/public/artifacts.tsx`): the counts a check finds, a change waiting for
   approval, a sum that reconciles, an import order, a quote, importer settings, the same price for an agency and a company, where the
   files go (never from Kauro to a CRM), two customers behind their walls, the small window of a file a model may see. Values from the
   synthetic sample and the policy, words from the catalogue, hidden from assistive technology because the text beside them says it.
3. **Rock only under things.** The texture is a surface something rests on (the hero window, the sheets of a delivery, the report cover,
   the ticket of the free check) and never behind words: the footer wordmark cut in clay and the rock on the not-found page are removed,
   and the bands that carry text are their own colour with a grain.
4. **Wine as the middle colour.** Between porcelain and carbon, wine leads where a page says its one strong sentence: the context band
   of Home, the menu, the responsibility band of How it works, the scope question of Supported services, the free check, the contact aside.
5. **The not-found page** answers in the product's terms: a lookup that matched no row, stamped, beside the heading.

## 7. Fourth pass (2026-10-17): walk the process, and every section built from its own content

1. **The menu is a card, not a room.** The folded navigation opens as a carbon card under its button; it never covers the page, never
   locks its scroll and never widens it. Escape or a click outside closes it. Without script it is still the native disclosure of §6.
2. **The process is walked, not read** (`apps/web/src/public/journey.tsx`). Home's process is four steps on a rail: measure, decide,
   prepare, import. Each one shows the Kauro window at that step. The counts run up as they are measured. The visitor approves the three
   proposed changes themselves (real buttons, `aria-pressed`). The rows reconcile in prepare, and the files fall into order in import.
3. **Interactive pieces are progressive.** The journey, the buyer switch (`audience.tsx`), the delivery folder (`package-folder.tsx`) and
   the step reader of How it works (`scrolly.tsx`) render every panel stacked before the script runs. After it they become an ARIA tabs
   pattern (arrows, Home, End) or a scroll-driven stage. The figures they draw are hidden from assistive technology; the words beside
   them carry the meaning. Every animation stops for `prefers-reduced-motion`, and no hook reads the clock (K0): a count runs on the
   animation frame's own timestamp.
4. **Section by its content.**
   - The buyer section switches between an agency's client workspaces and a company's single workspace, with the same price.
   - The delivery section is a folder with wine tabs whose open document sits beside its explanation, with no wine box.
   - The limits are struck-through sentences, not a diagram.
   - The offer leads with CLEAN on wine (who it is made for, what arrives, from what price). HubSpot and Salesforce follow as the two
     qualified destinations, and on Supported services CLEAN's card spans the row.
   - Data handling answers a cross-customer request with a "Not found" stamp and shows the model's limited context as a redacted file.
5. **Depth only where something rests.** The ticket of the free check carries a shadow over a darkened rock, so it sits in front of it.
   The 404 is one larger tilted lookup card that holds the heading, the zero and the stamp together.
