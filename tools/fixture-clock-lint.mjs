// Fixture instants checked against the database clock must use serverNow with a margin.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guardedField = /^(?:provider)?(?:issued|completed|occurred)/i;

function isProcessClock(node) {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && ((node.expression.expression.text === "clock" && node.expression.name.text === "now")
      || (node.expression.expression.text === "Date" && node.expression.name.text === "now"));
}

export function lintSource(source, file = "support.ts") {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const failures = [];
  function inspectField(name, value, node) {
    if (!guardedField.test(name)) return;
    function inspect(expression) {
      if (isProcessClock(expression)) {
        const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
        failures.push(`${file}:${line + 1}: ${name} uses the process clock; use serverNow(client) minus one second (explicit test options still win)`);
      }
      ts.forEachChild(expression, inspect);
    }
    inspect(value);
  }
  function visit(node) {
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isComputedPropertyName(node.name) ? node.name.expression : node.name;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) inspectField(name.text, node.initializer, node);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = node.left;
      if (ts.isPropertyAccessExpression(target)) inspectField(target.name.text, node.right, node);
      if (ts.isElementAccessExpression(target) && ts.isStringLiteral(target.argumentExpression)) inspectField(target.argumentExpression.text, node.right, node);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return failures;
}

function* files(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

export function lintFixtures(base = root) {
  const sources = [...files(join(base, "packages/persistence/src/testing"))];
  // the test-only provider fakes stamp external instants the database compares with its own clock (R2-080, adversary 12f5025 ADV-1)
  const packages = join(base, "packages");
  if (existsSync(packages)) {
    for (const pkg of readdirSync(packages)) {
      if (pkg === "persistence") continue;
      sources.push(...[...files(join(packages, pkg, "src"))].filter((file) => /[\/]testing[\/]/.test(file)));
    }
  }
  const apps = join(base, "apps");
  if (existsSync(apps)) {
    for (const app of readdirSync(apps)) {
      sources.push(...[...files(join(apps, app, "test"))].filter((file) => /support[^/\\]*\.ts$/.test(file)));
    }
  }
  return sources.sort().flatMap((file) => lintSource(readFileSync(file, "utf8"), relative(base, file)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = lintFixtures(process.argv[2] ? resolve(process.argv[2]) : root);
  if (failures.length) {
    process.stderr.write(`${failures.join("\n")}\n`);
    process.exitCode = 1;
  } else process.stdout.write("fixture-clock lint passed\n");
}
