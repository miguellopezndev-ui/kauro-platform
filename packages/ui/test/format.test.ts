import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { Count, Deadline, Money, countToBigInt, formatCount, formatDeadline, formatMoney, groupThousands } from "../src/index.js";
import { findOne, render, textOf } from "./support/markup.js";

test("D-COPY-1: money is shown from a minor-unit string by BigInt arithmetic as 'USD 1,295.00', with the sign in front of the digits and no float anywhere", () => {
  assert.equal(formatMoney("129500", "USD"), "USD 1,295.00");
  assert.equal(formatMoney("0", "USD"), "USD 0.00");
  assert.equal(formatMoney("5", "USD"), "USD 0.05");
  assert.equal(formatMoney("100", "USD"), "USD 1.00");
  assert.equal(formatMoney("99999999", "EUR"), "EUR 999,999.99");
  assert.equal(formatMoney("-1250", "USD"), "USD -12.50");
  assert.equal(formatMoney("-5", "USD"), "USD -0.05");
  assert.equal(formatMoney("1500", "JPY"), "JPY 1,500", "a currency with no minor unit has no fraction");
  // Beyond the 53 bits of a double: a float would round these digits.
  assert.equal(formatMoney("12345678901234567890123", "USD"), "USD 123,456,789,012,345,678,901.23");
  assert.equal(formatMoney("9007199254740993", "USD"), "USD 90,071,992,547,409.93");
});

test("D-COPY-1: money refuses anything that is not a canonical minor-unit integer of a currency the table knows, instead of guessing", () => {
  for (const bad of ["12.5", "1e3", "01", "-0", "", " 1", "1 ", "+1", "1,000", "-", "0x10", "NaN"]) assert.throws(() => formatMoney(bad, "USD"), RangeError, JSON.stringify(bad));
  for (const currency of ["XXX", "usd", "", "US", "USDD"]) assert.throws(() => formatMoney("100", currency), RangeError, JSON.stringify(currency));
});

test("D-COPY-1: a count is a whole non-negative number shown en-US with thousands separators, exact for a number, a BigInt or a canonical decimal string", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(999), "999");
  assert.equal(formatCount(1000), "1,000");
  assert.equal(formatCount(1200), "1,200");
  assert.equal(formatCount("1150"), "1,150");
  assert.equal(formatCount(1462n), "1,462");
  assert.equal(formatCount(2n ** 70n), "1,180,591,620,717,411,303,424");
  assert.equal(formatCount("123456789012345678901234567890"), "123,456,789,012,345,678,901,234,567,890");
  assert.equal(countToBigInt("42"), 42n);
  assert.equal(groupThousands("1234567"), "1,234,567");
});

test("D-COPY-1: a count refuses a negative, fractional, unsafe or non-canonical value and names what was being counted", () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, -1n, "01", "1,200", "-1", "", "1.0", " 1", "1e3"]) {
    assert.throws(() => formatCount(bad, "rows"), RangeError, String(bad));
  }
  assert.throws(() => formatCount(-1, "physical rows"), /physical rows/);
  assert.throws(() => groupThousands("12a"), RangeError);
  assert.throws(() => groupThousands(""), RangeError);
});

test("D-COPY-1: a deadline is exact to the minute in the named zone, with the zone's own name, across the daylight-saving change", () => {
  assert.deepEqual(formatDeadline("2027-01-14T22:00:00Z", "America/New_York"), { iso: "2027-01-14T22:00:00.000Z", text: "Jan 14, 2027, 5:00 PM EST" });
  assert.deepEqual(formatDeadline("2027-07-01T16:30:00Z", "America/New_York"), { iso: "2027-07-01T16:30:00.000Z", text: "Jul 1, 2027, 12:30 PM EDT" });
  // The clocks go forward at 2:00 on 14 March 2027: 22:00Z is already daylight time, 06:00Z is still standard time.
  assert.equal(formatDeadline("2027-03-14T22:00:00Z", "America/New_York").text, "Mar 14, 2027, 6:00 PM EDT");
  assert.equal(formatDeadline("2027-03-14T06:00:00Z", "America/New_York").text, "Mar 14, 2027, 1:00 AM EST");
  assert.equal(formatDeadline("2027-01-15T05:00:00Z", "America/New_York").text, "Jan 15, 2027, 12:00 AM EST");
  assert.equal(formatDeadline("2027-01-14T22:00:00Z", "UTC").text, "Jan 14, 2027, 10:00 PM UTC");
  // The same instant written with an offset is the same deadline.
  assert.deepEqual(formatDeadline("2027-01-14T17:00:00-05:00", "America/New_York"), formatDeadline("2027-01-14T22:00:00Z", "America/New_York"));
  assert.equal(formatDeadline("2027-01-14T22:00:00.123456Z", "UTC").iso, "2027-01-14T22:00:00.123Z");
});

test("D-COPY-1: a deadline refuses an instant with no offset, a date with no time, a date or time that does not exist and a zone that does not exist", () => {
  for (const bad of ["2027-01-14", "2027-01-14T22:00", "2027-01-14T22:00:00", "14 Jan 2027", "", "2027-13-14T22:00:00Z", "2027-02-30T22:00:00Z", "2027-02-29T22:00:00Z", "2027-01-14T24:00:00Z", "2027-01-14T22:60:00Z", "2027-01-14T22:00:60Z", "2027-00-14T22:00:00Z", "2027-01-00T22:00:00Z", "2027-01-14T22:00:00+25:00"]) {
    assert.throws(() => formatDeadline(bad, "UTC"), RangeError, JSON.stringify(bad));
  }
  assert.equal(formatDeadline("2028-02-29T22:00:00Z", "UTC").text, "Feb 29, 2028, 10:00 PM UTC", "a leap day exists");
  assert.throws(() => formatDeadline("2027-01-14T22:00:00Z", "Mars/Olympus_Mons"), RangeError);
});

test("D-DS-1: Money, Count and Deadline render one element each — the figure as text, and a <time> whose datetime is the exact instant", () => {
  const money = findOne(render(createElement(Money, { minor: "129500", currency: "USD" })).root, "span");
  assert.equal(textOf(money), "USD 1,295.00");
  assert.equal(money.attrs.get("class"), "kauro-money");
  const count = findOne(render(createElement(Count, { value: "1150" })).root, "span");
  assert.equal(textOf(count), "1,150");
  assert.equal(count.attrs.get("class"), "kauro-count");
  const deadline = findOne(render(createElement(Deadline, { at: "2027-01-14T22:00:00Z", timeZone: "America/New_York" })).root, "time");
  assert.equal(deadline.attrs.get("datetime"), "2027-01-14T22:00:00.000Z");
  assert.equal(textOf(deadline), "Jan 14, 2027, 5:00 PM EST");
  assert.equal(deadline.attrs.get("class"), "kauro-deadline");
  assert.throws(() => render(createElement(Money, { minor: "12.50", currency: "USD" })), RangeError);
  assert.throws(() => render(createElement(Count, { value: -3 })), RangeError);
  assert.throws(() => render(createElement(Deadline, { at: "2027-01-14T22:00:00", timeZone: "UTC" })), RangeError);
});
