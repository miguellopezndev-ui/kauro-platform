// The input limits a visitor is told about (manual 07 "Input limits"; A3 3.2), written from the vendored policy snapshot so that a number is
// stated once, in the policy, and never typed into a page. Bytes are written in decimal units, the way file sizes are shown in a file
// picker and in the policy ("2 GB" is 2,000,000,000 bytes), and never rounded up.
import { formatCount } from "./pricing-bands.ts";
import { POLICY_SNAPSHOT } from "./policy-snapshot.ts";

const UNITS = [
  { suffix: "TB", size: 1_000_000_000_000 },
  { suffix: "GB", size: 1_000_000_000 },
  { suffix: "MB", size: 1_000_000 },
  { suffix: "kB", size: 1_000 },
] as const;

/** A byte count in decimal units with at most one decimal: 2000000000 is "2 GB", 1500000000 is "1.5 GB", 250000000 is "250 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("a size is a non-negative whole number of bytes");
  const unit = UNITS.find((candidate) => bytes >= candidate.size);
  if (unit === undefined) return `${formatCount(bytes)} ${bytes === 1 ? "byte" : "bytes"}`;
  const tenths = Math.floor((bytes * 10) / unit.size);
  const whole = Math.floor(tenths / 10);
  return `${formatCount(whole)}${tenths % 10 === 0 ? "" : `.${tenths % 10}`} ${unit.suffix}`;
}

/** The limits as the words of the catalogue take them: a page passes these straight to copy(). */
export const INPUT_LIMITS = Object.freeze({
  files: formatCount(POLICY_SNAPSHOT.input.files),
  fileSize: formatBytes(POLICY_SNAPSHOT.input.fileBytes),
  setSize: formatBytes(POLICY_SNAPSHOT.input.revisionBytes),
  columns: formatCount(POLICY_SNAPSHOT.input.columns),
  units: formatCount(POLICY_SNAPSHOT.launchSourceUnits),
});
