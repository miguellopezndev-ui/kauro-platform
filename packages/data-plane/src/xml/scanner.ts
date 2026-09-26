/**
 * A streaming, hardened XML scanner for the parts of an untrusted workbook (04 "XLSX parser requirements": "XML external entities
 * and DTD processing are disabled"; XML depth is a limit; S024 "XML entities"). It is not a general XML processor on purpose:
 *
 * - any document type declaration or markup declaration (`<!DOCTYPE`, `<!ENTITY`, `<!ELEMENT`, `<!ATTLIST`, `<!NOTATION`) is refused
 *   as ACTIVE_CONTENT (XML_DTD) the moment it is seen, so no entity can be defined, expanded or fetched;
 * - an entity reference other than the five predefined ones and numeric character references is refused (XML_UNDEFINED_ENTITY:
 *   without a DTD nothing can define it);
 * - input must be UTF-8 (the OOXML encoding; a declaration naming another is refused); characters XML 1.0 forbids are refused;
 * - element nesting beyond the depth bound, and a single token (tag, comment, processing instruction, CDATA section) longer than
 *   the token bound, is RESOURCE_LIMIT; unbalanced or malformed markup and text outside the root element are CORRUPT_STRUCTURE.
 *
 * Events report element names with their namespace prefix removed (SpreadsheetML is matched by local name) and attributes by their
 * qualified names. Text is reported in pieces as it streams; the consumer bounds what it accumulates.
 *
 * Loaded inside the isolated child: no imports but this package's error type.
 */
import { InspectionRefusal } from "../errors.js";

export interface XmlLimits {
  readonly maxDepth: number;
  /** The longest single markup token (a start tag with its attributes, a comment, a CDATA section), in characters. */
  readonly maxTokenChars: number;
}

export type XmlAttributes = ReadonlyMap<string, string>;

export interface XmlEvents {
  open(name: string, attributes: XmlAttributes): void;
  close(name: string): void;
  text(value: string): void;
}

const PREDEFINED: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);
const INVALID_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/;
const NAME = /^[A-Za-z_À-�][-A-Za-z0-9_.·À-�]*(?::[A-Za-z_À-�][-A-Za-z0-9_.·À-�]*)?$/;
const MARKUP_DECLARATIONS = ["<!DOCTYPE", "<!ENTITY", "<!ELEMENT", "<!ATTLIST", "<!NOTATION"];

export function localName(qualified: string): string {
  const i = qualified.indexOf(":");
  return i < 0 ? qualified : qualified.slice(i + 1);
}

/** The value of a namespaced attribute by local name (`r:id` under any prefix but `xmlns`), or undefined. */
export function prefixedAttribute(attributes: XmlAttributes, local: string): string | undefined {
  for (const [name, value] of attributes) {
    const i = name.indexOf(":");
    if (i > 0 && name.slice(0, i) !== "xmlns" && name.slice(i + 1) === local) return value;
  }
  return undefined;
}

export class XmlScanner {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  private buffer = "";
  private readonly stack: string[] = [];
  private rootSeen = false;
  private anything = false;

  constructor(
    private readonly events: XmlEvents,
    private readonly limits: XmlLimits,
    private readonly part: string,
  ) {}

  write(bytes: Uint8Array): void {
    let text: string;
    try {
      text = this.decoder.decode(bytes, { stream: true });
    } catch {
      throw this.refuse("CORRUPT_STRUCTURE", "XML_ENCODING_INVALID");
    }
    this.buffer += text;
    this.drain(false);
  }

  end(): void {
    let text: string;
    try {
      text = this.decoder.decode();
    } catch {
      throw this.refuse("CORRUPT_STRUCTURE", "XML_ENCODING_INVALID");
    }
    this.buffer += text;
    this.drain(true);
    if (this.stack.length > 0 || !this.rootSeen) throw this.refuse("CORRUPT_STRUCTURE", "XML_TRUNCATED");
  }

  private refuse(refusal: "CORRUPT_STRUCTURE" | "ACTIVE_CONTENT" | "RESOURCE_LIMIT", code: string): InspectionRefusal {
    return new InspectionRefusal(refusal, code, this.part);
  }

  private drain(final: boolean): void {
    const buf = this.buffer;
    const n = buf.length;
    let pos = 0;
    while (pos < n) {
      const lt = buf.indexOf("<", pos);
      if (lt < 0) {
        // text to the end, holding back an entity reference that is not complete yet
        let end = n;
        const amp = buf.lastIndexOf("&");
        if (!final && amp >= pos && buf.indexOf(";", amp) < 0) {
          if (n - amp > 16) throw this.refuse("CORRUPT_STRUCTURE", "XML_MALFORMED_REFERENCE");
          end = amp;
        }
        if (end > pos) this.text(buf.slice(pos, end));
        pos = end;
        break;
      }
      if (lt > pos) this.text(buf.slice(pos, lt));
      pos = lt;
      const next = this.markup(buf, pos, final);
      if (next < 0) break;
      pos = next;
    }
    this.buffer = buf.slice(pos);
    if (this.buffer.length > this.limits.maxTokenChars) throw this.refuse("RESOURCE_LIMIT", "XML_TOKEN_LIMIT");
    if (final && this.buffer.length > 0) throw this.refuse("CORRUPT_STRUCTURE", "XML_TRUNCATED");
  }

  private text(raw: string): void {
    if (raw.length === 0) return;
    if (this.stack.length === 0) {
      if (raw.trim().length > 0) throw this.refuse("CORRUPT_STRUCTURE", "XML_TEXT_OUTSIDE_ROOT");
      this.anything = true;
      return;
    }
    const value = this.decodeReferences(raw);
    if (INVALID_CHARACTER.test(value)) throw this.refuse("CORRUPT_STRUCTURE", "XML_INVALID_CHARACTER");
    this.anything = true;
    this.events.text(value);
  }

  private decodeReferences(raw: string): string {
    if (raw.indexOf("&") < 0) return raw;
    let out = "";
    let i = 0;
    for (;;) {
      const amp = raw.indexOf("&", i);
      if (amp < 0) {
        out += raw.slice(i);
        return out;
      }
      out += raw.slice(i, amp);
      const semi = raw.indexOf(";", amp);
      if (semi < 0 || semi - amp > 16) throw this.refuse("CORRUPT_STRUCTURE", "XML_MALFORMED_REFERENCE");
      const name = raw.slice(amp + 1, semi);
      if (name.startsWith("#")) {
        const hex = name.startsWith("#x");
        const digits = name.slice(hex ? 2 : 1);
        if (!(hex ? /^[0-9A-Fa-f]{1,6}$/ : /^[0-9]{1,7}$/).test(digits)) throw this.refuse("CORRUPT_STRUCTURE", "XML_MALFORMED_REFERENCE");
        const cp = Number.parseInt(digits, hex ? 16 : 10);
        const valid = cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
        if (!valid) throw this.refuse("CORRUPT_STRUCTURE", "XML_INVALID_CHARACTER");
        out += String.fromCodePoint(cp);
      } else {
        const v = PREDEFINED.get(name);
        if (v === undefined) throw this.refuse("CORRUPT_STRUCTURE", "XML_UNDEFINED_ENTITY");
        out += v;
      }
      i = semi + 1;
    }
  }

  /** Handles the markup token at `pos` (which holds '<'); returns the position after it, or -1 when it is not complete yet. */
  private markup(buf: string, pos: number, final: boolean): number {
    const incomplete = (): number => {
      if (final) throw this.refuse("CORRUPT_STRUCTURE", "XML_TRUNCATED");
      if (buf.length - pos > this.limits.maxTokenChars) throw this.refuse("RESOURCE_LIMIT", "XML_TOKEN_LIMIT");
      return -1;
    };
    if (buf.startsWith("<?", pos)) {
      const end = buf.indexOf("?>", pos + 2);
      if (end < 0) return incomplete();
      const body = buf.slice(pos + 2, end);
      const target = /^[^\s?]*/.exec(body)?.[0] ?? "";
      if (target.toLowerCase() === "xml") {
        if (this.anything || pos !== 0) throw this.refuse("CORRUPT_STRUCTURE", "XML_DECLARATION_MISPLACED");
        const encoding = /\bencoding\s*=\s*["']([^"']*)["']/.exec(body)?.[1];
        if (encoding !== undefined && !/^utf-?8$/i.test(encoding)) throw this.refuse("CORRUPT_STRUCTURE", "XML_ENCODING_UNSUPPORTED");
      }
      this.anything = true;
      return end + 2;
    }
    if (buf.startsWith("<!", pos)) {
      if (buf.length - pos < 10 && !final) {
        // not enough characters to tell a comment, a CDATA section or a declaration apart
        const head = buf.slice(pos);
        if ("<!--".startsWith(head) || "<![CDATA[".startsWith(head) || MARKUP_DECLARATIONS.some((d) => d.startsWith(head.toUpperCase()))) return incomplete();
      }
      if (buf.startsWith("<!--", pos)) {
        const end = buf.indexOf("-->", pos + 4);
        if (end < 0) return incomplete();
        this.anything = true;
        return end + 3;
      }
      if (buf.startsWith("<![CDATA[", pos)) {
        const end = buf.indexOf("]]>", pos + 9);
        if (end < 0) return incomplete();
        if (this.stack.length === 0) throw this.refuse("CORRUPT_STRUCTURE", "XML_TEXT_OUTSIDE_ROOT");
        const value = buf.slice(pos + 9, end);
        if (INVALID_CHARACTER.test(value)) throw this.refuse("CORRUPT_STRUCTURE", "XML_INVALID_CHARACTER");
        this.events.text(value);
        return end + 3;
      }
      const upper = buf.slice(pos, pos + 10).toUpperCase();
      if (MARKUP_DECLARATIONS.some((d) => upper.startsWith(d))) throw this.refuse("ACTIVE_CONTENT", "XML_DTD");
      throw this.refuse("CORRUPT_STRUCTURE", "XML_MALFORMED");
    }
    if (buf.startsWith("</", pos)) {
      const end = buf.indexOf(">", pos + 2);
      if (end < 0) return incomplete();
      const name = buf.slice(pos + 2, end).trimEnd();
      const open = this.stack.pop();
      if (open === undefined || open !== name) throw this.refuse("CORRUPT_STRUCTURE", "XML_MISMATCHED_TAG");
      this.events.close(localName(name));
      return end + 1;
    }
    // a start tag: find its end outside quoted attribute values
    let quote = "";
    let end = -1;
    for (let i = pos + 1; i < buf.length; i++) {
      const c = buf[i] as string;
      if (quote !== "") {
        if (c === quote) quote = "";
        else if (c === "<") throw this.refuse("CORRUPT_STRUCTURE", "XML_MALFORMED");
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") {
        end = i;
        break;
      } else if (c === "<") throw this.refuse("CORRUPT_STRUCTURE", "XML_MALFORMED");
    }
    if (end < 0) return incomplete();
    this.startTag(buf.slice(pos + 1, end));
    return end + 1;
  }

  private startTag(body: string): void {
    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameMatch = /^[^\s/>]+/.exec(inner);
    const name = nameMatch?.[0] ?? "";
    if (!NAME.test(name)) throw this.refuse("CORRUPT_STRUCTURE", "XML_MALFORMED");
    if (this.stack.length === 0 && this.rootSeen) throw this.refuse("CORRUPT_STRUCTURE", "XML_MULTIPLE_ROOTS");
    const attributes = new Map<string, string>();
    let i = name.length;
    for (;;) {
      const ws = /^\s*/.exec(inner.slice(i))?.[0].length ?? 0;
      i += ws;
      if (i >= inner.length) break;
      if (ws === 0) throw this.refuse("CORRUPT_STRUCTURE", "XML_MALFORMED");
      const m = /^([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(inner.slice(i));
      if (m === null) throw this.refuse("CORRUPT_STRUCTURE", "XML_MALFORMED");
      const attr = m[1] as string;
      if (!NAME.test(attr) || attributes.has(attr)) throw this.refuse("CORRUPT_STRUCTURE", "XML_MALFORMED");
      const value = this.decodeReferences((m[2] ?? m[3] ?? "").replace(/[\t\n\r]/g, " "));
      if (INVALID_CHARACTER.test(value)) throw this.refuse("CORRUPT_STRUCTURE", "XML_INVALID_CHARACTER");
      attributes.set(attr, value);
      i += m[0].length;
    }
    if (this.stack.length + 1 > this.limits.maxDepth) throw this.refuse("RESOURCE_LIMIT", "XML_DEPTH_LIMIT");
    this.rootSeen = true;
    this.anything = true;
    const local = localName(name);
    this.events.open(local, attributes);
    if (selfClosing) this.events.close(local);
    else this.stack.push(name);
  }
}

/** Bounded text accumulation of one element (a cell value, a shared string): RESOURCE_LIMIT beyond `maxBytes` UTF-8 bytes. */
export class TextAccumulator {
  private pieces: string[] = [];
  private bytes = 0;
  constructor(
    private readonly maxBytes: number,
    private readonly part: string,
    private readonly code: string,
  ) {}
  add(value: string): void {
    this.bytes += Buffer.byteLength(value, "utf8");
    if (this.bytes > this.maxBytes) throw new InspectionRefusal("RESOURCE_LIMIT", this.code, this.part);
    this.pieces.push(value);
  }
  take(): string {
    const v = this.pieces.join("");
    this.pieces = [];
    this.bytes = 0;
    return v;
  }
}
