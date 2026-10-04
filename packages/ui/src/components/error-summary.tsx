"use client";

import { useEffect, useId, useRef } from "react";
import type { ReactElement } from "react";
import { CLASS } from "../internal/class-names.js";
import { focusFieldById } from "../internal/dialog-controller.js";
import { Heading } from "../internal/heading.js";
import type { HeadingLevel } from "../internal/heading.js";

export interface ErrorSummaryItem {
  /** The id of the control the error belongs to, or null for an error that names no control on this page. */
  readonly fieldId: string | null;
  readonly message: string;
}

export interface ErrorSummaryProps {
  /** The summary's heading, for example "There is a problem". */
  readonly title: string;
  /** Renders nothing when empty. A new array (a new refusal) moves focus to the summary again. */
  readonly errors: readonly ErrorSummaryItem[];
  readonly headingLevel?: HeadingLevel | undefined;
}

/**
 * ErrorSummary (D-DS-1, D-A11Y-1): when a refusal arrives, focus moves to this summary; it lists every error, and each one that
 * names a control links to it and moves focus there. A group with a name, not an alert: focus already announces it.
 */
export function ErrorSummary({ title, errors, headingLevel = 2 }: ErrorSummaryProps): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (errors.length > 0) ref.current?.focus();
  }, [errors]);
  if (errors.length === 0) return null;
  return (
    <div ref={ref} tabIndex={-1} role="group" aria-labelledby={titleId} className={CLASS.errorSummary}>
      <Heading level={headingLevel} id={titleId}>
        {title}
      </Heading>
      <ul className={CLASS.errorSummaryList}>
        {errors.map((error, index) => (
          <li key={`${error.fieldId ?? "-"}:${index}`}>
            {error.fieldId === null ? (
              error.message
            ) : (
              <a
                href={`#${error.fieldId}`}
                onClick={(event) => {
                  if (focusFieldById((id) => document.getElementById(id), error.fieldId as string)) event.preventDefault();
                }}
              >
                {error.message}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
