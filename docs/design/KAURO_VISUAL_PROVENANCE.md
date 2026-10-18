# Provenance of the Kauro visual identity

## Credit

| Role | Who |
| --- | --- |
| Creative direction, design decisions, selection and approval | The owner of Kauro Data S.A.S. |
| Elaboration and implementation of the visual design (code, styles, generated textures, documentation) | Claude, Anthropic's assistant, working for the owner in Claude Code |

The owner made the creative calls over five review rounds on 2026-10-17 and 2026-10-18, recorded in A10 §5–§9. Among them:

- the palette and its use, with wine as the middle colour;
- the editorial, minimal register and the rejection of generic SaaS looks;
- the approved references (the Home hero, the not-found card, the closing ticket, the wine context band);
- the rejections that shaped the rules (oversized type, empty panels, sticky elements, a full-screen menu, isolated gimmicks);
- the alternating tilts, and motion only where it sells.

Claude proposed and built each round and implemented the identity across the code. Claude did not make the approval decisions, and
the owner did not write the code.

## Identity version

- **Version 1.0**, integrated 2026-10-18.
- Authority: [KAURO_VISUAL_IDENTITY.md](KAURO_VISUAL_IDENTITY.md), with the decision record in
  `docs/authority/amendments/A10_VISUAL_IDENTITY.md` §1–§9.
- Coverage: [KAURO_SCREEN_COVERAGE.md](KAURO_SCREEN_COVERAGE.md).
- Owner-review status by surface: [DESIGN-LEDGER.md](DESIGN-LEDGER.md).

## Origin of the files

- **Source.** Built in the local worktree `C:/Users/migue/Kauro-design` on the branch `design/kauro-visual-refresh` (final delivery
  `7897a954`), from the base `main` `65e48d96`. The earlier prototypes on `review/visual-v1-prototypes` (made by Codex) are **not** part
  of this identity, and none of their files were used.
- **Recoverable copy, made before integration.** `C:/Users/migue/Kauro-visual-delivery/`:
  - `kauro-visual-delivery.bundle`, a git bundle of the delivery branch and its backup branch;
  - `MANIFEST.md`, with the commits and every delivered file's status against the base and its SHA-256;
  - `evidence/app-screens/`, screenshots of the app and ops screens in both themes at 1280 and 375 px.
- **Integration.** The branch `design/visual-identity-integration` was cut from `main` `ac6340965c098f3d0a1ed24d45ff4cbd49593b1e` and
  received the delivery in one merge. It does not touch the work of Order 8 (PR #109, which changes only
  `apps/api/test/inbound-lane-support.ts`).

## Commits

The **Git author** recorded on these commits is the owner's GitHub account (`miguellopezndev-ui`), because Claude committed in the owner's
local environment with its git identity. The code in them was written by Claude. Each non-merge commit carries the trailer
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The Git history is left exactly as recorded.

| Commit | Date | Git author | Co-author trailer | Content |
| --- | --- | --- | --- | --- |
| `d61704a4` | 2026-10-17 | miguellopezndev-ui | Claude Opus 5.5 | A10 §1–§4: palette, light and dark themes, tokens, shell, theme preference |
| `2bc56c3b` | 2026-10-17 | miguellopezndev-ui | Claude Opus 5.5 | A10 §5: generated textures, hero product window, margin notes, stamp |
| `09e94a9e` | 2026-10-17 | miguellopezndev-ui | Claude Opus 5.5 | A10 §6: menu, product fragments, rock only under objects, not-found page |
| `785a4718` | 2026-10-17 | miguellopezndev-ui | Claude Opus 5.5 | A10 §7: interactive pieces, sections built from their content |
| `372f448e` | 2026-10-17 | miguellopezndev-ui | Claude Opus 5.5 | A10 §8: one file through the process, objects instead of boxes |
| `5e781eea` | 2026-10-18 | miguellopezndev-ui | Claude Opus 5.5 | spacing and claims fixes, alternating tilts |
| `a82ee1da` | 2026-10-18 | miguellopezndev-ui | Claude Opus 5.5 | A10 §9: motion and tilt |
| `7897a954` | 2026-10-18 | miguellopezndev-ui | Claude Opus 5.5 | final pass: dead CSS removed, shared paper palette |
| `f9d42b14` | 2026-10-18 | miguellopezndev-ui | (merge commit) | integration of the delivery onto `main` `ac63409` |
| `01d6c820` | 2026-10-18 | miguellopezndev-ui | Claude Opus 5.5 | app and ops screens: wrapping, fact lists, action lists, heading order |

The pull request, the commit that is finally merged and the CI results are recorded in the pull request itself and in the integration
report.

## Screens incorporated

All 24 implemented screens of the registry follow the identity (see the coverage document for the matrix of all 55):

- **Owner-supervised:** UI01–UI08, UI48, UI49 and the not-published state of UI45–UI47 (the public site and legal shells), plus the
  not-found page.
- **Implemented by Claude, owner review pending:** UI14, UI15, UI16, UI18, UI23, UI24, UI25, UI30, UI32 and UI52 (signed-in app), and
  UI39 (internal operations). They are not reachable without a sign-in, which does not exist yet for the owner or for sellers.

## Original resources and third-party licences

- **Textures:** `clay-rock`, `ember-rock`, `wine-rock`, `carbon-rock` and `grain` in `apps/web/src/app/(public)/textures/` are SVG
  generated for Kauro (feTurbulence, displacement and lighting filters). They are original, with no third-party content.
- **Fonts:** none are shipped or requested; the identity uses the platform's system faces.
- **Icons:** the line glyphs of `packages/ui` and CSS-drawn marks; there are no icon fonts or packs.
- **Images and photographs:** none.
- **New runtime dependencies:** none. The checks used tools already in the repository (axe-core 4.13.0, Playwright 1.63.0). Playwright's
  Chromium was installed locally to run them.

## Reports (B13 PDF)

The approved delivery contains no design for the B13 report PDFs. Their harmonisation with the identity is pending future work. It will
be versioned without altering issued reports, their hashes or evidence, the issuer's legal identity, or an agency's own branding.
