# Kauro visual identity

**Version 1.0 — integrated 2026-10-18.** This is the visual authority for every Kauro web surface. The owner of Kauro Data S.A.S. directed
and approved it; Claude (Anthropic's assistant) drew and implemented it (provenance:
[KAURO_VISUAL_PROVENANCE.md](KAURO_VISUAL_PROVENANCE.md)). The decision record of each design round is amendment A10
(`docs/authority/amendments/A10_VISUAL_IDENTITY.md`, §1–§9). This document states the resulting rules. Which screens follow them is listed
in [KAURO_SCREEN_COVERAGE.md](KAURO_SCREEN_COVERAGE.md).

**What the owner reviewed, and what they have not yet seen.** The owner reviewed the identity on the surfaces they could open: the public
site, the not-found page and the legal not-published card. The customer application and internal operations screens need a sign-in that
does not exist yet. On them, Claude extended the same identity technically (the application register of §10). The owner's direct visual
review of those screens is still pending; the integration does not count as that review.

The identity governs presentation only. It never overrides a security contract (CSP, no inline style, no remote resource), the
accessibility contract (WCAG 2.2 AA, focus, reduced motion), the copy contract (A3, `PUBLIC_COPY`, the screen catalogues) or any
functional decision.

## 1. Principles

1. **The product is the illustration.** Pictures are pieces of the product drawn in HTML from the synthetic sample: a project window, a
   file's rows, a report sheet, a ticket, a permissions panel. There are no stock images, no fake dashboards, no generic SaaS figures and
   no logo other than the wordmark.
2. **One object per idea.** A section makes its point with one physical object. The object is sized to its content, slightly off square,
   with real depth (a shadow, or rock beneath it). A stamp appears only where a verdict belongs: "Synthetic sample data", "Not found",
   "Same price, same discounts", "Never", "Free", "Not published".
3. **Editorial, minimal, high contrast.** Headlines are large and set in two weights. Body text sits on a calm measure. Sections are
   separated by space and hairlines, not by boxes.
4. **Remove before adding.** These are not allowed:
   - type larger than its meaning;
   - a panel with an empty half;
   - anything that follows the reader down the screen;
   - an isolated gimmick nothing else on the page echoes;
   - gradients used as decoration, or many colours.
5. **Sell honestly.** Every table, card, text and movement serves the decision to buy: it shows the product working and puts the proof
   beside the claim. The words come from the copy catalogues and keep A3's limits.
6. **Personality in doses.** Margin notes in an editor's italic, stamps and tilted cards carry the personality. They are never so many that
   the page stops being professional.

## 2. Colour

Source of truth: `packages/ui/src/tokens.ts`. `packages/ui/tokens.css` is generated from it and checked byte for byte; never edit the CSS
alone. Every text and non-text pair is checked against WCAG 2.2 AA in every palette by `packages/ui/test/tokens.test.ts`.

### Brand

| Name | Hex | Role |
| --- | --- | --- |
| Carbon | `#242426` | Text in the light theme; the background of the dark theme and of inverse bands. |
| Porcelain | `#F8F6F3` | The page in the light theme; text on dark and wine. |
| Wine | `#653A46` | The primary colour in the light theme; the middle colour that leads a page or a section; stamps; the CLEAN offer. |
| Clay | `#C4A693` | Accent; the primary colour in the dark theme; flags, rails, numbers and the rock texture. |

### Palettes (token → light / dark)

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| text | `#242426` | `#F1ECE6` | body text |
| textMuted | `#5F5955` | `#ADA59E` | secondary text, labels |
| background | `#F8F6F3` | `#242426` | page |
| surface | `#F1EDE8` | `#1D1D1F` | sunken sections, bars, table heads |
| raised | `#FFFFFF` | `#2D2C2F` | cards, panels, inputs |
| border | `#E3DCD4` | `#3A393D` | hairlines |
| primary / onPrimary | `#653A46` / `#F8F6F3` | `#C4A693` / `#242426` | primary action, links, focus |
| accent / accentText / accentSurface | `#C4A693` / `#7A5A45` / `#ECE2D9` | `#C4A693` / `#C4A693` / `#352E2A` | flags, rails, highlights |
| wine / onWine / wineMuted | `#653A46` / `#F8F6F3` / `#E3D3D2` | the same | wine bands and cards |
| status (danger, warning, success, info) | text + surface pairs | text + surface pairs | always with an icon or a word, never colour alone |

Bands:
- **Inverse** (`.kauro-inverse`): carbon, in either theme (`COLOR_INVERSE`, `COLOR_INVERSE_DARK`).
- **Wine** (`.kauro-wine`, `COLOR_WINE`): primary actions in porcelain with wine text, focus in clay.
- **Paper** (`.kauro-paper`): a document that keeps the light palette on a dark or wine band in the light theme, and becomes a raised dark
  sheet in the dark theme.

### Themes

- Light is the default. Dark applies when the stored preference says so (`kauro_theme` cookie → `<html data-theme>`), or when the system
  asks and no preference is stored.
- The switch is `ThemeControl`. It works without script; with script it is instant, and transitions are suspended during the switch
  (`data-theme-switching`).

## 3. Typography

**Agreed direction (owner, 2026-10-18):**
- a wordmark set in type only ("Kauro", no symbol);
- **Inter** for the brand, headings and text;
- **JetBrains Mono** for technical information where it helps legibility;
- no third face, and no serif.

The custom "a" of the wordmark is never applied to running text.

**Implemented on the web (Order 10, 2026-10-19).** Until then the web used system families and a Georgia note; that discrepancy, recorded on
2026-10-18, is closed. The decision record is A10 §11. Printed documents use the same files, embedded (§13).

| Role | Family (token) | Notes |
| --- | --- | --- |
| Body | Inter (`--kauro-font-family`) | 16 px, line height 1.5; dense metadata never below 14 px |
| Display (headings, figures, wordmark) | Inter (`--kauro-display-family`), its optical size axis giving large sizes their display cut | tight tracking (−0.02 to −0.05 em), weights 300 to 700 |
| Mono (file names, hashes, references, counters) | JetBrains Mono (`--kauro-mono-family`), 400 to 700 | 0.6875–0.875 rem; hashes break anywhere |
| Editor's note | Inter Italic (`--kauro-note-family`) | margin notes and quiet asides only |

**How the faces are served:**
- the official files and their provenance are in `apps/web/public/fonts`, served from Kauro's own origin at stable, versioned paths
  (`font-src 'self'`), with no font CDN;
- `apps/web/src/server/faces.ts` declares them once, and every document inlines that declaration under its nonce (the root layout and
  the legal pages alike);
- only Inter's roman is preloaded; the italic and the mono weights load when a page uses them;
- "Inter Fallback" carries Inter's metrics, so body text does not reflow on arrival; mono text may move slightly; every stack ends in a
  system stack;
- the faces apply to every document of the web, the implemented application screens included.

**The wordmark:** it is "Kauro" set in Inter. The custom "a" mentioned above has no reproducible artifact in the repository, so it is not
drawn; it awaits the owner's review.

**Narrow screens:** a table of four columns or more is laid out row by row below 40 rem, each value beside its column's name (`DataTable`),
so no word breaks inside a narrow column.

**Type roles:**
- **Headline in two weights:** the last words of an h1 are set light in the primary colour (`PageHead accent`, `Headline`). The text is
  the registry's own sentence, unchanged.
- **Figures:** prices and counts are display at weight 300, with tabular numbers. A currency code is set small and raised (`PriceFigure`).
- **Labels:** small uppercase with 0.06–0.12 em tracking, in textMuted (eyebrows, column heads, "Made for").
- **Hierarchy:**
  - one h1 per page;
  - sections own an h2 with `aria-labelledby`;
  - no level is skipped.

## 4. Grid, spacing, shape

- **Spacing scale (px):** 0, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128 (`--kauro-space-0…10`).
- **Page:** wrap max 80 rem (`--kauro-site-width`), gutter `clamp(1.25rem, 4.5vw, 3rem)`, at least 20 px on a phone.
- **Breakpoints in use:** 40 rem (phone → small tablet), 48 rem, 56 rem, 62 rem (two-column compositions), 64 rem.
- **Split sections:** heading 5 / content 7. Headings never stick to the screen.
- **Radius:** 4 px for controls (`--kauro-radius`), 10 px for cards, panels and dialogs (`--kauro-radius-large`), and pills for chips and
  states. Borders are 1 px. Touch targets are at least 44 px.
- **Tilt:** cards sit slightly off square, about 1° to 3°.
  - Directions alternate down a page. On Home: buyers left and right, pile left, permissions right, ticket left.
  - A family shares a direction: the not-found card and the not-published legal card both lean right.
  - A stamp leans against its card.
- **Depth:** a long soft shadow under objects that rest on something. Rock textures sit only under objects, never behind text.

## 5. Components

Primitives of the application (`packages/ui/src/components`, styled by `styles.ts`):
- buttons (primary, secondary, danger);
- fields with hint and error, and an error summary;
- tables with caption, sort, empty state and pagination;
- banners, status badges (tone + icon + word), the phase list, measures and counts;
- dialogs and disclosures, money and deadline;
- `SafeText`, for any value that comes from a customer or a file: bidi-isolated, wrapped and never interpreted as HTML.

The public site (`apps/web/src/public/`):
- `PageHead` (tones plain, clay, inverse, wine; compact size; two-weight accent);
- `Section` (stack or split, tones plain, sunken, clay, inverse, wine);
- `LinkButton`, `DataTable`, `PriceFigure`, `Stamp`, `ServiceState`, `FileName`;
- the product fragments of `artifacts.tsx` (Pane, Counts, Approval, Reconcile, ImportOrder, FileChips, Settings, MarginNote);
- the composed objects:
  - the journey (`journey.tsx`);
  - the buyer cards (`audience.tsx`);
  - the document pile (`package-folder.tsx`);
  - the permissions panel, the service board and the ticket (in `pages/home.tsx`);
  - the "who acts" card (`pages/how-it-works.tsx`);
  - the status panel (`pages/status.tsx`).

The shell (`apps/web/src/shell/`):
- the app header: wordmark, the agency label with its state, switch agency, theme, sign out;
- the agency tabs, a strip that scrolls inside itself on a phone;
- the main area with its fact lists, sections and actions;
- the refused and state panels;
- the not-found card.

## 6. Navigation and forms

- **Public header:** wordmark, theme control, Sign in, and a Menu button. The menu is a native disclosure that drops a small carbon card
  under its button. It dims the page a little, never covers or widens it, closes on Escape or a press outside, and shows no numbers.
- **Footer:** small wordmark, tagline, links, the "does not connect to a live CRM" note.
- **App navigation:** agency tabs under the header, the current one underlined in the primary colour.
- **Forms:**
  - every control has a visible label;
  - errors are named in a summary and beside the field;
  - short fields pair on a wide screen;
  - a submit never loses what the person typed;
  - a long value wraps.

## 7. Iconography and illustration

Icons are the few line glyphs of `packages/ui` (16 px, 1.5 px stroke, `currentColor`), always beside a word. Other marks are drawn in CSS:
the padlock, the check rings, the theme glyph and the menu glyph. Illustrations are the product fragments above. The rock and grain
textures are generated SVG served from the site's own origin (`apps/web/src/app/(public)/textures/`), placed only under objects. No
photograph, no external image, no `<img>` or `<svg>` in public page markup.

## 8. Motion and interaction

Motion serves the sale and stops for `prefers-reduced-motion`. **Text never moves on its own, and nothing is see-through on its way in:** objects arrive by movement only (rise, settle, scale), so every text is legible at every instant (the browser suite runs axe on the real build with motion on). Opacity changes only where two words trade places in one spot, or for the backdrop of the open menu.
1. **First impression:** on load the hero window settles and the stamp lands last. Interior head objects settle the
   same way.
2. **Arrival:** an object rises and settles into its own tilt when the reader reaches it. Each stamp lands just after its card. This is
   tied to the scroll (`animation-timeline: view()`) where the browser supports it; elsewhere objects are simply in place.
3. **Response:** a tilted card straightens a little under the pointer, a board row lifts, and buttons give under the press.
4. **Change:** an interactive piece moves only when something in it changes:
   - the journey's file folds, renames and counts down as approved changes apply;
   - the pile restacks;
   - a chip trades its words;
   - a count runs. It never reads the clock (K0); it uses the animation frame's timestamp.

No piece changes size while its content changes, so the page never jumps. A stamp mid-landing never widens the page.

## 9. States and responsive

- **Every state has a look:**
  - loading;
  - empty ("No decision is waiting");
  - success (success tone, check);
  - warning (clay-toned banner);
  - error and integrity failure (danger tone);
  - stale and expired;
  - step-up (identity confirmation, which keeps what was typed);
  - denied and restricted.

  A state is a panel with its heading, its words and one next step, never colour alone.
- **Before the script runs,** every interactive piece shows its content in place: all steps listed, the first document on top.
- **Checked at 320, 375, 768 and 1280 px:** there is no horizontal scroll. Wide tables scroll inside their own region, and hashes and
  references wrap.

## 10. Surfaces

- **Public site:** editorial. A hero object, one point per section, wine leading where a page has one point (How it works head, CLEAN,
  the context band, the contact aside), inverse bands for weight, sunken sections for rhythm.
- **Customer application** (technical extension by Claude; owner visual review pending): the same tokens, type and components in a
  calmer, functional register:
  - fact lists with hairlines;
  - one h1 and h2 sections;
  - status badges with words;
  - outlined secondary actions and a single primary action;
  - no decorative objects. The product itself is the content.
- **Internal operations (`/ops`)** (technical extension by Claude; owner visual review pending): the application register, with emphasis on exact values (amounts, references, hashes in mono) and
  on clearly named refusals.
- **Legal documents:** a reading column, and the not-found card stamped "Not published" while a document is unpublished. The identity
  never changes a legal text or its authority.

## 11. Representative examples in the code

- Hero product window and stamp: `apps/web/src/public/pages/home.tsx` (`ProductWindow`).
- One file through the process: `apps/web/src/public/journey.tsx`.
- Permissions panel and service board: `apps/web/src/public/pages/home.tsx`.
- Not-found card: `apps/web/src/app/not-found.tsx` and `apps/web/src/shell/shell.css`.
- App screen in the application register: `apps/web/src/screens/health-check/` with `apps/web/src/shell/shell.css`.
- Tokens and their contrast checks: `packages/ui/src/tokens.ts`, `packages/ui/test/tokens.test.ts`.

## 12. Rules for every new screen

1. Use the tokens and the existing components; add a token or a component only when nothing existing fits, and add it to the system
   (`packages/ui` or `apps/web/src/public/parts.tsx`), never as a page-local colour.
2. Pick the register of its surface (§10). A public section gets one object from the product; an application screen gets none.
3. Keep the hierarchy (one h1, h2 sections, no skipped level), AA contrast in both themes, visible focus, reduced motion, no inline style,
   no remote resource.
4. Check 320/375/768/1280 and both themes with axe before it is called done.
5. Add the screen to [KAURO_SCREEN_COVERAGE.md](KAURO_SCREEN_COVERAGE.md) and `docs/design/DESIGN-LEDGER.md` as "implemented, owner review
   pending" until the owner reviews it.
6. A change to the palette, the typography, the motion language or the structure of a surface is an evolution of the identity: it needs
   the owner's authorisation and a new version of this document.

## 13. Printed documents

These criteria were set by the owner's scope decision for deliverables (2026-10-18). Their first application is the B13 package report,
template 2 (`packages/reports/src/html.ts`; proposal and review in `docs/design/REPORT-REDESIGN-PROPOSAL.md`). They apply to a document
Kauro generates for a person (PDF or printed HTML).

**They are not retroactive.** A document already issued keeps its stored bytes and hashes; a new template or renderer version gives new
hashes and a new identity, and never rewrites an earlier one. They never change a document's facts: if a layout needs a figure, the figure
comes from the document's model, never computed by the layout.

1. **Typography:**
   - Inter for all text and JetBrains Mono for paths, hashes, references and numbering;
   - proportional figures (no `tnum`) and labels tracked by at most 0.06 em: tabular figures and wide tracking make the PDF's text
     lose the digits or read as spaced letters;
   - both embedded in the document from pinned, licensed official files (version, licence and SHA-256 recorded), never taken from the
     host's installed fonts and never fetched;
   - contextual alternates and stylistic sets off (`font-variant-ligatures: no-contextual; font-feature-settings: "calt" 0`), so the
     document's text extracts and searches exactly as written.
2. **Hierarchy:**
   - the brand that leads, then the verdict as a quiet label, then one h1 and the status sentence, then the attribution;
   - numbered h2 sections;
   - figures light and large where they summarise, medium in tables;
   - the first page lets a reader understand the result without removing anything from later pages.
3. **Spacing and composition:**
   - space, not lines, separates groups;
   - each element sits closer to what it belongs to than to its neighbours;
   - short tables may sit side by side, aligned on one line;
   - nothing is enlarged beyond its meaning.
4. **Tables:**
   - one rule under the head and quiet porcelain bands instead of a grid, with no double rules;
   - the total under a single rule;
   - numbers right-aligned in tabular figures;
   - paths break only after a slash, with the folder lighter than the file name;
   - hashes break anywhere;
   - a row with nothing in it is set back, not removed.
5. **Pagination:**
   - Letter and A4 differ only in the page rule;
   - table heads repeat, rows do not split, and headings stay with their content;
   - every page carries a running footer with the document title and "Page n of m".
6. **Palette, used by context, not by fixed proportions:**
   - carbon for text;
   - porcelain for panels and bands;
   - wine for the verdict, numbering and the one total that matters;
   - a light clay tint for a notice.

   No colour carries a meaning that the words do not also carry.
7. **The agency's identity:**
   - on a document an agency hands on, the agency's logo, or its display name set as a wordmark, leads the cover;
   - customisation is limited to the name and logo the platform admits;
   - Kauro's palette and type are the document's frame, never a competing mark.
8. **Kauro's attribution:** the issuer's legal identity always appears as a line of text from the terms facts (R2-070), never drawn as a
   brand and never replaced by white label. A document presented as delivered by Kauro itself (none exists yet) may carry the Kauro
   wordmark; it still follows these criteria.
9. **Accessibility:**
   - text is text, never an image of text;
   - contrast meets WCAG AA on the printed colours;
   - the document has a language, a title and a heading order;
   - a logo has the agency's name as its alternative text.
10. **Evidence and safety:**
    - the HTML document names its template (`<meta name="generator">`), the PDF's identity records that document's SHA-256, and the
      document names its inputs (package, manifest, model and renderer version); a new template deploys with a new `rendererVersion`;
    - it is inert (no script, no event handler, no inline style attribute, no URL other than its embedded `data:` image and fonts) under
      a restrictive CSP;
    - a content check proves that every text of the document survives into the PDF's extracted text, in the embedded faces only.
