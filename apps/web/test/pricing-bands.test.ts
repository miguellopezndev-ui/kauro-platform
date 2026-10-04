// The arithmetic and the words of the price ladder (UI04): amounts are formatted from minor units without a float, the band a visitor's
// count falls in is decided at the band edges the manual publishes, and an estimate is never anything but an indicative band (A3 3.4).
import assert from "node:assert/strict";
import { test } from "node:test";
import { bandIndexOf, estimateBand, formatCount, formatUsd, priceOf, startingPrice } from "../src/public/pricing-bands.ts";

test("money is written from minor units: whole amounts without cents, a fraction with two", () => {
  assert.equal(formatUsd(0), "USD 0");
  assert.equal(formatUsd(69_500), "USD 695");
  assert.equal(formatUsd(129_500), "USD 1,295");
  assert.equal(formatUsd(123_025), "USD 1,230.25");
  assert.equal(formatUsd(5), "USD 0.05");
  assert.throws(() => formatUsd(-1), RangeError);
  assert.throws(() => formatUsd(1.5), RangeError);
  assert.throws(() => formatUsd(Number.NaN), RangeError);
});

test("counts are written with thousands separators and refuse anything that is not a whole count", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(150_000), "150,000");
  assert.equal(formatCount(1_000_000), "1,000,000");
  assert.throws(() => formatCount(-1), RangeError);
  assert.throws(() => formatCount(0.5), RangeError);
});

test("the starting prices are the first band of each mode", () => {
  assert.equal(formatUsd(startingPrice("CLEAN")), "USD 695");
  assert.equal(formatUsd(startingPrice("HUBSPOT")), "USD 1,295");
  assert.equal(formatUsd(startingPrice("SALESFORCE")), "USD 1,495");
  assert.equal(formatUsd(priceOf(2, "CLEAN")), "USD 1,795");
});

test("a count falls in the band whose edges the ladder publishes, and zero units is no sale", () => {
  assert.equal(bandIndexOf(0), null);
  assert.equal(bandIndexOf(1), 0);
  assert.equal(bandIndexOf(50_000), 0);
  assert.equal(bandIndexOf(50_001), 1);
  assert.equal(bandIndexOf(150_000), 1);
  assert.equal(bandIndexOf(150_001), 2);
  assert.equal(bandIndexOf(500_000), 2);
  assert.equal(bandIndexOf(500_001), 3);
  assert.equal(bandIndexOf(1_000_000), 3);
  assert.equal(bandIndexOf(1_000_001), null);
  assert.equal(bandIndexOf(Number.NaN), null);
  assert.equal(bandIndexOf(2.5), null);
});

test("an estimate accepts digits with separators and spaces, and nothing else", () => {
  assert.deepEqual(estimateBand("42,000", "CLEAN"), { kind: "BAND", band: 0, mode: "CLEAN", minor: 69_500, offered: true });
  assert.deepEqual(estimateBand(" 50 001 ", "HUBSPOT"), { kind: "BAND", band: 1, mode: "HUBSPOT", minor: 199_500, offered: true });
  assert.deepEqual(estimateBand("500000", "SALESFORCE"), { kind: "BAND", band: 2, mode: "SALESFORCE", minor: 349_500, offered: true });
  assert.deepEqual(estimateBand("500,001", "CLEAN"), { kind: "BAND", band: 3, mode: "CLEAN", minor: 269_500, offered: false });
  assert.deepEqual(estimateBand("0", "CLEAN"), { kind: "NO_UNITS" });
  assert.deepEqual(estimateBand("000", "CLEAN"), { kind: "NO_UNITS" });
  assert.deepEqual(estimateBand("1,000,001", "CLEAN"), { kind: "BEYOND_LADDER" });
  for (const text of ["", "   ", "abc", "1e5", "-5", "12.5", "1_000", "0x10", "١٢٣", "99999999999999"]) {
    assert.deepEqual(estimateBand(text, "CLEAN"), { kind: "NOT_A_COUNT" }, JSON.stringify(text));
  }
});

test("a band above the launch envelope is on the ladder but is never offered", () => {
  const result = estimateBand("750,000", "HUBSPOT");
  assert.equal(result.kind, "BAND");
  assert.equal(result.kind === "BAND" && result.offered, false);
});
