// The props no primitive accepts: it is styled only by the generated stylesheet (B11 D-SEC-1: no inline style; D-DS-3: no markup
// written into the page). The types already omit them, so a typed caller cannot pass one; this also drops them at run time, so a
// spread of props nobody typed (a JavaScript caller, a cast) cannot bring a style attribute or raw markup back in.

const REFUSED = ["className", "style", "dangerouslySetInnerHTML"] as const;

/** A shallow copy of the props without a class name, a style or raw markup. */
export function withoutStyling<T extends object>(props: T): T {
  const copy: Record<string, unknown> = { ...(props as Record<string, unknown>) };
  for (const name of REFUSED) delete copy[name];
  return copy as T;
}
