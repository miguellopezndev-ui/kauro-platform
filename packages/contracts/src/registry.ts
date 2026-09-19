/**
 * Access to the vendored authority registry with provenance verification: every JSON file is hashed at load and compared with
 * registry/PROVENANCE.json, so a silently edited registry cannot pass as the contract authority.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The package root is the nearest ancestor holding this package's package.json (works from src/ and from dist/src/). */
function packageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "@kauro/contracts") return dir;
    } catch {
      // not here; walk up
    }
    dir = join(dir, "..");
  }
  throw new Error("@kauro/contracts package root not found above " + start);
}

const registryDir = join(packageRoot(here), "registry");

export interface Provenance {
  readonly source: string;
  readonly vendored_at: string;
  readonly brand_note: string;
  readonly files: Readonly<Record<string, string>>;
}

export class RegistryIntegrityError extends Error {
  constructor(file: string, expected: string, actual: string) {
    super(`registry/${file}: sha256 ${actual} differs from the recorded provenance ${expected}`);
    this.name = "RegistryIntegrityError";
  }
}

let cachedProvenance: Provenance | undefined;

export function provenance(): Provenance {
  if (!cachedProvenance) cachedProvenance = JSON.parse(readFileSync(join(registryDir, "PROVENANCE.json"), "utf8")) as Provenance;
  return cachedProvenance;
}

/** Returns the raw bytes of a registry file after verifying its recorded hash. */
export function registryBytes(file: string): Buffer {
  const prov = provenance();
  const expected = prov.files[file];
  if (!expected) throw new RegistryIntegrityError(file, "(not in PROVENANCE.json)", "?");
  const bytes = readFileSync(join(registryDir, file));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new RegistryIntegrityError(file, expected, actual);
  return bytes;
}

export function registryJson<T = unknown>(file: string): T {
  return JSON.parse(registryBytes(file).toString("utf8")) as T;
}

export interface RegistryGate {
  readonly id: string;
  readonly [key: string]: unknown;
}

export function gates(): ReadonlyArray<RegistryGate> {
  const raw = registryJson<unknown>("gates.json");
  const list = Array.isArray(raw) ? raw : Object.values(raw as Record<string, unknown>).find(Array.isArray);
  if (!Array.isArray(list)) throw new TypeError("gates.json: no gate list found");
  return list as RegistryGate[];
}

export function screens(): ReadonlyArray<Record<string, unknown>> {
  const raw = registryJson<unknown>("screens.json");
  const list = Array.isArray(raw) ? raw : Object.values(raw as Record<string, unknown>).find(Array.isArray);
  if (!Array.isArray(list)) throw new TypeError("screens.json: no screen list found");
  return list as Record<string, unknown>[];
}

export function policy(): Record<string, unknown> {
  return registryJson<Record<string, unknown>>("policy.json");
}
