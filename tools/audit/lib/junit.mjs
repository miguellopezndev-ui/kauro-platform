// JUnit reading for red proofs (A5, R2 21:49-51: "Harness syntax errors, missing dependencies or unrelated crashes do not count as
// successful sabotage detection"). All product runners are node:test over compiled `dist/test/*.test.js`; the report names the
// compiled file, the audit names the source test. sourceOf maps `<dir>/dist/test/<x>.test.js` -> `<dir>/test/<x>.test.ts` relative to
// the subject repo root (`.mjs` tests and source paths map to themselves). casesOf reads every testcase with its outcome PASSED,
// FAILED, SKIPPED or TODO, the failure `type` (testCodeFailure is a failing assertion; hookFailed, testTimeoutFailure and
// cancelledByParent are harness) and its message; failuresOf keeps the FAILED ones.

function xmlText(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&");
}

function attributesOf(text) {
  const attrs = {};
  for (const a of text.matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = xmlText(a[2]);
  return attrs;
}

/** The source test file of a reported file (absolute or relative, compiled or source), as a repo-relative path with `/`. */
export function sourceOf(file, repoRoot) {
  let p = file.replaceAll("\\", "/");
  if (repoRoot) {
    const root = `${repoRoot.replaceAll("\\", "/").replace(/\/+$/, "")}/`;
    if (p.toLowerCase().startsWith(root.toLowerCase())) p = p.slice(root.length);
  }
  return p.replace(/(^|\/)dist\/test\/(.+)\.test\.js$/, "$1test/$2.test.ts");
}

export function casesOf(xml, { repoRoot } = {}) {
  const cases = [];
  const re = /<testcase((?:\s+\w+="[^"]*")*)\s*(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(re)) {
    const attrs = attributesOf(m[1]);
    const body = m[3] ?? "";
    const failure = /<failure((?:\s+\w+="[^"]*")*)\s*(?:\/>|>([\s\S]*?)<\/failure>)/.exec(body);
    const skipped = /<skipped((?:\s+\w+="[^"]*")*)\s*(?:\/>|>[\s\S]*?<\/skipped>)/.exec(body);
    let outcome = "PASSED";
    let type = null;
    let message = null;
    if (failure) {
      const fa = attributesOf(failure[1]);
      outcome = "FAILED";
      type = fa.type ?? null;
      message = `${fa.message ?? ""}\n${xmlText(failure[2] ?? "")}`.trim();
    } else if (skipped) {
      outcome = attributesOf(skipped[1]).type === "todo" ? "TODO" : "SKIPPED";
    } else if (attrs.failure !== undefined) {
      outcome = "FAILED";
      message = attrs.failure;
    }
    cases.push({ name: (attrs.name ?? "").replace(/&quot;/g, '"'), file: sourceOf(attrs.file ?? "", repoRoot), outcome, type, message });
  }
  return cases;
}

export function failuresOf(xml, options) {
  return casesOf(xml, options).filter((c) => c.outcome === "FAILED");
}
