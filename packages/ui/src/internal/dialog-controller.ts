// The imperative half of ConfirmDialog and ErrorSummary, kept apart from React so it is testable with plain stubs (B11 W1:
// the tests render static markup without a DOM; the real browser behaviour is proven by the stage-2 specs).
//
// D-A11Y-1: focus goes to the dialog heading on open, to the error summary on a refusal, and back to the invoker on close.
// D-A11Y-2 / R2-062: no hidden default and no unrelated Enter key can approve anything.

export interface FocusTargetLike {
  focus(): void;
  /** False once the element was removed from the document (a removed invoker cannot take focus back). */
  readonly isConnected?: boolean;
}

export interface ModalLike {
  readonly open: boolean;
  showModal(): void;
  close(): void;
}

export interface DialogEnvironment {
  readonly dialog: ModalLike;
  readonly heading: FocusTargetLike;
  /** The control that opened the dialog, or null when it is not known. */
  readonly invoker: FocusTargetLike | null;
}

/**
 * Opens the dialog modally, puts focus on its heading, and returns the function that closes it and hands focus back to the
 * invoker. The heading, not a button, takes focus so that nothing actionable is focused when the dialog appears, and opening
 * the dialog twice (React strict mode runs effects twice) opens it once.
 */
export function enterDialog(environment: DialogEnvironment): () => void {
  const { dialog, heading, invoker } = environment;
  if (!dialog.open) dialog.showModal();
  heading.focus();
  let left = false;
  return () => {
    if (left) return;
    left = true;
    if (dialog.open) dialog.close();
    if (invoker !== null && invoker.isConnected !== false) invoker.focus();
  };
}

/**
 * The native `cancel` event (the Escape key) would close the dialog by itself, leaving the owner's state open. It is turned
 * into the owner's own Cancel, which is never an approval.
 */
export function cancelFromEscape(event: { preventDefault(): void }, onCancel: () => void): void {
  event.preventDefault();
  onCancel();
}

export interface EnterKeyEvent {
  readonly key: string;
  readonly target: { readonly tagName: string } | null;
}

/**
 * Enter does something inside the dialog only on a button (its own activation) or a link (following it). On a checkbox, on
 * the heading or on any text it does nothing, so a stray Enter can neither approve nor submit.
 */
export function suppressEnter(event: EnterKeyEvent): boolean {
  if (event.key !== "Enter") return false;
  const tag = event.target?.tagName.toUpperCase() ?? "";
  return tag !== "BUTTON" && tag !== "A";
}

/** Moves focus to the field an error names; false when the field is not on the page (the link then behaves as a plain link). */
export function focusFieldById(lookup: (id: string) => FocusTargetLike | null, id: string): boolean {
  const element = lookup(id);
  if (element === null) return false;
  element.focus();
  return true;
}
