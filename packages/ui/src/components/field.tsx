import type { ReactElement, ReactNode } from "react";
import { CLASS } from "../internal/class-names.js";
import { Icon } from "../internal/icon.js";

/** Label (D-DS-1): the accessible name of a control, associated by `for`. */
export function Label({ htmlFor, children }: { readonly htmlFor: string; readonly children: ReactNode }): ReactElement {
  return (
    <label className={CLASS.label} htmlFor={htmlFor}>
      {children}
    </label>
  );
}

/** Hint (D-DS-1): help text a control refers to with aria-describedby. */
export function Hint({ id, children }: { readonly id: string; readonly children: ReactNode }): ReactElement {
  return (
    <p id={id} className={CLASS.hint}>
      {children}
    </p>
  );
}

/**
 * FieldError (D-DS-1, D-A11Y-1): the message of one error, with its own id so the control it belongs to can refer to it with
 * aria-describedby. The icon repeats the meaning without colour and is hidden from assistive technology.
 */
export function FieldError({ id, children }: { readonly id: string; readonly children: ReactNode }): ReactElement {
  return (
    <p id={id} className={CLASS.fieldError}>
      <Icon name="danger" />
      <span>{children}</span>
    </p>
  );
}

/** The attributes Field hands to the control it wraps, to be spread onto it. */
export interface ControlProps {
  readonly id: string;
  readonly "aria-describedby"?: string;
  readonly "aria-invalid"?: true;
}

export interface FieldProps {
  /** The control's id; the hint and the error get `<id>-hint` and `<id>-error`. */
  readonly id: string;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  /** Renders the control with the attributes that tie it to its label, hint and error. */
  readonly children: (control: ControlProps) => ReactNode;
}

const ID = /^[A-Za-z][A-Za-z0-9_.:-]*$/;

/**
 * Field (D-DS-1): label, optional hint, optional error and the control they describe. The control is given its id and, when
 * there is a hint or an error, aria-describedby naming them, and aria-invalid when there is an error, so a screen reader reads
 * the label, then the hint, then the error at the control (D-A11Y-1: errors linked by aria-describedby).
 */
export function Field({ id, label, hint, error, children }: FieldProps): ReactElement {
  if (!ID.test(id)) throw new RangeError(`not a usable element id: ${JSON.stringify(id)}`);
  const hasHint = hint !== undefined && hint !== null && hint !== false;
  const hasError = error !== undefined && error !== null && error !== false;
  const describedBy = [hasHint ? `${id}-hint` : null, hasError ? `${id}-error` : null].filter((token): token is string => token !== null).join(" ");
  const control: ControlProps = {
    id,
    ...(describedBy === "" ? {} : { "aria-describedby": describedBy }),
    ...(hasError ? { "aria-invalid": true as const } : {}),
  };
  return (
    <div className={CLASS.field}>
      <Label htmlFor={id}>{label}</Label>
      {hasHint ? <Hint id={`${id}-hint`}>{hint}</Hint> : null}
      {hasError ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
      {children(control)}
    </div>
  );
}
