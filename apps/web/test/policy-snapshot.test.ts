// The public pages cannot call policy() (the contract package reads its registry files with fs, which a Next bundle cannot do), so they
// state the numbers of a vendored snapshot (src/public/policy-snapshot.ts). This test is the guard the snapshot's header promises: every
// number a page states equals the policy registry's number, so a change in packages/contracts/registry/policy.json that is not copied
// here fails the build, and a page can never publish a price, a window or a limit the policy does not hold.
import assert from "node:assert/strict";
import { test } from "node:test";
import { policy } from "@kauro/contracts/registry";
import { BANDS, bandLabel, bandOffered, bandRange, repeatDiscounts } from "../src/public/pricing-bands.ts";
import { POLICY_SNAPSHOT, SERVICE_MODES, SNAPSHOT_PATHS } from "../src/public/policy-snapshot.ts";

const registry = policy();

function at(path: string): unknown {
  let value: unknown = registry;
  for (const segment of path.split(".")) {
    assert.ok(typeof value === "object" && value !== null && segment in value, `the registry has no ${path}`);
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

test("every number the public pages state from the policy equals the policy registry's number", () => {
  assert.ok(SNAPSHOT_PATHS.length >= 20, "the snapshot names its numbers");
  for (const [path, value] of SNAPSHOT_PATHS) assert.equal(value, at(path), `${path} drifted from the policy registry`);
});

test("the price bands, by mode and in minor units, equal the registry's bands", () => {
  const registryBands = at("pricing.bands") as ReadonlyArray<Record<string, number>>;
  assert.equal(BANDS.length, registryBands.length);
  registryBands.forEach((band, index) => {
    assert.equal(BANDS[index]?.maximum, band["maximum"], `band ${index} maximum`);
    for (const mode of SERVICE_MODES) assert.equal(BANDS[index]?.minor[mode], band[mode], `band ${index} ${mode}`);
  });
  assert.equal(POLICY_SNAPSHOT.scheduleVersion, at("pricing.scheduleVersion"));
});

test("the repeat discount tiers are the registry's tiers, written as percentages", () => {
  const tiers = at("pricing.repeatTiers") as ReadonlyArray<{ minimum: number; bps: number }>;
  assert.deepEqual(
    POLICY_SNAPSHOT.repeatTiers.map((tier) => ({ minimum: tier.minimum, percent: tier.percent })),
    tiers.map((tier) => ({ minimum: tier.minimum, percent: tier.bps / 100 })),
  );
  assert.deepEqual(repeatDiscounts(), [
    { range: "1 to 9", percent: 5 },
    { range: "10 to 24", percent: 10 },
    { range: "25 or more", percent: 15 },
  ]);
});

test("the service modes the pages know are the registry's public modes, and the ladder never lists a mode the registry does not", () => {
  assert.deepEqual([...SERVICE_MODES], (at("modes.public") as string[]));
});

test("the ladder's bands start where the previous band ends, and only the bands inside the launch envelope are offered", () => {
  assert.deepEqual(BANDS.map((_, index) => bandLabel(index)), ["Up to 50,000", "50,001 to 150,000", "150,001 to 500,000", "500,001 to 1,000,000"]);
  assert.deepEqual(BANDS.map((_, index) => bandRange(index)), [
    { from: 1, to: 50_000 },
    { from: 50_001, to: 150_000 },
    { from: 150_001, to: 500_000 },
    { from: 500_001, to: 1_000_000 },
  ]);
  assert.deepEqual(BANDS.map((_, index) => bandOffered(index)), [true, true, true, false]);
  assert.equal(POLICY_SNAPSHOT.launchSourceUnits, at("capacity.launchSourceUnits"));
});
