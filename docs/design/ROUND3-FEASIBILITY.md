# Round 3: Day-0 feasibility record

Written 2026-10-21 from real checks on the owner's Windows 11 machine (10.0.26300), Node 24.20.0, pnpm 10.16.1, repository on
`order11/private-review` (at `5cbf9ec7` when the check began; another session committed up to `67677078` while it ran). It answers master plan §3.0 and deliverables plan §1.1, §1.3 and §6. Nothing was installed
or downloaded, no tracked file was changed, nothing was committed, and the review server on port 4400 was not touched. Scratch work
ran in `%TEMP%\kauro-round3-dryrun` and was deleted afterwards; the scripts used are described in each row so they can be rebuilt.

**Rule carried from §3.0:** a check whose tool is missing uses the fallback written here, and that fallback is the bar for the check
until the owner answers. Nothing is installed mid-run.

---

## 1. Checks, tools and fallbacks

Launch tests used the repository's own `@playwright/test` 1.63.0 (resolved from `apps/web`). Its `browsers.json` expects Chromium
revision 1243, Firefox 1543 and WebKit 2359. `%LOCALAPPDATA%\ms-playwright` holds only `chromium-1243`,
`chromium_headless_shell-1243`, `ffmpeg-1011` and `winldd-1007`.

| Check | Tool | Present? (version/path) | Works? | Fallback that counts as the bar |
| --- | --- | --- | --- | --- |
| Capture harness, Chromium | Playwright bundled Chromium | Yes: `ms-playwright\chromium-1243` (153.0.8010.12), headless shell 1243 | Yes: launch, `setContent`, screenshot, canvas pixels; about 0.4 s per launch | (not needed) |
| Capture harness, Edge | Playwright `channel: "msedge"` | Yes: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` 155.0.4283.62 | Yes, same checks; about 1 s per launch | (not needed) |
| Chrome | Playwright `channel: "chrome"` / `KAURO_PDF_BROWSER` | No Google Chrome installed | No (`chrome` channel not found) | Edge serves wherever a branded Chromium is needed |
| Firefox | Playwright's patched Firefox (rev 1543) | **No** (`ms-playwright\firefox-1543` absent) | No | **Installed Firefox 157.0.1** (`C:\Program Files\Mozilla Firefox\firefox.exe`) through Playwright's WebDriver BiDi channel `firefox.launch({ channel: "moz-firefox" })`. Tested: launch about 2 s, screenshot, canvas pixels, canvas blur, `ariaSnapshot`, axe all work. Limits found: `emulateMedia` sets `prefers-color-scheme` but **not** `prefers-reduced-motion` or `forced-colors`, and `layout-shift` entries are not reported (CLS reads 0). Bar: every Firefox check runs on moz-firefox; reduced motion, forced colours and CLS are judged in Chromium only, and the record says so |
| WebKit (Safari engine) | Playwright WebKit (rev 2359) | **No** (`ms-playwright\webkit-2359` absent; no Safari on Windows) | No | No real equivalent offline. Bar: Chromium + Edge + Firefox pass, plus a written list of the CSS features the pages use that differ in Safari (checked against the kit, not a render). WebKit rendering is **not verified** until the owner decides (§4) |
| axe | `@axe-core/playwright` 4.13.0 with `axe-core` 4.13.0 (devDependency of `apps/web`) | Yes | Yes in Chromium, Edge and moz-firefox (a planted missing `alt` was reported as `image-alt`). It needs a page from `browser.newContext()`; `browser.newPage()` makes it refuse | (not needed) |
| Colour-vision simulation | CDP `Emulation.setEmulatedVisionDeficiency` | Yes (Chromium/Edge) | Yes: protanopia, deuteranopia, tritanopia, achromatopsia, blurredVision all accepted | Outside Chromium: an SVG `feColorMatrix` / CSS `grayscale()` filter applied to the page or the screenshot |
| Screen reader | Windows Narrator | Yes: `C:\Windows\System32\Narrator.exe` 10.0.26100.8972 | Present but **not scriptable** reliably, and an autonomous run cannot do a manual pass | **Accessibility-tree walk from Playwright**, in reading order, with names, roles and states: `locator.ariaSnapshot()` works in Chromium and moz-firefox (tested: landmark, link, heading level, `button [pressed]`), and CDP `Accessibility.getFullAXTree` in Chromium. A Narrator pass is listed for the owner's walk, not claimed |
| Media emulation | Playwright `emulateMedia` | Yes | Chromium: dark, reduced motion and forced colours all match. Firefox: colour scheme only | As in the Firefox row |
| Colour-share meter (pixels) | `sharp` or `pngjs` | **Not in the repository** (only inside the Codex runtime cache, `C:\Users\migue\.cache\codex-runtimes\...`, which belongs to another tool and is not used) | n/a | **`@napi-rs/canvas` 0.1.100**, already in the repository as pdf.js's dependency: `loadImage` + `getImageData` read a 918×1188 PNG in 40 ms in Node. Also `getImageData` on a canvas inside a Playwright page (tested in all three engines). Either counts |
| Gaussian blur (blur test, Home DNA) | Canvas `ctx.filter = "blur(Npx)"` | Yes | Yes in Chromium, Edge, moz-firefox and `@napi-rs/canvas` (a hard edge read back as a blended pixel) | CSS `filter: blur()` on the page |
| APCA contrast | A small local function | No package (none needed) | Yes: APCA-W3 0.0.98G-4g written locally gives black on white Lc 106.04, white on black −107.88, `#888` on white 63.06, the published reference values | (not needed) |
| WCAG contrast | `packages/ui` contrast arithmetic | Yes (tested by `@kauro/ui`) | Yes | (not needed) |
| Lighthouse | `lighthouse` | **No**: not in `node_modules`, not global (`npm ls -g` lists only pnpm), not in the npx cache | No (`npx` would download, not allowed) | **Playwright metrics:** `PerformanceObserver` LCP (tested: Chromium and Firefox) and CLS (Chromium), navigation and resource `transferSize` per type for JS, CSS, font and texture weight, and CDP `Performance.getMetrics` (36 metrics). The budgets of Foundations are set on these numbers. No Lighthouse score is reported |
| PDF structure | pdf.js (`pdfjs-dist`) | Yes: 5.6.205, a dependency of `packages/data-plane` (`node_modules\.pnpm\pdfjs-dist@5.6.205`), legacy build | Yes, on the rendered Letter report: 4 pages, `/Lang` en-US, MarkInfo `Marked: true`, a structure tree on page 1 (197 nodes: Document, H1, H2, P, Table, TR, TH, TD, NonStruct), 70 marked-content runs, fonts embedded as subsets (Inter variable and JetBrains Mono, none missing) | (not needed) |
| PDF page renders (greyscale, contact sheet) | pdf.js + `@napi-rs/canvas` | Yes | Yes: page 1 to PNG at 1.5× (918×1188) in about 350 ms; greyscale is a pixel pass on that PNG | (not needed) |
| Second PDF text reader | Xpdf `pdftotext` (ships with Git for Windows) | Yes: `/mingw64/bin/pdftotext` 4.06 | Yes (`-layout` text of the report) | (not needed) |
| PDF/UA validation | veraPDF (needs Java) | **No**: no `java` on PATH, no `JAVA_HOME`, no JDK under Program Files; no veraPDF | No | **pdf.js reads:** the structure tree and its order against the visual order, `/Lang`, MarkInfo, headings and table header cells, embedded fonts, and text extraction compared with `pdftotext`. Bar: those checks pass. The record states that PDF/UA conformance is **not validated** without veraPDF |
| JSON against a schema | `ajv` 8.20.0 + `ajv-formats` 3.0.1 (through Fastify) | Yes | Present (resolved; not exercised on a package) | (not needed) |
| CSV strict parse | A CSV library | **No** CSV library in the repository | n/a | A local strict RFC 4180 parser (small function) plus Migration Core's own verifier, which already proves canonical CSV bytes (`artifacts.canonicalBytes`) and headers; HubSpot and Data Loader rules are checked from their documentation as data |
| Markdown by two renderers | `markdown-it`, `marked`, pandoc, Python-Markdown | **None** (no npm package, no pandoc, Python 3.13 without `markdown`) | No | A local structural check of the generated Markdown (headings, list and table syntax, links) and a raw-text read. Bar: that check passes; rendering parity across two renderers is **not verified** until the owner decides (§4) |
| Visual diff and regression snapshots | `pixelmatch` or similar | No | n/a | A local per-pixel compare through `@napi-rs/canvas` `getImageData` |
| Judging and persona walks (§9.4, §3.1 items 8 and 10) | Fresh-context agents | The agent tool is available to the session | Not measurable from the machine | The ceilings of §9.4 (60 per decision, 700 Tier A page, 250 Tier B, 20 Tier C, six held back for the final). When a ceiling or a refusal stops a bracket, the leader goes to the final match, as §9.4 already says |

---

## 2. Dry runs

All times are wall-clock on this machine. Logs were kept in the scratch folder for the run and deleted with it.

### 2.1 Platform suites

| Command (from `C:\Users\migue\Projects\Kauro`) | Time | Result |
| --- | --- | --- |
| `pnpm --filter @kauro/ui run test` | 1 s | Pass, 60/60. It runs the compiled `dist`, built 2026-10-21 18:01, after the last `packages/ui` source change (17:54) |
| `cd apps/web && npx tsc -p tsconfig.node.json` | 5 s | Exit 0 |
| `cd apps/web && node --test "dist/test/**/*.test.js"` | 6 s | Pass, 332/332 |
| `cd tools/review/private && npx tsc --noEmit -p tsconfig.json` | 7 s | Exit 0 |
| `node --test tools/test/review-private-inventory.test.mjs` | under 1 s | Pass, 2/2 |
| `pnpm run verify:fast` | 250 s | Exit 0. Tools tests 351: 345 pass, 6 skipped (Linux-only signal tests, by design); architecture gate, fixture clock, OpenAPI (159 operations), web client and matrix all pass. Contract generation is byte-identical (no tracked change) |
| `PGBIN=<PGBIN> pnpm -r --no-bail run test` (the workspace half of the root `test` script; the tools half ran inside `verify:fast`) | 25 min (cut by a 1,500 s cap just after the last package reported) | Every package reported. 12 of 13 green: contracts 12, ui 60, migration-core 1, intelligence-core 4, domain 161, reports 114, application 237, persistence 802 (6.4 min), authorization 12, data-plane 151 (1.5 min), web 332, control 135 (5.7 min), all passing. **api: 1,320 pass, 1 fail, 22 skipped, 82 todo of 1,425 (17 min).** The failure is file-level: `dist/test/refund-generic-cells.test.js` ended as failed after 69.5 s with no failing assertion inside it. Run alone (`node --test dist/test/refund-generic-cells.test.js` with `PGBIN`) it **passes**: 134 pass, 11 skipped, 0 fail, 230 s. It is a transient failure under load (the file runs race and timeout cells, the Windows timing class in the flakes record), not a broken test. The `⚠` lines under `cmd063-sender-identities` are recorded gaps (GAP-RS-2) marked todo, not failures |
| `pnpm run verify` (verify:fast + full builds + all workspace tests + clean-consume) | not run | Its parts were run separately above; the full builds were skipped (see §3, risk 1) |
| Public e2e (`pnpm --filter @kauro/web run e2e`) | not run | Needs the standalone build and a server; skipped as instructed |

### 2.2 The PDF render

`pnpm -r build` was **not** needed: `packages/data-plane/dist` and `packages/reports/dist` exist, built 2026-10-21 06:36, after the last
source change to either package (2026-10-19, `4c90aa1f`).

```sh
cd packages/data-plane
KAURO_PDF_BROWSER="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" \
KAURO_REQUIRE_PDF_ENGINE=1 \
KAURO_PDF_EVIDENCE_DIR="<scratch>\pdf" \
node --test --test-reporter=spec dist/test/report-pdf.test.js
```

- **15 s, pass 13/13, 0 skipped** (`KAURO_REQUIRE_PDF_ENGINE=1` turns a missing browser into a failure, so the engine really ran).
  The browser probe recorded `chromium/155.0.4283.62`.
- PDFs written: `report-LETTER.pdf` 539,935 B (4 pages, 612×792 pt), `report-A4.pdf` 539,263 B,
  `report-A-clean-multi-object-LETTER.pdf` 539,935 B, `report-D-salesforce-LETTER.pdf` 541,147 B, plus `browser.json`,
  `report-LETTER.json` and `report-A4.json`.
- **Baseline kept:** `report-LETTER.pdf` (sha256 `2c84888709e3c0f09fd367dfd838dbbcba008371f0633dc278cc42bbd25ba2f2`), its
  `report-LETTER.json` and `browser.json` were copied to
  `C:\Users\migue\Projects\Kauro.archive\Deliveries\Visual\order11\research\round3-docs-baseline\` (hash-checked after the copy).

### 2.3 Migration Core acceptance in a scratch copy

- **Copy:** `cores/kauro-migration-core` is 8.1 MB and has **no `node_modules` and no `dist`** in the repository. It was copied whole.
  ESM ignores `NODE_PATH`, so its dependencies were **copied** (not linked, not downloaded) from the repository's pnpm store into the
  copy's own `node_modules`: `fflate` 0.8.3, `libphonenumber-js` 1.13.12, `@types/node` 24.3.1, `undici-types` 7.10.0 (24 MB in all).
- **Build:** `node <repo>/node_modules/.pnpm/typescript@5.9.2/node_modules/typescript/bin/tsc -p tsconfig.json`, 9 s. Exit 2 with 40
  errors, **all** from `fast-check` (a devDependency the repository's store does not hold) in `test/property/*` and
  `test/support/generate.ts`; everything was emitted. The core pins TypeScript 5.9.3; the repository's 5.9.2 was used.
- **Acceptance:** `node dist/tools/build-acceptance-packages.js` (`npm run acceptance`), 2 s. All five cases verified (A 19 rows,
  B 8, C 10 with 2 merged and 5 isolated, D-hubspot 16, D-salesforce 19 with 4 leftover). **All 145 files are byte-identical** to the
  tracked `acceptance/`; the only differences are four empty directories, which git does not track.
- **Golden corpus:** `node tools/run-tests.mjs --filter golden` (`npm run golden`), 6 s, **602/602 pass** (43 cases).
- **Determinism:** `node dist/tools/determinism-replay.js`, 34 s: 48 fixtures (43 golden, 5 acceptance) run twice in separate
  processes, 0 differ.
- **Whole core suite:** `node tools/run-tests.mjs`, 54 s: 1,743 of 1,747 pass. The 4 failures are environmental to the copy, not the
  engine: two property files (`fast-check` missing), `[MC-07] release-dossier self-tests`
  (`chain.resumeAfterCheckoutKeepsPrHead.current/.legacy`, which need the core's own git and PR history) and `[S092] evidence
  self-tests` (`batch.*` release-evidence batches). None touches package generation. A patch proof uses build, acceptance, golden,
  determinism and verify, which all pass in the copy.

**Does the golden corpus pin document hashes? No.** The golden expectations (`test/fixtures/golden/*/expected/case.json`) hold counts,
changes, flags, merges and relationships, never a hash. But four things do pin the documents, and a template patch must respect them:

1. **Exact sentences in `audit.md`** (`test/golden/golden.test.ts`, "quotes the reconciliation in the audit summary"): `All N source
   row(s) read from the input files have exactly one disposition. 0 rows disappeared.` and one table row `| DISPOSITION | n |` for
   OUTPUT, MERGED_PROVEN, ISOLATED, LEFTOVER and REJECTED_INPUT. `test/integration/package.test.ts` also matches the first sentence.
2. **The verifier re-renders `audit.md`** (`audit.derivedFromReconciliation`, `src/verify/verify-package.ts`) and compares bytes with
   `renderAudit`. A patch to that renderer changes both sides, so it passes, provided it stays a pure function of the reconciliation.
3. **The artifact list is closed:** the verifier's expected path set (`verify-package.ts`, the list ending in `audit.md`,
   `import-instructions.md`) and `test/unit/layout.test.ts` ("knows about exactly the artifacts the contract names") both fail on a new
   file. A new README or index needs entries in `src/artifacts/layout.ts`, the verifier and that test.
4. **Acceptance hashes:** `acceptance/*/hashes.txt` and each `manifest.json` hold the SHA-256 of `04_DOCUMENTATION/audit.md` and
   `import-instructions.md`, and the core's CI runs `git diff --exit-code -- acceptance spec`. A patch therefore regenerates those
   entries. This is the diff §1.1 allows (documentation entries of the manifest only), and the acceptance rebuild in the copy shows
   how to prove it.

### 2.4 Migration Core on new input (deliverables plan §1.3)

**Entry points.**
- CLI (`bin kauro-core` = `dist/src/cli/main.js`):
  - `run --input <dir> --config <file> --out <dir>` writes and verifies a package. CLEAN_ONLY needs nothing else.
  - HUBSPOT and SALESFORCE also need `--target-contract`, `--attestation`, `--attestation-issuer` and `--attestation-instant` files.
  - `verify --package <dir>` and `inspect --input <dir> --out <dir>` (a source profile and candidate set, useful for drafting a
    configuration for a new world).
- API: `loadConfig` → `runMigration({ inputRoot, config, configHash, scratch, ...attestationFor(mode) })` →
  `writeAndPromotePackage` → `verifyPackage`, exactly as `tools/build-acceptance-packages.ts` does. `attestationFor` (from
  `dist/tools/attestation-fixture.js`) gives the fixture contract and signed attestation for CRM modes, so no files are needed.

**Input format.** A folder of `CSV` or `XLSX` files (encodings UTF8, UTF16LE, UTF16BE, WINDOWS_1252, LATIN1) and a `config.json`:
`configVersion` "3.0.0", `source` (system, namespace), `target` (mode CLEAN_ONLY, HUBSPOT or SALESFORCE; importMode), `files[]`,
`records[]` (object, source id column, fields with destination field and semantic type) and `associations[]`.

**Tried in the copy.**

| Run | Command | Time | Result |
| --- | --- | --- | --- |
| A-clean-multi-object input, CLI | `node dist/src/cli/main.js run --input test/fixtures/acceptance/A-clean-multi-object/input --config .../config.json --out <scratch>/cli-out/A` | 1 s | 29 artifacts verified; **byte-identical** to the tracked package A. `verify --package` passed its 60 checks |
| D-hubspot and D-salesforce, API | `node run-crm.mjs <mc> <input> <config> <out>` (a 25-line script mirroring the acceptance builder) | 0.3 s each | Verified, 60 checks, 0 problems; **byte-identical** to the tracked packages |
| **A new synthetic input** (the D-hubspot files with a company renamed and a contact added) | same script, HUBSPOT mode | 0.3 s | New run `run_ccc5dc08c5b960bb29c6d6fe`: 17 source rows, 13 records, verified (60 checks) |
| **The report PDF of that new package** | a 30-line script: `readMigrationPackage` → `buildReportModel` → `generateReportPdf` from `@kauro/reports`, with the data-plane `ChromiumPdfEngine` on Edge | 1.8 s | 529,363 B, 4 Letter pages, tagged (MarkInfo `Marked: true`, `/Lang` en-US) |

**Verdict: the path of §1.3 works.** A canonical world written as CSV plus a 3.0.0 configuration runs through Migration Core into a
scratch folder, verifies, and renders as the report PDF with the platform's own renderer. The cross-surface reconciliation can cover
documents and screens together. The fallback of §1.3 (mapping names onto the acceptance cases) is not needed.

---

## 3. Risks found

1. **Building the web would disturb the review server.** `tools/review/serve.mjs` serves `apps/web/.next/standalone` and reads
   `apps/web/dist/e2e/support/public-api.js`. `pnpm -r build`, `pnpm --filter @kauro/web run build` and the public e2e suite rewrite
   them, so they must not run while another session uses port 4400. This record ran no build. Recompiling `apps/web/dist` with
   `tsc -p tsconfig.node.json` (an instruction of this check) rewrote files the server had already loaded at start-up; the server was
   not restarted and was still listening afterwards.
2. **The compiled `dist` trees are what the tests run.** `pnpm --filter @kauro/ui run test` and the root `test` script do not build
   first. Today every `dist` is newer than its source; a run that edits sources must rebuild the package before its tests mean
   anything.
3. **Firefox through BiDi is not Playwright's patched Firefox.** It cannot emulate reduced motion or forced colours and reports no
   layout shifts. Those checks are Chromium-only until the owner decides.
4. **No WebKit at all.** Safari-specific defects (for example `backdrop-filter`, form controls, font synthesis) cannot be seen on this
   machine.
5. **PDF/UA is read, not validated.** pdf.js shows a tagged, ordered, language-tagged PDF with embedded fonts. That is evidence, not
   a conformance verdict.
6. **Migration Core needs its dependencies copied into a scratch copy.** The repository's store has no `fast-check` and no TypeScript
   5.9.3, so the property suites cannot run there and the build uses 5.9.2. The acceptance bytes still match exactly, so the build is
   sound for a patch proof. A patch is proved by acceptance, golden, determinism and verify, not by the whole core suite.
7. **A template patch for a new README/index is wider than a template.** It touches the layout contract, the verifier's closed list and
   a unit test (§2.3, point 3) as well as the renderers. That is still inside the core's own files, but it should be written in the
   specification so the later release knows what it carries.
8. **Concurrent work in the repository.** During this check another session edited `docs/design/` and `tools/` and committed four
   times (`306f2963` to `67677078`, 22:34–22:52), adding `tools/test/canon.test.mjs`. The suites above ran against a tree that was
   changing. That is not a fault in the suites, but two sessions running tests and builds in one checkout at once is a risk to
   plan for. This check's only change to the repository is this record.
9. **The full workspace suite takes about 25 minutes and has a load-sensitive file.** api alone is 17 minutes; persistence and control
   about 6 each. `refund-generic-cells` failed once under the parallel run and passed alone. A Round 3 run that needs "the whole
   suite green" should run api with its own `--test-concurrency=3` and nothing else in parallel, and re-run a file-level failure alone
   before calling it real (and record both runs).
10. **A cut run leaves a temporary PostgreSQL behind.** The cap stopped `pnpm` while a test cluster was up
    (`%TEMP%\kauro-pg-YGZMBd`, started 22:51). This check stopped it with `pg_ctl -m fast stop` and removed its folder. Four older
    `%TEMP%\kauro-pg-*` folders from 06:55 to 07:09 this morning were left as found: they are not from this check. Never cap the
    suite with `timeout`; give the tool call a long timeout instead.

---

## 4. What the owner must decide

Only items that need a download or a sign-in. Until the owner answers, each check uses its fallback above. Nothing is installed during
the run.

| # | Item | Why | What it takes | If declined |
| --- | --- | --- | --- | --- |
| 1 | **Playwright WebKit** (`npx playwright install webkit`, revision 2359 for Playwright 1.63.0) | The only way to see the Safari engine on this machine | A download from Playwright's CDN into `%LOCALAPPDATA%\ms-playwright` | WebKit stays unverified and is listed as a gap in the delivery |
| 2 | **Playwright Firefox** (`npx playwright install firefox`, revision 1543) | Reduced motion, forced colours and CLS in Firefox | A download from Playwright's CDN | Firefox runs on the installed Firefox 157 through BiDi, with those three checks Chromium-only |
| 3 | **Java (a JRE 11+) and veraPDF** | A real PDF/UA-1 and WCAG verdict on every PDF | Two downloads (a JRE, for example Eclipse Temurin, and the veraPDF installer) | PDF/UA is read through pdf.js and stated as not validated |
| 4 | **Lighthouse** (npm package, run locally) | A Lighthouse score and its audits per page | An npm download, kept in a scratch folder outside the repository | Performance is measured with Playwright (LCP, CLS, transfer weights) against the budgets; no score |
| 5 | **Two Markdown renderers** (for example `markdown-it` and `marked`, npm) | Deliverables plan §6: Markdown rendered by two renderers | npm downloads, kept in a scratch folder outside the repository | A local structural check and a raw-text read; rendering parity not verified |
| 6 | (optional) **`fast-check` 4.9.0** in the Migration Core scratch copy | Lets the core's property suites run in a patch proof | An npm download into the scratch copy only | The patch is proved by acceptance, golden, determinism and verify |

No item needs a sign-in.
