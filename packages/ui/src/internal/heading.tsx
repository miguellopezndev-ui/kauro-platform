import type { ComponentPropsWithRef, ReactElement } from "react";
import { CLASS, cx } from "./class-names.js";
import { withoutStyling } from "./unstyled.js";

export type HeadingLevel = 2 | 3 | 4;

export interface HeadingProps extends Omit<ComponentPropsWithRef<"h2">, "className" | "style" | "dangerouslySetInnerHTML"> {
  readonly level: HeadingLevel;
  readonly extraClass?: string | undefined;
}

const TAG = { 2: "h2", 3: "h3", 4: "h4" } as const;

/** A heading at a chosen level, so a component can sit under whatever outline its page has. */
export function Heading({ level, extraClass, ...rest }: HeadingProps): ReactElement {
  if (!Object.hasOwn(TAG, level)) throw new RangeError(`heading level must be 2, 3 or 4: ${String(level)}`);
  const Tag = TAG[level];
  return <Tag {...withoutStyling(rest)} className={cx(CLASS.heading, extraClass)} />;
}
