"use client";

import { useId, useState } from "react";
import type { ReactElement } from "react";
import { CLASS } from "../internal/class-names.js";

export interface SafeTextDisclosureProps {
  readonly preview: string;
  readonly value: string;
  readonly showFullValue: string;
}

/**
 * The cut form of SafeText: the preview and a disclosure button. The button names what it does, reports its state with
 * aria-expanded and controls the element that holds the full value, which stays hidden (and out of the accessibility tree)
 * until it is used. Both texts are inside their own <bdi>, like every SafeText value.
 */
export function SafeTextDisclosure({ preview, value, showFullValue }: SafeTextDisclosureProps): ReactElement {
  const fullId = useId();
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <bdi>{preview}</bdi>{" "}
      <button type="button" className={CLASS.disclosure} aria-expanded={expanded} aria-controls={fullId} onClick={() => setExpanded((open) => !open)}>
        {showFullValue}
      </button>
      <span id={fullId} className={CLASS.safeTextFull} hidden={!expanded}>
        <bdi>{value}</bdi>
      </span>
    </>
  );
}
