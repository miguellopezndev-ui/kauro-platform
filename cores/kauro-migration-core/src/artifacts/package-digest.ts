import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../util/hash.js';
import { compareCodeUnits } from '../util/json.js';
import { listPackageFiles } from './write-package.js';

/**
 * The canonical digest of a package.
 *
 * One number over the whole directory, computed the same way by anyone holding
 * the bytes. It exists so that something outside this engine can attest to a
 * package: a signature over this digest names exactly one set of bytes.
 *
 * The definition, which is the part that matters and is repeated in
 * `docs/CONTRACT.md`:
 *
 * 1. List every file in the package, including `manifest.json`, as a path
 *    relative to the package root with `/` separators.
 * 2. Sort the paths by UTF-16 code unit.
 * 3. For each, take the SHA-256 of its bytes, lowercase hex.
 * 4. Join `<path> <sha256>` lines with `\n`, with a trailing `\n`.
 * 5. Prefix `kauro-package-digest/1\n`.
 * 6. The digest is the SHA-256 of that text, lowercase hex.
 *
 * Nothing about the digest is stored inside the package: a file cannot contain
 * its own hash, and a digest a package carries about itself would attest to
 * nothing. The package does not attest to its own truth. This is a name for the
 * bytes, so that an attestation made elsewhere can refer to them.
 */

export const PACKAGE_DIGEST_VERSION = 'kauro-package-digest/1';

export interface PackageDigest {
  readonly digest: string;
  readonly fileCount: number;
  /** The exact text the digest is taken over, so a disagreement can be read. */
  readonly manifestText: string;
}

export function packageDigest(packageDir: string): PackageDigest {
  const paths = [...listPackageFiles(packageDir)].sort(compareCodeUnits);
  const lines = paths.map((path) => {
    const bytes = readFileSync(join(packageDir, ...path.split('/')));
    return `${path} ${sha256Hex(bytes)}`;
  });
  const manifestText = `${PACKAGE_DIGEST_VERSION}\n${lines.map((line) => `${line}\n`).join('')}`;
  return { digest: sha256Hex(manifestText), fileCount: paths.length, manifestText };
}
