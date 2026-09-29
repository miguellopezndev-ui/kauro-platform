// The stylesheet of the primitives (B11 D-DS-1, D-SEC-1). Components emit class names (internal/class-names.ts) and nothing
// else: no style attribute, no inline colour. This module writes the rule for each class, using only the custom properties of
// tokens.ts, and renderTokenCss folds it into tokens.css. styles.test.ts checks that every class has a rule, that no rule uses a
// literal colour or pixel size, and that every custom property a rule reads is defined.

import { CLASS } from "./internal/class-names.js";

const sel = (name: string): string => `.${name}`;

const rule = (selector: string, declarations: readonly string[]): string =>
  `${selector} {\n${declarations.map((declaration) => `  ${declaration};`).join("\n")}\n}`;

const color = (token: string): string => `var(--kauro-color-${token})`;
const space = (step: number): string => `var(--kauro-space-${step})`;
const FOCUS_BORDER = `var(--kauro-border-width) solid`;

const TONES: ReadonlyArray<readonly [string, string, string]> = [
  [CLASS.toneNeutral, "text", "surface"],
  [CLASS.toneInfo, "info-text", "info-surface"],
  [CLASS.toneSuccess, "success-text", "success-surface"],
  [CLASS.toneWarning, "warning-text", "warning-surface"],
  [CLASS.toneDanger, "danger-text", "danger-surface"],
];

/** The rules of the primitives, as CSS text. */
export function renderComponentCss(): string {
  const rules: string[] = [];
  const add = (selector: string, declarations: readonly string[]): void => {
    rules.push(rule(selector, declarations));
  };

  add(sel(CLASS.icon), ["inline-size: 1em", "block-size: 1em", "flex: none"]);
  add(sel(CLASS.heading), ["margin: 0 0 var(--kauro-space-3)", "line-height: var(--kauro-line-height-heading)", "font-weight: 700"]);
  add(`h2${sel(CLASS.heading)}`, ["font-size: 1.5rem"]);
  add(`h3${sel(CLASS.heading)}`, ["font-size: 1.25rem"]);
  add(`h4${sel(CLASS.heading)}`, ["font-size: 1.125rem"]);

  // SafeText: the value is isolated so a bidirectional control inside it cannot reorder the text around it.
  add(`${sel(CLASS.safeText)} bdi`, ["unicode-bidi: isolate", "overflow-wrap: anywhere"]);
  add(sel(CLASS.safeTextMarker), [
    "display: inline-block",
    "margin-inline-end: var(--kauro-space-1)",
    "padding: 0 var(--kauro-space-1)",
    "border: var(--kauro-border-width) solid currentColor",
    "border-radius: var(--kauro-radius)",
    `color: ${color("warning-text")}`,
    `background: ${color("warning-surface")}`,
    "font-size: var(--kauro-font-size-dense)",
    "font-weight: 600",
  ]);
  add(sel(CLASS.safeTextFull), ["display: block", "overflow-wrap: anywhere"]);
  add(`${sel(CLASS.safeTextFull)}[hidden]`, ["display: none"]);
  add(sel(CLASS.disclosure), [
    "padding: 0",
    "border: 0",
    "background: none",
    `color: ${color("primary")}`,
    "font: inherit",
    "text-decoration: underline",
    "cursor: pointer",
  ]);

  add(`${sel(CLASS.count)}, ${sel(CLASS.money)}, ${sel(CLASS.deadline)}`, ["font-variant-numeric: tabular-nums"]);
  add(`${sel(CLASS.count)}, ${sel(CLASS.money)}`, ["white-space: nowrap"]);

  // Buttons and link buttons. The target is never smaller than the target token (WCAG 2.2 SC 2.5.8).
  add(sel(CLASS.button), [
    "display: inline-flex",
    "align-items: center",
    "justify-content: center",
    "gap: var(--kauro-space-2)",
    "box-sizing: border-box",
    "min-block-size: var(--kauro-target-size)",
    "min-inline-size: var(--kauro-target-size)",
    "padding: var(--kauro-space-2) var(--kauro-space-4)",
    `border: ${FOCUS_BORDER} ${color("primary")}`,
    "border-radius: var(--kauro-radius)",
    "font: inherit",
    "font-weight: 600",
    "line-height: var(--kauro-line-height-body)",
    "text-decoration: none",
    "cursor: pointer",
  ]);
  add(sel(CLASS.buttonPrimary), [`background: ${color("primary")}`, `color: ${color("on-primary")}`]);
  add(`${sel(CLASS.buttonPrimary)}:hover:not(:disabled)`, [`background: ${color("primary-hover")}`, `border-color: ${color("primary-hover")}`]);
  add(sel(CLASS.buttonSecondary), [`background: ${color("background")}`, `color: ${color("primary")}`]);
  add(`${sel(CLASS.buttonSecondary)}:hover:not(:disabled)`, [`background: ${color("surface")}`]);
  add(sel(CLASS.buttonDanger), [`background: ${color("background")}`, `color: ${color("danger-text")}`, `border-color: ${color("danger-text")}`]);
  add(`${sel(CLASS.buttonDanger)}:hover:not(:disabled)`, [`background: ${color("danger-surface")}`]);
  add(`${sel(CLASS.button)}:disabled`, [
    `background: ${color("surface")}`,
    `color: ${color("text-muted")}`,
    `border-color: ${color("control-border")}`,
    "cursor: not-allowed",
  ]);

  // Fields.
  add(sel(CLASS.field), ["display: flex", "flex-direction: column", "gap: var(--kauro-space-1)", "margin-block-end: var(--kauro-space-4)"]);
  add(sel(CLASS.label), ["font-weight: 600"]);
  add(sel(CLASS.hint), ["margin: 0", `color: ${color("text-muted")}`]);
  add(sel(CLASS.fieldError), [
    "display: flex",
    "align-items: flex-start",
    "gap: var(--kauro-space-2)",
    "margin: 0",
    `color: ${color("danger-text")}`,
    "font-weight: 600",
  ]);
  add(`${sel(CLASS.field)} :is(input, select, textarea)`, [
    "box-sizing: border-box",
    "min-block-size: var(--kauro-target-size)",
    "max-inline-size: 100%",
    "padding: var(--kauro-space-2) var(--kauro-space-3)",
    `border: ${FOCUS_BORDER} ${color("control-border")}`,
    "border-radius: var(--kauro-radius)",
    `background: ${color("background")}`,
    `color: ${color("text")}`,
    "font: inherit",
  ]);
  add(`${sel(CLASS.field)} :is(input, select, textarea)[aria-invalid="true"]`, [`border-color: ${color("danger-text")}`]);

  add(sel(CLASS.errorSummary), [
    "margin-block-end: var(--kauro-space-4)",
    "padding: var(--kauro-space-4)",
    `border: ${FOCUS_BORDER} ${color("danger-text")}`,
    "border-radius: var(--kauro-radius)",
    `background: ${color("danger-surface")}`,
    `color: ${color("text")}`,
  ]);
  add(`${sel(CLASS.errorSummary)} .${CLASS.heading}`, [`color: ${color("danger-text")}`]);
  add(sel(CLASS.errorSummaryList), ["margin: 0", "padding-inline-start: var(--kauro-space-5)"]);
  add(`${sel(CLASS.errorSummaryList)} a`, [`color: ${color("danger-text")}`, "font-weight: 600"]);

  // The confirmation dialog.
  add(sel(CLASS.dialog), [
    "box-sizing: border-box",
    "inline-size: min(40rem, calc(100% - 2 * var(--kauro-space-4)))",
    "max-block-size: calc(100dvh - 2 * var(--kauro-space-4))",
    "overflow: auto",
    "padding: var(--kauro-space-5)",
    `border: ${FOCUS_BORDER} ${color("control-border")}`,
    "border-radius: var(--kauro-radius)",
    `background: ${color("background")}`,
    `color: ${color("text")}`,
  ]);
  add(`${sel(CLASS.dialog)}::backdrop`, [`background: color-mix(in srgb, ${color("text")} 60%, transparent)`]);
  add(sel(CLASS.dialogSummary), ["margin-block-end: var(--kauro-space-4)"]);
  add(sel(CLASS.effectList), ["display: grid", "gap: var(--kauro-space-4)", "margin: 0", "padding: 0", "list-style: none"]);
  add(sel(CLASS.effect), [`border: ${FOCUS_BORDER} ${color("border")}`, "border-radius: var(--kauro-radius)", "padding: var(--kauro-space-4)"]);
  add(`${sel(CLASS.effectDescription)} p`, ["margin: 0 0 var(--kauro-space-2)"]);
  add(sel(CLASS.effectAcknowledge), ["display: flex", "align-items: flex-start", "gap: var(--kauro-space-3)"]);
  add(`${sel(CLASS.effectAcknowledge)} input`, ["flex: none", "inline-size: 1.5rem", "block-size: 1.5rem", "margin: 0"]);
  add(sel(CLASS.dialogActions), ["display: flex", "flex-wrap: wrap", "justify-content: flex-end", "gap: var(--kauro-space-3)", "margin-block-start: var(--kauro-space-5)"]);

  // Tables.
  add(sel(CLASS.tableRegion), ["max-inline-size: 100%", "overflow-x: auto"]);
  add(sel(CLASS.table), ["inline-size: 100%", "border-collapse: collapse"]);
  add(sel(CLASS.tableCaption), ["padding-block-end: var(--kauro-space-2)", "text-align: start", "font-weight: 700"]);
  add(`${sel(CLASS.table)} :is(th, td)`, [
    "padding: var(--kauro-space-2) var(--kauro-space-3)",
    "text-align: start",
    "vertical-align: top",
    `border-block-end: ${FOCUS_BORDER} ${color("border")}`,
  ]);
  add(`${sel(CLASS.table)} thead th`, [`background: ${color("surface")}`]);
  add(`${sel(CLASS.table)} :is(th, td)${sel(CLASS.tableEnd)}`, ["text-align: end", "font-variant-numeric: tabular-nums"]);
  add(sel(CLASS.tableEmpty), [`color: ${color("text-muted")}`]);
  add(sel(CLASS.sortButton), [
    "display: inline-flex",
    "align-items: center",
    "gap: var(--kauro-space-1)",
    "min-block-size: var(--kauro-target-size)",
    "padding: 0",
    "border: 0",
    "background: none",
    "color: inherit",
    "font: inherit",
    "font-weight: 700",
    "cursor: pointer",
  ]);
  add(sel(CLASS.pagination), ["display: flex", "flex-wrap: wrap", "align-items: center", "gap: var(--kauro-space-3)", "margin-block-start: var(--kauro-space-3)"]);
  add(`${sel(CLASS.pagination)} p`, ["margin: 0", "margin-inline-end: auto"]);

  // Status.
  for (const [name, text, surface] of TONES) add(sel(name), [`color: ${color(text)}`, `background: ${color(surface)}`]);
  add(sel(CLASS.statusBadge), [
    "display: inline-flex",
    "align-items: center",
    "gap: var(--kauro-space-1)",
    "padding: var(--kauro-space-1) var(--kauro-space-2)",
    "border: var(--kauro-border-width) solid currentColor",
    "border-radius: var(--kauro-radius)",
    "font-size: var(--kauro-font-size-dense)",
    "font-weight: 600",
  ]);
  add(sel(CLASS.banner), [
    "display: flex",
    "align-items: flex-start",
    "gap: var(--kauro-space-3)",
    "padding: var(--kauro-space-3) var(--kauro-space-4)",
    "border: var(--kauro-border-width) solid currentColor",
    "border-radius: var(--kauro-radius)",
  ]);
  add(sel(CLASS.bannerBody), ["flex: 1", "min-inline-size: 0", `color: ${color("text")}`]);
  add(sel(CLASS.bannerTitle), ["margin: 0 0 var(--kauro-space-1)", "font-weight: 700"]);
  add(sel(CLASS.phaseList), ["display: grid", "gap: var(--kauro-space-3)", "margin: 0", "padding: 0", "list-style: none"]);
  add(sel(CLASS.phase), ["display: flex", "flex-wrap: wrap", "align-items: center", "gap: var(--kauro-space-2)"]);
  add(sel(CLASS.phaseState), [
    "padding: 0 var(--kauro-space-2)",
    "border: var(--kauro-border-width) solid currentColor",
    "border-radius: var(--kauro-radius)",
    "font-size: var(--kauro-font-size-dense)",
  ]);
  add(sel(CLASS.phaseDone), [`color: ${color("success-text")}`]);
  add(sel(CLASS.phaseCurrent), [`color: ${color("info-text")}`, "font-weight: 700"]);
  add(sel(CLASS.phaseUpcoming), [`color: ${color("text-muted")}`]);
  add(sel(CLASS.phaseFailed), [`color: ${color("danger-text")}`]);

  // The count panel.
  add(sel(CLASS.countPanel), [`border: ${FOCUS_BORDER} ${color("border")}`, "border-radius: var(--kauro-radius)", "padding: var(--kauro-space-4)"]);
  add(sel(CLASS.measures), ["display: grid", "grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr))", "gap: var(--kauro-space-4)", "margin: 0"]);
  add(`${sel(CLASS.measure)} dt`, ["font-weight: 700"]);
  add(`${sel(CLASS.measure)} dd`, ["margin: 0"]);
  add(sel(CLASS.measureValue), ["font-size: 1.5rem", "font-variant-numeric: tabular-nums"]);
  add(sel(CLASS.measureDefinition), [`color: ${color("text-muted")}`, "font-size: var(--kauro-font-size-dense)"]);
  add(sel(CLASS.outputFiles), ["margin: 0", "padding: 0", "list-style: none", "font-size: var(--kauro-font-size-body)"]);
  add(`${sel(CLASS.outputFiles)} li`, ["display: flex", "justify-content: space-between", "gap: var(--kauro-space-3)"]);

  rules.push(
    [
      "@media (forced-colors: active) {",
      `  ${sel(CLASS.button)}, ${sel(CLASS.statusBadge)}, ${sel(CLASS.banner)}, ${sel(CLASS.errorSummary)}, ${sel(CLASS.effect)} { border-color: CanvasText; }`,
      `  ${sel(CLASS.button)}:disabled { border-color: GrayText; color: GrayText; }`,
      "}",
    ].join("\n"),
  );
  return rules.join("\n");
}
