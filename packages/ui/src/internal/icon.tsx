import type { ReactElement } from "react";
import { CLASS } from "./class-names.js";

/**
 * The icons the primitives draw. Each is an inline SVG built from presentation attributes (allowed under style-src-attr 'none')
 * and drawn in currentColor, so it takes the colour of the text beside it and follows forced-colors. They are decorative
 * (aria-hidden): the meaning is always carried by the text next to them. Every status tone has a different outline, so the
 * tone is readable without colour (D-DS-1: icon plus text).
 */
export type IconName =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "current"
  | "upcoming"
  | "sort"
  | "sort-ascending"
  | "sort-descending";

const CIRCLE = "M14.5 8a6.5 6.5 0 1 1-13 0a6.5 6.5 0 0 1 13 0z";

const PATHS: Readonly<Record<IconName, readonly string[]>> = Object.freeze({
  neutral: [CIRCLE, "M5.5 8h5"],
  info: [CIRCLE, "M8 7.25v4", "M8 4.75v.5"],
  success: [CIRCLE, "M5 8.25l2 2 4-4.5"],
  warning: ["M8 2L14.5 13.5H1.5z", "M8 6.5v3", "M8 11.5v.5"],
  danger: ["M5 1.5h6L14.5 5v6L11 14.5H5L1.5 11V5z", "M6 6l4 4", "M10 6l-4 4"],
  current: [CIRCLE, "M8 6v4"],
  upcoming: [CIRCLE],
  sort: ["M5 6.5L8 3.5l3 3", "M5 9.5L8 12.5l3-3"],
  "sort-ascending": ["M5 9.5L8 6.5l3 3"],
  "sort-descending": ["M5 6.5L8 9.5l3-3"],
});

export function Icon({ name }: { readonly name: IconName }): ReactElement {
  const paths = PATHS[name];
  return (
    <svg
      className={CLASS.icon}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={name === "upcoming" ? "2 2" : undefined}
      aria-hidden="true"
      focusable="false"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
