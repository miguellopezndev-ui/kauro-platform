/**
 * List cursors (re-check finding N16; 10 "Pagination, search and exports": "Cursors are opaque, integrity-protected and bound to actor
 * scope, filter, sort and snapshot policy. Deleting or inserting records between pages has a documented consistency model. A
 * cursor cannot be edited to enumerate another tenant"; registry R2-060 "Reject cursor scope/signature mismatch without leaking
 * rows or totals").
 *
 * A cursor is `<position>.<mac>`: the base64url JSON of the keyset position (the createdAt and id of the last row of the page
 * it continues) and an HMAC-SHA256, under the server's cursor key, over that position and the binding of the request that
 * received it — the read operation, the acting identity, the agency scope, the filter, the sort order and the snapshot policy.
 * The binding itself is never in the token: a cursor presented by another identity, for another agency, another list, filter or
 * order does not verify and is refused as CURSOR_INVALID, before any row is read, with nothing about the other scope.
 *
 * Consistency model (KEYSET_V1): pages follow the total order (createdAt, id) strictly after the position; a row inserted before
 * the position is not revisited, a row inserted after it appears on a later page, and a removed row never shifts another page.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const CURSOR_SORT = "createdAt,id:asc";
export const CURSOR_SNAPSHOT_POLICY = "KEYSET_V1";
/** The wire shape of a cursor (the response schemas and the query admission use it). */
export const CURSOR_PATTERN = "^[A-Za-z0-9_-]{8,512}\\.[A-Za-z0-9_-]{43}$";
const CURSOR_SHAPE = new RegExp(CURSOR_PATTERN);
const POSITION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POSITION_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/** What a cursor is bound to: the request it was issued for. */
export interface CursorBinding {
  readonly operation: string;
  readonly userId: string;
  readonly agencyId: string | null;
  /** The list filter, canonical (an empty string when the list has none). */
  readonly filter: string;
}

export interface CursorPosition {
  readonly createdAt: string;
  readonly id: string;
}

function bindingText(binding: CursorBinding): string {
  return ["kauro.cursor.v1", binding.operation, binding.userId, binding.agencyId ?? "-", binding.filter, CURSOR_SORT, CURSOR_SNAPSHOT_POLICY].join("|");
}

function macOf(key: Uint8Array, position: string, binding: CursorBinding): Buffer {
  return createHmac("sha256", key).update(`${position}.${bindingText(binding)}`, "utf8").digest();
}

/** A key of at least 32 bytes (HMAC-SHA256's block security); anything shorter is refused where the key is configured. */
export function isCursorKey(key: Uint8Array): boolean {
  return key.byteLength >= 32;
}

/** The cursor that continues after `position` for exactly `binding`. */
export function sealCursor(key: Uint8Array, binding: CursorBinding, position: CursorPosition): string {
  if (!isCursorKey(key)) throw new RangeError("a cursor key has at least 32 bytes");
  const encoded = Buffer.from(JSON.stringify([position.createdAt, position.id]), "utf8").toString("base64url");
  return `${encoded}.${macOf(key, encoded, binding).toString("base64url")}`;
}

/**
 * The position a cursor names when it was sealed for exactly `binding` with this key; null for anything else (another scope,
 * list, filter, identity or key, an edited position, a malformed token).
 */
export function openCursor(key: Uint8Array, binding: CursorBinding, token: string): CursorPosition | null {
  if (!isCursorKey(key) || !CURSOR_SHAPE.test(token)) return null;
  const [encoded, mac] = token.split(".") as [string, string];
  const expected = macOf(key, encoded, binding);
  const presented = Buffer.from(mac, "base64url");
  if (presented.byteLength !== expected.byteLength || !timingSafeEqual(presented, expected)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (e) {
    // a verified MAC over bytes that are not JSON cannot come from sealCursor: the key signed something else
    if (e instanceof SyntaxError) return null;
    throw e;
  }
  if (!Array.isArray(decoded) || decoded.length !== 2) return null;
  const [createdAt, id] = decoded as unknown[];
  if (typeof createdAt !== "string" || !POSITION_TIME.test(createdAt) || typeof id !== "string" || !POSITION_ID.test(id)) return null;
  return { createdAt, id };
}
