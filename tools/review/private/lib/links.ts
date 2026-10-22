// The review's own addresses (Order 11). The private screens are served at their real application paths on the review origin; the review's
// index and viewer live under /__review/private; /__as/{person} chooses who the review shows the application to.
export const REVIEW = "/__review/private";
export const AS_COOKIE = "kauro_review_as";

export function viewerHref(id: string, context?: string, state?: string): string {
  const query = new URLSearchParams();
  if (context !== undefined) query.set("ctx", context);
  if (state !== undefined) query.set("state", state);
  const text = query.toString();
  return `${REVIEW}/screen/${id}${text === "" ? "" : `?${text}`}`;
}

/** A screen's real path, drawn for one person in one state (the viewer's frame); without them it is the plain experience. */
export function stateHref(path: string, context?: string, state?: string, proposal?: string): string {
  const query = new URLSearchParams();
  if (context !== undefined) query.set("review-as", context);
  if (state !== undefined) query.set("review-state", state);
  if (proposal !== undefined) query.set("review-proposal", proposal);
  const text = query.toString();
  return `${path}${text === "" ? "" : `?${text}`}`;
}

/** Enter the application as one of the synthetic people, at `next` or at that person's own landing page. */
export function asHref(person: string, next?: string): string {
  return `/__as/${person}${next === undefined ? "" : `?next=${encodeURIComponent(next)}`}`;
}
