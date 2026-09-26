/**
 * Labels and shared helpers of the contract fakes (decision D-FAKE-B1; 21 "Evidence classes"): every fake of this subpath implements
 * the documented contract of the port it stands for, declares `integrationClass: "CONTRACT_FAKE"` (an external provider) or
 * `binding: "CONTRACT_FAKE"` (a platform port of a package not yet on main), carries the evidence class SIMULATED, and keeps a call
 * log a test can read. Nothing here is real integration (that is package B15's): a case demonstrated through a fake is PARTIAL at
 * closure, with the simulated half named. This subpath is test-only (architecture.rules.json testOnlySubpaths): no production
 * source imports it, so no deployment wiring can bind a fake.
 */
import { createHash } from "node:crypto";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";

/** The evidence class of everything a fake produces (21 "Evidence classes"): never EXECUTED_PROVIDER. */
export const FAKE_EVIDENCE_CLASS = "SIMULATED" as const;
export const CONTRACT_FAKE = "CONTRACT_FAKE" as const;

/** One call a fake received (what, with which identity, and when), in call order. */
export interface FakeCall {
  readonly port: string;
  readonly operation: string;
  /** The identity the call carried (a provider request id, a provider id, a revision hash, ...), when it has one. */
  readonly identity: string | null;
  readonly at: UtcInstant;
  /** False when the fake refused to send (a dispatch past its deadline). */
  readonly sent: boolean;
}

export function sha256Hex(data: string | Uint8Array): Sha256Hex {
  return createHash("sha256").update(data).digest("hex");
}

/** A deterministic RFC 9562 UUIDv8 of a digest: the content address of the evidence store (a request `id`, never a v7 aggregate id). */
export function uuidV8Of(hex: Sha256Hex): string {
  const b = hex.slice(0, 32).split("");
  b[12] = "8";
  b[16] = ((Number.parseInt(b[16] as string, 16) & 0x3) | 0x8).toString(16);
  const s = b.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** Minor units as a provider's decimal amount string ("115579" → "1155.79"; minor unit 2, registry policy money). */
export function decimalOf(cents: bigint): string {
  const s = cents.toString().padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

/** A provider's decimal amount string as minor units, refusing anything but an exact two-decimal non-negative amount. */
export function centsOf(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,13})\.[0-9]{2}$/.test(value)) return null;
  return BigInt(value.replace(".", ""));
}

/** A provider timestamp as the platform's canonical instant (three fractional digits, Z), or null. */
export function instantOf(value: unknown): UtcInstant | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
