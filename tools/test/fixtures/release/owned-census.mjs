// S088 census helper: finds every recursive-delete sink in a source tree, resolving aliases of rmSync/rm/rmdirSync (import renames,
// assignments, destructuring, default parameters and the callers of a function whose parameter defaults to a sink), and classifies
// whether the deleted path is a directory the same file created (mkdtemp) or derives from one. Pure: reads files, writes nothing.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SOURCE = /\.(mjs|cjs|js|ts)$/;

/** Same-length copy of `src` with comments blanked and string/template/regex contents replaced by "_" (newlines kept). */
export function mask(src) {
  const out = src.split("");
  const n = src.length;
  const fill = (a, b, ch) => { for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = ch; };
  function scan(start, stopAtBrace) {
    let i = start, depth = 0, prev = "";
    while (i < n) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") { let j = src.indexOf("\n", i); if (j < 0) j = n; fill(i, j, " "); i = j; continue; }
      if (c === "/" && src[i + 1] === "*") { let j = src.indexOf("*/", i + 2); j = j < 0 ? n : j + 2; fill(i, j, " "); i = j; continue; }
      if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
        fill(i + 1, j, "_"); i = j + 1; prev = "s"; continue;
      }
      if (c === "`") {
        let j = i + 1;
        while (j < n && src[j] !== "`") {
          if (src[j] === "\\") { fill(j, j + 2, "_"); j += 2; continue; }
          if (src[j] === "$" && src[j + 1] === "{") { j = scan(j + 2, true) + 1; continue; }
          fill(j, j + 1, "_"); j++;
        }
        i = j + 1; prev = "s"; continue;
      }
      if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev))) {
        let j = i + 1, cls = false;
        while (j < n && src[j] !== "\n" && (cls || src[j] !== "/")) { if (src[j] === "\\") j++; else if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false; j++; }
        fill(i + 1, j, "_"); i = j + 1; prev = "s"; continue;
      }
      if (c === "{") depth++;
      if (c === "}") { if (stopAtBrace && depth === 0) return i; depth--; }
      if (!/\s/.test(c)) prev = c;
      i++;
    }
    return i;
  }
  scan(0, false);
  return out.join("");
}

function lineOf(text, index) { let l = 1; for (let k = 0; k < index; k++) if (text.charCodeAt(k) === 10) l++; return l; }

/** Arguments (trimmed masked texts) of the call whose "(" is at `open`, and the index after ")". */
function callArgs(m, open) {
  const args = []; let depth = 0, start = open + 1;
  for (let i = open; i < m.length; i++) {
    const c = m[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) { depth--; if (depth === 0) { const last = m.slice(start, i).trim(); if (last !== "" || args.length > 0) args.push(last); return { args, end: i + 1 }; } }
    else if (c === "," && depth === 1) { args.push(m.slice(start, i).trim()); start = i + 1; }
  }
  return { args, end: m.length };
}

function listSources(dir) {
  const found = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) found.push(...listSources(p));
    else if (SOURCE.test(e.name)) found.push(p);
  }
  return found;
}

const FS_SPEC = /^(node:)?fs(\/promises)?$/;
const esc = (s) => s.replace(/[$.*+?^{}()|[\]\\]/g, "\\$&");

function readFile(path, root) {
  const text = readFileSync(path, "utf8");
  return { path, rel: relative(root, path).split("\\").join("/"), text, m: mask(text) };
}

/** Sink names visible in one file: direct callables, fs namespaces, promises namespaces, unresolved dynamic forms. */
function bindingsOf(f) {
  const direct = new Set(), fsNs = new Set(), pNs = new Set(), unresolved = [];
  for (const imp of f.m.matchAll(/import\s+([^;]*?)\s+from\s+(['"])(_*)\2/g)) {
    const specStart = imp.index + imp[0].length - imp[3].length - 1;
    const spec = f.text.slice(specStart, specStart + imp[3].length);
    const fsm = FS_SPEC.exec(spec);
    if (!fsm) continue;
    const promisesModule = Boolean(fsm[2]);
    const clause = imp[1];
    const def = /^([\w$]+)\s*(?:,|$)/.exec(clause); if (def) (promisesModule ? pNs : fsNs).add(def[1]);
    const star = /\*\s+as\s+([\w$]+)/.exec(clause); if (star) (promisesModule ? pNs : fsNs).add(star[1]);
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) for (const part of named[1].split(",")) {
      const bits = part.trim().split(/\s+as\s+/); const name = bits[0]; const loc = (bits[1] ?? bits[0]).trim();
      if (!name) continue;
      if (promisesModule ? /^(rm|rmdir)$/.test(name) : /^(rmSync|rmdirSync|rm|rmdir)$/.test(name)) direct.add(loc);
      if (!promisesModule && name === "promises") pNs.add(loc);
    }
  }
  for (const dyn of f.m.matchAll(/\b(?:import|require)\s*\(\s*(['"])(_*)\1/g)) {
    const specStart = dyn.index + dyn[0].length - dyn[2].length - 1;
    if (!FS_SPEC.test(f.text.slice(specStart, specStart + dyn[2].length))) continue;
    // `(await import("node:fs")).readFileSync(...)`: a named non-sink member is followed exactly; any other use is unresolved.
    const member = /^\s*\)\s*\)\s*\.\s*([\w$]+)/.exec(f.m.slice(dyn.index + dyn[0].length));
    if (member && !/^(rmSync|rmdirSync|rm|rmdir|promises)$/.test(member[1])) continue;
    unresolved.push(`${f.rel}:${lineOf(f.text, dyn.index)} dynamic fs import`);
  }
  return { direct, fsNs, pNs, unresolved };
}

function sinkExprSource(direct, fsNs, pNs) {
  const alts = [];
  const or = (set) => `(?:${[...set].map(esc).join("|")})`;
  if (direct.size) alts.push(or(direct));
  if (fsNs.size) alts.push(`${or(fsNs)}\\s*\\.\\s*(?:rmSync|rmdirSync|rm|rmdir)`, `${or(fsNs)}\\s*\\.\\s*promises\\s*\\.\\s*(?:rm|rmdir)`);
  if (pNs.size) alts.push(`${or(pNs)}\\s*\\.\\s*(?:rm|rmdir)`);
  return alts.length ? `(?:${alts.join("|")})` : null;
}

/** The function whose parameter list contains `pos`: { fn, index } or null. */
function paramContext(m, pos) {
  let depth = 0, i = pos;
  for (; i >= 0; i--) { const c = m[i]; if (")]}".includes(c)) depth++; else if ("([{".includes(c)) { if (depth === 0) break; depth--; } }
  if (i < 0 || m[i] !== "(") return null;
  let index = 0; depth = 0;
  for (let k = i + 1; k < pos; k++) { const c = m[k]; if ("([{".includes(c)) depth++; else if (")]}".includes(c)) depth--; else if (c === "," && depth === 0) index++; }
  const before = m.slice(Math.max(0, i - 120), i);
  const g = /function\s*\*?\s*([\w$]+)\s*$/.exec(before) || /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?$/.exec(before);
  if (g) return { fn: g[1], index };
  const meth = /([\w$]+)\s*$/.exec(before);
  const end = callArgs(m, i).end;
  if (meth && /^\s*\{/.test(m.slice(end, end + 6))) return { fn: meth[1], index };
  return null;
}

function bodyOf(m, from) {
  const open = m.indexOf("{", from); if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < m.length; i++) { if (m[i] === "{") depth++; else if (m[i] === "}" && --depth === 0) return m.slice(open, i + 1); }
  return m.slice(open);
}

/** Names of functions (any file) whose body creates a directory with mkdtemp(Sync), directly or through another creator. */
function creatorsOf(files) {
  const defs = [];
  for (const f of files) {
    for (const d of f.m.matchAll(/(?:function\s*\*?\s*([\w$]+)\s*\(|(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function\s*)?\()/g)) {
      const name = d[1] || d[2];
      const end = callArgs(f.m, d.index + d[0].length - 1).end;
      const after = f.m.slice(end, end + 12);
      const eol = f.m.indexOf("\n", end);
      const body = /^\s*(?:=>\s*)?\{/.test(after) ? bodyOf(f.m, end) : f.m.slice(end, eol < 0 ? undefined : eol);
      defs.push({ name, body });
    }
  }
  const creators = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const d of defs) {
      if (creators.has(d.name)) continue;
      if (/\bmkdtemp(?:Sync)?\s*\(/.test(d.body) || [...creators].some((c) => new RegExp(`\\b${esc(c)}\\s*\\(`).test(d.body))) { creators.add(d.name); changed = true; }
    }
  }
  return creators;
}

function ownedExpr(expr, facts, loopVars = new Set()) {
  const e = expr.trim();
  if (/^[\w$]+$/.test(e)) return facts.owned.has(e) || loopVars.has(e);
  const prop = /^([\w$]+)\.(parent|root|dir)$/.exec(e);
  if (prop) return facts.fixtures.has(prop[1]);
  if (/^(?:await\s+)?mkdtemp(?:Sync)?\s*\(/.test(e)) return true;
  const concat = /^([\w$]+)\s*\+\s*['"_`]/.exec(e);
  if (concat) return facts.owned.has(concat[1]);
  const call = /^(join|resolve|dirname|normalize|realpathSync)\s*\(/.exec(e);
  if (call) { const a = callArgs(e, call[0].length - 1).args; return a.length > 0 && ownedExpr(a[0], facts, loopVars); }
  return false;
}

/** Ownership facts of one file: identifiers holding a directory this file created, fixtures made by a creator, owned arrays. */
function ownershipOf(f, creators) {
  const facts = { owned: new Set(), fixtures: new Set(), arrays: new Set() };
  const declarations = [];
  for (const a of f.m.matchAll(/\b(?:const|let|var)\s+(\{[^}]*\}|\[[^\]]*\]|[\w$]+)\s*=\s*/g)) {
    let i = a.index + a[0].length, depth = 0, rhs = "";
    for (; i < f.m.length; i++) {
      const c = f.m[i];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) { if (depth === 0) break; depth--; }
      else if ((c === ";" || c === "\n") && depth === 0) break;
      rhs += c;
    }
    declarations.push({ lhs: a[1], rhs: rhs.trim().replace(/^await\s+/, "") });
  }
  for (let pass = 0; pass < 6; pass++) {
    for (const { lhs, rhs } of declarations) {
      const pattern = /^[{[]/.test(lhs);
      const names = pattern ? lhs.slice(1, -1).split(",").map((s) => s.trim().split(/[:\s]/).pop()).filter(Boolean) : [lhs];
      const call = /^([\w$.]+)\s*\(/.exec(rhs);
      if (call && /^mkdtemp(?:Sync)?$/.test(call[1].split(".").pop())) names.forEach((x) => facts.owned.add(x));
      else if (call && creators.has(call[1])) names.forEach((x) => { facts.owned.add(x); if (!pattern) facts.fixtures.add(x); });
      else if (!pattern && ownedExpr(rhs, facts)) facts.owned.add(lhs);
      else if (rhs === "[]" && !pattern) facts.arrays.add(lhs);
      else if (rhs.startsWith("[") && !pattern) {
        const items = callArgs(`(${rhs.slice(1, -1)})`, 0).args;
        if (items.length && items.every((x) => ownedExpr(x, facts))) facts.arrays.add(`${lhs}#owned`);
      }
    }
    for (const p of f.m.matchAll(/\b([\w$]+)\.push\(([^)]*)\)/g)) if (facts.arrays.has(p[1]) && ownedExpr(p[2], facts)) facts.arrays.add(`${p[1]}#owned`);
  }
  return facts;
}

/**
 * The census of a source tree. Each site: { file, line, via: "literal" | "alias-param", path, text, owned }.
 * `stubs`: callers of an alias-parameter function that pass their own remover. `unresolved`: alias forms the scanner cannot follow.
 */
export function census(root) {
  const files = listSources(root).map((p) => readFile(p, root));
  const creators = creatorsOf(files);
  const sites = [], stubs = [], aliasBindings = [], unresolved = [];
  const aliasFns = new Map();
  const perFile = new Map();
  for (const f of files) {
    const b = bindingsOf(f); unresolved.push(...b.unresolved);
    const valueAliases = new Set(b.direct);
    for (let changed = true; changed;) {
      changed = false;
      const src = sinkExprSource(valueAliases, b.fsNs, b.pNs);
      if (!src) break;
      for (const a of f.m.matchAll(new RegExp(`(?<![\\w$.])([\\w$]+)\\s*=\\s*(?:await\\s+)?(${src})(?![\\w$.(])`, "g"))) {
        const ctx = paramContext(f.m, a.index);
        if (ctx) {
          if (!aliasFns.has(ctx.fn)) {
            aliasFns.set(ctx.fn, { fn: ctx.fn, index: ctx.index });
            aliasBindings.push({ file: f.rel, line: lineOf(f.text, a.index), name: a[1], fn: ctx.fn });
          }
        } else if (!valueAliases.has(a[1])) {
          valueAliases.add(a[1]); changed = true;
          aliasBindings.push({ file: f.rel, line: lineOf(f.text, a.index), name: a[1], fn: null });
        }
      }
      for (const d of f.m.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?([\w$]+)/g)) {
        if (!b.fsNs.has(d[2]) && !b.pNs.has(d[2])) continue;
        for (const part of d[1].split(",")) {
          const [k, v = k] = part.split(":").map((s) => s.trim());
          if (/^(rmSync|rmdirSync|rm|rmdir)$/.test(k) && !valueAliases.has(v)) { valueAliases.add(v); changed = true; aliasBindings.push({ file: f.rel, line: lineOf(f.text, d.index), name: v, fn: null }); }
        }
      }
    }
    perFile.set(f.rel, { b, valueAliases });
  }
  for (const f of files) {
    const { b, valueAliases } = perFile.get(f.rel);
    const facts = ownershipOf(f, creators);
    const src = sinkExprSource(valueAliases, b.fsNs, b.pNs);
    const lines = f.text.split("\n");
    const loopVars = new Set();
    for (const l of f.m.matchAll(/for\s*\(\s*(?:const|let|var)\s+([\w$]+)\s+of\s+([^)]*)\)/g)) {
      const iter = l[2].trim();
      const items = iter.startsWith("[") ? callArgs(`(${iter.slice(1, -1)})`, 0).args : null;
      if ((items && items.length && items.every((x) => ownedExpr(x, facts))) || facts.arrays.has(`${iter}#owned`)) loopVars.add(l[1]);
    }
    const record = (kind, index, path, extra = {}) => {
      const line = lineOf(f.text, index);
      sites.push({ file: f.rel, line, via: kind, path, text: lines[line - 1].trim(), owned: ownedExpr(path, facts, loopVars), ...extra });
    };
    if (src) {
      for (const c of f.m.matchAll(new RegExp(`(?<![\\w$.])(${src})\\s*\\(`, "g"))) {
        if (/function\s*\*?\s*$/.test(f.m.slice(Math.max(0, c.index - 20), c.index))) continue;
        const { args } = callArgs(f.m, c.index + c[0].length - 1);
        const options = args[1];
        const recursive = args.some((a) => /\brecursive\b/.test(a)) || (options !== undefined && !options.startsWith("{"));
        if (recursive) record("literal", c.index, args[0] ?? "");
      }
    }
    for (const [fn, info] of aliasFns) {
      for (const c of f.m.matchAll(new RegExp(`(?<![\\w$.])${esc(fn)}\\s*\\(`, "g"))) {
        if (/function\s*\*?\s*$/.test(f.m.slice(Math.max(0, c.index - 20), c.index))) continue;
        const { args } = callArgs(f.m, c.index + c[0].length - 1);
        const given = args[info.index];
        if (given === undefined || (src && new RegExp(`^${src}$`).test(given))) record("alias-param", c.index, args[0] ?? "", { fn });
        else stubs.push({ file: f.rel, line: lineOf(f.text, c.index), fn });
      }
    }
  }
  sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { sites, stubs, aliasBindings, unresolved, files: files.map((f) => f.rel) };
}
