/**
 * The local worker protocol's wire (B14-A; docs/design/B14-A-worker-executor.md §4): its own frames over a plain pipe (the worker's
 * fd 3), never Node's IPC channel (review round 21, R21-1, R21-2). Node's channel parses and buffers whatever the other side writes
 * before any code of the host sees it: an invalid serialized frame threw out of its reader, a declared length of 4 GiB was buffered
 * as it trickled in, and its own commands and handles were trusted. Here the reader is ours, and every limit holds before a byte of
 * a payload is kept:
 *
 *   frame = [u32 BE header length][u32 BE body length][header: UTF-8 JSON object][body: bytes]
 *
 * The prefix is read first and a frame that declares more than FRAME_MAX_HEADER_BYTES of header or FRAME_MAX_BODY_BYTES of body is
 * refused at once. Messages are decoded one at a time, when the reader asks (FrameDecoder.next), so a reader bounds what it holds by
 * how many it asks for and by pausing its pipe meanwhile (the host: local-process-host.ts). The header is strict UTF-8, a JSON object; the one
 * binary field a message may carry (a ticket's bytes, a reply's bytes, a chunk) travels as the body, its place named by the header's
 * BODY_KEY, one of BODY_PLACES. Anything else is a violation: the reader stops and the attempt ends.
 */

/** The largest header a frame may declare: every message's own fields, without its bytes. */
export const FRAME_MAX_HEADER_BYTES = 16 * 1024;
/** The largest body a frame may declare: a ticket (ATTEMPT_TICKET_MAX_BYTES), one upload chunk (the writer's) or one read chunk. */
export const FRAME_MAX_BODY_BYTES = 8 * 1024 * 1024;
const PREFIX_BYTES = 8;
/** The header's own key naming where the body goes. */
const BODY_KEY = "~body";
/** Where a body may go: a ticket's bytes, a reply's value, an upload's chunk. */
const BODY_PLACES = ["bytes", "value", "call.chunk"] as const;

/** Why a frame was refused (the reader stops at the first). */
export class FrameViolation extends Error {
  readonly code = "CHANNEL_PROTOCOL_VIOLATION";
  constructor(problem: string) {
    super(`the channel's frame is not one of the protocol's: ${problem}`);
    this.name = "FrameViolation";
  }
}

function placeOf(message: Record<string, unknown>, place: string): { readonly parent: Record<string, unknown>; readonly key: string } | null {
  const path = place.split(".");
  let parent = message;
  for (const key of path.slice(0, -1)) {
    const next = parent[key];
    if (next === null || typeof next !== "object" || Array.isArray(next)) return null;
    parent = next as Record<string, unknown>;
  }
  return { parent, key: path[path.length - 1] as string };
}

/** One message as one frame (its bytes, if any, as the body). Throws on a message the protocol cannot carry (this side's own bug). */
export function encodeFrame(message: object): Buffer {
  let body: Uint8Array | null = null;
  let header: Record<string, unknown> = message as Record<string, unknown>;
  for (const place of BODY_PLACES) {
    const at = placeOf(header, place);
    const value = at?.parent[at.key];
    if (at === null || !(value instanceof Uint8Array)) continue;
    if (body !== null) throw new Error("a frame carries one body");
    body = value;
    // a copy of the path down to the body's place, the place itself null: the message given is never changed
    const copy: Record<string, unknown> = { ...header, [BODY_KEY]: place };
    if (place === "call.chunk") copy["call"] = { ...(header["call"] as Record<string, unknown>), chunk: null };
    else copy[place] = null;
    header = copy;
  }
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const bodyBytes = body === null ? 0 : body.byteLength;
  if (json.byteLength > FRAME_MAX_HEADER_BYTES || bodyBytes > FRAME_MAX_BODY_BYTES) throw new Error("a message larger than a frame");
  const prefix = Buffer.alloc(PREFIX_BYTES);
  prefix.writeUInt32BE(json.byteLength, 0);
  prefix.writeUInt32BE(bodyBytes, 4);
  return body === null ? Buffer.concat([prefix, json]) : Buffer.concat([prefix, json, body]);
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function messageOf(headerBytes: Buffer, body: Buffer): Record<string, unknown> {
  let header: unknown;
  try {
    header = JSON.parse(UTF8.decode(headerBytes));
  } catch {
    throw new FrameViolation("a header that is not UTF-8 JSON");
  }
  if (header === null || typeof header !== "object" || Array.isArray(header)) throw new FrameViolation("a header that is not an object");
  const message = header as Record<string, unknown>;
  const place = message[BODY_KEY];
  if (place === undefined) {
    if (body.byteLength > 0) throw new FrameViolation("a body no header names");
    return message;
  }
  delete message[BODY_KEY];
  const at = typeof place === "string" && (BODY_PLACES as readonly string[]).includes(place) ? placeOf(message, place) : null;
  if (at === null) throw new FrameViolation("a body's place outside the protocol");
  // bytes of their own: no frame the reader assembled is kept alive by them
  at.parent[at.key] = new Uint8Array(body);
  return message;
}

/**
 * The reader of one channel: bytes in, whole messages out, one at a time and only when its reader asks — so a reader that holds as
 * many calls as it may simply stops asking (and stops reading its pipe), and nothing it has not asked for is decoded. It holds the
 * bytes given and not yet asked for, which its reader bounds by pausing its pipe; a frame's prefix is checked as soon as it is there,
 * so a frame that declares more than the protocol's bounds is refused before its payload is held. A violation stops it for good.
 */
export class FrameDecoder {
  readonly #maxBody: number;
  #chunks: Buffer[] = [];
  #held = 0;
  #headerBytes = -1;
  #bodyBytes = -1;
  #failed: FrameViolation | null = null;

  constructor(maxBodyBytes: number = FRAME_MAX_BODY_BYTES) {
    this.#maxBody = maxBodyBytes;
  }

  /** The bytes held now (given and not yet decoded). */
  get heldBytes(): number {
    return this.#held;
  }

  /** Takes bytes (a copy: the reader's own buffer is never kept). Throws FrameViolation when the next frame's prefix is outside the protocol. */
  push(bytes: Uint8Array): void {
    if (this.#failed !== null) throw this.#failed;
    if (bytes.byteLength === 0) return;
    this.#chunks.push(Buffer.from(bytes));
    this.#held += bytes.byteLength;
    this.#guard(() => this.#prefix());
  }

  /** The next whole message, or null until its bytes are all there. Throws FrameViolation at the first frame outside the protocol. */
  next(): Record<string, unknown> | null {
    if (this.#failed !== null) throw this.#failed;
    return this.#guard(() => {
      if (!this.#prefix()) return null;
      const need = this.#headerBytes + this.#bodyBytes;
      if (this.#held < need) return null;
      const frame = this.#take(need);
      const header = frame.subarray(0, this.#headerBytes);
      // an empty body is still a body when the header names it (an empty final chunk)
      const body = frame.subarray(this.#headerBytes);
      this.#headerBytes = -1;
      this.#bodyBytes = -1;
      const message = messageOf(header, body);
      // the next frame's prefix, if it is already here, is checked now too
      this.#prefix();
      return message;
    });
  }

  #guard<T>(f: () => T): T {
    try {
      return f();
    } catch (error) {
      this.#failed = error instanceof FrameViolation ? error : new FrameViolation("an unreadable frame");
      this.#chunks = [];
      this.#held = 0;
      throw this.#failed;
    }
  }

  /** Reads the current frame's prefix once it is there (true), checking its bounds before anything of the frame is kept. */
  #prefix(): boolean {
    if (this.#headerBytes >= 0) return true;
    if (this.#held < PREFIX_BYTES) return false;
    const prefix = this.#take(PREFIX_BYTES);
    const header = prefix.readUInt32BE(0);
    const body = prefix.readUInt32BE(4);
    if (header === 0 || header > FRAME_MAX_HEADER_BYTES) throw new FrameViolation("a header length outside the protocol");
    if (body > this.#maxBody) throw new FrameViolation("a body length outside the protocol");
    this.#headerBytes = header;
    this.#bodyBytes = body;
    return true;
  }

  #take(n: number): Buffer {
    const all = this.#chunks.length === 1 ? (this.#chunks[0] as Buffer) : Buffer.concat(this.#chunks, this.#held);
    const taken = Buffer.from(all.subarray(0, n));
    const rest = all.subarray(n);
    this.#chunks = rest.byteLength > 0 ? [rest] : [];
    this.#held = rest.byteLength;
    return taken;
  }
}
