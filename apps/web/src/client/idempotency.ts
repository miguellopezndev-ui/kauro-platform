// Idempotency keys of the browser (design D-OPS-1; 10 "Idempotency contract": "A response lost after commit is recovered by the same key.
// The client does not generate a new key merely because it did not receive an answer"). One logical intent has one key:
//   - a subject-bound command (CMD025 approve a plan, CMD028 create a payment order, CMD029 capture a payment, CMD036 …) derives it:
//     UUIDv5(KAURO_WEB_OPERATIONS, "CMDnnn:subjectId:subjectVersion"), so a double activation, a lost response, a reload and a second tab
//     all arrive at the same key and the server replays;
//   - a creation without a subject (CMD001, 009, 011, 044) mints a UUIDv7 when its form opens and keeps it until a COMPLETED answer.
// Both forms satisfy the api's key pattern ^[A-Za-z0-9_-]{16,128}$.

/** The namespace of the web's operation keys (a fixed UUID; changing it re-keys every intent, which the server would treat as new). */
export const KAURO_WEB_OPERATIONS = "badaa28e-3e6f-4225-af2c-6d677b9b9ba2";

export type CommandId = `CMD${string}`;

const COMMAND = /^CMD\d{3}$/;
/** A component of the derivation name: no colon (it would let one name be read as another) and nothing outside a safe alphabet. */
const COMPONENT = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatUuid(bytes: Uint8Array): string {
  const hex = hexOf(bytes.subarray(0, 16));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The name a subject-bound key is derived from. Throws RangeError for a component that could shift the boundary between fields. */
export function operationKeyName(command: string, subjectId: string, subjectVersion: number | string): string {
  if (!COMMAND.test(command)) throw new RangeError("an operation names a command as CMDnnn");
  if (!COMPONENT.test(subjectId)) throw new RangeError("the subject id of an operation is 1 to 128 characters of A-Z a-z 0-9 _ -");
  let version: string;
  if (typeof subjectVersion === "number") {
    if (!Number.isSafeInteger(subjectVersion) || subjectVersion < 0) throw new RangeError("a numeric subject version is a non-negative safe integer");
    version = String(subjectVersion);
  } else {
    if (!COMPONENT.test(subjectVersion)) throw new RangeError("the subject version of an operation is 1 to 128 characters of A-Z a-z 0-9 _ -");
    version = subjectVersion;
  }
  return `${command}:${subjectId}:${version}`;
}

/** RFC 9562 UUIDv5 (SHA-1) of `name` in `namespace`. */
export async function uuidV5(namespace: string, name: string): Promise<string> {
  if (!UUID.test(namespace)) throw new RangeError("a namespace is a lowercase UUID");
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error("WebCrypto is unavailable: a key cannot be derived in this context");
  const namespaceBytes = Uint8Array.from(namespace.replaceAll("-", "").match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
  input.set(namespaceBytes, 0);
  input.set(nameBytes, namespaceBytes.length);
  const digest = new Uint8Array(await subtle.digest("SHA-1", input)).slice(0, 16);
  digest[6] = ((digest[6] as number) & 0x0f) | 0x50;
  digest[8] = ((digest[8] as number) & 0x3f) | 0x80;
  return formatUuid(digest);
}

/** The key of the intent "run `command` on this version of this subject". */
export async function deriveOperationKey(command: string, subjectId: string, subjectVersion: number | string): Promise<string> {
  return uuidV5(KAURO_WEB_OPERATIONS, operationKeyName(command, subjectId, subjectVersion));
}

/** RFC 9562 UUIDv7: the 48-bit millisecond instant, then 74 random bits. `now` and `randomBytes` are injected so a test owns both. */
export function newFormKey(now: () => number, randomBytes: (length: number) => Uint8Array): string {
  const instant = now();
  if (!Number.isSafeInteger(instant) || instant < 0 || instant >= 2 ** 48) throw new RangeError("the clock did not answer a millisecond instant");
  const random = randomBytes(10);
  if (random.length !== 10) throw new RangeError("ten random bytes were requested");
  const bytes = new Uint8Array(16);
  let rest = instant;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  bytes.set(random, 6);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  return formatUuid(bytes);
}
