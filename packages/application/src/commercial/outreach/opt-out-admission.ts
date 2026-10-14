/**
 * Admission of the RFC 8058 one-click POST (plan docs/design/B12-outreach-plan.md "Public opt-out", ADV-26, D-B12O-13). The request is the
 * mail client's, not a browser session's: s.3.1 "MUST NOT include cookies, HTTP authorization, or any other context information", s.3.2 the
 * content is multipart/form-data (SHOULD) or application/x-www-form-urlencoded (MAY). This module admits exactly:
 *  (i) Content-Type application/x-www-form-urlencoded (parameter charset=utf-8 optional) with the body bytes `List-Unsubscribe=One-Click`, or
 *  (ii) multipart/form-data with one boundary and exactly one part, Content-Disposition form-data; name="List-Unsubscribe", value One-Click;
 * a body of at most 1 KiB. It reads no Idempotency-Key, Origin, cookie or Authorization header: it is handed the content type and the bytes
 * only. Any other media type is CONTENT_TYPE_UNSUPPORTED (415), any other body SCHEMA_VIOLATION (400); both write nothing.
 */
export const OPT_OUT_BODY_LIMIT_BYTES = 1024;

export type OneClickAdmission = { readonly kind: "ADMITTED" } | { readonly kind: "CONTENT_TYPE_UNSUPPORTED" } | { readonly kind: "SCHEMA_VIOLATION" };

const ADMITTED: OneClickAdmission = Object.freeze({ kind: "ADMITTED" });
const UNSUPPORTED: OneClickAdmission = Object.freeze({ kind: "CONTENT_TYPE_UNSUPPORTED" });
const VIOLATION: OneClickAdmission = Object.freeze({ kind: "SCHEMA_VIOLATION" });

const FORM_BODY = "List-Unsubscribe=One-Click";
const BOUNDARY = /^[0-9A-Za-z'()+_,\-./:=?]{1,70}$/;

interface ParsedType {
  readonly media: string;
  readonly params: ReadonlyArray<readonly [string, string]>;
}

function parseContentType(header: string): ParsedType | null {
  const parts = header.split(";");
  const media = (parts[0] ?? "").trim().toLowerCase();
  const params: Array<readonly [string, string]> = [];
  for (const raw of parts.slice(1)) {
    const eq = raw.indexOf("=");
    if (eq < 0) return null;
    const name = raw.slice(0, eq).trim().toLowerCase();
    let value = raw.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    params.push([name, value]);
  }
  return { media, params };
}

function admitMultipart(params: ParsedType["params"], text: string): OneClickAdmission {
  const boundaries = params.filter(([n]) => n === "boundary");
  if (boundaries.length !== 1 || params.length !== 1) return VIOLATION;
  const boundary = boundaries[0]![1];
  if (!BOUNDARY.test(boundary)) return VIOLATION;
  const open = `--${boundary}\r\n`;
  const close = `\r\n--${boundary}--`;
  if (!text.startsWith(open)) return VIOLATION;
  let rest = text.slice(open.length);
  // an optional single CRLF may follow the closing delimiter
  if (rest.endsWith("\r\n")) rest = rest.slice(0, -2);
  if (!rest.endsWith(close)) return VIOLATION;
  const part = rest.slice(0, rest.length - close.length);
  if (part.includes(`--${boundary}`)) return VIOLATION; // a second part
  const split = part.indexOf("\r\n\r\n");
  if (split < 0) return VIOLATION;
  const headers = part.slice(0, split).split("\r\n");
  const value = part.slice(split + 4);
  if (headers.length !== 1) return VIOLATION;
  const header = headers[0]!;
  const colon = header.indexOf(":");
  if (colon < 0 || header.slice(0, colon).trim().toLowerCase() !== "content-disposition") return VIOLATION;
  const disposition = header
    .slice(colon + 1)
    .split(";")
    .map((s) => s.trim());
  if (disposition.length !== 2 || disposition[0]!.toLowerCase() !== "form-data" || disposition[1] !== 'name="List-Unsubscribe"') return VIOLATION;
  return value === "One-Click" ? ADMITTED : VIOLATION;
}

/** The admission of the one-click POST: `contentType` is the request's Content-Type header (undefined when absent), `body` its bytes. */
export function admitOneClickOptOut(contentType: string | undefined, body: Uint8Array | null): OneClickAdmission {
  if (contentType === undefined) return UNSUPPORTED;
  const type = parseContentType(contentType);
  if (type === null) return UNSUPPORTED;
  if (type.media !== "application/x-www-form-urlencoded" && type.media !== "multipart/form-data") return UNSUPPORTED;
  if (body === null || body.byteLength === 0 || body.byteLength > OPT_OUT_BODY_LIMIT_BYTES) return VIOLATION;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return VIOLATION;
  }
  if (type.media === "application/x-www-form-urlencoded") {
    for (const [name, value] of type.params) {
      if (name !== "charset" || value.toLowerCase() !== "utf-8") return UNSUPPORTED;
    }
    return text === FORM_BODY ? ADMITTED : VIOLATION;
  }
  return admitMultipart(type.params, text);
}
