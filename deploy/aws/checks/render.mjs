// Renders the policy templates of deploy/aws/policies and the worker contracts of deploy/aws/worker exactly as Terraform's
// templatefile() does for them (deploy/aws/terraform/modules/policy-template): every ${NAME} is bound or the render fails, "$comment"
// members are dropped, and the statements of several templates are concatenated in order. The offline evaluator and the static
// checks read the documents through this, so they judge the same text Terraform would send.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const AWS_DIR = join(import.meta.dirname, "..");
export const POLICIES_DIR = join(AWS_DIR, "policies");
export const WORKER_DIR = join(AWS_DIR, "worker");

const PLACEHOLDER = /\$\{([A-Za-z0-9_]+)\}/g;

/** The placeholder names a template uses. */
export function placeholdersOf(text) {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))].sort();
}

/** One template's text with every placeholder bound; an unbound one throws, as templatefile() does. */
export function bind(text, vars, label = "template") {
  if (/%\{/.test(text)) throw new Error(`${label}: template directives (%{) are not used by these documents`);
  return text.replace(PLACEHOLDER, (_, name) => {
    if (!Object.hasOwn(vars, name)) throw new Error(`${label}: unbound placeholder \${${name}}`);
    return vars[name];
  });
}

function withoutComments(value) {
  if (Array.isArray(value)) return value.map(withoutComments);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$comment").map(([key, v]) => [key, withoutComments(v)]));
  }
  return value;
}

/** A rendered document (object) from one or more template paths relative to deploy/aws. */
export function renderPolicy(paths, vars) {
  const list = Array.isArray(paths) ? paths : [paths];
  const statements = [];
  for (const path of list) {
    const doc = withoutComments(JSON.parse(bind(readFileSync(join(AWS_DIR, path), "utf8"), vars, path)));
    statements.push(...doc.Statement);
  }
  const sids = statements.map((s) => s.Sid);
  if (new Set(sids).size !== sids.length) throw new Error(`${list.join(" + ")}: duplicate Sid`);
  return { Version: "2012-10-17", Statement: statements };
}

/** Rendered JSON, minified as Terraform's jsonencode() writes it (the size SCP and RCP limits count). */
export function minified(doc) {
  return JSON.stringify(doc);
}

/** A rendered non-policy contract (the task definition), comments dropped. */
export function renderContract(path, vars) {
  return withoutComments(JSON.parse(bind(readFileSync(join(AWS_DIR, path), "utf8"), vars, path)));
}
