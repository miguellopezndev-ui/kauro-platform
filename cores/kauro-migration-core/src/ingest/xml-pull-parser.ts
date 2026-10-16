import { MigrationError } from '../domain/errors.js';

/**
 * A strict, deliberately small XML pull parser for the OOXML subset that
 * spreadsheets use.
 *
 * Written here rather than taken from a package for three reasons that matter
 * to this engine: it refuses document type declarations outright, so entity
 * expansion attacks have nowhere to land; it never resolves anything external;
 * and it yields events rather than a tree, so a large worksheet does not have
 * to be materialised twice.
 */

export interface XmlStartElement {
  readonly kind: 'start';
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly selfClosing: boolean;
}

export interface XmlEndElement {
  readonly kind: 'end';
  readonly name: string;
}

export interface XmlText {
  readonly kind: 'text';
  readonly text: string;
}

export type XmlEvent = XmlStartElement | XmlEndElement | XmlText;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** `<![CDATA[`, the longest prefix this parser has to recognise before it can act on a `<`. */
const LONGEST_PREFIX = 9;

/** Strips a namespace prefix. The engine matches on local names only. */
export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * The whole document at once, for a part small enough that holding it is not a
 * decision -- the workbook, its relationships, its styles.
 *
 * A thin call on `parseXmlChunks`, deliberately. A second parser would be a
 * second answer to what this XML subset means, and the worksheet reader -- the
 * one that cannot hold its part -- would eventually disagree with the callers
 * that can.
 */
export function parseXml(text: string, origin: string): Generator<XmlEvent, void, undefined> {
  return parseXmlChunks([text], origin);
}

/**
 * The same parser, over a document that arrives in pieces.
 *
 * A worksheet part is the largest thing this engine reads, and decoding one to a
 * single string cost a copy of the sheet before a row had been looked at -- on
 * top of the inflated bytes it was decoded from, and on top of the container
 * they came out of. The pull parser was already a generator, so it never built a
 * tree; what it could not avoid was being handed the whole document first.
 *
 * What it holds instead is one block, plus whatever token that block ends part
 * way through. Two properties are what make that safe rather than merely
 * smaller:
 *
 *   A text run is emitted only once the `<` that ends it has arrived. Splitting
 *   one at a block boundary would hand `decodeEntities` "&am" and then "p;", and
 *   an entity decoded as two broken halves is a value the file never held.
 *
 *   Character offsets stay absolute. `base` counts what has been dropped, so a
 *   refusal names the same character it named when the document was one string.
 */
export function* parseXmlChunks(
  chunks: Iterable<string>,
  origin: string,
): Generator<XmlEvent, void, undefined> {
  // The stack is what makes this fail-closed. Without it a truncated worksheet
  // reads as a shorter but well-formed one, and rows disappear with no error.
  const openElements: string[] = [];
  // A document has one root. Text and elements after the root used to be
  // accepted, because the stack was balanced by then.
  let rootsSeen = 0;

  // What has arrived and has not been consumed, and how much was dropped before
  // it. `index` is the cursor inside `text`; `base + index` is the cursor in the
  // document, which is the only number a refusal is allowed to quote.
  let text = '';
  let base = 0;
  let index = 0;
  // No further block is coming, so an unfinished construct is a damaged file
  // rather than one that has not finished arriving.
  let ended = false;
  const source = chunks[Symbol.iterator]();

  for (;;) {
    // `waiting` says the loop stopped because it could not yet decide, not
    // because it ran out of document. That difference is the whole of the
    // incremental part: every "never closed" refusal below is reached only when
    // `ended` says no further block can close it.
    let waiting = false;

    while (!waiting && index < text.length) {
      const open = text.indexOf('<', index);
      if (open === -1) {
        if (!ended) {
          waiting = true;
          break;
        }
        const trailing = text.slice(index);
        if (trailing.trim().length > 0) {
          yield { kind: 'text', text: decodeEntities(trailing, origin) };
        }
        // Leave through the loop, not around it, so the balance check below still runs.
        index = text.length;
        break;
      }

      if (open > index) {
        yield { kind: 'text', text: decodeEntities(text.slice(index, open), origin) };
        index = open;
      }

      // Fewer characters after the `<` than the longest prefix is not a tag this
      // parser fails to understand; it is a tag it has not finished receiving.
      if (text.length - open < LONGEST_PREFIX && !ended) {
        waiting = true;
        break;
      }

      if (text.startsWith('<!--', open)) {
        const close = text.indexOf('-->', open + 4);
        if (close === -1) {
          if (!ended) {
            waiting = true;
            break;
          }
          throw corrupt(origin, 'an XML comment is never closed', base + open);
        }
        index = close + 3;
        continue;
      }

      if (text.startsWith('<![CDATA[', open)) {
        const close = text.indexOf(']]>', open + 9);
        if (close === -1) {
          if (!ended) {
            waiting = true;
            break;
          }
          throw corrupt(origin, 'a CDATA section is never closed', base + open);
        }
        yield { kind: 'text', text: text.slice(open + 9, close) };
        index = close + 3;
        continue;
      }

      if (text.startsWith('<!DOCTYPE', open) || text.startsWith('<!ENTITY', open)) {
        throw new MigrationError(
          'INPUT_UNSUPPORTED',
          `${origin} contains a document type or entity declaration`,
          'This engine refuses XML that declares entities, because expanding them is an attack surface. Re-export the workbook from the source application.',
          { origin, characterOffset: base + open },
        );
      }

      if (text.startsWith('<?', open)) {
        const close = text.indexOf('?>', open + 2);
        if (close === -1) {
          if (!ended) {
            waiting = true;
            break;
          }
          throw corrupt(origin, 'a processing instruction is never closed', base + open);
        }
        index = close + 2;
        continue;
      }

      const close = findTagEnd(text, open, origin, base, ended);
      if (close === -1) {
        waiting = true;
        break;
      }
      const inner = text.slice(open + 1, close);

      if (inner.startsWith('/')) {
        const name = inner.slice(1).trim();
        const expected = openElements.pop();
        if (expected === undefined) {
          throw corrupt(origin, `the closing tag </${name}> has no matching opening tag`, base + open);
        }
        if (expected !== name) {
          throw corrupt(origin, `<${expected}> is closed by </${name}>`, base + open);
        }
        yield { kind: 'end', name };
        index = close + 1;
        continue;
      }

      const selfClosing = inner.endsWith('/');
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const start = parseStartTag(body, selfClosing, origin, base + open);
      if (openElements.length === 0) rootsSeen += 1;
      if (!selfClosing) openElements.push(start.name);
      yield start;
      index = close + 1;
    }

    if (ended) break;

    // Everything consumed is released before the next block is taken, which is
    // what keeps the buffer the size of a block rather than the size of a sheet.
    if (index > 0) {
      text = text.slice(index);
      base += index;
      index = 0;
    }
    const next = source.next();
    if (next.done === true) ended = true;
    else text += next.value;
  }

  if (rootsSeen > 1) {
    throw new MigrationError(
      'INPUT_CORRUPT',
      `${origin} has ${String(rootsSeen)} top-level elements; an XML document has one`,
      'The archive member is not a well-formed XML document. Re-export the workbook from the source application.',
      { origin, rootsSeen },
    );
  }
  if (openElements.length > 0) {
    throw corrupt(
      origin,
      `the document ends with ${String(openElements.length)} element(s) still open, the innermost being <${String(openElements[openElements.length - 1])}>`,
      base + text.length,
    );
  }
}

/**
 * Finds the `>` that closes a tag, ignoring any inside quoted attribute values.
 *
 * Returns -1 when the tag runs past everything that has arrived and more is
 * still coming, because a tag that has not finished being delivered is not a
 * tag that is never closed.
 */
function findTagEnd(text: string, open: number, origin: string, base: number, ended: boolean): number {
  let quote: string | null = null;
  for (let index = open + 1; index < text.length; index += 1) {
    const character = text[index] as string;
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return index;
  }
  if (!ended) return -1;
  throw corrupt(origin, 'a tag is never closed', base + open);
}

function parseStartTag(
  body: string,
  selfClosing: boolean,
  origin: string,
  offset: number,
): XmlStartElement {
  let index = 0;
  while (index < body.length && !isSpace(body[index] as string)) index += 1;
  const name = body.slice(0, index);
  if (name.length === 0) throw corrupt(origin, 'a tag has no element name', offset);

  const attributes: Record<string, string> = {};
  while (index < body.length) {
    while (index < body.length && isSpace(body[index] as string)) index += 1;
    if (index >= body.length) break;

    const nameStart = index;
    while (index < body.length && body[index] !== '=' && !isSpace(body[index] as string)) index += 1;
    const attributeName = body.slice(nameStart, index);
    if (attributeName.length === 0) break;

    while (index < body.length && isSpace(body[index] as string)) index += 1;
    if (body[index] !== '=') {
      throw corrupt(origin, `attribute "${attributeName}" has no value`, offset);
    }
    index += 1;
    while (index < body.length && isSpace(body[index] as string)) index += 1;

    const quote = body[index];
    if (quote !== '"' && quote !== "'") {
      throw corrupt(origin, `attribute "${attributeName}" is not quoted`, offset);
    }
    index += 1;
    const valueStart = index;
    while (index < body.length && body[index] !== quote) index += 1;
    if (index >= body.length) {
      throw corrupt(origin, `attribute "${attributeName}" is never closed`, offset);
    }
    if (Object.prototype.hasOwnProperty.call(attributes, attributeName)) {
      throw corrupt(origin, `attribute "${attributeName}" appears twice on the same element`, offset);
    }
    attributes[attributeName] = decodeEntities(body.slice(valueStart, index), origin);
    index += 1;
  }

  return { kind: 'start', name, attributes, selfClosing };
}

function isSpace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

/**
 * Decodes the five predefined entities and numeric character references.
 * Anything else is rejected: a workbook that references a custom entity is a
 * workbook whose meaning depends on a declaration this parser refuses to read.
 */
export function decodeEntities(text: string, origin: string): string {
  if (!text.includes('&')) return text;

  let out = '';
  let index = 0;
  while (index < text.length) {
    const ampersand = text.indexOf('&', index);
    if (ampersand === -1) {
      out += text.slice(index);
      break;
    }
    out += text.slice(index, ampersand);
    const semicolon = text.indexOf(';', ampersand);
    if (semicolon === -1 || semicolon - ampersand > 12) {
      throw corrupt(origin, 'an "&" is not part of a well-formed entity reference', ampersand);
    }
    const entity = text.slice(ampersand + 1, semicolon);
    out += resolveEntity(entity, origin, ampersand);
    index = semicolon + 1;
  }
  return out;
}

function resolveEntity(entity: string, origin: string, offset: number): string {
  const named = NAMED_ENTITIES[entity];
  if (named !== undefined) return named;

  if (entity.startsWith('#')) {
    const isHex = entity[1] === 'x' || entity[1] === 'X';
    const digits = isHex ? entity.slice(2) : entity.slice(1);
    const pattern = isHex ? /^[0-9a-fA-F]{1,6}$/u : /^[0-9]{1,7}$/u;
    if (!pattern.test(digits)) {
      throw corrupt(origin, `"&${entity};" is not a valid character reference`, offset);
    }
    const codePoint = Number.parseInt(digits, isHex ? 16 : 10);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      throw corrupt(origin, `"&${entity};" is not a valid Unicode code point`, offset);
    }
    return String.fromCodePoint(codePoint);
  }

  throw new MigrationError(
    'INPUT_UNSUPPORTED',
    `${origin} references the entity "&${entity};", which this engine does not resolve`,
    'Only the five predefined XML entities and numeric character references are accepted. Re-export the workbook.',
    { origin, entity, characterOffset: offset },
  );
}

function corrupt(origin: string, what: string, offset: number): MigrationError {
  return new MigrationError(
    'INPUT_CORRUPT',
    `${origin} is not well-formed XML: ${what} (character offset ${String(offset)})`,
    'The file is damaged. Re-export it from the source application.',
    { origin, characterOffset: offset },
  );
}
