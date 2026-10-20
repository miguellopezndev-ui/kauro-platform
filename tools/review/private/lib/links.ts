// The review's own addresses (Order 11). The project's basePath is /__review/private; a plain <a> does not add it, so it is written here.
export const BASE = "/__review/private";

export function viewerHref(id: string, context?: string, state?: string): string {
  const query = new URLSearchParams();
  if (context !== undefined) query.set("ctx", context);
  if (state !== undefined) query.set("state", state);
  const text = query.toString();
  return `${BASE}/screen/${id}${text === "" ? "" : `?${text}`}`;
}

export function frameHref(id: string, context?: string, state?: string): string {
  const query = new URLSearchParams();
  if (context !== undefined) query.set("ctx", context);
  if (state !== undefined) query.set("state", state);
  const text = query.toString();
  return `${BASE}/frame/${id}${text === "" ? "" : `?${text}`}`;
}
