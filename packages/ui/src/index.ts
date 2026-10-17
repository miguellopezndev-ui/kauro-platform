// Tokens: the values, their checks and the stylesheet (@kauro/ui/tokens.css is renderTokenCss written to disk).
export {
  BORDER_WIDTH_PX,
  BRAND,
  COLOR,
  COLOR_DARK,
  COLOR_INVERSE,
  COLOR_INVERSE_DARK,
  COLOR_WINE,
  FOCUS,
  NON_TEXT_PAIRS,
  RADIUS_LARGE_PX,
  RADIUS_PX,
  SPACING_PX,
  TARGET_SIZE_PX,
  TEXT_PAIRS,
  THEMES,
  TYPOGRAPHY,
  contrastRatio,
  relativeLuminance,
  renderTokenCss,
} from "./tokens.js";
export type { ColorToken, ThemeName } from "./tokens.js";
export { renderComponentCss } from "./styles.js";

// Formatting of the figures the primitives show: counts, money by minor units, deadlines in a named zone.
export { MINOR_UNIT_EXPONENT, countToBigInt, formatCount, formatDeadline, formatMoney, groupThousands } from "./format.js";
export type { CountValue, FormattedDeadline } from "./format.js";

// Primitives (B11 D-DS-1). Every one takes its words from the caller's copy; none holds an English string.
export { SafeText, DEFAULT_MAX_CHARS, isFormulaLike, truncateGraphemes } from "./components/safe-text.js";
export type { SafeTextCopy, SafeTextProps } from "./components/safe-text.js";
export { Count, Deadline, Money } from "./components/figures.js";
export type { DeadlineProps, MoneyProps } from "./components/figures.js";
export { Button, LinkButton, isSafeHref } from "./components/button.js";
export type { ButtonProps, ButtonVariant, LinkButtonProps } from "./components/button.js";
export { Field, FieldError, Hint, Label } from "./components/field.js";
export type { ControlProps, FieldProps } from "./components/field.js";
export { ErrorSummary } from "./components/error-summary.js";
export type { ErrorSummaryItem, ErrorSummaryProps } from "./components/error-summary.js";
export { ConfirmDialog, ConfirmDialogView, canApprove } from "./components/confirm-dialog.js";
export type {
  ConfirmDialogCopy,
  ConfirmDialogError,
  ConfirmDialogProps,
  ConfirmDialogViewProps,
  ConfirmEffect,
} from "./components/confirm-dialog.js";
export { CountDenominators } from "./components/count-denominators.js";
export type {
  CountDenominatorsCopy,
  CountDenominatorsProps,
  MeasureCopy,
  OutputFileCount,
} from "./components/count-denominators.js";
export { DataTable } from "./components/data-table.js";
export type {
  DataTableColumn,
  DataTableCopy,
  DataTablePagination,
  DataTableProps,
  SortDirection,
} from "./components/data-table.js";
export { Banner, StatusBadge } from "./components/status.js";
export type { BannerProps, StatusBadgeProps, Tone } from "./components/status.js";
export { PhaseList } from "./components/phase-list.js";
export type { Phase, PhaseListProps, PhaseState } from "./components/phase-list.js";
export { NavigationGuard } from "./components/navigation-guard.js";
export type { LeaveAttempt, NavigationGuardProps } from "./components/navigation-guard.js";
