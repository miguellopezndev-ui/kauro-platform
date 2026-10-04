import type { ComponentPropsWithRef, ReactElement } from "react";
import { CLASS, cx } from "../internal/class-names.js";
import { withoutStyling } from "../internal/unstyled.js";

/** The props a primitive never accepts: it is styled only by the generated stylesheet (D-SEC-1, no inline style). */
type Unstyled = "className" | "style" | "dangerouslySetInnerHTML";

export type ButtonVariant = "primary" | "secondary" | "danger";

const VARIANT_CLASS: Readonly<Record<ButtonVariant, string>> = Object.freeze({
  primary: CLASS.buttonPrimary,
  secondary: CLASS.buttonSecondary,
  danger: CLASS.buttonDanger,
});

export interface ButtonProps extends Omit<ComponentPropsWithRef<"button">, Unstyled | "type"> {
  readonly variant?: ButtonVariant | undefined;
  /** Defaults to "button": a button submits a form only when the caller says so, explicitly. */
  readonly type?: "button" | "submit" | undefined;
}

export function Button({ variant = "secondary", type = "button", ...rest }: ButtonProps): ReactElement {
  return <button {...withoutStyling(rest)} type={type} className={cx(CLASS.button, VARIANT_CLASS[variant])} />;
}

export interface LinkButtonProps extends Omit<ComponentPropsWithRef<"a">, Unstyled | "href"> {
  readonly href: string;
  readonly variant?: ButtonVariant | undefined;
}

// Schemes that run script or carry a document: a link a person can follow must never be one of them.
const EXECUTABLE_SCHEME = /^\s*(?:javascript|data|vbscript):/i;

/** True when an href may be followed: a path, a query, a fragment or a link to another site — never a script or a data URL. */
export function isSafeHref(href: string): boolean {
  return !EXECUTABLE_SCHEME.test(href.replace(/[\u0000-\u001f]/g, ""));
}

/** A link that looks like a button, for navigation (a button is for actions). */
export function LinkButton({ href, variant = "secondary", ...rest }: LinkButtonProps): ReactElement {
  if (!isSafeHref(href)) throw new RangeError("a link may not run script or carry data");
  return <a {...withoutStyling(rest)} href={href} className={cx(CLASS.button, VARIANT_CLASS[variant])} />;
}
