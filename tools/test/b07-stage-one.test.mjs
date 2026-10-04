// B07 stage 1 is one implementation (the `b07/stage-1` integrator; design §15 "Every provider fake has exactly one owner", §17
// item 15, D-FAKE-1, D-DP-6). The three stage-1 mandates were built in parallel worktrees; this check keeps what they share
// coherent for the stage-2 mandates that branch from here: each provider port of the source lifecycle has exactly one labelled
// contract fake, implemented only in its owner's `src/testing` and exported only through its owner's test-only subpath (a test
// that needs a provider binds that fake and creates none of its own), and the persistence fixture — which may not import the data
// plane (architecture.rules.json) — records the tokens the fakes and the real parsers of @kauro/data-plane report. It reads the
// built packages (`pnpm run verify` builds before it tests).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const root = join(import.meta.dirname, "..", "..");
const load = (path) => import(pathToFileURL(join(root, path)).href);

/** Each provider port of packages/application/src/ports/source-providers.ts and the one file that may implement it (design §15). */
const OWNERS = Object.freeze({
  ObjectStoragePort: "packages/application/src/testing/contract-fake-object-storage.ts",
  SessionVaultPort: "packages/application/src/testing/contract-fake-session-vault.ts",
  AuthorityJournalPort: "packages/application/src/testing/contract-fake-authority-journal.ts",
  MalwareScannerPort: "packages/data-plane/src/testing/malware-scanner-fake.ts",
});

/** Every TypeScript source of the workspace's packages and apps, production and test, outside build output and dependencies. */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|mts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(relative(root, path).split(sep).join("/"));
    }
  };
  for (const top of ["packages", "apps"]) walk(join(root, top));
  return out;
}

test("B07 stage 1 is one implementation: each provider port has exactly one labelled contract fake, implemented only by its owner and exported only through its owner's test-only subpath, and the persistence fixture records the tokens those fakes and the real parsers of @kauro/data-plane report", async () => {
  // one owner per fake: the only class implementing each provider port is its owner's fake
  const files = sources();
  for (const [port, owner] of Object.entries(OWNERS)) {
    const implementers = files.filter((f) => new RegExp(`\\bimplements\\s+(?:[\\w.]+\\s*,\\s*)*${port}\\b`).test(readFileSync(join(root, f), "utf8")));
    assert.deepEqual(implementers, [owner], `${port} is implemented by its owner's labelled fake only`);
  }

  const entries = {
    "@kauro/domain": await load("packages/domain/dist/src/index.js"),
    "@kauro/application": await load("packages/application/dist/src/index.js"),
    "@kauro/application/testing": await load("packages/application/dist/src/testing/index.js"),
    "@kauro/persistence": await load("packages/persistence/dist/src/index.js"),
    "@kauro/persistence/testing": await load("packages/persistence/dist/src/testing/index.js"),
    "@kauro/data-plane": await load("packages/data-plane/dist/src/index.js"),
    "@kauro/data-plane/testing": await load("packages/data-plane/dist/src/testing/index.js"),
  };
  const exported = Object.entries(entries).flatMap(([entry, m]) => Object.keys(m).filter((k) => /^ContractFake\w+$/.test(k) && typeof m[k] === "function" && !/(Error|Refusal)$/.test(k)).map((k) => `${entry} ${k}`));
  // the four fakes of package B10's ports (packages/application/src/commercial/testing; B10 design §11) are not source-lifecycle
  // provider ports: each has its own owner file there and is listed only so that an unlisted fake still fails this check
  assert.deepEqual(exported.sort(), [
    "@kauro/application/testing ContractFakeAuthorityJournal",
    "@kauro/application/testing ContractFakeBankingCalendar",
    "@kauro/application/testing ContractFakeBuyerTypeReader",
    "@kauro/application/testing ContractFakeObjectStorage",
    "@kauro/application/testing ContractFakePayoutEvidence",
    "@kauro/application/testing ContractFakePreparationCompletion",
    "@kauro/application/testing ContractFakeSessionVault",
    "@kauro/data-plane/testing ContractFakeMalwareScanner",
  ]);
  const fakes = entries["@kauro/application/testing"];
  const scanner = entries["@kauro/data-plane/testing"];
  for (const token of [fakes.CONTRACT_FAKE_STORAGE_PROVIDER, fakes.CONTRACT_FAKE_VAULT_PROVIDER, fakes.CONTRACT_FAKE_JOURNAL_PROVIDER, scanner.FAKE_SCANNER_ENGINE, scanner.FAKE_SCANNER_ENGINE_VERSION, scanner.FAKE_SCANNER_SIGNATURE_VERSION]) {
    assert.match(token, /^contract-fake-/, "every token of a fake says it is one");
  }
  assert.equal(scanner.FAKE_SCANNER_EVIDENCE_CLASS, "SIMULATED");

  // the fixture's provider facts are the fakes' (SIMULATED), and its receipt and evaluation name the real parsers' versions
  const fixture = entries["@kauro/persistence/testing"];
  const parsers = entries["@kauro/data-plane"];
  assert.deepEqual(
    [fixture.FIXTURE_STORAGE_PROVIDER, fixture.FIXTURE_SCANNER, fixture.FIXTURE_SCANNER_ENGINE_VERSION, fixture.FIXTURE_SIGNATURE_VERSION, fixture.FIXTURE_INSPECTOR_VERSION, fixture.FIXTURE_EVALUATOR_VERSION],
    [fakes.CONTRACT_FAKE_STORAGE_PROVIDER, scanner.FAKE_SCANNER_ENGINE, scanner.FAKE_SCANNER_ENGINE_VERSION, scanner.FAKE_SCANNER_SIGNATURE_VERSION, parsers.INSPECTOR_VERSION, parsers.EVALUATOR_VERSION],
  );
});
