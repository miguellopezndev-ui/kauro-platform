# Round 3: the kit (master plan §8.0)

**Version 0.9, draft** (2026-10-22). It is frozen as version 1 when groups B and D are decided. After that, a page that needs a new part
or a change files a system change request (§9), and every finished screen is recaptured and diffed.

The system is **c4, "one ledger with four mastheads"** (PD-05; `research/round3-slice/AUDITIONS.md`). This file is its kit: the tokens,
the type tiers, the spacing, the rules, the stamps, the objects, motion, the chart grammar, the icons and each component family's
decision. Records are in `Kauro.archive/Deliveries/Visual/order11/research/round3-kit/`:
- `INVENTORY.md`: 42 families on 71 screens;
- `auditions/<family>/`: the baseline v0 and three alternatives per family;
- `judging-<group>/`: batches, key, judged files and `score.json`;
- `DECISIONS.md`: each family's results and reasoning.

The reference code is the c4 stylesheet, `research/round3-slice/concepts/c4-synthesis/system.css`. It moves into `packages/ui` and
`apps/web` when the screens are built. Its token values already match `packages/ui/tokens.css`.

---

## 1. Colour roles

### 1.1 Dark web (every site)

| Role | Token (c4 / `packages/ui`) | Value | Contrast on page | Use |
|---|---|---|---|---|
| Page | `--bg` / `--kauro-color-background` | #242426 | — | the page |
| Sunken | `--bg-sunk` / `--kauro-color-surface` | #1D1D1F | — | sunken band, index column, footer |
| Deepest | `--bg-deep` / `--kauro-color-ink` | #19191B | — | the deepest band |
| Paper | `--paper` / `--kauro-color-raised` | #2D2C2F | — | a paper object only (slip, estimator, ticket, letter) |
| Field on paper | `--paper-2` | #353438 | — | a field inside a paper object |
| Ink | `--ink` / `--kauro-color-text` | #F1ECE6 | 15.0:1 | text, heavy rules |
| Quiet ink | `--ink-2` / `--kauro-color-text-muted` | #ADA59E | 6.2:1 | meta, basis lines, notes |
| Hairline | `--rule` / `--kauro-color-border` | #3A393D | — | rules between rows |
| Strong hairline | `--rule-2` | #57545A | — | table heads, column rules |
| Control border | `--control` / `--kauro-color-control-border` | #857D77 | 3.6:1 | outlined buttons, inputs |
| Clay | `--clay` / `--kauro-color-primary` | #C4A693 | 8.1:1 | actions, links, the current place |
| Clay hover | `--clay-hi` | #D6BFAE | — | hover |
| Brown | `--brown` / `--kauro-color-accent-surface` | #352E2A | — | the rock's shadow, accent surface |
| Wine | `--wine` / `--kauro-color-wine` | #653A46 | — | the one thing that matters most per screen; count badges; the public climax |
| On wine | `--on-wine` | #F8F6F3 | 9.6:1 on wine | text on wine |
| Quiet on wine | `--on-wine-2` | #E3D3D2 | 7.3:1 on wine | quiet text on wine |

**Status inks.** Always with a word and a glyph shape of their own, never colour alone (K21):
- danger #F0A49A;
- warning #E3BC74;
- success #A3CDA9;
- information #AFC3DA;
- quiet #ADA59E.

**Wine rules:**
- **One per screen.** Wine marks the one thing the reader came for: the "Needs you" block, the payout slip, the public closing band.
- **Count badges.** Wine count badges appear only on navigation where a decision waits (owner nav V1).
- **Never in a chart in a tool.** There, wine means "needs you" (§7).
- **Wine rock only behind money,** where the paper object is the one object of the screen: money approvals (K36) and the
  transfer slip on payment instructions (K17). Every other confirmation and object sits on carbon.

### 1.2 Light print (documents and emails, PD-01)

| Role | Value |
|---|---|
| Paper | #FFFFFF |
| Ink | #1B1B1D |
| Quiet ink | #55524F |
| Hairline | #D9D5D0 |
| Strong hairline | #A9A49E |
| Tint | #F4F2EF |
| Data series | #2E3138 (graphite, not a brand colour) |

- **White-label documents** use only these values (PD-02).
- **Kauro-branded documents** (quotes, statements, receipts) add wine and clay on paper. Their exact roles are decided in the
  deliverables track's auditions and added here through a change request.

## 2. Type

**Families:**
- the system sans on the web (owner rule: the web keeps system fonts);
- Segoe UI Variable Display for the pitch tier's display headlines;
- the system mono for references, codes and hashes (K17);
- Georgia for public margin notes only;
- **Inter** in print (pinned by `assets/fonts/PROVENANCE.json`).

**Figures.** Compared numbers use tabular, lining figures, right-aligned (PD-03).

| Tier | Role | px / line height | Weight |
|---|---|---|---|
| Pitch (public) | display h1, two weights (≤ 2 lines at 1280) | 40–52 / 1.04 | 650, accent 300 in clay |
| Pitch | closing headline, two weights | 34–56 / 1.04 | 650 + 300 |
| Pitch | section h2 | 26–32 / 1.15 | 650 |
| Pitch | lead · body · meta | 18/28 · 16/26 · 14/20 | 400 |
| Pitch | eyebrow | 12/16, caps, 0.16em | 600 |
| Pitch | price figure · estimator figure | 22/28 · 44/48 | 600 · 300 |
| Tool (private) | page title | 24/30 | 700 |
| Tool | numbered section, under a 2 px rule | 17/24 | 700 |
| Tool | sub-heading, row title | 14/20 (15 for sub-heads) | 700 |
| Tool | body, cells, nav, buttons | 14/20 | 400 (buttons 600) |
| Tool | meta, basis, context, column heads | 13/18 | 400 |
| Tool | label, stamp, footnote marker (**the floor**) | 12/16 | 600–700 |
| Tool | ledger figure · key figure on wine · slip figure | 22/28 · 30/34 · 44/48 | 600 · 700 · 300 |
| Print | title · subtitle · section | 28/32 · 16/22 · 16/20 | 700 · 500 · 700 |
| Print | chart title · body and tables (floor) · glance figure | 13/18 · 12/14–16 · 18/22 | 700 · 400 · 650 |

- **One size per role.** No size outside this table. Weight carries hierarchy in the tool tier, so sizes stay close.
- **Line length.** Body text runs 45–75 characters. Long-form text (K41) holds a measure of about 68 characters.
- **Floor.** 12 px everywhere, on the web and in print.

## 3. Space, grid and radii

- **Spacing** on a 4 px base: 4, 8, 12, 16, 24, 32, 48, 64, 96 (the `--s1`…`--s9` and `--kauro-space-*` tokens). No other value.
- **Sections:** 48 apart in the tools, 64 on the public site.
- **Measures:**
  - public 1200;
  - owner console full width with a 208 px index;
  - workspace 1200;
  - seller portal 1080 (a statement);
  - print Letter 816 px or A4.
- **Gutter:** `clamp(16px, 3.2vw, 40px)`.
- **Breakpoints** (four, replacing today's 23 values):
  - 480;
  - 768 (closed `Menu` on the workspace and seller portal; 44 px targets below it);
  - 1024 (closed `Menu` on the owner console and the public site);
  - 1280 (the project stage rail moves beside the content, K03).
- **Radii:**
  - 0 for the ledger;
  - 2 px for controls and stamps;
  - 4 px for fields;
  - 8 px for paper objects.
- **Elevation:**
  - none in the ledger;
  - one lift, Home's deep soft shadow, only for a paper object on rock.

## 4. Rules, sections and the ledger grammar

- **A numbered section** sits under a 2 px ink rule. The number is part of the heading, and long pages carry a contents block numbered
  to match (K04).
- **Rows** are separated by a hairline, with table heads on the strong hairline.
- **A total** is a 1 px rule over a double rule.
- **Amounts** are right-aligned over their basis, using the "figure over basis" row ("x of y").
- **Arithmetic** is written out on a balance line.
- **Footnotes** are tied to numbered definitions, ordered by first use.
- **Folds.** Long secondary detail starts in a closed fold (`<details>`), whose summary states what is inside and how many.
- **Masthead per site,** legible in greyscale:
  - owner console: heavy-over-thin rule;
  - workspace: single heavy rule;
  - seller portal: thin-over-heavy rule;
  - public site: Home's header, with no rule.

## 5. Stamps and tags

- **A stamp is a verdict only.** It has a word, a glyph and a double frame, set straight. The words:
  - Held, Paid, Draft, Blocked, With counsel (c4);
  - Read only, Restricted, Expired, Suspended (K27);
  - Authorised, Stopped (K41: whether a reviewed letter may be sent).
- **At most one stamp per region** (K27). It is never repeated down a list whose heading already says the state (K21).
- **A tag** (dashed, quiet, no frame) marks a proposal or a state that is not a verdict.

## 6. Objects, textures and motion

**Paper objects** appear only where the object is the answer:
- the payout slip (seller);
- the estimator and the closing ticket (Pricing);
- the confirmation slip with its code stub (K36);
- the transfer slip on payment instructions (K17);
- the reviewed letter (K41).

The package label (K18 v2) was not taken: a package is not money, so it gets no wine rock.

Each has an 8 px radius and a 1–1.5° tilt. A paper object takes Home's lift only on rock.

**Textures** go only under an object (Home's rule): ember rock, wine rock, carbon rock and grain.

**Motion:**
- in answer to the reader only (pointer, choice, state change), never on its own and never with the scroll (Order 10; BR-23);
- a paper object straightens and lifts 4 px on hover, as on Home;
- easing `cubic-bezier(0.2, 0.7, 0.2, 1)`;
- `prefers-reduced-motion` removes transitions. A still tilt stays, because it is not motion.

**Nothing follows the scroll** (BR-23). This rules out sticky indexes (K04) and viewport-corner toasts (K24).

## 7. The chart grammar (web dark, print light)

**A chart ledger:**
- one horizontal bar per object and a total bar;
- one zero baseline (an ink rule) and one scale, with light gridlines and a tick row under the total;
- **outcomes in a fixed order**: delivered → unified with approval → held back → not readable;
- **one series**, told apart by fill rather than colour: solid for delivered, hatched for unified, dotted for held back, a crossed
  outline for not readable;
- **a legend** with every outcome and its total, zeros included;
- **direct labels**, with each outcome's count in its own column;
- **the total row** carries the ledger's double rule;
- **a text alternative** for every chart: the figures as a table.

It survives greyscale.

**Colours by medium:**
- **Print:** the series is graphite #2E3138.
- **Dark web:** the series is porcelain #F1ECE6 on carbon (15:1), not an inversion. Gridlines are #3A393D and the baseline is ink.
  Wine never enters a chart in a tool.

**Funnels and meters** (K16) use the same ledger on the dark web:
- each bar sits on a full track (the whole) in quiet ink;
- the value stands in one right-aligned column, and states its basis ("13 of 16", "88 of 90 days", "64.0% of USD 4,240.50");
- a funnel writes the drop from the stage before on its row ("−3");
- a zero draws the empty track and says "0 of 3";
- the figures as a table sit behind one closed fold.

## 8. Component families

Each row: the decision, its evidence, and what the kit takes. Full tables are in `research/round3-kit/DECISIONS.md`.

### 8.1 Taken from c4 as decided in the slice (not auditioned again)

| Family | Kit part |
|---|---|
| K05 phone menu | a closed `Menu` disclosure, never wrapped tabs |
| K07 section heads | §4 |
| K10 money table, K15 balance line | right-aligned amounts over their basis; arithmetic written out |
| K12 table stacked on a phone | each row becomes a labelled block |
| K13 key figures, K14 figure over basis | a strip of key figures; "x of y" rows |
| K19 timelines and activity | the dated log list |
| K22 stamps | §5 |
| K23 counts | the wine count badge on nav only (§1.1) |
| K25 the wine block | one per screen |
| K30 links | clay, underlined, `→` for "go somewhere" links |
| K39 identity and switcher | the masthead names the workspace and role (workspace) or the seller and agreement (seller portal) |
| K40 help text and footnotes | §4; Georgia margin notes on the public site only |
| K42 bands and textures | §6 |

### 8.2 Group A (144 judgements)

| Family | Decision | Evidence |
|---|---|---|
| K27 page states | **v3, tiered by consequence.** Waiting states are a quiet line. Problems are a region notice with a glyph and a title. Verdict states get a stamp, a headline, the action under the text and a "Still available" list | 6–0, 6–0, 5–1 (lead 7.8) |
| K21 inline status | **v3 grouped for triage lists; v1 (a glyph and a word column) for ordered lists.** A colour means one thing, each meaning has its own glyph, and urgency shows in the date column | v3 is the bracket winner; v1 clearly beats the baseline; the split is my review (§9.5) |
| K29 buttons | **v1, a strict order of roles.** One filled button per view. Unavailable buttons are dashed with a lock and give their reason beside them. A busy mark sits inside the button, whose label stays. The destructive button stays outlined, even on hover. Plus v2's ruled action bar for form footers | v1 and v2 tie; v1 wins on its brief's safety rule (my review) |
| K36 confirmations and step-up | **v2, a slip with a tear-off code stub.** The act and the code are one object, and the primary keeps its real label. Wine rock only behind money approvals | 6–0 against every alternative |

### 8.3 Group C (150 judgements)

| Family | Decision | Evidence |
|---|---|---|
| K03 + K02 + K28 project navigation, header and stage | **v3.** Four area tabs and one header line ("Needs you · Stage 4 of 6 · Quote and payment"), with a dated stage rail and a NOW marker. The rail sits under the content below 1280 px or when the content is short. A stage name is never printed twice | It beats v0 and v1 6–0 and ties v2; v3 is chosen for consistency with c4's tabs (my review) |
| K04 + K06 sub-navigation and index | **v1 made static, plus v2's per-section status.** Quiet underline tabs. A "Settings · 1 of 4" select on the phone. A numbered contents block, never sticky | It beats v0 6–0; v1's sticky index fails BR-23 |
| K32 choice controls | **v1, ruled rows.** The meaning sits inside each row, and the chosen row has a clay edge. The declaration is a signed line. Toggles say On and Off. Locked rows say "Always sent" | It beats v0 6–0 |
| K31 + K33 + K34 inputs and field anatomy | **v0 kept (the incumbent), fixed.** The date is entered as month, day and year. A read-only field is dashed. File rows state their status in a word. The hint sits above the field. Drop zones are sized to their content | No challenger won clearly (§9.4) |

### 8.4 Group B (being judged)

K38 panels and paper objects, K11 facts and check your answers, K09 interactive table (with K37 action menus and K20 pagination),
K35 filters and search.

### 8.5 Group D (180 judgements)

| Family | Decision | Evidence |
|---|---|---|
| K17 code, hash, reference, copy value | **v2's field anatomy.** A mono value in a boxed field with Copy inside it, and "Copied" inside the button. References are never spaced. Account numbers are grouped for display and copied raw. A hash shows its first and last 8 characters, with the full value one click away. **The transfer slip on wine rock appears only on payment instructions (UI24)** | v2 6–0 clear against every alternative |
| K24 + K26 results after an action | **v1, the status line.** A consequential result is a dated line under the page head, with the next action at the right. A routine result is a short line beside its control. **No toasts.** On a phone the verdict sits on its own line | v1 clearly beats v0 and v3 and ties v2; v2's corner toasts fail BR-23 |
| K41 long-form | **v1 plus v3's citation apparatus.** The letter is the one paper object with its verdict stamp. Legal documents and guides are numbered c4 sections at about 72 characters, with a contents block, sub-clause numbers (3.3.a) and rules R1–R4 with May and Never. There is no rule under every paragraph | v1 and v3 both clearly beat v0 and split between themselves; my review keeps v1 and takes v3's apparatus, which the brief requires |
| K18 file lists and downloads | **v1, folders as sections.** "Download the package" comes first, then the package facts block, then the folders as numbered sub-sections. Import files are open and evidence folders closed with their counts. Every file and folder has one icon button. Resources are split into Current and Replaced | v1 and v2 both clearly beat v0 and tie; v2 puts wine behind a non-money object and drops per-file downloads |
| K16 dark charts, funnels, meters | **v0 stays (the incumbent), fixed with "of N" (K14).** The chart ledger on carbon puts each bar on a full track, with values in one right-aligned column. Every figure states its basis ("13 of 16", "88 of 90 days"), and the drop is written on the row | v3 wins 6–0, but its lead is 4.4, under the margin |

### 8.6 Not in the kit
- **K43 review chrome** is review-only and never enters the product bundle.
- **K08 footers:** private sites have none. Public footers keep Home's, which the public-site audit covers (master plan §10.4).

## 9. Icons

**One set, the incumbent, extended.** The kit keeps the hand-drawn set in `packages/ui/src/internal/icon.tsx`:
- 16 px grid, 1.5 px stroke, round caps and joins;
- inline SVG in `currentColor`, so it follows forced colours and needs no request;
- `aria-hidden`, because the word beside it carries the meaning;
- every status tone has its own outline (circle, triangle, octagon), so tone reads without colour (D-DS-1).

It grows by the glyphs the winning auditions draw, in the same grammar:
- copy and copied, download, lock, file and folder;
- external, calendar, search, filter, menu, close, chevron;
- stamp glyphs.

**Why not a library.** A library (Lucide, Phosphor, Heroicons) would add a dependency and a second stroke grammar beside the status
glyphs that already pass the colour-free test. No screen needs more than about 25 glyphs. This is my review's decision, not a judged
one, and the record says so.

## 10. Targets and gates

- **Targets:** 24 px everywhere and 44 px under 768 px wide (the slice gates found 18–20 px links in c4; the kit fixes them):
  - text links in lists get 12 px of block padding;
  - row actions are 32 px buttons, or 44 px on a phone.
- **Every kit part passes** `tools/round3/gates.mjs` at 8 widths: no overflow, no text under 12 px, no target under 24 px (44 px on a
  phone), and 0 axe violations.

## 11. Change control

1. A page that needs a new part, or a change, adds a row here under "Change requests" with the reason and its evidence.
2. The part is auditioned if it is non-trivial (master plan §8.3).
3. When the kit changes, every finished screen is recaptured and visually diffed against its committed snapshot. Any unexpected
   difference reopens that screen.

### Change requests
| # | From | Part | Change | Reason | State |
|---|---|---|---|---|---|
| CR-1 | Owner console · Today, L4 (`research/round3-owner/today/AUDITIONS.md`) | Folds (`k-fold`, K37) | On the phone, the "+" marker stays on the summary's first line beside its title (`flex-wrap: nowrap` on the marker; the title wraps) | Seen in all 15 L4 variants: a long fold title leaves the "+" alone on its own line | Open: apply at kit build, then recapture every finished screen |
| CR-2 | Owner console · Today final (`research/round3-owner/today/final/NOTES.md`) | Icons (§9) | Add an "already in another list" glyph (an up-arrow in a circle, 16 px, 1.5 px stroke) for rows that point to an item listed elsewhere on the page | Health groups items "Already in Needs you" apart from "Open, nothing for you to decide" (the clock); two groups need two shapes (K21) | Open: add to the icon set at kit build |
