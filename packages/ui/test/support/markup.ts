// A small reader of the markup react-dom/server writes (renderToStaticMarkup), so the primitives' tests can assert elements,
// ARIA names and associations without a DOM library (B11 W1). It reads exactly the dialect React writes — double-quoted
// attributes, the five character references React escapes, the HTML void elements — and refuses anything else, so a change in
// what React emits fails loudly instead of being read wrongly.
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

export interface ElementNode {
  readonly kind: "element";
  readonly tag: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly children: Node[];
  readonly parent: ElementNode | null;
}
export interface TextNode {
  readonly kind: "text";
  readonly text: string;
}
export type Node = ElementNode | TextNode;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const ENTITIES: Readonly<Record<string, string>> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };

const decode = (text: string): string =>
  text.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (m) => ENTITIES[m] as string);

const TOKEN = /<!--[\s\S]*?-->|<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/"]+(?:="[^"]*")?)*)\s*(\/?)>/gy;
const ATTRIBUTE = /\s+([^\s=>/"]+)(?:="([^"]*)")?/gy;

/** Parses static markup into a tree under a synthetic `#root` element. */
export function parseMarkup(html: string): ElementNode {
  const root: ElementNode = { kind: "element", tag: "#root", attrs: new Map(), children: [], parent: null };
  let current = root;
  let position = 0;
  while (position < html.length) {
    const next = html.indexOf("<", position);
    const end = next === -1 ? html.length : next;
    if (end > position) current.children.push({ kind: "text", text: decode(html.slice(position, end)) });
    if (next === -1) break;
    TOKEN.lastIndex = next;
    const m = TOKEN.exec(html);
    if (m === null) throw new Error(`unreadable markup at ${next}: ${html.slice(next, next + 60)}`);
    position = TOKEN.lastIndex;
    if (m[0].startsWith("<!--")) continue;
    if (m[1] !== undefined) {
      if (current.tag !== m[1]) throw new Error(`</${m[1]}> closes <${current.tag}>`);
      current = current.parent as ElementNode;
      continue;
    }
    const attrs = new Map<string, string>();
    ATTRIBUTE.lastIndex = 0;
    const source = m[3] ?? "";
    for (let a = ATTRIBUTE.exec(source); a !== null; a = ATTRIBUTE.exec(source)) {
      if (attrs.has(a[1] as string)) throw new Error(`attribute ${a[1]} repeated on <${m[2]}>`);
      attrs.set(a[1] as string, decode(a[2] ?? ""));
    }
    const element: ElementNode = { kind: "element", tag: m[2] as string, attrs, children: [], parent: current };
    current.children.push(element);
    if (m[4] !== "/" && !VOID.has(element.tag)) current = element;
  }
  if (current !== root) throw new Error(`<${current.tag}> is never closed`);
  return root;
}

/** Renders a React element to static markup and parses it. */
export function render(element: ReactElement): { readonly html: string; readonly root: ElementNode } {
  const html = renderToStaticMarkup(element);
  return { html, root: parseMarkup(html) };
}

export function* elementsOf(node: ElementNode): Generator<ElementNode> {
  for (const child of node.children) {
    if (child.kind === "element") {
      yield child;
      yield* elementsOf(child);
    }
  }
}

export const findAll = (root: ElementNode, tag: string): ElementNode[] => [...elementsOf(root)].filter((e) => e.tag === tag);

export function findOne(root: ElementNode, tag: string, describe = tag): ElementNode {
  const found = findAll(root, tag);
  if (found.length !== 1) throw new Error(`expected exactly one ${describe}, found ${found.length}`);
  return found[0] as ElementNode;
}

export const byClass = (root: ElementNode, className: string): ElementNode[] =>
  [...elementsOf(root)].filter((e) => (e.attrs.get("class") ?? "").split(/\s+/).includes(className));

export function byId(root: ElementNode, id: string): ElementNode {
  const found = [...elementsOf(root)].filter((e) => e.attrs.get("id") === id);
  if (found.length !== 1) throw new Error(`expected exactly one element with id ${id}, found ${found.length}`);
  return found[0] as ElementNode;
}

export const idsOf = (root: ElementNode): string[] => [...elementsOf(root)].flatMap((e) => (e.attrs.has("id") ? [e.attrs.get("id") as string] : []));

/** The text of a node and everything under it, with no whitespace normalisation. */
export function textOf(node: Node): string {
  if (node.kind === "text") return node.text;
  return node.children.map(textOf).join("");
}

/** The ids an attribute such as aria-describedby, aria-labelledby or for lists. */
export const tokensOf = (element: ElementNode, name: string): string[] => (element.attrs.get(name) ?? "").split(/\s+/).filter((t) => t !== "");

export function ancestors(element: ElementNode): ElementNode[] {
  const out: ElementNode[] = [];
  for (let p = element.parent; p !== null && p.tag !== "#root"; p = p.parent) out.push(p);
  return out;
}

export const isInside = (element: ElementNode, container: ElementNode): boolean => ancestors(element).includes(container);

/**
 * The accessible name of a form control as the tests need it: aria-labelledby, aria-label, a <label for> or a wrapping <label>.
 */
export function accessibleName(root: ElementNode, control: ElementNode): string {
  const labelledBy = tokensOf(control, "aria-labelledby");
  if (labelledBy.length > 0) return labelledBy.map((id) => textOf(byId(root, id))).join(" ").trim();
  const aria = control.attrs.get("aria-label");
  if (aria !== undefined) return aria;
  const id = control.attrs.get("id");
  if (id !== undefined) {
    const labels = findAll(root, "label").filter((l) => l.attrs.get("for") === id);
    if (labels.length > 0) return labels.map((l) => textOf(l)).join(" ").replace(/\s+/g, " ").trim();
  }
  const wrapping = ancestors(control).find((a) => a.tag === "label");
  if (wrapping !== undefined) return textOf(wrapping).replace(/\s+/g, " ").trim();
  return "";
}

/** Every bidirectional embedding, override and isolate control (the ones that can reorder text around them). */
export const BIDI_CONTROLS = /[\u{202A}-\u{202E}\u{2066}-\u{2069}]/u;
