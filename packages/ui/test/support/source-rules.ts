// A reader of TypeScript source for the two rules of B11 D-SEC-1 and D-DS-3 (a gate-style test, not a linter): the web surfaces
// style only through the classes of tokens.css, so there is never an inline style; and they render strings only as text nodes, so
// there is never a way to write markup into the page. The source is parsed with the TypeScript compiler, so a comment or a type
// that merely names a forbidden thing is not a violation, and a forbidden thing is found however it is spelled: a JSX attribute,
// a property, a computed key, a spread object or a call.
import ts from "typescript";

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: "inline-style" | "html-injection";
  readonly detail: string;
}

/** Ways to write markup into a page other than as React elements and text. */
const HTML_SINKS = new Set(["dangerouslySetInnerHTML", "innerHTML", "outerHTML", "insertAdjacentHTML", "createContextualFragment"]);

/** The calls whose second argument is the props object of the element they create. */
const ELEMENT_FACTORIES = new Set(["createElement", "cloneElement", "jsx", "jsxs", "jsxDEV"]);

function scriptKindOf(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(?:mjs|cjs|js)$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const nameOf = (node: ts.Node): string | null => {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
};

/** Every violation of the two rules in one source file. */
export function scanSource(fileName: string, text: string): Violation[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));
  const found: Violation[] = [];
  const report = (node: ts.Node, rule: Violation["rule"], detail: string): void => {
    found.push({ file: fileName, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, rule, detail });
  };
  // The object literal a property sits in, when that object is the props of an element: the second argument of createElement or
  // jsx, or the spread of a JSX element.
  const propsOfFactoryCall = (node: ts.Node): ts.ObjectLiteralExpression | null => {
    const literal = node.parent;
    if (!literal || !ts.isObjectLiteralExpression(literal)) return null;
    const call = literal.parent;
    if (call && ts.isJsxSpreadAttribute(call)) return literal;
    if (!call || !ts.isCallExpression(call)) return null;
    const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : ts.isIdentifier(call.expression) ? call.expression.text : "";
    return ELEMENT_FACTORIES.has(callee) && call.arguments[1] === literal ? literal : null;
  };

  const visit = (node: ts.Node): void => {
    // A JSX attribute: style={...}, dangerouslySetInnerHTML={...}.
    if (ts.isJsxAttribute(node)) {
      const name = nameOf(node.name);
      if (name === "style") report(node, "inline-style", "a JSX style attribute");
      if (name !== null && HTML_SINKS.has(name)) report(node, "html-injection", `the attribute ${name}`);
    }
    // A property written out: { style: ... } handed to createElement or jsx, or { dangerouslySetInnerHTML: ... } anywhere.
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const name = nameOf(node.name);
      if (name === "style" && propsOfFactoryCall(node) !== null) report(node, "inline-style", "a style prop given to an element");
      if (name !== null && HTML_SINKS.has(name)) report(node, "html-injection", `the property ${name}`);
    }
    // Reading or writing one: element.style, element.innerHTML, props["dangerouslySetInnerHTML"].
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (name === "style") report(node, "inline-style", "the style property of an element");
      if (name === "cssText") report(node, "inline-style", "cssText");
      if (HTML_SINKS.has(name)) report(node, "html-injection", `the property ${name}`);
    }
    if (ts.isElementAccessExpression(node)) {
      const name = nameOf(node.argumentExpression);
      if (name === "style") report(node, "inline-style", "the style property of an element");
      if (name !== null && HTML_SINKS.has(name)) report(node, "html-injection", `the property ${name}`);
    }
    // A destructured or bare name: const { dangerouslySetInnerHTML } = props.
    if (ts.isBindingElement(node)) {
      const name = nameOf(node.propertyName ?? node.name);
      if (name !== null && HTML_SINKS.has(name)) report(node, "html-injection", `the binding ${name}`);
    }
    // element.setAttribute("style", ...), document.write(...).
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const first = node.arguments[0];
      if (method === "setAttribute" && first !== undefined && nameOf(first)?.toLowerCase() === "style") report(node, "inline-style", 'setAttribute("style")');
      if (method === "write" || method === "writeln") {
        const target = node.expression.expression;
        if (ts.isIdentifier(target) && target.text === "document") report(node, "html-injection", `document.${method}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
