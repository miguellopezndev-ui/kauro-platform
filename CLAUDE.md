# Instructions for Claude Code in this repository

These instructions cover the visual design of Kauro. They never replace a security contract, an accessibility contract, the copy
contract (A3) or a functional decision recorded in `docs/authority/`; when they seem to conflict, those win.

## Visual identity

The visual authority of every Kauro web surface is [docs/design/KAURO_VISUAL_IDENTITY.md](docs/design/KAURO_VISUAL_IDENTITY.md) (version
1.0, approved by the owner; decision record: `docs/authority/amendments/A10_VISUAL_IDENTITY.md`).

1. Every new screen follows the approved identity: its palette, typography, spacing, shape, components, motion and the register of its
   surface (public, customer application, internal operations).
2. Reuse the existing components: `packages/ui` (tokens, primitives, `SafeText`), `apps/web/src/public/parts.tsx` and `artifacts.tsx`,
   and the shell in `apps/web/src/shell/`. Change a token in `packages/ui/src/tokens.ts` and regenerate `tokens.css`; never edit the
   generated CSS alone.
3. Do not invent a palette, a typeface or a visual structure of your own for a page or a feature.
4. Any significant evolution of the identity (palette, typography, motion language, the structure of a surface) needs the owner's
   authorisation, and a new version of the identity document.
5. Extensions must be coherent with the existing pages: put them side by side with a comparable page before calling them done.
6. Add every new screen to [docs/design/KAURO_SCREEN_COVERAGE.md](docs/design/KAURO_SCREEN_COVERAGE.md) and
   [docs/design/DESIGN-LEDGER.md](docs/design/DESIGN-LEDGER.md) as "implemented, owner review pending" until the owner has reviewed it.
7. The visual appearance of Kauro is implemented and maintained by Claude. It is not redesigned by Codex.
8. Codex may carry out an independent technical review. That review gives it no authority to change the approved identity.

## Earlier decisions and functional change (D-34)

Earlier decisions and existing contracts are evidence and transition constraints, not automatic reasons to reject a better solution
(`docs/authority/decisions/2026-10-21-CONTINUOUS-IMPROVEMENT.md`). Propose a material improvement with its effects on policy,
contracts, backend, data, security, cost, experience and tests; the owner decides. During Orders 11 and 12 work is design only: record
each functional change it needs in `docs/design/ORDER11-FUNCTIONAL-GAPS.md`, to be grouped by component in
`docs/design/FUNCTIONAL-CHANGE-INVENTORY.md` before the functional orders.

## Before a visual change is done

- `pnpm --filter @kauro/ui run test` (tokens and contrast in every palette) and `@kauro/web` tests.
- Check both themes and 320/375/768/1280 px: no horizontal scroll, no cut text, visible focus, axe clean, reduced motion respected.
- No inline style, no remote resource, no new runtime dependency without a demonstrated need; the CSP stays as it is.
- Copy comes from the catalogues (`apps/web/src/copy/`), never written into JSX.
