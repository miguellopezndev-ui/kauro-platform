import type { CanonicalObject } from '../domain/canonical.js';
import { sha256Hex } from '../util/hash.js';

/**
 * Deterministic destination-side keys.
 *
 * Keys are derived only from data that already identifies the record, so the
 * same source and configuration always produce the same key on every machine.
 * No randomness is used, and the key exposes no source value: it is a hash, not
 * an encoding.
 */

const KEY_VERSION = 'v1';

export function migrationKeyFromIdentity(object: CanonicalObject, identityKey: string): string {
  return render(object, sha256Hex(`${KEY_VERSION}|identity|${identityKey}`));
}

export function migrationKeyFromRow(
  object: CanonicalObject,
  sourceSystem: string,
  sourceNamespace: string,
  bundleId: string,
  rowLocatorId: string,
): string {
  return render(
    object,
    sha256Hex(`${KEY_VERSION}|row|${sourceSystem}|${sourceNamespace}|${bundleId}|${rowLocatorId}`),
  );
}

export function mergeIdFor(identityKeys: readonly string[]): string {
  const sorted = [...identityKeys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `mg_${sha256Hex(`${KEY_VERSION}|merge|${sorted.join('\n')}`).slice(0, 16)}`;
}

export function edgeIdFor(associationMappingId: string, rowLocatorId: string, fromKey: string, toKey: string): string {
  return `ed_${sha256Hex(`${KEY_VERSION}|edge|${associationMappingId}|${rowLocatorId}|${fromKey}|${toKey}`).slice(0, 16)}`;
}

export function clusterIdFor(signal: string, value: string, migrationKeys: readonly string[]): string {
  const sorted = [...migrationKeys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `dc_${sha256Hex(`${KEY_VERSION}|cluster|${signal}|${value}|${sorted.join('\n')}`).slice(0, 16)}`;
}

function render(object: CanonicalObject, digest: string): string {
  return `mk_${object.toLowerCase()}_${digest.slice(0, 20)}`;
}
