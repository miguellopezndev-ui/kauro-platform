import { MigrationError } from '../domain/errors.js';

// Written this way so no editor or shell can turn them into real line breaks.
const CR = String.fromCharCode(13);
const LF_CHAR = String.fromCharCode(10);
const QUOTE = String.fromCharCode(34);

/**
 * A second, independent count of the rows in a source.
 *
 * The readers in this directory are the only thing that turns bytes into rows,
 * so a count taken from a reader's own output is the reader agreeing with
 * itself. A defect inside `readCsv` or `parseWorksheet` moves both sides of the
 * row equation together and the package reports a smaller migration as a
 * complete one.
 *
 * The two functions here read the same bytes and count separators. They do not
 * decode values, resolve shared strings, apply styles or build any structure,
 * which is what makes them worth having: they are short enough to check by
 * reading them, and they share no code with the reader they check.
 */

/**
 * Records in RFC 4180 text: one per record terminator that is not inside
 * quotes, plus one more if any character followed the last terminator.
 *
 * A blank line is a record — of one empty field — because that is what the
 * reader produces and what `policies.blankRow` exists to dispose of. Counting
 * it as nothing here would make this function disagree with a correct reader,
 * which is the one thing it must never do.
 */
export function countCsvRecords(text: string, delimiter: string): number {
  const census = createCsvCensus();
  census.push(text);
  // `delimiter` is not read: a delimiter is an ordinary character between
  // terminators, and taking it into account here would be this function
  // starting to parse fields, which is the reader's job and not its own.
  void delimiter;
  return census.total();
}

/**
 * The same count, over a file that arrives in pieces.
 *
 * The reader is fed a block at a time, and a census that needed the whole file
 * would put the file back in memory to check that the reader did not have to.
 * So the count carries what it cannot yet decide: a carriage return at the end
 * of a piece, because the line feed that would pair with it has not arrived,
 * and a quote at the end of a piece, because whether it closes the field or is
 * the first half of an escaped quote depends on the next character.
 */
export interface CsvCensus {
  push(text: string): void;
  /** Records counted so far, including one for anything after the last terminator. */
  total(): number;
}

export function createCsvCensus(): CsvCensus {
  let terminators = 0;
  let anythingSinceTerminator = false;
  let inQuotes = false;
  let heldCarriageReturn = false;
  let heldQuote = false;

  return {
    push(text: string): void {
      for (let index = 0; index < text.length; index += 1) {
        const character = text[index];

        if (heldQuote) {
          heldQuote = false;
          if (character === QUOTE) {
            anythingSinceTerminator = true;
            continue;
          }
          inQuotes = false;
          // and on to this character, which is outside the quotes now
        }

        if (heldCarriageReturn) {
          heldCarriageReturn = false;
          if (character === LF_CHAR) continue;
        }

        if (inQuotes) {
          anythingSinceTerminator = true;
          if (character !== QUOTE) continue;
          const next = text[index + 1];
          if (next === undefined) {
            heldQuote = true;
            continue;
          }
          if (next === QUOTE) {
            index += 1;
            continue;
          }
          inQuotes = false;
          continue;
        }

        if (character === QUOTE) {
          inQuotes = true;
          anythingSinceTerminator = true;
          continue;
        }

        if (character === CR || character === LF_CHAR) {
          if (character === CR) {
            const next = text[index + 1];
            if (next === undefined) heldCarriageReturn = true;
            else if (next === LF_CHAR) index += 1;
          }
          terminators += 1;
          anythingSinceTerminator = false;
          continue;
        }

        anythingSinceTerminator = true;
      }
    },

    total(): number {
      return terminators + (anythingSinceTerminator ? 1 : 0);
    },
  };
}
/**
 * `<row>` elements in worksheet XML, counted by scanning for start tags.
 *
 * Comments, CDATA sections, processing instructions and declarations are
 * skipped, because `<row` inside one of them is text rather than an element.
 * Namespace prefixes are allowed: `<x:row>` is a row.
 */
export function countWorksheetRows(xml: string): number {
  const census = createWorksheetRowCensus();
  census.push(xml);
  census.end();
  return census.total();
}

/**
 * The same count, over a worksheet part that arrives in pieces.
 *
 * The reason is the one `CsvCensus` already gives: the reader is fed a block at
 * a time so that a sheet never exists in memory as one string, and a census
 * that needed the whole part would put the sheet back to check that the reader
 * did not have to. It is the same scan, stopped where it cannot yet decide.
 *
 * What it carries between blocks is a `<` it has not been able to classify --
 * `<!` and `<![CDATA[` differ nine characters in -- an element name whose
 * boundary has not arrived, and its position inside a comment, CDATA section,
 * processing instruction or declaration it is still skipping. Inside one of
 * those it holds only the last two characters, so a comment the size of the
 * sheet costs nothing to skip.
 */
export interface WorksheetRowCensus {
  push(text: string): void;
  /** No further block is coming. */
  end(): void;
  /** `<row>` elements counted so far. */
  total(): number;
}

/** `<![CDATA[`, the longest prefix the scan has to recognise before it can act on a `<`. */
const LONGEST_XML_PREFIX = 9;

export function createWorksheetRowCensus(): WorksheetRowCensus {
  let rows = 0;
  let xml = '';
  let index = 0;
  let ended = false;
  // The whole-string scan `break`s out of its loop on an unterminated comment,
  // CDATA section, processing instruction or declaration, and counts nothing
  // after it. `stopped` is that same `break`, kept across blocks, so a part
  // delivered in pieces gives the count the whole part would have given.
  let stopped = false;

  const consume = (): void => {
    while (!stopped && index < xml.length) {
      const open = xml.indexOf('<', index);
      if (open === -1) {
        // Nothing left to count in what has arrived. Whatever is before the end
        // of the block holds no `<`, so none of it can be a row.
        index = xml.length;
        return;
      }
      if (xml.length - open < LONGEST_XML_PREFIX && !ended) {
        index = open;
        return;
      }

      if (xml.startsWith('<!--', open)) {
        const close = xml.indexOf('-->', open + 4);
        if (close === -1) {
          if (!ended) {
            index = open;
            return;
          }
          stopped = true;
          return;
        }
        index = close + 3;
        continue;
      }
      if (xml.startsWith('<![CDATA[', open)) {
        const close = xml.indexOf(']]>', open + 9);
        if (close === -1) {
          if (!ended) {
            index = open;
            return;
          }
          stopped = true;
          return;
        }
        index = close + 3;
        continue;
      }
      if (xml.startsWith('<?', open)) {
        const close = xml.indexOf('?>', open + 2);
        if (close === -1) {
          if (!ended) {
            index = open;
            return;
          }
          stopped = true;
          return;
        }
        index = close + 2;
        continue;
      }
      if (xml.startsWith('<!', open)) {
        const close = xml.indexOf('>', open + 2);
        if (close === -1) {
          if (!ended) {
            index = open;
            return;
          }
          stopped = true;
          return;
        }
        index = close + 1;
        continue;
      }
      if (xml.startsWith('</', open)) {
        index = open + 2;
        continue;
      }

      let cursor = open + 1;
      while (cursor < xml.length && !isNameBoundary(xml[cursor])) cursor += 1;
      // A name that reaches the end of the block may go on into the next one.
      // The end of the part is a boundary; the end of a block is not.
      if (cursor >= xml.length && !ended) {
        index = open;
        return;
      }
      const name = xml.slice(open + 1, cursor);
      const colon = name.lastIndexOf(':');
      if ((colon === -1 ? name : name.slice(colon + 1)) === 'row') rows += 1;
      index = cursor;
    }
  };

  const compact = (): void => {
    if (index === 0) return;
    xml = xml.slice(index);
    index = 0;
  };

  return {
    push(text: string): void {
      if (stopped) return;
      xml = xml.length === 0 ? text : xml + text;
      consume();
      compact();
    },
    end(): void {
      if (ended) return;
      ended = true;
      consume();
      compact();
    },
    total(): number {
      return rows;
    },
  };
}

function isNameBoundary(character: string | undefined): boolean {
  return (
    character === undefined ||
    character === ' ' ||
    character === '\t' ||
    character === '\r' ||
    character === '\n' ||
    character === '>' ||
    character === '/'
  );
}

/**
 * Raised where the reader produced rows, not where they were later filed. A
 * disagreement here means the reader lost or invented rows, which is the one
 * thing the row equation exists to make impossible.
 */
export function assertCensusAgrees(
  produced: number,
  census: number,
  origin: string,
  details: Readonly<Record<string, unknown>>,
): void {
  if (produced === census) return;
  throw new MigrationError(
    'INPUT_CORRUPT',
    `${origin} was read as ${String(produced)} rows, but counting the rows in the file directly gives ${String(census)}`,
    'The file is not laid out the way its format requires, or this reader has a defect. Either way the engine will not write a package it cannot account for. Re-export the file from the source application.',
    { ...details, rowsRead: produced, rowsCounted: census },
  );
}
