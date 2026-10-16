// Shared by the case-map checkers (B03, B04): the test titles a source file declares with it(...) or test(...), as matchers.
// A cited title must be one the file declares character for character; a template title matches its expansion (see declaredTitles).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';


/** Index just past the string literal that opens at `at` (quote at `at`), template placeholders included. */
export function skipString(src, at) {
  const quote = src[at];
  let i = at + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === quote) return i + 1;
    if (quote === '`' && c === '$' && src[i + 1] === '{') { i = skipExpression(src, i + 2); continue; }
    i += 1;
  }
  return src.length;
}

/** Index just past the `}` that closes a template placeholder whose expression starts at `at`. */
export function skipExpression(src, at) {
  let depth = 1;
  let i = at;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return src.length;
}

/** The escapes a title literal may carry, resolved the way the runtime resolves them. */
export function unescape(raw) {
  return raw.replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\s\S]))/g, (all, braced, four, two, other) => {
    if (braced !== undefined) return String.fromCodePoint(Number.parseInt(braced, 16));
    if (four !== undefined) return String.fromCharCode(Number.parseInt(four, 16));
    if (two !== undefined) return String.fromCharCode(Number.parseInt(two, 16));
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }[other] ?? other;
  });
}

/** The literal that opens at `at`: its fixed text segments, split where a template placeholder stands; null when it is not closed on its line. */
export function readLiteral(src, at) {
  const quote = src[at];
  const parts = [];
  let current = '';
  let i = at + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { current += src.slice(i, i + 2); i += 2; continue; }
    if (c === quote) {
      parts.push(current);
      return { template: quote === '`', parts: parts.map(unescape) };
    }
    if (quote === '`' && c === '$' && src[i + 1] === '{') {
      parts.push(current);
      current = '';
      i = skipExpression(src, i + 2);
      continue;
    }
    if (quote !== '`' && c === '\n') return null;
    current += c;
    i += 1;
  }
  return null;
}

/** Every quoted string literal of a source, unescaped: the values a title template's placeholders can stand for. */
export function stringLiterals(src) {
  // One line at a time, so a quote inside a comment can only pair with another on its own line.
  return src.split(/\r?\n/).flatMap((line) => [...line.matchAll(/'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\$])*)`/g)].map((m) => unescape(m[1] ?? m[2] ?? m[3] ?? '')));
}

/**
 * Every test title a source file declares with it(...) or test(...), as matchers. A template title matches an expansion whose fixed
 * text is its own character for character and whose every placeholder stands for a string literal the file or its support modules
 * declare (or several of them joined by ' + '), so a loop over vectors, modes or receipts is cited by the titles it really runs.
 */
export function declaredTitles(src, literals) {
  const titles = [];
  const opener = /\b(?:it|test)\s*\(\s*/g;
  for (let m = opener.exec(src); m !== null; m = opener.exec(src)) {
    const at = opener.lastIndex;
    if (!['"', "'", '`'].includes(src[at])) continue;
    const literal = readLiteral(src, at);
    if (literal === null) continue;
    if (!literal.template || literal.parts.length === 1) {
      const text = literal.parts.join('');
      titles.push({ source: text, matches: (title) => title === text });
      continue;
    }
    const fixed = literal.parts.join('').replace(/\s/g, '').length;
    // A template that is almost all placeholder would match anything: it is not an exact title to cite.
    if (fixed < 5) continue;
    const pattern = new RegExp(`^${literal.parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('([\\s\\S]+?)')}$`, 'u');
    const declared = (value) => literals.has(value) || value.split(' + ').every((piece) => literals.has(piece));
    titles.push({ source: literal.parts.join('${…}'), matches: (title) => { const m = pattern.exec(title); return m !== null && m.slice(1).every(declared); } });
  }
  return titles;
}


const titleCache = new Map();
/** The support modules beside a test file (a `support` directory next to it), whose literals a title template may draw on. */
const supportLiterals = (path) => {
  const dir = join(path, '..', 'support');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /\.(?:ts|mts|js|mjs)$/.test(name)).flatMap((name) => stringLiterals(readFileSync(join(dir, name), 'utf8')));
};
export const titlesIn = (path) => {
  if (!titleCache.has(path)) {
    const src = readFileSync(path, 'utf8');
    titleCache.set(path, declaredTitles(src, new Set([...stringLiterals(src), ...supportLiterals(path)])));
  }
  return titleCache.get(path);
};
