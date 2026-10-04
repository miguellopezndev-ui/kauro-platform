"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ReactElement, ReactNode, RefObject } from "react";
import { countToBigInt } from "../format.js";
import type { CountValue } from "../format.js";
import { CLASS } from "../internal/class-names.js";
import { cancelFromEscape, enterDialog, suppressEnter } from "../internal/dialog-controller.js";
import { Heading } from "../internal/heading.js";
import { Button } from "./button.js";
import { ErrorSummary } from "./error-summary.js";
import type { ErrorSummaryItem } from "./error-summary.js";
import { FieldError } from "./field.js";
import { Count } from "./figures.js";

/**
 * ConfirmDialog (B11 D-A11Y-2, R2-062): the confirmation of an action with a high-impact effect — a CLEAR, a merge, an
 * exclusion. It is a native <dialog> opened with showModal(), with no <form> around it, every button type="button" and no
 * default action. Every effect the action will have is disclosed with its count and must be acknowledged by its own checkbox
 * before Approve is enabled. Enter on a checkbox or on text does nothing, Escape is Cancel, and Cancel is a different control
 * from approval. Focus goes to the dialog heading on open, to the error summary on a refusal, and back to the invoker on close.
 * The server's errors name the effect they concern and are tied to that effect's checkbox with aria-describedby.
 *
 * The words come from the caller's copy catalogue: this package holds none.
 */

export interface ConfirmEffect {
  /** Stable id of the effect; the server's errors name it. Letters, digits and _ . : - only, at most 64. */
  readonly id: string;
  /** What will happen, in a sentence. */
  readonly description: ReactNode;
  /** How many rows, companies or contacts it touches. */
  readonly count: CountValue;
  /** What the count counts, for example "rows change". */
  readonly countLabel: string;
  /** The checkbox's label, for example "I understand that 1,200 rows are cleared". */
  readonly acknowledgeLabel: string;
}

export interface ConfirmDialogError {
  /** The effect the error concerns; an id that matches no shown effect is listed in the summary and tied to no control. */
  readonly effectId: string;
  readonly message: string;
}

export interface ConfirmDialogCopy {
  readonly approve: string;
  readonly cancel: string;
  /** The heading of the error summary. */
  readonly errorSummaryTitle: string;
}

export interface ConfirmDialogViewProps {
  /** The dialog's heading: it names the action. */
  readonly title: string;
  /** The exact effect of approving, in words. */
  readonly summary: ReactNode;
  readonly effects: readonly ConfirmEffect[];
  readonly errors?: readonly ConfirmDialogError[] | undefined;
  readonly copy: ConfirmDialogCopy;
  /** The effect ids acknowledged so far. */
  readonly acknowledged: ReadonlySet<string>;
  readonly onToggle: (effectId: string, acknowledged: boolean) => void;
  readonly onApprove: () => void;
  readonly onCancel: () => void;
  /** True while an approval is in flight: neither button can be pressed again. */
  readonly pending?: boolean | undefined;
  readonly dialogRef?: RefObject<HTMLDialogElement | null> | undefined;
  readonly headingRef?: RefObject<HTMLHeadingElement | null> | undefined;
}

export interface ConfirmDialogProps extends Omit<ConfirmDialogViewProps, "acknowledged" | "onToggle" | "dialogRef" | "headingRef"> {
  /** The dialog is in the document only while this is true; closing and reopening starts with nothing acknowledged. */
  readonly open: boolean;
  /** The control that opened the dialog, to hand focus back to; the focused element at open time when omitted. */
  readonly invoker?: RefObject<HTMLElement | null> | undefined;
}

const EFFECT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Approve is possible only when there is at least one disclosed effect and every one of them is acknowledged. */
export function canApprove(effects: readonly Pick<ConfirmEffect, "id">[], acknowledged: ReadonlySet<string>): boolean {
  return effects.length > 0 && effects.every((effect) => acknowledged.has(effect.id));
}

function assertEffects(effects: readonly ConfirmEffect[]): void {
  if (effects.length === 0) throw new RangeError("a confirmation must disclose at least one effect");
  const seen = new Set<string>();
  for (const effect of effects) {
    if (!EFFECT_ID.test(effect.id)) throw new RangeError(`not a usable effect id: ${JSON.stringify(effect.id)}`);
    if (seen.has(effect.id)) throw new RangeError(`effect id repeated: ${effect.id}`);
    seen.add(effect.id);
    countToBigInt(effect.count, `count of effect ${effect.id}`);
  }
}

/** The dialog as a function of its state: markup only, no state of its own. ConfirmDialog owns the state. */
export function ConfirmDialogView(props: ConfirmDialogViewProps): ReactElement {
  const { title, summary, effects, errors = [], copy, acknowledged, onToggle, onApprove, onCancel, pending = false, dialogRef, headingRef } = props;
  const base = useId();
  assertEffects(effects);
  const headingId = `${base}-title`;
  const summaryId = `${base}-summary`;
  const controlId = (effect: ConfirmEffect): string => `${base}-effect-${effect.id}`;
  const shown = new Set(effects.map((effect) => effect.id));

  const summaryItems: ErrorSummaryItem[] = errors.map((error) => ({
    fieldId: shown.has(error.effectId) ? controlId(effects.find((effect) => effect.id === error.effectId) as ConfirmEffect) : null,
    message: error.message,
  }));
  const approvable = canApprove(effects, acknowledged) && !pending;

  return (
    <dialog
      ref={dialogRef}
      className={CLASS.dialog}
      aria-labelledby={headingId}
      aria-describedby={summaryId}
      onCancel={(event) => cancelFromEscape(event, onCancel)}
      onKeyDown={(event) => {
        if (suppressEnter({ key: event.key, target: event.target as Element })) event.preventDefault();
      }}
    >
      <Heading level={2} id={headingId} tabIndex={-1} ref={headingRef}>
        {title}
      </Heading>
      <div id={summaryId} className={CLASS.dialogSummary}>
        {summary}
      </div>
      <ErrorSummary title={copy.errorSummaryTitle} errors={summaryItems} headingLevel={3} />
      <ul className={CLASS.effectList}>
        {effects.map((effect) => {
          const control = controlId(effect);
          const messages = errors.filter((error) => error.effectId === effect.id);
          const errorIds = messages.map((_, index) => `${control}-error-${index}`);
          return (
            <li key={effect.id} className={CLASS.effect}>
              <div id={`${control}-description`} className={CLASS.effectDescription}>
                <p>{effect.description}</p>
                <p>
                  <Count value={effect.count} /> {effect.countLabel}
                </p>
              </div>
              <div className={CLASS.effectAcknowledge}>
                <input
                  type="checkbox"
                  id={control}
                  checked={acknowledged.has(effect.id)}
                  onChange={(event) => onToggle(effect.id, event.currentTarget.checked)}
                  aria-describedby={[`${control}-description`, ...errorIds].join(" ")}
                  aria-invalid={messages.length > 0 ? true : undefined}
                />
                <label htmlFor={control}>{effect.acknowledgeLabel}</label>
              </div>
              {messages.map((error, index) => (
                <FieldError key={errorIds[index]} id={errorIds[index] as string}>
                  {error.message}
                </FieldError>
              ))}
            </li>
          );
        })}
      </ul>
      <div className={CLASS.dialogActions}>
        <Button variant="secondary" disabled={pending} onClick={onCancel}>
          {copy.cancel}
        </Button>
        <Button
          variant="primary"
          disabled={!approvable}
          aria-busy={pending ? true : undefined}
          onClick={() => {
            if (approvable) onApprove();
          }}
        >
          {copy.approve}
        </Button>
      </div>
    </dialog>
  );
}

function OpenConfirmDialog({ invoker, ...view }: Omit<ConfirmDialogProps, "open">): ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const dialog = dialogRef.current;
    const heading = headingRef.current;
    if (dialog === null || heading === null) return undefined;
    const active = document.activeElement;
    return enterDialog({ dialog, heading, invoker: invoker?.current ?? (active instanceof HTMLElement ? active : null) });
  }, [invoker]);

  return (
    <ConfirmDialogView
      {...view}
      dialogRef={dialogRef}
      headingRef={headingRef}
      acknowledged={acknowledged}
      onToggle={(effectId, checked) =>
        setAcknowledged((current) => {
          const next = new Set(current);
          if (checked) next.add(effectId);
          else next.delete(effectId);
          return next;
        })
      }
    />
  );
}

export function ConfirmDialog(props: ConfirmDialogProps): ReactElement | null {
  const { open, ...rest } = props;
  return open ? <OpenConfirmDialog {...rest} /> : null;
}
