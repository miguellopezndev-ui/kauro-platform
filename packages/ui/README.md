# @kauro/ui

The design system of the web surfaces (B11 D-DS-1): the colour, type, spacing and focus tokens of the interface contract, the
stylesheet rendered from them, and the accessible React 19 primitives built on both. Private to this repository; the
application (`apps/web`) is the only consumer.

## What is here

| Part | Where |
|---|---|
| Tokens and the WCAG 2.2 AA contrast checks that bind them | `src/tokens.ts` |
| The component stylesheet (every rule reads a token) | `src/styles.ts`, written into `tokens.css` by `renderTokenCss()` |
| Number, money and deadline formatting | `src/format.ts` |
| Primitives | `src/components/*.tsx`, all exported from `src/index.ts` |
| Class names the primitives emit | `src/internal/class-names.ts` |

Primitives: `SafeText`, `ConfirmDialog` (and its server-renderable `ConfirmDialogView`), `CountDenominators`, `Money`, `Count`,
`Deadline`, `PhaseList`, `DataTable`, `Field` with `Label`, `Hint` and `FieldError`, `ErrorSummary`, `StatusBadge`, `Banner`,
`NavigationGuard`, `Button` and `LinkButton`.

## Rules every primitive keeps

- **No words.** The package holds no English (or any) string that a person reads. Every label, definition, marker and button
  name comes from the caller's copy catalogue, passed as a `copy` prop or as `children`. A primitive that needs a word it was not
  given does not compile.
- **Styled by class only.** The stylesheet is `tokens.css`; a primitive sets `className` from the fixed list in
  `class-names.ts` and nothing else. There is no `style` attribute and no `dangerouslySetInnerHTML` anywhere in `packages/ui` or
  `apps/web`, because the page's CSP is `style-src-attr 'none'` and untrusted text must stay text. `test/source-rules.test.ts`
  reads both source trees and fails on either. A primitive also drops `className`, `style` and `dangerouslySetInnerHTML` if a
  caller smuggles them in with a cast.
- **Untrusted text goes through `SafeText`.** A name, a label or a value that a customer or an agency wrote is shown as one text
  node inside `<bdi>`: markup is escaped, a bidirectional control cannot reorder the text around it, a value that starts like a
  spreadsheet formula carries a visible marker, and a long value is cut on a grapheme boundary with its full text one button
  away. Inside a link or a button, which cannot also hold that button, pass `maxChars={null}`.
- **Nothing has a default action.** A `Button` is `type="button"` unless the caller asks for `submit`. The confirmation dialog has
  no `<form>`, opens with focus on its heading and keeps its approve button disabled until every disclosed effect is
  acknowledged.
- **Colour is never the only signal.** Every tone and state has an icon and words; focus is drawn once, by the base rule, and no
  rule hides it; a pointer target is at least `--kauro-target-size`.
- **Exact figures.** `Money` takes a minor-unit string and formats by `BigInt` (`"129500"` becomes `USD 1,295.00`); `Count` takes
  a whole number, a `BigInt` or a canonical decimal string; `Deadline` takes an RFC 3339 instant and a named zone, and writes
  the zone's own name. Each refuses what it cannot show exactly rather than guessing.

## Client and server components

`ConfirmDialog`, `ErrorSummary`, `NavigationGuard` and `SafeTextDisclosure` (used by `SafeText` for a cut value) start with
`"use client"`: they need focus, a native dialog or an event listener. Everything else renders on the server.
`ConfirmDialogView` is the same dialog with its state passed in, for a caller that owns the state and for the markup tests.
`DataTable` takes an `onSort` callback only when a column is sortable; a function cannot cross from a server component, so a
sortable table belongs in a client component.

## Regenerating `tokens.css`

`tokens.css` is a generated file: `test/tokens.test.ts` compares it byte for byte with `renderTokenCss()`. After a change to
`src/tokens.ts` or `src/styles.ts`:

```
pnpm --filter @kauro/ui run build
pnpm --filter @kauro/ui run generate
```

## Tests

`pnpm --filter @kauro/ui run test` renders each primitive with `react-dom/server` and reads the markup: elements, ARIA names and
associations, and every class against the stylesheet. There is no DOM library. What only a browser can show (focus movement, the
native dialog, the guard's prompt) is proven by the specs in `apps/web/e2e`.
