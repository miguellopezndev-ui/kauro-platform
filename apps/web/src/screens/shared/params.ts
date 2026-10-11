// The identifiers a screen takes from its address (design D-ROUTE-1): an id that is not the api's own id shape is never sent anywhere; the
// page answers "not found" before any read. Query values are single strings only (a repeated parameter is no id).
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function idOrNull(value: string | readonly string[] | undefined): string | null {
  return typeof value === "string" && ID.test(value) ? value : null;
}
